import os
import time
import urllib.parse
import re
import logging
from typing import Optional, List, Tuple
import cv2
import numpy as np

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

import scan_manager as scm
import media_manager as mm
import scanner_engine as se

router = APIRouter()

IMAGE_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff",
    ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf", ".srw", ".x3f",
)


@router.get("/api/scanner/folder-tree")
def get_scanner_folder_tree(path: str = "", depth: int = 2):
    """
    Retorna a árvore de pastas otimizada para o Gerenciador de Pastas do Scanner.
    Suporta lazy load através do parâmetro 'depth'.
    """
    try:
        return mm.explorer_tree(path, depth)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/scan/precheck")
def scan_precheck(req: scm.ScanRequest):
    return scm.scan_precheck(req)


@router.post("/api/scan/clear-checkpoints")
def clear_checkpoints(req: dict):
    return scm.clear_checkpoints(req)


@router.post("/api/scan/start")
def start_scan(req: scm.ScanRequest):
    from utils import _invalidate_stats_caches
    _invalidate_stats_caches()
    return scm.start_scan(req)


@router.get("/api/scan/status")
def get_scan_status():
    try:
        raw = scm.get_scan_status() or {}
        from scanner_engine import _scan_last_progress_at, _scan_last_progress_file, _scan_last_processed, _scan_stalled
        now = time.time()
        last_secs = (now - _scan_last_progress_at) if _scan_last_progress_at > 0 else None
        if _scan_stalled:
            raw["status"] = "stalled"
        elif raw.get("is_scanning"):
            raw["status"] = "running"
        elif raw.get("stopped"):
            raw["status"] = "stopped"
        elif raw.get("scan_summary"):
            raw["status"] = "done"
        else:
            raw["status"] = "idle"
        raw["last_progress_seconds"] = round(last_secs, 1) if last_secs is not None else None
        raw["current_file"] = _scan_last_progress_file or (raw.get("current_photo") or {}).get("name")
        raw["processed"] = raw.get("total_processadas", _scan_last_processed)
        raw["total"] = raw.get("total_validos", 0)
        return raw
    except Exception:
        _scan_logger = logging.getLogger(__name__)
        _scan_logger.exception("[scanner-status] failed")
        return {
            "running": False, "progress": 0, "processed": 0, "total": 0,
            "status": "recovering", "error": "temporary_failure",
        }


@router.post("/api/scan/clear_summary")
def clear_scan_summary():
    from utils import _invalidate_stats_caches
    _invalidate_stats_caches()
    return scm.clear_scan_summary()


@router.post("/api/scan/stop")
def stop_scan():
    return scm.stop_scan()


@router.post("/api/scanner/stop")
def scanner_stop():
    scm.stop_scan()
    return {"success": True}


@router.get("/api/scanner/live-status")
def scanner_live_status():
    s = scm.get_scan_status()
    now = time.time()
    started_at = s.get("started_at")
    is_scanning = bool(s.get("is_scanning", False))
    processed = int(s.get("total_processadas", 0))
    total = int(s.get("total_files", 0))
    elapsed = (now - started_at) if started_at and is_scanning else None
    eta = None
    avg_sec = None
    if elapsed is not None and elapsed > 0 and processed >= 5:
        speed = processed / elapsed
        remaining = total - processed
        if remaining > 0 and speed > 0:
            eta = round(remaining / speed, 1)
            avg_sec = round(elapsed / processed, 2)
    return {
        "running": is_scanning,
        "stopped": bool(s.get("stopped", False)),
        "processedPhotos": processed,
        "totalPhotos": total,
        "started_at": started_at,
        "elapsed_seconds": round(elapsed, 1) if elapsed is not None else None,
        "eta_seconds": eta,
        "avgSecondsPerPhoto": avg_sec,
        "is_scanning": is_scanning,
        "status_text": s.get("status_text", ""),
    }


@router.post("/api/scanner/cleanup")
def scanner_cleanup():
    return scm.force_cleanup()


@router.post("/api/scanner/unload-models")
def scanner_unload_models():
    return scm.unload_models()


@router.post("/api/scan/quality_fill")
def start_quality_audit(req: dict):
    return scm.start_quality_audit(req)


@router.post("/api/scan/start_quality_audit")
def start_quality_audit_legacy(req: dict):
    return scm.start_quality_audit(req)


@router.get("/api/scan/quality_audit_status")
def get_quality_audit_status():
    try:
        return scm.get_quality_audit_status()
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


