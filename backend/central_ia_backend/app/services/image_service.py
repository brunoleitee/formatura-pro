import os
import hashlib
import time
from datetime import datetime
from typing import List, Optional
from PIL import Image
import logging

from app.core.config import settings

logger = logging.getLogger(__name__)


def calculate_file_hash(file_path: str) -> str:
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()


def generate_thumbnail(
    source_path: str,
    dest_path: str,
    size: int = 320
) -> bool:
    try:
        with Image.open(source_path) as img:
            img = img.convert("RGB")
            
            original_width, original_height = img.size
            aspect_ratio = original_width / original_height
            
            if aspect_ratio > 1:
                new_width = size
                new_height = int(size / aspect_ratio)
            else:
                new_height = size
                new_width = int(size * aspect_ratio)
            
            img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
            img.save(dest_path, "JPEG", quality=85, optimize=True)
        return True
    except Exception as e:
        logger.error(f"Erro ao gerar thumbnail: {e}")
        return False


def generate_preview(
    source_path: str,
    dest_path: str,
    size: int = 1600
) -> bool:
    return generate_thumbnail(source_path, dest_path, size)


def generate_face_crop(
    source_path: str,
    dest_path: str,
    x: int, y: int, width: int, height: int,
    size: int = 200,
    expand: float = 0.4
) -> bool:
    try:
        expand_pixels = int(max(width, height) * expand)
        
        with Image.open(source_path) as img:
            img = img.convert("RGB")
            original_width, original_height = img.size
            
            x1 = max(0, x - expand_pixels)
            y1 = max(0, y - expand_pixels)
            x2 = min(original_width, x + width + expand_pixels)
            y2 = min(original_height, y + height + expand_pixels)
            
            crop = img.crop((x1, y1, x2, y2))
            crop = crop.resize((size, size), Image.Resampling.LANCZOS)
            crop.save(dest_path, "JPEG", quality=90, optimize=True)
        return True
    except Exception as e:
        logger.error(f"Erro ao gerar face crop: {e}")
        return False


def get_image_dimensions(file_path: str) -> tuple:
    try:
        with Image.open(file_path) as img:
            return img.size
    except Exception:
        return 0, 0


def get_file_size(file_path: str) -> int:
    try:
        return os.path.getsize(file_path)
    except Exception:
        return 0


def get_exif_date(file_path: str) -> Optional[datetime]:
    try:
        from PIL.ExifTags import TAGS
        with Image.open(file_path) as img:
            exif = img._getexif()
            if exif:
                for tag_id, value in exif.items():
                    tag = TAGS.get(tag_id, tag_id)
                    if tag == "DateTimeOriginal":
                        return datetime.strptime(value, "%Y:%m:%d %H:%M:%S")
    except Exception:
        pass
    return None


def is_valid_image(file_path: str) -> bool:
    try:
        from PIL import Image
        with Image.open(file_path) as img:
            img.verify()
        return True
    except Exception:
        return False


def get_storage_size(directory: str) -> int:
    total = 0
    if os.path.exists(directory):
        for dirpath, dirnames, filenames in os.walk(directory):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                try:
                    total += os.path.getsize(fp)
                except Exception:
                    pass
    return total


def list_image_files(folder_path: str) -> List[str]:
    valid_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff'}
    files = []
    if os.path.isdir(folder_path):
        for f in os.listdir(folder_path):
            ext = os.path.splitext(f)[1].lower()
            if ext in valid_extensions:
                files.append(os.path.join(folder_path, f))
    return sorted(files)