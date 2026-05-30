from __future__ import annotations

import threading
from typing import Any, Dict, Optional

import cv2
import numpy as np

from services.paddle_ocr_service import (
    get_paddle_ocr,
    run_paddle_ocr,
    run_paddle_ocr_numeric,
    run_ocr_safe as _run_ocr_safe,
    is_ocr_available as _is_ocr_available,
    get_ocr_status as _get_ocr_status,
)

_OCR_STATE: Dict[str, Any] = {
    "checked": False,
    "available": False,
    "message": "OCR não verificado",
}

_STATE_LOCK = threading.Lock()


def _probe_ocr() -> bool:
    status = _get_ocr_status()
    _OCR_STATE["available"] = bool(status.get("available", False))
    _OCR_STATE["message"] = status.get("message", "OCR indisponível")
    _OCR_STATE["checked"] = True
    return bool(_OCR_STATE["available"])


def is_tesseract_available() -> bool:
    if not _OCR_STATE["checked"]:
        with _STATE_LOCK:
            if not _OCR_STATE["checked"]:
                return _probe_ocr()
    return bool(_OCR_STATE["available"])


def get_tesseract_status() -> Dict[str, Any]:
    if not _OCR_STATE["checked"]:
        _probe_ocr()
    return {
        "available": bool(_OCR_STATE["available"]),
        "message": _OCR_STATE["message"],
        "engine": "paddleocr",
    }


def log_tesseract_unavailable_once(log_info=None) -> None:
    if is_tesseract_available():
        return
    if log_info is not None:
        log_info("[OCR] PaddleOCR indisponível. OCR desativado.")


def run_tesseract_safe(image, config: str = "") -> str:
    numeric_only = "whitelist=0123456789" in config
    if isinstance(image, np.ndarray) and image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    return _run_ocr_safe(image, numeric_only=numeric_only)


def run_ocr_text(image: np.ndarray) -> str:
    results = run_paddle_ocr(image)
    texts = [t for t, c, b in results]
    return " ".join(texts)


def run_ocr_numeric(image: np.ndarray) -> str:
    results = run_paddle_ocr_numeric(image)
    if not results:
        return ""
    return results[0][0]
