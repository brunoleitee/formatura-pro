from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class PhotoBase(BaseModel):
    file_name: str
    original_path: str
    event_id: int


class PhotoCreate(PhotoBase):
    file_size: Optional[int] = None
    capture_date: Optional[datetime] = None


class PhotoUpdate(BaseModel):
    status: Optional[str] = None
    rating: Optional[int] = None
    color_label: Optional[str] = None
    favorite: Optional[bool] = None
    discarded: Optional[bool] = None


class FaceInfo(BaseModel):
    id: int
    crop_url: Optional[str] = None
    x: int
    y: int
    width: int
    height: int
    detection_score: float
    status: str
    confidence: Optional[float] = None
    suggested_person_name: Optional[str] = None
    
    class Config:
        from_attributes = True


class PhotoResponse(BaseModel):
    id: int
    file_name: str
    preview_url: Optional[str] = None
    original_path: str
    width: Optional[int] = None
    height: Optional[int] = None
    file_size: Optional[int] = None
    capture_date: Optional[str] = None
    scanner_origin: Optional[str] = None
    status: str
    rating: int
    color_label: str
    favorite: bool
    faces: List[FaceInfo] = []
    ocr_text: Optional[str] = None
    
    class Config:
        from_attributes = True


class FilmstripPhoto(BaseModel):
    id: int
    index: int
    file_name: str
    thumbnail_url: Optional[str] = None
    preview_url: Optional[str] = None
    status: str
    favorite: bool
    rating: int
    color_label: str
    has_error: bool
    suggested_person_name: Optional[str] = None
    confidence: Optional[float] = None


class RatingRequest(BaseModel):
    photo_id: int
    rating: int


class ColorLabelRequest(BaseModel):
    photo_id: int
    color_label: str


class FavoriteRequest(BaseModel):
    photo_id: int
    favorite: bool


class DiscardRequest(BaseModel):
    photo_id: int
    discard: bool = True