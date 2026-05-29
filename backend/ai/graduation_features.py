"""Features compartilhadas para treino e inferência dos itens de formatura."""

from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageOps

GRADUATION_LABELS: tuple[str, ...] = ("beca", "faixa", "capelo", "canudo", "jabor")
GRADUATION_FEATURE_NAMES: tuple[str, ...] = (
    "mean",
    "std",
    "edge_like",
    "top_minus_bottom",
    "mid_minus_top",
    "contrast",
    "center_std",
    "aspect_ratio",
    "upper_minus_lower",
    "left_minus_right",
    "quadrant_balance",
    "top_vs_bottom_quarters",
)


def clamp01(value: float) -> float:
    return float(max(0.0, min(1.0, value)))


def pick_primary_box(boxes: Sequence[Sequence[float]] | None) -> tuple[float, float, float, float] | None:
    if not boxes:
        return None
    best = None
    best_area = -1.0
    for box in boxes:
        if len(box) < 4:
            continue
        x1, y1, x2, y2 = [float(v) for v in box[:4]]
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        if area > best_area:
            best_area = area
            best = (x1, y1, x2, y2)
    return best


def expand_box(box: tuple[float, float, float, float], width: int, height: int, crop_expand: float = 0.65) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    face_w = max(1.0, x2 - x1)
    face_h = max(1.0, y2 - y1)
    cx = (x1 + x2) / 2.0
    top = y1 - (face_h * 0.35)
    bottom = y2 + (face_h * (1.9 + crop_expand))
    left = cx - (face_w * (1.25 + crop_expand * 0.2))
    right = cx + (face_w * (1.25 + crop_expand * 0.2))
    return (
        int(max(0, math.floor(left))),
        int(max(0, math.floor(top))),
        int(min(width, math.ceil(right))),
        int(min(height, math.ceil(bottom))),
    )


def prepare_graduation_crop(
    image: Image.Image,
    box: tuple[float, float, float, float] | None,
    *,
    crop_expand: float = 0.65,
) -> Image.Image:
    width, height = image.size
    if box is None:
        left = int(width * 0.18)
        top = int(height * 0.04)
        right = int(width * 0.82)
        bottom = int(height * 0.86)
    else:
        left, top, right, bottom = expand_box(box, width, height, crop_expand)
    if right <= left or bottom <= top:
        left, top, right, bottom = 0, 0, width, height
    return image.crop((left, top, right, bottom))


def _safe_mean(arr: np.ndarray) -> float:
    return float(arr.mean()) if arr.size else 0.0


def _safe_std(arr: np.ndarray) -> float:
    return float(arr.std()) if arr.size else 0.0


def extract_graduation_features(crop: Image.Image) -> np.ndarray:
    gray = ImageOps.grayscale(crop)
    arr = np.asarray(gray, dtype=np.float32) / 255.0
    h, w = arr.shape

    top = arr[: max(1, h // 3), :]
    mid = arr[h // 3: max(h // 3 + 1, (2 * h) // 3), :]
    bottom = arr[max(1, (2 * h) // 3):, :]
    upper = arr[: max(1, h // 2), :]
    lower = arr[max(1, h // 2):, :]
    left = arr[:, : max(1, w // 2)]
    right = arr[:, max(1, w // 2):]
    top_left = arr[: max(1, h // 2), : max(1, w // 2)]
    top_right = arr[: max(1, h // 2), max(1, w // 2):]
    bottom_left = arr[max(1, h // 2):, : max(1, w // 2)]
    bottom_right = arr[max(1, h // 2):, max(1, w // 2):]
    center = arr[h // 4: max(h // 4 + 1, (3 * h) // 4), w // 4: max(w // 4 + 1, (3 * w) // 4)]

    dx = np.abs(np.diff(arr, axis=1)).mean() if w > 1 else 0.0
    dy = np.abs(np.diff(arr, axis=0)).mean() if h > 1 else 0.0
    lap = np.abs(np.diff(arr, n=2, axis=0)).mean() if h > 2 else 0.0
    contrast = float(arr.max() - arr.min())
    edge_like = float((dx + dy + lap) / 3.0)

    top_mean = _safe_mean(top)
    mid_mean = _safe_mean(mid)
    bottom_mean = _safe_mean(bottom)
    upper_mean = _safe_mean(upper)
    lower_mean = _safe_mean(lower)
    left_mean = _safe_mean(left)
    right_mean = _safe_mean(right)
    top_left_mean = _safe_mean(top_left)
    top_right_mean = _safe_mean(top_right)
    bottom_left_mean = _safe_mean(bottom_left)
    bottom_right_mean = _safe_mean(bottom_right)
    center_std = _safe_std(center)

    return np.array(
        [
            float(arr.mean()),
            float(arr.std()),
            edge_like,
            top_mean - bottom_mean,
            mid_mean - top_mean,
            contrast,
            center_std,
            float(w) / max(1.0, float(h)),
            upper_mean - lower_mean,
            left_mean - right_mean,
            (top_left_mean + bottom_right_mean) - (top_right_mean + bottom_left_mean),
            float((top_mean + top_left_mean + top_right_mean) / 3.0 - (bottom_mean + bottom_left_mean + bottom_right_mean) / 3.0),
        ],
        dtype=np.float32,
    )

