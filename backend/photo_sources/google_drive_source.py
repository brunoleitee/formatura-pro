import os
import logging
from typing import Optional, Dict, Any

from .base import PhotoSource

logger = logging.getLogger(__name__)


def _get_drive_file_id(photo: Dict[str, Any]) -> Optional[str]:
    file_id = photo.get("drive_file_id")
    if file_id:
        return str(file_id)
    raw = photo.get("foto_path") or photo.get("original_path") or ""
    if isinstance(raw, str) and raw.startswith("cloud://"):
        return raw[8:]
    return None


class GoogleDrivePhotoSource(PhotoSource):
    def get_drive_file_id(self, photo: Dict[str, Any]) -> Optional[str]:
        return _get_drive_file_id(photo)

    def get_full_path(self, photo: Dict[str, Any]) -> Optional[str]:
        from cloud.drive_cache import cache

        file_id = _get_drive_file_id(photo)
        if not file_id:
            return None

        if cache.original_exists(file_id):
            path = cache.get_original_path(file_id)
            print(f"[PhotoSource] google drive full cache hit: {path}")
            return path

        print(f"[PhotoSource] google drive full cache miss: {file_id}")
        return None

    def get_thumb_path(self, photo: Dict[str, Any], size: int = 300) -> Optional[str]:
        from cloud.drive_cache import cache

        file_id = _get_drive_file_id(photo)
        if not file_id:
            return None

        if cache.thumb_exists(file_id):
            path = cache.get_thumb_path(file_id)
            print(f"[PhotoSource] google drive thumb cache hit: {path}")
            return path

        print(f"[PhotoSource] google drive thumb cache miss: {file_id}")
        return None

    def get_preview_path(self, photo: Dict[str, Any], size: int = 1920) -> Optional[str]:
        return self.get_full_path(photo)

    def exists(self, photo: Dict[str, Any]) -> bool:
        from cloud.drive_cache import cache

        file_id = _get_drive_file_id(photo)
        if not file_id:
            return False

        raw = photo.get("foto_path") or photo.get("original_path") or ""
        if isinstance(raw, str) and raw.startswith("cloud://"):
            return cache.original_exists(file_id) or bool(cache.load_metadata(file_id))

        return cache.original_exists(file_id)

    def trigger_download(self, photo: Dict[str, Any]) -> bool:
        from cloud.drive_cache import cache, download_queue
        from cloud import is_authenticated, drive_manager

        file_id = _get_drive_file_id(photo)
        if not file_id:
            return False

        if cache.original_exists(file_id):
            print(f"[PhotoSource] download ja existe: {file_id}")
            return True

        if not is_authenticated():
            print("[PhotoSource] nao autenticado")
            return False

        if download_queue.is_downloading(file_id):
            print(f"[PhotoSource] ja esta baixando: {file_id}")
            return True

        download_queue.add_task(
            file_id=file_id,
            file_type="original",
            url=f"https://drive.google.com/uc?id={file_id}",
            dest_path=cache.get_original_dir(),
            priority=3,
        )
        print(f"[PhotoSource] download iniciado: {file_id}")
        return True
