import json
import logging
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_EASYOCR_READER = None
_EASYOCR_LOCK = threading.Lock()

def get_easyocr_reader():
    global _EASYOCR_READER
    if _EASYOCR_READER is None:
        with _EASYOCR_LOCK:
            if _EASYOCR_READER is None:
                try:
                    import easyocr
                    import io
                    import contextlib
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        _EASYOCR_READER = easyocr.Reader(['en'], gpu=False)
                    print("[EasyOCR] Reader inicializado com sucesso")
                except Exception as e:
                    print(f"[EasyOCR] Erro ao inicializar: {e}")
                    _EASYOCR_READER = False
    return _EASYOCR_READER if _EASYOCR_READER is not False else None

MAX_OCR_SECONDS = 6.0
OCR_FALLBACK_RESERVE_SECONDS = 1.2

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


def detect_probable_badge_region(img: np.ndarray, primary_face_bbox: Tuple[int, int, int, int]) -> Tuple[int, int, int, int]:
    x1, y1, x2, y2 = primary_face_bbox
    face_w = x2 - x1
    face_h = y2 - y1
    
    badge_x1 = int(x1 - face_w * 0.8)
    badge_x2 = int(x2 + face_w * 0.8)
    
    badge_y1 = int(y2 + face_h * 0.3)
    badge_y2 = int(y2 + face_h * 2.2)
    
    h, w = img.shape[:2]
    
    badge_x1 = max(0, badge_x1)
    badge_y1 = max(0, badge_y1)
    badge_x2 = min(w, badge_x2)
    badge_y2 = min(h, badge_y2)
    
    return (badge_x1, badge_y1, badge_x2, badge_y2)


def _detect_primary_face(img: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        scale = 1.0
        max_dim = 1000.0
        if max(h, w) > max_dim:
            scale = max_dim / max(h, w)
            gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        cascade_path = os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml')
        face_cascade = cv2.CascadeClassifier(cascade_path)
        if face_cascade.empty(): return None
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        if len(faces) == 0: return None
        best_face = max(faces, key=lambda f: f[2] * f[3])
        x, y, fw, fh = best_face
        if scale != 1.0:
            x, y, fw, fh = int(x / scale), int(y / scale), int(fw / scale), int(fh / scale)
        return (x, y, x + fw, y + fh)
    except Exception as e:
        print(f"[OCR-ID] erro ao detectar face com haarcascade: {e}")
        return None


def _preprocess_for_ocr(crop: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop.copy()
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    h, w = gray.shape[:2]
    upscaled = cv2.resize(gray, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)
    kernel_sharpen = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    sharp = cv2.filter2D(upscaled, -1, kernel_sharpen)
    return sharp


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
    candidates = re.findall(r"\d{3,5}", text or "")
    unique: List[str] = []
    seen = set()
    for item in candidates:
        if 3 <= len(item) <= 5 and item not in seen:
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
        "fields": {
            "nome": None,
            "curso": None,
            "instituicao": None,
            "data": None,
            "tipo": None,
            "numero": None
        }
    }


def _enriched_ocr_result(number: str, confidence: float) -> Dict[str, Any]:
    return {
        "ocr_text": number,
        "ocr_confidence": round(confidence, 4),
        "ocr_confidence_pct": int(round(confidence * 100)),
        "ocr_type": "id_card",
        "ocr_label": "Ficha numérica",
        "ocr_enriched": True,
        "fields": {
            "nome": None,
            "curso": None,
            "instituicao": None,
            "data": None,
            "tipo": None,
            "numero": number
        }
    }


def _id_card_candidate_rank(candidate: Dict[str, Any]) -> Tuple[float, float, float, float]:
    number = str(candidate.get("numbers", ""))
    length = len(number)
    confidence = float(candidate.get("confidence", 0.0))
    source = str(candidate.get("source", ""))
    psm = str(candidate.get("psm", ""))
    region = str(candidate.get("region", ""))

    if source == "number_box":
        length_bonus = {5: 0.11, 4: 0.02, 3: -0.02, 6: -0.18}.get(length, -0.25)
    else:
        length_bonus = {4: 0.08, 5: 0.03, 3: 0.02, 6: -0.16}.get(length, -0.25)
    source_bonus = 0.08 if source == "number_box" else 0.04 if source == "segmented" else 0.0
    region_bonus = 0.03 if region == "middle_right_box" else 0.0
    psm_bonus = 0.05 if psm == "13" else 0.0
    noise_penalty = 0.04 if source == "line_fallback" and length >= 5 else 0.0
    rank = confidence + length_bonus + source_bonus + region_bonus + psm_bonus - noise_penalty
    return (rank, 1.0 if length == 4 else 0.0, confidence, -float(length))


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


def _digits_as_foreground(binary: np.ndarray) -> np.ndarray:
    h, w = binary.shape[:2]
    if h == 0 or w == 0:
        return binary
    border = np.concatenate([
        binary[0, :],
        binary[-1, :],
        binary[:, 0],
        binary[:, -1],
    ])
    return 255 - binary if float(np.mean(border)) > 127.0 else binary


def _split_blob_by_erosion(blob_crop: np.ndarray, x_offset: int, y_offset: int) -> List[Tuple[int, int, int, int, np.ndarray]]:
    h, w = blob_crop.shape
    for k in (1, 2):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k + 1, k + 1))
        eroded = cv2.erode(blob_crop, kernel, iterations=1)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(eroded, connectivity=8)
        if num_labels - 1 < 2:
            continue
        comps = []
        for i in range(1, num_labels):
            x = stats[i, cv2.CC_STAT_LEFT]
            y = stats[i, cv2.CC_STAT_TOP]
            bw = stats[i, cv2.CC_STAT_WIDTH]
            bh = stats[i, cv2.CC_STAT_HEIGHT]
            if bh >= h * 0.4 and bw >= 4:
                comps.append((x_offset + x, y_offset + y, bw, bh, blob_crop[y:y + bh, x:x + bw]))
        if len(comps) >= 2:
            print(f"[OCR-ID] split por erosao: {len(comps)} componentes")
            return comps
    return []


def _split_blob_by_projection(blob_crop: np.ndarray, x_offset: int, y_offset: int) -> List[Tuple[int, int, int, int, np.ndarray]]:
    h, w = blob_crop.shape
    if w < 10:
        return []
    projection = np.sum(blob_crop == 255, axis=0).astype(np.float32)
    kernel = np.ones(5) / 5
    proj_smooth = np.convolve(projection, kernel, mode="same")
    start = int(w * 0.15)
    end = int(w * 0.85)
    if end <= start:
        return []
    valley = np.argmin(proj_smooth[start:end]) + start
    valley_depth = proj_smooth[valley]
    left_region = proj_smooth[max(0, valley - int(w * 0.2)):valley] if valley > 0 else np.array([valley_depth])
    right_region = proj_smooth[valley:min(w, valley + int(w * 0.2))] if valley < w - 1 else np.array([valley_depth])
    left_peak = float(np.max(left_region))
    right_peak = float(np.max(right_region))
    if left_peak > valley_depth * 1.25 and right_peak > valley_depth * 1.25:
        left_w = valley
        right_w = w - valley
        if left_w >= 4 and right_w >= 4:
            return [
                (x_offset, y_offset, left_w, h, blob_crop[:, :valley]),
                (x_offset + valley, y_offset, right_w, h, blob_crop[:, valley:]),
            ]
    return []


