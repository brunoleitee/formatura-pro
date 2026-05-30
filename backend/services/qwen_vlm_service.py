import os
from typing import Any, Dict, List, Optional
import numpy as np

_QWEN_STATE: Dict[str, Any] = {
    "available": False,
    "message": "Qwen2.5-VL desativado permanentemente",
    "loading": False,
    "quantized": False,
}

def load_qwen_model(quantize: bool = True) -> bool:
    print("[VLM] Qwen2.5-VL desativado permanentemente.")
    return False

def is_qwen_available() -> bool:
    return False

def get_qwen_status() -> Dict[str, Any]:
    return dict(_QWEN_STATE)

def analyze_graduation_image(image: np.ndarray) -> Optional[Dict[str, Any]]:
    return None

def analyze_graduation_image_batch(
    images: List[np.ndarray],
    max_batch: int = 4,
) -> List[Optional[Dict[str, Any]]]:
    return [None] * min(len(images), max_batch)
