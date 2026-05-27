import os
import time
import urllib.parse
import re
import logging
from typing import Optional, List
import cv2
import numpy as np

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

import scan_manager as scm
import media_manager as mm
import scanner_engine as se

router = APIRouter()

IMAGE_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff",
    ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf", ".srw", ".x3f",
)


@router.get("/api/scanner/folder-tree")
def get_scanner_folder_tree(path: str = "", depth: int = 2):
    """
    Retorna a árvore de pastas otimizada para o Gerenciador de Pastas do Scanner.
    Suporta lazy load através do parâmetro 'depth'.
    """
    try:
        return mm.scanner_folder_tree(path, depth)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/scan/precheck")
def scan_precheck(req: scm.ScanRequest):
    return scm.scan_precheck(req)


@router.post("/api/scan/clear-checkpoints")
def clear_checkpoints(req: dict):
    return scm.clear_checkpoints(req)


@router.post("/api/scan/start")
def start_scan(req: scm.ScanRequest):
    from utils import _invalidate_stats_caches
    _invalidate_stats_caches()
    return scm.start_scan(req)


@router.get("/api/scan/status")
def get_scan_status():
    try:
        raw = scm.get_scan_status() or {}
        from scanner_engine import _scan_last_progress_at, _scan_last_progress_file, _scan_last_processed, _scan_stalled
        now = time.time()
        last_secs = (now - _scan_last_progress_at) if _scan_last_progress_at > 0 else None
        if _scan_stalled:
            raw["status"] = "stalled"
        elif raw.get("is_scanning"):
            raw["status"] = "running"
        elif raw.get("stopped"):
            raw["status"] = "stopped"
        elif raw.get("scan_summary"):
            raw["status"] = "done"
        else:
            raw["status"] = "idle"
        raw["last_progress_seconds"] = round(last_secs, 1) if last_secs is not None else None
        raw["current_file"] = _scan_last_progress_file or (raw.get("current_photo") or {}).get("name")
        raw["processed"] = raw.get("total_processadas", _scan_last_processed)
        raw["total"] = raw.get("total_validos", 0)
        return raw
    except Exception:
        _scan_logger = logging.getLogger(__name__)
        _scan_logger.exception("[scanner-status] failed")
        return {
            "running": False, "progress": 0, "processed": 0, "total": 0,
            "status": "recovering", "error": "temporary_failure",
        }


@router.post("/api/scan/clear_summary")
def clear_scan_summary():
    from utils import _invalidate_stats_caches
    _invalidate_stats_caches()
    return scm.clear_scan_summary()


@router.post("/api/scan/stop")
def stop_scan():
    return scm.stop_scan()


@router.post("/api/scanner/stop")
def scanner_stop():
    scm.stop_scan()
    return {"success": True}


@router.get("/api/scanner/live-status")
def scanner_live_status():
    s = scm.get_scan_status()
    now = time.time()
    started_at = s.get("started_at")
    is_scanning = bool(s.get("is_scanning", False))
    processed = int(s.get("total_processadas", 0))
    total = int(s.get("total_files", 0))
    elapsed = (now - started_at) if started_at and is_scanning else None
    eta = None
    avg_sec = None
    if elapsed is not None and elapsed > 0 and processed >= 5:
        speed = processed / elapsed
        remaining = total - processed
        if remaining > 0 and speed > 0:
            eta = round(remaining / speed, 1)
            avg_sec = round(elapsed / processed, 2)
    return {
        "running": is_scanning,
        "stopped": bool(s.get("stopped", False)),
        "processedPhotos": processed,
        "totalPhotos": total,
        "started_at": started_at,
        "elapsed_seconds": round(elapsed, 1) if elapsed is not None else None,
        "eta_seconds": eta,
        "avgSecondsPerPhoto": avg_sec,
        "is_scanning": is_scanning,
        "status_text": s.get("status_text", ""),
    }


@router.post("/api/scanner/cleanup")
def scanner_cleanup():
    return scm.force_cleanup()


@router.post("/api/scanner/unload-models")
def scanner_unload_models():
    return scm.unload_models()


@router.post("/api/scan/quality_fill")
def start_quality_audit(req: dict):
    return scm.start_quality_audit(req)


@router.post("/api/scan/start_quality_audit")
def start_quality_audit_legacy(req: dict):
    return scm.start_quality_audit(req)


