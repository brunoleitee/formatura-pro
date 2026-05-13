import os
import re
import cv2
import numpy as np
import logging
from typing import Optional, Dict, Any, List, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)


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


def _find_text_regions(img: np.ndarray) -> List[Tuple[int, int, int, int]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
    morphed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(morphed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    regions = []
    h, w = img.shape[:2]
    for cnt in contours:
        x, y, rw, rh = cv2.boundingRect(cnt)
        if rw < 30 or rh < 10 or rw > w * 0.8 or rh > h * 0.3:
            continue
        aspect = rw / max(rh, 1)
        if aspect < 1.5 or aspect > 20:
            continue
        regions.append((x, y, x + rw, y + rh))
    regions.sort(key=lambda r: r[1])
    return regions


def _crop_region(img: np.ndarray, region: Tuple[int, int, int, int]) -> np.ndarray:
    x1, y1, x2, y2 = region
    x1, y1 = max(0, x1 - 10), max(0, y1 - 5)
    x2, y2 = min(img.shape[1], x2 + 10), min(img.shape[0], y2 + 5)
    crop = img[y1:y2, x1:x2]
    return crop


def _enhance_crop(crop: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
    gray = clahe.apply(gray)
    h, w = gray.shape[:2]
    if max(h, w) < 200:
        scale = 400.0 / max(h, w)
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    sharpen = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    gray = cv2.filter2D(gray, -1, sharpen)
    _, gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return gray


def _run_tesseract(image: np.ndarray, config: str = "") -> str:
    import pytesseract
    try:
        text = pytesseract.image_to_string(image, config=config, lang="por")
        return text.strip()
    except Exception as e:
        print(f"[OCR] tesseract error: {e}")
        return ""


def _extract_numbers(text: str) -> str:
    return "".join(re.findall(r"\d+", text))


def _best_numeric_result(results: List[Dict]) -> Optional[Dict]:
    valid = [r for r in results if r.get("numbers")]
    if not valid:
        return None
    valid.sort(key=lambda r: r.get("confidence", 0), reverse=True)
    return valid[0]


def _ocr_general(image: np.ndarray) -> Dict:
    config = "--oem 3 --psm 6"
    text = _run_tesseract(image, config)
    numbers = _extract_numbers(text)
    conf = min(0.9, 0.3 + len(numbers) * 0.05) if numbers else 0.0
    return {"text": text, "numbers": numbers, "confidence": conf, "type": "general"}


def _ocr_numeric_only(image: np.ndarray) -> Dict:
    config = "--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789"
    text = _run_tesseract(image, config)
    numbers = _extract_numbers(text)
    conf = min(0.95, 0.4 + len(numbers) * 0.06) if numbers else 0.0
    return {"text": text, "numbers": numbers, "confidence": conf, "type": "numeric"}


def process_ocr(local_path: str) -> Dict[str, Any]:
    print(f"[OCR] processing: {local_path}")
    img = _load_image(local_path)
    if img is None:
        print("[OCR] failed to load image")
        return {"ocr_text": "", "ocr_confidence": 0.0, "ocr_type": "none", "regions_found": 0}

    h, w = img.shape[:2]
    print(f"[OCR] image size: {w}x{h}")

    all_results = []

    # OCR geral na imagem inteira
    full = _ocr_general(img)
    if full["numbers"]:
        all_results.append(full)

    # OCR numerico na imagem inteira
    full_num = _ocr_numeric_only(img)
    if full_num["numbers"]:
        all_results.append(full_num)

    # Detectar regioes de texto
    regions = _find_text_regions(img)
    print(f"[OCR] regions found: {len(regions)}")

    for i, region in enumerate(regions):
        crop = _crop_region(img, region)
        enhanced = _enhance_crop(crop)

        r_general = _ocr_general(enhanced)
        if r_general["numbers"]:
            r_general["region"] = i
            all_results.append(r_general)

        r_numeric = _ocr_numeric_only(enhanced)
        if r_numeric["numbers"]:
            r_numeric["region"] = i
            all_results.append(r_numeric)

    best = _best_numeric_result(all_results)
    print(f"[OCR] best result: {best}")

    result = {
        "ocr_text": best["numbers"] if best else "",
        "ocr_confidence": best["confidence"] if best else 0.0,
        "ocr_type": best["type"] if best else "none",
        "ocr_raw": best["text"] if best else "",
        "regions_found": len(regions),
        "candidates": len(all_results),
    }
    print(f"[OCR] result: numbers='{result['ocr_text']}' conf={result['ocr_confidence']:.2f}")
    return result


def cross_reference_ocr_with_face(
    ocr_text: str,
    ocr_confidence: float,
    face_student: Optional[str],
    face_confidence: Optional[float],
) -> Dict[str, Any]:
    result = {
        "final_student": face_student,
        "final_confidence": face_confidence or 0.0,
        "ocr_enriched": False,
    }

    if not ocr_text or ocr_confidence < 0.3:
        return result

    # Tentar encontrar aluno por numero OCR
    root_dir = Path(__file__).resolve().parents[1]
    catalogs_dir = root_dir / "data" / "catalogs"
    import sqlite3
    ocr_student = None
    for db_file in catalogs_dir.glob("*.db"):
        try:
            conn = sqlite3.connect(str(db_file))
            c = conn.cursor()
            c.execute("SELECT aluno_id FROM alunos WHERE aluno_id LIKE ? LIMIT 1", (f"%{ocr_text}%",))
            row = c.fetchone()
            if row:
                ocr_student = row[0]
                break
            c.execute("SELECT aluno_id FROM alunos WHERE class_name LIKE ? LIMIT 1", (f"%{ocr_text}%",))
            row = c.fetchone()
            if row:
                ocr_student = row[0]
                break
            conn.close()
        except Exception:
            pass

    if ocr_student:
        if face_student and face_student == ocr_student:
            result["final_student"] = ocr_student
            result["final_confidence"] = min(0.99, (face_confidence or 0) + ocr_confidence * 0.3)
            result["ocr_enriched"] = True
            print(f"[OCR] cruzamento FACE+OCR: {ocr_student} conf={result['final_confidence']:.2f}")
        else:
            result["ocr_student"] = ocr_student
            result["ocr_confidence"] = ocr_confidence
            result["final_confidence"] = max(result["final_confidence"], ocr_confidence * 0.7)
            print(f"[OCR] OCR sugeriu: {ocr_student} conf={ocr_confidence:.2f}")

    return result