def _try_split_blob(blob_crop: np.ndarray, x_offset: int, y_offset: int) -> List[Tuple[int, int, int, int, np.ndarray]]:
    result = _split_blob_by_projection(blob_crop, x_offset, y_offset)
    if result:
        print(f"[OCR-ID] split por projecao vertical")
        return result
    result = _split_blob_by_erosion(blob_crop, x_offset, y_offset)
    if result:
        print(f"[OCR-ID] vale vertical encontrado")
        return result
    return []


def _segment_digits_in_plate(binary: np.ndarray, min_height_ratio: float = 0.3) -> List[Tuple[int, int, int, int, np.ndarray]]:
    h, w = binary.shape
    if h < 10 or w < 10:
        return []
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    raw: List[Tuple[int, int, int, int, int, np.ndarray]] = []
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
        if bw < 3 or bh < 6:
            continue
        if area < 25:
            continue
        if x < 2 or (x + bw) > w - 2:
            continue
        touches_vertical_border = y < 2 or (y + bh) > h - 2
        too_large_for_digit = bw > w * 0.40 or bh > h * 0.88
        if touches_vertical_border and too_large_for_digit:
            continue
        raw.append((x, y, bw, bh, area, binary[y:y + bh, x:x + bw]))
    raw.sort(key=lambda b: b[0])
    widths = [b[2] for b in raw]
    median_w = float(np.median(widths)) if widths else 0
    final: List[Tuple[int, int, int, int, np.ndarray]] = []
    for x, y, bw, bh, area, crop in raw:
        aspect = bw / max(bh, 1)
        is_wide = aspect > 1.6 or (bw > median_w * 1.5 and len(raw) < 5)
        if not is_wide:
            final.append((x, y, bw, bh, crop))
        else:
            sub = _try_split_blob(crop, x, y)
            if sub:
                print(f"[OCR-ID] blob composto detectado ({bw}x{bh}), dividido em {len(sub)} partes")
                final.extend(sub)
            else:
                final.append((x, y, bw, bh, crop))
    final.sort(key=lambda b: b[0])
    return final


def _ocr_single_digit(digit_crop: np.ndarray) -> Optional[str]:
    if digit_crop.size == 0:
        return None
    h, w = digit_crop.shape[:2]
    padded = cv2.copyMakeBorder(digit_crop, 8, 8, 8, 8, cv2.BORDER_REPLICATE)
    if max(h, w) < 100:
        scale = 140.0 / max(h, w)
        padded = cv2.resize(padded, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    variants = [padded]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    dilated = cv2.dilate(padded, kernel, iterations=1)
    variants.append(dilated)
    for img in variants:
        for psm in ("10", "13"):
            config = f"--oem 3 --psm {psm} -c tessedit_char_whitelist=0123456789"
            text = _run_tesseract(img, config)
            clean = re.sub(r"\D", "", (text or "").strip())
            if len(clean) == 1:
                return clean
    return None


def _ocr_blob_line(blob_crop: np.ndarray) -> Optional[str]:
    h, w = blob_crop.shape[:2]
    for attempt in (0, 1):
        img = blob_crop.copy()
        if attempt == 1:
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
            img = cv2.dilate(img, kernel, iterations=1)
        ih, iw = img.shape[:2]
        padded = cv2.copyMakeBorder(img, 6, 6, 6, 6, cv2.BORDER_REPLICATE)
        if max(ih, iw) < 120:
            scale = 160.0 / max(ih, iw)
            padded = cv2.resize(padded, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        config = "--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789"
        text = _run_tesseract(padded, config)
        clean = re.sub(r"\D", "", (text or "").strip())
        if 2 <= len(clean) <= 3:
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
        ("adaptive_31_12", lambda g: cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 12)),
        ("adaptive_21_8", lambda g: cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, 8)),
        ("adaptive_15_3", lambda g: cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 3)),
    ]

    best_digits: Optional[List[str]] = None
    best_conf = 0.0

    for var_name, thresh_fn in prep_variants:
        if time.time() - start > MAX_OCR_SECONDS - OCR_FALLBACK_RESERVE_SECONDS:
            print("[OCR-ID] timeout segmentacao, preservando fallback de linha")
            break
        binary = thresh_fn(gray)
        binary = _digits_as_foreground(binary)
        kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 5))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel_h)
        binary = _remove_small_components(binary, 20)

        _save_debug_plate(local_path, f"debug_threshold_{crop_idx}_{var_name}.jpg", binary)

        blobs = _segment_digits_in_plate(binary)
        print(f"[OCR-ID] blobs encontrados: {len(blobs)}")
        if len(blobs) < 3 or len(blobs) > 6:
            print("[OCR-ID] nenhum blob válido encontrado")
            _save_debug_plate(local_path, f"debug_blobs_{crop_idx}_{var_name}.jpg", binary)
            continue

        print(f"[OCR-ID] projection histogram calculado")
        digits: List[str] = []
        for bi, (bx, by, bw, bh, digit_crop) in enumerate(blobs, 1):
            if time.time() - start > MAX_OCR_SECONDS - OCR_FALLBACK_RESERVE_SECONDS:
                print("[OCR-ID] timeout segmentacao, preservando fallback de linha")
                break
            print(f"[OCR-ID] processando blob {bi}/{len(blobs)}")
            print(f"[OCR-ID] blob {bi} bbox: {bx},{by},{bw},{bh}")
            _save_debug_plate(local_path, f"debug_blob_{crop_idx}_{var_name}_{bi}.jpg", digit_crop)
            try:
                d = _ocr_single_digit(digit_crop)
                if d is None:
                    d = _ocr_blob_line(digit_crop)
            except Exception as e:
                print(f"[OCR-ID] blob {bi} erro protegido: {e}")
                continue
            if d is None:
                print(f"[OCR-ID] blob {bi} OCR: falhou")
                continue
            print(f"[OCR-ID] blob {bi} OCR: {d}")
            digits.extend(list(d))

        if len(digits) < 3 or len(digits) > 5:
            continue

        number = "".join(digits)
        if not re.match(r"^\d{3,5}$", number):
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
            "source": "segmented",
            "psm": "blob",
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
    print(f"[preview-ocr] raw_text={text}")
    clean = re.sub(r"\D", "", (text or "").strip())
    if not re.match(r"^\d{3,5}$", clean):
        return
    score = min(0.97, 0.54 + _digit_length_score(clean) * 0.18)
    if score >= 0.75:
        candidates.append({
            "numbers": clean,
            "confidence": round(score, 4),
            "score": round(score, 4),
            "source": "crop_fallback",
            "psm": "7",
        })


