import json
import os

import cv2
import numpy as np
from PIL import Image

BLUR_CACHE = {}

BLUR_CACHE_FILE = None

_load_pil_with_orientation = None
_load_quality_settings = None
_log_debug = lambda msg: None
_log_info = lambda msg: None


def configure(
    *,
    load_pil_with_orientation=None,
    load_quality_settings=None,
    log_debug=None,
    log_info=None,
):
    global _load_pil_with_orientation, _load_quality_settings, _log_debug, _log_info
    if load_pil_with_orientation is not None:
        _load_pil_with_orientation = load_pil_with_orientation
    if load_quality_settings is not None:
        _load_quality_settings = load_quality_settings
    if log_debug is not None:
        _log_debug = log_debug
    if log_info is not None:
        _log_info = log_info


def set_cache_paths(blur_cache_file, eye_cache_file=None):
    global BLUR_CACHE_FILE
    BLUR_CACHE_FILE = blur_cache_file


def _ensure_ready():
    if _load_pil_with_orientation is None or _load_quality_settings is None:
        raise RuntimeError("quality_analysis nao configurado")


def load_caches_from_disk():
    global BLUR_CACHE
    if BLUR_CACHE_FILE and os.path.exists(BLUR_CACHE_FILE):
        try:
            with open(BLUR_CACHE_FILE, "r", encoding="utf-8") as f:
                BLUR_CACHE = json.load(f)
            _log_info(f"Cache de blur carregado: {len(BLUR_CACHE)} entradas")
        except Exception as e:
            _log_debug(f"Erro ao carregar blur cache: {e}")
            BLUR_CACHE = {}


def save_caches_to_disk():
    if BLUR_CACHE_FILE:
        try:
            with open(BLUR_CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(BLUR_CACHE, f)
        except Exception as e:
            _log_debug(f"Erro ao salvar blur cache: {e}")


def clear_memory_caches():
    BLUR_CACHE.clear()


def clear_disk_caches():
    if BLUR_CACHE_FILE and os.path.exists(BLUR_CACHE_FILE):
        try:
            os.remove(BLUR_CACHE_FILE)
        except Exception:
            pass


def update_blur_cache(key, value):
    BLUR_CACHE[str(key)] = value
    if len(BLUR_CACHE) % 100 == 0:
        save_caches_to_disk()


def get_blur_label(score, settings):
    if score is None:
        return "Não analisada"
    if score < settings["blur_blurry_threshold"]:
        return "Possivelmente desfocada"
    if score < settings["blur_attention_threshold"]:
        return "Atenção"
    return "Nítida"


def get_blur_info(path, img_np=None):
    _ensure_ready()
    try:
        stat = os.stat(path)
        key = (path, stat.st_mtime_ns, stat.st_size)
        cached = BLUR_CACHE.get(str(key))
        if cached:
            return cached

        if img_np is not None:
            gray = cv2.cvtColor(img_np, cv2.COLOR_BGR2GRAY)
            h, w = gray.shape[:2]
            if w > 900 or h > 900:
                scale = 900 / max(w, h)
                gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        else:
            pil = _load_pil_with_orientation(path).convert("L")
            pil.thumbnail((900, 900), Image.Resampling.LANCZOS)
            gray = np.array(pil)

        score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        settings = _load_quality_settings()
        if score < settings["blur_blurry_threshold"]:
            status = "blurry"
            label = "Possivelmente desfocada"
        elif score < settings["blur_attention_threshold"]:
            status = "attention"
            label = "Atenção"
        else:
            status = "sharp"
            label = "Nítida"
        result = {"blur_score": round(score, 1), "blur_status": status, "blur_label": label}
        update_blur_cache(key, result)
        return result
    except Exception:
        return {"blur_score": None, "blur_status": "unknown", "blur_label": "Não analisada"}

