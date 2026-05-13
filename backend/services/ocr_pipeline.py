import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

from services.ocr_engine import (
    get_tesseract_status,
    is_tesseract_available,
    log_tesseract_unavailable_once,
    run_tesseract_safe,
)

OCR_DEBUG_ENABLED = os.environ.get("OCR_DEBUG", os.environ.get("FORM_PRO_OCR_DEBUG", "0")) == "1"
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
