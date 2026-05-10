from pydantic import BaseModel
from typing import Optional


class ExportRequest(BaseModel):
    type: str = "all"
    include_csv: bool = True
    include_photos: bool = True
    person_ids: Optional[list] = None


class ExportResponse(BaseModel):
    export_id: int
    path: str
    message: str