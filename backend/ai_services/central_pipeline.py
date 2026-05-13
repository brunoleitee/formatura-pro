import os
import cv2
import numpy as np
import logging
import time
from pathlib import Path

class CentralAIPipeline:
    def __init__(self, face_engine_provider=None, get_db=None, mm=None):
        self.face_engine_provider = face_engine_provider
        self.get_db = get_db
        self.mm = mm
        self.ocr_engine = None # Placeholder para EasyOCR/Tesseract
        
    def process_photo(self, photo_id: int, catalog: str):
        """
        Executa o pipeline completo para uma única foto.
        Usa PhotoSource como camada universal de acesso a imagens.
        """
        try:
            with self.get_db(catalog) as db:
                c = db.cursor()
                c.execute("SELECT * FROM photos WHERE id = ?", (photo_id,))
                photo = c.fetchone()
                if not photo:
                    return False
                
                photo = dict(photo)

                # Resolver caminho via PhotoSource (suporta local e cloud)
                from services.photo_loader import load_photo_for_ai
                img_path = load_photo_for_ai(photo)

                if not img_path or not os.path.exists(img_path):
                    print(f"[CentralPipeline] caminho nao resolvido: photo_id={photo_id}")
                    return False

                print(f"[CentralPipeline] processando: {img_path}")

                # 1. Carregar imagem
                img = cv2.imread(img_path)
                if img is None:
                    from PIL import Image
                    pil_img = Image.open(img_path).convert("RGB")
                    img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
                
                # 2. Detecção e Reconhecimento de Faces
                faces_found = []
                face_engine = self.face_engine_provider.get_app_face() if self.face_engine_provider else None
                
                if face_engine:
                    faces = face_engine.get(img)
                    for i, face in enumerate(faces):
                        x1, y1, x2, y2 = map(int, face.bbox)
                        score = float(face.det_score)
                        emb = face.embedding.astype("float32")
                        
                        # Salvar crop da face
                        crop_filename = f"face_{photo_id}_{i}.jpg"
                        crop_path = ""
                        if self.mm:
                            thumb_dir = self.mm._get("thumb_cache_dir")
                            crop_path = os.path.join(thumb_dir, crop_filename)
                            # Usar o motor de thumb do mm para extrair o crop com expand
                            self.mm._run_thumb_engine("face", img_path, crop_path, 200, x1=x1, y1=y1, x2=x2, y2=y2, expand=0.4)
                        
                        # Inserir na tabela de faces
                        c.execute("""
                            INSERT INTO faces (photo_id, crop_path, x, y, width, height, detection_score, embedding, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'detected')
                        """, (photo_id, crop_path, x1, y1, x2-x1, y2-y1, score, emb.tobytes()))
                        
                        face_id = c.lastrowid
                        faces_found.append({"id": face_id, "score": score})
                
                # 3. OCR (Simulado por enquanto)
                # No futuro: self.ocr_engine.readtext(img)
                raw_text = "" 
                c.execute("""
                    INSERT INTO ocr_results (photo_id, raw_text, confidence)
                    VALUES (?, ?, ?)
                """, (photo_id, raw_text, 0.0))
                
                # 4. Atualizar status da foto
                c.execute("UPDATE photos SET status = 'processed' WHERE id = ?", (photo_id,))
                db.commit()
                return True
                
        except Exception as e:
            logging.error(f"Erro no pipeline Central IA para foto {photo_id}: {e}")
            return False

    def run_clustering(self, catalog: str):
        """
        Executa o agrupamento (clustering) de faces desconhecidas.
        """
        # TODO: Implementar lógica de clustering com FAISS
        pass
