import os
import cv2
import numpy as np
import threading
import sqlite3
import string
import urllib.parse
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from pathlib import Path
from PIL import Image, ExifTags, ImageOps
import contextlib
import logging
import io
import shutil
import sys
import hashlib
import importlib
import subprocess
import json
import time
import csv
import signal
import uuid
try:
    import psutil
except ImportError:
    psutil = None
from concurrent.futures import ThreadPoolExecutor, as_completed
from logging.handlers import RotatingFileHandler
from datetime import datetime, timedelta
import atexit
import argparse
import quality_analysis as qa
import backup_manager as bm
import scanner_engine as se
import export_manager as ex
import catalog_manager as cm
import catalog_data_manager as cdm
import people_data_manager as pdm
import system_manager as sm
import interaction_manager as im
import media_manager as mm
import review_manager as rm
import maintenance_manager as am
import scan_manager as scm
import backend_state
from state import (  # noqa: F811
    AppState, _global_state_lock,
    scan_state, export_state, undo_export_state,
    manual_search_state, graduation_analysis_state, quality_audit_state,
    app_face, face_engine_device, face_engine_gpu_error, face_det_size,
    faiss_index, ref_ids, ref_classes, ref_person_keys, ref_reference_folders, ref_names,
    min_face_area, ref_match_threshold,
    cluster_centers, cluster_names, cluster_counts,
    _EMBEDDING_DISK_CACHE, _EMBEDDING_DISK_CACHE_LOADED,
    scanner_cancel, app_settings, LAST_BACKUPS,
)
from db import (  # noqa: F811
    DbConnection, get_db, catalog_db_path, backup_catalog_db,
    get_embedding_cache_path, load_embedding_disk_cache, save_embedding_disk_cache,
    get_cached_embedding, set_cached_embedding, clear_embedding_cache,
    get_scan_checkpoint, save_scan_checkpoint, clear_scan_checkpoint,
)
from utils import (
    log_debug, log_info, quiet_external_output, _suppress_stdout,
    sanitize_catalog_name, sanitize_folder_name, _invalidate_stats_caches,
    _catalog_stats_cache, _CATALOG_STATS_TTL
)
from quality_analysis import (
    clear_disk_caches as qa_clear_disk_caches,
    clear_memory_caches as qa_clear_memory_caches,
    get_blur_info,
    get_blur_label,
    load_caches_from_disk as qa_load_caches_from_disk,
    save_caches_to_disk as qa_save_caches_to_disk,
)
from backup_manager import (
    load_app_settings,
    save_app_settings,
    perform_auto_backup,
    clean_old_auto_backups,
    scheduled_backup_thread,
    DEFAULT_APP_SETTINGS,
)

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8000)
args, unknown = parser.parse_known_args()
PORT = args.port


APP_NAME = "Formatura PRO"
APP_VERSION = "1.2.0"
AI_VERSION = "hybrid_v2"
IMAGE_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff",
    ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf", ".srw", ".x3f",
)
EMBEDDING_CACHE_FILE = None

DEBUG_MODE = os.environ.get("FORM_PRO_DEBUG", "0") == "1"
VERBOSE_LOGGING = DEBUG_MODE or os.environ.get("FORM_PRO_VERBOSE", "0") == "1"

class SanitizedFormatter(logging.Formatter):
    def format(self, record):
        message = super().format(record)
        user_profile = os.environ.get("USERPROFILE") or os.environ.get("HOME")
        if user_profile:
            user_profile_norm = os.path.normpath(user_profile)
            message = message.replace(user_profile, "<USER_PROFILE>")
            message = message.replace(user_profile_norm, "<USER_PROFILE>")
            message = message.replace(user_profile.replace("\\", "/"), "<USER_PROFILE>")
        return message

def setup_logging():
    log_dir = get_writable_app_dir()
    log_file = os.path.join(log_dir, "formaturapro.log")
    rotate_handler = RotatingFileHandler(log_file, maxBytes=5*1024*1024, backupCount=5, encoding='utf-8')
    rotate_handler.setFormatter(SanitizedFormatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
    root_logger = logging.getLogger()
    if VERBOSE_LOGGING:
        root_logger.setLevel(logging.DEBUG)
    else:
        root_logger.setLevel(logging.INFO)
    root_logger.addHandler(rotate_handler)



def get_writable_app_dir():
    if not getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(__file__))
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or os.path.expanduser("~")
    app_dir = os.path.join(root, APP_NAME)
    os.makedirs(app_dir, exist_ok=True)
    return app_dir

class SafeStream:
    def __init__(self, original):
        self.original = original
    def write(self, data):
        try:
            if self.original:
                self.original.write(data)
        except (OSError, IOError):
            pass
    def flush(self):
        try:
            if self.original:
                self.original.flush()
        except (OSError, IOError):
            pass
    def __getattr__(self, name):
        return getattr(self.original, name)

# Blindagem global de standard streams para evitar crash head-less no Windows
if sys.stdout:
    sys.stdout = SafeStream(sys.stdout)
if sys.stderr:
    sys.stderr = SafeStream(sys.stderr)

def ensure_windowed_stdio():
    if not getattr(sys, "frozen", False):
        return
    log_dir = get_writable_app_dir()
    stdout_path = os.path.join(log_dir, "output.log")
    stderr_path = os.path.join(log_dir, "error.log")
    try:
        if sys.stdout is None or sys.stdout.closed:
            sys.stdout = open(stdout_path, "a", encoding="utf-8", buffering=1)
    except Exception:
        pass
    try:
        if sys.stderr is None or sys.stderr.closed:
            sys.stderr = open(stderr_path, "a", encoding="utf-8", buffering=1)
    except Exception:
        pass

ensure_windowed_stdio()

import onnxruntime as ort 
os.environ["ORT_LOGGING_LEVEL"] = "3"
logging.getLogger("onnxruntime").setLevel(logging.ERROR)
logging.basicConfig(level=logging.INFO, format='%(message)s')
setup_logging()

try:
    importlib.import_module("faiss")
    FAISS_AVAILABLE = True
except ImportError:
    FAISS_AVAILABLE = False

@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    print("[graduation-analysis] routes registered", flush=True)
    for route in app.routes:
        path = getattr(route, "path", "")
        print(path, flush=True)
    try:
        se.ensure_face_engine()
    except Exception as e:
        print(f"[AI] warmup InsightFace adiado: {e}", flush=True)
    _start_metrics_worker()
    print("[metrics] background worker iniciado", flush=True)
    yield

