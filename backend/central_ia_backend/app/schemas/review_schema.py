from pydantic import BaseModel
from typing import Optional


class ConfirmRequest(BaseModel):
    event_id: int
    face_id: int
    person_id: int
    confidence: float


class RejectRequest(BaseModel):
    event_id: int
    face_id: int
    note: Optional[str] = None


class ReviewResponse(BaseModel):
    success: bool
    message: str