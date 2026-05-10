from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import Optional

from app.db import get_db
from app.models import Photo, Face, OCRResult

router = APIRouter(prefix="/search", tags=["Busca"])


@router.get("/text")
def search_text(
    catalog: str = Query(...),
    q: str = Query(..., min_length=1)
):
    try:
        event_id = int(catalog)
    except ValueError:
        return []

    db = next(get_db())
    try:
        results = []
        
        photos = db.query(Photo).filter(
            Photo.event_id == event_id,
            Photo.file_name.contains(q)
        ).limit(20).all()
        
        for photo in photos:
            results.append({
                "type": "photo",
                "id": photo.id,
                "file_name": photo.file_name,
                "thumbnail_url": f"/media/thumbnails/{photo.id}" if photo.thumbnail_path else None,
                "status": photo.status
            })
        
        ocr_results = db.query(OCRResult).filter(
            OCRResult.event_id == event_id,
            or_(
                OCRResult.detected_name.contains(q),
                OCRResult.detected_number.contains(q),
                OCRResult.raw_text.contains(q)
            )
        ).limit(20).all()
        
        for ocr in ocr_results:
            photo = db.query(Photo).filter(Photo.id == ocr.photo_id).first()
            if photo:
                results.append({
                    "type": "ocr",
                    "id": ocr.id,
                    "match_text": ocr.detected_name or ocr.detected_number or ocr.raw_text[:50],
                    "photo_id": photo.id,
                    "file_name": photo.file_name,
                    "thumbnail_url": f"/media/thumbnails/{photo.id}" if photo.thumbnail_path else None
                })

        return results
    finally:
        db.close()


@router.get("/face")
def search_similar_faces(
    catalog: str = Query(...),
    photo_id: int = Query(...),
    limit: int = Query(20, ge=1, le=100)
):
    try:
        event_id = int(catalog)
    except ValueError:
        return []

    db = next(get_db())
    try:
        source_face = db.query(Face).filter(Face.photo_id == photo_id).first()
        if not source_face:
            return []
        
        similar_faces = db.query(Face).filter(
            Face.event_id == event_id,
            Face.id != source_face.id,
            Face.embedding.isnot(None)
        ).limit(limit).all()
        
        results = []
        for face in similar_faces:
            photo = db.query(Photo).filter(Photo.id == face.photo_id).first()
            results.append({
                "face_id": face.id,
                "photo_id": face.photo_id,
                "file_name": photo.file_name if photo else "Desconhecido",
                "thumbnail_url": f"/media/thumbnails/{photo.id}" if photo and photo.thumbnail_path else None,
                "confidence": face.confidence or face.detection_score or 0.5,
                "suggested_person_name": face.suggested_person_name
            })

        return results
    finally:
        db.close()