app = FastAPI(title="Formatura PRO API", lifespan=lifespan)

THUMB_SEMAPHORE_SMALL = threading.Semaphore(16)
THUMB_SEMAPHORE_LARGE = threading.Semaphore(4)
THUMB_SLOT_LOCAL = threading.local()
THUMB_QUEUE = []
THUMB_QUEUE_LOCK = threading.Lock()
THUMB_MAX_QUEUE = 100

def get_thumb_slot(size=300, timeout=1.0):
    semaphore = THUMB_SEMAPHORE_SMALL if int(size or 0) <= 400 else THUMB_SEMAPHORE_LARGE
    acquired = semaphore.acquire(timeout=timeout)
    if not acquired:
        with THUMB_QUEUE_LOCK:
            THUMB_QUEUE.append(time.time())
    THUMB_SLOT_LOCAL.current = semaphore
    return acquired

def release_thumb_slot():
    try:
        semaphore = getattr(THUMB_SLOT_LOCAL, "current", None)
        if semaphore is not None:
            semaphore.release()
            THUMB_SLOT_LOCAL.current = None
    except:
        pass

ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:5174",
    "http://localhost:5174",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
}


def is_allowed_browser_source(value):
    if not value:
        return True
    try:
        parsed = urllib.parse.urlparse(value)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        return origin in ALLOWED_ORIGINS
    except Exception:
        return False


@app.middleware("http")
async def block_untrusted_browser_sources(request: Request, call_next):
    if request.url.path.startswith("/api"):
        origin = request.headers.get("origin")
        referer = request.headers.get("referer")
        if origin and not is_allowed_browser_source(origin):
            return JSONResponse({"detail": "Origem nao autorizada."}, status_code=403)
        if not origin and referer and not is_allowed_browser_source(referer):
            return JSONResponse({"detail": "Origem nao autorizada."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self' http://127.0.0.1:8000; "
        "img-src 'self' data: file: http://127.0.0.1:8000; "
        "media-src 'self' data: file: http://127.0.0.1:8000; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval';"
    )
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

from routers.review import router as review_router
from routers.scanner import router as scanner_router
from routes.catalogs import router as catalogs_router
from routes.people import router as people_router
from routes.system import router as system_router
from routes.export import router as export_router
from routes.media import router as media_router
from routes.faces import router as faces_router

app.include_router(review_router)
app.include_router(scanner_router)
app.include_router(catalogs_router)
app.include_router(people_router)
app.include_router(system_router)
app.include_router(export_router)
app.include_router(media_router)
app.include_router(faces_router)

# Handler global de exceções: garante que erros 500 saiam como JSONResponse
# e não como connection-reset, o que faz o browser bloquear por CORS.
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logging.error(f"[global_exception_handler] {request.method} {request.url.path} → {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"ok": False, "error": str(exc), "detail": "Erro interno no servidor"},
    )

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_DIR = getattr(sys, "_MEIPASS", BASE_DIR)
DATA_DIR = get_writable_app_dir()
CATALOG_DIR = os.path.join(DATA_DIR, "catalogos")
THUMB_CACHE_DIR = os.path.join(DATA_DIR, "thumb_cache")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
EXPORT_HISTORY_PATH = os.path.join(DATA_DIR, "export_history.json")
QUALITY_SETTINGS_PATH = os.path.join(DATA_DIR, "quality_settings.json")
os.makedirs(CATALOG_DIR, exist_ok=True)
os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
os.makedirs(BACKUP_DIR, exist_ok=True)

# Sincronizar diretórios com state.py para db.py e outros módulos
from state import BASE_DIR as _sd, RUNTIME_DIR as _sr, DATA_DIR as _sdd, CATALOG_DIR as _sc, THUMB_CACHE_DIR as _st, BACKUP_DIR as _sb
import state as _st_mod
_st_mod.BASE_DIR = BASE_DIR
_st_mod.RUNTIME_DIR = RUNTIME_DIR
_st_mod.DATA_DIR = DATA_DIR
_st_mod.CATALOG_DIR = CATALOG_DIR
_st_mod.THUMB_CACHE_DIR = THUMB_CACHE_DIR
_st_mod.BACKUP_DIR = BACKUP_DIR

BLUR_CACHE_FILE = os.path.join(DATA_DIR, "blur_cache.json")

qa.set_cache_paths(BLUR_CACHE_FILE)

CRITICAL_PATHS = {
    os.environ.get("SYSTEMROOT", "C:\\Windows").lower(),
    os.environ.get("PROGRAMFILES", "C:\\Program Files").lower(),
    os.environ.get("PROGRAMFILES(X86)", "C:\\Program Files (x86)").lower(),
    "/etc".lower(),
    "/usr".lower(),
    "/bin".lower(),
    "/sbin".lower(),
}

def is_safe_path(path):
    abs_path = os.path.abspath(path).lower()
    for critical in CRITICAL_PATHS:
        if abs_path == critical or abs_path.startswith(critical + os.sep):
            return False
    return True

def validate_destination_path(dest_path):
    if not is_safe_path(dest_path):
        raise HTTPException(400, "Caminho de destino é protegido. Escolha outra pasta.")


backup_thread = None
shutdown_event = threading.Event()
shutdown_completed = False

def graceful_shutdown(signum=None, frame=None):
    global shutdown_completed
    if shutdown_completed:
        return
    shutdown_completed = True
    log_info("Iniciando desligamento graceful...")
    shutdown_event.set()
    save_embedding_disk_cache()
    scan_state["is_scanning"] = False
    export_state["is_exporting"] = False
    time.sleep(1)
    log_info("Desligamento concluido.")
    if signum is not None:
        sys.exit(0)

try:
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, graceful_shutdown)
    if hasattr(signal, 'SIGINT'):
        signal.signal(signal.SIGINT, graceful_shutdown)
except ValueError:
    pass
atexit.register(graceful_shutdown)

bm.configure(
    app_settings_path=os.path.join(DATA_DIR, "app_settings.json"),
    catalog_dir=CATALOG_DIR,
    backup_dir=BACKUP_DIR,
    shutdown_event_obj=shutdown_event,
    log_debug=log_debug,
    log_info=log_info,
)

