import os
import logging
from typing import Optional, Dict, Any

from .base import PhotoSource

logger = logging.getLogger(__name__)


def _get_path(photo: Dict[str, Any]) -> Optional[str]:
    for key in ("foto_path", "original_path", "path"):
        val = photo.get(key)
        if val:
            return str(val)
    return None


class LocalPhotoSource(PhotoSource):
    def get_drive_file_id(self, photo: Dict[str, Any]) -> Optional[str]:
        return None

    def get_full_path(self, photo: Dict[str, Any]) -> Optional[str]:
        path = _get_path(photo)
        if path and not path.startswith("cloud://"):
            print(f"[PhotoSource] local full: {path}")
            return path
        return None

    def get_thumb_path(self, photo: Dict[str, Any], size: int = 300) -> Optional[str]:
        path = self.get_full_path(photo)
        if path and os.path.exists(path):
            return path
        return None

    def get_preview_path(self, photo: Dict[str, Any], size: int = 1920) -> Optional[str]:
        return self.get_full_path(photo)

    def exists(self, photo: Dict[str, Any]) -> bool:
        path = self.get_full_path(photo)
        return bool(path and os.path.exists(path))