@router.get("/api/scan/quality_audit_status")
def get_quality_audit_status():
    try:
        return scm.get_quality_audit_status()
    except Exception as e:
        return {
            "status": "error",
            "running": False,
            "enabled": False,
            "processed": 0,
            "total": 0,
            "progress": 0.0,
            "message": str(e),
            "is_auditing": False,
            "status_text": str(e),
        }


@router.get("/api/scanner/preview-ocr")
def scanner_preview_ocr(path: str = ""):
    """
    Preview OCR de uma única foto. Não salva no banco.
    Usa rosto detectado com InsightFace para calcular crop da ficha e rodar OCR.
    """
    from utils import log_info, _suppress_stdout
    decoded = urllib.parse.unquote(path).strip()
    if not decoded or not os.path.isfile(decoded):
        return {"ok": False, "error": "Arquivo não encontrado"}

    ext = os.path.splitext(decoded)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        return {"ok": False, "error": "Formato de imagem não suportado"}

    try:
        img = cv2.imread(decoded)
        if img is None:
            return {"ok": False, "error": "Falha ao ler imagem"}

        h, w = img.shape[:2]

        # ── 1. Detectar rosto principal com InsightFace ──
        from services.face_engine import FACE_INFERENCE_LOCK

        se.ensure_face_engine()
        app_face = se.get_app_face()
        primary_face = None

        if app_face:
            with FACE_INFERENCE_LOCK:
                with _suppress_stdout():
                    raw_faces = app_face.get(img) or []
            if raw_faces:
                raw_faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
                best = raw_faces[0]
                fx1, fy1, fx2, fy2 = map(int, best.bbox[:4])
                primary_face = (fx1, fy1, fx2, fy2)
                log_info(f"[preview-ocr] face_bbox={primary_face}")

        # ── 2. Document number region detector (fichas documentais) ──
        from services.ocr_pipeline import detect_document_number_region, process_hybrid_ocr, process_ocr

        doc_result = detect_document_number_region(img, decoded, primary_face)
        new_number = doc_result.get("number") if doc_result else None

        # Só aceita OCR novo se achou número de 4+ dígitos
        if new_number and len(new_number) >= 4:
            log_info(f"[doc-ocr] pipeline=document_detector number={new_number} confidence={doc_result['confidence']}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": doc_result.get("raw_text", new_number),
                "fields": {
                    "nome": None, "curso": None, "instituicao": None,
                    "data": None, "tipo": None, "numero": new_number,
                },
                "confidence": doc_result["confidence"],
            }

        # ── 2b. Fallback: OCR antigo confiável (process_ocr) ──
        from services.ocr_pipeline import extract_document_number

        old_result = process_ocr(decoded, primary_face)
        old_text = old_result.get("ocr_text", "") or ""
        old_number = old_result.get("fields", {}).get("numero")
        old_conf = old_result.get("ocr_confidence", 0.85) or 0.85

        log_info(f"[ocr-compare] old_text={old_text}")
        log_info(f"[ocr-compare] new_text={new_number}")

        # Validar old_number com as regras documentais (rejeitar 3 dígitos)
        if old_number:
            validated = extract_document_number(old_text) or extract_document_number(old_number)
            if validated and len(validated) >= 4:
                log_info(f"[ocr-compare] selected_source=old_ocr")
                log_info(f"[EasyOCR] selected_number={validated}")
                return {
                    "ok": True,
                    "path": decoded,
                    "raw_text": old_text,
                    "fields": {
                        "nome": None, "curso": None, "instituicao": None,
                        "data": None, "tipo": None, "numero": validated,
                    },
                    "confidence": round(float(old_conf), 4),
                }
            # Rejeitar número de 3 dígitos do OCR antigo
            log_info(f"[doc-ocr] candidate={old_number} conf={old_conf:.2f} rejected=true reason=too_short_for_document")
            log_info(f"[ocr-compare] selected_source=null (old rejected)")

        # ── 3. OCR híbrido por tipo de ficha ──
        hybrid = process_hybrid_ocr(img, decoded)

        # Se for ficha completa com nome+numero, retorna tudo
        if hybrid["doc_type"] == "completa" and hybrid["fields"].get("numero"):
            log_info(f"[preview-ocr] doc_type=completa numero={hybrid['fields']['numero']} nome={hybrid['fields'].get('nome')}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": hybrid["raw_text"],
                "fields": hybrid["fields"],
                "confidence": hybrid["confidence"],
            }

        # Se for simples com numero, retorna direto
        if hybrid["doc_type"] == "simples" and hybrid["fields"].get("numero"):
            log_info(f"[EasyOCR] selected_number={hybrid['fields']['numero']}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": hybrid["raw_text"],
                "fields": {
                    "nome": None,
                    "curso": None,
                    "instituicao": None,
                    "data": None,
                    "tipo": None,
                    "numero": hybrid["fields"]["numero"],
                },
                "confidence": hybrid["confidence"],
            }

        # ── 4. Fallback: crop facial + Tesseract ──
        from services.ocr_engine import run_tesseract_safe

        debug_dir = None
        try:
            _d = os.path.join(os.path.dirname(decoded), ".preview_ocr_debug")
            os.makedirs(_d, exist_ok=True)
            debug_dir = _d
        except Exception:
            pass
        base_name = os.path.splitext(os.path.basename(decoded))[0]

        def _preprocess_strong(crop_img: np.ndarray) -> np.ndarray:
            gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY)
            upscaled = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(upscaled)
            sharpen_kernel = np.array([[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]], dtype=np.float32)
            sharp = cv2.filter2D(clahe, -1, sharpen_kernel)
            filtered = cv2.bilateralFilter(sharp, 9, 75, 75)
            thresh = cv2.adaptiveThreshold(filtered, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 2)
            kernel = np.ones((3, 3), np.uint8)
            return cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

        def _save_debug(crop_img: np.ndarray, suffix: str):
            if debug_dir is None:
                return
            try:
                p = os.path.join(debug_dir, f"{base_name}_{suffix}.jpg")
                cv2.imwrite(p, crop_img)
            except Exception:
                pass

        def _ocr_crop_tesseract(crop_img: np.ndarray) -> list:
            if crop_img.size == 0:
                return []
            try:
                processed = _preprocess_strong(crop_img)
                candidates = []
                for psm in ("7", "8", "6"):
                    text = run_tesseract_safe(processed, f"--psm {psm} -c tessedit_char_whitelist=0123456789")
                    text = (text or "").strip()
                    log_info(f"[preview-ocr] config=psm{psm}")
                    log_info(f"[preview-ocr] text={text}")
                    nums = re.findall(r"\b(\d{3,5})\b", text)
                    for n in nums:
                        score = 0
                        if len(n) == 4:
                            score += 3
                        elif len(n) == 3:
                            score += 1
                        elif len(n) == 5:
                            score += 2
                        if text.strip() == n:
                            score += 2
                        digits = re.sub(r"\D", "", text)
                        if digits == n:
                            score += 1
                        candidates.append((n, score, psm, text))
                return candidates
            except Exception as e:
                log_info(f"[preview-ocr] crop_ocr_error={e}")
                return []

        selected_number = None
        crop_results = []

        if primary_face:
            fx1, fy1, fx2, fy2 = primary_face
            face_w = fx2 - fx1
            face_h = fy2 - fy1

            for idx, label, x1, x2, y1, y2 in (
                (1, "peito",
                 max(0, int(fx1 - face_w * 1.7)),
                 min(w, int(fx2 + face_w * 1.7)),
                 max(0, int(fy2 + face_h * 0.05)),
                 min(h, int(fy2 + face_h * 1.50))),
                (2, "peito_largo",
                 max(0, int(fx1 - face_w * 2.0)),
                 min(w, int(fx2 + face_w * 2.0)),
                 max(0, int(fy2)),
                 min(h, int(fy2 + face_h * 2.00))),
                (3, "centro_inferior",
                 int(w * 0.20), int(w * 0.80),
                 int(h * 0.45), int(h * 0.78)),
            ):
                if x2 <= x1 or y2 <= y1:
                    continue
                log_info(f"[preview-ocr] crop_{idx}_box=({x1},{y1},{x2},{y2})")
                crop_img = img[y1:y2, x1:x2]
                _save_debug(crop_img, f"crop_{idx}")
                candidates = _ocr_crop_tesseract(crop_img)
                if candidates:
                    candidates.sort(key=lambda x: (-x[1], x[2]))
                    best = candidates[0]
                    crop_results.append((best[0], idx, best[3], best[1]))
                    processed = _preprocess_strong(crop_img)
                    _save_debug(processed, f"crop_{idx}_processed")

        if crop_results:
            crop_results.sort(key=lambda x: (-x[3], x[1]))
            selected_number = crop_results[0][0]
            crop_text = crop_results[0][2]
            log_info(f"[EasyOCR] selected_number={selected_number}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": crop_text,
                "fields": {
                    "nome": None, "curso": None, "instituicao": None,
                    "data": None, "tipo": None, "numero": selected_number,
                },
                "confidence": 0.85,
            }

        # ── 5. Fallback final: OCR na imagem inteira ──
        result = process_ocr(decoded)

        if result:
            raw_text = result.get("ocr_text", "") or ""
            confidence = result.get("ocr_confidence", 0.0) or 0.0
            log_info(f"[preview-ocr] full_text={raw_text}")

            if not selected_number:
                nums = re.findall(r"\b(\d{3,5})\b", raw_text)
                if nums:
                    selected_number = nums[0]
            if selected_number:
                log_info(f"[EasyOCR] selected_number={selected_number}")

            lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
            fields = {
                "nome": lines[0] if len(lines) > 0 else None,
                "curso": lines[1] if len(lines) > 1 else None,
                "instituicao": lines[2] if len(lines) > 2 else None,
                "data": None, "tipo": None,
                "numero": selected_number,
            }
            for line in lines:
                dm = re.search(r"\b(\d{2})[\s/.-](\d{2})[\s/.-](\d{4})\b", line)
                if dm and not fields["data"]:
                    fields["data"] = f"{dm.group(1)}/{dm.group(2)}/{dm.group(3)}"
            tipo_kw = ["COLAÇÃO", "COLACAO", "FORMATURA", "GRADUAÇÃO", "GRADUACAO", "DIPLOMA", "CERTIFICADO", "CONCLUSÃO", "CONCLUSAO"]
            for line in lines:
                up = line.upper()
                for kw in tipo_kw:
                    if kw in up and not fields["tipo"]:
                        fields["tipo"] = line
                        break

            return {
                "ok": True, "path": decoded,
                "raw_text": raw_text, "fields": fields,
                "confidence": round(float(confidence), 4),
            }

        return {
            "ok": True, "path": decoded,
            "raw_text": "", "fields": {
                "nome": None, "curso": None, "instituicao": None,
                "data": None, "tipo": None, "numero": None,
            },
            "confidence": 0.0,
        }
    except Exception as e:
        log_info(f"[preview-ocr] error={e}")
        return {"ok": False, "error": str(e)}