DEFAULT_QUALITY_SETTINGS = {
    "blur_blurry_threshold": 80,
    "blur_attention_threshold": 140,
    "min_photos_per_person": 3,
    "manual_search_min_score": 0.45
}

def load_quality_settings():
    try:
        if os.path.exists(QUALITY_SETTINGS_PATH):
            with open(QUALITY_SETTINGS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {**DEFAULT_QUALITY_SETTINGS, **(data if isinstance(data, dict) else {})}
    except Exception:
        pass
    return dict(DEFAULT_QUALITY_SETTINGS)

def save_quality_settings(data):
    settings = {**DEFAULT_QUALITY_SETTINGS, **(data if isinstance(data, dict) else {})}
    settings["blur_blurry_threshold"] = max(1, float(settings["blur_blurry_threshold"]))
    settings["blur_attention_threshold"] = max(settings["blur_blurry_threshold"] + 1, float(settings["blur_attention_threshold"]))
    settings["min_photos_per_person"] = max(1, int(settings["min_photos_per_person"]))
    settings["manual_search_min_score"] = max(0.1, min(float(settings.get("manual_search_min_score", 0.45)), 0.95))
    with open(QUALITY_SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)
    return settings

LAST_CATALOG_FILE = os.path.join(DATA_DIR, "last_catalog.txt")

def _load_last_catalog():
    try:
        if os.path.exists(LAST_CATALOG_FILE):
            with open(LAST_CATALOG_FILE, encoding="utf-8") as f:
                name = f.read().strip()
            db_path = os.path.join(CATALOG_DIR, f"{name}.db")
            if name and os.path.exists(db_path):
                return name
    except Exception:
        pass
    return ""

def _save_last_catalog(name: str):
    try:
        with open(LAST_CATALOG_FILE, "w", encoding="utf-8") as f:
            f.write(name)
    except Exception:
        pass

AppState.current_catalog = _load_last_catalog()
app_settings = load_app_settings()
backend_state.app_settings = app_settings

def configure_modules():
    ex.configure(
        log_debug=log_debug,
        log_info=log_info,
        get_db=get_db,
        backup_catalog_db=backup_catalog_db,
        validate_destination_path=validate_destination_path,
        sanitize_folder_name=sanitize_folder_name,
        export_state=export_state,
        undo_export_state=undo_export_state,
        get_current_catalog=lambda: AppState.current_catalog,
        export_history_path=EXPORT_HISTORY_PATH,
        image_extensions=IMAGE_EXTENSIONS,
        runtime_dir=RUNTIME_DIR,
    )

    cm.configure(
        data_dir=DATA_DIR,
        catalog_dir=CATALOG_DIR,
        get_db=get_db,
        catalog_db_path=catalog_db_path,
        sanitize_catalog_name=sanitize_catalog_name,
        get_current_catalog=lambda: AppState.current_catalog,
        set_current_catalog=lambda value: [setattr(AppState, "current_catalog", value), _save_last_catalog(value)],
    )

    cdm.configure(
        get_db=get_db,
        backup_catalog_db=backup_catalog_db,
        sanitize_catalog_name=sanitize_catalog_name,
        catalog_db_path=catalog_db_path,
        get_current_catalog=lambda: AppState.current_catalog,
        app_version=APP_VERSION,
    )

    pdm.configure(
        get_db=get_db,
        get_current_catalog=lambda: AppState.current_catalog,
        get_catalog_dir=lambda: CATALOG_DIR,
        get_blur_label=get_blur_label,
        load_quality_settings=load_quality_settings,
        sqlite3=sqlite3,
    )

    sm.configure(
        app_name=APP_NAME,
        app_version=APP_VERSION,
        data_dir=DATA_DIR,
        catalog_dir=CATALOG_DIR,
        backup_dir=BACKUP_DIR,
        scan_state=scan_state,
        export_state=export_state,
        face_engine_device=se.get_face_engine_device,
        face_engine_provider=se.get_face_engine_provider,
        face_engine_label=se.get_face_engine_label,
        face_engine_gpu_error=se.get_face_engine_gpu_error,
        load_export_history=ex.load_export_history,
        get_current_catalog=lambda: AppState.current_catalog,
        embedding_cache=_EMBEDDING_DISK_CACHE,
        app_settings=app_settings,
        save_app_settings=save_app_settings,
        set_app_settings=lambda value: globals().__setitem__("app_settings", value),
        get_db=get_db,
    )

    im.configure(
        app_settings=lambda: app_settings,
    )

    mm.configure(
        get_db=get_db,
        get_current_catalog=lambda: AppState.current_catalog,
        load_quality_settings=load_quality_settings,
        get_blur_info=get_blur_info,
        log_info=log_info,
        thumb_cache_dir=THUMB_CACHE_DIR,
    )

    rm.configure(
        backup_catalog_db=backup_catalog_db,
        get_db=get_db,
        get_current_catalog=lambda: AppState.current_catalog,
        sanitize_catalog_name=sanitize_catalog_name,
        face_box_area=se.face_box_area,
        ensure_face_engine=se.ensure_face_engine,
        imread_unicode=se.imread_unicode,
        quiet_external_output=quiet_external_output,
        scanner_engine=se,
        faiss_available=FAISS_AVAILABLE,
        faiss_index=lambda: faiss_index,
        ref_ids=lambda: ref_ids,
        load_quality_settings=load_quality_settings,
        save_quality_settings=save_quality_settings,
        qa_clear_memory_caches=qa_clear_memory_caches,
        qa_clear_disk_caches=qa_clear_disk_caches,
        clear_embedding_cache=clear_embedding_cache,
        thumb_cache_dir=THUMB_CACHE_DIR,
        manual_search_state=lambda: manual_search_state,
        graduation_analysis_state=lambda: graduation_analysis_state,
        log_info=log_info,
    )

    am.configure(
        backup_catalog_db=backup_catalog_db,
        get_db=get_db,
        get_current_catalog=lambda: AppState.current_catalog,
        sanitize_catalog_name=sanitize_catalog_name,
    get_pendencies=mm.get_pendencies,
    explorer_entry_info=mm.explorer_entry_info,
    get_blur_info=get_blur_info,
    data_dir=DATA_DIR,
)

    scm.configure(
        sanitize_catalog_name=sanitize_catalog_name,
        catalog_dir=CATALOG_DIR,
        image_extensions=IMAGE_EXTENSIONS,
        gpu_diagnostics=sm.gpu_diagnostics,
        scan_state=scan_state,
        quality_audit_state=quality_audit_state,
        app_state=AppState,
        log_info=log_info,
        scanner_engine=se,
        get_db=get_db,
        face_box_area=se.face_box_area,
    )

    se.configure(
        log_debug=log_debug,
        log_info=log_info,
        quiet_external_output=quiet_external_output,
        get_memory_info=sm.get_memory_info,
        get_db=get_db,
        sanitize_catalog_name=sanitize_catalog_name,
        get_scan_checkpoint=get_scan_checkpoint,
        save_scan_checkpoint=save_scan_checkpoint,
        clear_scan_checkpoint=clear_scan_checkpoint,
        get_blur_info=get_blur_info,
        is_background_face=se.is_background_face,
        face_box_area=se.face_box_area,
        min_face_area=min_face_area,
        ref_match_threshold=ref_match_threshold,
        faiss_available=FAISS_AVAILABLE,
        runtime_dir=RUNTIME_DIR,
        data_dir=DATA_DIR,
        image_extensions=IMAGE_EXTENSIONS,
        scan_state=scan_state,
        quality_audit_state=quality_audit_state,
        app_state=AppState,
        load_embedding_disk_cache=load_embedding_disk_cache,
        save_embedding_disk_cache=save_embedding_disk_cache,
        get_cached_embedding=get_cached_embedding,
        set_cached_embedding=set_cached_embedding,
        app_settings=lambda: app_settings,
        det_size=face_det_size,
    )

app_face = None
face_engine_device = ""
face_engine_gpu_error = ""
face_det_size = (640, 640)
faiss_index = None
ref_ids = []


qa.configure(
    load_pil_with_orientation=mm.load_pil_with_orientation,
    load_quality_settings=load_quality_settings,
    log_debug=log_debug,
    log_info=log_info,
)
qa_load_caches_from_disk()

_metrics_gpu_once = None
_metrics_logger = logging.getLogger("metrics")
_metrics_snapshot = {}
_metrics_lock = threading.Lock()
_metrics_interval = 5.0
_metrics_worker_running = False

def _metrics_collect_gpu_once():
    global _metrics_gpu_once
    if _metrics_gpu_once is not None:
        return _metrics_gpu_once
    try:
        nv = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2
        )
        if nv.returncode == 0:
            parts = nv.stdout.strip().split(", ")
            if len(parts) == 2:
                result = (round(float(parts[0]), 0), round(float(parts[1]), 0))
                _metrics_gpu_once = result
                return result
    except Exception:
        pass
    _metrics_gpu_once = (0, None)
    return (0, None)


