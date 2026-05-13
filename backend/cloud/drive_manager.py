import logging
from typing import Optional, List, Dict, Any
from .drive_auth import load_token, is_authenticated
from .drive_models import DriveFile, DriveFolder

logger = logging.getLogger(__name__)


class DriveManager:
    def __init__(self):
        self.service = None

    def _get_service(self):
        if not is_authenticated():
            raise Exception("Não autenticado no Google Drive")

        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        token_data = load_token()
        if not token_data:
            raise Exception("Token não encontrado")

        credentials = Credentials(
            token=token_data.get("token"),
            refresh_token=token_data.get("refresh_token"),
            token_uri=token_data.get("token_uri"),
            client_id=token_data.get("client_id"),
            client_secret=token_data.get("client_secret"),
            scopes=token_data.get("scopes", []),
        )

        self.service = build("drive", "v3", credentials=credentials, cache_discovery=False)
        return self.service

    def list_folders(self, folder_id: str = "root") -> List[DriveFolder]:
        try:
            service = self._get_service()
            results = (
                service.files()
                .list(
                    q=f"'{folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
                    fields="files(id, name, parents, modifiedTime)",
                    orderBy="name",
                )
                .execute()
            )
            folders = []
            for f in results.get("files", []):
                folders.append(
                    DriveFolder(
                        id=f["id"],
                        name=f["name"],
                        parent=f.get("parents", [None])[0],
                        modifiedTime=f.get("modifiedTime"),
                    )
                )
            return folders
        except Exception as e:
            logger.error(f"Erro ao listar pastas: {e}")
            return []

    def list_files(
        self, folder_id: str = "root", page_size: int = 100, offset: int = 0
    ) -> List[DriveFile]:
        try:
            service = self._get_service()
            results = (
                service.files()
                .list(
                    q=f"'{folder_id}' in parents and trashed=false and mimeType contains 'image/'",
                    fields="files(id, name, mimeType, size, parents, modifiedTime, thumbnailLink, webViewLink)",
                    pageSize=page_size,
                    orderBy="name",
                )
                .execute()
            )
            files = []
            for f in results.get("files", []):
                files.append(
                    DriveFile(
                        id=f["id"],
                        name=f["name"],
                        mimeType=f["mimeType"],
                        size=int(f.get("size", 0)),
                        parent=f.get("parents", [None])[0],
                        modifiedTime=f.get("modifiedTime"),
                        thumbnailLink=f.get("thumbnailLink"),
                        webViewLink=f.get("webViewLink"),
                    )
                )
            return files
        except Exception as e:
            logger.error(f"Erro ao listar arquivos: {e}")
            return []

    def get_file_metadata(self, file_id: str) -> Optional[DriveFile]:
        try:
            service = self._get_service()
            f = service.files().get(fileId=file_id, fields="id, name, mimeType, size, parents, modifiedTime").execute()
            return DriveFile(
                id=f["id"],
                name=f["name"],
                mimeType=f["mimeType"],
                size=int(f.get("size", 0)),
                parent=f.get("parents", [None])[0],
                modifiedTime=f.get("modifiedTime"),
            )
        except Exception as e:
            logger.error(f"Erro ao buscar metadata: {e}")
            return None

    def download_thumbnail(self, file_id: str, dest_path: str) -> bool:
        try:
            service = self._get_service()
            from .drive_cache import cache

            thumb_path = cache.get_thumb_path(file_id)
            if cache.thumb_exists(file_id):
                return True

            request = service.files().get_media(fileId=file_id)
            with open(thumb_path, "wb") as f:
                downloader = MediaIoBaseDownload(f, request)
                done = False
                while not done:
                    _, done = downloader.next_chunk()
            return True
        except Exception as e:
            logger.error(f"Erro ao baixar thumbnail: {e}")
            return False


drive_manager = DriveManager()