@router.get("/api/scanner/preview-faces")
def scanner_preview_faces(path: str = ""):
    """
    Preview faces de uma única foto. Não salva no banco, não usa FAISS, não cria cluster.
    """
    from utils import log_info, _suppress_stdout
    decoded = urllib.parse.unquote(path).strip()
    if not decoded or not os.path.isfile(decoded):
        return {"ok": False, "error": "Arquivo não encontrado", "faces": []}

    ext = os.path.splitext(decoded)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        return {"ok": False, "error": "Formato de imagem não suportado", "faces": []}

    try:
        log_info(f"[preview-faces] path={decoded}")

        from services.face_engine import FACE_INFERENCE_LOCK
        from scanner_engine import _scan_last_progress_at
        now = time.time()
        scanner_active = _scan_last_progress_at > 0 and (now - _scan_last_progress_at) < 120.0

        if scanner_active:
            acquired = FACE_INFERENCE_LOCK.acquire(timeout=0.1)
            if not acquired:
                log_info("[face-lock] busy by=preview-faces skipped (scanner ativo)")
                return {"ok": False, "busy": True, "reason": "scanner_running", "faces": []}
        else:
            FACE_INFERENCE_LOCK.acquire()

        try:
            log_info(f"[face-lock] acquired by=preview-faces file={os.path.basename(decoded)}")
            img = cv2.imread(decoded)
            if img is None:
                return {"ok": False, "error": "Falha ao ler imagem", "faces": []}

            h, w = img.shape[:2]
            log_info(f"[preview-faces] img_shape={w}x{h}")

            se.ensure_face_engine()
            app_face = se.get_app_face()
            if app_face is None:
                return {"ok": False, "error": "Motor de deteccao nao disponivel", "faces": []}

            with _suppress_stdout():
                raw_faces = app_face.get(img) or []
        finally:
            FACE_INFERENCE_LOCK.release()

        log_info(f"[preview-faces] detected={len(raw_faces)}")

        result_faces = []
        for face in raw_faces:
            bbox = face.bbox.astype(float).tolist() if hasattr(face, 'bbox') else [0, 0, 0, 0]
            x1, y1, x2, y2 = map(int, bbox[:4])
            confidence = float(getattr(face, 'det_score', 0))
            area = max(0, (x2 - x1) * (y2 - y1))
            crop_url = (
                f"/api/thumb?path={urllib.parse.quote(decoded)}"
                f"&x1={x1}&y1={y1}&x2={x2}&y2={y2}&size=120&q=80"
            )
            result_faces.append({
                "bbox": [x1, y1, x2, y2],
                "confidence": round(confidence, 4),
                "area": area,
                "is_primary": False,
                "crop_url": crop_url,
            })

        result_faces.sort(key=lambda f: f["area"], reverse=True)
        if result_faces:
            result_faces[0]["is_primary"] = True

        return {
            "ok": True,
            "path": decoded,
            "faces": result_faces,
        }
    except Exception as e:
        logging.getLogger(__name__).exception("[preview-faces] failed path=%s", decoded)
        return {"ok": False, "error": str(e), "faces": []}