def _metrics_collect_snapshot():
    t0 = time.perf_counter()
    cpu_ms = gpu_ms = temp_ms = 0.0
    cpu_val = ram_used = ram_pct = None
    gpu_val = gpu_temp = None
    cpu_temp = None
    gpu_provider = None
    warning = None

    _t = time.perf_counter()
    if psutil:
        try:
            cpu_val = round(psutil.cpu_percent(interval=0.0), 1)
            mem = psutil.virtual_memory()
            ram_used = round(mem.used / (1024 ** 3), 1)
            ram_pct = round(mem.percent, 1)
        except Exception:
            pass
    cpu_ms = (time.perf_counter() - _t) * 1000

    _t = time.perf_counter()
    gpu_result = _metrics_collect_gpu_once()
    gpu_val, gpu_temp = gpu_result
    gpu_provider = "nvidia-smi" if gpu_val is not None and gpu_val > 0 else "unavailable"
    if gpu_val is None:
        warning = "gpu_unavailable"
    gpu_ms = (time.perf_counter() - _t) * 1000

    _t = time.perf_counter()
    if psutil:
        try:
            temps = psutil.sensors_temperatures()
            for key in ("coretemp", "cpu_thermal", "k10temp", "zenpower"):
                if key in temps and temps[key]:
                    cpu_temp = round(temps[key][0].current, 0)
                    break
        except Exception:
            pass
    if cpu_temp is None and sys.platform == "win32" and not getattr(_metrics_collect_snapshot, '_wmic_tried', False):
        _metrics_collect_snapshot._wmic_tried = True
        try:
            out = subprocess.run(
                ["wmic", "/namespace:\\\\root\\wmi", "PATH", "MSAcpi_ThermalZoneTemperature", "get", "CurrentTemperature"],
                capture_output=True, text=True, timeout=2
            )
            if out.returncode == 0:
                for line in out.stdout.strip().splitlines():
                    line = line.strip()
                    if line and line.isdigit():
                        cpu_temp = round((int(line) / 10.0 - 273.15), 0)
                        break
        except Exception:
            pass
    temp_ms = (time.perf_counter() - _t) * 1000

    snap = {
        "cpuPercent": cpu_val, "ramUsedGb": ram_used, "ramPercent": ram_pct,
        "gpuPercent": gpu_val if gpu_val is not None else 0,
        "temperatureC": gpu_temp, "cpuTemperatureC": cpu_temp,
        "gpuProvider": gpu_provider or "unavailable",
        "metricsWarning": warning,
    }
    with _metrics_lock:
        _metrics_snapshot.update(snap)

    total_ms = (time.perf_counter() - t0) * 1000
    _metrics_logger.info(
        "[metrics] cpu=%.0fms gpu=%.0fms temp=%.0fms total=%.0fms gpu_provider=%s",
        cpu_ms, gpu_ms, temp_ms, total_ms, gpu_provider or "unavailable",
    )


def _metrics_worker_loop():
    global _metrics_worker_running
    _metrics_worker_running = True
    while _metrics_worker_running:
        try:
            _metrics_collect_snapshot()
        except Exception as exc:
            _metrics_logger.error("[metrics-worker] loop_exception error=%s", exc, exc_info=True)
        time.sleep(_metrics_interval)


def _start_metrics_worker():
    t = threading.Thread(target=_metrics_worker_loop, daemon=True)
    t.start()


