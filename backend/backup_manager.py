import json
import os
import shutil
from datetime import datetime, timedelta

DEFAULT_APP_SETTINGS = {
    "auto_backup_enabled": True,
    "auto_backup_interval_hours": 24,
    "last_auto_backup": None,
    "scan_parallel_photos": 4,
    "image_extensions": [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"],
    "export_incremental_default": False,
    "selection_accent_color": "#d4a44c",
    "photoshop_path": None,
    "ai_embedding_models_dir": None,
    "ai_embedding_image_model_path": None,
    "ai_embedding_text_model_path": None,
    "ai_embedding_tokenizer_path": None,
    "ai_embedding_hf_repo_id": "inference4j/clip-vit-base-patch32",
    "ai_embedding_dimension": 512,
    "ai_embedding_image_size": 224,
    "ai_embedding_max_text_tokens": 77,
    "cloud_catalogs_root_dir": None,
    "cloud_restore_last_catalog": True,
    "cloud_last_catalog_id": None,
}

APP_SETTINGS_PATH = None
CATALOG_DIR = None
BACKUP_DIR = None
shutdown_event = None
_log_debug = lambda msg: None
_log_info = lambda msg: None
_perform_auto_backup_hook = None


def configure(*, app_settings_path=None, catalog_dir=None, backup_dir=None, shutdown_event_obj=None, log_debug=None, log_info=None):
    global APP_SETTINGS_PATH, CATALOG_DIR, BACKUP_DIR, shutdown_event, _log_debug, _log_info
    if app_settings_path is not None:
        APP_SETTINGS_PATH = app_settings_path
    if catalog_dir is not None:
        CATALOG_DIR = catalog_dir
    if backup_dir is not None:
        BACKUP_DIR = backup_dir
    if shutdown_event_obj is not None:
        shutdown_event = shutdown_event_obj
    if log_debug is not None:
        _log_debug = log_debug
    if log_info is not None:
        _log_info = log_info


def load_app_settings():
    try:
        if APP_SETTINGS_PATH and os.path.exists(APP_SETTINGS_PATH):
            with open(APP_SETTINGS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {**DEFAULT_APP_SETTINGS, **(data if isinstance(data, dict) else {})}
    except Exception:
        pass
    return dict(DEFAULT_APP_SETTINGS)


def save_app_settings(settings):
    merged = {**DEFAULT_APP_SETTINGS, **(settings if isinstance(settings, dict) else {})}
    if APP_SETTINGS_PATH:
        with open(APP_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
    return merged


def clean_old_auto_backups(keep_count=5):
    try:
        if not BACKUP_DIR or not os.path.isdir(BACKUP_DIR):
            return
        backups = [d for d in os.listdir(BACKUP_DIR) if d.startswith("auto_backup_")]
        backups.sort(reverse=True)
        for old in backups[keep_count:]:
            old_path = os.path.join(BACKUP_DIR, old)
            shutil.rmtree(old_path, ignore_errors=True)
            _log_debug(f"Backup antigo removido: {old}")
    except Exception as e:
        _log_debug(f"Erro ao limpar backups antigos: {e}")


def perform_auto_backup():
    try:
        _log_info("Iniciando backup automatico...")
        if not CATALOG_DIR or not os.path.exists(CATALOG_DIR):
            return
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = f"auto_backup_{timestamp}"
        backup_path = os.path.join(BACKUP_DIR, backup_name)
        os.makedirs(backup_path, exist_ok=True)
        count = 0
        for db_file in os.listdir(CATALOG_DIR):
            if db_file.endswith(".db"):
                src = os.path.join(CATALOG_DIR, db_file)
                dst = os.path.join(backup_path, db_file)
                shutil.copy2(src, dst)
                count += 1
        settings = load_app_settings()
        settings["last_auto_backup"] = datetime.now().isoformat()
        save_app_settings(settings)
        clean_old_auto_backups()
        _log_info(f"Backup automatico concluido: {count} catalogo(s)")
    except Exception as e:
        _log_debug(f"Falha no backup automatico: {e}")


def scheduled_backup_thread():
    while not (shutdown_event and shutdown_event.is_set()):
        try:
            settings = load_app_settings()
            if settings.get("auto_backup_enabled", False):
                last = settings.get("last_auto_backup")
                interval = settings.get("auto_backup_interval_hours", 24)
                if last:
                    last_time = datetime.fromisoformat(last) if isinstance(last, str) else datetime(*last)
                    if datetime.now() - last_time >= timedelta(hours=interval):
                        perform_auto_backup()
                else:
                    perform_auto_backup()
        except Exception as e:
            _log_debug(f"Erro no backup agendado: {e}")
        if shutdown_event:
            shutdown_event.wait(3600)
        else:
            break
