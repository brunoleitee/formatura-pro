import os
import shutil
import time
import logging
import threading

from fastapi import HTTPException
from pydantic import BaseModel

from onnx_provider_utils import get_onnx_providers
from services.ocr_engine import get_tesseract_status

_cfg = {}
_stats_cache: dict[str, tuple[dict, float]] = {}
_stats_cache_lock = threading.Lock()
_stats_cache_ttl = 3.5

logger = logging.getLogger(__name__)


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    value = _get(name, default)
    return value() if callable(value) else value


def _invalidate_stats_cache():
    with _stats_cache_lock:
        _stats_cache.clear()


def _get_cached_stats(key):
    with _stats_cache_lock:
        entry = _stats_cache.get(key)
        if entry and (time.time() - entry[1]) < _stats_cache_ttl:
            return entry[0]
    return None


def _set_cached_stats(key, data):
    with _stats_cache_lock:
        _stats_cache[key] = (data, time.time())


def gpu_diagnostics():
    provider_info = get_onnx_providers()
    available = provider_info.get("available_providers", ["CPUExecutionProvider"])
    selected_providers = provider_info.get("providers", ["CPUExecutionProvider"])
    cuda_failed = bool(provider_info.get("cuda_failed", False))
    ort_version = ""
    provider_error = provider_info.get("provider_error", "")
    try:
        import onnxruntime as ort
        ort_version = getattr(ort, "__version__", "")
    except Exception:
        pass
    scan_state = _get("scan_state", {})
    active_provider = _value("face_engine_provider", "") or scan_state.get("provider") or ""
    active_device = (
        _value("face_engine_label", "")
        or _value("face_engine_device", "")
        or scan_state.get("device")
        or "Não inicializado"
    )
    ai_provider = provider_info.get("provider", "CPUExecutionProvider")
    ai_device = "GPU" if ai_provider in {"CUDAExecutionProvider", "DmlExecutionProvider"} else "CPU"
    preferred_provider = provider_info.get("provider") or (
        "CUDAExecutionProvider"
        if "CUDAExecutionProvider" in available else
        "DmlExecutionProvider"
        if "DmlExecutionProvider" in available else
        "CPUExecutionProvider"
    )
    if ai_provider == "CUDAExecutionProvider" and not cuda_failed:
        status_message = "CUDA ativa"
    elif ai_device == "GPU":
        status_message = "IA rodando em GPU"
    else:
        status_message = "CUDA indisponível. IA rodando em CPU."
    return {
        "available_providers": available,
        "selected_providers": selected_providers,
        "cuda_failed": cuda_failed,
        "cuda_available": "CUDAExecutionProvider" in available and not cuda_failed,
        "directml_available": "DmlExecutionProvider" in available,
        "preferred_provider": preferred_provider,
        "active_provider": active_provider,
        "active_device": active_device,
        "ai_device": ai_device,
        "message": status_message,
        "gpu_error": _value("face_engine_gpu_error", "") or scan_state.get("gpu_error") or ("" if not cuda_failed else status_message) or provider_error,
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
    ocr_status = get_tesseract_status()
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
        "ocr": {
            "available": ocr_status.get("available", False),
            "message": "OCR indisponível: Tesseract não instalado" if not ocr_status.get("available", False) else "OCR disponível",
            "status": "unavailable" if not ocr_status.get("available", False) else "available",
            "tesseract_cmd": ocr_status.get("cmd", ""),
        },
        "scanner": {
            "is_scanning": scan_state.get("is_scanning", False),
            "device": scan_state.get("device") or _value("face_engine_label", "") or _value("face_engine_device", "") or "",
            "provider": scan_state.get("provider") or _value("face_engine_provider", "") or "",
            "gpu_error": scan_state.get("gpu_error") or _value("face_engine_gpu_error", "") or "",
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
    cloud_catalogs_root_dir: str = None
    cloud_restore_last_catalog: bool = None
    cloud_last_catalog_id: str = None
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

    cached = _get_cached_stats(f"stats:{cat}")
    if cached is not None:
        return cached

    try:
        with get_db(cat) as conn:
            cur = conn.cursor()

            # 9 queries consolidadas em 1 para reduzir round-trips com o SQLite
            _t0 = time.perf_counter()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
            _has_alunos_stats = cur.fetchone() is not None
            if _has_alunos_stats:
                cur.execute("""
                    SELECT
                        (SELECT COUNT(*) FROM ocorrencias) AS total_occurrences,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias) AS photos_with_faces,
                        (SELECT COUNT(*) FROM alunos WHERE aluno_id != 'system_catalog') AS total_people,
                        (SELECT COUNT(DISTINCT aluno_id) FROM ocorrencias
                         WHERE aluno_id NOT LIKE 'Pessoa %' AND aluno_id != 'system_catalog') AS named_people,
                        (SELECT COUNT(*) FROM ocorrencias WHERE aluno_id LIKE 'Pessoa %') AS unnamed_people,
                        (SELECT COUNT(*) FROM discarded_photos) AS discarded_count,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias WHERE blur_status = 'blurry') AS blurred_photos,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias
                         WHERE x1 IS NOT NULL
                           AND (aluno_id IS NULL OR aluno_id = '' OR aluno_id LIKE 'Pessoa%'
                                OR lower(aluno_id) IN ('unknown','desconhecido','sem_nome','nao_mapeado','__unknown__'))
                        ) AS no_id_faces,
                        (SELECT COUNT(*) FROM alunos
                         WHERE aluno_id != 'system_catalog'
                           AND aluno_id NOT LIKE 'Pessoa %'
                           AND aluno_id NOT IN (
                               SELECT DISTINCT aluno_id FROM ocorrencias
                               WHERE aluno_id NOT LIKE 'Pessoa %' AND aluno_id != 'Sem Rostos'
                           )
                        ) AS refs_without_match
                """)
            else:
                cur.execute("""
                    SELECT
                        (SELECT COUNT(*) FROM ocorrencias) AS total_occurrences,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias) AS photos_with_faces,
                        0 AS total_people,
                        (SELECT COUNT(DISTINCT aluno_id) FROM ocorrencias
                         WHERE aluno_id NOT LIKE 'Pessoa %' AND aluno_id != 'system_catalog') AS named_people,
                        (SELECT COUNT(*) FROM ocorrencias WHERE aluno_id LIKE 'Pessoa %') AS unnamed_people,
                        (SELECT COUNT(*) FROM discarded_photos) AS discarded_count,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias WHERE blur_status = 'blurry') AS blurred_photos,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias
                         WHERE x1 IS NOT NULL
                           AND (aluno_id IS NULL OR aluno_id = '' OR aluno_id LIKE 'Pessoa%'
                                OR lower(aluno_id) IN ('unknown','desconhecido','sem_nome','nao_mapeado','__unknown__'))
                        ) AS no_id_faces,
                        0 AS refs_without_match
                """)
            counts = cur.fetchone()
            total_occurrences  = counts["total_occurrences"]
            photos_with_faces  = counts["photos_with_faces"]
            total_people       = counts["total_people"]
            named_people       = counts["named_people"]
            unnamed_people     = counts["unnamed_people"]
            discarded_count    = counts["discarded_count"]
            blurred_photos     = counts["blurred_photos"]
            no_id_faces        = counts["no_id_faces"]
            refs_without_match = counts["refs_without_match"]
            logger.info("[sql-perf] endpoint=/api/stats query=counts_consolidated rows=1 ms=%.0f", (time.perf_counter() - _t0) * 1000)

            # photos_per_person com class_name via JOIN (apenas se alunos existir)
            _t0 = time.perf_counter()
            if _has_alunos_stats:
                cur.execute("""
                    SELECT o.aluno_id, COUNT(*) AS cnt,
                           COALESCE(a.class_name, 'Sem turma') AS class_name,
                           COALESCE(NULLIF(TRIM(o.person_key), ''), o.aluno_id) AS person_key
                    FROM ocorrencias o
                    LEFT JOIN alunos a ON a.aluno_id = o.aluno_id
                    GROUP BY COALESCE(NULLIF(TRIM(o.person_key), ''), o.aluno_id)
                    ORDER BY cnt DESC
                """)
            else:
                cur.execute("""
                    SELECT o.aluno_id, COUNT(*) AS cnt,
                           'Sem turma' AS class_name,
                           COALESCE(NULLIF(TRIM(o.person_key), ''), o.aluno_id) AS person_key
                    FROM ocorrencias o
                    GROUP BY COALESCE(NULLIF(TRIM(o.person_key), ''), o.aluno_id)
                    ORDER BY cnt DESC
                """)
            photos_per_person = cur.fetchall()
            logger.info("[sql-perf] endpoint=/api/stats query=photos_per_person rows=%d ms=%.0f", len(photos_per_person), (time.perf_counter() - _t0) * 1000)

            avg_photos = 0
            if photos_per_person and total_people > 0:
                avg_photos = sum(r["cnt"] for r in photos_per_person) / total_people

            _t0 = time.perf_counter()
            reference_root = ""
            if _has_alunos_stats:
                cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = ?", ("system_catalog",))
                res = cur.fetchone()
                reference_root = res[0] if res and res[0] and os.path.isdir(res[0]) else ""
            logger.info("[sql-perf] endpoint=/api/stats query=system_catalog rows=1 ms=%.0f", (time.perf_counter() - _t0) * 1000)
            class_map = {}
            if reference_root:
                ignored_folders = {"#BASE", "BASE", "base", "referencias", "referências", "referencia", "referência"}
                for root, dirs, files in os.walk(reference_root):
                    for filename in files:
                        if not filename.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                            continue
                        try:
                            rel = os.path.relpath(os.path.join(root, filename), reference_root)
                            parts = rel.replace("\\", "/").split("/")
                            valid_parts = [p for p in parts[:-1] if p.strip() and p.strip().casefold() not in {f.casefold() for f in ignored_folders}]
                            class_name = valid_parts[-1] if valid_parts else "Sem turma"
                            student_name = os.path.splitext(filename)[0].strip()
                            class_map[student_name] = class_name
                        except Exception:
                            continue

            classes_data = {}
            for r in photos_per_person:
                aid = r["aluno_id"]
                db_class = r["class_name"]
                if db_class and db_class != "Sem turma":
                    class_name = db_class
                elif aid in class_map:
                    class_name = class_map[aid]
                else:
                    class_name = "Sem turma"
                if class_name not in classes_data:
                    classes_data[class_name] = {"students_count": 0, "photos_count": 0}
                classes_data[class_name]["students_count"] += 1
                classes_data[class_name]["photos_count"] += r["cnt"]

            goal_per_student = 50
            classes_list = []
            for class_name, data in classes_data.items():
                target = data["students_count"] * goal_per_student
                percent = round(data["photos_count"] / target * 100, 1) if target > 0 else 0
                avg = round(data["photos_count"] / data["students_count"], 1) if data["students_count"] > 0 else 0
                classes_list.append({
                    "class_name": class_name,
                    "students_count": data["students_count"],
                    "photos_count": data["photos_count"],
                    "goal_per_student": goal_per_student,
                    "target_photos": target,
                    "average_photos": avg,
                    "completion_percent": percent,
                })

            def sort_key(c):
                if c["class_name"] == "Sem turma":
                    return ("zzz", c["class_name"])
                return (c["class_name"], c["class_name"])
            classes_list.sort(key=sort_key)

            result = {
                "total_photos": photos_with_faces,
                "total_occurrences": total_occurrences,
                "photos_with_faces": photos_with_faces,
                "total_people": total_people,
                "named_people": named_people,
                "unnamed_people": unnamed_people,
                "discarded_photos": discarded_count,
                "blurred_photos": blurred_photos,
                "no_id_faces": no_id_faces,
                "refs_without_match": refs_without_match,
                "avg_photos_per_person": round(avg_photos, 1),
                "top_people": [{"id": r["aluno_id"], "count": r["cnt"]} for r in photos_per_person[:10]],
                "classes": classes_list,
            }

            _set_cached_stats(f"stats:{cat}", result)
            return result
    except Exception as e:
        raise HTTPException(500, str(e))
