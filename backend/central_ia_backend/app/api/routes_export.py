from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import ExportRequest, ExportResponse
from app.services import ExportService

router = APIRouter(prefix="/export", tags=["Exportação"])


@router.post("/{event_id}", response_model=ExportResponse)
def create_export(event_id: int, req: ExportRequest, db: Session = Depends(get_db)):
    try:
        service = ExportService(db)
        result = service.export_revision(
            event_id=event_id,
            export_type=req.type,
            include_csv=req.include_csv,
            include_photos=req.include_photos,
            person_ids=req.person_ids
        )
        return ExportResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{event_id}")
def get_exports(event_id: int, db: Session = Depends(get_db)):
    service = ExportService(db)
    exports = service.get_exports(event_id)
    return [{
        "id": e.id,
        "type": e.type,
        "path": e.path,
        "status": e.status,
        "created_at": str(e.created_at)
    } for e in exports]