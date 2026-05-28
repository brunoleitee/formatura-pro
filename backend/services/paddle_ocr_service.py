import os
import re
import threading
import logging
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_PPOCR_INSTANCE = None
_PPOCR_LOCK = threading.Lock()
_PPOCR_STATE: Dict[str, Any] = {
    "available": False,
    "message": "PaddleOCR não inicializado",
    "gpu": False,
    "initialized": False,
}


def get_paddle_ocr(gpu: Optional[bool] = None) -> Optional[Any]:
    global _PPOCR_INSTANCE
    if _PPOCR_INSTANCE is None:
        with _PPOCR_LOCK:
            if _PPOCR_INSTANCE is None:
                _init_paddle_ocr(gpu)
    return _PPOCR_INSTANCE


def _init_paddle_ocr(gpu: Optional[bool] = None) -> None:
    global _PPOCR_INSTANCE
    try:
        use_gpu = False
        if gpu is not None:
            use_gpu = gpu
        else:
            try:
                import torch
                use_gpu = torch.cuda.is_available()
            except Exception:
                use_gpu = False

        from paddleocr import PaddleOCR

        kwargs = dict(use_angle_cls=True, lang='en', show_log=False, use_gpu=use_gpu)
        _PPOCR_INSTANCE = PaddleOCR(**kwargs)
        _PPOCR_STATE["available"] = True
        _PPOCR_STATE["gpu"] = use_gpu
        _PPOCR_STATE["message"] = f"PaddleOCR disponível (GPU={use_gpu})"
        _PPOCR_STATE["initialized"] = True
        print(f"[OCR] PaddleOCR initialized (GPU={use_gpu})")
    except ImportError as e:
        _PPOCR_STATE["message"] = f"PaddleOCR não instalado: {e}"
        _PPOCR_STATE["initialized"] = True
        print(f"[OCR] PaddleOCR não disponível: {e}")
    except Exception as e:
        _PPOCR_STATE["message"] = f"PaddleOCR erro init: {e}"
        _PPOCR_STATE["initialized"] = True
        print(f"[OCR] PaddleOCR init error: {e}")


def run_paddle_ocr(image: np.ndarray) -> List[Tuple[str, float, Any]]:
    reader = get_paddle_ocr()
    if reader is None:
        return []
    try:
        result = reader.ocr(image, cls=True)
        texts: List[Tuple[str, float, Any]] = []
        if result and isinstance(result, list):
            for page in result:
                if page and isinstance(page, list):
                    for item in page:
                        if len(item) == 2:
                            bbox, (text, confidence) = item
                            texts.append((str(text).strip(), float(confidence), bbox))
        return texts
    except Exception as e:
        print(f"[OCR] PaddleOCR run error: {e}")
        return []


def run_paddle_ocr_numeric(image: np.ndarray) -> List[Tuple[str, float, str, Any]]:
    results = run_paddle_ocr(image)
    numeric: List[Tuple[str, float, str, Any]] = []
    for text, conf, bbox in results:
        clean = re.sub(r"\D", "", text)
        if clean:
            numeric.append((clean, conf, text, bbox))
    numeric.sort(key=lambda x: (-len(x[0]), -x[1]))
    return numeric


def run_ocr_safe(image: np.ndarray, numeric_only: bool = False) -> str:
    if numeric_only:
        results = run_paddle_ocr_numeric(image)
    else:
        results = run_paddle_ocr(image)
    if not results:
        return ""
    if numeric_only:
        texts = [r[0] for r in results]
    else:
        texts = [r[0] for r in results]
    return " ".join(texts)


def is_ocr_available() -> bool:
    if not _PPOCR_STATE["initialized"]:
        get_paddle_ocr()
    return bool(_PPOCR_STATE["available"])


def get_ocr_status() -> Dict[str, Any]:
    if not _PPOCR_STATE["initialized"]:
        get_paddle_ocr()
    return {
        "available": bool(_PPOCR_STATE["available"]),
        "message": _PPOCR_STATE["message"],
        "gpu": bool(_PPOCR_STATE["gpu"]),
        "initialized": bool(_PPOCR_STATE["initialized"]),
    }


def reset_ocr() -> None:
    global _PPOCR_INSTANCE
    with _PPOCR_LOCK:
        _PPOCR_INSTANCE = None
        _PPOCR_STATE["available"] = False
        _PPOCR_STATE["message"] = "PaddleOCR não inicializado"
        _PPOCR_STATE["initialized"] = False


# ── Backward compatibility aliases ──
is_tesseract_available = is_ocr_available
get_tesseract_status = get_ocr_status
