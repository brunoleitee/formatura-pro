from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class EventBase(BaseModel):
    name: str
    base_code: Optional[str] = None
    status: str = "active"


class EventCreate(EventBase):
    pass


class EventResponse(EventBase):
    id: int
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True