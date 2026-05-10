from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List, Optional

from app.db import get_db
from app.models import Photo, Face, Event, ProcessingJob
from app.schemas import (
    CentralStatsResponse, SuggestionResponse, PhotoSuggestionsResponse,
    ImportFolderRequest, ImportFolderResponse, ScanResponse
)
from app.services import ImportService, FaceService, ScanService, get_storage_size
from app.core.config import settings

router = APIRouter(prefix="/ai", tags=["IA"])


@router.get("/central-stats", response_model=CentralStatsResponse)
def get_central_stats(catalog: str = Query(...)):
    try:
        event_id = int(catalog)
    except ValueError:
        raise HTTPException(status_code=400, detail="catalog deve ser um número")

    db = next(get_db())
    try:
        service = ImportService(db)
        stats = service.get_event_stats(event_id)

        storage_used = get_storage_size(settings.STORAGE_DIR) // (1024 * 1024)

        jobs = db.query(ProcessingJob).filter(
            ProcessingJob.event_id == event_id
        ).all()

        import_job = next((j for j in jobs if j.type == "import"), None)
        ai_job = next((j for j in jobs if j.type in ["full_scan", "detect"]), None)

        timeline = {
            "import": {
                "processed": import_job.processed if import_job else stats["total_photos"],
                "total": import_job.total if import_job else stats["total_photos"],
                "status": "completed" if import_job and import_job.status == "completed" else "pending"
            },
            "ocr": {
                "processed": 0,
                "total": stats["total_photos"],
                "status": "pending"
            },
            "ai": {
                "processed": ai_job.processed if ai_job else stats["processed_photos"],
                "total": ai_job.total if ai_job else stats["total_photos"],
                "status": "running" if ai_job and ai_job.status == "running" else 
                          ("completed" if ai_job and ai_job.status == "completed" else "pending")
            },
            "review": {
                "processed": 0,
                "total": stats["total_photos"],
                "status": "pending"
            },
            "export": {
                "processed": 0,
                "total": stats["total_photos"],
                "status": "pending"
            }
        }

        def calc_pct(val):
            return round((val / stats["total_photos"] * 100), 1) if stats["total_photos"] > 0 else 0

        return CentralStatsResponse(
            total_photos=stats["total_photos"],
            processed_photos=stats["processed_photos"],
            in_curation=stats["in_curation"],
            pending=stats["pending"],
            errors=stats["errors"],
            storage_used=storage_used,
            timeline=timeline,
            percents={
                "processed": calc_pct(stats["processed_photos"]),
                "inCuration": calc_pct(stats["in_curation"]),
                "pending": calc_pct(stats["pending"]),
                "errors": calc_pct(stats["errors"])
            }
        )
    finally:
        db.close()


@router.get("/global-suggestions", response_model=List[SuggestionResponse])
def get_global_suggestions(
    catalog: str = Query(...),
    limit: int = Query(10, ge=1, le=50)
):
    try:
        event_id = int(catalog)
    except ValueError:
        raise HTTPException(status_code=400, detail="catalog deve ser um número")

    db = next(get_db())
    try:
        service = FaceService(db)
        suggestions = service.get_face_suggestions(event_id, limit)
        return suggestions
    finally:
        db.close()


@router.get("/photo-suggestions/{photo_id}", response_model=PhotoSuggestionsResponse)
def get_photo_suggestions(photo_id: int):
    db = next(get_db())
    try:
        service = FaceService(db)
        faces = service.get_photo_faces(photo_id)
        
        suggestions = []
        for face in faces:
            suggestions.append(SuggestionResponse(
                face_id=face.id,
                photo_id=face.photo_id,
                crop_url=f"/media/faces/{face.id}" if face.crop_path else None,
                suggested_person_id=face.suggested_person_id,
                suggested_person_name=face.suggested_person_name,
                confidence=face.confidence or face.detection_score or 0,
                status=face.status
            ))
        
        return PhotoSuggestionsResponse(photo_id=photo_id, suggestions=suggestions)
    finally:
        db.close()


@router.post("/import/folder", response_model=ImportFolderResponse)
def import_folder(req: ImportFolderRequest):
    db = next(get_db())
    try:
        service = ImportService(db)
        result = service.import_folder(req.event_id, req.folder_path, req.copy_files)
        return ImportFolderResponse(
            job_id=result["job_id"],
            message=f"Importação iniciada. {result['imported']} arquivos importados.",
            total_files=result["total_files"]
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro na importação: {str(e)}")
    finally:
        db.close()


@router.post("/scan/start/{event_id}", response_model=ScanResponse)
def start_scan(event_id: int):
    db = next(get_db())
    try:
        service = ScanService(db)
        job = service.scan_event(event_id, "full")
        return ScanResponse(
            job_id=job.id,
            message=f"Scan iniciado. {job.total} fotos para processar."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/jobs/{event_id}")
def get_jobs(event_id: int):
    db = next(get_db())
    try:
        service = ScanService(db)
        jobs = service.get_job_status(event_id)
        return [{
            "id": j.id,
            "type": j.type,
            "status": j.status,
            "progress": j.progress,
            "total": j.total,
            "processed": j.processed,
            "error_message": j.error_message,
            "started_at": str(j.started_at) if j.started_at else None,
            "finished_at": str(j.finished_at) if j.finished_at else None
        } for j in jobs]
    finally:
        db.close()