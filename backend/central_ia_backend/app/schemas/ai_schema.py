from pydantic import BaseModel
from typing import Optional, List


class CentralStatsResponse(BaseModel):
    total_photos: int
    processed_photos: int
    in_curation: int
    pending: int
    errors: int
    storage_used: int
    
    timeline: dict
    
    percents: dict

    ocr: Optional[dict] = None


class SuggestionResponse(BaseModel):
    face_id: int
    photo_id: int
    crop_url: Optional[str] = None
    suggested_person_id: Optional[int] = None
    suggested_person_name: Optional[str] = None
    confidence: float
    status: str


class PhotoSuggestionsResponse(BaseModel):
    photo_id: int
    suggestions: List[SuggestionResponse]


class ImportFolderRequest(BaseModel):
    event_id: int
    folder_path: str
    copy_files: bool = False


class ImportFolderResponse(BaseModel):
    job_id: int
    message: str
    total_files: int


class ScanRequest(BaseModel):
    event_id: int


class ScanResponse(BaseModel):
    job_id: int
    message: str


class SearchTextRequest(BaseModel):
    catalog: str
    q: str


class SearchFaceRequest(BaseModel):
    catalog: str
    photo_id: int
    limit: int = 20