def _ocr_plate_number_box_fallback(plate_bgr: np.ndarray, plate_score: float, start: float, candidates: List[Dict[str, Any]]) -> None:
    if time.time() - start > MAX_OCR_SECONDS:
        return
    try:
        h, w = plate_bgr.shape[:2]
        aspect = w / max(h, 1)
        if aspect > 2.05:
            print("[OCR-ID] fallback caixa numero: placa larga, usando subcrop direito")
            mid_x = int(w * 0.35)
            plate_bgr = plate_bgr[:, mid_x:]
            h, w = plate_bgr.shape[:2]
        regions = [
            ("top_right_box", (int(w * 0.58), 0, w, int(h * 0.36))),
            ("upper_right_wide", (int(w * 0.45), 0, w, int(h * 0.42))),
            ("middle_right_box", (int(w * 0.58), int(h * 0.12), w, int(h * 0.52))),
            ("top_band", (int(w * 0.25), 0, w, int(h * 0.30))),
        ]
        for region_name, (x1, y1, x2, y2) in regions:
            if time.time() - start > MAX_OCR_SECONDS:
                return
            roi = plate_bgr[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
            if roi.size == 0:
                continue
            gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            if max(gray.shape[:2]) < 420:
                scale = 520.0 / max(gray.shape[:2])
                gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
            gray = clahe.apply(gray)
            variants = [
                ("gray", gray),
                ("otsu", cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]),
                ("otsu_inv", cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]),
                ("adaptive", cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 7)),
            ]
            for variant_name, img in variants:
                for psm in ("7", "6", "13"):
                    if time.time() - start > MAX_OCR_SECONDS:
                        return
                    text = _run_tesseract(img, f"--oem 3 --psm {psm} -c tessedit_char_whitelist=0123456789")
                    clean = re.sub(r"\D", "", (text or "").strip())
                    print(f"[OCR-ID] fallback caixa numero {region_name}/{variant_name}/psm{psm}: {clean or 'falhou'}")
                    if not re.match(r"^\d{3,6}$", clean):
                        continue
                    score = min(0.96, 0.60 + _digit_length_score(clean) * 0.18 + plate_score * 0.12)
                    if score >= 0.72:
                        candidates.append({
                            "numbers": clean,
                            "confidence": round(score, 4),
                            "score": round(score, 4),
                            "source": "number_box",
                            "psm": psm,
                            "variant": variant_name,
                            "region": region_name,
                        })
    except Exception as e:
        print(f"[OCR-ID] fallback caixa numero erro protegido: {e}")


def _ocr_plate_line_fallback(plate_bgr: np.ndarray, plate_score: float, start: float, candidates: List[Dict[str, Any]]) -> None:
    if time.time() - start > MAX_OCR_SECONDS:
        return
    try:
        padded = _add_plate_padding(plate_bgr, 12)
        gray = cv2.cvtColor(padded, cv2.COLOR_BGR2GRAY)
        if max(gray.shape[:2]) < 700:
            scale = 900.0 / max(gray.shape[:2])
            gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)
        variants = [
            ("gray", gray),
            ("otsu", cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]),
            ("adaptive", cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 8)),
        ]
        for var_name, img in variants:
            for psm in ("7", "6", "13"):
                if time.time() - start > MAX_OCR_SECONDS:
                    return
                text = _run_tesseract(img, f"--oem 3 --psm {psm} -c tessedit_char_whitelist=0123456789")
                clean = re.sub(r"\D", "", (text or "").strip())
                print(f"[OCR-ID] fallback linha {var_name}/psm{psm}: {clean or 'falhou'}")
                if not re.match(r"^\d{3,6}$", clean):
                    continue
                score = min(0.94, 0.54 + _digit_length_score(clean) * 0.18 + plate_score * 0.12)
                if score >= 0.70:
                    candidates.append({
                        "numbers": clean,
                        "confidence": round(score, 4),
                        "score": round(score, 4),
                        "source": "line_fallback",
                        "psm": psm,
                        "variant": var_name,
                    })
    except Exception as e:
        print(f"[OCR-ID] fallback linha erro protegido: {e}")


def _ocr_plate_subregions(plate_bgr: np.ndarray, plate_score: float, local_path: str, crop_idx: int) -> List[Dict[str, Any]]:
    """
    Cria subcrops da placa detectada e tenta OCR em cada região.
    EasyOCR como primário, Tesseract como fallback.
    """
    results = []
    h, w = plate_bgr.shape[:2]
    if h < 10 or w < 10:
        return results

    sub_regions = [
        ("plate_full", 0, 0, w, h),
        ("plate_center", int(w * 0.15), int(h * 0.20), int(w * 0.85), int(h * 0.80)),
        ("plate_right", int(w * 0.35), int(h * 0.15), int(w * 0.95), int(h * 0.85)),
        ("plate_mid_band", int(w * 0.05), int(h * 0.30), int(w * 0.95), int(h * 0.75)),
    ]

    reader = get_easyocr_reader()

    for region_name, rx1, ry1, rx2, ry2 in sub_regions:
        if rx2 <= rx1 or ry2 <= ry1:
            continue
        sub = plate_bgr[ry1:ry2, rx1:rx2]
        if sub.size == 0:
            continue

        # ── EasyOCR ──
        easyocr_found = None
        easyocr_confidence = 0.0

        if reader is not None:
            try:
                results_eo = reader.readtext(sub, detail=1, paragraph=False, allowlist='0123456789')
                for bbox_eo, text_eo, conf_eo in results_eo:
                    clean_eo = re.sub(r"\D", "", (text_eo or "").strip())
                    if re.match(r"^\d{3,5}$", clean_eo):
                        score_eo = min(0.99, conf_eo * 0.85 + _digit_length_score(clean_eo) * 0.10 + plate_score * 0.05)
                        print(f"[EasyOCR] text={clean_eo} confidence={conf_eo:.2f}")
                        if score_eo > easyocr_confidence:
                            easyocr_confidence = score_eo
                            easyocr_found = clean_eo
            except Exception as e:
                print(f"[EasyOCR] erro no subcrop {region_name}: {e}")

        if easyocr_found and easyocr_confidence >= 0.60:
            results.append({
                "numbers": easyocr_found,
                "confidence": round(easyocr_confidence, 4),
                "score": round(easyocr_confidence, 4),
                "source": "easyocr",
                "psm": "easyocr",
                "region": region_name,
            })
            continue

        # ── Tesseract fallback ──
        gray = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
        if max(gray.shape[:2]) < 500:
            scale = 700.0 / max(gray.shape[:2])
            gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
        enhanced = clahe.apply(gray)

        prep_variants = [
            ("otsu", cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]),
            ("otsu_inv", cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]),
            ("adaptive", cv2.adaptiveThreshold(enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 8)),
        ]

        best_number = None
        best_score = 0.0

        for vname, prep_img in prep_variants:
            for psm in ("7", "8", "13"):
                text = _run_tesseract(prep_img, f"--psm {psm} -c tessedit_char_whitelist=0123456789")
                clean = re.sub(r"\D", "", (text or "").strip())
                if clean:
                    print(f"[OCR-ID] plate_region={region_name} text={clean}")
                if re.match(r"^\d{3,5}$", clean):
                    score = min(0.97, 0.55 + _digit_length_score(clean) * 0.18 + plate_score * 0.10)
                    if score > best_score:
                        best_score = score
                        best_number = clean

        if best_number and best_score >= 0.70:
            results.append({
                "numbers": best_number,
                "confidence": round(best_score, 4),
                "score": round(best_score, 4),
                "source": "plate_subregion",
                "psm": "7_8_13",
                "region": region_name,
            })

    return results


