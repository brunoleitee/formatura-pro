import os
import cv2
import numpy as np
from typing import List, Optional, Tuple
from sqlalchemy.orm import Session
import logging

from app.models import Face, Photo
from app.services.image_service import generate_face_crop
from app.core.config import settings
from onnx_provider_utils import get_onnx_providers, get_session_providers, mark_cuda_failed

logger = logging.getLogger(__name__)


class FaceService:
    def __init__(self, db: Session):
        self.db = db
        self.face_engine = None
        self._init_face_engine()

    def _init_face_engine(self):
        provider_info = get_onnx_providers(log_debug=logger.debug)
        try:
            from insightface.app import FaceAnalysis

            providers = provider_info["selected_providers"]
            self.face_engine = FaceAnalysis(
                name="buffalo_l",
                providers=providers,
                provider_options=provider_info["provider_options"],
            )
            self.face_engine.prepare(ctx_id=provider_info["ctx_id"], det_size=(640, 640))
            real_providers = get_session_providers(self.face_engine)
            real_provider = real_providers[0] if real_providers else provider_info["provider"]
            if provider_info["provider"] == "CUDAExecutionProvider" and "CUDAExecutionProvider" not in real_providers:
                mark_cuda_failed()
                logger.info("[AI] CUDA indisponível, usando CPU")
                logger.info("[AI] Provider ativo: CPUExecutionProvider")
            else:
                if real_provider == "CUDAExecutionProvider":
                    logger.info("[AI] CUDA ativa")
                logger.info(f"[AI] Provider ativo: {real_provider}")
            logger.info("InsightFace carregado com sucesso")
        except Exception as e:
            if provider_info["provider"] == "CUDAExecutionProvider":
                mark_cuda_failed()
                logger.info("[AI] CUDA indisponível, usando CPU")
            elif provider_info["provider"] != "CPUExecutionProvider":
                logger.info("[AI] Provider indisponível, usando CPU")
            else:
                logger.warning(f"InsightFace não disponível: {e}")
                self.face_engine = None
                return

            try:
                fallback = get_onnx_providers(log_debug=logger.debug)
                self.face_engine = FaceAnalysis(
                    name="buffalo_l",
                    providers=fallback["selected_providers"],
                    provider_options=fallback["provider_options"],
                )
                self.face_engine.prepare(ctx_id=fallback["ctx_id"], det_size=(640, 640))
                real_providers = get_session_providers(self.face_engine)
                real_provider = real_providers[0] if real_providers else "CPUExecutionProvider"
                if real_provider == "CUDAExecutionProvider":
                    logger.info("[AI] CUDA ativa")
                logger.info(f"[AI] Provider ativo: {real_provider}")
                logger.info("InsightFace carregado com sucesso")
                return
            except Exception as cpu_exc:
                logger.warning(f"InsightFace não disponível: {cpu_exc}")
                self.face_engine = None
                return

    def detect_faces(self, photo: Photo, event_id: int) -> List[Face]:
        if not self.face_engine:
            logger.warning("Face engine não disponível")
            return []

        if not os.path.exists(photo.original_path):
            logger.error(f"Arquivo não encontrado: {photo.original_path}")
            return []

        try:
            img = cv2.imread(photo.original_path)
            if img is None:
                logger.error(f"Não foi possível ler a imagem: {photo.original_path}")
                return []

            faces = self.face_engine.get(img)
            detected_faces = []

            for i, face in enumerate(faces):
                x1, y1, x2, y2 = map(int, face.bbox)
                score = float(face.det_score)
                embedding = face.embedding.astype(np.float32)

                crop_filename = f"face_{photo.id}_{i}_{int(score*100)}.jpg"
                crop_path = os.path.join(settings.FACES_DIR, crop_filename)

                generate_face_crop(
                    photo.original_path, crop_path,
                    x1, y1, x2 - x1, y2 - y1,
                    size=settings.FACE_SIZE
                )

                face_record = Face(
                    event_id=event_id,
                    photo_id=photo.id,
                    crop_path=crop_path if os.path.exists(crop_path) else None,
                    x=x1, y=y1, width=x2 - x1, height=y2 - y1,
                    detection_score=score,
                    embedding=embedding.tobytes(),
                    status="detected"
                )
                self.db.add(face_record)
                detected_faces.append(face_record)

            if detected_faces:
                photo.status = "detected"
                self.db.commit()

            logger.info(f"Detectadas {len(detected_faces)} faces na foto {photo.id}")
            return detected_faces

        except Exception as e:
            logger.error(f"Erro ao detectar faces: {e}")
            return []

    def get_face_suggestions(self, event_id: int, limit: int = 10) -> List[dict]:
        faces = self.db.query(Face).filter(
            Face.event_id == event_id,
            Face.status.in_(["detected", "suggested"])
        ).order_by(Face.detection_score.desc()).limit(limit).all()

        suggestions = []
        for face in faces:
            suggestions.append({
                "face_id": face.id,
                "photo_id": face.photo_id,
                "crop_url": f"/media/faces/{os.path.basename(face.crop_path)}" if face.crop_path else None,
                "confidence": face.detection_score,
                "status": face.status,
                "suggested_person_name": face.suggested_person_name,
                "suggested_person_id": face.suggested_person_id
            })
        return suggestions

    def get_photo_faces(self, photo_id: int) -> List[Face]:
        return self.db.query(Face).filter(Face.photo_id == photo_id).all()
