import os
import cv2
import numpy as np
import threading
import sqlite3
import string
import urllib.parse
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
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
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")
EMBEDDING_CACHE_FILE = None

DEBUG_MODE = os.environ.get("FORM_PRO_DEBUG", "0") == "1"
VERBOSE_LOGGING = DEBUG_MODE or os.environ.get("FORM_PRO_VERBOSE", "0") == "1"

def setup_logging():
    log_dir = get_writable_app_dir()
    log_file = os.path.join(log_dir, "formaturapro.log")
    rotate_handler = RotatingFileHandler(log_file, maxBytes=5*1024*1024, backupCount=5, encoding='utf-8')
    rotate_handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
    root_logger = logging.getLogger()
    if VERBOSE_LOGGING:
        root_logger.setLevel(logging.DEBUG)
    else:
        root_logger.setLevel(logging.INFO)
    root_logger.addHandler(rotate_handler)
    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter('%(message)s'))
    root_logger.addHandler(console)

def log_debug(msg):
    if VERBOSE_LOGGING:
        logging.debug(msg)

def log_info(msg):
    logging.info(msg)

@contextlib.contextmanager
def quiet_external_output():
    if VERBOSE_LOGGING:
        yield
        return
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield

def get_writable_app_dir():
    if not getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(__file__))
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or os.path.expanduser("~")
    app_dir = os.path.join(root, APP_NAME)
    os.makedirs(app_dir, exist_ok=True)
    return app_dir

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

try:
    importlib.import_module("faiss")
    FAISS_AVAILABLE = True
except ImportError:
    FAISS_AVAILABLE = False

app = FastAPI(title="Formatura PRO API")

THUMB_SEMAPHORE = threading.Semaphore(4)
THUMB_QUEUE = []
THUMB_QUEUE_LOCK = threading.Lock()
THUMB_MAX_QUEUE = 50

def get_thumb_slot(timeout=0.5):
    acquired = THUMB_SEMAPHORE.acquire(timeout=timeout)
    if not acquired:
        with THUMB_QUEUE_LOCK:
            if len(THUMB_QUEUE) < THUMB_MAX_QUEUE:
                THUMB_QUEUE.append(time.time())
            else:
                raise HTTPException(429, "Too many thumbnail requests. Please wait.")
    return True

def release_thumb_slot():
    try:
        THUMB_SEMAPHORE.release()
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
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    return True

def sanitize_folder_name(name):
    """Remove caracteres inválidos para nomes de pastas no Windows/Linux/Mac."""
    if name is None:
        return "Desconhecido"
    # Garantir que seja string
    sanitized = str(name)
    # Caracteres proibidos no Windows: / \ : * ? " < > |
    invalid_chars = '/\\:*?"<>|'
    for char in invalid_chars:
        sanitized = sanitized.replace(char, "_")
    return sanitized.strip() or "Sem_Nome"

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

if hasattr(signal, 'SIGTERM'):
    signal.signal(signal.SIGTERM, graceful_shutdown)
if hasattr(signal, 'SIGINT'):
    signal.signal(signal.SIGINT, graceful_shutdown)
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

class AppState:
    current_catalog = ""

scan_state = {
    "is_scanning": False,
    "progress": 0.0,
    "status_text": "Pronto",
    "total_processadas": 0,
    "total_matches": 0,
    "total_clusters": 0,
    "total_files": 0,
    "last_folder_scanned": "",
    "eta_seconds": 0,
    "device": "",
    "gpu_error": "",
    "skipped_background_faces": 0,
    "scan_summary": None,
    "current_photo": None,
    "current_photo_index": 0,
    "recent_faces": [],
}

export_state = {
    "is_exporting": False,
    "progress": 0.0,
    "status_text": "Pronto",
    "total_files": 0,
    "processed_files": 0,
    "eta_seconds": 0,
    "export_summary": None,
    "undo_available": False
}

undo_export_state = {
    "last_export": None,
    "files_copied": [],
    "folders_created": [],
    "original_paths": {},
}

app_settings = load_app_settings()