def process_id_card_ocr(local_path: str, img: Optional[np.ndarray] = None, face_bbox: Optional[Tuple[int, int, int, int]] = None) -> Dict[str, Any]:
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
        crop_defs = []
        
        primary_face = face_bbox if face_bbox is not None else _detect_primary_face(img)
        if primary_face is not None:
            badge_region = detect_probable_badge_region(img, primary_face)
            print(f"[preview-ocr] face_bbox={primary_face}")
            print(f"[preview-ocr] badge_region={badge_region}")
            crop_defs.append(("badge_crop", badge_region))
            
        crop_defs.append(("imagem_inteira", (0, 0, w, h)))

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

            print(f"[OCR-ID] crop {idx}/{len(crop_defs)} criado ({name})")
            _save_debug_plate(local_path, f"debug_crop_{name}.jpg", crop)
            
            if name == "badge_crop":
                print(f"[preview-ocr] ocr_source=badge_crop")
                print(f"[preview-ocr] crop_used=true")
                print(f"[preview-ocr] crop_size={crop.shape[1]}x{crop.shape[0]}")
                
                preprocessed = _preprocess_for_ocr(crop)
                _save_debug_plate(local_path, f"debug_ocr_crop.jpg", preprocessed)
                
                texts = []
                texts.append(_run_tesseract(preprocessed, "--oem 3 --psm 6 -c tessedit_char_whitelist=0123456789"))
                texts.append(_run_tesseract(preprocessed, "--oem 3 --psm 11 -c tessedit_char_whitelist=0123456789"))
                
                best_cand = None
                best_score = 0.0
                
                for t in texts:
                    print(f"[preview-ocr] raw_text={t}")
                    clean = re.sub(r"\D", "", (t or "").strip())
                    candidates_in_crop = _extract_id_card_candidates(clean)
                    for cand in candidates_in_crop:
                        score = min(0.97, 0.54 + _digit_length_score(cand) * 0.18)
                        if score > best_score:
                            best_score, best_cand = score, cand
                
                if best_cand and best_score >= 0.70:
                    print(f"[preview-ocr] ocr_text={best_cand}")
                    candidates.append({"numbers": best_cand, "confidence": round(best_score, 4), "score": round(best_score, 4), "source": "badge_crop", "psm": "6_11"})
                    break 
            elif name == "imagem_inteira":
                print(f"[preview-ocr] ocr_source=imagem_inteira")
                print(f"[preview-ocr] crop_used=false")

            plate_result = _detect_plate_in_crop(crop)
            if plate_result is None:
                print(f"[OCR-ID] crop {idx}/{len(crop_defs)} sem placa detectada")
                _ocr_crop_fallback(crop, start, candidates)
                if candidates:
                    break
                continue

            px, py, pw, ph, plate_img, plate_score = plate_result
            plates_found += 1
            print(f"[OCR-ID] placa detectada em {name}")
            print(f"[OCR-ID] bbox placa: {px},{py},{pw},{ph}")
            _save_debug_plate(local_path, f"debug_plate_crop_{idx}.jpg", plate_img)

            if time.time() - start > MAX_OCR_SECONDS:
                break

            seg_result = _segmented_plate_ocr(plate_img, plate_score, start, local_path, idx)
            if seg_result:
                candidates.append(seg_result)
            _ocr_plate_number_box_fallback(plate_img, plate_score, start, candidates)
            _ocr_plate_line_fallback(plate_img, plate_score, start, candidates)
            plate_sub_results = _ocr_plate_subregions(plate_img, plate_score, local_path, idx)
            for r in plate_sub_results:
                candidates.append(r)
            if candidates:
                break

        print(f"[OCR-ID] candidatos OCR: {[c['numbers'] for c in candidates]}")
        print(f"[OCR-ID] placas detectadas: {plates_found}")

        if not candidates:
            print("[OCR-ID] sem numero detectado")
            elapsed = int((time.time() - start) * 1000)
            print(f"[OCR-ID] finalizado em {elapsed}ms")
            return _empty_ocr_result()

        candidates.sort(key=_id_card_candidate_rank, reverse=True)
        best = candidates[0]
        number = best["numbers"]
        confidence = best["confidence"]

        print(f"[OCR-ID] melhor candidato: {number}")
        print(f"[OCR-ID] selected_number={number}")
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
            "fields": {
                "nome": None,
                "curso": None,
                "instituicao": None,
                "data": None,
                "tipo": None,
                "numero": None
            }
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
        "fields": {
            "nome": None,
            "curso": None,
            "instituicao": None,
            "data": None,
            "tipo": None,
            "numero": candidate["numbers"]
        }
    }


def _classify_document_type(texts_with_conf: List[Tuple[str, float]]) -> str:
    """
    Classifica o tipo de documento com base nos textos encontrados.
    Retorna: 'completa', 'simples', ou 'pequena'
    """
    full_doc_keywords = [
        "NOME", "CURSO", "INSTITUIÇÃO", "INSTITUICAO", "ALUNO",
        "FORMATURA", "COLAÇÃO", "COLACAO", "DIPLOMA", "CERTIFICADO",
    ]

    all_upper = " ".join(t.upper() for t, _ in texts_with_conf)

    for kw in full_doc_keywords:
        if kw in all_upper:
            return "completa"

    nums = []
    for t, _ in texts_with_conf:
        clean = re.sub(r"\D", "", t)
        if re.match(r"^\d{3,5}$", clean):
            nums.append(clean)

    non_numeric = [t for t, _ in texts_with_conf if not re.match(r"^[\d\s\W]+$", t)]

    if nums and len(non_numeric) <= 1:
        return "simples"

    if len(texts_with_conf) <= 2:
        return "pequena"

    return "simples"


