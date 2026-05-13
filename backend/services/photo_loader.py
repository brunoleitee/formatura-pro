import os
import time
import logging
from typing import Optional, Dict, Any

from photo_sources import resolve_photo_source, get_photo_path

logger = logging.getLogger(__name__)


def load_photo_for_ai(
    photo: Dict[str, Any],
    wait_timeout: int = 60,
    poll_interval: float = 0.5,
) -> Optional[str]:
    """
    Resolve qualquer foto (local ou cloud) para um caminho de arquivo local válido.

    - Local: retorna o path direto.
    - Cloud: baixa sob demanda e aguarda até wait_timeout segundos.

    Retorna o local_path pronto para OCR/embedding, ou None se falhar.
    """
    source = resolve_photo_source(photo)
    local_path = source.get_full_path(photo)

    if local_path and os.path.exists(local_path):
        print(f"[PhotoLoader] cache hit: {local_path}")
        return local_path

    from photo_sources.google_drive_source import GoogleDrivePhotoSource

    if isinstance(source, GoogleDrivePhotoSource):
        file_id = source.get_drive_file_id(photo)
        if not file_id:
            print("[PhotoLoader] drive_file_id nao encontrado")
            return None

        print(f"[PhotoLoader] downloading full: {file_id}")
        source.trigger_download(photo)

        from cloud.drive_cache import cache
        deadline = time.time() + wait_timeout
        while time.time() < deadline:
            if cache.original_exists(file_id):
                cached_path = cache.get_original_path(file_id)
                if os.path.exists(cached_path):
                    print(f"[PhotoLoader] download concluido: {cached_path}")
                    return cached_path
            time.sleep(poll_interval)

        print(f"[PhotoLoader] timeout apos {wait_timeout}s para: {file_id}")
        return None

    print(f"[PhotoLoader] caminho nao encontrado para: {photo}")
    return None
