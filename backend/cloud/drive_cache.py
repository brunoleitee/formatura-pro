import os
import json
import logging
import threading
import time
import urllib.request
from typing import Optional, List, Dict, Any, Set
from datetime import datetime
from queue import Queue, PriorityQueue
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

CACHE_DIR = "data/.cache/drive"
MAX_ACTIVE_DOWNLOADS = 4
THUMB_SIZE = 200
PREVIEW_SIZE = 800


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
        return os.path.join(self.originals_dir, f"{file_id}.jpg")

    def get_thumb_dir(self) -> str:
        return self.thumb_dir

    def get_preview_dir(self) -> str:
        return self.preview_dir

    def get_original_dir(self) -> str:
        return self.originals_dir

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


@dataclass(order=True)
class DownloadTask:
    priority: int
    file_id: str = field(compare=False)
    file_type: str = field(compare=False)
    url: str = field(compare=False)
    dest_path: str = field(compare=False)
    timestamp: float = field(compare=False)


class DownloadQueue:
    def __init__(self):
        self.queue: PriorityQueue = PriorityQueue()
        self.active: Set[str] = set()
        self.lock = threading.Lock()
        self.running = False

    def is_downloading(self, file_id: str) -> bool:
        with self.lock:
            return file_id in self.active

    def add_task(self, file_id: str, file_type: str, url: str, dest_path: str, priority: int = 5) -> None:
        with self.lock:
            if file_id in self.active:
                print(f"[CloudThumb] ja esta baixando: {file_id}")
                return
            task = DownloadTask(
                priority=priority,
                file_id=file_id,
                file_type=file_type,
                url=url,
                dest_path=dest_path,
                timestamp=time.time()
            )
            self.queue.put(task)
            if not self.running:
                self.start()

    def start(self) -> None:
        if self.running:
            return
        self.running = True
        threading.Thread(target=self._worker, daemon=True).start()

    def _validate_image(self, filepath: str) -> bool:
        try:
            from PIL import Image as PILImage
            if not os.path.getsize(filepath) > 0:
                return False
            with PILImage.open(filepath) as img:
                img.verify()
            return True
        except Exception:
            return False

    def _download_to_temp(self, task) -> bool:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload
        from cloud import load_token

        tmp_file = os.path.join(task.dest_path, f"{task.file_id}.tmp")
        dest_file = os.path.join(task.dest_path, f"{task.file_id}.jpg")

        try:
            os.makedirs(task.dest_path, exist_ok=True)

            # Tenta download via URL primeiro — rapido
            if task.url:
                try:
                    print(f"[CloudThumb] download via URL: {task.file_id}")
                    with urllib.request.urlopen(task.url, timeout=30) as resp:
                        ct = resp.headers.get('Content-Type', '')
                        if not ct.startswith('image/'):
                            raise Exception(f"Content-Type nao e imagem: {ct}")
                        with open(tmp_file, "wb") as f:
                            f.write(resp.read())
                    if os.path.getsize(tmp_file) > 100 and self._validate_image(tmp_file):
                        os.replace(tmp_file, dest_file)
                        print(f"[CloudThumb] download via URL OK: {task.file_id} ({os.path.getsize(dest_file)} bytes, {ct})")
                        return True
                    else:
                        print(f"[CloudThumb] URL invalido, fallback get_media: {task.file_id}")
                except Exception as e:
                    print(f"[CloudThumb] URL download falhou, fallback get_media: {e}")
                finally:
                    if os.path.exists(tmp_file):
                        try:
                            os.remove(tmp_file)
                        except Exception:
                            pass

            # Fallback: get_media (autenticado, funciona sempre)
            print(f"[CloudThumb] download via get_media: {task.file_id}")
            token_data = load_token()
            if not token_data:
                return False

            credentials = Credentials(
                token=token_data.get("token"),
                refresh_token=token_data.get("refresh_token"),
                token_uri=token_data.get("token_uri"),
                client_id=token_data.get("client_id"),
                client_secret=token_data.get("client_secret"),
                scopes=token_data.get("scopes", []),
            )
            service = build("drive", "v3", credentials=credentials, cache_discovery=False)
            request = service.files().get_media(fileId=task.file_id)

            with open(tmp_file, "wb") as f:
                downloader = MediaIoBaseDownload(f, request)
                done = False
                while not done:
                    _, done = downloader.next_chunk()

            if os.path.getsize(tmp_file) > 0 and self._validate_image(tmp_file):
                os.replace(tmp_file, dest_file)
                print(f"[CloudThumb] download via get_media OK: {task.file_id} ({os.path.getsize(dest_file)} bytes)")
                return True
            else:
                print(f"[CloudThumb] get_media retornou arquivo invalido: {task.file_id}")
                return False

        except Exception as e:
            logger.error(f"Erro no download {task.file_id}: {e}")
            return False
        finally:
            if os.path.exists(tmp_file):
                try:
                    os.remove(tmp_file)
                except Exception:
                    pass

    def _worker(self) -> None:
        while self.running:
            try:
                task = self.queue.get(timeout=1)
            except:
                if not self.active:
                    break
                continue

            with self.lock:
                if task.file_id in self.active:
                    continue
                self.active.add(task.file_id)

            dest_file = os.path.join(task.dest_path, f"{task.file_id}.jpg")
            if os.path.exists(dest_file) and not self._validate_image(dest_file):
                print(f"[CloudThumb] cache corrompido, removendo: {dest_file}")
                try:
                    os.remove(dest_file)
                except Exception:
                    pass

            if not os.path.exists(dest_file):
                self._download_to_temp(task)

            with self.lock:
                self.active.discard(task.file_id)

        with self.lock:
            if not self.active and self.queue.empty():
                self.running = False


download_queue = DownloadQueue()