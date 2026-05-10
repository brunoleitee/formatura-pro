import os
import time
import shutil
from typing import List, Optional
from PIL import Image
from sqlalchemy.orm import Session
from datetime import datetime

from app.models import Photo, Event, ProcessingJob
from app.services.image_service import (
    calculate_file_hash, generate_thumbnail, generate_preview,
    get_image_dimensions, get_file_size, get_exif_date, is_valid_image,
    list_image_files
)
from app.core.config import settings
import logging

logger = logging.getLogger(__name__)


class ImportService:
    def __init__(self, db: Session):
        self.db = db

    def create_event(self, name: str, base_code: str = None) -> Event:
        event = Event(
            name=name,
            base_code=base_code,
            status="active"
        )
        self.db.add(event)
        self.db.commit()
        self.db.refresh(event)
        return event

    def get_or_create_event(self, event_id: int) -> Optional[Event]:
        return self.db.query(Event).filter(Event.id == event_id).first()

    def import_folder(
        self,
        event_id: int,
        folder_path: str,
        copy_files: bool = False
    ) -> dict:
        if not os.path.isdir(folder_path):
            raise ValueError(f"Pasta não encontrada: {folder_path}")

        event = self.get_or_create_event(event_id)
        if not event:
            raise ValueError(f"Evento {event_id} não encontrado")

        files = list_image_files(folder_path)
        if not files:
            raise ValueError("Nenhum arquivo de imagem encontrado na pasta")

        job = ProcessingJob(
            event_id=event_id,
            type="import",
            status="running",
            total=len(files),
            processed=0,
            started_at=datetime.now()
        )
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)

        imported = 0
        errors = 0

        for file_path in files:
            try:
                if not is_valid_image(file_path):
                    errors += 1
                    continue

                original_path = file_path
                if copy_files:
                    dest_path = os.path.join(settings.ORIGINALS_DIR, f"event_{event_id}")
                    os.makedirs(dest_path, exist_ok=True)
                    new_path = os.path.join(dest_path, os.path.basename(file_path))
                    shutil.copy2(file_path, new_path)
                    original_path = new_path

                file_hash = calculate_file_hash(original_path)
                existing = self.db.query(Photo).filter(
                    Photo.event_id == event_id,
                    Photo.hash == file_hash
                ).first()
                
                if existing:
                    continue

                width, height = get_image_dimensions(original_path)
                file_size = get_file_size(original_path)
                capture_date = get_exif_date(original_path)

                file_name = os.path.basename(file_path)
                thumb_name = f"thumb_{event_id}_{imported}_{file_hash[:8]}.jpg"
                preview_name = f"preview_{event_id}_{imported}_{file_hash[:8]}.jpg"

                thumb_path = os.path.join(settings.THUMBNAILS_DIR, thumb_name)
                preview_path = os.path.join(settings.PREVIEWS_DIR, preview_name)

                generate_thumbnail(original_path, thumb_path, settings.THUMBNAIL_SIZE)
                generate_preview(original_path, preview_path, settings.PREVIEW_SIZE)

                photo = Photo(
                    event_id=event_id,
                    file_name=file_name,
                    original_path=original_path,
                    thumbnail_path=thumb_path,
                    preview_path=preview_path,
                    width=width,
                    height=height,
                    file_size=file_size,
                    capture_date=capture_date,
                    status="imported",
                    hash=file_hash
                )
                self.db.add(photo)
                imported += 1

                if imported % 10 == 0:
                    job.processed = imported
                    job.progress = imported / len(files)
                    self.db.commit()

            except Exception as e:
                logger.error(f"Erro ao importar {file_path}: {e}")
                errors += 1

        job.status = "completed"
        job.processed = imported
        job.progress = 1.0
        job.finished_at = datetime.now()
        self.db.commit()

        return {
            "job_id": job.id,
            "total_files": len(files),
            "imported": imported,
            "errors": errors
        }

    def get_event_stats(self, event_id: int) -> dict:
        photos = self.db.query(Photo).filter(Photo.event_id == event_id).all()
        
        total = len(photos)
        processed = sum(1 for p in photos if p.status in ["detected", "processed"])
        in_curation = sum(1 for f in photos if f.faces and any(face.status == "suggested" for face in f.faces))
        pending = sum(1 for p in photos if p.status == "imported")
        errors = sum(1 for p in photos if p.status == "error")

        storage_used = sum(p.file_size or 0 for p in photos)

        return {
            "total_photos": total,
            "processed_photos": processed,
            "in_curation": in_curation,
            "pending": pending,
            "errors": errors,
            "storage_used": storage_used
        }

    def get_filmstrip(
        self,
        event_id: int,
        search: str = None,
        status: str = None,
        page: int = 1,
        limit: int = 50
    ) -> List[Photo]:
        query = self.db.query(Photo).filter(
            Photo.event_id == event_id,
            Photo.discarded == False
        )

        if search:
            query = query.filter(Photo.file_name.contains(search))

        if status and status != "Todos":
            query = query.filter(Photo.status == status.lower())

        query = query.order_by(Photo.id.desc())
        
        offset = (page - 1) * limit
        return query.offset(offset).limit(limit).all()

    def get_photo(self, photo_id: int) -> Optional[Photo]:
        return self.db.query(Photo).filter(Photo.id == photo_id).first()