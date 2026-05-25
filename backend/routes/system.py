"""
Rotas de sistema, configurações e utilitários.
Extraídas de backend.py.
"""

import os
import json
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

import system_manager as sm
import interaction_manager as im
import maintenance_manager as mm
from db import get_db
from review_manager.models import DiscardPhotoReq, QualitySettingsReq
from pydantic import BaseModel

class OpenPathReq(BaseModel):
    path: str

router = APIRouter()
logger = logging.getLogger(__name__)

SettingsUpdate = sm.SettingsUpdate


# ── GPU ────────────────────────────────────────────────────────

@router.get("/api/gpu/diagnostics")
def gpu_diagnostics():
    return sm.gpu_diagnostics()


# ── Sistema ────────────────────────────────────────────────────

@router.get("/api/system/status")
def system_status():
    return sm.system_status()


@router.get("/api/settings")
def get_settings():
    return sm.get_settings()


@router.post("/api/settings")
def update_settings(req: SettingsUpdate):
    return sm.update_settings(req)


@router.get("/api/stats")
def get_stats(catalog: str = ""):
    return sm.get_stats(catalog)


# ── Utilitários ────────────────────────────────────────────────

@router.post("/api/logs/open")
def open_logs():
    return mm.open_logs()


@router.post("/api/app-folder/open")
def open_app_folder():
    return mm.open_app_folder()

@router.post("/api/system/open-path")
def open_system_path(req: OpenPathReq):
    return im.open_path(req.path)


@router.post("/api/catalog/backup")
def backup_catalog():
    from db import backup_catalog_db
    from state import AppState
    path = backup_catalog_db(AppState.current_catalog, "manual")
    return {"status": "ok" if path else "error", "path": path}


@router.get("/api/event/problems-report")
def event_problems_report(catalog: str = ""):
    import media_manager as mm
    return mm.event_problems_report(catalog)


@router.post("/api/discard-photo")
def discard_photo(req: DiscardPhotoReq):
    import review_manager as rm
    return rm.discard_photo(req)


@router.post("/api/clear-db")
def clear_database():
    import review_manager as rm
    return rm.clear_database()


@router.post("/api/cache/clear")
def clear_cache():
    import review_manager as rm
    return rm.clear_cache()


@router.get("/api/settings/quality")
def get_quality_settings():
    import review_manager as rm
    return rm.get_quality_settings()


@router.post("/api/settings/quality")
def update_quality_settings(req: QualitySettingsReq):
    import review_manager as rm
    return rm.update_quality_settings(req)


# ── Catalog JSON import/export ─────────────────────────────────

@router.get("/api/catalog/export")
def export_catalog_json(catalog: str = ""):
    import catalog_data_manager as cdm
    return cdm.export_catalog_json(catalog)


@router.post("/api/catalog/import")
def import_catalog_json(req):
    import catalog_data_manager as cdm
    return cdm.import_catalog_json(req)


# ── Faces ──────────────────────────────────────────────────────

@router.get("/api/faces/similar")
def search_similar_faces(rowid: int, catalog: str = "", limit: int = 50):
    import review_manager as rm
    return rm.search_similar_faces(rowid, catalog, limit)


@router.get("/api/faces/thumb")
def get_face_thumb(rowid: int, catalog: str = "", size: int = 180):
    import media_manager as mm
    return mm.get_face_thumb(rowid, catalog, size)