@app.get("/api/system/metrics")
def system_metrics():
    try:
        with _metrics_lock:
            snap = dict(_metrics_snapshot)
        has_any = any(snap.get(k) is not None for k in ("cpuPercent", "ramUsedGb", "gpuPercent"))
        if has_any:
            snap["status"] = "ready"
        else:
            snap["status"] = "warming_up"
        return snap
    except Exception:
        return {
            "cpuPercent": 0, "ramUsedGb": 0, "ramPercent": 0,
            "gpuPercent": 0, "temperatureC": None, "cpuTemperatureC": None,
            "gpuProvider": "unavailable", "metricsWarning": "snapshot_error",
            "status": "warming_up",
        }




class OpenPathReq(BaseModel):
    path: str

# =====================
# Cloud / Google Drive
# =====================

# Re-exports for backward compatibility
from services.cloud_ai_service import (
    _cloud_ai_paths_from_catalog_root,
    _cloud_ai_paths_for_catalog,
    _cloud_ai_connect_paths,
    _cloud_ai_root_from_catalog_row,
    _cloud_ai_copy_preview,
    _cloud_ai_vector_path,
    _cloud_ai_face_crop,
    _cloud_ai_load_vector,
    _cloud_ai_refresh_clusters_json,
    _cloud_ai_get_catalog_row,
    _cloud_ai_resolve_source_path,
    _cloud_ai_list_drive_files_recursive,
    _cloud_ai_schema_paths_for_catalog,
    _cloud_ai_get_status_payload,
    _cloud_ai_list_review_items,
    _cloud_ai_find_best_person,
    _cloud_ai_upsert_cluster,
    _cloud_ai_upsert_person,
    _cloud_ai_record_reference,
    _cloud_ai_process_catalog_impl,
    _cloud_ai_set_review_decision
)


def _try_load_ai_cache(foto_path: str, local_path: str = "") -> Optional[Dict[str, Any]]:
    file_id = foto_path.replace("cloud://", "", 1) if foto_path.startswith("cloud://") else ""
    if file_id:
        try:
            from cloud.drive_cache import cache
            meta = cache.load_metadata(file_id)
            if meta and meta.get("ai_face_detected") is not None:
                ai_ver = meta.get("ai_version", "")
                if ai_ver == AI_VERSION:
                    print("[AI-CACHE] cache encontrado")
                    print("[AI-CACHE] usando resultado salvo")
                    result = {
                        "success": True,
                        "cached": True,
                        "face_detected": bool(meta.get("ai_face_detected", False)),
                        "faces_count": int(meta.get("ai_faces_count", 0)),
                        "embedding_ready": bool(meta.get("ai_embedding_ready", False)),
                        "confidence": float(meta.get("ai_confidence", 0.0)),
                        "ocr_text": str(meta.get("ai_ocr_text", "")),
                        "ocr_confidence": float(meta.get("ai_ocr_confidence", 0.0)),
                        "ocr_confidence_pct": int(meta.get("ai_ocr_confidence_pct", 0)),
                        "ocr_score": float(meta.get("ai_ocr_score", 0.0)),
                        "ocr_type": str(meta.get("ai_ocr_type", "none")),
                        "ocr_label": str(meta.get("ai_ocr_label", "OCR geral")),
                        "ai_version": AI_VERSION,
                    }
                    print("[AI-CACHE] ignorando reprocessamento")
                    return result
                else:
                    print(f"[AI-CACHE] versao diferente ({ai_ver} != {AI_VERSION}), invalidando")
                    meta.pop("ai_face_detected", None)
                    meta.pop("ai_ocr_text", None)
                    cache.save_metadata(file_id, meta)
        except Exception as e:
            print(f"[AI-CACHE] erro ao ler cache: {e}")
    if local_path and os.path.exists(local_path):
        try:
            mtime_ns = int(os.path.getmtime(local_path) * 1e9)
            fsize = os.path.getsize(local_path)
            cat = AppState.current_catalog if AppState.current_catalog else ""
            if not cat:
                return None
            try:
                with get_db(cat) as conn:
                    c = conn.cursor()
                    c.execute("""
                        SELECT fe.embedding, fe.mtime_ns, fe.size, o.aluno_id
                        FROM face_embeddings fe
                        JOIN ocorrencias o ON o.rowid = fe.occurrence_rowid
                        WHERE fe.foto_path = ? AND fe.mtime_ns = ? AND fe.size = ?
                        LIMIT 1
                    """, (foto_path, mtime_ns, fsize))
                    emb_row = c.fetchone()
                    if emb_row and emb_row["embedding"]:
                        label = f"[face-cache] hit path={os.path.basename(foto_path)}"
                        print(label)
                        logging.getLogger(__name__).info(label)
                        return {
                            "success": True,
                            "cached": True,
                            "face_detected": True,
                            "faces_count": 1,
                            "embedding_ready": True,
                            "confidence": 0.0,
                            "ocr_text": "",
                            "ocr_confidence": 0.0,
                            "ocr_confidence_pct": 0,
                            "ocr_score": 0.0,
                            "ocr_type": "none",
                            "ocr_label": "OCR geral",
                            "ai_version": AI_VERSION,
                            "final_student": str(emb_row["aluno_id"]) if emb_row["aluno_id"] else None,
                        }
                    label = f"[face-cache] miss path={os.path.basename(foto_path)}"
                    print(label)
                    logging.getLogger(__name__).info(label)
            except Exception:
                pass
        except Exception as e:
            print(f"[AI-CACHE] erro ao ler banco: {e}")
    return None


class _BatchStatusReq(BaseModel):
    foto_paths: list[str] = []


@app.post("/api/ai/batch-status")
def ai_batch_status(req: _BatchStatusReq):
    """
    Retorna status de processamento AI para múltiplas fotos de uma vez.
    Body: { "foto_paths": ["path1", "path2", ...] }
    """
    try:
        items = []
        for fp in req.foto_paths:
            item: dict = {"foto_path": fp, "status": "unknown"}
            cached = _try_load_ai_cache(fp)
            if cached:
                item["face_detected"] = cached.get("face_detected", False)
                item["faces_count"] = cached.get("faces_count", 0)
                item["embedding_ready"] = cached.get("embedding_ready", False)
                item["final_student"] = cached.get("final_student")
                item["ocr_text"] = cached.get("ocr_text", "")
                item["ocr_confidence"] = cached.get("ocr_confidence", 0.0)
                item["status"] = "completed"
            items.append(item)
        return {"items": items}
    except Exception as e:
        print(f"[AI-BATCH] erro: {e}")
        return {"items": []}


