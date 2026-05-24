from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse, FileResponse
import logging
import os
import threading
import time
import media_manager as mm

router = APIRouter()

THUMB_SEMAPHORE_SMALL = threading.Semaphore(16)
THUMB_SEMAPHORE_LARGE = threading.Semaphore(4)
THUMB_SLOT_LOCAL = threading.local()
THUMB_QUEUE = []
THUMB_QUEUE_LOCK = threading.Lock()
THUMB_MAX_QUEUE = 100

def get_thumb_slot(size=300, timeout=1.0):
    semaphore = THUMB_SEMAPHORE_SMALL if int(size or 0) <= 400 else THUMB_SEMAPHORE_LARGE
    acquired = semaphore.acquire(timeout=timeout)
    if not acquired:
        with THUMB_QUEUE_LOCK:
            THUMB_QUEUE.append(time.time())
    THUMB_SLOT_LOCAL.current = semaphore
    return acquired

def release_thumb_slot():
    try:
        semaphore = getattr(THUMB_SLOT_LOCAL, "current", None)
        if semaphore is not None:
            semaphore.release()
            THUMB_SLOT_LOCAL.current = None
            with THUMB_QUEUE_LOCK:
                if THUMB_QUEUE:
                    THUMB_QUEUE.pop(0)
    except Exception as e:
        logging.getLogger(__name__).error(f"[thumb_slot] Erro ao liberar slot: {e}")

@router.get("/api/image_thumb")
def get_image_thumb(path: str, size: int = 300, q: int = 80):
    try:
        get_thumb_slot(size=size)
        return mm.get_image_thumb(path, size, q)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).warning("[thumb] get_image_thumb error path=%s: %s", path, e)
    finally:
        release_thumb_slot()
    return StreamingResponse(mm._create_error_placeholder(size), media_type="image/jpeg")

@router.get("/api/thumb")
def get_thumb(path: str, x1: int, y1: int, x2: int, y2: int, size: int = 120, expand: float = 0.35, q: int = 80):
    try:
        get_thumb_slot(size=size)
        return mm.get_thumb(path, x1, y1, x2, y2, size, expand, q)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).warning("[thumb] get_thumb error path=%s: %s", path, e)
    finally:
        release_thumb_slot()
    return StreamingResponse(mm._create_error_placeholder(size), media_type="image/jpeg")

@router.get("/api/image_full")
def get_image_full(path: str):
    return mm.get_image(path)

@router.get("/api/image")
def get_image(path: str = Query(...)):
    return mm.get_image(path)

@router.get("/api/image/resized")
def get_image_resized(path: str = Query(...), max_size: int = 1200):
    return mm.get_image_resized(path, max_size)

@router.get("/api/image_preview")
def get_image_preview(
    path: str = Query(...),
    size: int = Query(1920),
    max_size: int | None = Query(None),
):
    safe_size = max_size or size or 1920
    safe_size = max(1, min(int(safe_size), 2560))
    return mm.get_image_preview(path, safe_size)