manual_search_state = {
    "is_running": False,
    "progress": 0.0,
    "processed": 0,
    "total": 0,
    "status_text": "Pronto",
    "result": None,
    "error": "",
    "cancel_requested": False
}

quality_audit_state = {
    "is_auditing": False,
    "progress": 0.0,
    "processed": 0,
    "total": 0,
    "status_text": "Inativo"
}

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
        set_current_catalog=lambda value: setattr(AppState, "current_catalog", value),
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
        face_engine_device=lambda: face_engine_device,
        face_engine_gpu_error=lambda: face_engine_gpu_error,
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
        det_size=face_det_size,
    )

app_face = None
face_engine_device = ""
face_engine_gpu_error = ""
face_det_size = (640, 640)
faiss_index = None
ref_ids = []
LAST_BACKUPS = {}

min_face_area = 500
ref_match_threshold = 0.50

cluster_centers = []
cluster_names = []
cluster_counts = {}

_EMBEDDING_DISK_CACHE = {}
_EMBEDDING_DISK_CACHE_LOADED = False

def get_embedding_cache_path():
    return os.path.join(DATA_DIR, "embedding_cache_v2.db")

def load_embedding_disk_cache():
    global _EMBEDDING_DISK_CACHE, _EMBEDDING_DISK_CACHE_LOADED
    if _EMBEDDING_DISK_CACHE_LOADED:
        return
    _EMBEDDING_DISK_CACHE_LOADED = True
    cache_path = get_embedding_cache_path()
    if not os.path.exists(cache_path):
        return
    try:
        import pickle
        with open(cache_path, "rb") as f:
            _EMBEDDING_DISK_CACHE = pickle.load(f)
        log_info(f"Cache de embeddings carregado: {len(_EMBEDDING_DISK_CACHE)} entradas")
    except Exception as e:
        log_debug(f"Não foi possível carregar cache de embeddings: {e}")
        _EMBEDDING_DISK_CACHE = {}

def save_embedding_disk_cache():
    cache_path = get_embedding_cache_path()
    try:
        import pickle
        with open(cache_path + ".tmp", "wb") as f:
            pickle.dump(_EMBEDDING_DISK_CACHE, f)
        if os.path.exists(cache_path):
            os.remove(cache_path)
        os.rename(cache_path + ".tmp", cache_path)
        log_debug(f"Cache de embeddings salvo: {len(_EMBEDDING_DISK_CACHE)} entradas")
    except Exception as e:
        log_debug(f"Não foi possível salvar cache de embeddings: {e}")

def get_cached_embedding(path, x1, y1, x2, y2, mtime, size):
    key = (path, x1, y1, x2, y2, mtime, size)
    if key in _EMBEDDING_DISK_CACHE:
        log_debug(f"Embedding cache HIT: {path}")
        return _EMBEDDING_DISK_CACHE[key]
    return None

def set_cached_embedding(path, x1, y1, x2, y2, mtime, size, embedding):
    key = (path, x1, y1, x2, y2, mtime, size)
    _EMBEDDING_DISK_CACHE[key] = embedding
    if len(_EMBEDDING_DISK_CACHE) % 500 == 0:
        save_embedding_disk_cache()

def clear_embedding_cache():
    global _EMBEDDING_DISK_CACHE
    _EMBEDDING_DISK_CACHE = {}
    cache_path = get_embedding_cache_path()
    if os.path.exists(cache_path):
        try:
            os.remove(cache_path)
            log_info("Cache de embeddings limpo.")
        except Exception as e:
            log_debug(f"Erro ao limpar cache: {e}")

def get_scan_checkpoint(conn, scan_key):
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM scan_checkpoints WHERE scan_key = ?", (scan_key,))
        row = cur.fetchone()
        if row:
            return dict(row)
    except Exception as e:
        log_debug(f"Erro ao carregar checkpoint: {e}")
    return None

