"""
Rotas de gerenciamento de catálogos.
Extraídas de backend.py para reduzir o monólito.
"""

import json
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import catalog_manager as cm
import catalog_data_manager as cdm
from utils import _invalidate_stats_caches
from db import get_db

router = APIRouter()
logger = logging.getLogger(__name__)


class CatalogSettingsReq(BaseModel):
    catalog: str
    scan_paths: list = []
    root_path: str = ""
    selected_folders: dict = {}


SetCatalogReq = cm.SetCatalogReq
RenameCatalogReq = cm.RenameCatalogReq
ImportCatalogReq = cdm.ImportCatalogReq
MarkAbsentReq = cdm.MarkAbsentReq


@router.get("/api/catalogs")
def list_catalogs():
    return cm.list_catalogs()


@router.post("/api/catalogs/set")
def set_catalog(req: SetCatalogReq):
    return cm.set_catalog(req)


@router.post("/api/catalogs/rename")
def rename_catalog(req: RenameCatalogReq):
    _invalidate_stats_caches()
    return cm.rename_catalog(req)


@router.post("/api/catalogs/delete")
def delete_catalog(req: SetCatalogReq):
    return cm.delete_catalog(req)


@router.get("/api/catalogs/settings")
def get_catalog_settings(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT scan_paths, root_path, selected_folders FROM catalog_settings WHERE catalog_name = ?", (catalog,))
            row = cur.fetchone()
            selected_folders = {}
            if row and row[2]:
                try:
                    selected_folders = json.loads(row[2])
                except Exception:
                    selected_folders = {}
            if row:
                return {
                    "catalog": catalog,
                    "scan_paths": row[0].split("|") if row[0] else [],
                    "root_path": row[1] or "",
                    "selected_folders": selected_folders,
                    "quality": {}, "scanner": {}, "export": {}, "ui": {},
                }
            return {"catalog": catalog, "scan_paths": [], "root_path": "", "selected_folders": {},
                    "quality": {}, "scanner": {}, "export": {}, "ui": {}}
    except Exception as e:
        return {"catalog": catalog, "scan_paths": [], "root_path": "", "selected_folders": {},
                "quality": {}, "scanner": {}, "export": {}, "ui": {}}


@router.post("/api/catalogs/settings")
def save_catalog_settings(req: CatalogSettingsReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            scan_paths_str = "|".join(req.scan_paths) if req.scan_paths else ""
            selected_folders_str = json.dumps(req.selected_folders) if req.selected_folders else ""
            cur.execute("""
                INSERT OR REPLACE INTO catalog_settings (catalog_name, scan_paths, root_path, selected_folders)
                VALUES (?, ?, ?, ?)
            """, (req.catalog, scan_paths_str, req.root_path, selected_folders_str))
            conn.commit()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/api/catalogs/all-subfolders")
def get_all_subfolders(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT path FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            folders = [r["path"] for r in cur.fetchall()]

        all_subdirs = []
        for folder_path in folders:
            if not os.path.isdir(folder_path):
                continue
            folder_path = os.path.normpath(folder_path).replace("\\", "/")
            for root, dirs, _ in os.walk(folder_path):
                for d in dirs:
                    full = os.path.normpath(os.path.join(root, d)).replace("\\", "/")
                    if full.startswith(folder_path):
                        relative = full[len(folder_path):].strip("/")
                        if relative:
                            all_subdirs.append(f"{os.path.basename(folder_path)}/{relative}")
        return {"ok": True, "subfolders": sorted(list(set(all_subdirs)))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class AddCatalogFolderReq(BaseModel):
    catalog: str
    path: str
    include_subfolders: bool = True
    scan_immediately: bool = False
    folder_type: str = "event"


class RemoveFolderReq(BaseModel):
    catalog: str
    path: str


class ToggleFolderReq(BaseModel):
    catalog: str
    path: str


class ScanFolderReq(BaseModel):
    catalog: str
    path: str


class SyncCatalogReq(BaseModel):
    catalog: str


@router.get("/api/catalogs/folders")
def list_catalog_folders(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT id, path, include_subfolders, photo_count, last_scan_at, status, folder_type FROM catalog_folders WHERE catalog_name = ? ORDER BY id ASC", (catalog,))
            rows = cur.fetchall()
        return {"folders": [dict(r) for r in rows]}
    except Exception as e:
        return {"folders": [], "error": str(e)}


@router.get("/api/catalogs/event-ref-paths")
def get_catalog_event_ref_paths(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT path, folder_type FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            rows = cur.fetchall()
        return {r["folder_type"]: r["path"] for r in rows}
    except Exception:
        return {}


@router.post("/api/catalogs/folders")
def add_catalog_folder(req: AddCatalogFolderReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT OR IGNORE INTO catalog_folders (catalog_name, path, include_subfolders, status, folder_type) VALUES (?, ?, ?, ?, ?)",
                (req.catalog, req.path, int(req.include_subfolders), "active", req.folder_type),
            )
            conn.commit()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/catalogs/folders/remove")
def remove_catalog_folder(req: RemoveFolderReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM catalog_folders WHERE catalog_name = ? AND path = ?", (req.catalog, req.path))
            conn.commit()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/catalogs/folders/toggle")
def toggle_catalog_folder(req: ToggleFolderReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            cur.execute("UPDATE catalog_folders SET status = CASE WHEN status = 'active' THEN 'inactive' ELSE 'active' END WHERE catalog_name = ? AND path = ?", (req.catalog, req.path))
            conn.commit()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/catalogs/stats")
def catalog_folder_stats(catalog: str = ""):
    try:
        return cm.catalog_folder_stats(catalog)
    except Exception as e:
        logger.error(f"[FolderStats] ERROR catalog={catalog} error={e}")
        return {"status": "error", "error": str(e)}


@router.post("/api/catalogs/scan-folder")
def scan_catalog_folder(req: ScanFolderReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            cur.execute("UPDATE catalog_folders SET photo_count = photo_count + 1 WHERE catalog_name = ? AND path = ?", (req.catalog, req.path))
            conn.commit()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/catalogs/sync")
def sync_catalog(req: SyncCatalogReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT path FROM catalog_folders WHERE catalog_name = ? AND status = 'active'", (req.catalog,))
            folders = [r["path"] for r in cur.fetchall()]
        return {"success": True, "scanned_folders": folders}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/catalog/export")
def export_catalog_json(catalog: str = ""):
    return cdm.export_catalog_json(catalog)


@router.post("/api/catalog/import")
def import_catalog_json(req: ImportCatalogReq):
    return cdm.import_catalog_json(req)


@router.post("/api/people/mark-absent")
def mark_people_absent(req: MarkAbsentReq):
    return cdm.mark_people_absent(req)


@router.get("/api/people/absent")
def get_absent_people():
    return cdm.get_absent_people()
