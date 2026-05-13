import os
import logging
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

CACHE_DIR = "data/.cache/drive"


def get_cache_dir() -> str:
    path = os.path.join(CACHE_DIR)
    os.makedirs(path, exist_ok=True)
    return path


def get_thumb_dir() -> str:
    path = os.path.join(get_cache_dir(), "thumbs")
    os.makedirs(path, exist_ok=True)
    return path


def get_preview_dir() -> str:
    path = os.path.join(get_cache_dir(), "previews")
    os.makedirs(path, exist_ok=True)
    return path


def get_metadata_dir() -> str:
    path = os.path.join(get_cache_dir(), "metadata")
    os.makedirs(path, exist_ok=True)
    return path


def get_originals_dir() -> str:
    path = os.path.join(get_cache_dir(), "originals")
    os.makedirs(path, exist_ok=True)
    return path


class DriveCache:
    def __init__(self):
        self.thumb_dir = get_thumb_dir()
        self.preview_dir = get_preview_dir()
        self.metadata_dir = get_metadata_dir()
        self.originals_dir = get_originals_dir()

    def get_thumb_path(self, file_id: str) -> str:
        return os.path.join(self.thumb_dir, f"{file_id}.jpg")

    def get_preview_path(self, file_id: str) -> str:
        return os.path.join(self.preview_dir, f"{file_id}.jpg")

    def get_original_path(self, file_id: str) -> str:
        return os.path.join(self.originals_dir, file_id)

    def thumb_exists(self, file_id: str) -> bool:
        return os.path.exists(self.get_thumb_path(file_id))

    def preview_exists(self, file_id: str) -> bool:
        return os.path.exists(self.get_preview_path(file_id))

    def original_exists(self, file_id: str) -> bool:
        return os.path.exists(self.get_original_path(file_id))

    def save_metadata(self, file_id: str, data: Dict[str, Any]) -> None:
        import json
        path = os.path.join(self.metadata_dir, f"{file_id}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, default=str)

    def load_metadata(self, file_id: str) -> Optional[Dict[str, Any]]:
        import json
        path = os.path.join(self.metadata_dir, f"{file_id}.json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        return None

    def get_cache_size(self) -> int:
        total = 0
        for dir_path in [self.thumb_dir, self.preview_dir, self.originals_dir]:
            if os.path.exists(dir_path):
                for root, dirs, files in os.walk(dir_path):
                    for f in files:
                        total += os.path.getsize(os.path.join(root, f))
        return total

    def clear_cache(self, older_than_days: int = 30) -> int:
        import time
        count = 0
        cutoff = time.time() - (older_than_days * 86400)

        for dir_path in [self.thumb_dir, self.preview_dir, self.originals_dir]:
            if not os.path.exists(dir_path):
                continue
            for root, dirs, files in os.walk(dir_path):
                for f in files:
                    path = os.path.join(root, f)
                    if os.path.getmtime(path) < cutoff:
                        try:
                            os.remove(path)
                            count += 1
                        except:
                            pass

        logger.info(f"Cache limpo: {count} arquivos removidos")
        return count


cache = DriveCache()