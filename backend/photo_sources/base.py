from abc import ABC, abstractmethod
from typing import Optional, Dict, Any


class PhotoSource(ABC):
    @abstractmethod
    def get_full_path(self, photo: Dict[str, Any]) -> Optional[str]:
        ...

    @abstractmethod
    def get_thumb_path(self, photo: Dict[str, Any], size: int = 300) -> Optional[str]:
        ...

    @abstractmethod
    def get_preview_path(self, photo: Dict[str, Any], size: int = 1920) -> Optional[str]:
        ...

    @abstractmethod
    def exists(self, photo: Dict[str, Any]) -> bool:
        ...

    @abstractmethod
    def get_drive_file_id(self, photo: Dict[str, Any]) -> Optional[str]:
        ...
