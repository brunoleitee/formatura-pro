class AppState:
    current_catalog = ""


scan_state = {
    "is_scanning": False,
    "stopped": False,
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
    "scan_summary": None,
    "current_photo": None,
    "current_photo_index": 0,
    "recent_faces": [],
}

export_state = {
    "is_exporting": False,
    "progress": 0.0,
    "status_text": "Pronto",
    "total_files": 0,
    "processed_files": 0,
    "eta_seconds": 0,
    "export_summary": None,
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

app_face = None
face_engine_device = ""
face_engine_gpu_error = ""
face_det_size = (640, 640)
faiss_index = None
ref_ids = []
LAST_BACKUPS = {}

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
