import os
import csv
import shutil
import zipfile
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime

from app.models import Photo, Face, Person, Occurrence, Export, Event
from app.core.config import settings

import logging

logger = logging.getLogger(__name__)


class ExportService:
    def __init__(self, db: Session):
        self.db = db

    def create_export(
        self,
        event_id: int,
        export_type: str,
        include_csv: bool = True,
        include_photos: bool = True,
        person_ids: List[int] = None
    ) -> Export:
        export = Export(
            event_id=event_id,
            type=export_type,
            status="running"
        )
        self.db.add(export)
        self.db.commit()
        self.db.refresh(export)
        return export

    def export_revision(
        self,
        event_id: int,
        export_type: str = "all",
        include_csv: bool = True,
        include_photos: bool = True,
        person_ids: List[int] = None
    ) -> dict:
        event = self.db.query(Event).filter(Event.id == event_id).first()
        if not event:
            raise ValueError(f"Evento {event_id} não encontrado")

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        export_dir = os.path.join(settings.EXPORTS_DIR, f"export_{event_id}_{timestamp}")
        os.makedirs(export_dir, exist_ok=True)

        export_csv_path = os.path.join(export_dir, "ocorrencias.csv")
        persons_csv_path = os.path.join(export_dir, "pessoas.csv")
        photos_dir = os.path.join(export_dir, "fotos") if include_photos else None

        if include_csv:
            self._export_occurrences_csv(event_id, export_csv_path, person_ids)
            self._export_persons_csv(event_id, persons_csv_path, person_ids)

        if include_photos:
            os.makedirs(photos_dir, exist_ok=True)
            self._export_photos(event_id, photos_dir, person_ids)

        zip_path = os.path.join(settings.EXPORTS_DIR, f"export_{event_id}_{timestamp}.zip")
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(export_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, export_dir)
                    zipf.write(file_path, arcname)

        shutil.rmtree(export_dir)

        export = Export(
            event_id=event_id,
            type=export_type,
            path=zip_path,
            status="completed"
        )
        self.db.add(export)
        self.db.commit()

        return {
            "export_id": export.id,
            "path": zip_path,
            "message": "Exportação concluída com sucesso"
        }

    def _export_occurrences_csv(
        self,
        event_id: int,
        path: str,
        person_ids: List[int] = None
    ):
        query = self.db.query(Occurrence).filter(Occurrence.event_id == event_id)
        
        occurrences = query.all()
        
        with open(path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f, delimiter=';')
            writer.writerow(['ID', 'Pessoa', 'Foto ID', 'Confiança', 'Status', 'Nota'])
            
            for occ in occurrences:
                person = self.db.query(Person).filter(Person.id == occ.person_id).first()
                writer.writerow([
                    occ.id,
                    person.name if person else 'Desconhecido',
                    occ.photo_id,
                    f"{occ.confidence:.2f}" if occ.confidence else '',
                    occ.status,
                    occ.note or ''
                ])

    def _export_persons_csv(
        self,
        event_id: int,
        path: str,
        person_ids: List[int] = None
    ):
        query = self.db.query(Person).filter(Person.event_id == event_id)
        
        if person_ids:
            query = query.filter(Person.id.in_(person_ids))
        
        persons = query.all()
        
        with open(path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f, delimiter=';')
            writer.writerow(['ID', 'Nome', 'Total Fotos', 'Status'])
            
            for person in persons:
                writer.writerow([
                    person.id,
                    person.name,
                    person.total_photos or 0,
                    person.status
                ])

    def _export_photos(
        self,
        event_id: int,
        photos_dir: str,
        person_ids: List[int] = None
    ):
        query = self.db.query(Photo).filter(Photo.event_id == event_id)
        
        if person_ids:
            photo_ids = self.db.query(Occurrence.photo_id).filter(
                Occurrence.event_id == event_id,
                Occurrence.person_id.in_(person_ids)
            ).distinct().all()
            photo_ids = [p[0] for p in photo_ids]
            query = query.filter(Photo.id.in_(photo_ids))
        
        photos = query.all()
        
        for photo in photos:
            if not photo.preview_path or not os.path.exists(photo.preview_path):
                continue
            
            person_name = "desconhecido"
            if photo.faces:
                for face in photo.faces:
                    if face.suggested_person_name:
                        person_name = face.suggested_person_name
                        break
            
            person_dir = os.path.join(photos_dir, person_name)
            os.makedirs(person_dir, exist_ok=True)
            
            dest_path = os.path.join(person_dir, photo.file_name)
            shutil.copy2(photo.preview_path, dest_path)

    def get_exports(self, event_id: int) -> List[Export]:
        return self.db.query(Export).filter(
            Export.event_id == event_id
        ).order_by(Export.created_at.desc()).all()