def _extract_fields_from_texts(texts_with_conf: List[Tuple[str, float]], img: np.ndarray) -> Dict[str, Any]:
    """
    Extrai campos estruturados dos resultados do EasyOCR.
    """
    fields = {
        "nome": None,
        "curso": None,
        "instituicao": None,
        "data": None,
        "tipo": None,
        "numero": None,
    }

    sorted_texts = sorted(texts_with_conf, key=lambda x: -x[1])
    all_text = " | ".join(t for t, _ in sorted_texts)

    # Nº OCR
    for t, _ in sorted_texts:
        clean = re.sub(r"\D", "", t)
        if re.match(r"^\d{3,5}$", clean):
            if fields["numero"] is None:
                fields["numero"] = clean

    num_prefix = re.search(r"(?:N[º°]?[.:]?\s*|N[.:]?\s*|ID[.:]?\s*|MATR[.:]?\s*)(\d{3,5})", all_text, re.IGNORECASE)
    if num_prefix:
        fields["numero"] = num_prefix.group(1)

    # Data
    date_match = re.search(r"\b(\d{2})[\s/.-](\d{2})[\s/.-](\d{4})\b", all_text)
    if date_match:
        fields["data"] = f"{date_match.group(1)}/{date_match.group(2)}/{date_match.group(3)}"

    # Tipo
    tipo_map = {
        "COLAÇÃO": "COLAÇÃO", "COLACAO": "COLAÇÃO",
        "FORMATURA": "FORMATURA",
        "GRADUAÇÃO": "GRADUAÇÃO", "GRADUACAO": "GRADUAÇÃO",
        "DIPLOMA": "DIPLOMA",
        "CERTIFICADO": "CERTIFICADO",
        "CONCLUSÃO": "CONCLUSÃO", "CONCLUSAO": "CONCLUSÃO",
    }
    upper_all = all_text.upper()
    for kw, val in tipo_map.items():
        if kw in upper_all:
            for t, _ in sorted_texts:
                if kw in t.upper():
                    fields["tipo"] = t.strip()
                    break
            break

    # Nome
    nome_match = re.search(
        r"(?:NOME|ALUNO|ESTUDANTE|CANDIDATO)\s*[:\-]?\s*(.+?)(?=\s*(?:CURSO|DATA|TURMA|INSTITUIÇÃO|INSTITUICAO|N[º°]?[.:]?\s*\d|\Z))",
        all_text, re.IGNORECASE | re.DOTALL
    )
    if nome_match:
        val = nome_match.group(1).strip().rstrip("|").strip()
        if val and len(val) > 3 and not re.match(r"^\d+$", val) and not re.match(r"^[\W_]+$", val):
            fields["nome"] = val

    # Curso
    curso_match = re.search(
        r"(?:CURSO|CURSO DE|CURSO:)\s*[:\-]?\s*(.+?)(?=\s*(?:DATA|INSTITUIÇÃO|INSTITUICAO|TURMA|ALUNO|NOME|N[º°]?[.:]?\s*\d|\Z))",
        all_text, re.IGNORECASE | re.DOTALL
    )
    if curso_match:
        val = curso_match.group(1).strip().rstrip("|").strip()
        if val and len(val) > 3 and not re.match(r"^\d+$", val):
            fields["curso"] = val

    # Instituição
    inst_match = re.search(
        r"(?:INSTITUIÇÃO|INSTITUICAO|INSTITUIÇÃO DE ENSINO|IES|UNIVERSIDADE|FACULDADE)\s*[:\-]?\s*(.+?)(?=\s*(?:CURSO|DATA|ALUNO|NOME|N[º°]?[.:]?\s*\d|\Z))",
        all_text, re.IGNORECASE | re.DOTALL
    )
    if inst_match:
        val = inst_match.group(1).strip().rstrip("|").strip()
        if val and len(val) > 3:
            fields["instituicao"] = val

    return fields


def process_hybrid_ocr(img: np.ndarray, local_path: str) -> Dict[str, Any]:
    """
    Processa OCR híbrido: classifica tipo de ficha, extrai campos.
    Retorna dict com raw_text, fields, confidence.
    """
    h, w = img.shape[:2]
    reader = get_easyocr_reader()
    result = {
        "raw_text": "",
        "fields": {
            "nome": None, "curso": None, "instituicao": None,
            "data": None, "tipo": None, "numero": None,
        },
        "confidence": 0.0,
        "doc_type": "unknown",
    }

    if reader is None:
        return result

    try:
        scale = min(1400 / max(h, w), 1.0)
        scan_img = cv2.resize(img, None, fx=scale, fy=scale) if scale < 1.0 else img

        easyocr_results = reader.readtext(scan_img, detail=1, paragraph=False)
        texts_with_conf = [(text.strip(), conf) for _, text, conf in easyocr_results]

        doc_type = _classify_document_type(texts_with_conf)
        result["doc_type"] = doc_type
        print(f"[hybrid-ocr] document_type={doc_type}")

        if doc_type == "completa":
            fields = _extract_fields_from_texts(texts_with_conf, img)
            result["fields"] = fields
            raw_parts = []
            for t, _ in texts_with_conf:
                raw_parts.append(t)
            result["raw_text"] = " | ".join(raw_parts)
            if fields["numero"]:
                result["confidence"] = 0.92
                for t, c in texts_with_conf:
                    if fields["numero"] in re.sub(r"\D", "", t):
                        result["confidence"] = min(0.97, c)
                        break
            else:
                result["confidence"] = 0.0

        elif doc_type == "simples":
            for t, conf in texts_with_conf:
                clean = re.sub(r"\D", "", t)
                if re.match(r"^\d{3,5}$", clean):
                    result["fields"]["numero"] = clean
                    result["raw_text"] = clean
                    result["confidence"] = min(0.97, conf)
                    print(f"[EasyOCR] text={clean} confidence={conf:.2f}")
                    break
            if not result["fields"]["numero"]:
                for t, conf in texts_with_conf:
                    nums = re.findall(r"\b(\d{3,5})\b", t)
                    if nums:
                        result["fields"]["numero"] = nums[0]
                        result["raw_text"] = nums[0]
                        result["confidence"] = min(0.90, conf)
                        break

        else:
            # pequena/inclinada — upsample + EasyOCR
            print("[hybrid-ocr] document_type=pequena — aplicando upscale 5x")
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            upscaled = cv2.resize(gray, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
            clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(upscaled)

            small_results = reader.readtext(enhanced, detail=1, paragraph=False, allowlist='0123456789')
            for _, text, conf in small_results:
                clean = re.sub(r"\D", "", text.strip())
                if re.match(r"^\d{3,5}$", clean):
                    result["fields"]["numero"] = clean
                    result["raw_text"] = clean
                    result["confidence"] = min(0.95, conf)
                    print(f"[EasyOCR] text={clean} confidence={conf:.2f}")
                    break

    except Exception as e:
        print(f"[hybrid-ocr] error={e}")

    if result["fields"]["numero"]:
        print(f"[EasyOCR] selected_number={result['fields']['numero']}")

    return result


def process_ocr(local_path: str, face_bbox: Optional[Tuple[int, int, int, int]] = None) -> Dict[str, Any]:
    try:
        from backend_state import scanner_cancel
        if scanner_cancel.get("cancel_requested", False):
            print("[preview-ocr] Cancelamento detectado — abortando OCR")
            return {"ocr_text": "", "ocr_confidence": 0.0, "ocr_confidence_pct": 0, "ocr_score": 0.0, "ocr_type": "cancelled", "ocr_label": "OCR cancelado", "ocr_raw": "", "regions_found": 0, "candidates": 0, "error": "OCR cancelado pelo usuario", "ocr_available": True, "fields": {"nome": None, "curso": None, "instituicao": None, "data": None, "tipo": None, "numero": None}}
    except Exception:
        pass
    print(f"[preview-ocr] engine=Tesseract")
    print(f"[preview-ocr] image_path={local_path}")
    if not is_tesseract_available():
        log_tesseract_unavailable_once(logger.info)
        status = get_tesseract_status()
        print("[preview-ocr] error=Tesseract não instalado ou fora do PATH")
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
            "fields": {
                "nome": None,
                "curso": None,
                "instituicao": None,
                "data": None,
                "tipo": None,
                "numero": None
            }
        }

    img = _load_image(local_path)
    if img is None:
        print("[preview-ocr] error=falha_carregar_imagem")
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
            "fields": {
                "nome": None,
                "curso": None,
                "instituicao": None,
                "data": None,
                "tipo": None,
                "numero": None
            }
        }

    id_card_result = process_id_card_ocr(local_path, img, face_bbox)
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
            "fields": {
                "nome": None,
                "curso": None,
                "instituicao": None,
                "data": None,
                "tipo": None,
                "numero": None
            }
        }
        _save_debug_artifacts(local_path, img, [], None, result)
        return result

    all_candidates.sort(key=lambda item: (item.get("score", 0.0), len(item.get("numbers", ""))), reverse=True)
    best = all_candidates[0]
    result = _result_from_candidate(best, len(regions), len(all_candidates), get_tesseract_status())
    _save_debug_artifacts(local_path, img, all_candidates, best, result)
    return result


