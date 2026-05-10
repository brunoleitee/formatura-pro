from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional, List

from app.db import get_db
from app.models import Photo, Face
from app.schemas import (
    PhotoResponse, FilmstripPhoto, RatingRequest, 
    ColorLabelRequest, FavoriteRequest, DiscardRequest
)
from app.services import ImportService

router = APIRouter(prefix="/photos", tags=["Fotos"])


@router.get("/filmstrip", response_model=List[FilmstripPhoto])
def get_filmstrip(
    catalog: str = Query(..., description="ID do evento"),
    search: Optional[str] = None,
    status: Optional[str] = None,
    page: int = 1,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    try:
        event_id = int(catalog)
    except ValueError:
        raise HTTPException(status_code=400, detail="catalog deve ser um número")

    service = ImportService(db)
    photos = service.get_filmstrip(event_id, search, status, page, limit)

    result = []
    for idx, photo in enumerate(photos):
        suggested_name = None
        confidence = None
        if photo.faces:
            for face in photo.faces:
                if face.suggested_person_name:
                    suggested_name = face.suggested_person_name
                    confidence = face.confidence
                    break

        result.append(FilmstripPhoto(
            id=photo.id,
            index=idx + 1,
            file_name=photo.file_name,
            thumbnail_url=f"/media/thumbnails/{photo.id}" if photo.thumbnail_path else None,
            preview_url=f"/media/previews/{photo.id}" if photo.preview_path else None,
            status=photo.status,
            favorite=photo.favorite,
            rating=photo.rating,
            color_label=photo.color_label,
            has_error=photo.status == "error",
            suggested_person_name=suggested_name,
            confidence=confidence
        ))

    return result


@router.get("/{photo_id}", response_model=PhotoResponse)
def get_photo(photo_id: int, db: Session = Depends(get_db)):
    photo = db.query(Photo).filter(Photo.id == photo_id).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Foto não encontrada")

    faces = db.query(Face).filter(Face.photo_id == photo_id).all()
    
    ocr_text = ""
    if photo.ocr_results:
        for ocr in photo.ocr_results:
            if ocr.raw_text:
                ocr_text = ocr.raw_text
                break

    return PhotoResponse(
        id=photo.id,
        file_name=photo.file_name,
        preview_url=f"/media/previews/{photo.id}" if photo.preview_path else None,
        original_path=photo.original_path,
        width=photo.width,
        height=photo.height,
        file_size=photo.file_size,
        capture_date=str(photo.capture_date) if photo.capture_date else None,
        scanner_origin=photo.scanner_origin,
        status=photo.status,
        rating=photo.rating,
        color_label=photo.color_label,
        favorite=photo.favorite,
        faces=[{
            "id": f.id,
            "crop_url": f"/media/faces/{f.id}" if f.crop_path else None,
            "x": f.x, "y": f.y, "width": f.width, "height": f.height,
            "detection_score": f.detection_score or 0,
            "status": f.status,
            "confidence": f.confidence,
            "suggested_person_name": f.suggested_person_name
        } for f in faces],
        ocr_text=ocr_text
    )


@router.post("/rating")
def update_rating(req: RatingRequest, db: Session = Depends(get_db)):
    photo = db.query(Photo).filter(Photo.id == req.photo_id).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Foto não encontrada")
    
    photo.rating = req.rating
    db.commit()
    return {"success": True, "message": f"Avaliação alterada para {req.rating} estrelas"}


@router.post("/color-label")
def update_color_label(req: ColorLabelRequest, db: Session = Depends(get_db)):
    photo = db.query(Photo).filter(Photo.id == req.photo_id).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Foto não encontrada")
    
    photo.color_label = req.color_label
    db.commit()
    return {"success": True, "message": "Etiqueta colorida alterada"}


@router.post("/favorite")
def update_favorite(req: FavoriteRequest, db: Session = Depends(get_db)):
    photo = db.query(Photo).filter(Photo.id == req.photo_id).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Foto não encontrada")
    
    photo.favorite = req.favorite
    db.commit()
    return {"success": True, "message": "Favorito atualizado"}


@router.post("/discard")
def update_discard(req: DiscardRequest, db: Session = Depends(get_db)):
    photo = db.query(Photo).filter(Photo.id == req.photo_id).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Foto não encontrada")
    
    photo.discarded = req.discard
    db.commit()
    return {"success": True, "message": "Descarte atualizado"}