import gc
import os
import threading
import urllib.parse
import traceback
from collections import Counter

from fastapi import HTTPException
from pydantic import BaseModel

_cfg = {}

def _log_memory(label=""):
    log_info = _cfg.get("log_info", lambda msg, *args, **kwargs: None)
    try:
        import psutil
        proc = psutil.Process(os.getpid())
        rss = proc.memory_info().rss / (1024 * 1024)
        log_info(f"[MEM] {label} — RSS={rss:.0f}MB")
    except Exception:
        pass


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    value = _get(name, default)
    return value() if callable(value) else value


def _collect_scan_files(root_paths, image_extensions):
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
                    norm_path = os.path.normcase(os.path.abspath(full_path))
                    if norm_path in seen_files:
                        counters["ignored_duplicates"] += 1
                        continue
                    seen_files.add(norm_path)
                    files_to_process.append(full_path)
                else:
                    counters["ignored_invalid_extension"] += 1
                    if ext:
                        counters[f"ignored_ext:{ext}"] += 1
                    else:
                        counters["ignored_ext:<sem_ext>"] += 1

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


from pydantic import BaseModel, Field, validator
import re

from typing import List, Optional
class ScanRequest(BaseModel):
    ref_path: Optional[str] = Field(default="", max_length=500)
    event_path: str = Field(..., min_length=1, max_length=500)
    project_name: Optional[str] = Field(default="Scanner", max_length=100)
    extra_paths: List[str] = Field(default_factory=list, max_items=10)
    selected_folders: Optional[List[str]] = Field(default_factory=list)

    @validator('ref_path', 'event_path', 'project_name', pre=True)
    def handle_none(cls, v):
        return v or ""

    @validator('ref_path', 'event_path', 'project_name')
    def sanitize_strings(cls, v):
        if not isinstance(v, str):
            v = str(v or "")
        v = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', v)
        v = re.sub(r'\.\./|\.\.\\', '', v)
        return v.strip()

    @validator('extra_paths', 'selected_folders', each_item=True)
    def sanitize_extra_paths(cls, v):
        v = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', v)
        v = re.sub(r'\.\./|\.\.\\', '', v)
        return v.strip()