def _save_doc_debug_image(img: np.ndarray, local_path: str, suffix: str) -> None:
    try:
        debug_dir = Path(os.path.dirname(local_path)) / ".preview_ocr_debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        out_path = debug_dir / f"{Path(local_path).stem}_{suffix}.jpg"
        cv2.imwrite(str(out_path), img)
    except Exception:
        pass


def extract_document_id_number(text: str) -> Optional[str]:
    if not text:
        return None

    text_stripped = text.strip()

    # Skip date patterns: dd/mm/yyyy, dd-mm-yyyy, etc.
    if re.match(r'^\d{2}[/\-.\s]\d{2}[/\-.\s]\d{2,4}$', text_stripped):
        return None
    # Skip date pattern like 12/05/1998 anywhere
    if re.search(r'\b\d{2}[/\-.]\d{2}[/\-.]\d{4}\b', text_stripped):
        return None

    # Priority 1: Nº/N°/ID/COD/CODIGO prefix
    prefix_pattern = re.compile(r'(?:N[º°o]?|ID|COD|CÓDIGO)\s*[:\-]?\s*(\d{3,6})', re.IGNORECASE)
    match = prefix_pattern.search(text_stripped)
    if match:
        num = match.group(1)
        if 3 <= len(num) <= 6:
            return num

    # Fallback: extract all 3-6 digit numbers
    clean = re.sub(r'[./\-]', ' ', text_stripped)
    numbers = re.findall(r'\b(\d{3,6})\b', clean)

    if not numbers:
        return None

    # Filter: skip numbers that look like parts of phone, CEP, CPF, RG
    has_phone = bool(re.search(r'\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}', text_stripped))
    has_cep = bool(re.search(r'\b\d{5}-?\d{3}\b', text_stripped))
    has_cpf = bool(re.search(r'\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b', text_stripped))
    has_rg = bool(re.search(r'\b\d{1,2}\.?\d{3}\.?\d{3}[-]?\d{1}\b', text_stripped))

    # Detect phone local part pattern: XXXX-XXXX or XXXXX-XXXX
    phone_local_parts: set = set()
    phone_local_m = re.search(r'\b(\d{4,5})[-.\s](\d{4})\b', text_stripped)
    if phone_local_m:
        phone_local_parts.add(phone_local_m.group(1))
        phone_local_parts.add(phone_local_m.group(2))

    valid = []
    for n in numbers:
        if len(n) < 3:
            continue
        if has_phone and 9 <= len(n) <= 11:
            continue
        if n in phone_local_parts:
            continue
        if has_cep and len(n) in (5, 8):
            continue
        if has_cpf and len(n) == 11:
            continue
        if has_rg and len(n) in (8, 9):
            continue
        valid.append(n)

    if not valid:
        return None

    # Sort: prefer 4-6 digits over 3, then longer, then first occurrence
    valid.sort(key=lambda n: (0 if len(n) >= 4 else 1, -len(n)))
    return valid[0]


def extract_simple_badge_number(text: str) -> Optional[str]:
    if not text:
        return None
    text_stripped = text.strip()
    if re.match(r'^\d{2}[/\-.\s]\d{2}[/\-.\s]\d{2,4}$', text_stripped):
        return None
    if re.search(r'\b\d{2}[/\-.]\d{2}[/\-.]\d{4}\b', text_stripped):
        return None
    prefix_pattern = re.compile(r'(?:N[º°o]?|ID|COD|CÓDIGO)\s*[:\-]?\s*(\d{3,5})', re.IGNORECASE)
    match = prefix_pattern.search(text_stripped)
    if match:
        num = match.group(1)
        if 3 <= len(num) <= 5:
            return num
    clean = re.sub(r'[./\-]', ' ', text_stripped)
    numbers = re.findall(r'\b(\d{3,5})\b', clean)
    if not numbers:
        return None
    has_phone = bool(re.search(r'\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}', text_stripped))
    has_cep = bool(re.search(r'\b\d{5}-?\d{3}\b', text_stripped))
    has_cpf = bool(re.search(r'\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b', text_stripped))
    has_rg = bool(re.search(r'\b\d{1,2}\.?\d{3}\.?\d{3}[-]?\d{1}\b', text_stripped))
    phone_local_parts: set = set()
    phone_local_m = re.search(r'\b(\d{4,5})[-.\s](\d{4})\b', text_stripped)
    if phone_local_m:
        phone_local_parts.add(phone_local_m.group(1))
        phone_local_parts.add(phone_local_m.group(2))
    valid = []
    for n in numbers:
        if len(n) < 3:
            continue
        if has_phone and 9 <= len(n) <= 11:
            continue
        if n in phone_local_parts:
            continue
        if has_cep and len(n) in (5, 8):
            continue
        if has_cpf and len(n) == 11:
            continue
        if has_rg and len(n) in (8, 9):
            continue
        valid.append(n)
    if not valid:
        return None
    valid.sort(key=lambda n: (0 if len(n) >= 4 else 1, -len(n)))
    return valid[0]


