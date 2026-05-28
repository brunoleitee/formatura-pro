import os
import json
import cv2
import numpy as np
import logging
import time
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

from services.metadata_schema import GraduationMetadata


class CentralAIPipeline:
    def __init__(self, face_engine_provider=None, get_db=None, mm=None):
        self.face_engine_provider = face_engine_provider
        self.get_db = get_db
        self.mm = mm
        self._paddle_ocr = None
        self._vlm = None
        
    def _get_paddle_ocr(self):
        if self._paddle_ocr is None:
            from services.paddle_ocr_service import get_paddle_ocr
            self._paddle_ocr = get_paddle_ocr()
        return self._paddle_ocr
    
    def _run_ocr_on_image(self, img: np.ndarray) -> Tuple[str, float]:
        from services.paddle_ocr_service import run_paddle_ocr
        results = run_paddle_ocr(img)
        texts = [t for t, c, b in results]
        combined = " ".join(texts)
        conf = max([c for t, c, b in results]) if results else 0.0
        return combined, conf
    
    def _run_vlm_analysis(self, img: np.ndarray) -> Optional[Dict[str, Any]]:
        from services.qwen_vlm_service import analyze_graduation_image
        return analyze_graduation_image(img)
        
    def process_photo(self, photo_id: int, catalog: str, photo_data: Optional[Dict[str, Any]] = None) -> bool:
        """
        Executa o pipeline completo para uma única foto.
        Pipeline: InsightFace -> PaddleOCR -> Qwen2.5-VL -> Metadados -> Ranking IA
        """
        try:
            with self.get_db(catalog) as db:
                c = db.cursor()
                if photo_data is None:
                    c.execute("SELECT * FROM photos WHERE id = ?", (photo_id,))
                    photo = c.fetchone()
                    if not photo:
                        return False
                    photo = dict(photo)
                else:
                    photo = photo_data

                from services.photo_loader import load_photo_for_ai
                img_path = load_photo_for_ai(photo)

                if not img_path or not os.path.exists(img_path):
                    print(f"[CentralPipeline] caminho nao resolvido: photo_id={photo_id}")
                    return False

                print(f"[CentralPipeline] processando: {img_path}")

                img = cv2.imread(img_path)
                if img is None:
                    from PIL import Image
                    pil_img = Image.open(img_path).convert("RGB")
                    img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

                metadata = GraduationMetadata()

                # 1. Detecção e Reconhecimento de Faces (InsightFace)
                faces_found = []
                face_engine = self.face_engine_provider.get_app_face() if self.face_engine_provider else None

                if face_engine:
                    faces = face_engine.get(img)
                    for i, face in enumerate(faces):
                        x1, y1, x2, y2 = map(int, face.bbox)
                        score = float(face.det_score)
                        emb = face.embedding.astype("float32")

                        crop_filename = f"face_{photo_id}_{i}.jpg"
                        crop_path = ""
                        if self.mm:
                            thumb_dir = self.mm._get("thumb_cache_dir")
                            crop_path = os.path.join(thumb_dir, crop_filename)
                            self.mm._run_thumb_engine("face", img_path, crop_path, 200, x1=x1, y1=y1, x2=x2, y2=y2, expand=0.4)

                        c.execute("""
                            INSERT INTO faces (photo_id, crop_path, x, y, width, height, detection_score, embedding, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'detected')
                        """, (photo_id, crop_path, x1, y1, x2-x1, y2-y1, score, emb.tobytes()))

                        face_id = c.lastrowid
                        faces_found.append({"id": face_id, "score": score, "bbox": (x1, y1, x2, y2)})

                metadata.group_photo = len(faces_found) >= 3
                if len(faces_found) == 1:
                    metadata.main_subject = "face_1"
                elif len(faces_found) > 1:
                    best_face = max(faces_found, key=lambda f: f["score"])
                    idx = faces_found.index(best_face) + 1
                    metadata.main_subject = f"face_{idx}"

                # 2. PaddleOCR
                ocr_text, ocr_conf = self._run_ocr_on_image(img)
                metadata.merge_ocr(ocr_text, ocr_conf)
                if ocr_text:
                    print(f"[OCR] text detected: {ocr_text}")
                else:
                    print(f"[OCR] no text detected")

                # 3. Qwen2.5-VL (apenas para contexto seletivo)
                needs_vlm = (
                    metadata.group_photo
                    or metadata.ocr_confidence < 0.5
                    or len(faces_found) == 0
                )

                if needs_vlm:
                    print(f"[VLM] Qwen analysis started (reason: group={metadata.group_photo}, low_conf={metadata.ocr_confidence < 0.5}, no_faces={len(faces_found)==0})")
                    vlm_result = self._run_vlm_analysis(img)
                    if vlm_result:
                        metadata.merge_vlm(vlm_result)
                        if vlm_result.get("graduation_context"):
                            print(f"[VLM] graduation items detected")
                        if metadata.main_subject:
                            print(f"[VLM] probable main subject: {metadata.main_subject}")
                else:
                    metadata.vlm_analyzed = False
                    print(f"[VLM] Skipped (high confidence OCR, single/small group)")

                # 4. Salvar metadados
                c.execute("""
                    INSERT INTO ocr_results (photo_id, raw_text, confidence)
                    VALUES (?, ?, ?)
                """, (photo_id, ocr_text, ocr_conf))

                metadata_dict = metadata.to_dict()
                c.execute("""
                    UPDATE photos SET status = 'processed', metadata_json = ?
                    WHERE id = ?
                """, (json.dumps(metadata_dict), photo_id))

                db.commit()
                print(f"[CentralPipeline] photo {photo_id} processed: OCR={ocr_conf:.2f} VLM={metadata.vlm_analyzed}")
                return True

        except Exception as e:
            logging.error(f"Erro no pipeline Central IA para foto {photo_id}: {e}")
            return False

    def run_clustering(self, catalog: str):
        pass