# ── GERADOR DE REFERÊNCIAS AUTOMATIZADAS ───────────────────────────────────

class CreateReferencesReq(BaseModel):
    id_folder: str
    catalog: Optional[str] = None


def run_create_references_worker(id_folder: str, catalog: str):
    from state import create_references_state
    import scanner_engine as se
    from services.ocr_pipeline import detect_document_number_region, process_hybrid_ocr, process_ocr
    import cv2
    import os
    import re
    from PIL import Image, ImageOps
    from services.face_engine import FACE_INFERENCE_LOCK

    create_references_state.update({
        "is_running": True,
        "progress": 0.0,
        "processed": 0,
        "total": 0,
        "status_text": "Iniciando processamento...",
        "error": None,
        "result": None,
    })

    try:
        valid_extensions = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
        all_photos = []
        for root, dirs, files in os.walk(id_folder):
            # Ignora pastas de referências geradas e subpastas de saída para evitar loop
            dirs[:] = [d for d in dirs if d.lower() not in ("#referencia", "referencia")]
            for f in files:
                if f.lower().endswith(valid_extensions):
                    all_photos.append(os.path.join(root, f))

        total_photos = len(all_photos)
        create_references_state.update({
            "total": total_photos,
            "status_text": f"Encontradas {total_photos} fotos. Processando..."
        })

        if total_photos == 0:
            create_references_state.update({
                "is_running": False,
                "progress": 1.0,
                "status_text": "Nenhuma foto encontrada no diretório informado.",
                "result": {"created_count": 0}
            })
            return

        created_count = 0
        se.ensure_face_engine()
        app_face = se.get_app_face()

        parent_dir = os.path.dirname(os.path.abspath(id_folder))

        for idx, photo_path in enumerate(all_photos, 1):
            try:
                img = cv2.imread(photo_path)
                if img is None:
                    continue

                primary_face = None
                if app_face:
                    with FACE_INFERENCE_LOCK:
                        raw_faces = app_face.get(img) or []
                    if raw_faces:
                        raw_faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
                        best = raw_faces[0]
                        fx1, fy1, fx2, fy2 = map(int, best.bbox[:4])
                        primary_face = (fx1, fy1, fx2, fy2)

                if primary_face is None:
                    continue

                student_id = None
                # 1. Document region detector
                doc_result = detect_document_number_region(img, photo_path, primary_face)
                number = doc_result.get("number") if doc_result else None
                if number and len(str(number).strip()) >= 3:
                    student_id = str(number).strip()

                # 2. Hybrid OCR
                if not student_id:
                    try:
                        hybrid = process_hybrid_ocr(img, photo_path)
                        number = hybrid["fields"].get("numero")
                        if number and len(str(number).strip()) >= 3:
                            student_id = str(number).strip()
                    except Exception:
                        pass

                # 3. Fallback old OCR
                if not student_id:
                    try:
                        old_result = process_ocr(photo_path, primary_face)
                        old_number = old_result.get("fields", {}).get("numero")
                        if old_number and len(str(old_number).strip()) >= 3:
                            student_id = str(old_number).strip()
                    except Exception:
                        pass

                # 4. Regex fallback on text
                if not student_id:
                    try:
                        full_res = process_ocr(photo_path)
                        if full_res and full_res.get("ocr_text"):
                            nums = re.findall(r"\b(\d{3,6})\b", full_res["ocr_text"])
                            if nums:
                                student_id = nums[0]
                    except Exception:
                        pass

                if student_id:
                    student_id_clean = re.sub(r'[\/:*?"<>|]', '', student_id).strip()
                    if student_id_clean:
                        rel_dir = os.path.dirname(os.path.relpath(photo_path, id_folder))
                        dest_dir = os.path.join(parent_dir, "#referencia", rel_dir)
                        os.makedirs(dest_dir, exist_ok=True)

                        pil_img = Image.open(photo_path)
                        pil_img = ImageOps.exif_transpose(pil_img)
                        w, h = pil_img.size

                        fx1, fy1, fx2, fy2 = primary_face
                        face_w = max(1, fx2 - fx1)
                        face_h = max(1, fy2 - fy1)
                        face_cx = (fx1 + fx2) / 2.0

                        # 24x30 (cm) → proporção 4:5 retrato. Crop deve ir do
                        # topo da cabeça até a base da ficha para permitir
                        # conferência visual do número.
                        TARGET_RATIO = 24.0 / 30.0  # largura / altura = 0.8

                        # Anchors verticais:
                        # - topo: ~0.55*face_h acima da face para sobrar cabelo
                        # - base: ~5.0*face_h abaixo da face para alcançar a ficha
                        head_top = fy1 - 0.55 * face_h
                        ficha_bottom = fy2 + 4.0 * face_h

                        # Clamp vertical à imagem
                        crop_top = max(0.0, head_top)
                        crop_bottom = min(float(h), ficha_bottom)
                        crop_h = max(1.0, crop_bottom - crop_top)

                        # Largura derivada do ratio, centrada no rosto
                        crop_w = crop_h * TARGET_RATIO
                        crop_left = face_cx - crop_w / 2.0
                        crop_right = face_cx + crop_w / 2.0

                        # Se a largura calculada estoura a imagem, encolhe
                        # mantendo o ratio (reduzindo a altura pela base —
                        # preferimos preservar a cabeça acima).
                        if crop_left < 0 or crop_right > w:
                            max_half = min(face_cx, w - face_cx)
                            if max_half * 2.0 < crop_w:
                                crop_w = max_half * 2.0
                                crop_h = crop_w / TARGET_RATIO
                                crop_bottom = crop_top + crop_h
                                crop_left = face_cx - crop_w / 2.0
                                crop_right = face_cx + crop_w / 2.0

                        # Se ainda assim a altura ficou maior que a imagem
                        # (face muito próxima de uma das laterais), reduz a
                        # largura também — última garantia de não estourar.
                        if crop_bottom > h:
                            crop_bottom = float(h)
                            crop_h = crop_bottom - crop_top
                            crop_w = crop_h * TARGET_RATIO
                            crop_left = face_cx - crop_w / 2.0
                            crop_right = face_cx + crop_w / 2.0

                        left = max(0, int(round(crop_left)))
                        top = max(0, int(round(crop_top)))
                        right = min(w, int(round(crop_right)))
                        bottom = min(h, int(round(crop_bottom)))

                        crop = pil_img.crop((left, top, right, bottom))
                        dest_file = os.path.join(dest_dir, f"{student_id_clean}.jpg")
                        crop.save(dest_file, "JPEG", quality=90)
                        created_count += 1

            except Exception as photo_err:
                logging.getLogger(__name__).warning(f"[create-references] Erro ao processar {photo_path}: {photo_err}")

            create_references_state.update({
                "processed": idx,
                "progress": idx / total_photos,
                "status_text": f"Processando {idx} de {total_photos} fotos. Criadas: {created_count}"
            })

        create_references_state.update({
            "is_running": False,
            "progress": 1.0,
            "status_text": f"Processamento concluído. {created_count} referências criadas na pasta '#referencia'!",
            "result": {
                "created_count": created_count,
            }
        })

    except Exception as e:
        logging.getLogger(__name__).exception("[create-references] Falha crítica")
        create_references_state.update({
            "is_running": False,
            "status_text": f"Erro: {str(e)}",
            "error": str(e),
        })


@router.post("/api/scanner/create-references")
def create_references(req: CreateReferencesReq):
    from state import create_references_state
    if create_references_state.get("is_running"):
        return {"status": "already_running", "running": True}

    id_folder = req.id_folder.strip()
    if not id_folder or not os.path.isdir(id_folder):
        raise HTTPException(status_code=400, detail="Diretório de ID inválido ou inexistente")

    catalog = req.catalog or ""
    import threading
    threading.Thread(target=run_create_references_worker, args=(id_folder, catalog), daemon=True).start()
    return {"status": "started", "running": True}


@router.get("/api/scanner/create-references/status")
def get_create_references_status():
    from state import create_references_state
    return create_references_state
