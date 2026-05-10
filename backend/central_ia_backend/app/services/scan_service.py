import os
import cv2
import numpy as np
from sqlalchemy.orm import Session
import logging

from app.models import Photo, Face, ProcessingJob
from app.services.face_service import FaceService
from datetime import datetime

logger = logging.getLogger(__name__)


class ScanService:
    def __init__(self, db: Session):
        self.db = db

    def create_job(self, event_id: int, job_type: str) -> ProcessingJob:
        job = ProcessingJob(
            event_id=event_id,
            type=job_type,
            status="running",
            started_at=datetime.now()
        )
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)
        return job

    def scan_event(self, event_id: int, scan_type: str = "full") -> ProcessingJob:
        if scan_type == "full":
            return self._scan_full(event_id)
        elif scan_type == "detect":
            return self._scan_detect(event_id)
        elif scan_type == "embed":
            return self._scan_embed(event_id)
        else:
            raise ValueError(f"Tipo de scan desconhecido: {scan_type}")

    def _scan_full(self, event_id: int) -> ProcessingJob:
        job = self.create_job(event_id, "full_scan")
        
        photos = self.db.query(Photo).filter(
            Photo.event_id == event_id,
            Photo.status == "imported"
        ).all()
        
        job.total = len(photos)
        self.db.commit()

        face_service = FaceService(self.db)
        processed = 0

        for photo in photos:
            try:
                face_service.detect_faces(photo, event_id)
                processed += 1
                job.processed = processed
                job.progress = processed / len(photos)
                
                if processed % 10 == 0:
                    self.db.commit()
            except Exception as e:
                logger.error(f"Erro ao processar foto {photo.id}: {e}")

        job.status = "completed"
        job.finished_at = datetime.now()
        self.db.commit()

        return job

    def _scan_detect(self, event_id: int) -> ProcessingJob:
        return self._scan_full(event_id)

    def _scan_embed(self, event_id: int) -> ProcessingJob:
        job = self.create_job(event_id, "embedding")
        
        faces = self.db.query(Face).filter(
            Face.event_id == event_id,
            Face.embedding == None
        ).all()
        
        job.total = len(faces)
        self.db.commit()

        if self.db.query(Face).filter(Face.event_id == event_id).first():
            face_service = FaceService(self.db)
            photos = self.db.query(Photo).filter(Photo.event_id == event_id).all()
            
            processed = 0
            for photo in photos:
                face_service.detect_faces(photo, event_id)
                processed += 1
                job.processed = processed
                job.progress = processed / len(photos)
                
                if processed % 10 == 0:
                    self.db.commit()

        job.status = "completed"
        job.finished_at = datetime.now()
        self.db.commit()

        return job

    def get_job_status(self, event_id: int) -> list:
        return self.db.query(ProcessingJob).filter(
            ProcessingJob.event_id == event_id
        ).order_by(ProcessingJob.started_at.desc()).all()

    def update_photo_status(self, photo_id: int, status: str):
        photo = self.db.query(Photo).filter(Photo.id == photo_id).first()
        if photo:
            photo.status = status
            self.db.commit()