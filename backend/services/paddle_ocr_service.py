import os
import re
from typing import Any, Dict, List, Tuple, Optional
import numpy as np

_PPOCR_STATE = {
    "available": False,
    "message": "PaddleOCR desativado permanentemente",
    "gpu": False,
    "initialized": True,
}

def get_paddle_ocr(gpu: Optional[bool] = None) -> Optional[Any]:
    return None

def run_paddle_ocr(image: np.ndarray) -> List[Tuple[str, float, Any]]:
    return []

def run_paddle_ocr_numeric(image: np.ndarray) -> List[Tuple[str, float, str, Any]]:
    return []

def run_ocr_safe(image: np.ndarray, numeric_only: bool = False) -> str:
    return ""

def is_ocr_available() -> bool:
    return False

def get_ocr_status() -> Dict[str, Any]:
    return dict(_PPOCR_STATE)

def reset_ocr() -> None:
    pass

is_tesseract_available = is_ocr_available
get_tesseract_status = get_ocr_status
