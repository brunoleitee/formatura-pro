import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_EASYOCR_READER = None
MAX_OCR_SECONDS = 3.0

from services.ocr_engine import (
    get_tesseract_status,
    is_tesseract_available,
    log_tesseract_unavailable_once,
    run_tesseract_safe,
)

OCR_DEBUG_ENABLED = os.environ.get("OCR_DEBUG", os.environ.get("FORM_PRO_OCR_DEBUG", os.environ.get("FORM_PRO_DEBUG", "0"))) == "1"
OCR_DEBUG_DIR = Path(__file__).resolve().parents[1] / "data" / ".cache" / "ocr_debug"


def _load_image(local_path: str) -> Optional[np.ndarray]:
    img = cv2.imread(local_path)
    if img is None:
        from PIL import Image

        try:
            pil = Image.open(local_path).convert("RGB")
            img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        except Exception:
            return None
    return img


def _ensure_debug_dir() -> Path:
    OCR_DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    return OCR_DEBUG_DIR


def _find_text_regions(img: np.ndarray) -> List[Tuple[int, int, int, int]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (17, 4))
    morphed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(morphed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    regions = []
    h, w = img.shape[:2]
    for cnt in contours:
        x, y, rw, rh = cv2.boundingRect(cnt)
        area = rw * rh
        if area < 15000:
            continue
        if rw < 80 or rh < 20:
            continue
        if rw > w * 0.95 or rh > h * 0.35:
            continue
        aspect = rw / max(rh, 1)
        if aspect < 1.8 or aspect > 30:
            continue
        regions.append((x, y, x + rw, y + rh))
    regions.sort(key=lambda r: (r[1], -(r[2] - r[0]) * (r[3] - r[1])))
    return regions


def _crop_region(img: np.ndarray, region: Tuple[int, int, int, int]) -> np.ndarray:
    x1, y1, x2, y2 = region
    x1, y1 = max(0, x1 - 14), max(0, y1 - 8)
    x2, y2 = min(img.shape[1], x2 + 14), min(img.shape[0], y2 + 8)
    return img[y1:y2, x1:x2]


def _expand_region(img: np.ndarray, region: Tuple[int, int, int, int], pad_x: int = 26, pad_y: int = 18) -> Tuple[int, int, int, int]:
    x1, y1, x2, y2 = region
    return (
        max(0, x1 - pad_x),
        max(0, y1 - pad_y),
        min(img.shape[1], x2 + pad_x),
        min(img.shape[0], y2 + pad_y),
    )


def _enhance_crop(crop: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
    gray = clahe.apply(gray)
    h, w = gray.shape[:2]
    if max(h, w) < 220:
        scale = 420.0 / max(h, w)
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    sharpen = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    gray = cv2.filter2D(gray, -1, sharpen)
    _, gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return gray


def _run_tesseract(image: np.ndarray, config: str = "") -> str:
    return run_tesseract_safe(image, config=config)


def _extract_number_candidates(text: str) -> List[str]:
    candidates = re.findall(r"\d{3,}", text or "")
    unique: List[str] = []
    seen = set()
    for item in candidates:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def _extract_id_card_candidates(text: str) -> List[str]:
    candidates = re.findall(r"\d{3,6}", text or "")
    unique: List[str] = []
    seen = set()
    for item in candidates:
        if 3 <= len(item) <= 6 and item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def _label_hint(text: str) -> bool:
    if not text:
        return False
    upper = text.upper()
    tokens = ("Nº", "N°", "NO", "NUMERO", "MATRICULA", "MATRÍCULA", "FICHA", "CRACHA", "CRACHÁ")
    return any(token in upper for token in tokens)


def _region_geometry_score(img: np.ndarray, region: Tuple[int, int, int, int]) -> float:
    x1, y1, x2, y2 = region
    width = max(x2 - x1, 1)
    height = max(y2 - y1, 1)
    area = width * height
    img_area = max(img.shape[0] * img.shape[1], 1)
    aspect = width / height

    area_score = min(area / max(img_area * 0.20, 1), 1.0)
    aspect_score = min(max((aspect - 1.8) / 8.0, 0.0), 1.0)

    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    img_cx = img.shape[1] / 2.0
    img_cy = img.shape[0] / 2.0
    dx = abs(cx - img_cx) / max(img.shape[1], 1)
    dy = abs(cy - img_cy) / max(img.shape[0], 1)
    center_score = max(0.0, 1.0 - ((dx * 0.75) + (dy * 0.25)) * 2.0)

    crop = img[y1:y2, x1:x2]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.size else np.zeros((1, 1), dtype=np.uint8)
    brightness = float(np.mean(gray)) / 255.0
    brightness_score = min(max((brightness - 0.42) / 0.5, 0.0), 1.0)

    return float(max(0.0, min((area_score * 0.35) + (aspect_score * 0.25) + (center_score * 0.2) + (brightness_score * 0.2), 1.0)))


def _digit_length_score(number_text: str) -> float:
    length = len(number_text or "")
    if length == 0:
        return 0.0
    if 4 <= length <= 6:
        return 1.0
    if length == 3:
        return 0.92
    if length == 7:
        return 0.65
    if length == 8:
        return 0.45
    if length == 9:
        return 0.28
    return 0.15


def _candidate_ocr_score(*, text: str, confidence: float, region_score: float, label_hint: bool, numeric_only: bool, source_kind: str) -> float:
    numbers = _extract_number_candidates(text)
    if not numbers:
        return 0.0
    best_number = max(numbers, key=lambda value: (_digit_length_score(value), len(value)))
    length_score = _digit_length_score(best_number)
    conf_score = max(0.0, min(float(confidence), 1.0))
    source_bonus = 0.08 if source_kind == "region" else 0.0
    numeric_bonus = 0.10 if numeric_only else 0.0
    label_bonus = 0.12 if label_hint else 0.0
    score = (
        (conf_score * 0.48)
        + (length_score * 0.24)
        + (region_score * 0.16)
        + source_bonus
        + numeric_bonus
        + label_bonus
    )
    return float(max(0.0, min(score, 0.99)))


def _ocr_label(number_text: str, label_hint: bool, fallback: str) -> Tuple[str, str]:
    length = len(number_text or "")
    if label_hint or fallback == "ficha_numerica":
        if length <= 5:
            return "ficha_numerica", "Ficha numérica"
        return "matricula_numerica", "Matrícula numérica"
    if length <= 5:
        return "ficha_numerica", "Ficha numérica"
    if length >= 6:
        return "matricula_numerica", "Matrícula numérica"
    return fallback, "OCR geral"


def _build_candidate(
    *,
    source: str,
    region: Optional[Tuple[int, int, int, int]],
    crop: np.ndarray,
    text: str,
    raw_text: str,
    confidence: float,
    region_score: float,
    label_hint: bool,
    numeric_only: bool,
) -> Optional[Dict[str, Any]]:
    number_candidates = _extract_number_candidates(text)
    if not number_candidates:
        return None

    best_number = max(number_candidates, key=lambda value: (_digit_length_score(value), len(value)))
    ocr_type, ocr_label = _ocr_label(best_number, label_hint, "ficha_numerica" if numeric_only else "ocr_geral")
    score = _candidate_ocr_score(
        text=text,
        confidence=confidence,
        region_score=region_score,
        label_hint=label_hint,
        numeric_only=numeric_only,
        source_kind=source,
    )

    return {
        "id": f"{source}:{best_number}:{region[0] if region else 'full'}:{region[1] if region else 'full'}",
        "source": source,
        "region": region,
        "crop": crop,
        "raw_text": raw_text,
        "text": text,
        "numbers": best_number,
        "confidence": round(score, 4),
        "score": round(score, 4),
        "ocr_type": ocr_type,
        "ocr_label": ocr_label,
        "label_hint": label_hint,
        "numeric_only": numeric_only,
        "region_score": round(region_score, 4),
    }


def _save_debug_artifacts(local_path: str, img: np.ndarray, regions: List[Dict[str, Any]], best: Optional[Dict[str, Any]], result: Dict[str, Any]) -> None:
    if not OCR_DEBUG_ENABLED:
        return
    try:
        debug_dir = _ensure_debug_dir() / Path(local_path).stem / datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        debug_dir.mkdir(parents=True, exist_ok=True)

        cv2.imwrite(str(debug_dir / "original.png"), img)

        overlay = img.copy()
        for item in regions:
            x1, y1, x2, y2 = item["region"]
            color = (0, 255, 0) if best and item.get("id") == best.get("id") else (255, 165, 0)
            cv2.rectangle(overlay, (x1, y1), (x2, y2), color, 2)
            cv2.putText(
                overlay,
                f"{item.get('ocr_label', '')} {item.get('score', 0.0):.2f}",
                (x1, max(0, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                color,
                1,
                cv2.LINE_AA,
            )
        cv2.imwrite(str(debug_dir / "regions.png"), overlay)

        if best and best.get("crop") is not None:
            crop = best["crop"]
            if crop.ndim == 2:
                crop = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
            cv2.imwrite(str(debug_dir / "best_crop.png"), crop)

        payload = {
            "result": result,
            "best": {k: v for k, v in (best or {}).items() if k != "crop"},
            "regions": [{k: v for k, v in item.items() if k != "crop"} for item in regions],
        }
        (debug_dir / "result.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _ocr_general(image: np.ndarray) -> Dict[str, Any]:
    config = "--oem 3 --psm 6"
    text = _run_tesseract(image, config)
    numbers = _extract_number_candidates(text)
    conf = min(0.86, 0.28 + len(numbers) * 0.06) if numbers else 0.0
    return {"text": text, "numbers": numbers, "confidence": conf, "type": "ocr_geral", "label": "OCR geral"}


def _ocr_numeric_only(image: np.ndarray) -> Dict[str, Any]:
    config = "--psm 7 -c tessedit_char_whitelist=0123456789"
    text = _run_tesseract(image, config)
    numbers = _extract_number_candidates(text)
    conf = min(0.97, 0.48 + len(numbers) * 0.08) if numbers else 0.0
    return {"text": text, "numbers": numbers, "confidence": conf, "type": "ficha_numerica", "label": "Ficha numérica"}


def _id_card_regions(img: np.ndarray) -> List[Tuple[str, Tuple[int, int, int, int], float]]:
    h, w = img.shape[:2]
    regions = [
        ("lower_half", (0, int(h * 0.50), w, h), 0.90),
        ("lower_third", (0, int(h * 0.66), w, h), 0.96),
        ("lower_band_55_95", (0, int(h * 0.55), w, int(h * 0.95)), 1.00),
        ("center_lower", (int(w * 0.12), int(h * 0.58), int(w * 0.88), int(h * 0.95)), 1.00),
        ("hand_card_area", (int(w * 0.18), int(h * 0.62), int(w * 0.82), int(h * 0.92)), 0.98),
        ("bottom_center", (int(w * 0.20), int(h * 0.70), int(w * 0.80), int(h * 0.98)), 0.94),
    ]
    valid = []
    for name, (x1, y1, x2, y2), weight in regions:
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 - x1 >= 80 and y2 - y1 >= 40:
            valid.append((name, (x1, y1, x2, y2), weight))
    return valid


def _prepare_id_card_variants(crop: np.ndarray) -> List[Tuple[str, np.ndarray, float]]:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop.copy()
    gray = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
    clahe = cv2.createCLAHE(clipLimit=3.5, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    h, w = gray.shape[:2]
    scale = 3.0 if max(h, w) < 900 else 2.0
    upscaled = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    sharpen = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    sharp = cv2.filter2D(upscaled, -1, sharpen)
    blur = cv2.GaussianBlur(sharp, (3, 3), 0)
    otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    otsu_inv = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    adaptive = cv2.adaptiveThreshold(
        blur,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        7,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    opened = cv2.morphologyEx(otsu, cv2.MORPH_OPEN, kernel, iterations=1)
    return [
        ("gray", upscaled, 0.80),
        ("sharp", sharp, 0.86),
        ("otsu", otsu, 0.94),
        ("otsu_inv", otsu_inv, 0.88),
        ("adaptive", adaptive, 0.92),
        ("opened", opened, 0.90),
    ]


def _ocr_segmented_large_digits(image: np.ndarray) -> Optional[str]:
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()
    if float(np.mean(gray)) < 127.0:
        binary = 255 - gray
    else:
        binary = gray

    inv = 255 - binary
    contours, _ = cv2.findContours(inv, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = binary.shape[:2]
    boxes = []
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        area = bw * bh
        if bh < h * 0.18 or bw < w * 0.015:
            continue
        if area < max(500, h * w * 0.002):
            continue
        if bh > h * 0.95 or bw > w * 0.45:
            continue
        boxes.append((x, y, bw, bh))

    boxes.sort(key=lambda item: item[0])
    if not 3 <= len(boxes) <= 6:
        return None

    digits = []
    for x, y, bw, bh in boxes:
        pad = max(12, int(max(bw, bh) * 0.10))
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(w, x + bw + pad)
        y2 = min(h, y + bh + pad)
        roi = binary[y1:y2, x1:x2]
        text = _run_tesseract(
            roi,
            "--oem 3 --psm 13 -c tessedit_char_whitelist=0123456789 -c classify_bln_numeric_mode=1",
        )
        digit = re.sub(r"\D", "", text or "")
        if len(digit) != 1:
            return None
        digits.append(digit)

    number = "".join(digits)
    return number if 3 <= len(number) <= 6 else None


def _save_id_card_debug(local_path: str, img: np.ndarray, candidates: List[Dict[str, Any]], crops: List[Dict[str, Any]], result: Dict[str, Any]) -> None:
    if not OCR_DEBUG_ENABLED:
        return
    try:
        debug_dir = _ensure_debug_dir() / Path(local_path).stem / "id_card" / datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "original.png"), img)

        overlay = img.copy()
        for item in crops:
            x1, y1, x2, y2 = item["region"]
            cv2.rectangle(overlay, (x1, y1), (x2, y2), (0, 200, 255), 2)
            cv2.putText(overlay, item["name"], (x1, max(0, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 200, 255), 1, cv2.LINE_AA)
            crop_img = item.get("crop")
            if crop_img is not None:
                cv2.imwrite(str(debug_dir / f"{item['name']}.png"), crop_img)
        cv2.imwrite(str(debug_dir / "regions.png"), overlay)

        payload = {
            "result": result,
            "candidates": [{k: v for k, v in item.items() if k not in ("crop", "image")} for item in candidates],
            "crops": [{k: v for k, v in item.items() if k != "crop"} for item in crops],
        }
        (debug_dir / "result.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _empty_ocr_result() -> Dict[str, Any]:
    return {
        "ocr_text": "",
        "ocr_confidence": 0.0,
        "ocr_confidence_pct": 0,
        "ocr_type": "none",
        "ocr_label": "OCR geral",
        "ocr_enriched": False,
    }


def _enriched_ocr_result(number: str, confidence: float) -> Dict[str, Any]:
    return {
        "ocr_text": number,
        "ocr_confidence": round(confidence, 4),
        "ocr_confidence_pct": int(round(confidence * 100)),
        "ocr_type": "id_card",
        "ocr_label": "Ficha numérica",
        "ocr_enriched": True,
    }


def _detect_plate_in_crop(crop: np.ndarray) -> Optional[Tuple[int, int, int, int, np.ndarray, float]]:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    h_img, w_img = gray.shape
    if h_img < 20 or w_img < 20:
        return None

    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    best_plate = None
    best_score = 0.0

    for thresh_val in range(180, 250, 10):
        _, thresh = cv2.threshold(blur, thresh_val, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            area = w * h
            crop_area = h_img * w_img
            if area < crop_area * 0.03:
                continue
            aspect = w / max(h, 1)
            if aspect < 1.0 or aspect > 8.0:
                continue
            area_ratio = area / crop_area
            cx = x + w / 2
            cy = y + h / 2
            crop_cx = w_img / 2
            crop_cy = h_img / 2
            dist = ((cx - crop_cx) ** 2 + (cy - crop_cy) ** 2) ** 0.5
            max_dist = ((crop_cx) ** 2 + (crop_cy) ** 2) ** 0.5
            center_score = 1.0 - (dist / max(max_dist, 1))
            plate_region = gray[y:y + h, x:x + w]
            if plate_region.size == 0:
                continue
            mean_brightness = float(np.mean(plate_region))
            brightness_score = min(mean_brightness / 255.0 * 1.5, 1.0)
            score = area_ratio * 0.4 + center_score * 0.3 + brightness_score * 0.3
            if score > best_score:
                best_score = score
                best_plate = (x, y, w, h, crop[y:y + h, x:x + w])

    if best_plate is not None and best_score > 0.3:
        x, y, w_rect, h_rect, plate_img = best_plate
        return (x, y, w_rect, h_rect, plate_img, best_score)
    return None


def _remove_small_components(binary: np.ndarray, min_area: int = 40) -> np.ndarray:
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    cleaned = np.zeros_like(binary)
    for i in range(1, num_labels):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            cleaned[labels == i] = 255
    return cleaned


def _add_plate_padding(plate_bgr: np.ndarray, pad: int = 15) -> np.ndarray:
    return cv2.copyMakeBorder(plate_bgr, pad, pad, pad, pad, cv2.BORDER_REPLICATE)


def _segment_digits_in_plate(binary: np.ndarray, min_height_ratio: float = 0.3, max_width_height_ratio: float = 1.2) -> List[Tuple[int, int, int, int, np.ndarray]]:
    h, w = binary.shape
    if h < 10 or w < 10:
        return []
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    blobs: List[Tuple[int, int, int, int, int, np.ndarray]] = []
    for i in range(1, num_labels):
        x = stats[i, cv2.CC_STAT_LEFT]
        y = stats[i, cv2.CC_STAT_TOP]
        bw = stats[i, cv2.CC_STAT_WIDTH]
        bh = stats[i, cv2.CC_STAT_HEIGHT]
        area = stats[i, cv2.CC_STAT_AREA]
        if bh < h * min_height_ratio:
            continue
        if bh > h * 0.95:
            continue
        if bw < 4 or bh < 8:
            continue
        aspect = bw / max(bh, 1)
        if aspect > max_width_height_ratio:
            continue
        if area < 30:
            continue
        if x < 2 or (x + bw) > w - 2:
            continue
        blobs.append((x, y, bw, bh, area, binary[y:y + bh, x:x + bw]))
    blobs.sort(key=lambda b: b[0])
    return [(x, y, bw, bh, crop) for x, y, bw, bh, _, crop in blobs]


def _ocr_single_digit(digit_crop: np.ndarray) -> Optional[str]:
    if digit_crop.size == 0:
        return None
    h, w = digit_crop.shape[:2]
    padded = cv2.copyMakeBorder(digit_crop, 8, 8, 8, 8, cv2.BORDER_REPLICATE)
    if max(h, w) < 100:
        scale = 140.0 / max(h, w)
        padded = cv2.resize(padded, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    for psm in ("10", "13"):
        config = f"--oem 3 --psm {psm} -c tessedit_char_whitelist=0123456789"
        text = _run_tesseract(padded, config)
        clean = re.sub(r"\D", "", (text or "").strip())
        if len(clean) == 1:
            return clean
    return None


def _segmented_plate_ocr(plate_bgr: np.ndarray, plate_score: float, start: float, local_path: str, crop_idx: int) -> Optional[Dict[str, Any]]:
    if time.time() - start > MAX_OCR_SECONDS:
        return None

    padded = _add_plate_padding(plate_bgr, 12)
    gray = cv2.cvtColor(padded, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    if max(h, w) < 600:
        scale = 900.0 / max(h, w)
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    prep_variants = [
        ("adaptive", lambda g: cv2.adaptiveThreshold(cv2.GaussianBlur(g, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 12)),
        ("otsu", lambda g: cv2.threshold(cv2.GaussianBlur(g, (3, 3), 0), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]),
    ]

    best_digits: Optional[List[str]] = None
    best_conf = 0.0

    for var_name, thresh_fn in prep_variants:
        if time.time() - start > MAX_OCR_SECONDS:
            break
        binary = thresh_fn(gray)
        mean_val = np.mean(binary)
        if mean_val < 127:
            binary = 255 - binary
        binary = _remove_small_components(binary, 40)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

        _save_debug_plate(local_path, f"debug_threshold_{crop_idx}_{var_name}.jpg", binary)

        blobs = _segment_digits_in_plate(binary)
        if len(blobs) < 3 or len(blobs) > 6:
            _save_debug_plate(local_path, f"debug_blobs_{crop_idx}_{var_name}.jpg", binary)
            continue

        print(f"[OCR-ID] blobs encontrados: {len(blobs)}")
        digits: List[str] = []
        valid = True
        for bi, (bx, by, bw, bh, digit_crop) in enumerate(blobs, 1):
            if time.time() - start > MAX_OCR_SECONDS:
                valid = False
                break
            print(f"[OCR-ID] blob {bi} bbox: {bx},{by},{bw},{bh}")
            _save_debug_plate(local_path, f"debug_blob_{crop_idx}_{var_name}_{bi}.jpg", digit_crop)
            d = _ocr_single_digit(digit_crop)
            if d is None:
                print(f"[OCR-ID] blob {bi} OCR: falhou")
                valid = False
                break
            print(f"[OCR-ID] blob {bi} OCR: {d}")
            digits.append(d)

        if not valid or len(digits) < 3 or len(digits) > 5:
            continue

        number = "".join(digits)
        if not re.match(r"^\d{3,5}$", number):
            continue

        if number in [d.get("number") for d in []]:  # skip seen
            continue

        mean_blob_height = np.mean([b[3] for b in blobs]) if blobs else 0
        h_norm = binary.shape[0] if binary.shape[0] > 0 else 1
        height_score = min(mean_blob_height / max(h_norm * 0.5, 1), 1.0)
        length_score = 1.0 if len(digits) in (4, 5) else 0.8
        conf = min(0.97, 0.5 + len(digits) * 0.09 + height_score * 0.2)
        score = length_score * 0.5 + height_score * 0.3 + plate_score * 0.2
        score = float(max(0.0, min(score, 0.99)))

        if score > best_conf:
            best_conf = score
            best_digits = digits

    if best_digits and best_conf >= 0.75:
        number = "".join(best_digits)
        print(f"[OCR-ID] resultado final: {number}")
        return {
            "numbers": number,
            "confidence": round(best_conf, 4),
            "score": round(best_conf, 4),
        }
    return None


def _save_debug_plate(local_path: str, tag: str, img: np.ndarray) -> None:
    if not OCR_DEBUG_ENABLED:
        return
    try:
        debug_dir = _ensure_debug_dir() / Path(local_path).stem
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / tag), img)
    except Exception:
        pass


def _ocr_crop_fallback(crop: np.ndarray, start: float, candidates: List[Dict[str, Any]]) -> None:
    if time.time() - start > MAX_OCR_SECONDS:
        return
    text = _run_tesseract(crop, "--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789")
    clean = re.sub(r"\D", "", (text or "").strip())
    if not re.match(r"^\d{3,5}$", clean):
        return
    score = min(0.97, 0.54 + _digit_length_score(clean) * 0.18)
    if score >= 0.75:
        candidates.append({"numbers": clean, "confidence": round(score, 4), "score": round(score, 4)})


def process_id_card_ocr(local_path: str, img: Optional[np.ndarray] = None) -> Dict[str, Any]:
    start = time.time()
    print("[OCR-ID] iniciando leitura da ficha")
    try:
        if img is None:
            img = _load_image(local_path)
        if img is None:
            print("[OCR-ID] sem numero detectado")
            elapsed = int((time.time() - start) * 1000)
            print(f"[OCR-ID] finalizado em {elapsed}ms")
            return _empty_ocr_result()

        h, w = img.shape[:2]
        crop_defs = [
            ("inferior_amplo", (0, int(h * 0.55), w, int(h * 0.95))),
            ("central_inferior", (int(w * 0.15), int(h * 0.58), int(w * 0.85), int(h * 0.90))),
            ("ficha_provavel", (int(w * 0.20), int(h * 0.62), int(w * 0.80), int(h * 0.88))),
        ]

        if time.time() - start > MAX_OCR_SECONDS:
            print("[OCR-ID] timeout, abortando OCR da ficha")
            return _empty_ocr_result()

        candidates: List[Dict[str, Any]] = []
        plates_found = 0

        for idx, (name, (x1, y1, x2, y2)) in enumerate(crop_defs, 1):
            if time.time() - start > MAX_OCR_SECONDS:
                print("[OCR-ID] timeout, abortando OCR da ficha")
                break

            crop = img[y1:y2, x1:x2]
            if crop.size == 0:
                continue

            print(f"[OCR-ID] crop {idx}/{len(crop_defs)} criado")
            _save_debug_plate(local_path, f"debug_crop_{idx}.jpg", crop)

            plate_result = _detect_plate_in_crop(crop)
            if plate_result is None:
                print(f"[OCR-ID] crop {idx}/{len(crop_defs)} sem placa detectada")
                _ocr_crop_fallback(crop, start, candidates)
                continue

            px, py, pw, ph, plate_img, plate_score = plate_result
            plates_found += 1
            print(f"[OCR-ID] placa detectada")
            print(f"[OCR-ID] bbox placa: {px},{py},{pw},{ph}")
            _save_debug_plate(local_path, f"debug_plate_crop_{idx}.jpg", plate_img)

            if time.time() - start > MAX_OCR_SECONDS:
                break

            seg_result = _segmented_plate_ocr(plate_img, plate_score, start, local_path, idx)
            if seg_result:
                candidates.append(seg_result)

        print(f"[OCR-ID] candidatos OCR: {[c['numbers'] for c in candidates]}")
        print(f"[OCR-ID] placas detectadas: {plates_found}")

        if not candidates:
            print("[OCR-ID] sem numero detectado")
            elapsed = int((time.time() - start) * 1000)
            print(f"[OCR-ID] finalizado em {elapsed}ms")
            return _empty_ocr_result()

        candidates.sort(key=lambda c: (c["confidence"], len(c["numbers"])), reverse=True)
        best = candidates[0]
        number = best["numbers"]
        confidence = best["confidence"]

        print(f"[OCR-ID] melhor candidato: {number}")
        print(f"[OCR-ID] score final: {confidence:.2f}")
        elapsed = int((time.time() - start) * 1000)
        print(f"[OCR-ID] finalizado em {elapsed}ms")

        if confidence < 0.75:
            print(f"[OCR-ID] confianca {confidence:.2f} abaixo de 0.75, descartando")
            return _empty_ocr_result()

        return _enriched_ocr_result(number, confidence)

    except Exception as e:
        print(f"[OCR-ID] erro protegido: {e}")
        return _empty_ocr_result()


def _result_from_candidate(candidate: Optional[Dict[str, Any]], regions_found: int, candidates_count: int, tesseract_status: Dict[str, Any]) -> Dict[str, Any]:
    if not candidate:
        return {
            "ocr_text": "",
            "ocr_confidence": 0.0,
            "ocr_confidence_pct": 0,
            "ocr_score": 0.0,
            "ocr_type": "none",
            "ocr_label": "OCR geral",
            "ocr_raw": "",
            "regions_found": regions_found,
            "candidates": candidates_count,
            "ocr_available": True,
            "ocr_status": tesseract_status,
        }

    return {
        "ocr_text": candidate["numbers"],
        "ocr_confidence": round(float(candidate["confidence"]), 4),
        "ocr_confidence_pct": int(round(float(candidate["confidence"]) * 100)),
        "ocr_score": round(float(candidate["score"]), 4),
        "ocr_type": candidate["ocr_type"],
        "ocr_label": candidate["ocr_label"],
        "ocr_raw": candidate["raw_text"],
        "regions_found": regions_found,
        "candidates": candidates_count,
        "ocr_available": True,
        "ocr_status": tesseract_status,
    }


def process_ocr(local_path: str) -> Dict[str, Any]:
    if not is_tesseract_available():
        log_tesseract_unavailable_once(logger.info)
        status = get_tesseract_status()
        return {
            "ocr_text": "",
            "ocr_confidence": 0.0,
            "ocr_confidence_pct": 0,
            "ocr_score": 0.0,
            "ocr_type": "unavailable",
            "ocr_label": "OCR indisponível",
            "ocr_raw": "",
            "regions_found": 0,
            "candidates": 0,
            "error": "Tesseract não instalado ou fora do PATH",
            "ocr_available": False,
            "ocr_status": status,
        }

    img = _load_image(local_path)
    if img is None:
        return {
            "ocr_text": "",
            "ocr_confidence": 0.0,
            "ocr_confidence_pct": 0,
            "ocr_score": 0.0,
            "ocr_type": "none",
            "ocr_label": "OCR geral",
            "ocr_raw": "",
            "regions_found": 0,
            "candidates": 0,
            "ocr_available": True,
            "ocr_status": get_tesseract_status(),
        }

    id_card_result = process_id_card_ocr(local_path, img)
    if id_card_result and id_card_result.get("ocr_text"):
        return id_card_result

    regions = _find_text_regions(img)
    all_candidates: List[Dict[str, Any]] = []

    # 1) OCR numérico na imagem inteira
    full_numeric = _ocr_numeric_only(img)
    if full_numeric["numbers"]:
        full_candidate = _build_candidate(
            source="full",
            region=None,
            crop=img,
            text=full_numeric["text"],
            raw_text=full_numeric["text"],
            confidence=full_numeric["confidence"],
            region_score=0.15,
            label_hint=_label_hint(full_numeric["text"]),
            numeric_only=True,
        )
        if full_candidate:
            all_candidates.append(full_candidate)

    # 2) Regiões maiores, horizontais e mais claras
    for idx, region in enumerate(regions):
        expanded = _expand_region(img, region)
        crop = _crop_region(img, expanded)
        enhanced = _enhance_crop(crop)

        geom_score = _region_geometry_score(img, region)
        expanded_crop = img[expanded[1]:expanded[3], expanded[0]:expanded[2]]
        general_hint = _ocr_general(expanded_crop)
        label_hint = _label_hint(general_hint["text"])

        numeric = _ocr_numeric_only(enhanced)
        candidate = _build_candidate(
            source="region",
            region=region,
            crop=crop,
            text=numeric["text"],
            raw_text=numeric["text"],
            confidence=numeric["confidence"],
            region_score=geom_score,
            label_hint=label_hint,
            numeric_only=True,
        )
        if candidate:
            candidate["region_index"] = idx
            all_candidates.append(candidate)

    # 3) OCR geral apenas como fallback
    if not all_candidates:
        general = _ocr_general(img)
        candidate = _build_candidate(
            source="full",
            region=None,
            crop=img,
            text=general["text"],
            raw_text=general["text"],
            confidence=general["confidence"],
            region_score=0.0,
            label_hint=_label_hint(general["text"]),
            numeric_only=False,
        )
        if candidate:
            all_candidates.append(candidate)

    if not all_candidates:
        result = {
            "ocr_text": "",
            "ocr_confidence": 0.0,
            "ocr_confidence_pct": 0,
            "ocr_score": 0.0,
            "ocr_type": "none",
            "ocr_label": "OCR geral",
            "ocr_raw": "",
            "regions_found": len(regions),
            "candidates": 0,
            "ocr_available": True,
            "ocr_status": get_tesseract_status(),
        }
        _save_debug_artifacts(local_path, img, [], None, result)
        return result

    all_candidates.sort(key=lambda item: (item.get("score", 0.0), len(item.get("numbers", ""))), reverse=True)
    best = all_candidates[0]
    result = _result_from_candidate(best, len(regions), len(all_candidates), get_tesseract_status())
    _save_debug_artifacts(local_path, img, all_candidates, best, result)
    return result


def cross_reference_ocr_with_face(
    face_result: Optional[Dict[str, Any]] = None,
    ocr_result: Optional[Dict[str, Any]] = None,
    *,
    ocr_text: str = "",
    ocr_confidence: float = 0.0,
    face_student: Optional[str] = None,
    face_confidence: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Faz cruzamento simples entre OCR e face detection.
    Fallback seguro para evitar quebra do pipeline hibrido.
    """
    face_result = face_result or {}
    ocr_result = ocr_result or {}

    if not ocr_text:
        ocr_text = str(ocr_result.get("ocr_text") or ocr_result.get("text") or "")
    if not ocr_confidence:
        try:
            ocr_confidence = float(ocr_result.get("ocr_confidence") or ocr_result.get("confidence") or 0.0)
        except Exception:
            ocr_confidence = 0.0
    if face_student is None:
        face_student = face_result.get("face_student") or face_result.get("student") or face_result.get("aluno_id")
    if face_confidence is None:
        try:
            face_confidence = float(face_result.get("face_confidence") or face_result.get("confidence") or 0.0)
        except Exception:
            face_confidence = 0.0

    ocr_confidence = max(0.0, min(float(ocr_confidence or 0.0), 1.0))
    face_confidence = max(0.0, min(float(face_confidence or 0.0), 1.0))
    suggested_id = ocr_text.strip() or None

    final_student = suggested_id or face_student
    final_confidence = ocr_confidence if suggested_id else face_confidence

    return {
        "matched": bool(face_student and suggested_id and str(face_student) == str(suggested_id)),
        "ocr_confidence": ocr_confidence,
        "face_confidence": face_confidence,
        "suggested_id": suggested_id,
        "final_student": final_student,
        "final_confidence": final_confidence,
        "ocr_enriched": bool(suggested_id),
    }
