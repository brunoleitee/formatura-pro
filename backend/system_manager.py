import os
import shutil
import time

from fastapi import HTTPException
from pydantic import BaseModel

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    value = _get(name, default)
    return value() if callable(value) else value


def gpu_diagnostics():
    ort_version = ""
    try:
        import onnxruntime as ort
        available = ort.get_available_providers()
        ort_version = getattr(ort, "__version__", "")
    except Exception as e:
        available = []
        provider_error = str(e)
    else:
        provider_error = ""
    scan_state = _get("scan_state", {})
    return {
        "available_providers": available,
        "cuda_available": "CUDAExecutionProvider" in available,
        "active_device": _value("face_engine_device", "") or scan_state.get("device") or "Não inicializado",
        "gpu_error": _value("face_engine_gpu_error", "") or scan_state.get("gpu_error") or provider_error,
        "onnxruntime": ort_version,
    }


def get_memory_info():
    try:
        import psutil
        mem = psutil.virtual_memory()
        return {
            "total_gb": round(mem.total / (1024 ** 3), 1),
            "available_gb": round(mem.available / (1024 ** 3), 1),
            "used_gb": round(mem.used / (1024 ** 3), 1),
            "percent": mem.percent,
        }
    except ImportError:
        return {"error": "psutil nao disponivel"}
    except Exception:
        return {"error": "Falha ao obter info de memoria"}


def system_status():
    data_dir = _get("data_dir")
    thumb_cache_dir = _get("thumb_cache_dir")
    backup_dir = _get("backup_dir")
    app_name = _get("app_name")
    app_version = _get("app_version")
    scan_state = _get("scan_state", {})
    export_state = _get("export_state", {})
    load_export_history = _get("load_export_history")
    current_catalog = _value("get_current_catalog")
    _embedding_disk_cache = _value("embedding_cache", {})
    automation = _get("automation")
    
    try:
        catalogs = [f for f in os.listdir(_get("catalog_dir")) if f.endswith(".db")]
    except Exception:
        catalogs = []

    latest_backup = None
    try:
        backup_files = [
            os.path.join(backup_dir, f)
            for f in os.listdir(backup_dir)
            if os.path.isfile(os.path.join(backup_dir, f))
        ]
        if backup_files:
            latest_path = max(backup_files, key=lambda p: os.path.getmtime(p))
            latest_backup = {
                "name": os.path.basename(latest_path),
                "path": latest_path,
                "created_at": time.strftime("%d/%m/%Y %H:%M:%S", time.localtime(os.path.getmtime(latest_path))),
            }
    except Exception:
        latest_backup = None

    try:
        usage = shutil.disk_usage(data_dir)
        disk_free_gb = round(usage.free / (1024 ** 3), 1)
    except Exception:
        disk_free_gb = None

    thumb_cache_stats = {
        "path": thumb_cache_dir,
        "files": 0,
        "size_bytes": 0,
        "size_mb": 0,
        "usage_percent_bytes": 0,
    }
    try:
        if thumb_cache_dir and os.path.isdir(thumb_cache_dir):
            total_bytes = 0
            total_files = 0
            for root, _, files in os.walk(thumb_cache_dir):
                for name in files:
                    full = os.path.join(root, name)
                    try:
                        stat = os.stat(full)
                    except Exception:
                        continue
                    total_bytes += stat.st_size
                    total_files += 1
            thumb_cache_stats["files"] = total_files
            thumb_cache_stats["size_bytes"] = total_bytes
            thumb_cache_stats["size_mb"] = round(total_bytes / (1024 ** 2), 1)
            try:
                max_bytes = int((_get("app_settings", {}) or {}).get("thumb_cache_max_bytes", 0) or 0)
            except Exception:
                max_bytes = 0
            if max_bytes > 0:
                thumb_cache_stats["usage_percent_bytes"] = round(min(100.0, (total_bytes / max_bytes) * 100), 1)
    except Exception:
        pass

    history = load_export_history()
    gpu = gpu_diagnostics()
    scanner_log = os.path.join(data_dir, "error_scanner.log")
    last_scanner_error = ""
    try:
        if os.path.isfile(scanner_log):
            last_scanner_error = time.strftime("%d/%m/%Y %H:%M:%S", time.localtime(os.path.getmtime(scanner_log)))
    except Exception:
        last_scanner_error = ""

    return {
        "app_name": app_name,
        "version": app_version,
        "data_dir": data_dir,
        "current_catalog": current_catalog,
        "catalog_count": len(catalogs),
        "disk_free_gb": disk_free_gb,
        "latest_backup": latest_backup,
        "last_export": history[0] if history else None,
        "gpu": gpu,
        "scanner": {
            "is_scanning": scan_state.get("is_scanning", False),
            "device": scan_state.get("device") or _get("face_engine_device", "") or "",
            "gpu_error": scan_state.get("gpu_error") or _get("face_engine_gpu_error", "") or "",
            "last_error_at": last_scanner_error,
        },
        "export": {
            "is_exporting": export_state.get("is_exporting", False),
            "status_text": export_state.get("status_text", ""),
        },
        "memory": get_memory_info(),
        "embedding_cache": {
            "entries": len(_embedding_disk_cache),
            "enabled": True,
        },
        "thumb_cache": thumb_cache_stats,
        "ai_index": automation.get_index_status() if automation and hasattr(automation, "get_index_status") else None,
        "settings": _get("app_settings", {}),
    }


