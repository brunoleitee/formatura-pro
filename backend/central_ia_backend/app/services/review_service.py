from sqlalchemy.orm import Session
from typing import List, Optional

from app.models import Photo, Face, Person, Occurrence
from app.schemas.review_schema import ConfirmRequest, RejectRequest

import logging

logger = logging.getLogger(__name__)


class ReviewService:
    def __init__(self, db: Session):
        self.db = db

    def confirm_face(
        self,
        event_id: int,
        face_id: int,
        person_id: int,
        confidence: float
    ) -> dict:
        face = self.db.query(Face).filter(Face.id == face_id).first()
        if not face:
            raise ValueError(f"Face {face_id} não encontrada")

        person = self.db.query(Person).filter(Person.id == person_id).first()
        if not person:
            person = Person(
                event_id=event_id,
                name=f"Pessoa {person_id}",
                status="active"
            )
            self.db.add(person)
            self.db.commit()
            self.db.refresh(person)

        face.status = "confirmed"
        face.suggested_person_id = person.id
        face.suggested_person_name = person.name
        face.confidence = confidence

        occurrence = Occurrence(
            event_id=event_id,
            photo_id=face.photo_id,
            face_id=face.id,
            person_id=person.id,
            confidence=confidence,
            status="confirmed"
        )
        self.db.add(occurrence)

        person.total_photos = (person.total_photos or 0) + 1
        self.db.commit()

        return {"success": True, "message": f"Face vinculada a {person.name}"}

    def reject_face(self, event_id: int, face_id: int, note: str = None) -> dict:
        face = self.db.query(Face).filter(Face.id == face_id).first()
        if not face:
            raise ValueError(f"Face {face_id} não encontrada")

        face.status = "rejected"
        self.db.commit()

        return {"success": True, "message": "Sugestão rejeitada"}

    def get_pending_suggestions(self, event_id: int, limit: int = 10) -> List[Face]:
        return self.db.query(Face).filter(
            Face.event_id == event_id,
            Face.status.in_(["detected", "suggested"])
        ).order_by(Face.detection_score.desc()).limit(limit).all()