def extract_document_number(text: str) -> Optional[str]:
    if not text:
        return None
    text_stripped = text.strip()
    if re.match(r'^\d{2}[/\-.\s]\d{2}[/\-.\s]\d{2,4}$', text_stripped):
        return None
    if re.search(r'\b\d{2}[/\-.]\d{2}[/\-.]\d{4}\b', text_stripped):
        return None

    # Priority 1: Nº/N°/ID/COD/CODIGO prefix (4-6 digits only)
    prefix_pattern = re.compile(r'(?:N[º°o]?|ID|COD|CÓDIGO)\s*[:\-]?\s*(\d{4,6})', re.IGNORECASE)
    match = prefix_pattern.search(text_stripped)
    if match:
        num = match.group(1)
        if 4 <= len(num) <= 6:
            return num

    # Fallback: extract all 4-6 digit numbers only
    clean = re.sub(r'[./\-]', ' ', text_stripped)
    numbers = re.findall(r'\b(\d{4,6})\b', clean)
    if not numbers:
        return None

    has_phone = bool(re.search(r'\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}', text_stripped))
    has_cep = bool(re.search(r'\b\d{5}-?\d{3}\b', text_stripped))
    has_cpf = bool(re.search(r'\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b', text_stripped))
    has_rg = bool(re.search(r'\b\d{1,2}\.?\d{3}\.?\d{3}[-]?\d{1}\b', text_stripped))
    phone_local_parts: set = set()
    phone_local_m = re.search(r'\b(\d{4,5})[-.\s](\d{4})\b', text_stripped)
    if phone_local_m:
        phone_local_parts.add(phone_local_m.group(1))
        phone_local_parts.add(phone_local_m.group(2))

    valid = []
    for n in numbers:
        if len(n) < 4:
            continue
        if has_phone and 9 <= len(n) <= 11:
            continue
        if n in phone_local_parts:
            continue
        if has_cep and len(n) in (5, 8):
            continue
        if has_cpf and len(n) == 11:
            continue
        if has_rg and len(n) in (8, 9):
            continue
        valid.append(n)

    if not valid:
        return None

    valid.sort(key=lambda n: (0 if len(n) >= 4 else 1, -len(n)))
    return valid[0]


