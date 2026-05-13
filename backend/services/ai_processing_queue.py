import threading
import time
import logging
from typing import Optional, Callable, Dict, Any
from dataclasses import dataclass, field
from queue import Queue

from .photo_loader import load_photo_for_ai

logger = logging.getLogger(__name__)


@dataclass
class AIJob:
    photo_id: int
    catalog: str
    photo: Dict[str, Any]
    callback: Optional[Callable] = None


class AIProcessingQueue:
    def __init__(self):
        self.queue: Queue = Queue()
        self.running = False
        self._thread: Optional[threading.Thread] = None

    def enqueue(self, photo_id: int, catalog: str, photo: Dict[str, Any], callback: Optional[Callable] = None) -> None:
        job = AIJob(photo_id=photo_id, catalog=catalog, photo=photo, callback=callback)
        self.queue.put(job)
        print(f"[AIQueue] enfileirado: photo_id={photo_id}, catalog={catalog}")
        if not self.running:
            self.start()

    def start(self) -> None:
        if self.running:
            return
        self.running = True
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()
        print("[AIQueue] worker iniciado")

    def _worker(self) -> None:
        while self.running:
            try:
                job = self.queue.get(timeout=1)
            except Exception:
                continue

            try:
                self._process_job(job)
            except Exception as e:
                print(f"[AIQueue] erro processando photo_id={job.photo_id}: {e}")
            finally:
                self.queue.task_done()

    def _process_job(self, job: AIJob) -> None:
        print(f"[AIQueue] processando photo_id={job.photo_id} catalog={job.catalog}")

        local_path = load_photo_for_ai(job.photo)
        if not local_path:
            print(f"[AIQueue] falha ao carregar foto: photo_id={job.photo_id}")
            return

        print(f"[AIQueue] foto carregada: {local_path}")

        if job.callback:
            job.callback(local_path, job)


ai_processing_queue = AIProcessingQueue()
