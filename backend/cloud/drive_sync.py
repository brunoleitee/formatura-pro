import logging
import threading
import time
from typing import List, Dict, Any, Optional
from datetime import datetime
from .drive_manager import drive_manager
from .drive_cache import cache
from .drive_models import CloudFile, SyncStatus

logger = logging.getLogger(__name__)

SYNC_STATE_FILE = "data/cloud/sync_state.json"


class DriveSync:
    def __init__(self):
        self.sync_queue: List[Dict[str, Any]] = []
        self.is_syncing = False
        self.sync_thread: Optional[threading.Thread] = None
        self.sync_progress = 0.0
        self.last_sync: Optional[datetime] = None

    def add_to_queue(self, file_id: str, operation: str, local_path: str = "", remote_path: str = "") -> None:
        self.sync_queue.append({
            "file_id": file_id,
            "operation": operation,
            "local_path": local_path,
            "remote_path": remote_path,
            "added_at": datetime.now().isoformat(),
        })

    def start_background_sync(self) -> None:
        if self.is_syncing:
            return

        self.is_syncing = True
        self.sync_thread = threading.Thread(target=self._sync_worker, daemon=True)
        self.sync_thread.start()

    def _sync_worker(self) -> None:
        while self.sync_queue and self.is_syncing:
            item = self.sync_queue.pop(0)
            try:
                if item["operation"] == "upload":
                    self._upload_file(item)
                elif item["operation"] == "download":
                    self._download_file(item)
                self.sync_progress = 1.0 - (len(self.sync_queue) / max(1, len(self.sync_queue) + 1))
            except Exception as e:
                logger.error(f"Erro na sincronização: {e}")

        self.is_syncing = False
        self.last_sync = datetime.now()
        self.sync_progress = 1.0

    def _upload_file(self, item: Dict[str, Any]) -> bool:
        logger.info(f"Uploading: {item['local_path']}")
        return True

    def _download_file(self, item: Dict[str, Any]) -> bool:
        logger.info(f"Downloading: {item['file_id']}")
        return True

    def get_status(self) -> SyncStatus:
        return SyncStatus(
            is_online=True,
            pending_uploads=len([i for i in self.sync_queue if i["operation"] == "upload"]),
            pending_downloads=len([i for i in self.sync_queue if i["operation"] == "download"]),
            last_sync=self.last_sync,
            sync_progress=self.sync_progress,
        )

    def sync_folder(self, folder_id: str) -> List[CloudFile]:
        files = drive_manager.list_files(folder_id)
        cloud_files = []

        for f in files:
            metadata = cache.load_metadata(f.id)
            if metadata:
                cloud_files.append(CloudFile(**metadata, drive_file_id=f.id))
            else:
                new_file = CloudFile(
                    drive_file_id=f.id,
                    sync_status="pending",
                    modified_time=f.modifiedTime,
                )
                cache.save_metadata(f.id, new_file.model_dump())
                cloud_files.append(new_file)

        return cloud_files

    def preload_thumbnails(self, file_ids: List[str], limit: int = 20) -> None:
        for file_id in file_ids[:limit]:
            if not cache.thumb_exists(file_id):
                threading.Thread(
                    target=drive_manager.download_thumbnail,
                    args=(file_id, cache.get_thumb_path(file_id)),
                    daemon=True,
                ).start()


sync_service = DriveSync()