def scan_precheck(req: ScanRequest):
    try:
        print(f"[DEBUG] Recebido precheck para o projeto: {req.project_name}")
        sanitize_catalog_name = _get("sanitize_catalog_name")
        catalog_dir = _get("catalog_dir")
        get_db = _get("get_db")
        image_extensions = _get("image_extensions", ())
        gpu_diagnostics = _get("gpu_diagnostics")

        checks = []
        warnings = []
        errors = []
        project_name = (req.project_name or "").strip()

        try:
            cname = sanitize_catalog_name(project_name)
            checks.append({"label": "Nome do catálogo", "ok": True, "detail": cname})
        except Exception:
            cname = ""
            errors.append("Informe um nome válido para o catálogo.")
            checks.append({"label": "Nome do catálogo", "ok": False, "detail": "Nome vazio ou inválido"})

        catalog_exists = False
        db_path = os.path.join(catalog_dir, f"{cname}.db") if cname else ""
        if db_path and os.path.exists(db_path):
            try:
                with get_db(cname) as conn:
                    if conn.conn:
                        cur = conn.cursor()
                        cur.execute("SELECT 1 FROM ocorrencias LIMIT 1")
                        has_occurrences = cur.fetchone() is not None
                        cur.execute("SELECT 1 FROM discarded_photos LIMIT 1")
                        has_discarded = cur.fetchone() is not None
                        cur.execute("SELECT 1 FROM alunos WHERE aluno_id != 'system_catalog' LIMIT 1")
                        has_alunos = cur.fetchone() is not None
                        catalog_exists = has_occurrences or has_discarded or has_alunos
            except Exception:
                catalog_exists = True
        if catalog_exists:
            warnings.append("Já existe um catálogo com esse nome. O scanner pode acrescentar novas ocorrências nele.")

        ori_ok = bool(req.event_path and os.path.isdir(req.event_path))
        checks.append({"label": "Pasta de fotos", "ok": ori_ok, "detail": req.event_path or "Não selecionada"})
        if not ori_ok:
            errors.append("Selecione uma pasta válida de fotos do evento.")

        extra_paths = []
        extra_invalid = []
        seen_paths = set()
        for path in req.extra_paths or []:
            if not path:
                continue
            abs_path = os.path.abspath(path)
            if abs_path in seen_paths:
                continue
            seen_paths.add(abs_path)
            if os.path.isdir(abs_path):
                extra_paths.append(abs_path)
            else:
                extra_invalid.append(abs_path)
        if extra_paths:
            checks.append({"label": "Pastas adicionais", "ok": True, "detail": f"{len(extra_paths)} pasta(s)"})
        if extra_invalid:
            warnings.append(f"{len(extra_invalid)} pasta(s) adicional(is) não foram encontradas e serão ignoradas.")

        ref_selected = bool(req.ref_path)
        ref_ok = bool(req.ref_path and os.path.isdir(req.ref_path))
        checks.append({"label": "Pasta de referências", "ok": (not ref_selected) or ref_ok, "detail": req.ref_path or "Opcional"})
        if ref_selected and not ref_ok:
            warnings.append("A pasta de referências não foi encontrada. O scanner seguirá agrupando por semelhança.")
        elif not ref_selected:
            warnings.append("Sem referências selecionadas. O scanner criará grupos automáticos para conferência.")

        scan_roots = []
        seen_scan_roots = set()
        for root_path in [req.event_path] + extra_paths:
            if not root_path:
                continue
            abs_root = os.path.abspath(root_path)
            if abs_root in seen_scan_roots:
                continue
            seen_scan_roots.add(abs_root)
            scan_roots.append(abs_root)
        photo_stats = _collect_scan_files(scan_roots, image_extensions)
        photo_count = photo_stats["valid_total"]

        ref_count = 0
        ref_stats = {
            "found_total": 0,
            "valid_total": 0,
            "ignored_invalid_extension": 0,
            "ignored_duplicates": 0,
        }
        if ref_ok:
            ref_stats = _collect_scan_files([req.ref_path], image_extensions)
            ref_count = ref_stats["valid_total"]
        checks.append({"label": "Fotos encontradas", "ok": photo_count > 0, "detail": f"{photo_count} imagem(ns)"})
        if ori_ok and photo_count == 0:
            errors.append("Nenhuma imagem valida foi encontrada na pasta de fotos.")

        if photo_stats["ignored_invalid_extension"] > 0:
            warnings.append(
                f"{photo_stats['ignored_invalid_extension']} arquivo(s) foram ignorados por extensao invalida."
            )

        gpu = gpu_diagnostics()
        gpu_ok = bool(gpu.get("cuda_available") or gpu.get("directml_available"))
        provider_label = gpu.get("active_device")
        if not provider_label or provider_label == "Não inicializado":
            provider_label = {
                "CUDAExecutionProvider": "GPU NVIDIA",
                "DmlExecutionProvider": "GPU DirectML",
                "CPUExecutionProvider": "CPU",
            }.get(gpu.get("preferred_provider"), "CPU")
        checks.append({"label": "Placa de vídeo", "ok": gpu_ok, "detail": provider_label})
        if not gpu_ok:
            warnings.append("GPU não ativada. O processamento pode ficar mais lento.")

        return {
            "can_start": len(errors) == 0,
            "project_name": cname,
            "catalog_exists": catalog_exists,
            "photo_count": photo_count,
            "reference_count": ref_count,
            "photo_stats": photo_stats,
            "reference_stats": ref_stats,
            "device": provider_label,
            "gpu_error": gpu.get("gpu_error", ""),
            "checks": checks,
            "warnings": warnings,
            "errors": errors,
        }
    except Exception as e:
        print(f"ERRO em scan_precheck: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def quiet_external_output():
    return _get("quiet_external_output")()


def safe_path_join(*parts):
    try:
        return os.path.join(*parts)
    except Exception:
        return None


def imread_unicode(path):
    return _get("imread_unicode")(path)


def ensure_face_engine():
    return _get("ensure_face_engine")()


def load_references(ref_path):
    return _get("load_references")(ref_path)


def find_best_reference(emb):
    return _get("find_best_reference")(emb)


def find_or_create_cluster(emb):
    return _get("find_or_create_cluster")(emb)


def clear_checkpoints(req: dict):
    try:
        sanitize_catalog_name = _get("sanitize_catalog_name")
        get_db = _get("get_db")
        app_state = _get("app_state")
        cname = sanitize_catalog_name(req.get("catalog_name", app_state.current_catalog))
        with get_db(cname) as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM scan_checkpoints")
            conn.commit()
        return {"status": "ok", "message": "Checkpoints limpos. Proximo scan sera completo."}
    except Exception as e:
        print(f"ERRO em clear_checkpoints: {e}")
        traceback.print_exc()
        raise HTTPException(400, f"Erro ao limpar checkpoints: {str(e)}")


def _safe_scanner_worker(se, req, log_info, scan_state):
    try:
        se.run_scanner_worker(req)
    except Exception as e:
        err_msg = traceback.format_exc()
        log_info(f"[ERRO CRÍTICO] Falha no worker do scanner: {err_msg}")
        scan_state["status_text"] = "Erro ao iniciar scanner."
        scan_state["gpu_error"] = str(e)
        scan_state["is_scanning"] = False


def start_scan(req: ScanRequest):
    try:
        scan_state = _get("scan_state")
        sanitize_catalog_name = _get("sanitize_catalog_name")
        log_info = _get("log_info")
        se = _get("scanner_engine")
        from backend_state import scanner_cancel as _sc
        if scan_state["is_scanning"] or _sc.get("running", False):
            raise HTTPException(status_code=400, detail="Scanner já está em execução.")
        try:
            sanitize_catalog_name(req.project_name)
        except Exception as e:
            raise HTTPException(400, f"Nome de catálogo inválido: {e}")
        if not req.event_path or not os.path.isdir(req.event_path):
            raise HTTPException(status_code=400, detail="Selecione uma pasta válida de fotos brutas.")
        _log_memory("before scanner start")
        scan_state["is_scanning"] = True
        scan_state["stopped"] = False
        scan_state["status_text"] = "Iniciando scanner..."
        scan_state["progress"] = 0.0
        scan_state["total_processadas"] = 0
        scan_state["total_faces"] = 0
        scan_state["total_files"] = 0
        scan_state["eta_seconds"] = 0
        scan_state["gpu_error"] = ""
        scan_state["scan_summary"] = None
        scan_state["total_found_files"] = 0
        scan_state["total_valid_files"] = 0
        scan_state["total_existing_files"] = 0
        scan_state["total_inserted_files"] = 0
        scan_state["total_ignored_files"] = 0
        scan_state["ignored_reasons"] = {}
        scan_state["event_path"] = req.event_path or ""
        scan_state["ref_path"] = req.ref_path or ""
        from backend_state import scanner_cancel as _sc
        _sc["running"] = True
        _sc["cancel_requested"] = False
        log_info(f"[SCAN] Iniciando scanner: project={req.project_name}, ref={req.ref_path}, ori={req.event_path}")

        # Salvar event_path e ref_path como pastas vinculadas ao catálogo
        try:
            get_db = _get("get_db")
            if get_db and req.project_name:
                with get_db(req.project_name) as conn:
                    cur = conn.cursor()
                    for path, ftype in [(req.event_path, "event"), (req.ref_path, "reference")]:
                        if path and path.strip():
                            cur.execute("SELECT id, folder_type FROM catalog_folders WHERE catalog_name = ? AND path = ?",
                                        (req.project_name, path))
                            existing = cur.fetchone()
                            if existing:
                                if existing["folder_type"] != ftype:
                                    cur.execute("UPDATE catalog_folders SET folder_type = ? WHERE id = ?",
                                                (ftype, existing["id"]))
                            else:
                                cur.execute("""
                                    INSERT INTO catalog_folders (catalog_name, path, include_subfolders, photo_count, folder_type)
                                    VALUES (?, ?, 1, 0, ?)
                                """, (req.project_name, path, ftype))
                    conn.commit()
                    print(f"[CatalogFolders] saved event={req.event_path} reference={req.ref_path}", flush=True)
        except Exception as e:
            print(f"[CatalogFolders] error saving scan paths: {e}", flush=True)

        threading.Thread(target=_safe_scanner_worker, args=(se, req, log_info, scan_state), daemon=True).start()
        return {"message": "Scanner Batch iniciado."}
    except HTTPException:
        raise
    except Exception as e:
        print(f"ERRO em start_scan: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def get_scan_status():
    return _get("scan_state")


def clear_scan_summary():
    scan_state = _get("scan_state")
    scan_state["scan_summary"] = None
    return {"status": "ok"}


def _memory_cleanup_global(log_info=None):
    if log_info is None:
        log_info = _get("log_info", lambda msg, *args, **kwargs: None)
    log_info("[Scanner] cleanup start")

    # 1. scan_state accumulators - never store PIL/numpy/cv2/base64/bytes
    ss = _get("scan_state")
    if ss is not None:
        ss["current_photo"] = None
        ss["recent_faces"] = []
        ss.pop("processing_history", None)
        ss["total_processadas"] = 0
        ss["total_faces"] = 0
        ss["total_files"] = 0
        ss["total_found_files"] = 0
        ss["total_valid_files"] = 0
        ss["total_inserted_files"] = 0
        ss["total_existing_files"] = 0
        ss["total_ignored_files"] = 0
        ss["ignored_reasons"] = {}
        ss["duplicate_count"] = 0
        ss["duplicate_percent"] = 0
        ss["eta_seconds"] = 0
        ss["total_matches"] = 0
        ss["total_clusters"] = 0
        ss["skipped_background_faces"] = 0
        ss["scan_summary"] = None
        ss["progress"] = 0.0
        ss["faces"] = []
        ss["scanQueue"] = []
        ss["processedItems"] = []

    # 2. AI queue
    try:
        from services.ai_processing_queue import ai_processing_queue
        ai_processing_queue.running = False
        with ai_processing_queue.queue.mutex:
            ai_processing_queue.queue.queue.clear()
            ai_processing_queue.queue.all_tasks_done.notify_all()
            ai_processing_queue.queue.unfinished_tasks = 0
        if log_info:
            log_info("[Scanner] queues cleared")
    except Exception:
        pass

    # 3. Embedding cache — bigger than anything else
    try:
        import backend_state
        backend_state._EMBEDDING_DISK_CACHE.clear()
        backend_state._EMBEDDING_DISK_CACHE_LOADED = False
        backend_state.cluster_centers.clear()
        backend_state.cluster_names.clear()
        backend_state.cluster_counts.clear()
        backend_state.ref_ids.clear()
        if hasattr(backend_state, 'ref_classes'):
            backend_state.ref_classes.clear()
        backend_state.faiss_index = None
        if log_info:
            log_info("[Scanner] embedding cache cleared")
    except Exception:
        pass

    # 4. Clear scanner_engine._cfg references
    try:
        se = _get("scanner_engine")
        if se is not None:
            se._cfg["cluster_centers"] = []
            se._cfg["cluster_names"] = []
            se._cfg["cluster_counts"] = {}
            se._cfg["ref_ids"] = []
            se._cfg["ref_classes"] = {}
            se._cfg["faiss_index"] = None
    except Exception:
        pass

    # 5. Clear quality analysis memory caches
    try:
        from quality_analysis import clear_memory_caches
        clear_memory_caches()
        if log_info:
            log_info("[Scanner] blur cache cleared")
    except Exception:
        pass

    # 6. Torch/CUDA cleanup
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            if log_info:
                log_info("[Scanner] torch CUDA cache emptied")
    except Exception:
        pass

    # 7. Forced GC
    import gc
    for _ in range(3):
        gc.collect()
    _log_memory("after cleanup/gc")
    if log_info:
        log_info("[Scanner] gc collected")
        log_info("[Scanner] cleanup done")


def stop_scan():
    scan_state = _get("scan_state")
    scan_state["is_scanning"] = False
    scan_state["stopped"] = True
    scan_state["status_text"] = "Scanner interrompido"

    log_info = _get("log_info")
    if log_info:
        log_info("[Scanner] STOP REQUESTED — cancelamento real ativado")

    from backend_state import scanner_cancel as _sc
    _sc["cancel_requested"] = True
    _sc["running"] = False
    _sc["stopped"] = True

    from services.ai_processing_queue import ai_processing_queue
    try:
        ai_processing_queue.running = False
        with ai_processing_queue.queue.mutex:
            ai_processing_queue.queue.queue.clear()
            ai_processing_queue.queue.all_tasks_done.notify_all()
            ai_processing_queue.queue.unfinished_tasks = 0
        if log_info:
            log_info("[Scanner] AI queue emptied and stopped")
    except Exception:
        pass

    _memory_cleanup_global(log_info)
    _log_memory("after stop")

    # WATCHDOG: se o worker nao parar em 10s, força sys.exit()
    def _watchdog_kill():
        import time
        time.sleep(10)
        s = _get("scan_state")
        if s is not None and s.get("is_scanning", False):
            if log_info:
                log_info("[Scanner] WATCHDOG — worker nao parou, forçando sys.exit(1)")
            _sc["KILL_NOW"] = True
            import sys
            sys.exit(1)

    threading.Thread(target=_watchdog_kill, daemon=True).start()

    return {"message": "Cancelamento real ativado. Scanner sera interrompido em breve."}


def force_cleanup():
    log_info = _get("log_info", lambda msg, *args, **kwargs: None)
    _memory_cleanup_global(log_info)
    return {"success": True, "message": "Cleanup forcado concluido."}


def unload_models():
    log_info = _get("log_info", lambda msg, *args, **kwargs: None)
    log_info("[Scanner] Unload models requested")

    _memory_cleanup_global(log_info)

    # Unload InsightFace face model
    try:
        se = _get("scanner_engine")
        if se is not None:
            app_face = se._cfg.get("app_face")
            if app_face is not None:
                try:
                    del app_face
                except Exception:
                    pass
                se._cfg["app_face"] = None
                se._cfg["face_engine_device"] = ""
                se._cfg["face_engine_provider"] = ""
                se._cfg["face_engine_label"] = ""
                se._cfg["face_engine_gpu_error"] = ""
                log_info("[Scanner] Face model unloaded")
    except Exception as e:
        log_info(f"[Scanner] Error unloading face model: {e}")

    # Clear app_face in backend_state if present
    try:
        import backend_state
        if hasattr(backend_state, 'app_face'):
            backend_state.app_face = None
    except Exception:
        pass

    # Clear ONNX sessions if accessible
    try:
        import onnxruntime as ort
        try:
            ort.get_default_session().end_profiling()
        except Exception:
            pass
    except Exception:
        pass

    # Torch CUDA cleanup
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            log_info("[Scanner] torch CUDA cache emptied")
    except Exception:
        pass

    import gc
    gc.collect()
    gc.collect()
    gc.collect()
    _log_memory("after unload models")

    return {"success": True, "message": "Modelos descarregados e memoria limpa."}


def start_quality_audit(req: dict):
    quality_audit_state = _get("quality_audit_state")
    se = _get("scanner_engine")
    app_state = _get("app_state")
    if quality_audit_state["is_auditing"]:
        return {"status": "already_running"}
    cname = req.get("catalog", app_state.current_catalog)
    threading.Thread(target=se.run_quality_audit_worker, args=(cname,), daemon=True).start()
    return {"status": "started"}


def _normalize_quality_audit_status(state=None):
    source = state if isinstance(state, dict) else {}
    running = bool(source.get("is_auditing") or source.get("running"))
    processed = max(0, int(source.get("processed") or 0))
    total = max(0, int(source.get("total") or 0))
    raw_progress = source.get("progress", 0) or 0
    try:
        progress = float(raw_progress)
    except Exception:
        progress = 0.0
    if progress > 1:
        progress = progress / 100.0
    progress = max(0.0, min(1.0, progress))
    status_text = str(
        source.get("status_text")
        or source.get("message")
        or ("Auditoria em andamento" if running else "Quality audit não iniciado")
    )
    status = str(source.get("status") or ("running" if running else "idle"))
    enabled = bool(source.get("enabled", False))

    return {
        "status": status,
        "running": running,
        "enabled": enabled,
        "processed": processed,
        "total": total,
        "progress": progress,
        "message": status_text,
        "is_auditing": running,
        "status_text": status_text,
    }


def get_quality_audit_status():
    try:
        return _normalize_quality_audit_status(_get("quality_audit_state"))
    except Exception as e:
        return {
            "status": "error",
            "running": False,
            "enabled": False,
            "processed": 0,
            "total": 0,
            "progress": 0.0,
            "message": str(e),
            "is_auditing": False,
            "status_text": str(e),
        }


def exit_app():
    scan_state = _value("scan_state", {})
    export_state = _value("export_state", {})
    if isinstance(scan_state, dict):
        scan_state["is_scanning"] = False
    if isinstance(export_state, dict):
        export_state["is_exporting"] = False
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"status": "closing"}
