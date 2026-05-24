"""
Rotas de exportação.
Extraídas de backend.py.
"""

import logging
from fastapi import APIRouter
import export_manager as ex

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/api/export/check-conflicts")
def check_export_conflicts(req: ex.ExportReq):
    return ex.check_export_conflicts(req)


@router.post("/api/export/quality")
def export_quality(req: ex.ExportReq):
    return ex.export_quality(req)


@router.get("/api/export/history")
def get_export_history():
    return {"history": ex.load_export_history()}


@router.post("/api/export/undo")
def undo_last_export():
    return ex.undo_last_export()


@router.post("/api/export/start")
def start_export(req: ex.ExportReq):
    return ex.start_export(req)


@router.get("/api/export/status")
def get_export_status():
    try:
        status = ex.get_export_status()
        if not isinstance(status, dict):
            raise RuntimeError("export status indisponivel")
        is_exporting = bool(status.get("is_exporting") or status.get("running"))
        text = str(status.get("status_text") or status.get("message") or (
            "Exportacao em andamento" if is_exporting else "Nenhuma exportacao em andamento"))
        normalized = dict(status)
        normalized["is_exporting"] = is_exporting
        normalized["running"] = is_exporting
        normalized["status"] = "running" if is_exporting else "idle"
        normalized["progress"] = float(status.get("progress") or 0)
        normalized["status_text"] = text
        normalized["message"] = text
        normalized["total_files"] = int(status.get("total_files") or 0)
        normalized["processed_files"] = int(status.get("processed_files") or 0)
        normalized["eta_seconds"] = int(status.get("eta_seconds") or 0)
        return normalized
    except Exception as e:
        logger.info(f"Falha ao consultar status da exportacao: {e}")
        return {
            "is_exporting": False, "running": False, "status": "idle",
            "progress": 0, "status_text": "Nenhuma exportacao em andamento",
            "message": "Nenhuma exportacao em andamento",
            "total_files": 0, "processed_files": 0, "eta_seconds": 0,
            "export_summary": None,
        }


@router.post("/api/export/clear_summary")
def clear_export_summary():
    return ex.clear_export_summary()
