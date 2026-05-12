import contextlib
import hashlib
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

_cfg = {
    "log_debug": lambda msg: None,
    "log_info": lambda msg: None,
    "quiet_external_output": contextlib.nullcontext,
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
    "image_extensions": (".jpg", ".jpeg", ".png"),
    "image_models_ready": False,
    "app_face": None,
    "face_engine_device": "",
    "face_engine_provider": "",
    "face_engine_label": "",
    "face_engine_gpu_error": "",
    "det_size": (640, 640),
    "faiss_index": None,
    "ref_ids": [],
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
    available = ["CPUExecutionProvider"]
    ort_version = ""
    provider_error = ""
    preload_error = ""

    try:
        import onnxruntime as ort

        available = ort.get_available_providers()
        ort_version = getattr(ort, "__version__", "")

        if "CUDAExecutionProvider" in available:
            try:
                ort.preload_dlls(cuda=True, cudnn=True, msvc=True, directory="")
            except Exception as e:
                preload_error = str(e)
                _cfg["log_info"](f"[AI] CUDA disponível, mas falhou ao pré-carregar DLLs: {e}")
    except Exception as e:
        provider_error = str(e)
        _cfg["log_debug"](f"Erro verificando providers: {e}")
        available = ["CPUExecutionProvider"]

    _cfg["log_info"](f"[AI] ONNXRuntime providers disponíveis: {available}")

    candidates = [_provider_config(provider) for provider in AI_PROVIDER_PRIORITY if provider in available]
    if not candidates:
        candidates = [_provider_config("CPUExecutionProvider")]

    return {
        "available_providers": available,
        "ort_version": ort_version,
        "provider_error": provider_error,
        "preload_error": preload_error,
        "selected_provider": candidates[0]["provider"],
        "selected_label": candidates[0]["label"],
        "candidates": candidates,
    }


def ensure_face_engine():
    global _cfg
    app_face = _cfg["app_face"]
    face_engine_device = _cfg["face_engine_device"]
    face_engine_provider = _cfg["face_engine_provider"]
    face_engine_label = _cfg["face_engine_label"]
    face_engine_gpu_error = _cfg["face_engine_gpu_error"]
    provider_info = get_available_ai_provider()
    selected_provider = provider_info["selected_provider"]

    if app_face is not None:
        if not face_engine_provider or face_engine_provider != selected_provider:
            app_face = None
        else:
            return

    model_root = _cfg["runtime_dir"] if os.path.isdir(os.path.join(_cfg["runtime_dir"], "models", "buffalo_l")) else "~/.insightface"

    from insightface.app import FaceAnalysis

    errors = []
    preload_error = provider_info.get("preload_error", "")

    for candidate in provider_info["candidates"]:
        try:
            _cfg["log_info"](
                f"[AI] Tentando provider {candidate['provider']} "
                f"({candidate['label']}) com cadeia {candidate['providers']}"
            )
            app_face = FaceAnalysis(
                name="buffalo_l",
                root=model_root,
                providers=candidate["providers"],
                provider_options=candidate["provider_options"],
                allowed_modules=["detection", "recognition"],
            )
            app_face.prepare(ctx_id=candidate["ctx_id"], det_size=_cfg.get("det_size", (640, 640)))

            face_engine_device = candidate["device"]
            face_engine_provider = candidate["provider"]
            face_engine_label = candidate["label"]
            face_engine_gpu_error = ""
            _cfg["log_info"](f"[AI] Provider ativo: {face_engine_provider} ({face_engine_label})")
            break
        except Exception as e:
            errors.append(f"{candidate['provider']}: {e}")
            _cfg["log_info"](f"[AI] Falha ao carregar {candidate['provider']}: {e}")
            app_face = None
    else:
        raise RuntimeError("Falha ao inicializar InsightFace em todos os providers candidatos.")

    if errors:
        face_engine_gpu_error = preload_error or " | ".join(errors)

    _cfg["app_face"] = app_face
    _cfg["face_engine_device"] = face_engine_device
    _cfg["face_engine_provider"] = face_engine_provider
    _cfg["face_engine_label"] = face_engine_label
    _cfg["face_engine_gpu_error"] = face_engine_gpu_error


def load_references(ref_path):
    global _cfg
    faiss_index = None
    ref_ids = []
    refs = []
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
            refs.append({"id": Path(f).stem, "emb": emb})
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

    log_info(f"[SCAN] Worker iniciado: project={req.project_name}")
    scan_state["is_scanning"] = True
    scan_state["status_text"] = "Inicializando..."
    scan_state["progress"] = 0.0
    scan_state["total_processadas"] = 0
    scan_state["total_matches"] = 0
    scan_state["total_clusters"] = 0
    scan_state["total_files"] = 0
    scan_state["last_folder_scanned"] = req.ori_path
    scan_state["skipped_background_faces"] = 0
    scan_state["provider"] = ""
    scan_state["gpu_error"] = ""
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
                
        fotos = []
        for root_path in scan_roots:
            for r, d, files in os.walk(root_path):
                for f in files:
                    if f.lower().endswith(_cfg["image_extensions"]):
                        fotos.append(os.path.join(r, f))
                        
        total = len(fotos)
        scan_state["total_files"] = total

        if total == 0:
            scan_state["status_text"] = "Nenhuma foto encontrada para scan."
            scan_state["is_scanning"] = False
            return

        with get_db(cname) as conn:
            cur = conn.cursor()
            batch_size = 24 if get_face_engine_device() == "GPU" else 12
            import time
            start_time = time.time()
            total_faces_found = 0
            last_face_update_time = 0

            try:
                for i in range(0, total, batch_size):
                    if not scan_state["is_scanning"]:
                        break
                    chunk_paths = fotos[i:i + batch_size]
                    scan_state["status_text"] = f"Decodificando Lote {i} a {min(total, i + batch_size)}..."
                    chunk_imgs = [imread_unicode(path) for path in chunk_paths]
                    scan_state["status_text"] = f"Inferencia IA Lote {i} a {min(total, i + batch_size)}..."

                    for p, img in zip(chunk_paths, chunk_imgs):
                        if img is None:
                            continue
                        photo_hash = file_sha1(p)
                        try:
                            with quiet_external_output():
                                faces = _cfg["app_face"].get(img) or []
                        except Exception as e:
                            log_debug(f"Falha de AI em {p}: {e}")
                            continue

                        valid_faces = []
                        for face in faces:
                            if not hasattr(face, "embedding") or face.embedding is None:
                                continue
                            x1, y1, x2, y2 = map(int, face.bbox)
                            area = face_box_area(x1, y1, x2, y2)
                            if area < _cfg["min_face_area"]:
                                continue
                            valid_faces.append((face, x1, y1, x2, y2, area))

                        # Calcular blur uma vez por foto
                        blur_info = _cfg["get_blur_info"](p, img) if _cfg.get("get_blur_info") else {}
                        b_score = blur_info.get("blur_score")
                        b_status = blur_info.get("blur_status")

                        if not valid_faces:
                            # Inserir entrada dummy para rastrear a foto mesmo sem faces
                            cur.execute(
                                "INSERT OR IGNORE INTO ocorrencias (aluno_id, foto_path, x1, y1, x2, y2, photo_hash, blur_score, blur_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                ("Sem Rostos", p, None, None, None, None, photo_hash, b_score, b_status),
                            )
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
                            
                            log_debug(f"[foreground] foto={os.path.basename(p)} faces={len(scored_faces)} principais={fg_count} ignoradas_bg={len(scored_faces)-fg_count}")

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
                                cur.execute("INSERT OR IGNORE INTO alunos VALUES (?, ?)", (nome, "n/a"))
                                
                                current_time = time.time()
                                if current_time - last_face_update_time > 0.5:
                                    new_face = {"name": nome, "path": p, "box": [x1, y1, x2, y2]}
                                    scan_state["recent_faces"].insert(0, new_face)
                                    scan_state["recent_faces"] = scan_state["recent_faces"][:50]
                                    last_face_update_time = current_time

                    scan_state["total_processadas"] = min(total, i + batch_size)
                    scan_state["progress"] = scan_state["total_processadas"] / total
                    elapsed = time.time() - start_time
                    if scan_state["total_processadas"] > 0:
                        scan_state["eta_seconds"] = int((elapsed / scan_state["total_processadas"]) * (total - scan_state["total_processadas"]))
                    conn.commit()
                    gc.collect()

                _cfg["save_embedding_disk_cache"]()
                gc.collect()
                catalog_root = req.ori_path
                try:
                    if req.ref_path and os.path.isdir(req.ref_path):
                        catalog_root = os.path.commonpath([os.path.abspath(req.ori_path), os.path.abspath(req.ref_path)])
                except Exception:
                    catalog_root = req.ori_path
                cur.execute("INSERT OR REPLACE INTO alunos VALUES (?, ?)", ("system_catalog", catalog_root))
                conn.commit()
            finally:
                pass

        scan_state["status_text"] = "Processamento concluído!"
        final_elapsed = time.time() - start_time
        mins = int(final_elapsed // 60)
        secs = int(final_elapsed % 60)
        scan_state["scan_summary"] = {
            "time_str": f"{mins}m {secs}s",
            "total_photos": scan_state["total_processadas"],
            "total_faces": total_faces_found
        }
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
        scan_state["is_scanning"] = False
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
                if not quality_state["is_auditing"]:
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
