from typing import Optional, Dict, Any

from .base import PhotoSource
from .local_source import LocalPhotoSource
from .google_drive_source import GoogleDrivePhotoSource


_local_source = LocalPhotoSource()
_drive_source = GoogleDrivePhotoSource()


def resolve_photo_source(photo: Dict[str, Any]) -> PhotoSource:
    source_type = photo.get("source_type", "")
    if source_type == "google_drive":
        return _drive_source

    raw = str(photo.get("foto_path") or photo.get("original_path") or "")
    if raw.startswith("cloud://"):
        return _drive_source

    return _local_source


def get_photo_path(photo: Dict[str, Any]) -> Optional[str]:
    source = resolve_photo_source(photo)
    return source.get_full_path(photo)