def save_scan_checkpoint(conn, scan_key, ori_path, ref_path, last_batch_index, total_batches):
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT OR REPLACE INTO scan_checkpoints 
            (scan_key, ori_path, ref_path, last_batch_index, total_batches, updated_at)
            VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
        """, (scan_key, ori_path, ref_path, last_batch_index, total_batches))
        conn.commit()
        if last_batch_index % 10 == 0:
            log_debug(f"Checkpoint salvo: batch {last_batch_index}/{total_batches}")
    except Exception as e:
        log_debug(f"Erro ao salvar checkpoint: {e}")

def clear_scan_checkpoint(conn, scan_key):
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM scan_checkpoints WHERE scan_key = ?", (scan_key,))
        conn.commit()
    except Exception as e:
        log_debug(f"Erro ao limpar checkpoint: {e}")

def sanitize_catalog_name(name):
    cleaned = "".join(
        ch for ch in (name or "").strip().replace(" ", "_")
        if ch.isalnum() or ch in ("_", "-", ".")
    ).strip("._")
    if not cleaned:
        raise HTTPException(400, "Nome de catalogo vazio ou invalido")
    return cleaned

def ensure_quality_columns(conn):
    c = conn.cursor()
    c.execute("PRAGMA table_info(ocorrencias)")
    columns = [row['name'] for row in c.fetchall()]
    modified = False
    if 'blur_score' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN blur_score REAL")
        modified = True
    if 'blur_status' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN blur_status TEXT")
        modified = True
    if 'closed_eyes' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN closed_eyes INTEGER")
        modified = True
    if 'created_at' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN created_at REAL")
        modified = True
    if 'photo_hash' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN photo_hash TEXT")
        modified = True
    if modified:
        conn.commit()

class DbConnection:
    def __init__(self, cat=None):
        self.cat = cat
        self.conn = None
        self.closed = False
    
    def __enter__(self):
        use_cat = sanitize_catalog_name(self.cat if self.cat else AppState.current_catalog)
        if not use_cat: raise HTTPException(400, "Nenhum catálogo/evento selecionado! Crie um novo primeiro!")
        db_path = os.path.join(CATALOG_DIR, f"{use_cat}.db")
        if os.path.commonpath([CATALOG_DIR, os.path.abspath(db_path)]) != CATALOG_DIR:
            raise HTTPException(400, "Nome de catalogo invalido")
        try:
            self.conn = sqlite3.connect(db_path, timeout=30)
            self.conn.row_factory = sqlite3.Row
        except Exception as e:
            log_info(f"FATAL: Erro ao conectar ao banco {db_path}: {e}")
            self.conn = None
            raise HTTPException(500, f"Falha ao abrir banco de dados: {e}")
        c = self.conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS ocorrencias (
                aluno_id TEXT,
                foto_path TEXT,
                x1 INTEGER,
                y1 INTEGER,
                x2 INTEGER,
                y2 INTEGER,
                blur_score REAL,
                blur_status TEXT,
                closed_eyes INTEGER
            )
        """)
        ensure_quality_columns(self.conn)
        c.execute("""
            CREATE TABLE IF NOT EXISTS alunos (
                aluno_id TEXT PRIMARY KEY,
                face_cache_path TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS discarded_photos (
                foto_path TEXT PRIMARY KEY,
                created_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS face_embeddings (
                occurrence_rowid INTEGER PRIMARY KEY,
                foto_path TEXT,
                x1 INTEGER,
                y1 INTEGER,
                x2 INTEGER,
                y2 INTEGER,
                mtime_ns INTEGER,
                size INTEGER,
                embedding BLOB,
                updated_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS scan_checkpoints (
                scan_key TEXT PRIMARY KEY,
                ori_path TEXT,
                ref_path TEXT,
                last_batch_index INTEGER,
                total_batches INTEGER,
                created_at REAL DEFAULT (strftime('%s','now')),
                updated_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno ON ocorrencias(aluno_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto ON ocorrencias(foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto_path ON ocorrencias(foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_photo_hash ON ocorrencias(photo_hash)")
        c.execute("""
            CREATE TABLE IF NOT EXISTS export_history (
                uuid TEXT PRIMARY KEY,
                dest_path TEXT,
                mode TEXT,
                files_json TEXT,
                folders_json TEXT,
                timestamp TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_face_embeddings_path ON face_embeddings(foto_path)")
        c.execute("""
            CREATE TABLE IF NOT EXISTS unknown_face_clusters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cluster_id TEXT NOT NULL,
                face_id INTEGER,
                original_path TEXT,
                confidence REAL,
                created_at REAL DEFAULT (strftime('%s','now')),
                updated_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_ufc_cluster_id ON unknown_face_clusters(cluster_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ufc_original_path ON unknown_face_clusters(original_path)")
        try:
            c.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_ocor_unique
                ON ocorrencias(aluno_id, foto_path, x1, y1, x2, y2)
            """)
        except sqlite3.IntegrityError:
            c.execute("""
                DELETE FROM ocorrencias
                WHERE rowid NOT IN (
                    SELECT MIN(rowid)
                    FROM ocorrencias
                    GROUP BY aluno_id, foto_path, x1, y1, x2, y2
                )
            """)
            c.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_ocor_unique
                ON ocorrencias(aluno_id, foto_path, x1, y1, x2, y2)
            """)
        self.conn.commit()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.conn and not self.closed:
            self.conn.close()
            self.closed = True
        return False
    
    def cursor(self):
        if self.conn is None:
            log_info("ERRO CRITICO: Tentativa de obter cursor em banco nao inicializado.")
            raise HTTPException(500, "Banco de dados nao inicializado corretamente.")
        return self.conn.cursor()
    
    def commit(self):
        return self.conn.commit()
    
    def close(self):
        if self.conn and not self.closed:
            self.conn.close()
            self.closed = True


def get_db(cat=None) -> DbConnection:
    return DbConnection(cat)

def catalog_db_path(cat=None):
    use_cat = sanitize_catalog_name(cat if cat else AppState.current_catalog)
    return os.path.join(CATALOG_DIR, f"{use_cat}.db")

def backup_catalog_db(cat=None, reason="backup"):
    try:
        use_cat = sanitize_catalog_name(cat if cat else AppState.current_catalog)
        key = (use_cat, reason)
        now = time.time()
        recent = LAST_BACKUPS.get(key)
        if recent and now - recent["time"] < 20 and os.path.exists(recent["path"]):
            return recent["path"]
        src = catalog_db_path(use_cat)
        if not os.path.exists(src):
            return ""
        safe_reason = sanitize_catalog_name(reason)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        dest = os.path.join(BACKUP_DIR, f"{use_cat}_{safe_reason}_{stamp}.db.bak")
        shutil.copy2(src, dest)
        LAST_BACKUPS[key] = {"time": now, "path": dest}
        return dest
    except Exception as e:
        print(f"Falha criando backup do catálogo: {e}")
        return ""

@app.get("/api/catalogs")
def list_catalogs():
    return cm.list_catalogs()

SetCatalogReq = cm.SetCatalogReq

@app.post("/api/catalogs/set")
def set_catalog(req: SetCatalogReq):
    return cm.set_catalog(req)

RenameCatalogReq = cm.RenameCatalogReq

@app.post("/api/catalogs/rename")
def rename_catalog(req: RenameCatalogReq):
    return cm.rename_catalog(req)

@app.post("/api/catalogs/delete")
def delete_catalog(req: SetCatalogReq):
    return cm.delete_catalog(req)

@app.get("/api/catalogs/settings")
def get_catalog_settings(catalog: str = ""):
    try:
        with cm.get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT scan_paths, root_path FROM catalog_settings WHERE catalog_name = ?", (catalog,))
            row = cur.fetchone()
            if row:
                return {
                    "catalog": catalog,
                    "scan_paths": row[0].split("|") if row[0] else [],
                    "root_path": row[1] or "",
                    "quality": {},
                    "scanner": {},
                    "export": {},
                    "ui": {}
                }
            return {
                "catalog": catalog,
                "scan_paths": [],
                "root_path": "",
                "quality": {},
                "scanner": {},
                "export": {},
                "ui": {}
            }
    except Exception as e:
        return {
            "catalog": catalog,
            "scan_paths": [],
            "root_path": "",
            "quality": {},
            "scanner": {},
            "export": {},
            "ui": {}
        }

class CatalogSettingsReq(BaseModel):
    catalog: str
    scan_paths: list = []
    root_path: str = ""

@app.post("/api/catalogs/settings")
def save_catalog_settings(req: CatalogSettingsReq):
    try:
        with cm.get_db(req.catalog) as conn:
            cur = conn.cursor()
            scan_paths_str = "|".join(req.scan_paths) if req.scan_paths else ""
            cur.execute("""
                INSERT OR REPLACE INTO catalog_settings (catalog_name, scan_paths, root_path)
                VALUES (?, ?, ?)
            """, (req.catalog, scan_paths_str, req.root_path or ""))
            conn.commit()
        return {"success": True, "catalog": req.catalog}
    except Exception as e:
        print(f"Erro ao salvar configurações do catálogo: {e}")
        return {"success": False, "error": str(e)}

@app.get("/api/search/global")
def global_search(q: str = ""):
    return pdm.global_search(q)

@app.get("/api/people")
def get_people(unknown: bool = False):
    return pdm.get_people(unknown)

@app.get("/api/photos/all")
def get_all_photos(limit: int = 1000):
    return pdm.get_all_photos(limit)

@app.get("/api/photos/{aluno_id}")
def get_photos(aluno_id: str):
    return pdm.get_photos(aluno_id)

qa.configure(
    load_pil_with_orientation=mm.load_pil_with_orientation,
    load_quality_settings=load_quality_settings,
    log_debug=log_debug,
    log_info=log_info,
)
qa_load_caches_from_disk()

@app.get("/api/pendencies")
def get_pendencies(catalog: str = "", mode: str = "all"):
    return mm.get_pendencies(catalog, mode)

@app.get("/api/unknown-clusters")
def get_unknown_clusters(
    catalog: str = "",
    min_score: float = 0.58,
    min_cluster_size: int = 2,
    limit: int = 80
):
    return rm.get_unknown_clusters(catalog, min_score, min_cluster_size, limit)

@app.get("/api/review/unknown-clusters")
def get_review_unknown_clusters(
    catalog: str = "",
    min_score: float = 0.58,
    min_cluster_size: int = 2,
    limit: int = 100
):
    return rm.get_unknown_clusters(catalog, min_score, min_cluster_size, limit)

AssignUnknownClusterRequest = rm.AssignUnknownClusterRequest

@app.post("/api/review/unknown-clusters/assign")
def assign_cluster(req: AssignUnknownClusterRequest):
    payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    print("[assign_unknown_cluster] payload:", payload, flush=True)
    try:
        return rm.assign_cluster(req)
    except HTTPException as e:
        return JSONResponse(
            status_code=e.status_code,
            content={
                "ok": False,
                "error": "assign_unknown_cluster_http_error",
                "detail": str(e.detail),
            },
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        logging.getLogger(__name__).exception("[assign_unknown_cluster] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "assign_unknown_cluster_failed",
                "detail": str(e),
            },
        )

@app.get("/api/culling/analyze/{aluno_id}")
def analyze_culling(aluno_id: str, catalog: str = ""):
    return mm.analyze_culling(aluno_id, catalog)

@app.get("/api/photo-info")
def get_photo_info(path: str, catalog: str = ""):
    try:
        import urllib.parse
        decoded_path = urllib.parse.unquote(path)
        if not os.path.exists(decoded_path):
            return {"faces": [], "discarded": False}
        
        get_db = pdm._get("get_db")
        if not get_db:
            return {"faces": [], "discarded": False}
        
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute("SELECT discarded FROM fotos WHERE path = ?", (decoded_path,))
            row = cur.fetchone()
            discarded = bool(row["discarded"]) if row else False
            
            cur.execute("""
                SELECT x1, y1, x2, y2, aluno_id FROM ocorrencias 
                WHERE foto_path = ? AND aluno_id IS NOT NULL
            """, (decoded_path,))
            faces = []
            for f in cur.fetchall():
                if f["x1"] is not None:
                    faces.append({
                        "box": [f["x1"], f["y1"], f["x2"], f["y2"]],
                        "name": f["aluno_id"]
                    })
        
        return {"faces": faces, "discarded": discarded}
    except Exception as e:
        return {"faces": [], "discarded": False}

@app.get("/api/image_thumb")
def get_image_thumb(path: str, size: int=300):
    try:
        get_thumb_slot()
        return mm.get_image_thumb(path, size)
    finally:
        release_thumb_slot()

@app.get("/api/thumb")
def get_thumb(path: str, x1: int, y1: int, x2: int, y2: int, size: int=120, expand: float=0.35):
    try:
        get_thumb_slot()
        return mm.get_thumb(path, x1, y1, x2, y2, size, expand)
    finally:
        release_thumb_slot()

@app.get("/api/image")
def get_image(path: str = Query(...)):
    return mm.get_image(path)

@app.get("/api/image/resized")
def get_image_resized(path: str = Query(...), max_size: int = 1200):
    return mm.get_image_resized(path, max_size)

@app.get("/api/explorer/ls")
def explorer_ls(path: str = "", catalog: str = ""):
    return mm.explorer_ls(path, catalog)

ManualIdentifyReq = rm.ManualIdentifyReq
ManualSearchReq = rm.ManualSearchReq

@app.post("/api/manual_identify")
def manual_identify(req: ManualIdentifyReq):
    return rm.manual_identify(req)

@app.get("/api/select-folder")
def select_folder():
    return im.select_folder()

@app.get("/api/select-image")
def select_image():
    return im.select_image()

@app.get("/api/folder-stats")
def folder_stats(path: str = Query(...)):
    return rm.folder_stats(path)

@app.post("/api/manual-search-photo")
def manual_search_photo(req: ManualSearchReq):
    return rm.run_manual_search(req, update_state=False)

@app.post("/api/manual-search/start")
def start_manual_search(req: ManualSearchReq):
    return rm.start_manual_search(req)

@app.get("/api/manual-search/status")
def get_manual_search_status():
    return rm.get_manual_search_status()

@app.post("/api/manual-search/cancel")
def cancel_manual_search():
    return rm.cancel_manual_search()

@app.get("/api/suggestions")
def get_suggestions(aluno_id: str):
    return rm.get_suggestions(aluno_id)

RenameReq = rm.RenameReq

@app.post("/api/rename-person")
def rename_person(req: RenameReq):
    return rm.rename_person(req)

DeletePersonReq = rm.DeletePersonReq

@app.post("/api/delete-person")
def delete_person(req: DeletePersonReq):
    try:
        return rm.delete_person(req)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

DeletePhotoReq = rm.DeletePhotoReq

@app.post("/api/delete-photo")
def delete_photo(req: DeletePhotoReq):
    return rm.delete_photo(req)

DiscardPhotoReq = rm.DiscardPhotoReq
QualitySettingsReq = rm.QualitySettingsReq

@app.get("/api/settings/quality")
def get_quality_settings():
    return rm.get_quality_settings()

@app.post("/api/settings/quality")
def update_quality_settings(req: QualitySettingsReq):
    return rm.update_quality_settings(req)

@app.post("/api/cache/clear")
def clear_cache():
    return rm.clear_cache()

@app.post("/api/logs/open")
def open_logs():
    return am.open_logs()

@app.post("/api/app-folder/open")
def open_app_folder():
    return am.open_app_folder()

@app.post("/api/catalog/backup")
def create_catalog_backup(reason: str = Query("manual")):
    return am.create_catalog_backup(reason)

@app.get("/api/event/problems-report")
def event_problems_report(catalog: str = ""):
    return am.event_problems_report(catalog)

@app.post("/api/discard-photo")
def discard_photo(req: DiscardPhotoReq):
    return am.discard_photo(req)

@app.post("/api/clear-db")
def clear_db():
    return am.clear_db()

ExportReq = ex.ExportReq

def build_export_worklist(conn, req: ExportReq):
    return ex.build_export_worklist(conn, req)

def export_report_paths(dest_path: str):
    return ex.export_report_paths(dest_path)

def count_export_destination(dest_path: str):
    return ex.count_export_destination(dest_path)

@app.post("/api/export/check-conflicts")
def check_export_conflicts(req: ExportReq):
    return ex.check_export_conflicts(req)

@app.post("/api/export/quality")
def export_quality(req: ExportReq):
    return ex.export_quality(req)

@app.get("/api/export/history")
def get_export_history():
    return {"history": ex.load_export_history()}

@app.get("/api/gpu/diagnostics")
def gpu_diagnostics():
    return sm.gpu_diagnostics()

@app.get("/api/system/status")
def system_status():
    return sm.system_status()

@app.get("/api/settings")
def get_settings():
    return sm.get_settings()

SettingsUpdate = sm.SettingsUpdate

@app.post("/api/settings")
def update_settings(req: SettingsUpdate):
    return sm.update_settings(req)

@app.get("/api/stats")
def get_stats(catalog: str = ""):
    return sm.get_stats(catalog)

@app.get("/api/catalog/export")
def export_catalog_json(catalog: str = ""):
    return cdm.export_catalog_json(catalog)

ImportCatalogReq = cdm.ImportCatalogReq

@app.post("/api/catalog/import")
def import_catalog_json(req: ImportCatalogReq):
    return cdm.import_catalog_json(req)

MarkAbsentReq = cdm.MarkAbsentReq

@app.post("/api/people/mark-absent")
def mark_people_absent(req: MarkAbsentReq):
    return cdm.mark_people_absent(req)

@app.get("/api/people/absent")
def get_absent_people():
    return cdm.get_absent_people()

@app.post("/api/export/undo")
def undo_last_export():
    return ex.undo_last_export()

@app.post("/api/export/start")
def start_export(req: ExportReq):
    return ex.start_export(req)

@app.get("/api/export/status")
def get_export_status():
    return ex.get_export_status()

@app.post("/api/export/clear_summary")
def clear_export_summary():
    return ex.clear_export_summary()

class OpenFolderReq(BaseModel):
    path: str

@app.post("/api/open-folder")
def open_folder(req: OpenFolderReq):
    return im.open_folder(req.path)

@app.post("/api/open-photoshop")
def open_photoshop(req: OpenFolderReq):
    return im.open_photoshop(req.path)

@app.post("/api/open-file")
def open_file(req: OpenFolderReq):
    return im.open_file(req.path)

@app.post("/api/scan/precheck")
def scan_precheck(req: scm.ScanRequest):
    return scm.scan_precheck(req)

@app.post("/api/scan/clear-checkpoints")
def clear_checkpoints(req: dict):
    return scm.clear_checkpoints(req)

@app.post("/api/scan/start")
def start_scan(req: scm.ScanRequest):
    return scm.start_scan(req)

@app.get("/api/scan/status")
def get_scan_status():
    return scm.get_scan_status()

@app.post("/api/scan/clear_summary")
def clear_scan_summary():
    return scm.clear_scan_summary()

@app.post("/api/scan/stop")
def stop_scan():
    return scm.stop_scan()

@app.post("/api/scan/quality_fill")
def start_quality_audit(req: dict):
    return scm.start_quality_audit(req)

@app.get("/api/scan/quality_audit_status")
def get_quality_audit_status():
    return scm.get_quality_audit_status()

@app.post("/api/app/exit")
def exit_app():
    return scm.exit_app()

@app.get("/api/catalog")
def get_catalog():
    return am.get_catalog()

@app.get("/api/drafts")
def get_drafts(catalog: str = "", path: str = ""):
    return am.get_drafts(catalog, path)

@app.get("/api/discard-candidates")
def get_discard_candidates(catalog: str = ""):
    return mm.get_discard_candidates(catalog)

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
                    # Tenta dar um sinal 0 (apenas verifica existência no Windows)
                    try:
                        if parent_pid > 0:
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
