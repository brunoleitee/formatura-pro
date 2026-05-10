from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import ConfirmRequest, RejectRequest, ReviewResponse
from app.services import ReviewService

router = APIRouter(prefix="/review", tags=["Revisão"])


@router.post("/confirm", response_model=ReviewResponse)
def confirm_suggestion(req: ConfirmRequest, db: Session = Depends(get_db)):
    try:
        service = ReviewService(db)
        result = service.confirm_face(
            event_id=req.event_id,
            face_id=req.face_id,
            person_id=req.person_id,
            confidence=req.confidence
        )
        return ReviewResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reject", response_model=ReviewResponse)
def reject_suggestion(req: RejectRequest, db: Session = Depends(get_db)):
    try:
        service = ReviewService(db)
        result = service.reject_face(req.event_id, req.face_id, req.note)
        return ReviewResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))