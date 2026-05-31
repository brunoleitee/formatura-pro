"""
Re-exporta do state.py para compatibilidade com imports existentes.
Módulos novos devem importar de state.py diretamente.
DeprecationWarning: Este módulo será removido no futuro. Importe de state.py diretamente.
"""
import warnings
warnings.warn(
    "backend_state.py está depreciado. Importe de state.py diretamente.",
    DeprecationWarning, stacklevel=2,
)
from state import (  # noqa: F401
    AppState,
    _global_state_lock,
    scan_state,
    export_state,
    undo_export_state,
    manual_search_state,
    graduation_analysis_state,
    quality_audit_state,
    app_face,
    face_engine_device,
    face_engine_gpu_error,
    face_det_size,
    faiss_index,
    ref_ids,
    ref_classes,
    ref_person_keys,
    ref_reference_folders,
    ref_names,
    min_face_area,
    ref_match_threshold,
    cluster_centers,
    cluster_names,
    cluster_counts,
    _EMBEDDING_DISK_CACHE,
    _EMBEDDING_DISK_CACHE_LOADED,
    scanner_cancel,
    app_settings,
)
