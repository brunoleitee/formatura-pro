import contextlib
import hashlib
import io
import os
import threading
import traceback
from pathlib import Path
from collections import Counter

import cv2
import numpy as np
from PIL import Image, ImageOps

from onnx_provider_utils import get_onnx_providers, get_session_providers, mark_cuda_failed

os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")

_FACE_ENGINE_LOCK = threading.Lock()


@contextlib.contextmanager
def _default_quiet_external_output():
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield

_cfg = {
    "log_debug": lambda msg: None,
    "log_info": lambda msg: None,
    "quiet_external_output": _default_quiet_external_output,
    "get_memory_info": lambda: {},
    "get_db": None,
    "sanitize_catalog_name": lambda name: name,
    "get_scan_checkpoint": None,
    "save_scan_checkpoint": None,
    "clear_scan_checkpoint": None,
    "get_blur_info": None,
    "is_background_face": None,
    "face_box_area": None,
    "min_face_area": 500,
    "ref_match_threshold": 0.5,
    "faiss_available": False,
    "runtime_dir": "",
    "data_dir": "",
    "image_extensions": (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"),
    "image_models_ready": False,
    "app_face": None,
    "face_engine_device": "",
    "face_engine_provider": "",
    "face_engine_label": "",
    "face_engine_gpu_error": "",
    "det_size": (640, 640),
    "faiss_index": None,
    "ref_ids": [],
    "ref_classes": {},
    "cluster_centers": [],
    "cluster_names": [],
    "cluster_counts": {},
    "scan_state": None,
    "quality_audit_state": None,
    "current_catalog": "",
    "save_embedding_disk_cache": lambda: None,
    "load_embedding_disk_cache": lambda: None,
    "get_memory_info": lambda: {},
}


def configure(**kwargs):
    _cfg.update({k: v for k, v in kwargs.items() if v is not None})


AI_PROVIDER_PRIORITY = [
    "CUDAExecutionProvider",
    "DmlExecutionProvider",
    "CPUExecutionProvider",
]

AI_PROVIDER_LABELS = {
    "CUDAExecutionProvider": "GPU NVIDIA",
    "DmlExecutionProvider": "GPU DirectML",
    "CPUExecutionProvider": "CPU",
}


def face_box_area(x1, y1, x2, y2):
    return max(0, x2 - x1) * max(0, y2 - y1)


def is_background_face(x1, y1, x2, y2, largest_face_area, image_shape, valid_face_count):
    if valid_face_count <= 1 or largest_face_area <= 0 or not image_shape:
        return False
    area = face_box_area(x1, y1, x2, y2)
    image_h = image_shape[0] if len(image_shape) > 0 else 0
    face_h = max(0, y2 - y1)
    area_ratio = area / largest_face_area
    height_ratio = (face_h / image_h) if image_h else 1
    return area_ratio < 0.38 and height_ratio < 0.22


def calc_foreground_score(x1, y1, x2, y2, area, img_shape, face, blur_score):
    if not img_shape:
        return 0.5, 1, 0.0, 0.5, "No image shape"
    
    img_h, img_w = img_shape[:2]
    img_area = img_h * img_w
    if img_area == 0:
        return 0.5, 1, 0.0, 0.5, "Zero image area"

    face_area_ratio = area / img_area
    
    if face_area_ratio > 0.05:
        size_score = 1.0
    elif face_area_ratio < 0.004:
        size_score = 0.0
    else:
        size_score = min(1.0, face_area_ratio / 0.05)
        
    face_cx = (x1 + x2) / 2.0
    face_cy = (y1 + y2) / 2.0
    img_cx = img_w / 2.0
    img_cy = img_h / 2.0
    
    dist_x = abs(face_cx - img_cx) / img_w
    dist_y = abs(face_cy - img_cy) / img_h
    dist = (dist_x**2 + dist_y**2)**0.5
    
    center_score = max(0.0, 1.0 - (dist * 2.0))
    
    sharpness_score = 0.5
    if blur_score is not None:
        try:
            val = float(blur_score)
            sharpness_score = min(1.0, max(0.0, val / 100.0))
        except:
            pass
            
    pose_score = 0.8
    if hasattr(face, 'pose') and face.pose is not None:
        pitch, yaw, roll = face.pose
        pose_penalty = min(1.0, (abs(yaw) + abs(pitch)) / 90.0)
        pose_score = 1.0 - pose_penalty
        
    edge_penalty_score = 1.0
    margin_w = img_w * 0.02
    margin_h = img_h * 0.02
    if x1 < margin_w or y1 < margin_h or x2 > img_w - margin_w or y2 > img_h - margin_h:
        edge_penalty_score = 0.2

    fg_score = (0.40 * size_score) + (0.25 * center_score) + (0.15 * sharpness_score) + (0.10 * pose_score) + (0.10 * edge_penalty_score)
    
    if face_area_ratio < 0.008:
        fg_score *= 0.5
    
    bg_reason = ""
    if face_area_ratio < 0.004:
        bg_reason = "Rosto muito pequeno"
        fg_score = min(fg_score, 0.3)
    elif edge_penalty_score < 0.5:
        bg_reason = "Na borda"
    elif pose_score < 0.4:
        bg_reason = "Muito lateral"
    elif sharpness_score < 0.2:
        bg_reason = "Desfocado"
    elif fg_score < 0.45:
        bg_reason = "Segundo plano provável"
        
    is_foreground = 1 if fg_score >= 0.45 else 0
    
    return fg_score, is_foreground, face_area_ratio, center_score, bg_reason


def quiet_external_output():
    return _cfg["quiet_external_output"]()


def imread_unicode(path):
    try:
        if not path or not os.path.isfile(path):
            _cfg["log_debug"](f"Arquivo nao existe ou path invalido: {path}")
            return None
        file_size = os.path.getsize(path)
        if file_size > 100 * 1024 * 1024:
            _cfg["log_debug"](f"Arquivo muito grande ({file_size / 1024 / 1024:.1f}MB): {path}")
            return None
        with Image.open(path) as pil_img:
            if pil_img.mode != "RGB":
                pil_img = pil_img.convert("RGB")
            pil_img = ImageOps.exif_transpose(pil_img)
            if pil_img.size[0] < 10 or pil_img.size[1] < 10:
                _cfg["log_debug"](f"Imagem muito pequena: {path}")
                return None
            img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
            if img is None or img.size == 0:
                _cfg["log_debug"](f"Imagem invalida: {path}")
                return None
            if img.shape[0] < 20 or img.shape[1] < 20:
                _cfg["log_debug"](f"Imagem muito pequena para deteccao: {path} - shape: {img.shape}")
                return None
            return img
    except Image.UnidentifiedImageError:
        _cfg["log_debug"](f"Imagem nao reconhecida (EXIF/corrompida): {path}")
        return None
    except PermissionError:
        _cfg["log_debug"](f"Permissao negada: {path}")
        return None
    except OSError as e:
        if "truncated" in str(e).lower() or "corrupt" in str(e).lower():
            _cfg["log_debug"](f"Imagem corrompida: {path}")
        else:
            _cfg["log_debug"](f"Erro OS lendo {path}: {e}")
        return None
    except Exception as e:
        _cfg["log_debug"](f"Erro lendo {path}: {e}")
        return None


def file_sha1(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        h = hashlib.sha1()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def collect_scan_inputs(root_paths, image_extensions):
    valid_exts = tuple(ext.lower() for ext in (image_extensions or ()))
    counters = Counter()
    files_to_process = []
    seen_files = set()
    seen_roots = set()

    for root_path in root_paths:
        if not root_path:
            continue
        abs_root = os.path.abspath(root_path)
        if abs_root in seen_roots or not os.path.isdir(abs_root):
            continue
        seen_roots.add(abs_root)

        for current_root, _dirs, filenames in os.walk(abs_root):
            for filename in filenames:
                counters["found_total"] += 1
                full_path = os.path.join(current_root, filename)
                ext = os.path.splitext(filename)[1].lower()
                if ext in valid_exts:
                    counters["valid_total"] += 1
                    counters[f"valid_ext:{ext}"] += 1
                    normalized = os.path.normcase(os.path.abspath(full_path))
                    if normalized in seen_files:
                        counters["ignored_duplicates"] += 1
                        continue
                    seen_files.add(normalized)
                    files_to_process.append(full_path)
                else:
                    counters["ignored_invalid_extension"] += 1
                    counters[f"ignored_ext:{ext or '<sem_ext>'}"] += 1

    return {
        "files": files_to_process,
        "found_total": counters["found_total"],
        "valid_total": counters["valid_total"],
        "ignored_invalid_extension": counters["ignored_invalid_extension"],
        "ignored_duplicates": counters["ignored_duplicates"],
        "valid_by_extension": {
            key.split(":", 1)[1]: value
            for key, value in counters.items()
            if key.startswith("valid_ext:")
        },
        "ignored_by_extension": {
            key.split(":", 1)[1]: value
            for key, value in counters.items()
            if key.startswith("ignored_ext:")
        },
    }


def _provider_device(provider_name):
    return "GPU" if provider_name in {"CUDAExecutionProvider", "DmlExecutionProvider"} else "CPU"


def _provider_label(provider_name):
    return AI_PROVIDER_LABELS.get(provider_name, provider_name or "CPU")


def _provider_config(provider_name):
    providers = [provider_name]
    provider_options = None
    ctx_id = -1

    if provider_name == "CUDAExecutionProvider":
        providers.append("CPUExecutionProvider")
        provider_options = [
            {
                "device_id": 0,
                "arena_extend_strategy": "kNextPowerOfTwo",
                "cudnn_conv_algo_search": "DEFAULT",
                "do_copy_in_default_stream": 1,
            },
            {},
        ]
        ctx_id = 0
    elif provider_name == "DmlExecutionProvider":
        providers.append("CPUExecutionProvider")
        ctx_id = 0

    return {
        "provider": provider_name,
        "providers": providers,
        "provider_options": provider_options,
        "ctx_id": ctx_id,
        "device": _provider_device(provider_name),
        "label": _provider_label(provider_name),
    }


def get_available_ai_provider():
    provider_info = get_onnx_providers(
        log_debug=_cfg["log_debug"],
    )
    available = provider_info["available_providers"]

    return {
        "available_providers": available,
        "provider_error": provider_info.get("provider_error", ""),
        "preload_error": "",
        "selected_provider": provider_info["provider"],
        "selected_label": provider_info["label"],
        "selected_providers": provider_info["selected_providers"],
        "provider_options": provider_info["provider_options"],
        "ctx_id": provider_info["ctx_id"],
        "provider": provider_info["provider"],
        "label": provider_info["label"],
        "device": provider_info["device"],
        "cuda_failed": provider_info["cuda_failed"],
    }


def ensure_face_engine():
    global _cfg
    if _cfg["app_face"] is not None:
        _cfg["log_info"]("[AI] reutilizando InsightFace global")
        return

    with _FACE_ENGINE_LOCK:
        if _cfg["app_face"] is not None:
            _cfg["log_info"]("[AI] reutilizando InsightFace global")
            return

        _cfg["log_info"]("[AI] inicializando InsightFace global...")
        provider_info = get_available_ai_provider()
        selected_provider = provider_info["selected_provider"]
        selected_providers = provider_info["selected_providers"]
        provider_options = provider_info["provider_options"]
        ctx_id = provider_info["ctx_id"]

        face_engine_device = _cfg["face_engine_device"]
        face_engine_provider = _cfg["face_engine_provider"]
        face_engine_label = _cfg["face_engine_label"]
        face_engine_gpu_error = _cfg["face_engine_gpu_error"]
        model_root = _cfg["runtime_dir"] if os.path.isdir(os.path.join(_cfg["runtime_dir"], "models", "buffalo_l")) else "~/.insightface"

        from insightface.app import FaceAnalysis

        try:
            with quiet_external_output():
                app_face = FaceAnalysis(
                    name="buffalo_l",
                    root=model_root,
                    providers=selected_providers,
                    provider_options=provider_options,
                    allowed_modules=["detection", "recognition"],
                )
                app_face.prepare(ctx_id=ctx_id, det_size=_cfg.get("det_size", (640, 640)))

            real_providers = get_session_providers(app_face)
            real_provider = real_providers[0] if real_providers else selected_provider
            if selected_provider == "CUDAExecutionProvider" and "CUDAExecutionProvider" not in real_providers:
                mark_cuda_failed()
                face_engine_device = "CPU"
                face_engine_provider = "CPUExecutionProvider"
                face_engine_label = "CPU"
                face_engine_gpu_error = "Sessao real da IA ficou em CPU"
                _cfg["log_info"]("[AI] CUDA indisponivel, usando CPU")
                _cfg["log_info"]("[AI] Provider ativo: CPUExecutionProvider")
            else:
                face_engine_device = "GPU" if real_provider in {"CUDAExecutionProvider", "DmlExecutionProvider"} else "CPU"
                face_engine_provider = real_provider
                face_engine_label = _provider_label(real_provider)
                face_engine_gpu_error = provider_info.get("provider_error", "")
                if real_provider == "CUDAExecutionProvider":
                    _cfg["log_info"]("[AI] CUDA ativa")
                elif selected_provider == "CPUExecutionProvider":
                    _cfg["log_info"]("[AI] CUDA indisponivel, usando CPU")
                _cfg["log_info"](f"[AI] Provider ativo: {real_provider}")
        except Exception as e:
            _cfg["log_info"](f"[AI] Falha ao carregar engine de IA: {e}")
            if selected_provider == "CPUExecutionProvider":
                _cfg["log_debug"](f"[SCAN] Erro fatal no carregamento CPU: {traceback.format_exc()}")
                raise

            mark_cuda_failed()
            _cfg["log_info"]("[AI] CUDA indisponivel, usando CPU")
            with quiet_external_output():
                app_face = FaceAnalysis(
                    name="buffalo_l",
                    root=model_root,
                    providers=["CPUExecutionProvider"],
                    provider_options=None,
                    allowed_modules=["detection", "recognition"],
                )
                app_face.prepare(ctx_id=-1, det_size=_cfg.get("det_size", (640, 640)))
            real_providers = get_session_providers(app_face)
            real_provider = real_providers[0] if real_providers else "CPUExecutionProvider"
            face_engine_device = "CPU"
            face_engine_provider = real_provider
            face_engine_label = _provider_label(real_provider)
            face_engine_gpu_error = str(e)
            _cfg["log_info"](f"[AI] Provider ativo: {real_provider}")

        _cfg["app_face"] = app_face
        _cfg["face_engine_device"] = face_engine_device
        _cfg["face_engine_provider"] = face_engine_provider
        _cfg["face_engine_label"] = face_engine_label
        _cfg["face_engine_gpu_error"] = face_engine_gpu_error
        _cfg["log_info"](f"[Face] model loaded device={face_engine_device} provider={face_engine_provider} label={face_engine_label}")


def load_references(ref_path):
    global _cfg
    faiss_index = None
    ref_ids = []
    refs = []
    ref_classes = {}
    if not ref_path or not os.path.isdir(ref_path):
        return
    _cfg["log_info"](f"Carregando referências de: {ref_path}")
    for r, d, files in os.walk(ref_path):
        for f in files:
            if not f.lower().endswith(_cfg["image_extensions"]):
                continue
            full = os.path.join(r, f)
            img = imread_unicode(full)
            if img is None:
                continue
            try:
                faces = _cfg["app_face"].get(img) or []
            except Exception:
                continue
            if len(faces) != 1 or not hasattr(faces[0], "embedding") or faces[0].embedding is None:
                continue
            emb = faces[0].embedding.astype("float32")
            norm = np.linalg.norm(emb)
            if norm == 0:
                continue
            emb = emb / norm
            ref_name = Path(f).stem
            rel_parent = Path(os.path.relpath(full, ref_path)).parent.name
            class_name = rel_parent if rel_parent not in ("", ".") else "Sem turma"
            print(f"[reference-import] arquivo={full} turma={class_name}")
            refs.append({"id": ref_name, "class_name": class_name, "emb": emb})
            ref_classes[ref_name.casefold()] = class_name
    if not refs:
        return
    ref_embs = np.array([r["emb"] for r in refs], dtype="float32")
    ref_ids = [r["id"] for r in refs]
    if _cfg["faiss_available"]:
        import faiss
        index = faiss.IndexFlatIP(ref_embs.shape[1])
        index.add(ref_embs)
        faiss_index = index
    else:
        faiss_index = ref_embs
    _cfg["faiss_index"] = faiss_index
    _cfg["ref_ids"] = ref_ids
    _cfg["ref_classes"] = ref_classes


def find_best_reference(emb):
    faiss_index = _cfg["faiss_index"]
    ref_ids = _cfg["ref_ids"]
    if faiss_index is None or not ref_ids:
        return None, 0.0
    emb = emb.astype("float32").reshape(1, -1)
    if _cfg["faiss_available"]:
        D, I = faiss_index.search(emb, 1)
        score = float(D[0][0])
        idx = int(I[0][0])
    else:
        sims = np.dot(faiss_index, emb[0])
        idx = int(np.argmax(sims))
        score = float(sims[idx])
    if idx < 0 or idx >= len(ref_ids):
        return None, 0.0
    return ref_ids[idx], score


def get_reference_class_name(ref_name: str | None) -> str:
    ref_classes = _cfg.get("ref_classes") or {}
    key = str(ref_name or "").strip().casefold()
    if not key:
        return "Sem turma"
    return ref_classes.get(key, "Sem turma")


def find_or_create_cluster(emb):
    cluster_centers = _cfg["cluster_centers"]
    cluster_names = _cfg["cluster_names"]
    cluster_counts = _cfg["cluster_counts"]
    if not cluster_centers:
        name = "Pessoa 1"
        cluster_centers.append(emb)
        cluster_names.append(name)
        cluster_counts[name] = 1
        return name
    centers = np.array(cluster_centers, dtype="float32")
    sims = np.dot(centers, emb)
    best_idx = int(np.argmax(sims))
    best_sim = float(sims[best_idx])
    if best_sim > 0.70:
        name = cluster_names[best_idx]
        count = cluster_counts.get(name, 1) + 1
        cluster_counts[name] = count
        old_center = cluster_centers[best_idx]
        new_center = (old_center * (count - 1) + emb) / count
        new_norm = np.linalg.norm(new_center)
        if new_norm != 0:
            new_center = new_center / new_norm
        cluster_centers[best_idx] = new_center.astype("float32")
        return name
    name = f"Pessoa {len(cluster_centers) + 1}"
    cluster_centers.append(emb)
    cluster_names.append(name)
    cluster_counts[name] = 1
    return name


def get_app_face():
    return _cfg["app_face"]


def get_face_engine_device():
    return _cfg["face_engine_device"]


def get_face_engine_provider():
    return _cfg["face_engine_provider"]


def get_face_engine_label():
    return _cfg["face_engine_label"] or _cfg["face_engine_device"]


def get_face_engine_gpu_error():
    return _cfg["face_engine_gpu_error"]


def _scan_state():
    return _cfg["scan_state"]


def _quality_state():
    return _cfg["quality_audit_state"]


_KILL_NOW = False


def _cancel_requested():
    try:
        from backend_state import scanner_cancel as _sc
        if _sc.get("KILL_NOW", False):
            import os
            os._exit(1)
        return _sc.get("cancel_requested", False)
    except Exception:
        return False


def _reset_cancel():
    try:
        from backend_state import scanner_cancel as _sc
        _sc["cancel_requested"] = False
        _sc["running"] = False
        _sc["stopped"] = False
        _sc["KILL_NOW"] = False
    except Exception:
        pass


def _memory_cleanup(scan_state=None):
    import gc
    if scan_state is not None:
        scan_state["current_photo"] = None
        scan_state["recent_faces"] = []
        scan_state.pop("processing_history", None)
        scan_state["progress"] = 0.0
    _cfg["cluster_centers"] = []
    _cfg["cluster_names"] = []
    _cfg["cluster_counts"] = {}
    for _ in range(3):
        gc.collect()


def _load_single_image(path):
    if _cancel_requested():
        return None
    return imread_unicode(path)


def _log_memory(label=""):
    log_info = _cfg.get("log_info", lambda msg: None)
    try:
        import psutil
        import os as _os
        proc = psutil.Process(_os.getpid())
        rss = proc.memory_info().rss / (1024 * 1024)
        log_info(f"[MEM] {label} — RSS={rss:.0f}MB")
    except Exception:
        pass


def run_scanner_worker(req):
    scan_state = _scan_state()
    if scan_state is None:
        raise RuntimeError("scan_state nao configurado")

    log_info = _cfg["log_info"]
    log_debug = _cfg["log_debug"]
    get_db = _cfg["get_db"]
    sanitize_catalog_name = _cfg["sanitize_catalog_name"]
    get_memory_info = _cfg["get_memory_info"]
    face_engine_device = _cfg["face_engine_device"]
    face_engine_gpu_error = _cfg["face_engine_gpu_error"]

    log_info("[Scanner] Start")
    log_info(f"[Scanner] faceDetectionEnabled={req.face_detection_enabled}")
    log_info(f"[SCAN] Worker iniciado: project={req.project_name}")
    scan_state["is_scanning"] = True
    scan_state["status_text"] = "Inicializando..."
    scan_state["progress"] = 0.0
    scan_state["total_processadas"] = 0
    scan_state["total_faces"] = 0
    scan_state["total_matches"] = 0
    scan_state["total_clusters"] = 0
    scan_state["total_files"] = 0
    scan_state["last_folder_scanned"] = req.ori_path
    scan_state["skipped_background_faces"] = 0
    scan_state["provider"] = ""
    scan_state["gpu_error"] = ""
    scan_state["total_found_files"] = 0
    scan_state["total_valid_files"] = 0
    scan_state["total_existing_files"] = 0
    scan_state["total_inserted_files"] = 0
    scan_state["total_ignored_files"] = 0
    scan_state["ignored_reasons"] = {}
    scan_state["scan_summary"] = None
    scan_state["recent_faces"] = []

    _cfg["cluster_centers"] = []
    _cfg["cluster_names"] = []
    _cfg["cluster_counts"] = {}

    try:
        log_info("[SCAN] Carregando cache de embeddings...")
        _cfg["load_embedding_disk_cache"]()
        import gc
        gc.collect()
        mem_info = get_memory_info()
        if isinstance(mem_info, dict) and "percent" in mem_info and mem_info["percent"] > 85:
            log_info(f"AVISO: Memoria alta ({mem_info['percent']}%). Processamento pode ser lento.")
    except Exception as e:
        log_info(f"[SCAN] Erro na inicializacao de memoria: {e}")

    cname = sanitize_catalog_name(req.project_name)
    if _cfg.get("app_state") is not None:
        _cfg["app_state"].current_catalog = cname
    _cfg["current_catalog"] = cname

    try:
        ensure_face_engine()
        _log_memory("after loading face model")
        face_engine_device = get_face_engine_device()
        face_engine_gpu_error = get_face_engine_gpu_error()
        scan_state["device"] = get_face_engine_label() or face_engine_device or "CPU"
        scan_state["provider"] = get_face_engine_provider() or ""
        scan_state["gpu_error"] = face_engine_gpu_error
        scan_state["status_text"] = "Carregando Referências..."
        load_references(req.ref_path)

        scan_roots = [req.ori_path]
        for extra in (req.extra_paths or []):
            if extra and os.path.isdir(extra):
                scan_roots.append(extra)

        scan_inputs = collect_scan_inputs(scan_roots, _cfg["image_extensions"])
        fotos = scan_inputs["files"]
        total = len(fotos)
        ignored_reasons = {
            "invalid_extension": scan_inputs["ignored_invalid_extension"],
            "duplicate_path": scan_inputs["ignored_duplicates"],
            "read_error": 0,
            "ai_error": 0,
        }
        scan_state["total_found_files"] = scan_inputs["found_total"]
        scan_state["total_valid_files"] = scan_inputs["valid_total"]
        scan_state["total_files"] = total
        scan_state["total_ignored_files"] = scan_inputs["ignored_invalid_extension"] + scan_inputs["ignored_duplicates"]
        scan_state["ignored_reasons"] = dict(ignored_reasons)

        log_info(
            f"[SCAN] Arquivos encontrados={scan_inputs['found_total']} "
            f"validos={scan_inputs['valid_total']} "
            f"ignorados_ext={scan_inputs['ignored_invalid_extension']} "
            f"duplicados={scan_inputs['ignored_duplicates']}"
        )

        if total == 0:
            scan_state["status_text"] = "Nenhuma foto encontrada para scan."
            scan_state["is_scanning"] = False
            return

        with get_db(cname) as conn:
            cur = conn.cursor()
            cur.execute("SELECT DISTINCT foto_path FROM ocorrencias")
            existing_photo_paths = {row["foto_path"] for row in cur.fetchall()}
            initial_existing_photo_paths = set(existing_photo_paths)
            inserted_photo_paths = set()
            processed_photo_paths = set()
            log_info(f"[SCAN] Fotos ja existentes no catalogo antes do scan: {len(existing_photo_paths)}")
            # MODO SEGURO: batch_size=1 para permitir cancelamento rapido
            batch_size = 1
            import time
            start_time = time.time()
            total_faces_found = 0
            last_face_update_time = 0

            try:
                scan_state["started_at"] = time.time()
                for i in range(0, total, batch_size):
                    if _cancel_requested():
                        log_info("[Scanner] CANCEL BEFORE BATCH — interrompendo")
                        scan_state["status_text"] = "Scanner interrompido"
                        break

                    p = fotos[i]
                    scan_state["status_text"] = f"Processando {i+1}/{total}: {os.path.basename(p)}"

                    # Carregar UMA foto por vez — nunca um lote inteiro
                    if _cancel_requested():
                        log_info("[Scanner] CANCEL BEFORE IMAGE LOAD")
                        scan_state["status_text"] = "Scanner interrompido"
                        break
                    img = _load_single_image(p)
                    if img is None:
                        if _cancel_requested():
                            break
                        ignored_reasons["read_error"] += 1
                        continue

                    processed_photo_paths.add(p)
                    photo_hash = file_sha1(p)
                    faces = []
                    valid_faces = []
                    t0_face = time.time()

                    if _cancel_requested():
                        log_info("[Scanner] CANCEL BEFORE FACE")
                        try: del img
                        except: pass
                        scan_state["status_text"] = "Scanner interrompido"
                        break

                    try:
                        with quiet_external_output():
                            faces = _cfg["app_face"].get(img) or []
                    except Exception as e:
                        log_debug(f"Falha de AI em {p}: {e}")
                        ignored_reasons["ai_error"] += 1
                        try: del img
                        except: pass
                        continue

                    if _cancel_requested():
                        log_info("[Scanner] CANCEL AFTER FACE — pulando face e DB")
                        try: del img; del faces
                        except: pass
                        scan_state["status_text"] = "Scanner interrompido"
                        break

                    total_faces_in_photo = len(faces)
                    img_h, img_w = img.shape[:2] if img is not None else (0, 0)
                    log_info(
                        f"[Face] faceDetectionEnabled=True "
                        f"faces_encontradas={total_faces_in_photo} "
                        f"image_size={img_w}x{img_h} "
                        f"path={os.path.basename(p)}"
                    )

                    for face in faces:
                        if not hasattr(face, "embedding") or face.embedding is None:
                            continue
                        x1, y1, x2, y2 = map(int, face.bbox)
                        area = face_box_area(x1, y1, x2, y2)
                        if area < _cfg["min_face_area"]:
                            continue
                        valid_faces.append((face, x1, y1, x2, y2, area))

                    # Calcular blur uma vez por foto
                    t0_photo = time.time()
                    
                    # 1. Decode/Read
                    t0_decode = time.time()
                    if img is None:
                        img = imread_unicode(p)
                    t_decode = (time.time() - t0_decode) * 1000

                    # 2. Blur
                    t0_blur = time.time()
                    blur_info = _cfg["get_blur_info"](p, img) if _cfg.get("get_blur_info") else {}
                    b_score = blur_info.get("blur_score")
                    b_status = blur_info.get("blur_status")
                    t_blur = (time.time() - t0_blur) * 1000

                    t_face = 0

                    if not valid_faces:
                        log_info(f"[Face] Nenhum rosto valido em {os.path.basename(p)} (total_detectado={total_faces_in_photo})")
                        log_info(f"[DB] inserindo foto sem rosto path={p}")
                        # Inserir entrada dummy para rastrear a foto mesmo sem faces
                        cur.execute(
                            "INSERT OR IGNORE INTO ocorrencias (aluno_id, foto_path, x1, y1, x2, y2, photo_hash, blur_score, blur_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            ("Sem Rostos", p, None, None, None, None, photo_hash, b_score, b_status),
                        )
                        rowcount = cur.rowcount
                        if p not in existing_photo_paths:
                            inserted_photo_paths.add(p)
                            existing_photo_paths.add(p)
                            log_info(f"[DB] inserida path={p} rowcount={rowcount}")
                        else:
                            log_info(f"[DB] ignorada (ja existe) path={p}")
                    else:
                        largest_face_area = max((face_data[5] for face_data in valid_faces), default=0)
                        
                        # Calcula score de foreground para todas as faces
                        scored_faces = []
                        for face, x1, y1, x2, y2, area in valid_faces:
                            fg_score, is_fg, f_ratio, c_score, bg_reason = calc_foreground_score(
                                x1, y1, x2, y2, area, img.shape, face, b_score
                            )
                            scored_faces.append({
                                "face": face, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "area": area,
                                "fg_score": fg_score, "is_fg": is_fg, "f_ratio": f_ratio,
                                "c_score": c_score, "bg_reason": bg_reason
                            })
                            
                        # Ordena por score para pegar os 3 melhores
                        scored_faces.sort(key=lambda x: x["fg_score"], reverse=True)
                        
                        # Limita para no maximo 3 como foreground
                        fg_count = 0
                        for sf in scored_faces:
                            if sf["is_fg"] == 1:
                                if fg_count < 3:
                                    fg_count += 1
                                else:
                                    sf["is_fg"] = 0
                                    sf["bg_reason"] = "Muitas pessoas na foto (4+)"
                        
                        log_info(f"[Face] faces_validas={len(valid_faces)} foreground={fg_count} foto={os.path.basename(p)}")

                        for sf in scored_faces:
                            face, x1, y1, x2, y2, area = sf["face"], sf["x1"], sf["y1"], sf["x2"], sf["y2"], sf["area"]
                            fg_score, is_fg, f_ratio, c_score, bg_reason = sf["fg_score"], sf["is_fg"], sf["f_ratio"], sf["c_score"], sf["bg_reason"]
                            
                            log_debug(f"[foreground-face] area={f_ratio:.3f} center={c_score:.2f} score={fg_score:.2f} foreground={is_fg} reason={bg_reason}")

                            # Apenas continua se decidimos pular a face baseada no is_background_face original (opcional, vamos manter para não estragar compatibilidade)
                            if is_background_face(x1, y1, x2, y2, largest_face_area, img.shape, len(valid_faces)):
                                scan_state["skipped_background_faces"] += 1
                                continue
                                
                            total_faces_found += 1
                            emb = face.embedding.astype("float32")
                            norm = np.linalg.norm(emb)
                            if norm == 0:
                                continue
                            emb = emb / norm
                            ref_name, ref_sim = find_best_reference(emb)
                            if ref_name is not None and ref_sim >= _cfg["ref_match_threshold"]:
                                nome = ref_name
                                scan_state["total_matches"] += 1
                            else:
                                nome = find_or_create_cluster(emb)
                                scan_state["total_clusters"] = len(_cfg["cluster_names"])
                            
                            t_face = (time.time() - t0_face) * 1000

                            log_info(f"[DB] inserindo face path={p} aluno={nome}")
                            cur.execute(
                                """
                                INSERT OR IGNORE INTO ocorrencias 
                                (aluno_id, foto_path, x1, y1, x2, y2, photo_hash, blur_score, blur_status, 
                                 foreground_score, is_foreground, face_area_ratio, center_score, background_penalty_reason) 
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """,
                                (nome, p, x1, y1, x2, y2, photo_hash, b_score, b_status,
                                 fg_score, is_fg, f_ratio, c_score, bg_reason),
                            )
                            rowcount = cur.rowcount
                            if p not in existing_photo_paths:
                                inserted_photo_paths.add(p)
                                existing_photo_paths.add(p)
                                log_info(f"[DB] inserida path={p} aluno={nome} rowcount={rowcount}")
                            else:
                                log_info(f"[DB] ignorada (ja existe) path={p} aluno={nome}")
                            detected_class = get_reference_class_name(nome)
                            print(f"[db-save] aluno={nome} class_name={detected_class}")
                            cur.execute(
                                """
                                INSERT OR IGNORE INTO alunos (aluno_id, face_cache_path, class_name)
                                VALUES (?, ?, ?)
                                """,
                                (nome, "n/a", detected_class),
                            )
                            
                            current_time = time.time()
                            if current_time - last_face_update_time > 0.5:
                                new_face = {"name": nome, "path": p, "box": [x1, y1, x2, y2]}
                                scan_state["recent_faces"].insert(0, new_face)
                                scan_state["recent_faces"] = scan_state["recent_faces"][:20]
                                last_face_update_time = current_time

                    # Log Benchmark
                    total_ms = (time.time() - t0_photo) * 1000
                    log_info(
                        f"[BENCHMARK] {os.path.basename(p)}: "
                        f"total={total_ms:.0f}ms | "
                        f"decode={t_decode:.0f}ms | "
                        f"blur={t_blur:.0f}ms | "
                        f"face={t_face:.0f}ms"
                    )

                    # Atualizar current_photo com dados reais para o carrossel live
                    scan_state["current_photo"] = {
                        "path": p,
                        "name": os.path.basename(p),
                        "faces": [{"bbox": [f[1], f[2], f[3], f[4]], "confidence": 0.95} for f in valid_faces],
                        "timestamp": time.time()
                    }

                    # Calcular tempo deste arquivo para o histórico de ETA
                    photo_duration = time.time() - t0_photo
                    history = scan_state.get("processing_history", [])
                    history.append(photo_duration)
                    if len(history) > 20: history.pop(0)
                    scan_state["processing_history"] = history

                    # Liberar referencias grandes da foto
                    try:
                        del img
                    except NameError:
                        pass
                    for _vn in ('faces', 'valid_faces', 'scored_faces'):
                        try:
                            _v = locals().get(_vn)
                            if _v is not None:
                                del _v
                        except Exception:
                            pass

                    # Throttling para evitar 100% CPU
                    import time as _time
                    _time.sleep(0.005)

                    if _cancel_requested():
                        log_info("[Scanner] Cancelamento no fim do lote — interrompendo")
                        scan_state["status_text"] = "Scanner interrompido"
                        break

                    scan_state["total_processadas"] = len(processed_photo_paths)
                    scan_state["total_faces"] = total_faces_found
                    scan_state["total_existing_files"] = len(processed_photo_paths.intersection(initial_existing_photo_paths))
                    scan_state["total_inserted_files"] = len(inserted_photo_paths)
                    
                    # Duplicadas reais (por hash ou path ignorado no início)
                    dup_count = scan_inputs.get("ignored_duplicates", 0)
                    scan_state["duplicate_count"] = dup_count
                    if total > 0:
                        scan_state["duplicate_percent"] = round((dup_count / total) * 100, 1)

                    scan_state["total_ignored_files"] = sum(ignored_reasons.values())
                    scan_state["ignored_reasons"] = dict(ignored_reasons)
                    scan_state["progress"] = scan_state["total_processadas"] / total
                    
                    # Cálculo de ETA Real baseado na média móvel das últimas 20 fotos
                    history = scan_state.get("processing_history", [])
                    if len(history) >= 5:
                        avg_speed = sum(history) / len(history)
                        scan_state["eta_seconds"] = int(avg_speed * (total - scan_state["total_processadas"]))
                    else:
                        scan_state["eta_seconds"] = -1 # Indica "Calculando..."
                    
                    conn.commit()
                    gc.collect()

                _log_memory("after scan loop")

                if _cancel_requested():
                    log_info("[Scanner] Cancelamento antes de salvar checkpoint — interrompendo")
                    scan_state["status_text"] = "Scanner interrompido"
                else:
                    _cfg["save_embedding_disk_cache"]()
                    gc.collect()
                    catalog_root = req.ori_path
                    try:
                        if req.ref_path and os.path.isdir(req.ref_path):
                            catalog_root = os.path.commonpath([os.path.abspath(req.ori_path), os.path.abspath(req.ref_path)])
                    except Exception:
                        catalog_root = req.ori_path
                    cur.execute(
                        """
                        INSERT OR REPLACE INTO alunos (aluno_id, face_cache_path, class_name)
                        VALUES (?, ?, ?)
                        """,
                        ("system_catalog", catalog_root, "Sem turma"),
                    )
                    conn.commit()
            finally:
                try:
                    chunk_imgs.clear()
                    del chunk_imgs
                except NameError:
                    pass
                gc.collect()

        if _cancel_requested():
            log_info("[Scanner] Cancelamento — pulando resumo final")
        else:
            scan_state["status_text"] = "Processamento concluído!"
            scan_state["progress"] = 1.0
            scan_state["eta_seconds"] = 0
            scan_state["total_faces"] = total_faces_found
            final_elapsed = time.time() - start_time
            mins = int(final_elapsed // 60)
            secs = int(final_elapsed % 60)
            scan_state["scan_summary"] = {
                "time_str": f"{mins}m {secs}s",
                "total_photos": scan_state["total_processadas"],
                "total_faces": total_faces_found,
                "found_total": scan_state["total_found_files"],
                "valid_total": scan_state["total_valid_files"],
                "inserted_total": scan_state["total_inserted_files"],
                "existing_total": scan_state["total_existing_files"],
                "ignored_total": scan_state["total_ignored_files"],
                "ignored_reasons": dict(scan_state["ignored_reasons"]),
            }
            log_info(
                f"[SCAN] Resumo final: encontradas={scan_state['total_found_files']} "
                f"validas={scan_state['total_valid_files']} processadas={scan_state['total_processadas']} "
                f"faces={total_faces_found} novas={scan_state['total_inserted_files']} "
                f"existentes={scan_state['total_existing_files']} "
                f"ignoradas={scan_state['total_ignored_files']} motivos={scan_state['ignored_reasons']}"
            )
    except Exception as e:
        import traceback
        err_msg = traceback.format_exc()
        log_info(f"[SCAN] ERRO: {str(e)}")
        scan_state["status_text"] = f"Erro falha crítica no scanner: {str(e)}"
        try:
            with open(os.path.join(_cfg["data_dir"], "error_scanner.log"), "w", encoding="utf-8") as f:
                f.write(err_msg)
        except Exception:
            pass
    finally:
        was_cancelled = _cancel_requested()
        scan_state["is_scanning"] = False
        scan_state["total_faces"] = locals().get("total_faces_found", 0)
        scan_state["progress"] = 1.0 if not was_cancelled else scan_state.get("progress", 0)
        scan_state["eta_seconds"] = 0
        if was_cancelled:
            scan_state["stopped"] = True
            scan_state["status_text"] = "Scanner interrompido"
            log_info("[Scanner] Fully stopped")
        _memory_cleanup(scan_state)
        _reset_cancel()
        log_info("[SCAN] Worker finalizado")


def run_quality_audit_worker(catalog_name):
    quality_state = _quality_state()
    if quality_state is None:
        raise RuntimeError("quality_audit_state nao configurado")
    get_db = _cfg["get_db"]
    get_blur_info = _cfg["get_blur_info"]

    try:
        quality_state["status"] = "running"
        quality_state["running"] = True
        quality_state["enabled"] = False
        quality_state["is_auditing"] = True
        quality_state["status_text"] = "Iniciando auditoria..."
        quality_state["message"] = "Iniciando auditoria..."
        quality_state["processed"] = 0
        with get_db(catalog_name) as conn:
            cur = conn.cursor()
            cur.execute("SELECT DISTINCT foto_path FROM ocorrencias WHERE blur_status IS NULL OR blur_status = 'sharp' AND blur_score IS NULL")
            rows = cur.fetchall()
            paths = [r["foto_path"] for r in rows if os.path.exists(r["foto_path"])]
            quality_state["total"] = len(paths)
            if not paths:
                quality_state["status"] = "idle"
                quality_state["status_text"] = "Catálogo já está 100% auditado."
                quality_state["message"] = "Catálogo já está 100% auditado."
                quality_state["running"] = False
                quality_state["is_auditing"] = False
                return
            for i, p in enumerate(paths):
                if not quality_state["is_auditing"] or _cancel_requested():
                    if _cancel_requested():
                        log_info = _cfg.get("log_info")
                        if log_info:
                            log_info("[Scanner] Cancelamento na auditoria de qualidade")
                    break
                quality_state["status_text"] = f"Auditando: {os.path.basename(p)}"
                quality_state["message"] = quality_state["status_text"]
                blur_info = get_blur_info(p)
                cur.execute("SELECT x1, y1, x2, y2 FROM ocorrencias WHERE foto_path = ?", (p,))
                face_rows = cur.fetchall()
                cur.execute(
                    """
                    UPDATE ocorrencias 
                    SET blur_score = ?, blur_status = ? 
                    WHERE foto_path = ?
                    """,
                    (blur_info.get("blur_score"), blur_info.get("blur_status"), p),
                )
                if i % 10 == 0:
                    conn.commit()
                quality_state["processed"] = i + 1
                quality_state["progress"] = (i + 1) / len(paths)
            conn.commit()
        quality_state["status"] = "completed"
        quality_state["status_text"] = "Auditoria concluída!"
        quality_state["message"] = "Auditoria concluída!"
    except Exception as e:
        quality_state["status"] = "error"
        quality_state["status_text"] = f"Erro na auditoria: {str(e)}"
        quality_state["message"] = quality_state["status_text"]
    finally:
        quality_state["running"] = False
        quality_state["is_auditing"] = False
