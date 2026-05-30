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
        
    def process_photo(self, photo_id: int, catalog: str, photo_data: Optional[Dict[str, Any]] = None) -> bool:
        """
        Executa o pipeline simplificado para uma única foto (focado puramente em Reconhecimento Facial).
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

                # Metadados de OCR e VLM limpos por padrão (removidos do pipeline)
                metadata.vlm_analyzed = False
                metadata.ocr_confidence = 0.0

                # Salvar metadados atualizados na tabela photos
                metadata_dict = metadata.to_dict()
                c.execute("""
                    UPDATE photos SET status = 'processed', metadata_json = ?
                    WHERE id = ?
                """, (json.dumps(metadata_dict), photo_id))

                db.commit()
                print(f"[CentralPipeline] foto {photo_id} processada com sucesso via Reconhecimento Facial (0% OCR / 0% Qwen)")
                return True

        except Exception as e:
            logging.error(f"Erro no pipeline Central IA para foto {photo_id}: {e}")
            return False

    def run_clustering(self, catalog: str):
        pass
