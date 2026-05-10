import os
from typing import Optional
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "Formatura PRO - Central IA"
    VERSION: str = "1.0.0"
    DEBUG: bool = True
    
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL", 
        "sqlite:///./central_ia.db"
    )
    
    STORAGE_DIR: str = os.getenv("STORAGE_DIR", "./storage")
    ORIGINALS_DIR: str = os.path.join(STORAGE_DIR, "originals")
    THUMBNAILS_DIR: str = os.path.join(STORAGE_DIR, "thumbnails")
    PREVIEWS_DIR: str = os.path.join(STORAGE_DIR, "previews")
    FACES_DIR: str = os.path.join(STORAGE_DIR, "faces")
    EXPORTS_DIR: str = os.path.join(STORAGE_DIR, "exports")
    
    THUMBNAIL_SIZE: int = 320
    PREVIEW_SIZE: int = 1600
    FACE_SIZE: int = 200
    
    MAX_UPLOAD_SIZE: int = 100 * 1024 * 1024
    
    ALLOWED_ORIGINS: list = ["*"]
    
    class Config:
        env_file = ".env"


settings = Settings()

for dir_path in [
    settings.STORAGE_DIR,
    settings.ORIGINALS_DIR,
    settings.THUMBNAILS_DIR,
    settings.PREVIEWS_DIR,
    settings.FACES_DIR,
    settings.EXPORTS_DIR,
]:
    os.makedirs(dir_path, exist_ok=True)