@app.post("/api/ai/process-photo")
def ai_process_photo(photo_id: int = 0, catalog: str = "", foto_path: str = "", force: bool = False):
    try:
        from services.ai_processing_queue import ai_processing_queue

        if catalog and photo_id:
            BASE_DIR = Path(__file__).resolve().parents[1]
            catalogs_dir = BASE_DIR / "data" / "catalogs"
            catalog_path = catalogs_dir / f"{catalog}.db"
            if not catalog_path.exists():
                return {"error": f"Catalogo nao encontrado: {catalog}"}

            conn = sqlite3.connect(str(catalog_path))
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute("SELECT * FROM photos WHERE id = ?", (photo_id,))
            photo = c.fetchone()
            conn.close()

            if not photo:
                return {"error": "Foto nao encontrada no catalogo"}

            ai_processing_queue.enqueue(
                photo_id=photo_id,
                catalog=catalog,
                photo=dict(photo),
            )
            return {"success": True, "photo_id": photo_id, "catalog": catalog, "status": "queued"}

        if foto_path:
            photo = {"foto_path": foto_path, "source_type": "google_drive"}
            from services.photo_loader import load_photo_for_ai
            local_path = load_photo_for_ai(photo)
            if not local_path or not os.path.exists(local_path):
                return {"success": False, "status": "downloading", "foto_path": foto_path}

            print(f"[AI] resolved local_path: {local_path}")
            print(f"[AI] file exists: {os.path.exists(local_path)}")
            file_size = os.path.getsize(local_path)
            print(f"[AI] file size: {file_size}")
            if file_size == 0:
                return {"success": False, "error": "Arquivo vazio"}

            if not force:
                cached = _try_load_ai_cache(foto_path, local_path)
                if cached:
                    return cached

            import cv2
            img = cv2.imread(local_path)
            if img is None:
                return {"success": False, "error": "Falha ao ler imagem"}
            print(f"[AI] image size: {img.shape[1]}x{img.shape[0]}")

            from scanner_engine import ensure_face_engine, get_app_face, FACE_INFERENCE_LOCK
            ensure_face_engine()
            app_face = get_app_face()
            faces = []
            if app_face:
                with FACE_INFERENCE_LOCK:
                    with _suppress_stdout():
                        faces = app_face.get(img) or []
            print(f"[AI] faces detected count: {len(faces)}")
            if len(faces) > 0:
                print("[AI] face detectada")

            # OCR hibrido com ranking documental (unificado com preview-ocr)
            primary_face = None
            if faces:
                best_f = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
                fx1, fy1, fx2, fy2 = map(int, best_f.bbox[:4])
                primary_face = (fx1, fy1, fx2, fy2)

            ocr_result = {
                "ocr_text": "",
                "ocr_confidence": 0.0,
                "ocr_confidence_pct": 0,
                "ocr_score": 0.0,
                "ocr_type": "none",
                "ocr_label": "OCR geral",
            }
            cross = {}
            process_ocr_fn = None
            cross_reference_ocr_with_face = None
            try:
                from services.ocr_pipeline import (
                    detect_document_number_region,
                    process_ocr as process_ocr_fn,
                    cross_reference_ocr_with_face,
                    extract_document_number,
                )
                print("[OCR] pipeline carregado")
            except Exception as e:
                print(f"[OCR] fallback import error: {e}")
                print("[OCR] fallback ativo")

            selected_text = None
            selected_confidence = 0.0
            selected_source = "none"

            # 1) Novo OCR documental
            if process_ocr_fn:
                try:
                    doc_result = detect_document_number_region(img, local_path, primary_face)
                    new_text = doc_result.get("number") if doc_result else None
                    if new_text and len(new_text) >= 4:
                        selected_text = new_text
                        selected_confidence = doc_result.get("confidence", 0.9) or 0.9
                        selected_source = "new_doc_ocr"
                    print(f"[ai-process-ocr] new_text={new_text}")
                except Exception as e:
                    print(f"[ai-process-ocr] new_ocr error: {e}")

            # 2) Fallback OCR antigo (process_ocr)
            old_text_raw = ""
            old_number = None
            if not selected_text and process_ocr_fn:
                try:
                    old_result = process_ocr_fn(local_path) or {}
                    old_text_raw = old_result.get("ocr_text", "") or ""
                    old_number = old_result.get("fields", {}).get("numero")
                    old_conf = old_result.get("ocr_confidence", 0.85) or 0.85
                    if old_number:
                        validated = extract_document_number(old_text_raw) or extract_document_number(old_number)
                        if validated and len(validated) >= 4:
                            selected_text = validated
                            selected_confidence = old_conf
                            selected_source = "old_ocr"
                        else:
                            print(f"[ai-process-ocr] candidate={old_number} rejected=true reason=too_short_for_document")
                    print(f"[ai-process-ocr] old_text={old_text_raw or old_number or ''}")
                except Exception as e:
                    print(f"[ai-process-ocr] old_ocr error: {e}")

            print(f"[ai-process-ocr] selected_text={selected_text}")
            print(f"[ai-process-ocr] selected_source={selected_source}")

            if not selected_text:
                print("[ai-process-ocr] OCR invalidado, limpando resultado final")
                selected_confidence = 0.0
                old_text_raw = ""

            ocr_result = {
                "ocr_text": selected_text or "",
                "ocr_confidence": selected_confidence,
                "ocr_confidence_pct": int(round(selected_confidence * 100)),
                "ocr_score": selected_confidence,
                "ocr_type": "document_ocr" if selected_text else "none",
                "ocr_label": "OCR hibrido" if selected_text else "OCR geral",
            }

            face_student = None
            for db in Path(__file__).resolve().parents[1].glob("data/catalogs/*.db"):
                try:
                    conn = sqlite3.connect(str(db))
                    c = conn.cursor()
                    c.execute("SELECT aluno_id FROM ocorrencias WHERE foto_path = ? LIMIT 1", (foto_path,))
                    r = c.fetchone()
                    if r:
                        face_student = r[0]
                    conn.close()
                    break
                except Exception:
                    pass
            if cross_reference_ocr_with_face:
                try:
                    cross = cross_reference_ocr_with_face(
                        ocr_text=ocr_result.get("ocr_text", ""),
                        ocr_confidence=ocr_result.get("ocr_confidence", 0.0),
                        face_student=face_student if len(faces) > 0 else None,
                        face_confidence=float(faces[0].det_score) if len(faces) > 0 and hasattr(faces[0], "det_score") else None,
                    ) or {}
                    print("[HYBRID] cruzamento concluido")
                except Exception as e:
                    print(f"[HYBRID] fallback ativo: {e}")
            else:
                print("[HYBRID] fallback ativo")

            if not selected_text:
                cross = {}

            result = {
                "success": True,
                "cached": False,
                "local_path": local_path,
                "face_detected": len(faces) > 0,
                "faces_count": len(faces),
                "ocr_text": ocr_result.get("ocr_text", ""),
                "ocr_confidence": ocr_result.get("ocr_confidence", 0.0),
                "ocr_confidence_pct": ocr_result.get("ocr_confidence_pct", int(round(float(ocr_result.get("ocr_confidence", 0.0)) * 100))),
                "ocr_score": ocr_result.get("ocr_score", ocr_result.get("ocr_confidence", 0.0)),
                "ocr_type": ocr_result.get("ocr_type", "none"),
                "ocr_label": ocr_result.get("ocr_label", ocr_result.get("ocr_type", "none")),
                "suggested_id": cross.get("suggested_id"),
                "final_student": cross.get("final_student"),
                "final_confidence": cross.get("final_confidence"),
                "ocr_enriched": cross.get("ocr_enriched", False),
                "hybrid_result": cross,
                "ai_version": AI_VERSION,
            }

            root_dir = Path(__file__).resolve().parents[1]

            # Salvar no catalogo SQLite se existir ocorrencia
            file_id = foto_path.replace("cloud://", "", 1) if foto_path.startswith("cloud://") else ""
            saved_to_catalog = False
            for db_file in (root_dir / "data" / "catalogs").glob("*.db"):
                try:
                    conn = sqlite3.connect(str(db_file))
                    c = conn.cursor()
                    c.execute("SELECT rowid FROM ocorrencias WHERE foto_path = ? LIMIT 1", (foto_path,))
                    occ_row = c.fetchone()
                    if occ_row:
                        rowid = occ_row[0]
                        if len(faces) > 0:
                            face = faces[0]
                            emb = face.embedding.astype("float32")
                            import numpy as np
                            norm = float(np.linalg.norm(emb))
                            c.execute("""
                                INSERT OR REPLACE INTO face_embeddings
                                (occurrence_rowid, foto_path, x1, y1, x2, y2, embedding, mtime_ns, size)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """, (
                                rowid, foto_path,
                                int(face.bbox[0]), int(face.bbox[1]),
                                int(face.bbox[2]), int(face.bbox[3]),
                                emb.tobytes(),
                                int(os.path.getmtime(local_path) * 1e9) if os.path.exists(local_path) else 0,
                                os.path.getsize(local_path) if os.path.exists(local_path) else 0,
                            ))
                            result["embedding_ready"] = norm > 0
                            result["embedding_norm"] = round(norm, 4)
                            result["confidence"] = float(face.det_score) if hasattr(face, "det_score") else 0.0
                            print("[AI] embedding gerado")
                        conn.commit()
                        saved_to_catalog = True
                        break
                    conn.close()
                except Exception:
                    pass

            # Se nao salvou em catalogo e tem file_id, salvar no metadata do cache
            if not saved_to_catalog and file_id:
                from cloud.drive_cache import cache
                metadata = cache.load_metadata(file_id) or {}
                metadata["ai_face_detected"] = len(faces) > 0
                metadata["ai_faces_count"] = len(faces)
                if len(faces) > 0:
                    face = faces[0]
                    import numpy as np
                    emb = face.embedding.astype("float32")
                    norm = float(np.linalg.norm(emb))
                    metadata["ai_embedding_ready"] = norm > 0
                    metadata["ai_confidence"] = float(face.det_score) if hasattr(face, "det_score") else 0.0
                    metadata["ai_processed_at"] = time.time()
                    result["embedding_ready"] = norm > 0
                    result["confidence"] = metadata["ai_confidence"]
                    print("[AI] embedding gerado")
                metadata["ai_ocr_text"] = ocr_result.get("ocr_text", "")
                metadata["ai_ocr_confidence"] = ocr_result.get("ocr_confidence", 0.0)
                metadata["ai_ocr_confidence_pct"] = ocr_result.get("ocr_confidence_pct", int(round(float(ocr_result.get("ocr_confidence", 0.0)) * 100)))
                metadata["ai_ocr_score"] = ocr_result.get("ocr_score", ocr_result.get("ocr_confidence", 0.0))
                metadata["ai_ocr_type"] = ocr_result.get("ocr_type", "none")
                metadata["ai_ocr_label"] = ocr_result.get("ocr_label", ocr_result.get("ocr_type", "none"))
                metadata["ai_version"] = AI_VERSION
                cache.save_metadata(file_id, metadata)
                print(f"[AI] resultado (face+ocr) salvo no cache metadata: {file_id}")

            print(f"[AI] resultado: {result}")
            return result

        return {"error": "forneca photo_id+catalog ou foto_path"}

    except Exception as e:
        print(f"[AIProcess] erro: {e}")
        return {"error": str(e)}


