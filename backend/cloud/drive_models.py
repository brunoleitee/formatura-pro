from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class DriveFile(BaseModel):
    id: str
    name: str
    mimeType: str
    size: Optional[int] = None
    parent: Optional[str] = None
    modifiedTime: Optional[datetime] = None
    thumbnailLink: Optional[str] = None
    webViewLink: Optional[str] = None
    webContentLink: Optional[str] = None


class DriveFolder(BaseModel):
    id: str
    name: str
    parent: Optional[str] = None
    modifiedTime: Optional[datetime] = None


class CloudFile(BaseModel):
    id: Optional[int] = None
    drive_file_id: str
    original_path: Optional[str] = None
    cache_path: Optional[str] = None
    thumb_path: Optional[str] = None
    modified_time: Optional[datetime] = None
    sync_status: str = "pending"
    local_only: bool = False
    remote_only: bool = False


class SyncStatus(BaseModel):
    is_online: bool
    pending_uploads: int = 0
    pending_downloads: int = 0
    last_sync: Optional[datetime] = None
    sync_progress: float = 0.0