def get_settings():
    return _get("app_settings", {})


class SettingsUpdate(BaseModel):
    theme: str = None
    auto_backup_enabled: bool = None
    auto_backup_interval_hours: int = None
    scan_parallel_photos: int = None
    export_incremental_default: bool = None
    selection_accent_color: str = None
    photoshop_path: str = None
    ai_embedding_models_dir: str = None
    ai_embedding_image_model_path: str = None
    ai_embedding_text_model_path: str = None
    ai_embedding_tokenizer_path: str = None
    ai_embedding_hf_repo_id: str = None
    ai_embedding_dimension: int = None
    ai_embedding_image_size: int = None
    ai_embedding_max_text_tokens: int = None
    thumb_cache_max_bytes: int = None
    thumb_cache_max_files: int = None


def update_settings(req: SettingsUpdate):
    save_app_settings = _get("save_app_settings")
    app_settings = _get("app_settings", {})
    updates = {k: v for k, v in req.dict().items() if v is not None}
    if "theme" in updates and updates["theme"] not in ("dark", "light"):
        raise HTTPException(400, "Tema deve ser 'dark' ou 'light'")
    if "auto_backup_interval_hours" in updates:
        hours = updates["auto_backup_interval_hours"]
        if hours < 1 or hours > 720:
            raise HTTPException(400, "Intervalo deve ser entre 1 e 720 horas")
    if "selection_accent_color" in updates and updates["selection_accent_color"] is not None:
        color = str(updates["selection_accent_color"]).strip()
        if not color.startswith("#"):
            color = f"#{color}"
        if len(color) == 4 and all(ch in "0123456789abcdefABCDEF" for ch in color[1:]):
            color = "#" + "".join(ch * 2 for ch in color[1:])
        if not (len(color) == 7 and color.startswith("#") and all(ch in "0123456789abcdefABCDEF" for ch in color[1:])):
            raise HTTPException(400, "Cor de destaque deve estar no formato hex (#RRGGBB)")
        updates["selection_accent_color"] = color.lower()
    if "thumb_cache_max_bytes" in updates and updates["thumb_cache_max_bytes"] is not None:
        if updates["thumb_cache_max_bytes"] < 0:
            raise HTTPException(400, "Limite de cache deve ser maior ou igual a 0")
    if "thumb_cache_max_files" in updates and updates["thumb_cache_max_files"] is not None:
        if updates["thumb_cache_max_files"] < 0:
            raise HTTPException(400, "Quantidade de arquivos deve ser maior ou igual a 0")
    app_settings = save_app_settings({**app_settings, **updates})
    _get("set_app_settings")(app_settings)
    return {"status": "ok", "settings": app_settings}


def get_stats(catalog: str = ""):
    get_db = _get("get_db")
    cat = catalog or _get("get_current_catalog")()
    if not cat:
        raise HTTPException(400, "Nenhum catalogo selecionado")
    try:
        with get_db(cat) as conn:
            cur = conn.cursor()

            cur.execute("SELECT COUNT(*) as cnt FROM ocorrencias")
            total_occurrences = cur.fetchone()["cnt"]

            cur.execute("SELECT COUNT(DISTINCT foto_path) as cnt FROM ocorrencias")
            photos_with_faces = cur.fetchone()["cnt"]

            cur.execute("SELECT COUNT(*) as cnt FROM alunos WHERE aluno_id != 'system_catalog'")
            total_people = cur.fetchone()["cnt"]

            cur.execute("SELECT COUNT(DISTINCT aluno_id) as cnt FROM ocorrencias WHERE aluno_id NOT LIKE 'Pessoa %' AND aluno_id != 'system_catalog'")
            named_people = cur.fetchone()["cnt"]

            cur.execute("SELECT COUNT(*) as cnt FROM ocorrencias WHERE aluno_id LIKE 'Pessoa %'")
            unnamed_people = cur.fetchone()["cnt"]

            cur.execute("SELECT COUNT(*) as cnt FROM discarded_photos")
            discarded_count = cur.fetchone()["cnt"]

            cur.execute("""
                SELECT aluno_id, COUNT(*) as cnt
                FROM ocorrencias
                GROUP BY aluno_id
                ORDER BY cnt DESC
            """)
            photos_per_person = cur.fetchall()

            avg_photos = 0
            if photos_per_person and total_people > 0:
                avg_photos = sum(r["cnt"] for r in photos_per_person) / total_people

            return {
                "total_occurrences": total_occurrences,
                "photos_with_faces": photos_with_faces,
                "total_people": total_people,
                "named_people": named_people,
                "unnamed_people": unnamed_people,
                "discarded_photos": discarded_count,
                "avg_photos_per_person": round(avg_photos, 1),
                "top_people": [{"id": r["aluno_id"], "count": r["cnt"]} for r in photos_per_person[:10]],
            }
    except Exception as e:
        raise HTTPException(500, str(e))