class AiBatchStatusReq(BaseModel):
    foto_paths: List[str] = []


@app.get("/")
def root_handler(code: str = Query(None), state: str = Query(None)):
    if code:
        print(f"[OAuth] Root callback received code={code[:30]}... state={state[:20] if state else 'N/A'}...")
        try:
            from cloud import exchange_code_for_token, get_user_info
            result = exchange_code_for_token(code, state)
            if result is None:
                return {"error": "Falha ao obter token"}
            user_info = get_user_info() or {}
            print(f"[OAuth] Root callback OK email={user_info.get('email')}")
            return {"status": "ok", "email": user_info.get("email")}
        except Exception as e:
            return {"error": str(e)}
    from fastapi.responses import FileResponse
    ui_dir = os.path.join(RUNTIME_DIR, "main", "dist")
    index = os.path.join(ui_dir, "index.html")
    if os.path.exists(index):
        return FileResponse(index, media_type="text/html")
    return {"error": "frontend not found"}


configure_modules()

import webbrowser
import time

def should_open_browser():
    return os.environ.get("FORM_PRO_NO_BROWSER") != "1"

ui_dir = os.path.join(RUNTIME_DIR, "main", "dist")
if os.path.exists(ui_dir):
    app.mount("/", StaticFiles(directory=ui_dir, html=True), name="ui")

