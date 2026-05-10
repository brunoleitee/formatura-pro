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


def ensure_face_engine():
    import importlib

    global _cfg
    app_face = _cfg["app_face"]
    face_engine_device = _cfg["face_engine_device"]
    face_engine_gpu_error = _cfg["face_engine_gpu_error"]
    available = ["CPUExecutionProvider"]
    try:
        import onnxruntime as ort
        available = ort.get_available_providers()
        for prov in ["CUDAExecutionProvider", "TensorrtExecutionProvider"]:
            if prov in available:
                try:
                    ort.preload_dlls(cuda=True, cudnn=True, msvc=True, directory="" if prov == "CUDAExecutionProvider" else "")
                    break
                except Exception:
                    available = ["CPUExecutionProvider"]
                    break
    except Exception as e:
        _cfg["log_debug"](f"Erro verificando providers: {e}")

    from functools import reduce
    wants_cuda = reduce(lambda a, b: a and b, ["CUDAExecutionProvider" in available])
    if app_face is not None:
        if wants_cuda and face_engine_device != "GPU":
            app_face = None
        else:
            return

    providers = ["CPUExecutionProvider"]
    provider_options = None
    ctx_id = -1
    face_engine_device = "CPU"
    model_root = _cfg["runtime_dir"] if os.path.isdir(os.path.join(_cfg["runtime_dir"], "models", "buffalo_l")) else "~/.insightface"

    if wants_cuda:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
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
        face_engine_device = "GPU"

    try:
        from insightface.app import FaceAnalysis
        app_face = FaceAnalysis(name="buffalo_l", root=model_root, providers=providers, provider_options=provider_options, allowed_modules=["detection", "recognition"])
        app_face.prepare(ctx_id=ctx_id, det_size=_cfg.get("det_size", (640, 640)))
    except Exception as e:
        if "CUDAExecutionProvider" not in providers:
            raise
        face_engine_gpu_error = str(e)
        face_engine_device = "CPU"
        app_face = FaceAnalysis(name="buffalo_l", root=model_root, providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"])
        app_face.prepare(ctx_id=-1, det_size=_cfg.get("det_size", (640, 640)))

    _cfg["app_face"] = app_face
    _cfg["face_engine_device"] = face_engine_device
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
        scan_state["device"] = face_engine_device or "CPU"
        scan_state["gpu_error"] = face_engine_gpu_error
        scan_state["status_text"] = "Carregando Referências..."
        load_references(req.ref_path)

        fotos = [os.path.join(r, f) for r, d, files in os.walk(req.ori_path) for f in files if f.lower().endswith(_cfg["image_extensions"])]
        total = len(fotos)
        scan_state["total_files"] = total

        if total == 0:
            scan_state["status_text"] = "Nenhuma foto encontrada para scan."
            scan_state["is_scanning"] = False
            return

        with get_db(cname) as conn:
            cur = conn.cursor()
            batch_size = 24 if face_engine_device == "GPU" else 12
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

                        largest_face_area = max((face_data[5] for face_data in valid_faces), default=0)
                        for face, x1, y1, x2, y2, area in valid_faces:
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
                                "INSERT OR IGNORE INTO ocorrencias (aluno_id, foto_path, x1, y1, x2, y2, photo_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                (nome, p, x1, y1, x2, y2, photo_hash),
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
        quality_state["is_auditing"] = True
        quality_state["status_text"] = "Iniciando auditoria..."
        quality_state["processed"] = 0
        with get_db(catalog_name) as conn:
            cur = conn.cursor()
            cur.execute("SELECT DISTINCT foto_path FROM ocorrencias WHERE blur_status IS NULL OR blur_status = 'sharp' AND blur_score IS NULL")
            rows = cur.fetchall()
            paths = [r["foto_path"] for r in rows if os.path.exists(r["foto_path"])]
            quality_state["total"] = len(paths)
            if not paths:
                quality_state["status_text"] = "Catálogo já está 100% auditado."
                quality_state["is_auditing"] = False
                return
            for i, p in enumerate(paths):
                if not quality_state["is_auditing"]:
                    break
                quality_state["status_text"] = f"Auditando: {os.path.basename(p)}"
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
        quality_state["status_text"] = "Auditoria concluída!"
    except Exception as e:
        quality_state["status_text"] = f"Erro na auditoria: {str(e)}"
    finally:
        quality_state["is_auditing"] = False
