"""
Estado global compartilhado entre módulos do backend.
Substitui backend_state.py como fonte única da verdade.
"""

import threading


class AppState:
    current_catalog = ""


_global_state_lock = threading.Lock()

scan_state = {
    "is_scanning": False,
    "progress": 0.0,
    "status_text": "Pronto",
    "total_processadas": 0,
    "total_matches": 0,
    "total_clusters": 0,
    "total_files": 0,
    "last_folder_scanned": "",
    "eta_seconds": 0,
    "device": "",
    "provider": "",
    "gpu_error": "",
    "skipped_background_faces": 0,
    "total_found_files": 0,
    "total_valid_files": 0,
    "total_existing_files": 0,
    "total_inserted_files": 0,
    "total_ignored_files": 0,
    "duplicate_count": 0,
    "duplicate_percent": 0.0,
    "ignored_reasons": {},
    "scan_summary": None,
    "current_photo": None,
    "current_photo_index": 0,
    "recent_faces": [],
    "started_at": None,
    "processing_history": [],
}

export_state = {
    "is_exporting": False,
    "progress": 0.0,
    "status_text": "Pronto",
    "total_files": 0,
    "processed_files": 0,
    "eta_seconds": 0,
    "export_summary": None,
    "export_id": "",
    "export_dir": "",
    "pdf_path": "",
    "undo_available": False,
}

undo_export_state = {
    "last_export": None,
    "files_copied": [],
    "folders_created": [],
    "original_paths": {},
}

manual_search_state = {
    "is_running": False,
    "progress": 0.0,
    "processed": 0,
    "total": 0,
    "status_text": "Pronto",
    "result": None,
    "error": "",
    "cancel_requested": False,
}

graduation_analysis_state = {
    "is_running": False,
    "running": False,
    "progress": 0.0,
    "processed": 0,
    "total": 0,
    "updated": 0,
    "status_text": "Inativo",
    "catalog": "",
    "result": None,
    "error": None,
    "started_at": None,
    "finished_at": None,
}

quality_audit_state = {
    "status": "idle",
    "running": False,
    "enabled": False,
    "is_auditing": False,
    "progress": 0.0,
    "processed": 0,
    "total": 0,
    "status_text": "Quality audit não iniciado",
    "message": "Quality audit não iniciado",
}

min_face_area = 500
ref_match_threshold = 0.50

# Scanner/engine state (mutable, shared across threads)
app_face = None
face_engine_device = ""
face_engine_gpu_error = ""
face_det_size = (640, 640)
faiss_index = None
ref_ids = []
ref_classes = {}
ref_person_keys = {}
ref_reference_folders = {}
ref_names = {}

min_face_area = 500
ref_match_threshold = 0.50

cluster_centers = []
cluster_names = []
cluster_counts = {}

_EMBEDDING_DISK_CACHE = {}
_EMBEDDING_DISK_CACHE_LOADED = False

scanner_cancel = {
    "running": False,
    "cancel_requested": False,
    "stopped": False,
    "KILL_NOW": False,
    "current_task": None,
    "executor": None,
    "queue": None,
    "worker_thread": None,
}

# Settings (populated at startup by backend.py)
app_settings = {}

# Directory constants (populated at startup by backend.py)
BASE_DIR = ""
RUNTIME_DIR = ""
DATA_DIR = ""
CATALOG_DIR = ""
THUMB_CACHE_DIR = ""
BACKUP_DIR = ""

LAST_BACKUPS = {}
