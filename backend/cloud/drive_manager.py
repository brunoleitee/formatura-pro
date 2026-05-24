import logging
from typing import Optional, List, Dict, Any
from .drive_auth import load_token, is_authenticated
from .drive_models import DriveFile, DriveFolder

logger = logging.getLogger(__name__)

IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/tiff",
    "image/bmp",
}

FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"


class DriveManager:
    def __init__(self):
        self.service = None

    def _high_res_thumb_link(self, url: Optional[str], size: int = 1024) -> Optional[str]:
        if not url: return url
        import re
        return re.sub(r'=s\d+$', f'=s{size}', url)

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
            folders = []
            page_token = None
            while True:
                results = (
                    service.files()
                    .list(
                        q=f"'{folder_id}' in parents and mimeType='{FOLDER_MIME_TYPE}' and trashed=false",
                        fields="nextPageToken, files(id, name, parents, modifiedTime)",
                        orderBy="name",
                        pageToken=page_token,
                        pageSize=1000,
                    )
                    .execute()
                )
                for f in results.get("files", []):
                    folders.append(
                        DriveFolder(
                            id=f["id"],
                            name=f["name"],
                            parent=f.get("parents", [None])[0],
                            modifiedTime=f.get("modifiedTime"),
                        )
                    )
                page_token = results.get("nextPageToken")
                if not page_token:
                    break
            return folders
        except Exception as e:
            logger.error(f"Erro ao listar pastas: {e}")
            return []

    def list_folder_items(self, folder_id: str = "root") -> List[Dict[str, Any]]:
        try:
            service = self._get_service()
            image_mime_query = " or ".join([f"mimeType='{mime}'" for mime in sorted(IMAGE_MIME_TYPES)])
            items: List[Dict[str, Any]] = []
            page_token = None
            while True:
                results = (
                    service.files()
                    .list(
                        q=f"'{folder_id}' in parents and trashed=false and (mimeType='{FOLDER_MIME_TYPE}' or {image_mime_query})",
                        fields=(
                            "nextPageToken, files("
                            "id, name, mimeType, size, parents, modifiedTime, "
                            "thumbnailLink, webViewLink, webContentLink"
                            ")"
                        ),
                        orderBy="folder,name",
                        pageToken=page_token,
                        pageSize=1000,
                    )
                    .execute()
                )
                for f in results.get("files", []):
                    mime_type = f.get("mimeType", "")
                    is_folder = mime_type == FOLDER_MIME_TYPE
                    size_value = f.get("size")
                    try:
                        parsed_size = int(size_value) if size_value is not None else None
                    except (TypeError, ValueError):
                        parsed_size = None
                    items.append({
                        "id": f["id"],
                        "name": f["name"],
                        "mimeType": mime_type,
                        "isFolder": is_folder,
                        "thumbnailUrl": self._high_res_thumb_link(f.get("thumbnailLink")) if not is_folder else None,
                        "webContentLink": f.get("webContentLink") or f.get("webViewLink"),
                        "modifiedTime": f.get("modifiedTime"),
                        "size": parsed_size,
                        "parentId": f.get("parents", [None])[0],
                    })
                page_token = results.get("nextPageToken")
                if not page_token:
                    break
            items.sort(key=lambda item: (0 if item["isFolder"] else 1, str(item["name"]).lower()))
            return items
        except Exception as e:
            logger.error(f"Erro ao listar itens da pasta: {e}")
            return []

    def list_folder_items_page(
        self, folder_id: str = "root", page_size: int = 200, page_token: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            service = self._get_service()
            image_mime_query = " or ".join([f"mimeType='{mime}'" for mime in sorted(IMAGE_MIME_TYPES)])
            items: List[Dict[str, Any]] = []

            list_params = {
                "q": f"'{folder_id}' in parents and trashed=false and (mimeType='{FOLDER_MIME_TYPE}' or {image_mime_query})",
                "fields": (
                    "nextPageToken, files("
                    "id, name, mimeType, size, parents, modifiedTime, "
                    "thumbnailLink, webViewLink, webContentLink"
                    ")"
                ),
                "orderBy": "folder,name",
                "pageSize": page_size,
            }
            if page_token:
                list_params["pageToken"] = page_token

            results = service.files().list(**list_params).execute()

            for f in results.get("files", []):
                mime_type = f.get("mimeType", "")
                is_folder = mime_type == FOLDER_MIME_TYPE
                size_value = f.get("size")
                try:
                    parsed_size = int(size_value) if size_value is not None else None
                except (TypeError, ValueError):
                    parsed_size = None
                items.append({
                    "id": f["id"],
                    "name": f["name"],
                    "mimeType": mime_type,
                    "isFolder": is_folder,
                    "thumbnailUrl": self._high_res_thumb_link(f.get("thumbnailLink")) if not is_folder else None,
                    "webContentLink": f.get("webContentLink") or f.get("webViewLink"),
                    "modifiedTime": f.get("modifiedTime"),
                    "size": parsed_size,
                    "parentId": f.get("parents", [None])[0],
                })

            next_page_token = results.get("nextPageToken")
            return {
                "items": items,
                "nextPageToken": next_page_token
            }
        except Exception as e:
            logger.error(f"Erro ao listar página de itens da pasta: {e}")
            return {"items": [], "nextPageToken": None}

    def list_files(
        self, folder_id: str = "root", page_size: int = 100, offset: int = 0
    ) -> List[DriveFile]:
        try:
            service = self._get_service()
            accepted_image_query = " or ".join([f"mimeType='{mime}'" for mime in sorted(IMAGE_MIME_TYPES)])
            files = []
            page_token = None
            while True:
                results = (
                    service.files()
                    .list(
                        q=f"'{folder_id}' in parents and trashed=false and ({accepted_image_query})",
                        fields="nextPageToken, files(id, name, mimeType, size, parents, modifiedTime, thumbnailLink, webViewLink, webContentLink)",
                        pageSize=page_size,
                        pageToken=page_token,
                        orderBy="name",
                    )
                    .execute()
                )
                for f in results.get("files", []):
                    size_value = f.get("size")
                    try:
                        parsed_size = int(size_value) if size_value is not None else None
                    except (TypeError, ValueError):
                        parsed_size = None
                    files.append(
                        DriveFile(
                            id=f["id"],
                            name=f["name"],
                            mimeType=f["mimeType"],
                            size=parsed_size,
                            parent=f.get("parents", [None])[0],
                            modifiedTime=f.get("modifiedTime"),
                            thumbnailLink=self._high_res_thumb_link(f.get("thumbnailLink")),
                            webViewLink=f.get("webViewLink"),
                            webContentLink=f.get("webContentLink"),
                        )
                    )
                page_token = results.get("nextPageToken")
                if not page_token:
                    break
            return files
        except Exception as e:
            logger.error(f"Erro ao listar arquivos: {e}")
            return []

    def summarize_folder(self, folder_id: str = "root", max_depth: int = 8) -> Dict[str, int]:
        try:
            import time
            from .drive_cache import cache
            
            # Check cache first
            cached = cache.load_metadata(f"summary_{folder_id}")
            if cached:
                timestamp = cached.get("cached_at", 0)
                # Cache valid for 2 hours (7200 seconds)
                if time.time() - timestamp < 7200:
                    logger.info(f"Usando resumo em cache para pasta {folder_id}")
                    return {"photos": cached.get("photos", 0), "subfolders": cached.get("subfolders", 0)}
        except Exception as cache_err:
            logger.warning(f"Erro ao ler cache de resumo: {cache_err}")

        try:
            service = self._get_service()
            visited = set()

            def count_level(current_id: str, depth: int) -> Dict[str, int]:
                if current_id in visited:
                    return {"photos": 0, "subfolders": 0}
                visited.add(current_id)

                image_count = 0
                folder_count = 0
                child_folders = []
                for item in self.list_folder_items(current_id):
                    if item.get("isFolder"):
                        folder_count += 1
                        child_folders.append(item["id"])
                    elif item.get("mimeType") in IMAGE_MIME_TYPES:
                        image_count += 1

                if depth < max_depth:
                    for child_id in child_folders:
                        child_counts = count_level(child_id, depth + 1)
                        image_count += child_counts["photos"]
                        folder_count += child_counts["subfolders"]

                return {"photos": image_count, "subfolders": folder_count}

            result = count_level(folder_id, 0)
            
            try:
                from .drive_cache import cache
                cache.save_metadata(f"summary_{folder_id}", {
                    "photos": result["photos"],
                    "subfolders": result["subfolders"],
                    "cached_at": time.time()
                })
            except Exception as cache_err:
                logger.warning(f"Erro ao salvar cache de resumo: {cache_err}")

            return result
        except Exception as e:
            logger.error(f"Erro ao resumir pasta: {e}")
            return {"photos": 0, "subfolders": 0}

    def get_file_metadata(self, file_id: str) -> Optional[DriveFile]:
        try:
            service = self._get_service()
            f = service.files().get(
                fileId=file_id,
                fields="id, name, mimeType, size, parents, modifiedTime, thumbnailLink, webViewLink, webContentLink",
            ).execute()
            size_value = f.get("size")
            try:
                parsed_size = int(size_value) if size_value is not None else None
            except (TypeError, ValueError):
                parsed_size = None
            return DriveFile(
                id=f["id"],
                name=f["name"],
                mimeType=f["mimeType"],
                size=parsed_size,
                parent=f.get("parents", [None])[0],
                modifiedTime=f.get("modifiedTime"),
                thumbnailLink=self._high_res_thumb_link(f.get("thumbnailLink")),
                webViewLink=f.get("webViewLink"),
                webContentLink=f.get("webContentLink"),
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