def open_browser():
    time.sleep(1.5)
    if should_open_browser():
        webbrowser.open(f"http://127.0.0.1:{PORT}")

if __name__ == "__main__":
    import os
    print("=" * 60)
    print(f"[BACKEND] CWD: {os.getcwd()}")
    print(f"[BACKEND] SCRIPT: {os.path.abspath(__file__)}")
    print("=" * 60)
    ensure_windowed_stdio()
    import uvicorn
    import socket
    
    def is_port_in_use(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(('127.0.0.1', port)) == 0

    def get_port_owner_pid(port):
        try:
            # -n mostra endereços e portas como números (agnóstico a idioma)
            # -o mostra o PID na última coluna
            result = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            return None
            
        target = f":{port}"
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line: continue
            parts = line.split()
            # TCP local_address remote_address state PID
            # No Windows com -ano, costuma ter 5 colunas
            if len(parts) >= 5 and parts[0].upper() == "TCP":
                local_addr = parts[1]
                # Verifica se termina com :8000
                if local_addr.endswith(target):
                    try:
                        return int(parts[-1]) # O PID é sempre o último com -o
                    except (ValueError, IndexError):
                        continue
        return None

    def get_process_image_name(pid):
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            return ""
        line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
        return line.split('","', 1)[0].strip('"').lower()

    def stop_existing_backend_on_port(port):
        """Tenta encontrar um processo rodando na porta alvo e encerra ele."""
        for attempt in range(3):
            pid = get_port_owner_pid(port)
            if not pid or pid == os.getpid():
                return
            
            log_info(f"Porta {port} em uso por PID {pid}. Encerrando para inicialização...")
            try:
                os.kill(pid, signal.SIGTERM)
                time.sleep(0.5)
                os.kill(pid, signal.SIGABRT)
            except Exception:
                # Taskkill é o mais garantido no Windows
                subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"], 
                              capture_output=True, 
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            
            time.sleep(1) # Aguarda liberação real no socket
            if not is_port_in_use(port):
                return
    def parent_watchdog():
        """Monitora se o processo pai ainda existe. Se o Tauri fechar, o backend morre junto."""
        try:
            # Período de carência inicial: espera o servidor e o sistema se estabilizarem
            time.sleep(10)
            
            if psutil:
                p = psutil.Process(os.getpid())
                parent = p.parent()
                if not parent:
                    return
                
                parent_pid = parent.pid
                print(f"[WATCHDOG] Monitorando processo pai (psutil): {parent_pid}")
                
                while True:
                    if not psutil.pid_exists(parent_pid):
                        print("[WATCHDOG] Processo pai encerrou. Finalizando backend...")
                        os._exit(0)
                    time.sleep(3)
            else:
                # Fallback nativo se psutil não estiver disponível
                parent_pid = os.getppid()
                if parent_pid <= 1: # No windows 1 costuma ser o init ou processo de sistema
                    return
                print(f"[WATCHDOG] Monitorando processo pai (fallback): {parent_pid}")
                while True:
                    try:
                        if parent_pid > 0:
                            if os.name == 'nt':
                                # No Windows, os.kill(pid, 0) mata o processo. Usamos ctypes de forma segura.
                                import ctypes
                                PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
                                ERROR_ACCESS_DENIED = 5
                                h_proc = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, parent_pid)
                                if h_proc:
                                    ctypes.windll.kernel32.CloseHandle(h_proc)
                                else:
                                    err = ctypes.windll.kernel32.GetLastError()
                                    if err == ERROR_ACCESS_DENIED:
                                        # O processo existe, mas não temos permissão de acesso
                                        pass
                                    else:
                                        # O processo realmente não existe
                                        raise ProcessLookupError()
                            else:
                                os.kill(parent_pid, 0)
                        else:
                            break
                    except (OSError, ProcessLookupError):
                        # No Windows, o getppid() pode ser instável se iniciado por scripts.
                        # Vamos apenas logar em vez de matar o processo agora para restaurar a conexão.
                        log_info(f"[WATCHDOG] Processo pai {parent_pid} não detectado, mas mantendo servidor ativo para estabilidade.")
                        # os._exit(0)  # Desativado temporariamente
                        break # Sai do loop do watchdog mas mantém o servidor vivo
                    except (SystemError, Exception) as e:
                        # Se for um erro do sistema ou desconhecido, logamos mas não matamos o watchdog ainda
                        # pois o processo pai pode ainda estar vivo.
                        if "returned a result with an exception set" not in str(e):
                            log_info(f"[WATCHDOG] Alerta ao verificar PID {parent_pid}: {e}")
                    time.sleep(5)

        except Exception as e:
            print(f"[WATCHDOG] Erro no monitoramento: {e}")

    if is_port_in_use(PORT):
        stop_existing_backend_on_port(PORT)

    # Inicia o vigilante do processo pai em background
    threading.Thread(target=parent_watchdog, daemon=True).start()

    if is_port_in_use(PORT):
        # Uma última tentativa de limpeza forçada antes de desistir
        stop_existing_backend_on_port(PORT)
        time.sleep(1)
        
    if is_port_in_use(PORT):
        print(f"ALERTA: A porta {PORT} continua ocupada. O servidor não pode iniciar.")
        if should_open_browser():
            webbrowser.open(f"http://127.0.0.1:{PORT}")
        sys.exit(0)
    else:
        print(f"Iniciando servidor em http://127.0.0.1:{PORT} [v{APP_VERSION}]")
        try:
            import psutil
            import os as _os
            _proc = psutil.Process(_os.getpid())
            _rss = _proc.memory_info().rss / (1024 * 1024)
            log_info(f"[MEM] app start — RSS={_rss:.0f}MB")
        except Exception:
            pass
        if VERBOSE_LOGGING:
            print("MODO DEBUG ATIVO - Logs detalhados ativos")
            print("   Use: set FORM_PRO_VERBOSE=0 para desativar")
        print("   Use: set FORM_PRO_DEBUG=1 para mais logs")
        if backup_thread is None or not backup_thread.is_alive():
            backup_thread = threading.Thread(target=scheduled_backup_thread, daemon=True)
            backup_thread.start()
        threading.Thread(target=open_browser, daemon=True).start()
        import uvicorn
        uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info", log_config=None)