@router.get("/api/scanner/preview-ocr")
def scanner_preview_ocr(path: str = ""):
    """
    Preview de informações básicas da foto. OCR não é executado aqui —
    use a aba de Revisão ("Analisar") ou Criar Referências.
    """
    from utils import log_info
    decoded = urllib.parse.unquote(path).strip()
    if not decoded or not os.path.isfile(decoded):
        return {"ok": False, "error": "Arquivo não encontrado"}

    ext = os.path.splitext(decoded)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        return {"ok": False, "error": "Formato de imagem não suportado"}

    try:
        img = cv2.imread(decoded)
        if img is None:
            return {"ok": False, "error": "Falha ao ler imagem"}

        h, w = img.shape[:2]

        # ── Detectar rosto principal com InsightFace ──
        from services.face_engine import FACE_INFERENCE_LOCK

        se.ensure_face_engine()
        app_face = se.get_app_face()
        primary_face = None

        if app_face:
            with FACE_INFERENCE_LOCK:
                with _suppress_stdout():
                    raw_faces = app_face.get(img) or []
            if raw_faces:
                raw_faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
                best = raw_faces[0]
                fx1, fy1, fx2, fy2 = map(int, best.bbox[:4])
                primary_face = (fx1, fy1, fx2, fy2)

        return {
            "ok": True,
            "path": decoded,
            "width": w,
            "height": h,
            "face_detected": primary_face is not None,
            "face_bbox": primary_face,
            "raw_text": "",
            "fields": {
                "nome": None, "curso": None, "instituicao": None,
                "data": None, "tipo": None, "numero": None,
            },
            "confidence": 0.0,
        }
    except Exception as e:
        log_info(f"[preview-ocr] error={e}")
        return {"ok": False, "error": str(e)}


@router.get("/api/scanner/preview-faces")
def scanner_preview_faces(path: str = ""):
    """
    Preview faces de uma única foto. Não salva no banco, não usa FAISS, não cria cluster.
    """
    from utils import log_info, _suppress_stdout
    decoded = urllib.parse.unquote(path).strip()
    if not decoded or not os.path.isfile(decoded):
        return {"ok": False, "error": "Arquivo não encontrado", "faces": []}

    ext = os.path.splitext(decoded)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        return {"ok": False, "error": "Formato de imagem não suportado", "faces": []}

    try:
        log_info(f"[preview-faces] path={decoded}")

        from services.face_engine import FACE_INFERENCE_LOCK
        from scanner_engine import _scan_last_progress_at
        now = time.time()
        scanner_active = _scan_last_progress_at > 0 and (now - _scan_last_progress_at) < 120.0

        if scanner_active:
            acquired = FACE_INFERENCE_LOCK.acquire(timeout=0.1)
            if not acquired:
                log_info("[face-lock] busy by=preview-faces skipped (scanner ativo)")
                return {"ok": False, "busy": True, "reason": "scanner_running", "faces": []}
        else:
            FACE_INFERENCE_LOCK.acquire()

        try:
            log_info(f"[face-lock] acquired by=preview-faces file={os.path.basename(decoded)}")
            img = cv2.imread(decoded)
            if img is None:
                return {"ok": False, "error": "Falha ao ler imagem", "faces": []}

            h, w = img.shape[:2]
            log_info(f"[preview-faces] img_shape={w}x{h}")

            se.ensure_face_engine()
            app_face = se.get_app_face()
            if app_face is None:
                return {"ok": False, "error": "Motor de deteccao nao disponivel", "faces": []}

            with _suppress_stdout():
                raw_faces = app_face.get(img) or []
        finally:
            FACE_INFERENCE_LOCK.release()

        log_info(f"[preview-faces] detected={len(raw_faces)}")

        result_faces = []
        for face in raw_faces:
            bbox = face.bbox.astype(float).tolist() if hasattr(face, 'bbox') else [0, 0, 0, 0]
            x1, y1, x2, y2 = map(int, bbox[:4])
            confidence = float(getattr(face, 'det_score', 0))
            area = max(0, (x2 - x1) * (y2 - y1))
            crop_url = (
                f"/api/thumb?path={urllib.parse.quote(decoded)}"
                f"&x1={x1}&y1={y1}&x2={x2}&y2={y2}&size=120&q=80"
            )
            result_faces.append({
                "bbox": [x1, y1, x2, y2],
                "confidence": round(confidence, 4),
                "area": area,
                "is_primary": False,
                "crop_url": crop_url,
            })

        result_faces.sort(key=lambda f: f["area"], reverse=True)
        if result_faces:
            result_faces[0]["is_primary"] = True

        return {
            "ok": True,
            "path": decoded,
            "faces": result_faces,
        }
    except Exception as e:
        logging.getLogger(__name__).exception("[preview-faces] failed path=%s", decoded)
        return {"ok": False, "error": str(e), "faces": []}