def _detect_document_bbox(img: np.ndarray, face_bbox: Optional[Tuple[int, int, int, int]]) -> Optional[Tuple[int, int, int, int]]:
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    best_bbox = None
    best_score = 0.0

    # Strategy 1: Threshold-based (white rectangle detection)
    for thresh_img in [
        cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
        cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 2),
    ]:
        if np.mean(thresh_img) < 127:
            thresh_img = 255 - thresh_img

        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25))
        closed = cv2.morphologyEx(thresh_img, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            x, y, cw, ch = cv2.boundingRect(cnt)
            area = cw * ch
            img_area = h * w
            if area < img_area * 0.10 or area < best_score:
                continue
            if cw < w * 0.25 or ch < h * 0.20:
                continue
            aspect = cw / max(ch, 1)
            if aspect < 0.4 or aspect > 4.0:
                continue
            best_bbox = (x, y, x + cw, y + ch)
            best_score = area

    # Strategy 2: Edge-based (Canny + largest contour)
    if best_bbox is None:
        edges = cv2.Canny(blur, 30, 100)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
        dilated = cv2.dilate(edges, kernel, iterations=3)
        contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
            x, y, cw, ch = cv2.boundingRect(cnt)
            area = cw * ch
            img_area = h * w
            if area < img_area * 0.10:
                continue
            if cw < w * 0.25 or ch < h * 0.20:
                continue
            aspect = cw / max(ch, 1)
            if aspect < 0.4 or aspect > 4.0:
                continue
            best_bbox = (x, y, x + cw, y + ch)
            break

    # Fallback: use face_bbox to estimate document region
    if best_bbox is None and face_bbox:
        fx1, fy1, fx2, fy2 = face_bbox
        fw = fx2 - fx1
        fh = fy2 - fy1
        doc_x1 = max(0, fx1 - int(fw * 1.5))
        doc_x2 = min(w, fx2 + int(fw * 1.5))
        doc_y1 = max(0, fy1 - int(fh * 0.3))
        doc_y2 = min(h, fy2 + int(fh * 3.0))
        best_bbox = (doc_x1, doc_y1, doc_x2, doc_y2)

    return best_bbox


def _generate_doc_number_regions(doc_img: np.ndarray) -> List[Tuple[str, Tuple[int, int, int, int]]]:
    h, w = doc_img.shape[:2]
    regions: List[Tuple[str, Tuple[int, int, int, int]]] = [
        ("top_right", (int(w * 0.55), 0, w, int(h * 0.30))),
        ("top_band", (int(w * 0.10), 0, int(w * 0.90), int(h * 0.25))),
        ("right_half", (int(w * 0.50), 0, w, h)),
        ("center_right", (int(w * 0.55), int(h * 0.20), w, int(h * 0.70))),
    ]

    # Detect high-contrast horizontal bands (potential number/label regions)
    gray = cv2.cvtColor(doc_img, cv2.COLOR_BGR2GRAY)
    sobelx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    sobelx = cv2.convertScaleAbs(sobelx)
    _, edge_thresh = cv2.threshold(sobelx, 40, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (40, 5))
    morphed = cv2.morphologyEx(edge_thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(morphed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes = []
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        area = bw * bh
        img_area = w * h
        if area < img_area * 0.008:
            continue
        if bw < w * 0.06 or bh < h * 0.015:
            continue
        if bw > w * 0.55 or bh > h * 0.18:
            continue
        aspect = bw / max(bh, 1)
        if aspect < 2.0 or aspect > 25:
            continue
        cx = x + bw / 2
        if cx < w * 0.35:
            continue
        boxes.append((x, y, bw, bh))

    # Sort by vertical position (top to bottom)
    boxes.sort(key=lambda b: b[1])
    for i, (bx, by, bw, bh) in enumerate(boxes[:3]):
        pad_x = int(bw * 0.08)
        pad_y = int(bh * 0.12)
        ex1 = max(0, bx - pad_x)
        ey1 = max(0, by - pad_y)
        ex2 = min(w, bx + bw + pad_x)
        ey2 = min(h, by + bh + pad_y)
        regions.append((f"high_contrast_boxes", (ex1, ey1, ex2, ey2)))

    return regions


def detect_document_number_region(
    img: np.ndarray,
    local_path: str,
    face_bbox: Optional[Tuple[int, int, int, int]] = None,
) -> Optional[Dict[str, Any]]:
    start = time.time()
    h, w = img.shape[:2]

    doc_bbox = _detect_document_bbox(img, face_bbox)
    if doc_bbox is None:
        doc_bbox = (0, 0, w, h)
    print(f"[doc-ocr] document_bbox={doc_bbox}")

    dx1, dy1, dx2, dy2 = doc_bbox
    doc_crop = img[dy1:dy2, dx1:dx2]
    if doc_crop.size == 0:
        return None

    dh, dw = doc_crop.shape[:2]
    scale = 3.0 if max(dh, dw) < 1200 else 2.0
    doc_upscaled = cv2.resize(doc_crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    try:
        _save_doc_debug_image(doc_upscaled, local_path, "document_crop")
    except Exception:
        pass

    sub_regions = _generate_doc_number_regions(doc_upscaled)
    candidates: List[Dict[str, Any]] = []
    reader = get_easyocr_reader()

    for region_name, (rx1, ry1, rx2, ry2) in sub_regions:
        if time.time() - start > MAX_OCR_SECONDS:
            break
        sub = doc_upscaled[ry1:ry2, rx1:rx2]
        if sub.size == 0:
            continue

        # EasyOCR
        if reader:
            try:
                eo_results = reader.readtext(
                    sub, detail=1, paragraph=False,
                    allowlist='0123456789Nº°IDCOD',
                )
                for bbox_eo, text, conf in eo_results:
                    text = (text or "").strip()
                    if not text:
                        continue
                    print(f"[doc-ocr] raw_text={text}")
                    num = extract_document_number(text)
                    if num:
                        candidates.append({
                            "text": text,
                            "number": num,
                            "confidence": min(0.99, float(conf) * 0.95 + 0.05),
                            "region": region_name,
                            "source": "easyocr",
                            "bbox": bbox_eo,
                            "image_shape": (doc_upscaled.shape[0], doc_upscaled.shape[1]),
                        })
                    else:
                        for short_num in re.findall(r'\b\d{3}\b', text):
                            print(f"[doc-ocr] rejected_candidate={short_num} reason=too_short_for_document")
            except Exception as e:
                print(f"[doc-ocr] easyocr error on {region_name}: {e}")

        # Tesseract fallback
        gray_sub = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
        enhanced = clahe.apply(gray_sub)
        base_conf = 0.50
        for psm in ("6", "7", "11", "13"):
            if time.time() - start > MAX_OCR_SECONDS:
                break
            text = _run_tesseract(
                enhanced,
                f"--psm {psm} -c tessedit_char_whitelist=0123456789NºIDCOD",
            )
            text = (text or "").strip()
            if not text:
                continue
            print(f"[doc-ocr] region={region_name} text={text}")
            num = extract_document_number(text)
            if num:
                candidates.append({
                    "text": text,
                    "number": num,
                    "confidence": base_conf + _digit_length_score(num) * 0.30,
                    "region": region_name,
                    "source": f"tesseract_psm{psm}",
                    "bbox": None,
                    "image_shape": (doc_upscaled.shape[0], doc_upscaled.shape[1]),
                })
            else:
                for short_num in re.findall(r'\b\d{3}\b', text):
                    print(f"[doc-ocr] rejected_candidate={short_num} reason=too_short_for_document")

    if not candidates:
        print(f"[doc-ocr] selected_number=null")
        return None

    print(f"[doc-ocr] candidates={[c['number'] for c in candidates]}")

    best = _select_best_doc_candidate(candidates)
    if best is None:
        print(f"[doc-ocr] selected_number=null")
        return None

    print(f"[doc-ocr] selected_number={best['number']}")
    return {
        "number": best["number"],
        "confidence": round(float(best.get("_score", best["confidence"])), 4),
        "raw_text": best["text"],
        "region": best["region"],
    }


def score_document_candidate(candidate: Dict[str, Any]) -> float:
    number = candidate["number"]
    confidence = float(candidate["confidence"])
    region = candidate.get("region", "")
    text = candidate.get("text", "")
    bbox = candidate.get("bbox")
    img_h, img_w = candidate.get("image_shape", (1, 1))

    score = confidence
    num_len = len(number)

    # bonus_length: +0.35 for 4+ digits
    if num_len >= 4:
        score += 0.35

    # bonus_document_pattern: +0.40 if near Nº/N°/ID/COD/CODIGO
    escaped = re.escape(number)
    if re.search(rf'(?:N[º°o]?|ID|COD|CÓDIGO)\s*[:\-]?\s*{escaped}', text, re.IGNORECASE):
        score += 0.40

    # bonus_position: +0.15 for top-right region
    if region == "top_right":
        score += 0.15

    # bonus_box_size: +0.10 if bbox is large
    if bbox and img_w > 0 and img_h > 0:
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        bw = max(xs) - min(xs)
        bh = max(ys) - min(ys)
        bbox_area = bw * bh
        img_area = img_w * img_h
        area_ratio = bbox_area / img_area
        if area_ratio > 0.03:
            score += 0.10
        elif area_ratio < 0.005 and confidence > 0.7:
            score -= 0.25

    # penalty_short_number: -0.60 for 3 digits
    if num_len == 3:
        score -= 0.60

    # penalty_isolated_noise: -0.20 if only digits, no label context
    if not re.search(r'[A-Za-zº°]', text):
        score -= 0.20

    # penalty_noise: -0.40 for obvious noise patterns
    if re.match(r'^(\d)\1{2,}$', number):
        score -= 0.40
    if number.count('0') >= len(number) * 0.5:
        score -= 0.30

    return score


def _select_best_doc_candidate(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    scored = []
    for c in candidates:
        score = score_document_candidate(c)
        c["_score"] = score
        rejected = score < 0.3
        print(f"[doc-ocr] candidate={c['number']} conf={c['confidence']:.2f} final_score={score:.2f} rejected={str(rejected).lower()}")
        scored.append(c)

    scored.sort(key=lambda x: x["_score"], reverse=True)

    if not scored:
        return None

    best = scored[0]
    best_num = best["number"]
    best_score = best["_score"]

    # 3-digit exception: only accept if unique, high conf, large bbox, or ID context
    if len(best_num) == 3:
        has_id_context = bool(re.search(r'(?:N[º°o]?|ID|COD|CÓDIGO)', best.get("text", ""), re.IGNORECASE))
        is_unique = len(scored) == 1
        if is_unique and (best["confidence"] > 0.95 or has_id_context):
            return best
        return None

    if best_score >= 0.3:
        return best

    return None


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
