from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.db import get_db
from app.models import Event
from app.schemas import EventCreate, EventResponse
from app.services import ImportService

router = APIRouter(prefix="/events", tags=["Eventos"])


@router.get("/", response_model=List[EventResponse])
def list_events(db: Session = Depends(get_db)):
    events = db.query(Event).order_by(Event.created_at.desc()).all()
    return events


@router.post("/", response_model=EventResponse)
def create_event(event_data: EventCreate, db: Session = Depends(get_db)):
    service = ImportService(db)
    event = service.create_event(event_data.name, event_data.base_code)
    return event


@router.get("/{event_id}", response_model=EventResponse)
def get_event(event_id: int, db: Session = Depends(get_db)):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    return event


@router.delete("/{event_id}")
def delete_event(event_id: int, db: Session = Depends(get_db)):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    db.delete(event)
    db.commit()
    return {"message": "Evento deletado"}