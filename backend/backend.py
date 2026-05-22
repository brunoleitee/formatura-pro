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
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
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


def ensure_alunos_class_column(conn):
    cur = conn.cursor()
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
        if cur.fetchone() is None:
            return True
        cur.execute("PRAGMA table_info(alunos)")
        cols = [row[1] for row in cur.fetchall()]
        if "class_name" not in cols:
            cur.execute("ALTER TABLE alunos ADD COLUMN class_name TEXT DEFAULT 'Sem turma'")
        cur.execute("UPDATE alunos SET class_name = COALESCE(NULLIF(TRIM(class_name), ''), 'Sem turma')")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return True


def ensure_identity_columns(conn):
    cur = conn.cursor()
    try:
        # Alunos table - only alter if it exists
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
        has_alunos = cur.fetchone() is not None
        if has_alunos:
            cur.execute("PRAGMA table_info(alunos)")
            cols = [row[1] for row in cur.fetchall()]
            if "person_key" not in cols:
                cur.execute("ALTER TABLE alunos ADD COLUMN person_key TEXT DEFAULT ''")
            if "reference_folder" not in cols:
                cur.execute("ALTER TABLE alunos ADD COLUMN reference_folder TEXT DEFAULT ''")

            # Migration: recriar tabela com person_key como PK
            # Verificar se ainda usa aluno_id como PK (formato antigo)
            pk_col = None
            for row in cur.execute("PRAGMA table_info(alunos)"):
                if row[5] == 1:  # pk flag
                    pk_col = row[1]
                    break
            if pk_col == "aluno_id":
                _migrate_alunos_to_person_key_pk(conn, cur, cols)

        # Ocorrencias table - always exists
        cur.execute("PRAGMA table_info(ocorrencias)")
        cols = [row[1] for row in cur.fetchall()]
        if "person_key" not in cols:
            cur.execute("ALTER TABLE ocorrencias ADD COLUMN person_key TEXT DEFAULT ''")
        if "reference_folder" not in cols:
            cur.execute("ALTER TABLE ocorrencias ADD COLUMN reference_folder TEXT DEFAULT ''")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key ON ocorrencias(person_key)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key_aluno ON ocorrencias(person_key, aluno_id)")

        # Garantir UNIQUE constraint em (foto_path, x1, y1, x2, y2) para ON CONFLICT funcionar
        _ensure_ocorrencias_unique(cur)

        # Backfill person_key vazio em ocorrências usando alunos como referência
        _backfill_ocorrencias_person_key(cur)

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return True


def _backfill_ocorrencias_person_key(cur):
    """Atualiza person_key vazio em ocorrências usando a tabela alunos como referência."""
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
        if not cur.fetchone():
            return
        cur.execute("SELECT COUNT(*) FROM ocorrencias WHERE person_key IS NULL OR TRIM(person_key) = ''")
        count = cur.fetchone()[0]
        if count == 0:
            return
        logging.getLogger(__name__).info("[migration] Backfilling person_key em %d ocorrencias", count)

        # Mapear aluno_id -> person_key (quando há apenas 1 aluno com esse nome)
        cur.execute("""
            SELECT aluno_id, person_key FROM alunos
            WHERE person_key IS NOT NULL AND TRIM(person_key) != ''
              AND aluno_id IS NOT NULL AND TRIM(aluno_id) != ''
        """)
        name_to_pk = {}
        ambiguous = set()
        for row in cur.fetchall():
            aid = row[0]
            pk = row[1]
            if aid in name_to_pk and name_to_pk[aid] != pk:
                ambiguous.add(aid)
            else:
                name_to_pk[aid] = pk

        # Atualizar ocorrências com person_key vazio (apenas nomes não-ambíguos)
        updated = 0
        for aid, pk in name_to_pk.items():
            if aid in ambiguous:
                continue
            cur.execute(
                "UPDATE ocorrencias SET person_key = ? WHERE aluno_id = ? AND (person_key IS NULL OR TRIM(person_key) = '')",
                (pk, aid),
            )
            updated += cur.rowcount

        if updated:
            logging.getLogger(__name__).info("[migration] person_key atualizado em %d ocorrencias", updated)
        if ambiguous:
            logging.getLogger(__name__).info(
                "[migration] %d nomes ambíguos (mesmo nome em turmas diferentes) precisam de re-scan: %s",
                len(ambiguous), ", ".join(sorted(ambiguous)[:5])
            )
    except Exception as e:
        logging.getLogger(__name__).warning("[migration] Backfill person_key falhou: %s", e)


def _ensure_ocorrencias_unique(cur):
    """Garante UNIQUE constraint em (foto_path, x1, y1, x2, y2) removendo duplicatas se necessário."""
    # Verificar se já existe constraint UNIQUE
    cur.execute("PRAGMA index_list(ocorrencias)")
    indexes = cur.fetchall()
    has_unique = False
    for idx in indexes:
        idx_name = idx[1]
        is_unique = idx[2]  # 1 = UNIQUE
        if is_unique:
            cur.execute(f"PRAGMA index_info({idx_name})")
            cols = [row[2] for row in cur.fetchall()]
            if set(cols) == {"foto_path", "x1", "y1", "x2", "y2"}:
                has_unique = True
                break

    if has_unique:
        return

    logging.getLogger(__name__).info("[migration] Adicionando UNIQUE constraint em ocorrencias(foto_path, x1, y1, x2, y2)")

    # Remover duplicatas: manter o registro com person_key preenchido ou o mais recente
    cur.execute("""
        DELETE FROM ocorrencias WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM ocorrencias
            GROUP BY foto_path, x1, y1, x2, y2
        )
    """)
    removed = cur.rowcount
    if removed:
        logging.getLogger(__name__).info("[migration] Removidas %d duplicatas de ocorrencias", removed)

    # Criar tabela temporária com constraint UNIQUE, copiar dados, substituir
    cur.execute("DROP TABLE IF EXISTS ocorrencias_new")

    # Construir CREATE TABLE dinamicamente a partir da estrutura existente
    cur.execute("PRAGMA table_info(ocorrencias)")
    col_defs = []
    for row in cur.fetchall():
        cname, ctype, notnull, dflt, pk = row[1], row[2], row[3], row[4], row[5]
        parts = f"{cname} {ctype}"
        if notnull:
            parts += " NOT NULL"
        if dflt is not None:
            parts += f" DEFAULT {dflt}"
        col_defs.append(parts)
    col_defs.append("UNIQUE(foto_path, x1, y1, x2, y2)")

    cur.execute(f"CREATE TABLE ocorrencias_new ({', '.join(col_defs)})")

    # Copiar dados existentes
    existing_cols = [row[1] for row in cur.execute("PRAGMA table_info(ocorrencias)").fetchall()]
    col_list = ", ".join(existing_cols)
    cur.execute(f"INSERT OR IGNORE INTO ocorrencias_new ({col_list}) SELECT {col_list} FROM ocorrencias")

    # Substituir tabela
    cur.execute("DROP TABLE ocorrencias")
    cur.execute("ALTER TABLE ocorrencias_new RENAME TO ocorrencias")

    # Recriar índices
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto ON ocorrencias(foto_path)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key ON ocorrencias(person_key)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key_aluno ON ocorrencias(person_key, aluno_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno_foto ON ocorrencias(aluno_id, foto_path)")

    logging.getLogger(__name__).info("[migration] UNIQUE constraint adicionado em ocorrencias")


def _migrate_alunos_to_person_key_pk(conn, cur, existing_cols):
    """Recria tabela alunos com person_key como PK para permitir formandos com mesmo nome em turmas diferentes."""
    import scanner_engine as _se

    # Coletar todos os dados existentes
    cur.execute("SELECT * FROM alunos")
    rows = cur.fetchall()
    col_names = [d[0] for d in cur.description]

    # Descobrir quais colunas extras existem além das base
    base_cols = {"aluno_id", "face_cache_path", "class_name", "person_key", "reference_folder"}
    extra_cols = [c for c in col_names if c not in base_cols]
    all_new_cols = ["person_key", "aluno_id", "face_cache_path", "class_name", "reference_folder"] + extra_cols

    # Criar tabela nova
    extra_col_defs = []
    for c in extra_cols:
        # Buscar tipo da coluna original
        col_type = "TEXT"
        for row in cur.execute("PRAGMA table_info(alunos)"):
            if row[1] == c:
                col_type = row[2] or "TEXT"
                break
        default_val = ""
        for row in cur.execute("PRAGMA table_info(alunos)"):
            if row[1] == c and row[4] is not None:
                default_val = f" DEFAULT {row[4]}"
                break
        extra_col_defs.append(f", {c} {col_type}{default_val}")

    extra_sql = "".join(extra_col_defs)
    cur.execute(f"""
        CREATE TABLE alunos_new (
            person_key TEXT PRIMARY KEY,
            aluno_id TEXT,
            face_cache_path TEXT,
            class_name TEXT DEFAULT 'Sem turma',
            reference_folder TEXT DEFAULT ''{extra_sql}
        )
    """)

    # Migrar dados
    migrated = 0
    for row in rows:
        data = dict(zip(col_names, row))
        aluno_id = data.get("aluno_id", "")
        class_name = str(data.get("class_name", "") or "").strip() or "Sem turma"
        person_key = str(data.get("person_key", "") or "").strip()
        reference_folder = str(data.get("reference_folder", "") or "").strip()
        face_cache_path = data.get("face_cache_path", "n/a")

        # Gerar person_key se vazio
        if not person_key:
            if aluno_id == "system_catalog":
                person_key = "__SYSTEM_CATALOG__"
            else:
                person_key = _se.make_person_key(
                    class_name=class_name,
                    reference_folder=reference_folder or class_name,
                    student_id=aluno_id,
                )

        # Construir VALUES
        vals = [person_key, aluno_id, face_cache_path, class_name, reference_folder]
        for c in extra_cols:
            vals.append(data.get(c, None))

        placeholders = ",".join(["?"] * len(vals))
        col_list = ",".join(all_new_cols)
        try:
            cur.execute(f"INSERT OR IGNORE INTO alunos_new ({col_list}) VALUES ({placeholders})", vals)
            migrated += 1
        except Exception:
            pass

    # Substituir tabela
    cur.execute("DROP TABLE alunos")
    cur.execute("ALTER TABLE alunos_new RENAME TO alunos")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_alunos_aluno_id ON alunos(aluno_id)")
    conn.commit()
    logging.getLogger(__name__).info(
        "[migration] alunos: PK migrada de aluno_id para person_key (%d registros)", migrated
    )

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

class AppState:
    current_catalog = _load_last_catalog()

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
    "provider": "",
    "gpu_error": "",
    "skipped_background_faces": 0,
    "total_found_files": 0,
    "total_valid_files": 0,
    "total_existing_files": 0,
    "total_inserted_files": 0,
    "total_ignored_files": 0,
    "duplicate_count": 0,
    "duplicate_percent": 0.0,
    "ignored_reasons": {},
    "scan_summary": None,
    "current_photo": None,
    "current_photo_index": 0,
    "recent_faces": [],
    "started_at": None,
    "processing_history": [], # Para cálculo de ETA real
}

export_state = {
    "is_exporting": False,
    "progress": 0.0,
    "status_text": "Pronto",
    "total_files": 0,
    "processed_files": 0,
    "eta_seconds": 0,
    "export_summary": None,
    "export_id": "",
    "export_dir": "",
    "pdf_path": "",
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

graduation_analysis_state = {
    "is_running": False,
    "running": False,
    "progress": 0.0,
    "processed": 0,
    "total": 0,
    "updated": 0,
    "status_text": "Inativo",
    "catalog": "",
    "result": None,
    "error": None,
    "started_at": None,
    "finished_at": None,
}

quality_audit_state = {
    "status": "idle",
    "running": False,
    "enabled": False,
    "is_auditing": False,
    "progress": 0.0,
    "processed": 0,
    "total": 0,
    "status_text": "Quality audit não iniciado",
    "message": "Quality audit não iniciado",
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

def _table_exists(conn, table_name):
    cur = conn.cursor()
    cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?) LIMIT 1",
        (table_name,),
    )
    return cur.fetchone() is not None


def _table_columns(conn, table_name):
    if not table_name.isidentifier():
        raise ValueError(f"Nome de tabela inválido: {table_name}")
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table_name})")
    return [row["name"] for row in cur.fetchall()]


def _safe_add_column(conn, table_name, column_name, definition):
    if not _table_exists(conn, table_name):
        return False
    columns = _table_columns(conn, table_name)
    if column_name in columns:
        return False
    try:
        conn.cursor().execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")
        return True
    except Exception:
        return False


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
    if 'has_gown' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN has_gown INTEGER")
        modified = True
    if 'has_diploma' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN has_diploma INTEGER")
        modified = True
    if 'has_sash' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN has_sash INTEGER")
        modified = True
    if 'has_cap' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN has_cap INTEGER")
        modified = True
    if 'face_front_score' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN face_front_score REAL")
        modified = True
    if 'graduation_score' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN graduation_score REAL")
        modified = True
    if 'graduation_tags' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN graduation_tags TEXT")
        modified = True
    if 'foreground_score' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN foreground_score REAL")
        modified = True
    if 'is_foreground' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN is_foreground INTEGER DEFAULT 1")
        modified = True
    if 'face_area_ratio' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN face_area_ratio REAL")
        modified = True
    if 'center_score' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN center_score REAL")
        modified = True
    if 'background_penalty_reason' not in columns:
        c.execute("ALTER TABLE ocorrencias ADD COLUMN background_penalty_reason TEXT")
        modified = True
    if modified:
        conn.commit()


def ensure_graduation_columns(conn):
    modified = False
    graduation_defs = (
        ("has_gown", "INTEGER DEFAULT 0"),
        ("has_diploma", "INTEGER DEFAULT 0"),
        ("has_sash", "INTEGER DEFAULT 0"),
        ("has_cap", "INTEGER DEFAULT 0"),
        ("has_jabor", "INTEGER DEFAULT 0"),
        ("graduation_tags", "TEXT DEFAULT '[]'"),
        ("ai_graduation_tags", "TEXT DEFAULT '[]'"),
        ("graduation_score", "REAL DEFAULT 0"),
        ("graduation_analyzed_at", "TEXT"),
        ("gown_confidence", "REAL DEFAULT 0"),
        ("diploma_confidence", "REAL DEFAULT 0"),
        ("sash_confidence", "REAL DEFAULT 0"),
        ("cap_confidence", "REAL DEFAULT 0"),
        ("jabor_confidence", "REAL DEFAULT 0"),
        ("graduation_reviewed", "INTEGER DEFAULT 0"),
        ("manual_graduation_tags", "TEXT DEFAULT '[]'"),
    )

    for table_name in ("photos", "fotos", "ocorrencias"):
        if not _table_exists(conn, table_name):
            continue
        for column_name, definition in graduation_defs:
            if _safe_add_column(conn, table_name, column_name, definition):
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
                closed_eyes INTEGER,
                has_gown INTEGER,
                has_diploma INTEGER,
                has_sash INTEGER,
                has_cap INTEGER,
                face_front_score REAL,
                graduation_score REAL,
                graduation_tags TEXT DEFAULT '[]',
                graduation_analyzed_at TEXT,
                foreground_score REAL,
                is_foreground INTEGER DEFAULT 1,
                face_area_ratio REAL,
                center_score REAL,
                background_penalty_reason TEXT
            )
        """)
        ensure_quality_columns(self.conn)
        ensure_graduation_columns(self.conn)
        ensure_identity_columns(self.conn)
        c.execute("""
            CREATE TABLE IF NOT EXISTS alunos (
                person_key TEXT PRIMARY KEY,
                aluno_id TEXT,
                face_cache_path TEXT,
                class_name TEXT DEFAULT 'Sem turma',
                reference_folder TEXT DEFAULT ''
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_alunos_aluno_id ON alunos(aluno_id)")
        ensure_alunos_class_column(self.conn)
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
        c.execute("""
            CREATE TABLE IF NOT EXISTS photo_meta (
                foto_path TEXT PRIMARY KEY,
                rating INTEGER DEFAULT 0,
                favorite INTEGER DEFAULT 0
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
        c.execute("CREATE INDEX IF NOT EXISTS idx_ufc_face_id ON unknown_face_clusters(face_id)")
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
        c.execute("""
            CREATE TABLE IF NOT EXISTS catalog_settings (
                catalog_name TEXT PRIMARY KEY,
                scan_paths TEXT DEFAULT '',
                root_path TEXT DEFAULT '',
                selected_folders TEXT DEFAULT '{}'
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS catalog_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                catalog_name TEXT NOT NULL,
                path TEXT NOT NULL,
                include_subfolders INTEGER DEFAULT 1,
                photo_count INTEGER DEFAULT 0,
                last_scan_at REAL,
                status TEXT DEFAULT 'active',
                folder_type TEXT DEFAULT 'event',
                created_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_folder_unique ON catalog_folders(catalog_name, path)")
        # Indexes for query performance on stats/people/review endpoints
        c.execute("CREATE INDEX IF NOT EXISTS idx_discarded_foto ON discarded_photos(foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_photo_meta_foto ON photo_meta(foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_x1 ON ocorrencias(x1)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno_foto ON ocorrencias(aluno_id, foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto_aluno ON ocorrencias(foto_path, aluno_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_alunos_id_class ON alunos(aluno_id, class_name)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_blur_foto ON ocorrencias(blur_status, foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ufc_cluster_face ON unknown_face_clusters(cluster_id, face_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno_x1 ON ocorrencias(aluno_id, x1)")
        # Migration: add folder_type column if missing
        try:
            c.execute("ALTER TABLE catalog_folders ADD COLUMN folder_type TEXT DEFAULT 'event'")
        except Exception:
            pass
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
    _invalidate_stats_caches()
    return cm.rename_catalog(req)

@app.post("/api/catalogs/delete")
def delete_catalog(req: SetCatalogReq):
    return cm.delete_catalog(req)

@app.get("/api/catalogs/settings")
def get_catalog_settings(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT scan_paths, root_path, selected_folders FROM catalog_settings WHERE catalog_name = ?", (catalog,))
            row = cur.fetchone()
            selected_folders = {}
            if row and row[2]:
                try:
                    selected_folders = json.loads(row[2])
                except Exception:
                    selected_folders = {}
            if row:
                return {
                    "catalog": catalog,
                    "scan_paths": row[0].split("|") if row[0] else [],
                    "root_path": row[1] or "",
                    "selected_folders": selected_folders,
                    "quality": {},
                    "scanner": {},
                    "export": {},
                    "ui": {}
                }
            return {
                "catalog": catalog,
                "scan_paths": [],
                "root_path": "",
                "selected_folders": {},
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
            "selected_folders": {},
            "quality": {},
            "scanner": {},
            "export": {},
            "ui": {}
        }

class CatalogSettingsReq(BaseModel):
    catalog: str
    scan_paths: list = []
    root_path: str = ""
    selected_folders: dict = {}

@app.post("/api/catalogs/settings")
def save_catalog_settings(req: CatalogSettingsReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            scan_paths_str = "|".join(req.scan_paths) if req.scan_paths else ""
            selected_folders_str = json.dumps(req.selected_folders) if req.selected_folders else ""
            cur.execute("""
                INSERT OR REPLACE INTO catalog_settings (catalog_name, scan_paths, root_path, selected_folders)
                VALUES (?, ?, ?, ?)
            """, (req.catalog, scan_paths_str, req.root_path or "", selected_folders_str))
            conn.commit()
        return {"success": True, "catalog": req.catalog}
    except Exception as e:
        print(f"Erro ao salvar configurações do catálogo: {e}")
        return {"success": False, "error": str(e)}

# ── Catalog Folders Management ──

class AddCatalogFolderReq(BaseModel):
    catalog: str
    path: str
    include_subfolders: bool = True
    scan_immediately: bool = False
    folder_type: str = "event"

class RemoveCatalogFolderReq(BaseModel):
    catalog: str
    folder_id: int

import re

def _is_junk_path(p: str) -> bool:
    """True only if p is a drive root or a top-level system directory by itself."""
    if not p or len(p) < 2:
        return True
    norm = p.strip().rstrip("\\/")
    # Drive root: C: or C:\
    if re.match(r'^[a-zA-Z]:\\?$', norm):
        return True
    # UNC root or Unix root
    if norm in ('/', '\\\\'):
        return True
    # Single-part names that are system dirs
    base = os.path.basename(norm).lower()
    if base in ('users', 'desktop', 'documents', 'downloads', 'windows',
                'program files', 'program files (x86)', 'programdata',
                'appdata', 'system32', 'syswow64', 'perflogs',
                'recovery', '$recycle.bin', 'system volume information',
                'bin', 'etc', 'usr', 'var', 'opt', 'tmp', 'home', 'root', 'lib', 'sbin',
                'dev', 'proc', 'run', 'mnt', 'media', 'lost+found',
                '.git', '.github', 'node_modules', '__pycache__', '.cache'):
        # Só rejeita se for o path inteiro ou se o pai for raiz do drive
        parent = os.path.dirname(norm.rstrip("\\/"))
        return re.match(r'^[a-zA-Z]:\\?$', parent) if parent else True
    return False

@app.get("/api/catalogs/all-subfolders")
def get_all_subfolders(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT path FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            folders = [r["path"] for r in cur.fetchall()]
        
        all_subdirs = []
        for folder_path in folders:
            if not os.path.isdir(folder_path):
                continue
            folder_path = os.path.normpath(folder_path).replace("\\", "/")
            all_subdirs.append(folder_path)
            for root, dirs, _files in os.walk(folder_path):
                dirs[:] = [d for d in dirs if not d.startswith('.') and d.lower() not in (
                    '.git', '.github', 'node_modules', '__pycache__', '.cache', 'thumbs', 'thumbnails', 'dist', 'build'
                )]
                for d in dirs:
                    full_path = os.path.join(root, d)
                    norm_path = os.path.normpath(full_path).replace("\\", "/")
                    all_subdirs.append(norm_path)
        
        return {"ok": True, "subfolders": sorted(list(set(all_subdirs)))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/catalogs/folders")

def list_catalog_folders(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()

            # ── 1. Cleanup: remove junk paths do banco ──
            cur.execute("SELECT id, path FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            for r in cur.fetchall():
                if _is_junk_path(r["path"]):
                    print(f"[CatalogSettings] rejected junk path = {r['path']}", flush=True)
                    cur.execute("DELETE FROM catalog_folders WHERE id = ?", (r["id"],))
            conn.commit()

            # ── 2. Sempre salvar paths do scan state (event + ref) ──
            try:
                scan_state = scm.get_scan_status() if hasattr(scm, 'get_scan_status') else {}
                for path, ftype in [
                    (scan_state.get("event_path", ""), "event"),
                    (scan_state.get("ref_path", ""), "reference"),
                ]:
                    if path and path.strip():
                        cur.execute("SELECT id, folder_type FROM catalog_folders WHERE catalog_name = ? AND path = ?",
                                    (catalog, path))
                        existing = cur.fetchone()
                        if existing:
                            if existing["folder_type"] != ftype:
                                cur.execute("UPDATE catalog_folders SET folder_type = ? WHERE id = ?",
                                            (ftype, existing["id"]))
                                print(f"[CatalogFolders] updated folder_type={ftype} path={path}", flush=True)
                        else:
                            cur.execute("""
                                INSERT INTO catalog_folders (catalog_name, path, include_subfolders, photo_count, folder_type)
                                VALUES (?, ?, 1, 0, ?)
                            """, (catalog, path, ftype))
                            print(f"[CatalogFolders] save {ftype}Path={path}", flush=True)
                conn.commit()
            except Exception as e:
                print(f"[CatalogFolders] scan-state save error: {e}", flush=True)

            # ── 3. Tenta catalog_folders ──
            cur.execute("""
                SELECT id, catalog_name, path, include_subfolders, photo_count, last_scan_at, status, folder_type, created_at
                FROM catalog_folders
                WHERE catalog_name = ?
                ORDER BY id
            """, (catalog,))
            rows = cur.fetchall()

            if rows:
                result = []
                for r in rows:
                    if _is_junk_path(r["path"]):
                        print(f"[CatalogSettings] rejected junk path = {r['path']}", flush=True)
                        cur.execute("DELETE FROM catalog_folders WHERE id = ?", (r["id"],))
                        continue
                    # ── Atualizar photo_count real ──
                    actual_count = r["photo_count"]
                    folder_path = r["path"]
                    if r["folder_type"] == "reference" and os.path.isdir(folder_path):
                        try:
                            exts = IMAGE_EXTENSIONS
                            actual_count = sum(
                                1 for _root, _, files in os.walk(folder_path)
                                for f in files
                                if os.path.splitext(f)[1].lower() in exts
                            )
                        except Exception:
                            pass
                    elif r["folder_type"] != "reference" and os.path.isdir(folder_path):
                        try:
                            exts = IMAGE_EXTENSIONS
                            if r["include_subfolders"]:
                                actual_count = sum(
                                    1 for _root, _, files in os.walk(folder_path)
                                    for f in files
                                    if os.path.splitext(f)[1].lower() in exts
                                )
                            else:
                                actual_count = sum(
                                    1 for f in os.listdir(folder_path)
                                    if os.path.isfile(os.path.join(folder_path, f))
                                    and os.path.splitext(f)[1].lower() in exts
                                )
                        except Exception:
                            pass
                    if actual_count != r["photo_count"]:
                        try:
                            cur.execute("UPDATE catalog_folders SET photo_count = ? WHERE id = ?",
                                        (actual_count, r["id"]))
                        except Exception:
                            pass
                    result.append({
                        "id": r["id"],
                        "catalogName": r["catalog_name"],
                        "path": r["path"],
                        "includeSubfolders": bool(r["include_subfolders"]),
                        "photoCount": actual_count,
                        "lastScanAt": r["last_scan_at"],
                        "status": r["status"],
                        "folderType": r["folder_type"] or "event",
                        "createdAt": r["created_at"],
                    })
                conn.commit()
                print(f"[CatalogSettings] final folders={[f['path'] for f in result]}", flush=True)
                return result

            # ── 3. Fallback: extrair diretórios IMEDIATOS das fotos ──
            # Sempre usar os.path.dirname(foto_path) — NUNCA subir na árvore
            all_paths = set()
            for table in ("ocorrencias", "face_embeddings"):
                try:
                    cur.execute(f"SELECT DISTINCT foto_path FROM {table}")
                    for r in cur.fetchall():
                        if r["foto_path"]:
                            all_paths.add(os.path.normpath(r["foto_path"]))
                except Exception:
                    pass

            raw_dirs = set()
            for fp in all_paths:
                d = os.path.dirname(fp)
                if d and d not in raw_dirs and not _is_junk_path(d):
                    raw_dirs.add(d)

            # ── 4. Contar fotos por pasta ──
            folder_photo_counts = {}
            for fp in all_paths:
                parent = os.path.dirname(fp)
                if parent in raw_dirs:
                    folder_photo_counts[parent] = folder_photo_counts.get(parent, 0) + 1

            print(f"[CatalogSettings] fallback immediate_dirs={len(raw_dirs)} photos={len(all_paths)}", flush=True)

            # ── 5. Migrar para catalog_folders ──
            for d in raw_dirs:
                count = folder_photo_counts.get(d, 0)
                cur.execute("""
                    INSERT OR IGNORE INTO catalog_folders (catalog_name, path, include_subfolders, photo_count, folder_type)
                    VALUES (?, ?, 1, ?, 'event')
                """, (catalog, d, count))
            conn.commit()

            # ── 6. Recarregar ──
            cur.execute("""
                SELECT id, catalog_name, path, include_subfolders, photo_count, last_scan_at, status, folder_type, created_at
                FROM catalog_folders
                WHERE catalog_name = ?
                ORDER BY id
            """, (catalog,))
            result = []
            for r in cur.fetchall():
                if _is_junk_path(r["path"]):
                    print(f"[CatalogSettings] rejected junk path = {r['path']}", flush=True)
                    cur.execute("DELETE FROM catalog_folders WHERE id = ?", (r["id"],))
                    continue
                # ── Atualizar photo_count real ──
                actual_count = r["photo_count"]
                folder_path = r["path"]
                if r["folder_type"] == "reference" and os.path.isdir(folder_path):
                    try:
                        exts = IMAGE_EXTENSIONS
                        actual_count = sum(
                            1 for _root, _, files in os.walk(folder_path)
                            for f in files
                            if os.path.splitext(f)[1].lower() in exts
                        )
                    except Exception:
                        pass
                elif r["folder_type"] != "reference" and os.path.isdir(folder_path):
                    try:
                        exts = IMAGE_EXTENSIONS
                        if r["include_subfolders"]:
                            actual_count = sum(
                                1 for _root, _, files in os.walk(folder_path)
                                for f in files
                                if os.path.splitext(f)[1].lower() in exts
                            )
                        else:
                            actual_count = sum(
                                1 for f in os.listdir(folder_path)
                                if os.path.isfile(os.path.join(folder_path, f))
                                and os.path.splitext(f)[1].lower() in exts
                            )
                    except Exception:
                        pass
                if actual_count != r["photo_count"]:
                    try:
                        cur.execute("UPDATE catalog_folders SET photo_count = ? WHERE id = ?",
                                    (actual_count, r["id"]))
                    except Exception:
                        pass
                result.append({
                    "id": r["id"],
                    "catalogName": r["catalog_name"],
                    "path": r["path"],
                    "includeSubfolders": bool(r["include_subfolders"]),
                    "photoCount": actual_count,
                    "lastScanAt": r["last_scan_at"],
                    "status": r["status"],
                    "folderType": r["folder_type"] or "event",
                    "createdAt": r["created_at"],
                })
            conn.commit()
            print(f"[CatalogSettings] final folders={[f['path'] for f in result]}", flush=True)
            return result

    except Exception as e:
        print(f"[CatalogFolders] list error: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return []

@app.get("/api/catalogs/event-ref-paths")
def get_catalog_event_ref_paths(catalog: str = ""):
    """Retorna os paths de evento e referência salvos no estado do scanner."""
    try:
        scan_state = scm.get_scan_status() if hasattr(scm, 'get_scan_status') else {}
        return {
            "eventPath": scan_state.get("event_path", ""),
            "referencePath": scan_state.get("ref_path", ""),
        }
    except Exception:
        return {"eventPath": "", "referencePath": ""}

@app.post("/api/catalogs/folders")
def add_catalog_folder(req: AddCatalogFolderReq):
    try:
        norm = os.path.normpath(req.path)
        if not os.path.isdir(norm):
            return {"success": False, "error": "Pasta não encontrada"}
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT id FROM catalog_folders WHERE catalog_name = ? AND path = ?", (req.catalog, norm))
            if cur.fetchone():
                return {"success": False, "error": "Esta pasta já está vinculada ao catálogo"}
            cur.execute("""
                INSERT INTO catalog_folders (catalog_name, path, include_subfolders, folder_type)
                VALUES (?, ?, ?, ?)
            """, (req.catalog, norm, 1 if req.include_subfolders else 0, req.folder_type))
            conn.commit()
            folder_id = cur.lastrowid
        # Disparar scan automaticamente se solicitado
        if req.scan_immediately and req.folder_type != "reference":
            try:
                ref_path = ""
                try:
                    with get_db(req.catalog) as conn2:
                        cur2 = conn2.cursor()
                        cur2.execute("SELECT path FROM catalog_folders WHERE catalog_name = ? AND folder_type = 'reference' ORDER BY id LIMIT 1", (req.catalog,))
                        row2 = cur2.fetchone()
                        if row2:
                            ref_path = row2["path"]
                except Exception:
                    pass
                scan_req = scm.ScanRequest(
                    event_path=norm,
                    ref_path=ref_path,
                    project_name=req.catalog,
                    extra_paths=[],
                    selected_folders=[],
                )
                scm.start_scan(scan_req)
            except Exception as scan_err:
                print(f"[CatalogFolders] scan_immediately error: {scan_err}", flush=True)
        return {"success": True, "folderId": folder_id}
    except Exception as e:
        print(f"[CatalogFolders] add error: {e}", flush=True)
        return {"success": False, "error": str(e)}

@app.post("/api/catalogs/folders/remove")
def remove_catalog_folder(req: RemoveCatalogFolderReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            # Buscar o path da pasta antes de remover
            cur.execute("SELECT path FROM catalog_folders WHERE id = ? AND catalog_name = ?", (req.folder_id, req.catalog))
            row = cur.fetchone()
            folder_path = row["path"] if row else ""
            # Remover a pasta do catálogo
            cur.execute("DELETE FROM catalog_folders WHERE id = ? AND catalog_name = ?", (req.folder_id, req.catalog))
            # Remover fotos da pasta das tabelas de ocorrências e descartadas
            if folder_path:
                norm = os.path.normpath(folder_path).lower()
                deleted_occ = 0
                deleted_disc = 0
                cur.execute("SELECT foto_path FROM ocorrencias")
                to_delete_occ = [r["foto_path"] for r in cur.fetchall() if os.path.normpath(r["foto_path"]).lower().startswith(norm + os.sep)]
                if to_delete_occ:
                    for i in range(0, len(to_delete_occ), 500):
                        chunk = to_delete_occ[i:i+500]
                        placeholders = ",".join(["?"] * len(chunk))
                        cur.execute(f"DELETE FROM ocorrencias WHERE foto_path IN ({placeholders})", chunk)
                        deleted_occ += len(chunk)
                cur.execute("SELECT foto_path FROM discarded_photos")
                to_delete_disc = [r["foto_path"] for r in cur.fetchall() if os.path.normpath(r["foto_path"]).lower().startswith(norm + os.sep)]
                if to_delete_disc:
                    for i in range(0, len(to_delete_disc), 500):
                        chunk = to_delete_disc[i:i+500]
                        placeholders = ",".join(["?"] * len(chunk))
                        cur.execute(f"DELETE FROM discarded_photos WHERE foto_path IN ({placeholders})", chunk)
                        deleted_disc += len(chunk)
                print(f"[CatalogFolders] removed folder '{folder_path}': {deleted_occ} ocorrencias, {deleted_disc} discarded", flush=True)
            conn.commit()
        return {"success": True}
    except Exception as e:
        print(f"[CatalogFolders] remove error: {e}", flush=True)
        return {"success": False, "error": str(e)}

class ToggleFolderReq(BaseModel):
    catalog: str
    folder_id: int

@app.post("/api/catalogs/folders/toggle")
def toggle_catalog_folder(req: ToggleFolderReq):
    try:
        with get_db(req.catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT status FROM catalog_folders WHERE id = ? AND catalog_name = ?", (req.folder_id, req.catalog))
            row = cur.fetchone()
            if not row:
                return {"success": False, "error": "Pasta não encontrada"}
            new_status = "inactive" if row["status"] == "active" else "active"
            cur.execute("UPDATE catalog_folders SET status = ? WHERE id = ? AND catalog_name = ?", (new_status, req.folder_id, req.catalog))
            conn.commit()
        return {"success": True, "status": new_status}
    except Exception as e:
        print(f"[CatalogFolders] toggle error: {e}", flush=True)
        return {"success": False, "error": str(e)}

_catalog_stats_cache: dict[str, tuple[dict, float]] = {}
_CATALOG_STATS_TTL = 3.5


def _invalidate_stats_caches():
    _catalog_stats_cache.clear()
    try:
        sm._invalidate_stats_cache()
    except Exception:
        pass

@app.get("/api/catalogs/stats")
def catalog_folder_stats(catalog: str = ""):
    _stats_logger = logging.getLogger(__name__)
    cache_key = f"catalogs/stats:{catalog}"
    cached = _catalog_stats_cache.get(cache_key)
    if cached and (time.time() - cached[1]) < _CATALOG_STATS_TTL:
        return cached[0]
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            _t = time.perf_counter()
            cur.execute("SELECT COUNT(*) FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            active_folders = cur.fetchone()[0]
            _stats_logger.info("[sql-perf] endpoint=/api/catalogs/stats query=count_folders rows=1 ms=%.0f", (time.perf_counter() - _t) * 1000)

            _t = time.perf_counter()
            cur.execute("SELECT COALESCE(SUM(photo_count), 0) FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            total_photos = cur.fetchone()[0]
            _stats_logger.info("[sql-perf] endpoint=/api/catalogs/stats query=sum_photo_count rows=1 ms=%.0f", (time.perf_counter() - _t) * 1000)

            _t = time.perf_counter()
            cur.execute("SELECT COUNT(DISTINCT foto_path) FROM ocorrencias")
            recognized = cur.fetchone()[0]
            _stats_logger.info("[sql-perf] endpoint=/api/catalogs/stats query=count_distinct_foto_path rows=1 ms=%.0f", (time.perf_counter() - _t) * 1000)
            new_photos = max(0, total_photos - recognized)

            _t = time.perf_counter()
            cur.execute("SELECT MAX(last_scan_at) FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            last_scan = cur.fetchone()[0]
            _stats_logger.info("[sql-perf] endpoint=/api/catalogs/stats query=max_last_scan rows=1 ms=%.0f", (time.perf_counter() - _t) * 1000)

            _t = time.perf_counter()
            cur.execute("SELECT COUNT(*) FROM ocorrencias WHERE x1 IS NOT NULL")
            total_faces = cur.fetchone()[0]
            _stats_logger.info("[sql-perf] endpoint=/api/catalogs/stats query=count_faces rows=1 ms=%.0f", (time.perf_counter() - _t) * 1000)

            _t = time.perf_counter()
            cur.execute("SELECT COUNT(DISTINCT foto_path) FROM ocorrencias WHERE x1 IS NOT NULL")
            photos_with_faces = cur.fetchone()[0]
            _stats_logger.info("[sql-perf] endpoint=/api/catalogs/stats query=count_photos_with_faces rows=1 ms=%.0f", (time.perf_counter() - _t) * 1000)

            _t = time.perf_counter()
            cur.execute("SELECT COUNT(DISTINCT aluno_id) FROM ocorrencias WHERE aluno_id IS NOT NULL AND aluno_id != '' AND aluno_id != 'desconhecido'")
            known_persons = cur.fetchone()[0]
            _stats_logger.info("[sql-perf] endpoint=/api/catalogs/stats query=count_known_persons rows=1 ms=%.0f", (time.perf_counter() - _t) * 1000)

        result = {
            "activeFolders": active_folders,
            "totalPhotos": total_photos,
            "recognizedPhotos": recognized,
            "newPhotos": new_photos,
            "lastScanAt": last_scan,
            "totalFaces": total_faces,
            "photosWithFaces": photos_with_faces,
            "knownPersons": known_persons,
        }
        _catalog_stats_cache[cache_key] = (result, time.time())
        return result
    except Exception as e:
        print(f"[CatalogFolders] stats error: {e}", flush=True)
        return {"activeFolders": 0, "totalPhotos": 0, "recognizedPhotos": 0, "newPhotos": 0, "lastScanAt": None, "totalFaces": 0, "photosWithFaces": 0, "knownPersons": 0}

class ScanFolderReq(BaseModel):
    catalog: str
    path: str
    include_subfolders: bool = True

@app.post("/api/catalogs/scan-folder")
def scan_catalog_folder(req: ScanFolderReq):
    try:
        ref_path = ""
        try:
            with get_db(req.catalog) as conn:
                cur = conn.cursor()
                cur.execute("SELECT path FROM catalog_folders WHERE catalog_name = ? AND folder_type = 'reference' ORDER BY id LIMIT 1", (req.catalog,))
                row = cur.fetchone()
                if row:
                    ref_path = row["path"]
        except Exception:
            pass
        scan_req = scm.ScanRequest(
            event_path=req.path,
            ref_path=ref_path,
            project_name=req.catalog,
            extra_paths=[],
            selected_folders=[],
        )
        return scm.start_scan(scan_req)
    except Exception as e:
        print(f"[CatalogFolders] scan-folder error: {e}", flush=True)
        return {"success": False, "error": str(e)}

@app.post("/api/catalogs/sync")
def sync_catalog(catalog: str = ""):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT path, include_subfolders, folder_type FROM catalog_folders WHERE catalog_name = ?", (catalog,))
            rows = cur.fetchall()
        if not rows:
            return {"success": False, "error": "Nenhuma pasta vinculada"}
        ref_path = ""
        for r in rows:
            if r["folder_type"] == "reference":
                ref_path = r["path"]
                break
        for r in rows:
            if r["folder_type"] == "reference":
                continue
            scan_req = scm.ScanRequest(
                event_path=r["path"],
                ref_path=ref_path,
                project_name=catalog,
                extra_paths=[],
                selected_folders=[],
            )
            scm.start_scan(scan_req)
        return {"success": True, "folders": len(rows)}
    except Exception as e:
        print(f"[CatalogFolders] sync error: {e}", flush=True)
        return {"success": False, "error": str(e)}

@app.get("/api/search/global")
def global_search(q: str = ""):
    return pdm.global_search(q)

@app.get("/api/people")
def get_people(unknown: bool = False):
    return pdm.get_people(unknown)

@app.get("/api/photos/all")
def get_all_photos(limit: int = None):
    return pdm.get_all_photos(limit)

@app.get("/api/photos")
def get_photos_page(catalog: str = "", limit: int = 100, offset: int = 0, subfolder: str = None):
    t0 = time.time()
    result = pdm.get_photos_page(catalog, limit, offset, subfolder)
    elapsed_ms = (time.time() - t0) * 1000
    logging.getLogger(__name__).info(
        f"[photos-page] catalog={catalog or pdm.current_catalog()} offset={offset} limit={limit} subfolder={subfolder} total={result['total']} ms={elapsed_ms:.0f}"
    )
    return result

@app.get("/api/photos/context")
def get_photo_context(path: str = "", catalog: str = ""):
    try:
        decoded_path = urllib.parse.unquote(path or "").strip()
        if not decoded_path:
            return {
                "current": None,
                "previous": None,
                "next": None,
                "neighbors": [],
                "index": -1,
                "total": 0,
            }

        photos = pdm.get_all_photos()
        if not photos:
            return {
                "current": None,
                "previous": None,
                "next": None,
                "neighbors": [],
                "index": -1,
                "total": 0,
            }

        def _norm(value: str) -> str:
            return os.path.normcase(os.path.normpath(urllib.parse.unquote(value or "")))

        target_norm = _norm(decoded_path)
        index = next((i for i, photo in enumerate(photos) if _norm(str(photo.get("path", ""))) == target_norm), -1)

        if index < 0:
            base_name = os.path.basename(decoded_path)
            if base_name:
                index = next(
                    (i for i, photo in enumerate(photos) if os.path.basename(str(photo.get("path", ""))) == base_name),
                    -1,
                )

        if index < 0:
            return {
                "current": None,
                "previous": None,
                "next": None,
                "neighbors": [],
                "index": -1,
                "total": len(photos),
            }

        window = 3
        start = max(0, index - window)
        end = min(len(photos), index + window + 1)
        neighbors = photos[start:end]

        return {
            "current": photos[index],
            "previous": photos[index - 1] if index > 0 else None,
            "next": photos[index + 1] if index < len(photos) - 1 else None,
            "neighbors": neighbors,
            "index": index,
            "total": len(photos),
            "catalog": catalog or "",
        }
    except Exception as e:
        logging.getLogger(__name__).exception("[photos/context] erro")
        return {
            "current": None,
            "previous": None,
            "next": None,
            "neighbors": [],
            "index": -1,
            "total": 0,
            "error": str(e),
        }

@app.get("/api/photos/{aluno_id}")
def get_photos(aluno_id: str):
    from urllib.parse import unquote
    decoded = unquote(aluno_id)
    log_info(f"[photos-api] incoming={aluno_id} decoded={decoded}")
    try:
        if "::" in decoded:
            log_info(f"[photos-api] mode=person_key person_key={decoded}")
            result = pdm.get_photos_by_person_key(decoded)
            log_info(f"[photos-api] photos_found={len(result)}")
            if not result:
                # Log person_keys from DB for debugging
                try:
                    db = _get("get_db")
                    with db() as conn:
                        cur = conn.cursor()
                        cur.execute("""
                            SELECT DISTINCT person_key, aluno_id, COUNT(*) as cnt
                            FROM ocorrencias
                            WHERE person_key IS NOT NULL AND person_key != ''
                              AND aluno_id = ?
                            GROUP BY person_key
                            ORDER BY cnt DESC
                            LIMIT 10
                        """, (decoded.split("::")[-1] if "::" in decoded else decoded,))
                        samples = [dict(r) for r in cur.fetchall()]
                        log_info(f"[photos-api] person_keys_for_aluno: {samples}")
                except Exception as log_e:
                    log_info(f"[photos-api] debug_query_error: {log_e}")
            return result
        log_info(f"[photos-api] mode=legacy aluno_id={decoded}")
        result = pdm.get_photos(decoded)
        log_info(f"[photos-api] photos_found={len(result)}")
        return result
    except Exception as e:
        logging.getLogger(__name__).exception("[photos] erro ao buscar fotos de %s", decoded)
        return []

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


@app.get("/api/review/clusters")
def get_review_clusters(
    catalog: str = "",
    limit: int = 30,
    offset: int = 0,
):
    try:
        return rm.get_review_clusters_page(catalog, limit, offset)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/review/clusters/detail")
def get_review_cluster_detail(
    catalog: str = "",
    cluster_id: str = "",
):
    return rm.get_review_cluster_detail(catalog, cluster_id)


@app.get("/api/review/student-match-preview")
def get_student_match_preview(catalog: str, cluster_id: str, student: str):
    return rm.get_student_match_preview(catalog, cluster_id, student)


@app.post("/api/review/generate-all-embeddings")
def generate_all_embeddings(req: dict = {}):
    return rm.generate_all_embeddings(req.get("catalog", ""))


BulkManualIdentifyReq = rm.BulkManualIdentifyReq


@app.post("/api/review/bulk-manual-identify")
def bulk_manual_identify(req: BulkManualIdentifyReq):
    return rm.bulk_manual_identify(req)

AssignUnknownClusterRequest = rm.AssignUnknownClusterRequest
IgnoreUnknownClusterRequest = rm.IgnoreUnknownClusterRequest
GraduationAnalysisRequest = rm.GraduationAnalysisRequest

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

@app.post("/api/migrate-person-keys")
def migrate_person_keys():
    return rm.migrate_person_keys()

@app.post("/api/review/unknown-clusters/ignore")
@app.post("/api/review/ignore")
@app.post("/api/unknown-clusters/ignore")
@app.post("/api/review/cluster/ignore")
@app.post("/api/review/bulk-ignore")
def ignore_cluster(req: IgnoreUnknownClusterRequest):
    try:
        return rm.ignore_cluster(req)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("[ignore_unknown_cluster] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "ignore_unknown_cluster_failed",
                "detail": str(e),
            },
        )

@app.post("/api/review/clusters/merge")
def merge_clusters(catalog: str = "", source_cluster_id: str = "", target_cluster_id: str = ""):
    try:
        return rm.merge_unknown_clusters(catalog, source_cluster_id, target_cluster_id)
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@app.get("/api/review/debug-cluster-similarities")
def debug_cluster_similarities(catalog: str = ""):
    try:
        return rm.debug_cluster_similarities(catalog)
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/review/debug-face-state")
def debug_face_state(rowid: int = 0, foto_path: str = ""):
    try:
        return rm.debug_face_state(rowid=rowid, foto_path=foto_path)
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/review/debug-student-matches")
def debug_student_matches(catalog: str = ""):
    try:
        return rm.debug_student_matches(catalog)
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/review/graduation-analysis/start")
def start_graduation_analysis(req: GraduationAnalysisRequest):
    try:
        return rm.start_graduation_analysis(req)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("[graduation_analysis_start] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "graduation_analysis_start_failed",
                "detail": str(e),
            },
        )

@app.get("/api/review/graduation-analysis/status")
def get_graduation_analysis_status(catalog: str = ""):
    try:
        return rm.get_graduation_analysis_status(catalog)
    except Exception as e:
        logging.getLogger(__name__).exception("[graduation_analysis_status] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "graduation_analysis_status_failed",
                "detail": str(e),
            },
        )


GraduationManualOverrideRequest = rm.GraduationManualOverrideRequest

@app.post("/api/review/graduation/manual-override")
def graduation_manual_override(req: GraduationManualOverrideRequest):
    try:
        return rm.graduation_manual_override(req)
    except Exception as e:
        logging.getLogger(__name__).exception("[graduation_manual_override] erro")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": str(e)},
        )


class BulkDiscardPhotoReq(BaseModel):
    catalog: str = ""
    photo_ids: Optional[List[int]] = None
    rowids: Optional[List[int]] = None
    foto_paths: Optional[List[str]] = None
    reason: Optional[str] = None

    def ids(self) -> List[int]:
        return self.photo_ids or self.rowids or []

class BulkRestorePhotoReq(BaseModel):
    catalog: str = ""
    photo_ids: Optional[List[int]] = None
    rowids: Optional[List[int]] = None
    foto_paths: Optional[List[str]] = None

    def ids(self) -> List[int]:
        return self.photo_ids or self.rowids or []

class BulkRemoveIdentificationReq(BaseModel):
    catalog: str = ""
    photo_ids: Optional[List[int]] = None
    rowids: Optional[List[int]] = None

    def ids(self) -> List[int]:
        return self.photo_ids or self.rowids or []


@app.post("/api/review/bulk-discard")
def bulk_discard_photos(req: BulkDiscardPhotoReq):
    _invalidate_stats_caches()
    return rm.bulk_discard_photos(req)


@app.post("/api/review/bulk-restore")
def bulk_restore_photos(req: BulkRestorePhotoReq):
    _invalidate_stats_caches()
    return rm.bulk_restore_photos(req)


@app.on_event("startup")
async def log_graduation_analysis_routes():
    print("[graduation-analysis] routes registered", flush=True)
    for route in app.routes:
        path = getattr(route, "path", "")
        print(path, flush=True)
    try:
        se.ensure_face_engine()
    except Exception as e:
        print(f"[AI] warmup InsightFace adiado: {e}", flush=True)

@app.on_event("startup")
async def start_metrics_worker():
    _start_metrics_worker()
    print("[metrics] background worker iniciado", flush=True)

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
def get_image_thumb(path: str, size: int = 300, q: int = 80):
    try:
        get_thumb_slot(size=size)
        return mm.get_image_thumb(path, size, q)
    except HTTPException:
        raise
    except Exception:
        pass
    finally:
        release_thumb_slot()
    return StreamingResponse(mm._create_error_placeholder(size), media_type="image/jpeg")

@app.get("/api/thumb")
def get_thumb(path: str, x1: int, y1: int, x2: int, y2: int, size: int = 120, expand: float = 0.35, q: int = 80):
    try:
        get_thumb_slot(size=size)
        return mm.get_thumb(path, x1, y1, x2, y2, size, expand, q)
    except HTTPException:
        raise
    except Exception:
        pass
    finally:
        release_thumb_slot()
    return StreamingResponse(mm._create_error_placeholder(size), media_type="image/jpeg")

@app.get("/api/image_full")
def get_image_full(path: str):
    return mm.get_image(path)

@app.get("/api/image")
def get_image(path: str = Query(...)):
    return mm.get_image(path)

@app.get("/api/image/resized")
def get_image_resized(path: str = Query(...), max_size: int = 1200):
    return mm.get_image_resized(path, max_size)

@app.get("/api/image_preview")
def get_image_preview(
    path: str = Query(...),
    size: int = Query(1920),
    max_size: int | None = Query(None),
):
    safe_size = max_size or size or 1920
    safe_size = max(1, min(int(safe_size), 2560))
    return mm.get_image_preview(path, safe_size)

@app.get("/api/explorer/ls")
def explorer_ls(path: str = "", catalog: str = ""):
    return mm.explorer_ls(path, catalog)


@app.get("/api/explorer/tree")
def explorer_tree(path: str = "", max_depth: int = 2):
    return mm.explorer_tree(path, max_depth)


@app.get("/api/scanner/folder-tree")
def get_scanner_folder_tree(path: str = "", depth: int = 2):
    """
    Retorna a árvore de pastas otimizada para o Gerenciador de Pastas do Scanner.
    Suporta lazy load através do parâmetro 'depth'.
    """
    try:
        return mm.scanner_folder_tree(path, depth)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/explorer/photos")
def explorer_photos(path: str = "", recursive: bool = False, limit: int = 0, offset: int = 0, include_raw: bool = True, include_video: bool = True):
    try:
        return mm.explorer_photos(path, recursive, limit, offset, include_raw, include_video)
    except HTTPException:
        raise
    except Exception as e:
        return {"ok": False, "error": str(e), "path": path, "total": 0, "photos": []}

ManualIdentifyReq = rm.ManualIdentifyReq
ManualSearchReq = rm.ManualSearchReq

@app.post("/api/manual_identify")
def manual_identify(req: ManualIdentifyReq):
    result = rm.manual_identify(req)
    pdm.invalidate_people_cache()
    return result

@app.get("/api/select-folder")
def select_folder():
    return im.select_folder()

@app.get("/api/select-image")
def select_image():
    return im.select_image()

@app.get("/api/select-file")
def select_file():
    return im.select_file()

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
    _invalidate_stats_caches()
    result = rm.rename_person(req)
    pdm.invalidate_people_cache()
    return result

DeletePersonReq = rm.DeletePersonReq

@app.post("/api/delete-person")
def delete_person(req: DeletePersonReq):
    try:
        result = rm.delete_person(req)
        pdm.invalidate_people_cache()
        return result
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
    _invalidate_stats_caches()
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

# ── Background metrics worker ──────────────────────────────
_metrics_snapshot: dict = {
    "cpuPercent": None, "ramUsedGb": None, "ramPercent": None,
    "gpuPercent": None, "temperatureC": None, "cpuTemperatureC": None,
    "gpuProvider": None, "metricsWarning": None,
}
_metrics_lock = threading.Lock()
_metrics_interval = 2.0
_metrics_worker_running = False
_metrics_gpu_once: tuple | None = None  # (gpu_val, gpu_temp) after first try
_metrics_logger = logging.getLogger(__name__)


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
    _metrics_logger = logging.getLogger(__name__)
    try:
        with _metrics_lock:
            snap = dict(_metrics_snapshot)
        has_any = any(snap.get(k) is not None for k in ("cpuPercent", "ramUsedGb", "gpuPercent"))
        if has_any:
            snap["status"] = "ready"
            _metrics_logger.info("[metrics-endpoint] status=ready")
        else:
            snap["status"] = "warming_up"
            _metrics_logger.info("[metrics-endpoint] fallback=warming_up snapshot_ainda_vazio")
        return snap
    except Exception:
        _metrics_logger.warning("[metrics-endpoint] fallback=default erro_ao_ler_snapshot", exc_info=True)
        return {
            "cpuPercent": 0, "ramUsedGb": 0, "ramPercent": 0,
            "gpuPercent": 0, "temperatureC": None, "cpuTemperatureC": None,
            "gpuProvider": "unavailable", "metricsWarning": "snapshot_error",
            "status": "warming_up",
        }

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
    try:
        status = ex.get_export_status()
        if not isinstance(status, dict):
            raise RuntimeError("export status indisponível")
        is_exporting = bool(status.get("is_exporting") or status.get("running"))
        text = str(status.get("status_text") or status.get("message") or ("Exportação em andamento" if is_exporting else "Nenhuma exportação em andamento"))
        normalized = dict(status)
        normalized["is_exporting"] = is_exporting
        normalized["running"] = is_exporting
        normalized["status"] = "running" if is_exporting else "idle"
        normalized["progress"] = float(status.get("progress") or 0)
        normalized["status_text"] = text
        normalized["message"] = text
        normalized["total_files"] = int(status.get("total_files") or 0)
        normalized["processed_files"] = int(status.get("processed_files") or 0)
        normalized["eta_seconds"] = int(status.get("eta_seconds") or 0)
        return normalized
    except Exception as e:
        log_info(f"Falha ao consultar status da exportacao: {e}")
        return {
            "is_exporting": False,
            "running": False,
            "status": "idle",
            "progress": 0,
            "status_text": "Nenhuma exportação em andamento",
            "message": "Nenhuma exportação em andamento",
            "total_files": 0,
            "processed_files": 0,
            "eta_seconds": 0,
            "export_summary": None,
        }

@app.post("/api/export/clear_summary")
def clear_export_summary():
    return ex.clear_export_summary()

class OpenFolderReq(BaseModel):
    path: str

class OpenPathReq(BaseModel):
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

@app.post("/api/system/open-path")
def open_path(req: OpenPathReq):
    target = os.path.abspath(os.path.normpath(os.path.expanduser(os.path.expandvars(req.path or ""))))
    if not target or not os.path.exists(target):
        raise HTTPException(status_code=404, detail="Caminho nao encontrado")
    if not is_safe_path(target):
        raise HTTPException(status_code=400, detail="Caminho protegido nao pode ser aberto")
    return im.open_path(target)

@app.get("/api/faces/similar")
def search_similar_faces(rowid: int, catalog: str = "", limit: int = 50):
    print(f"[faces/similar] rowid={rowid} catalog={repr(catalog)} limit={limit}")
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()

            cur.execute("SELECT embedding FROM face_embeddings WHERE occurrence_rowid = ?", (rowid,))
            base = cur.fetchone()
            print(f"[faces/similar] base_face={'found' if base else 'NOT FOUND'}, has_embedding={bool(base and base['embedding'])}")

            if not base or not base["embedding"]:
                return {"results": [], "message": "Embedding facial não disponível para este rosto. Execute uma nova varredura para gerar os embeddings."}

            query_emb = np.frombuffer(base["embedding"], dtype="float32").copy()
            norm = np.linalg.norm(query_emb)
            if norm == 0:
                return {"results": [], "message": "Embedding facial inválido para este rosto."}
            query_emb /= norm

            # Coordenadas vêm de ocorrencias (fonte canônica, sem JOIN em fotos)
            cur.execute("""
                SELECT fe.occurrence_rowid, fe.embedding,
                       o.foto_path, o.x1, o.y1, o.x2, o.y2, o.aluno_id
                FROM face_embeddings fe
                INNER JOIN ocorrencias o ON o.rowid = fe.occurrence_rowid
                WHERE fe.occurrence_rowid != ? AND fe.embedding IS NOT NULL
            """, (rowid,))
            rows = cur.fetchall()
            print(f"[faces/similar] candidates={len(rows)}")

        results = []
        for r in rows:
            try:
                emb = np.frombuffer(r["embedding"], dtype="float32").copy()
                n = np.linalg.norm(emb)
                if n == 0:
                    continue
                score = float(np.dot(query_emb, emb / n))
                path = r["foto_path"] or ""
                x1 = int(r["x1"] or 0)
                y1 = int(r["y1"] or 0)
                x2 = int(r["x2"] or 0)
                y2 = int(r["y2"] or 0)
                has_bbox = path and x2 > x1 and y2 > y1
                thumb = (
                    f"/api/faces/thumb?rowid={r['occurrence_rowid']}&catalog={urllib.parse.quote(catalog)}&size=180"
                    if has_bbox else
                    f"/api/image_thumb?path={urllib.parse.quote(path)}&size=180"
                    if path else ""
                )
                results.append({
                    "rowid": r["occurrence_rowid"],
                    "photo_path": path,
                    "thumb_url": thumb,
                    "score": score,
                    "aluno_id": r["aluno_id"],
                    "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                    "box": [x1, y1, x2, y2],
                })
            except Exception as row_err:
                print(f"[faces/similar] erro em row {r['occurrence_rowid']}: {row_err}")
                continue

        results.sort(key=lambda x: x["score"], reverse=True)
        print(f"[faces/similar] returning {min(len(results), limit)} results")
        return {"results": results[:limit]}

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[faces/similar] ERRO: {repr(e)}")
        traceback.print_exc()
        return {"results": [], "message": f"Erro ao buscar faces semelhantes: {e}"}

@app.get("/api/faces/thumb")
def get_face_thumb(rowid: int, catalog: str = "", size: int = 180):
    try:
        get_thumb_slot(size=size)
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT foto_path, x1, y1, x2, y2 FROM ocorrencias WHERE rowid = ?",
                (rowid,)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Face não encontrada")
            path = row["foto_path"]
            x1 = int(row["x1"] or 0)
            y1 = int(row["y1"] or 0)
            x2 = int(row["x2"] or 0)
            y2 = int(row["y2"] or 0)

        if not path or x2 <= x1 or y2 <= y1:
            return mm.get_image_thumb(path, size) if path else HTTPException(status_code=400, detail="Bounding box inválido")

        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail="Arquivo de imagem não encontrado")

        return mm.get_thumb(path, x1, y1, x2, y2, size)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[faces/thumb] ERRO rowid={rowid}: {repr(e)}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        release_thumb_slot()

@app.post("/api/scan/precheck")
def scan_precheck(req: scm.ScanRequest):
    return scm.scan_precheck(req)

@app.post("/api/scan/clear-checkpoints")
def clear_checkpoints(req: dict):
    return scm.clear_checkpoints(req)

@app.post("/api/scan/start")
def start_scan(req: scm.ScanRequest):
    _invalidate_stats_caches()
    return scm.start_scan(req)

@app.get("/api/scan/status")
def get_scan_status():
    try:
        raw = scm.get_scan_status() or {}
        from scanner_engine import _scan_last_progress_at, _scan_last_progress_file, _scan_last_processed, _scan_stalled
        now = time.time()
        last_secs = (now - _scan_last_progress_at) if _scan_last_progress_at > 0 else None
        if _scan_stalled:
            raw["status"] = "stalled"
        elif raw.get("is_scanning"):
            raw["status"] = "running"
        elif raw.get("stopped"):
            raw["status"] = "stopped"
        elif raw.get("scan_summary"):
            raw["status"] = "done"
        else:
            raw["status"] = "idle"
        raw["last_progress_seconds"] = round(last_secs, 1) if last_secs is not None else None
        raw["current_file"] = _scan_last_progress_file or (raw.get("current_photo") or {}).get("name")
        raw["processed"] = raw.get("total_processadas", _scan_last_processed)
        raw["total"] = raw.get("total_validos", 0)
        return raw
    except Exception:
        _scan_logger = logging.getLogger(__name__)
        _scan_logger.exception("[scanner-status] failed")
        return {
            "running": False, "progress": 0, "processed": 0, "total": 0,
            "status": "recovering", "error": "temporary_failure",
        }

@app.post("/api/scan/clear_summary")
def clear_scan_summary():
    _invalidate_stats_caches()
    return scm.clear_scan_summary()

@app.post("/api/scan/stop")
def stop_scan():
    return scm.stop_scan()

@app.post("/api/scanner/stop")
def scanner_stop():
    scm.stop_scan()
    return {"success": True}

@app.get("/api/scanner/live-status")
def scanner_live_status():
    s = scm.get_scan_status()
    now = time.time()
    started_at = s.get("started_at")
    is_scanning = bool(s.get("is_scanning", False))
    processed = int(s.get("total_processadas", 0))
    total = int(s.get("total_files", 0))
    elapsed = (now - started_at) if started_at and is_scanning else None
    eta = None
    avg_sec = None
    if elapsed is not None and elapsed > 0 and processed >= 5:
        speed = processed / elapsed
        remaining = total - processed
        if remaining > 0 and speed > 0:
            eta = round(remaining / speed, 1)
            avg_sec = round(elapsed / processed, 2)
    return {
        "running": is_scanning,
        "stopped": bool(s.get("stopped", False)),
        "processedPhotos": processed,
        "totalPhotos": total,
        "started_at": started_at,
        "elapsed_seconds": round(elapsed, 1) if elapsed is not None else None,
        "eta_seconds": eta,
        "avgSecondsPerPhoto": avg_sec,
        "is_scanning": is_scanning,
        "status_text": s.get("status_text", ""),
    }

@app.post("/api/scanner/cleanup")
def scanner_cleanup():
    return scm.force_cleanup()

@app.post("/api/scanner/unload-models")
def scanner_unload_models():
    return scm.unload_models()

@app.post("/api/scan/quality_fill")
def start_quality_audit(req: dict):
    return scm.start_quality_audit(req)

@app.post("/api/scan/start_quality_audit")
def start_quality_audit_legacy(req: dict):
    return scm.start_quality_audit(req)

@app.get("/api/scan/quality_audit_status")
def get_quality_audit_status():
    try:
        return scm.get_quality_audit_status()
    except Exception as e:
        return {
            "status": "error",
            "running": False,
            "enabled": False,
            "processed": 0,
            "total": 0,
            "progress": 0.0,
            "message": str(e),
            "is_auditing": False,
            "status_text": str(e),
        }

@app.get("/api/scanner/preview-ocr")
def scanner_preview_ocr(path: str = ""):
    """
    Preview OCR de uma única foto. Não salva no banco.
    Usa rosto detectado com InsightFace para calcular crop da ficha e rodar OCR.
    """
    decoded = urllib.parse.unquote(path).strip()
    if not decoded or not os.path.isfile(decoded):
        return {"ok": False, "error": "Arquivo não encontrado"}

    ext = os.path.splitext(decoded)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        return {"ok": False, "error": "Formato de imagem não suportado"}

    try:
        img = cv2.imread(decoded)
        if img is None:
            return {"ok": False, "error": "Falha ao ler imagem"}

        h, w = img.shape[:2]

        # ── 1. Detectar rosto principal com InsightFace ──
        import re

        se.ensure_face_engine()
        app_face = se.get_app_face()
        primary_face = None

        if app_face:
            from scanner_engine import FACE_INFERENCE_LOCK
            with FACE_INFERENCE_LOCK:
                with _suppress_stdout():
                    raw_faces = app_face.get(img) or []
            if raw_faces:
                raw_faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
                best = raw_faces[0]
                fx1, fy1, fx2, fy2 = map(int, best.bbox[:4])
                primary_face = (fx1, fy1, fx2, fy2)
                log_info(f"[preview-ocr] face_bbox={primary_face}")

        # ── 2. Document number region detector (fichas documentais) ──
        from services.ocr_pipeline import detect_document_number_region, process_hybrid_ocr, process_ocr

        doc_result = detect_document_number_region(img, decoded, primary_face)
        new_number = doc_result.get("number") if doc_result else None

        # Só aceita OCR novo se achou número de 4+ dígitos
        if new_number and len(new_number) >= 4:
            log_info(f"[doc-ocr] pipeline=document_detector number={new_number} confidence={doc_result['confidence']}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": doc_result.get("raw_text", new_number),
                "fields": {
                    "nome": None, "curso": None, "instituicao": None,
                    "data": None, "tipo": None, "numero": new_number,
                },
                "confidence": doc_result["confidence"],
            }

        # ── 2b. Fallback: OCR antigo confiável (process_ocr) ──
        from services.ocr_pipeline import extract_document_number

        old_result = process_ocr(decoded, primary_face)
        old_text = old_result.get("ocr_text", "") or ""
        old_number = old_result.get("fields", {}).get("numero")
        old_conf = old_result.get("ocr_confidence", 0.85) or 0.85

        log_info(f"[ocr-compare] old_text={old_text}")
        log_info(f"[ocr-compare] new_text={new_number}")

        # Validar old_number com as regras documentais (rejeitar 3 dígitos)
        if old_number:
            validated = extract_document_number(old_text) or extract_document_number(old_number)
            if validated and len(validated) >= 4:
                log_info(f"[ocr-compare] selected_source=old_ocr")
                log_info(f"[EasyOCR] selected_number={validated}")
                return {
                    "ok": True,
                    "path": decoded,
                    "raw_text": old_text,
                    "fields": {
                        "nome": None, "curso": None, "instituicao": None,
                        "data": None, "tipo": None, "numero": validated,
                    },
                    "confidence": round(float(old_conf), 4),
                }
            # Rejeitar número de 3 dígitos do OCR antigo
            log_info(f"[doc-ocr] candidate={old_number} conf={old_conf:.2f} rejected=true reason=too_short_for_document")
            log_info(f"[ocr-compare] selected_source=null (old rejected)")

        # ── 3. OCR híbrido por tipo de ficha ──
        hybrid = process_hybrid_ocr(img, decoded)

        # Se for ficha completa com nome+numero, retorna tudo
        if hybrid["doc_type"] == "completa" and hybrid["fields"].get("numero"):
            log_info(f"[preview-ocr] doc_type=completa numero={hybrid['fields']['numero']} nome={hybrid['fields'].get('nome')}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": hybrid["raw_text"],
                "fields": hybrid["fields"],
                "confidence": hybrid["confidence"],
            }

        # Se for simples com numero, retorna direto
        if hybrid["doc_type"] == "simples" and hybrid["fields"].get("numero"):
            log_info(f"[EasyOCR] selected_number={hybrid['fields']['numero']}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": hybrid["raw_text"],
                "fields": {
                    "nome": None,
                    "curso": None,
                    "instituicao": None,
                    "data": None,
                    "tipo": None,
                    "numero": hybrid["fields"]["numero"],
                },
                "confidence": hybrid["confidence"],
            }

        # ── 4. Fallback: crop facial + Tesseract ──
        from services.ocr_engine import run_tesseract_safe

        debug_dir = None
        try:
            _d = os.path.join(os.path.dirname(decoded), ".preview_ocr_debug")
            os.makedirs(_d, exist_ok=True)
            debug_dir = _d
        except Exception:
            pass
        base_name = os.path.splitext(os.path.basename(decoded))[0]

        def _preprocess_strong(crop_img: np.ndarray) -> np.ndarray:
            gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY)
            upscaled = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(upscaled)
            sharpen_kernel = np.array([[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]], dtype=np.float32)
            sharp = cv2.filter2D(clahe, -1, sharpen_kernel)
            filtered = cv2.bilateralFilter(sharp, 9, 75, 75)
            thresh = cv2.adaptiveThreshold(filtered, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 2)
            kernel = np.ones((3, 3), np.uint8)
            return cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

        def _save_debug(crop_img: np.ndarray, suffix: str):
            if debug_dir is None:
                return
            try:
                p = os.path.join(debug_dir, f"{base_name}_{suffix}.jpg")
                cv2.imwrite(p, crop_img)
            except Exception:
                pass

        def _ocr_crop_tesseract(crop_img: np.ndarray) -> list:
            if crop_img.size == 0:
                return []
            try:
                processed = _preprocess_strong(crop_img)
                candidates = []
                for psm in ("7", "8", "6"):
                    text = run_tesseract_safe(processed, f"--psm {psm} -c tessedit_char_whitelist=0123456789")
                    text = (text or "").strip()
                    log_info(f"[preview-ocr] config=psm{psm}")
                    log_info(f"[preview-ocr] text={text}")
                    nums = re.findall(r"\b(\d{3,5})\b", text)
                    for n in nums:
                        score = 0
                        if len(n) == 4:
                            score += 3
                        elif len(n) == 3:
                            score += 1
                        elif len(n) == 5:
                            score += 2
                        if text.strip() == n:
                            score += 2
                        digits = re.sub(r"\D", "", text)
                        if digits == n:
                            score += 1
                        candidates.append((n, score, psm, text))
                return candidates
            except Exception as e:
                log_info(f"[preview-ocr] crop_ocr_error={e}")
                return []

        selected_number = None
        crop_results = []

        if primary_face:
            fx1, fy1, fx2, fy2 = primary_face
            face_w = fx2 - fx1
            face_h = fy2 - fy1

            for idx, label, x1, x2, y1, y2 in (
                (1, "peito",
                 max(0, int(fx1 - face_w * 1.7)),
                 min(w, int(fx2 + face_w * 1.7)),
                 max(0, int(fy2 + face_h * 0.05)),
                 min(h, int(fy2 + face_h * 1.50))),
                (2, "peito_largo",
                 max(0, int(fx1 - face_w * 2.0)),
                 min(w, int(fx2 + face_w * 2.0)),
                 max(0, int(fy2)),
                 min(h, int(fy2 + face_h * 2.00))),
                (3, "centro_inferior",
                 int(w * 0.20), int(w * 0.80),
                 int(h * 0.45), int(h * 0.78)),
            ):
                if x2 <= x1 or y2 <= y1:
                    continue
                log_info(f"[preview-ocr] crop_{idx}_box=({x1},{y1},{x2},{y2})")
                crop_img = img[y1:y2, x1:x2]
                _save_debug(crop_img, f"crop_{idx}")
                candidates = _ocr_crop_tesseract(crop_img)
                if candidates:
                    candidates.sort(key=lambda x: (-x[1], x[2]))
                    best = candidates[0]
                    crop_results.append((best[0], idx, best[3], best[1]))
                    processed = _preprocess_strong(crop_img)
                    _save_debug(processed, f"crop_{idx}_processed")

        if crop_results:
            crop_results.sort(key=lambda x: (-x[3], x[1]))
            selected_number = crop_results[0][0]
            crop_text = crop_results[0][2]
            log_info(f"[EasyOCR] selected_number={selected_number}")
            return {
                "ok": True,
                "path": decoded,
                "raw_text": crop_text,
                "fields": {
                    "nome": None, "curso": None, "instituicao": None,
                    "data": None, "tipo": None, "numero": selected_number,
                },
                "confidence": 0.85,
            }

        # ── 5. Fallback final: OCR na imagem inteira ──
        result = process_ocr(decoded)

        if result:
            raw_text = result.get("ocr_text", "") or ""
            confidence = result.get("ocr_confidence", 0.0) or 0.0
            log_info(f"[preview-ocr] full_text={raw_text}")

            if not selected_number:
                nums = re.findall(r"\b(\d{3,5})\b", raw_text)
                if nums:
                    selected_number = nums[0]
            if selected_number:
                log_info(f"[EasyOCR] selected_number={selected_number}")

            lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
            fields = {
                "nome": lines[0] if len(lines) > 0 else None,
                "curso": lines[1] if len(lines) > 1 else None,
                "instituicao": lines[2] if len(lines) > 2 else None,
                "data": None, "tipo": None,
                "numero": selected_number,
            }
            for line in lines:
                dm = re.search(r"\b(\d{2})[\s/.-](\d{2})[\s/.-](\d{4})\b", line)
                if dm and not fields["data"]:
                    fields["data"] = f"{dm.group(1)}/{dm.group(2)}/{dm.group(3)}"
            tipo_kw = ["COLAÇÃO", "COLACAO", "FORMATURA", "GRADUAÇÃO", "GRADUACAO", "DIPLOMA", "CERTIFICADO", "CONCLUSÃO", "CONCLUSAO"]
            for line in lines:
                up = line.upper()
                for kw in tipo_kw:
                    if kw in up and not fields["tipo"]:
                        fields["tipo"] = line
                        break

            return {
                "ok": True, "path": decoded,
                "raw_text": raw_text, "fields": fields,
                "confidence": round(float(confidence), 4),
            }

        return {
            "ok": True, "path": decoded,
            "raw_text": "", "fields": {
                "nome": None, "curso": None, "instituicao": None,
                "data": None, "tipo": None, "numero": None,
            },
            "confidence": 0.0,
        }
    except Exception as e:
        log_info(f"[preview-ocr] error={e}")
        return {"ok": False, "error": str(e)}

@app.get("/api/scanner/preview-faces")
def scanner_preview_faces(path: str = ""):
    """
    Preview faces de uma única foto. Não salva no banco, não usa FAISS, não cria cluster.
    """
    decoded = urllib.parse.unquote(path).strip()
    if not decoded or not os.path.isfile(decoded):
        return {"ok": False, "error": "Arquivo não encontrado", "faces": []}

    ext = os.path.splitext(decoded)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        return {"ok": False, "error": "Formato de imagem não suportado", "faces": []}

    try:
        log_info(f"[preview-faces] path={decoded}")

        from scanner_engine import FACE_INFERENCE_LOCK, _scan_last_progress_at
        now = time.time()
        scanner_active = _scan_last_progress_at > 0 and (now - _scan_last_progress_at) < 120.0

        if scanner_active:
            acquired = FACE_INFERENCE_LOCK.acquire(timeout=0.1)
            if not acquired:
                log_info("[face-lock] busy by=preview-faces skipped (scanner ativo)")
                return {"ok": False, "busy": True, "reason": "scanner_running", "faces": []}
        else:
            FACE_INFERENCE_LOCK.acquire()

        try:
            log_info(f"[face-lock] acquired by=preview-faces file={os.path.basename(decoded)}")
            img = cv2.imread(decoded)
            if img is None:
                return {"ok": False, "error": "Falha ao ler imagem", "faces": []}

            h, w = img.shape[:2]
            log_info(f"[preview-faces] img_shape={w}x{h}")

            se.ensure_face_engine()
            app_face = se.get_app_face()
            if app_face is None:
                return {"ok": False, "error": "Motor de deteccao nao disponivel", "faces": []}

            with _suppress_stdout():
                raw_faces = app_face.get(img) or []
        finally:
            FACE_INFERENCE_LOCK.release()

        log_info(f"[preview-faces] detected={len(raw_faces)}")

        result_faces = []
        for face in raw_faces:
            bbox = face.bbox.astype(float).tolist() if hasattr(face, 'bbox') else [0, 0, 0, 0]
            x1, y1, x2, y2 = map(int, bbox[:4])
            confidence = float(getattr(face, 'det_score', 0))
            area = max(0, (x2 - x1) * (y2 - y1))
            crop_url = (
                f"/api/thumb?path={urllib.parse.quote(decoded)}"
                f"&x1={x1}&y1={y1}&x2={x2}&y2={y2}&size=120&q=80"
            )
            result_faces.append({
                "bbox": [x1, y1, x2, y2],
                "confidence": round(confidence, 4),
                "area": area,
                "is_primary": False,
                "crop_url": crop_url,
            })

        result_faces.sort(key=lambda f: f["area"], reverse=True)
        if result_faces:
            result_faces[0]["is_primary"] = True

        return {
            "ok": True,
            "path": decoded,
            "faces": result_faces,
        }
    except Exception as e:
        logging.getLogger(__name__).exception("[preview-faces] failed path=%s", decoded)
        return {"ok": False, "error": str(e), "faces": []}

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


# =====================
# Cloud / Google Drive
# =====================

@app.get("/api/cloud/google/auth/start")
def cloud_google_auth_start():
    try:
        from cloud import get_login_url
        from cloud.drive_auth import CLIENT_SECRETS_FILE
        print(f"[auth/start] CLIENT_SECRETS_FILE={CLIENT_SECRETS_FILE} exists={CLIENT_SECRETS_FILE.exists()}")
        if not CLIENT_SECRETS_FILE.exists():
            return {"error": f"client_secrets.json não encontrado em: {CLIENT_SECRETS_FILE}"}
        auth_url = get_login_url()
        if not auth_url:
            return {"error": "get_login_url() retornou None. Verifique logs do terminal."}
        return {"auth_url": auth_url}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/cloud/google/callback")
def cloud_google_callback(code: str = "", state: str = ""):
    print(f"[GoogleDrive] CALLBACK RECEBIDO code={code[:20]}...")
    try:
        from cloud import exchange_code_for_token, get_user_info
        result = exchange_code_for_token(code, state)
        if result is None:
            return {"error": "Falha ao obter token"}
        token, user_info = result, get_user_info() or {}
        print(f"[GoogleDrive] Callback OK email={user_info.get('email')}")
        return {"status": "ok", "email": user_info.get("email"), "name": user_info.get("name")}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/cloud/google/status")
def cloud_google_status():
    try:
        from cloud import is_authenticated, load_token, get_user_info
        if not is_authenticated():
            return {"connected": False}
        token_data = load_token()
        user_info = get_user_info() or {}
        return {
            "connected": True,
            "email": user_info.get("email", "Unknown"),
            "name": user_info.get("name", "Unknown"),
            "expires_at": token_data.get("expires_at") if token_data else None,
        }
    except Exception as e:
        return {"connected": False, "error": str(e)}


@app.get("/api/cloud/status")
def cloud_status():
    google = cloud_google_status()
    connected = bool(google.get("connected"))
    return {
        "connections": [
            {
                "provider": "google_drive",
                "connected": connected,
                "accountEmail": google.get("email") if connected else None,
                "status": "online" if connected else "disconnected",
            },
            {
                "provider": "dropbox",
                "connected": False,
                "status": "disconnected",
            },
            {
                "provider": "onedrive",
                "connected": False,
                "status": "disconnected",
            },
        ],
        "cache": {
            "folder": "Cache local da nuvem",
            "usedBytes": 0,
        },
    }


@app.get("/api/cloud/providers")
def cloud_providers():
    return {
        "providers": [
            {"provider": "google_drive", "name": "Google Drive", "enabled": True, "functional": True},
            {"provider": "dropbox", "name": "Dropbox", "enabled": False, "functional": False},
            {"provider": "onedrive", "name": "OneDrive", "enabled": False, "functional": False},
        ]
    }


@app.post("/api/cloud/google/logout")
def cloud_google_logout():
    try:
        from cloud import clear_token
        clear_token()
        return {"status": "ok"}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/cloud/google/folders")
def cloud_google_folders(parent_id: str = "root"):
    try:
        from cloud import is_authenticated, drive_manager
        if not is_authenticated():
            return {"error": "Não conectado ao Google Drive", "folders": []}
        folders = drive_manager.list_folders(parent_id)
        return {"folders": [f.model_dump() for f in folders]}
    except Exception as e:
        return {"error": str(e), "folders": []}


@app.get("/api/cloud/google/list")
def cloud_google_list(folderId: str = "root"):
    try:
        from concurrent.futures import ThreadPoolExecutor, TimeoutError
        from cloud import is_authenticated, drive_manager

        if not is_authenticated():
            return {"error": "Não conectado ao Google Drive", "items": [], "folders": [], "photos": 0, "subfolders": 0}

        def _load():
            return drive_manager.list_folder_items(folderId)

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_load)
            try:
                items = future.result(timeout=12)
            except TimeoutError:
                print(f"[cloud/google/list] timeout ao listar folderId={folderId}")
                return {"error": "Timeout ao listar pastas do Google Drive", "items": [], "folders": [], "photos": 0, "subfolders": 0}

        folders = [item for item in items if item.get("isFolder")]
        photos = [item for item in items if not item.get("isFolder")]

        return {
            "items": items,
            "folders": folders,
            "photosList": photos,
            "photos": len(photos),
            "subfolders": len(folders),
            "count": len(items),
            "photosCount": len(photos),
            "subfoldersCount": len(folders),
        }
    except Exception as e:
        print(f"[cloud/google/list] erro folderId={folderId}: {e}")
        return {"error": str(e), "items": [], "folders": [], "photos": 0, "subfolders": 0}


@app.get("/api/cloud/google/summary")
def cloud_google_summary(folder_id: str = "root"):
    try:
        from cloud import is_authenticated, drive_manager
        if not is_authenticated():
            return {"error": "Não conectado ao Google Drive", "photos": 0, "subfolders": 0}
        summary = drive_manager.summarize_folder(folder_id)
        return {
            "photos": summary.get("photos", 0),
            "subfolders": summary.get("subfolders", 0),
        }
    except Exception as e:
        return {"error": str(e), "photos": 0, "subfolders": 0}


@app.get("/api/cloud/google/index")
def cloud_google_index(folder_id: str = "root"):
    try:
        from cloud import is_authenticated, drive_manager
        from cloud.drive_cache import cache, download_queue

        if not is_authenticated():
            return {"error": "Não conectado", "files": []}

        files = drive_manager.list_files(folder_id, page_size=500)
        indexed = []

        for f in files:
            metadata = {
                "drive_file_id": f.id,
                "name": f.name,
                "mime_type": f.mimeType,
                "modified_time": str(f.modifiedTime) if f.modifiedTime else None,
                "size": f.size,
                "parent_folder": folder_id,
                "cached": cache.thumb_exists(f.id),
                "downloaded_full": cache.original_exists(f.id),
            }
            cache.save_metadata(f.id, metadata)
            metadata["thumb_path"] = cache.get_thumb_path(f.id) if cache.thumb_exists(f.id) else None
            indexed.append(metadata)

            # Enfileira download de thumbnail em background
            if not cache.thumb_exists(f.id) and not download_queue.is_downloading(f.id):
                download_queue.add_task(
                    file_id=f.id,
                    file_type="thumb",
                    url=f.thumbnailLink or "",
                    dest_path=cache.get_thumb_dir(),
                    priority=5
                )

        print(f"[CloudThumb] index concluido: {len(indexed)} arquivos, thumb downloads enfileirados")
        return {"files": indexed, "count": len(indexed)}
    except Exception as e:
        return {"error": str(e), "files": []}


PLACEHOLDER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">'
    '<rect width="200" height="200" fill="#1a1a2e" rx="4"/>'
    '<circle cx="100" cy="80" r="28" fill="none" stroke="#374151" stroke-width="3"/>'
    '<path d="M55 155 L65 120 L82 132 L100 95 L118 132 L135 120 L145 155 Z" fill="none" stroke="#374151" stroke-width="2.5"/>'
    '</svg>'
)

@app.get("/api/cloud/thumb")
def cloud_thumb(file_id: str = "", size: int = 200):
    try:
        from cloud.drive_cache import cache, download_queue

        if not file_id:
            return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                            headers={"Cache-Control": "no-store, must-revalidate"})

        thumb_path = cache.get_thumb_path(file_id)

        if cache.thumb_exists(file_id):
            if _is_valid_image_file(thumb_path):
                print(f"[CloudThumb] cache hit: {thumb_path}")
                return FileResponse(thumb_path, media_type="image/jpeg",
                                    headers={"Cache-Control": "public, max-age=86400"})
            else:
                print(f"[CloudThumb] cache corrompido, removendo: {thumb_path}")
                try:
                    os.remove(thumb_path)
                except Exception:
                    pass

        print(f"[CloudThumb] cache miss: {file_id}")

        from cloud import is_authenticated, drive_manager
        if not is_authenticated():
            return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                            headers={"Cache-Control": "no-store, must-revalidate"})

        if not download_queue.is_downloading(file_id):
            metadata = cache.load_metadata(file_id)
            if not metadata:
                return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                                headers={"Cache-Control": "no-store, must-revalidate"})

            file_info = drive_manager.get_file_metadata(file_id)
            thumb_url = file_info.thumbnailLink if file_info and file_info.thumbnailLink else ""

            download_queue.add_task(
                file_id=file_id,
                file_type="thumb",
                url=thumb_url,
                dest_path=cache.get_thumb_dir(),
                priority=1
            )

        return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                        headers={"Cache-Control": "no-store, must-revalidate"})

    except Exception as e:
        print(f"[CloudThumb] erro: {e}")
        return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                        headers={"Cache-Control": "no-store, must-revalidate"})


IMAGE_MAGIC_BYTES = {
    b'\xff\xd8\xff': 'image/jpeg',
    b'\x89PNG': 'image/png',
    b'GIF8': 'image/gif',
    b'RIFF': 'image/webp',
}

GOOGLE_DRIVE_IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/tiff",
    "image/bmp",
}

def _is_valid_image_file(path: str) -> bool:
    try:
        with open(path, 'rb') as f:
            header = f.read(8)
        for magic in IMAGE_MAGIC_BYTES:
            if header.startswith(magic):
                return True
        return False
    except Exception:
        return False


@app.get("/api/cloud/full")
def cloud_full(file_id: str = ""):
    try:
        from cloud.drive_cache import cache, download_queue
        from cloud import is_authenticated, drive_manager

        if not file_id:
            print("[CloudFull] file_id vazio")
            return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                            headers={"Cache-Control": "no-store, must-revalidate"})

        print(f"[CloudFull] file_id = {file_id}")
        original_path = cache.get_original_path(file_id)
        print(f"[CloudFull] local_path = {original_path}")

        local_path_obj = Path(original_path)

        if local_path_obj.exists():
            file_size = local_path_obj.stat().st_size
            is_valid = _is_valid_image_file(original_path)
            print(f"[CloudFull] exists = True, size = {file_size}, is_valid_image = {is_valid}")

            if is_valid:
                print(f"[CloudFull] cache hit valido: {original_path}")
                return FileResponse(
                    path=str(local_path_obj),
                    media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"}
                )
            else:
                print(f"[CloudFull] cache corrompido, removendo e redisponibilizando: {original_path}")
                try:
                    local_path_obj.unlink()
                except Exception:
                    pass

        print(f"[CloudFull] cache miss: {file_id}")

        if is_authenticated() and not download_queue.is_downloading(file_id):
            download_queue.add_task(
                file_id=file_id,
                file_type="original",
                url=f"https://drive.google.com/uc?id={file_id}",
                dest_path=cache.get_original_dir(),
                priority=3
            )
            print(f"[CloudFull] download iniciado: {file_id}")

        return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                        headers={"Cache-Control": "no-store, must-revalidate"})

    except Exception as e:
        print(f"[CloudFull] erro: {e}")
        return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml",
                        headers={"Cache-Control": "no-store, must-revalidate"})


@app.get("/api/cloud/google/files")
def cloud_google_files(folder_id: str = "root"):
    try:
        from cloud.drive_cache import cache

        if not os.path.exists(cache.metadata_dir):
            return {"files": [], "error": "Nenhuma pasta indexada"}

        files = []
        for filename in os.listdir(cache.metadata_dir):
            if filename.endswith('.json'):
                file_id = filename[:-5]
                metadata = cache.load_metadata(file_id)
                if metadata and metadata.get('parent_folder') == folder_id:
                    metadata['has_thumb'] = cache.thumb_exists(file_id)
                    metadata['has_preview'] = cache.preview_exists(file_id)
                    metadata['has_full'] = cache.original_exists(file_id)
                    files.append(metadata)

        return {"files": files, "count": len(files)}
    except Exception as e:
        return {"error": str(e), "files": []}


class CloudCatalogCreateRequest(BaseModel):
    provider: str
    folderId: str = ""
    eventName: str = ""
    source_folder_id: str = ""
    source_folder_name: str = ""
    sourceBreadcrumb: List[str] = []
    source_breadcrumb: List[str] = []
    name: str = ""
    references: List[str] = []
    totalFiles: int = 0
    total_files: int = 0
    totalSubfolders: int = 0
    total_subfolders: int = 0
    mode: str = "face"


class CloudCatalogStateUpsertRequest(BaseModel):
    currentFolderId: str = "root"
    currentPathJson: List[Any] = []
    selectedFolderId: str = ""
    selectedCatalogId: str = ""
    scrollPosition: float = 0.0
    viewMode: str = "catalog"
    backStack: List[Any] = []
    forwardStack: List[Any] = []


class CloudCatalogOpenExistingRequest(BaseModel):
    path: str


class CloudAiProcessRequest(BaseModel):
    limit: int = 12
    force: bool = False
    recursive: bool = True


def _cloud_events_db_path() -> Path:
    base_dir = Path(__file__).resolve().parents[1]
    data_dir = base_dir / "data" / "cloud"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "cloud_events.db"


def _ensure_cloud_events_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cloud_events (
            id TEXT PRIMARY KEY,
            name TEXT,
            type TEXT,
            provider TEXT,
            source_folder_id TEXT,
            source_folder_name TEXT,
            source_breadcrumb_json TEXT,
            references_json TEXT,
            mode TEXT,
            total_files INTEGER,
            total_subfolders INTEGER,
            references_count INTEGER,
            status TEXT,
            catalog_path TEXT,
            cache_path TEXT,
            metadata_path TEXT,
            fpdb_path TEXT,
            last_opened_at TEXT,
            cache_enabled INTEGER,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    columns = {
        "type": "TEXT",
        "source_breadcrumb_json": "TEXT",
        "total_subfolders": "INTEGER",
        "references_count": "INTEGER",
        "catalog_path": "TEXT",
        "cache_path": "TEXT",
        "metadata_path": "TEXT",
        "fpdb_path": "TEXT",
        "last_opened_at": "TEXT",
    }
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(cloud_events)")
    existing = {row[1] for row in cur.fetchall()}
    for column, ddl in columns.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE cloud_events ADD COLUMN {column} {ddl}")


def _cloud_catalogs_root_dir() -> Path:
    settings = app_settings if isinstance(app_settings, dict) else {}
    configured = settings.get("cloud_catalogs_root_dir") or settings.get("cloud_catalog_root_dir")
    if configured:
        root = Path(str(configured)).expanduser()
        if not root.is_absolute():
            root = Path(os.path.abspath(str(root)))
    else:
        documents = Path.home() / "Documents"
        root = (documents if documents.exists() else Path.home()) / "FormaturaPRO_Catalogs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _make_unique_catalog_root(base_dir: Path, desired_name: str) -> Path:
    candidate = base_dir / desired_name
    counter = 2
    while candidate.exists():
        candidate = base_dir / f"{desired_name}_{counter}"
        counter += 1
    return candidate


def _ensure_cloud_event_sqlite(fpdb_path: Path, metadata: Dict[str, Any]) -> None:
    conn = sqlite3.connect(str(fpdb_path))
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cloud_catalogs (
                id TEXT PRIMARY KEY,
                name TEXT,
                type TEXT,
                provider TEXT,
                source_folder_id TEXT,
                source_folder_name TEXT,
                source_breadcrumb TEXT,
                catalog_path TEXT,
                cache_path TEXT,
                mode TEXT,
                status TEXT,
                total_files INTEGER,
                total_subfolders INTEGER,
                references_count INTEGER,
                created_at TEXT,
                updated_at TEXT,
                last_opened_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cloud_photos (
                id TEXT PRIMARY KEY,
                catalog_id TEXT,
                provider TEXT,
                cloud_file_id TEXT,
                name TEXT,
                mime_type TEXT,
                thumbnail_url TEXT,
                web_content_link TEXT,
                size INTEGER,
                parent_folder_id TEXT,
                status TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cloud_catalog_state (
                catalog_id TEXT PRIMARY KEY,
                current_folder_id TEXT,
                current_path_json TEXT,
                selected_folder_id TEXT,
                selected_catalog_id TEXT,
                scroll_position REAL,
                view_mode TEXT,
                updated_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cloud_navigation_history (
                catalog_id TEXT,
                history_type TEXT,
                position INTEGER,
                folder_id TEXT,
                path_json TEXT,
                created_at TEXT
            )
        """)
        conn.execute("""
            INSERT OR REPLACE INTO cloud_catalogs (
                id, name, type, provider, source_folder_id, source_folder_name,
                source_breadcrumb, catalog_path, cache_path, mode, status,
                total_files, total_subfolders, references_count, created_at,
                updated_at, last_opened_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            metadata["id"],
            metadata["name"],
            metadata.get("type", "cloud"),
            metadata["provider"],
            metadata["sourceFolderId"],
            metadata["sourceFolderName"],
            json.dumps(metadata.get("sourceBreadcrumb", []), ensure_ascii=False),
            metadata["catalogPath"],
            metadata["cachePath"],
            metadata.get("mode", "face"),
            metadata.get("status", "indexed"),
            int(metadata.get("totalFiles", 0) or 0),
            int(metadata.get("totalSubfolders", 0) or 0),
            int(metadata.get("referencesCount", len(metadata.get("references", []))) or 0),
            metadata["createdAt"],
            metadata["updatedAt"],
            metadata.get("lastOpenedAt") or metadata["updatedAt"],
        ))
        conn.commit()
    finally:
        conn.close()


def _write_catalog_metadata(metadata_path: Path, metadata: Dict[str, Any]) -> None:
    with metadata_path.open("w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)


def _cloud_catalog_paths_from_any(path: str) -> Optional[Dict[str, Path]]:
    if not path:
        return None
    resolved = Path(os.path.abspath(os.path.expanduser(os.path.expandvars(path))))
    candidates: List[Path] = []
    if resolved.is_file():
        name = resolved.name.lower()
        if name in {"metadata.json", "evento.fpdb"}:
            candidates.append(resolved.parent.parent)
        else:
            candidates.append(resolved.parent)
    elif resolved.is_dir():
        name = resolved.name.lower()
        if name == "catalogo":
            candidates.append(resolved.parent)
        elif name in {"metadata", "sync", "cloud", "cache", "embeddings", "exports", "logs"}:
            candidates.append(resolved.parent)
        else:
            candidates.append(resolved)
            candidates.append(resolved.parent)
    for candidate in candidates:
        if not candidate:
            continue
        metadata_path = candidate / "Catalogo" / "metadata.json"
        fpdb_path = candidate / "Catalogo" / "evento.fpdb"
        if metadata_path.exists() and fpdb_path.exists():
            return {
                "root_dir": candidate,
                "catalog_dir": candidate / "Catalogo",
                "cache_dir": candidate / "Cache",
                "metadata_path": metadata_path,
                "fpdb_path": fpdb_path,
            }
    return None


def _load_cloud_catalog_metadata(path: str) -> Dict[str, Any]:
    paths = _cloud_catalog_paths_from_any(path)
    if not paths:
        raise HTTPException(status_code=404, detail="Estrutura do catálogo cloud não encontrada")
    try:
        with paths["metadata_path"].open("r", encoding="utf-8") as f:
            metadata = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"metadata.json inválido: {e}")
    if not isinstance(metadata, dict):
        raise HTTPException(status_code=400, detail="metadata.json inválido")
    if metadata.get("provider") != "google_drive":
        raise HTTPException(status_code=400, detail="Catálogo cloud incompatível: provider inválido")
    schema_version = int(metadata.get("schemaVersion", 1) or 1)
    if schema_version < 1:
        raise HTTPException(status_code=400, detail="Catálogo cloud incompatível: versão inválida")
    metadata.setdefault("schemaVersion", schema_version)
    metadata.setdefault("type", "cloud")
    metadata.setdefault("status", "indexed")
    metadata.setdefault("sourceBreadcrumb", [])
    metadata.setdefault("references", [])
    metadata.setdefault("totalFiles", 0)
    metadata.setdefault("totalSubfolders", 0)
    metadata.setdefault("referencesCount", len(metadata.get("references", [])))
    metadata.setdefault("catalogPath", str(paths["root_dir"]))
    metadata.setdefault("cachePath", str(paths["cache_dir"]))
    metadata.setdefault("embeddingsPath", str(paths["root_dir"] / "Embeddings"))
    metadata.setdefault("facesDbPath", str(paths["root_dir"] / "Embeddings" / "faces.db"))
    metadata.setdefault("reviewStatePath", str(paths["root_dir"] / "Catalogo" / "review_state.db"))
    metadata.setdefault("metadataPath", str(paths["metadata_path"]))
    metadata.setdefault("fpdbPath", str(paths["fpdb_path"]))
    return metadata


def _ensure_cloud_catalog_state_tables(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cloud_catalogs (
            id TEXT PRIMARY KEY,
            name TEXT,
            type TEXT,
            provider TEXT,
            source_folder_id TEXT,
            source_folder_name TEXT,
            source_breadcrumb TEXT,
            catalog_path TEXT,
            cache_path TEXT,
            mode TEXT,
            status TEXT,
            total_files INTEGER,
            total_subfolders INTEGER,
            references_count INTEGER,
            created_at TEXT,
            updated_at TEXT,
            last_opened_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cloud_catalog_state (
            catalog_id TEXT PRIMARY KEY,
            current_folder_id TEXT,
            current_path_json TEXT,
            selected_folder_id TEXT,
            selected_catalog_id TEXT,
            scroll_position REAL,
            view_mode TEXT,
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cloud_navigation_history (
            catalog_id TEXT,
            history_type TEXT,
            position INTEGER,
            folder_id TEXT,
            path_json TEXT,
            created_at TEXT
        )
    """)


def _normalize_history_entry(entry: Any) -> Dict[str, Any]:
    if isinstance(entry, dict):
        return entry
    return {}


def _save_cloud_catalog_session(
    fpdb_path: Path,
    catalog_id: str,
    state: Dict[str, Any],
    back_stack: List[Any],
    forward_stack: List[Any],
) -> None:
    conn = sqlite3.connect(str(fpdb_path))
    try:
        _ensure_cloud_catalog_state_tables(conn)
        now = datetime.now().isoformat()
        current_path_json = json.dumps(state.get("currentPathJson") or [], ensure_ascii=False)
        conn.execute("""
            INSERT OR REPLACE INTO cloud_catalog_state (
                catalog_id, current_folder_id, current_path_json, selected_folder_id,
                selected_catalog_id, scroll_position, view_mode, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            catalog_id,
            state.get("currentFolderId") or "root",
            current_path_json,
            state.get("selectedFolderId") or "",
            state.get("selectedCatalogId") or "",
            float(state.get("scrollPosition") or 0.0),
            state.get("viewMode") or "catalog",
            now,
        ))
        conn.execute("DELETE FROM cloud_navigation_history WHERE catalog_id = ?", (catalog_id,))
        for history_type, stack in (("back", back_stack), ("forward", forward_stack)):
            for position, entry in enumerate(stack):
                snapshot = _normalize_history_entry(entry)
                conn.execute("""
                    INSERT INTO cloud_navigation_history (
                        catalog_id, history_type, position, folder_id, path_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    catalog_id,
                    history_type,
                    position,
                    snapshot.get("currentFolderId") or snapshot.get("folder_id") or "root",
                    json.dumps(snapshot, ensure_ascii=False),
                    now,
                ))
        conn.commit()
    finally:
        conn.close()


def _load_cloud_catalog_session(fpdb_path: Path, catalog_id: str) -> Dict[str, Any]:
    conn = sqlite3.connect(str(fpdb_path))
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cloud_catalog_state_tables(conn)
        state_row = conn.execute(
            "SELECT * FROM cloud_catalog_state WHERE catalog_id = ?",
            (catalog_id,),
        ).fetchone()
        history_rows = conn.execute(
            "SELECT * FROM cloud_navigation_history WHERE catalog_id = ? ORDER BY history_type, position ASC",
            (catalog_id,),
        ).fetchall()
        back_stack: List[Any] = []
        forward_stack: List[Any] = []
        for row in history_rows:
            try:
                payload = json.loads(row["path_json"] or "{}")
            except Exception:
                payload = {}
            if row["history_type"] == "back":
                back_stack.append(payload)
            else:
                forward_stack.append(payload)
        if state_row:
            try:
                current_path_json = json.loads(state_row["current_path_json"] or "[]")
            except Exception:
                current_path_json = []
            return {
                "currentFolderId": state_row["current_folder_id"] or "root",
                "currentPathJson": current_path_json,
                "selectedFolderId": state_row["selected_folder_id"] or "",
                "selectedCatalogId": state_row["selected_catalog_id"] or "",
                "scrollPosition": float(state_row["scroll_position"] or 0.0),
                "viewMode": state_row["view_mode"] or "catalog",
                "backStack": back_stack,
                "forwardStack": forward_stack,
                "updatedAt": state_row["updated_at"],
            }
        return {
            "currentFolderId": "root",
            "currentPathJson": [],
            "selectedFolderId": "",
            "selectedCatalogId": "",
            "scrollPosition": 0.0,
            "viewMode": "catalog",
            "backStack": [],
            "forwardStack": [],
            "updatedAt": None,
        }
    finally:
        conn.close()


def _cloud_ai_paths_from_catalog_root(root_dir: Path) -> Dict[str, Path]:
    catalog_dir = root_dir / "Catalogo"
    embeddings_dir = root_dir / "Embeddings"
    cache_dir = root_dir / "Cache"
    faces_dir = cache_dir / "faces"
    previews_dir = cache_dir / "previews"
    vectors_dir = embeddings_dir / "vectors"
    faces_db = embeddings_dir / "faces.db"
    clusters_json = embeddings_dir / "clusters.json"
    review_state_db = catalog_dir / "review_state.db"
    return {
        "root_dir": root_dir,
        "catalog_dir": catalog_dir,
        "cache_dir": cache_dir,
        "faces_dir": faces_dir,
        "previews_dir": previews_dir,
        "embeddings_dir": embeddings_dir,
        "vectors_dir": vectors_dir,
        "faces_db": faces_db,
        "clusters_json": clusters_json,
        "review_state_db": review_state_db,
    }


def _ensure_cloud_ai_layout(paths: Dict[str, Path]) -> None:
    for key in ("faces_dir", "previews_dir", "vectors_dir"):
        paths[key].mkdir(parents=True, exist_ok=True)
    paths["faces_db"].touch(exist_ok=True)
    paths["review_state_db"].touch(exist_ok=True)
    if not paths["clusters_json"].exists():
        try:
            with paths["clusters_json"].open("w", encoding="utf-8") as f:
                json.dump({"clusters": []}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass


def _ensure_cloud_ai_schema(paths: Dict[str, Path]) -> None:
    _ensure_cloud_ai_layout(paths)
    conn = sqlite3.connect(str(paths["faces_db"]))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS faces (
                id TEXT PRIMARY KEY,
                photo_id TEXT,
                cloud_file_id TEXT,
                local_cache_path TEXT,
                bbox_json TEXT,
                embedding_path TEXT,
                person_id TEXT,
                confidence REAL,
                status TEXT,
                created_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS people (
                id TEXT PRIMARY KEY,
                name TEXT,
                reference_count INTEGER,
                created_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reference_faces (
                id TEXT PRIMARY KEY,
                person_id TEXT,
                cloud_file_id TEXT,
                bbox_json TEXT,
                embedding_path TEXT,
                quality_score REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS clusters (
                id TEXT PRIMARY KEY,
                person_id TEXT,
                confidence_avg REAL,
                total_faces INTEGER,
                status TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ai_catalog_state (
                catalog_id TEXT PRIMARY KEY,
                last_processed_at TEXT,
                last_batch_size INTEGER,
                last_error TEXT,
                updated_at TEXT
            )
        """)
        conn.commit()
    finally:
        conn.close()


def _ensure_cloud_review_schema(paths: Dict[str, Path]) -> None:
    _ensure_cloud_ai_layout(paths)
    conn = sqlite3.connect(str(paths["review_state_db"]))
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS review_items (
                id TEXT PRIMARY KEY,
                face_id TEXT,
                suggested_person_id TEXT,
                confidence REAL,
                status TEXT,
                decision TEXT,
                updated_at TEXT
            )
        """)
        conn.commit()
    finally:
        conn.close()


def _cloud_ai_paths_for_catalog(catalog_row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Path]:
    root_dir = Path(str(catalog_row["catalog_path"] if isinstance(catalog_row, sqlite3.Row) else catalog_row.get("catalog_path") or catalog_row.get("catalogPath") or "")).expanduser()
    if not root_dir.is_absolute():
        root_dir = Path(os.path.abspath(str(root_dir)))
    paths = _cloud_ai_paths_from_catalog_root(root_dir)
    _ensure_cloud_ai_schema(paths)
    _ensure_cloud_review_schema(paths)
    return paths


def _cloud_ai_connect_paths(catalog_row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Path]:
    if isinstance(catalog_row, sqlite3.Row):
        catalog_path = catalog_row["catalog_path"] or catalog_row["catalogPath"] if "catalogPath" in catalog_row.keys() else catalog_row["catalog_path"]
    else:
        catalog_path = catalog_row.get("catalog_path") or catalog_row.get("catalogPath")
    root_dir = Path(str(catalog_path or "")).expanduser()
    if not root_dir.is_absolute():
        root_dir = Path(os.path.abspath(str(root_dir)))
    return _cloud_ai_paths_from_catalog_root(root_dir)


def _cloud_ai_root_from_catalog_row(catalog_row: sqlite3.Row | Dict[str, Any]) -> Path:
    if isinstance(catalog_row, sqlite3.Row):
        catalog_path = catalog_row["catalog_path"]
    else:
        catalog_path = catalog_row.get("catalog_path") or catalog_row.get("catalogPath")
    root_dir = Path(str(catalog_path or "")).expanduser()
    if not root_dir.is_absolute():
        root_dir = Path(os.path.abspath(str(root_dir)))
    return root_dir


def _cloud_ai_copy_preview(paths: Dict[str, Path], cloud_file_id: str, source_path: str) -> str:
    preview_path = paths["previews_dir"] / f"{cloud_file_id}.jpg"
    if preview_path.exists():
        return str(preview_path)
    if source_path and os.path.exists(source_path):
        try:
            shutil.copy2(source_path, preview_path)
            return str(preview_path)
        except Exception:
            return str(source_path)
    return ""


def _cloud_ai_vector_path(paths: Dict[str, Path], face_id: str) -> Path:
    return paths["vectors_dir"] / f"{face_id}.npy"


def _cloud_ai_face_crop(paths: Dict[str, Path], face_id: str, image: np.ndarray, bbox: List[int]) -> str:
    crop_path = paths["faces_dir"] / f"{face_id}.jpg"
    try:
        x1, y1, x2, y2 = [max(0, int(v)) for v in bbox[:4]]
        h, w = image.shape[:2]
        x1 = min(x1, max(0, w - 1))
        x2 = min(max(x2, x1 + 1), w)
        y1 = min(y1, max(0, h - 1))
        y2 = min(max(y2, y1 + 1), h)
        crop = image[y1:y2, x1:x2]
        if crop.size > 0:
            cv2.imwrite(str(crop_path), crop)
            return str(crop_path)
    except Exception:
        pass
    return ""


def _cloud_ai_load_vector(vector_path: str) -> Optional[np.ndarray]:
    if not vector_path or not os.path.exists(vector_path):
        return None
    try:
        emb = np.load(vector_path)
        if emb is None:
            return None
        arr = np.asarray(emb, dtype="float32").reshape(-1)
        norm = float(np.linalg.norm(arr))
        if norm <= 0:
            return None
        return arr / norm
    except Exception:
        return None


def _cloud_ai_refresh_clusters_json(paths: Dict[str, Path]) -> None:
    conn = sqlite3.connect(str(paths["faces_db"]))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, person_id, confidence_avg, total_faces, status FROM clusters ORDER BY total_faces DESC, confidence_avg DESC"
        ).fetchall()
        payload = {
            "updatedAt": datetime.now().isoformat(),
            "clusters": [dict(row) for row in rows],
        }
        with paths["clusters_json"].open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    finally:
        conn.close()


def _cloud_ai_get_catalog_row(catalog_id: str) -> sqlite3.Row:
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cloud_events_table(conn)
        row = conn.execute("SELECT * FROM cloud_events WHERE id = ?", (catalog_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Catálogo cloud não encontrado")
        return row
    finally:
        conn.close()


def _cloud_ai_resolve_source_path(cloud_file_id: str) -> str:
    try:
        from cloud.drive_cache import cache
        for candidate in (
            cache.get_preview_path(cloud_file_id),
            cache.get_thumb_path(cloud_file_id),
            cache.get_original_path(cloud_file_id),
        ):
            if candidate and os.path.exists(candidate):
                return candidate
    except Exception:
        pass
    return ""


def _cloud_ai_list_drive_files_recursive(folder_id: str, max_depth: int = 8) -> List[Dict[str, Any]]:
    try:
        from cloud.drive_manager import drive_manager
    except Exception:
        return []

    files: List[Dict[str, Any]] = []
    visited: set[str] = set()

    def walk(current_id: str, depth: int) -> None:
        if not current_id or current_id in visited or depth > max_depth:
            return
        visited.add(current_id)
        try:
            for item in drive_manager.list_folder_items(current_id):
                if item.get("isFolder"):
                    walk(str(item.get("id", "")), depth + 1)
                    continue
                files.append({
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "parent": item.get("parentId"),
                    "modifiedTime": item.get("modifiedTime"),
                    "mimeType": item.get("mimeType"),
                    "thumbnailUrl": item.get("thumbnailUrl"),
                    "webContentLink": item.get("webContentLink"),
                    "size": item.get("size"),
                })
        except Exception:
            pass

    walk(folder_id, 0)
    return files


def _cloud_store_photo_rows(conn: sqlite3.Connection, *, catalog_id: str, provider: str, files: List[Dict[str, Any]], now: str) -> int:
    if not files:
        return 0
    inserted = 0
    rows = []
    for file_info in files:
        file_id = str(file_info.get("id") or "").strip()
        if not file_id:
            continue
        rows.append((
            file_id,
            catalog_id,
            provider,
            file_id,
            str(file_info.get("name") or ""),
            str(file_info.get("mimeType") or ""),
            str(file_info.get("thumbnailUrl") or ""),
            str(file_info.get("webContentLink") or ""),
            int(file_info.get("size") or 0),
            str(file_info.get("parent") or file_info.get("parentId") or ""),
            "indexed",
            now,
            now,
        ))
    if not rows:
        return 0
    conn.executemany(
        """
        INSERT OR REPLACE INTO cloud_photos (
            id, catalog_id, provider, cloud_file_id, name, mime_type, thumbnail_url,
            web_content_link, size, parent_folder_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    inserted = len(rows)
    return inserted


def _prepare_cloud_catalog_structure(
    *,
    catalog_id: str,
    name: str,
    provider: str,
    source_folder_id: str,
    source_folder_name: str,
    source_breadcrumb: List[str],
    references: List[str],
    total_files: int,
    total_subfolders: int,
    mode: str,
    now: str,
) -> Dict[str, Any]:
    root_dir = _make_unique_catalog_root(_cloud_catalogs_root_dir(), sanitize_catalog_name(name))
    catalogo_dir = root_dir / "Catalogo"
    cache_dir = root_dir / "Cache"
    thumbs_dir = cache_dir / "thumbs"
    previews_dir = cache_dir / "previews"
    temp_dir = cache_dir / "temp"
    cache_cloud_dir = cache_dir / "cloud"
    faces_cache_dir = cache_dir / "faces"
    previews_cache_dir = cache_dir / "previews"
    embeddings_dir = root_dir / "Embeddings"
    embeddings_vectors_dir = embeddings_dir / "vectors"
    embeddings_faces_db = embeddings_dir / "faces.db"
    embeddings_clusters_json = embeddings_dir / "clusters.json"
    cloud_dir = root_dir / "Cloud"
    cloud_metadata_dir = cloud_dir / "metadata"
    cloud_sync_dir = cloud_dir / "sync"
    exports_dir = root_dir / "Exports"
    logs_dir = root_dir / "Logs"
    review_state_db = catalogo_dir / "review_state.db"

    for path in (
        catalogo_dir,
        thumbs_dir,
        previews_dir,
        faces_cache_dir,
        temp_dir,
        cache_cloud_dir,
        embeddings_dir,
        embeddings_vectors_dir,
        cloud_metadata_dir,
        cloud_sync_dir,
        exports_dir,
        logs_dir,
    ):
        path.mkdir(parents=True, exist_ok=True)

    embeddings_faces_db.touch(exist_ok=True)
    review_state_db.touch(exist_ok=True)
    if not embeddings_clusters_json.exists():
        with embeddings_clusters_json.open("w", encoding="utf-8") as f:
            json.dump({"clusters": []}, f, ensure_ascii=False, indent=2)

    metadata_path = catalogo_dir / "metadata.json"
    fpdb_path = catalogo_dir / "evento.fpdb"
    fpdb_path.touch(exist_ok=True)

    metadata = {
        "id": catalog_id,
        "schemaVersion": 1,
        "name": name,
        "type": "cloud",
        "provider": provider,
        "sourceFolderId": source_folder_id,
        "sourceFolderName": source_folder_name,
        "sourceBreadcrumb": source_breadcrumb,
        "references": references,
        "totalFiles": int(total_files or 0),
        "totalSubfolders": int(total_subfolders or 0),
        "referencesCount": len(references),
        "mode": mode,
        "status": "indexed",
        "createdAt": now,
        "updatedAt": now,
        "catalogPath": str(root_dir),
        "cachePath": str(cache_dir),
    }
    _write_catalog_metadata(metadata_path, metadata)
    _ensure_cloud_event_sqlite(fpdb_path, metadata)
    return {
        "root_dir": root_dir,
        "catalogo_dir": catalogo_dir,
        "cache_dir": cache_dir,
        "faces_cache_dir": faces_cache_dir,
        "previews_cache_dir": previews_cache_dir,
        "embeddings_dir": embeddings_dir,
        "embeddings_vectors_dir": embeddings_vectors_dir,
        "embeddings_faces_db": embeddings_faces_db,
        "embeddings_clusters_json": embeddings_clusters_json,
        "review_state_db": review_state_db,
        "metadata_path": metadata_path,
        "fpdb_path": fpdb_path,
        "metadata": metadata,
    }


def _cloud_event_row_to_dict(row) -> Dict[str, Any]:
    references = []
    try:
        references = json.loads(row["references_json"] or "[]")
    except Exception:
        references = []
    source_breadcrumb = []
    try:
        source_breadcrumb = json.loads(row["source_breadcrumb_json"] or "[]")
    except Exception:
        source_breadcrumb = []
    return {
        "id": row["id"],
        "source": "cloud",
        "type": row["type"] or "cloud",
        "name": row["name"],
        "provider": row["provider"],
        "sourceFolderId": row["source_folder_id"],
        "sourceFolderName": row["source_folder_name"],
        "sourceBreadcrumb": source_breadcrumb,
        "references": references,
        "mode": row["mode"],
        "totalFiles": int(row["total_files"] or 0),
        "totalSubfolders": int(row["total_subfolders"] or 0),
        "referencesCount": int(row["references_count"] or len(references)),
        "status": row["status"],
        "catalogPath": row["catalog_path"],
        "cachePath": row["cache_path"],
        "embeddingsPath": str(Path(row["catalog_path"]) / "Embeddings") if row["catalog_path"] else "",
        "facesDbPath": str(Path(row["catalog_path"]) / "Embeddings" / "faces.db") if row["catalog_path"] else "",
        "reviewStatePath": str(Path(row["catalog_path"]) / "Catalogo" / "review_state.db") if row["catalog_path"] else "",
        "metadataPath": row["metadata_path"],
        "fpdbPath": row["fpdb_path"],
        "lastOpenedAt": row["last_opened_at"],
        "cacheEnabled": bool(row["cache_enabled"]),
        "cacheSize": 0,
        "lastSync": row["updated_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _cloud_ai_schema_paths_for_catalog(catalog_id: str) -> tuple[sqlite3.Row, Dict[str, Path]]:
    catalog_row = _cloud_ai_get_catalog_row(catalog_id)
    paths = _cloud_ai_paths_for_catalog(catalog_row)
    return catalog_row, paths


def _cloud_ai_get_status_payload(catalog_id: str) -> Dict[str, Any]:
    catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    try:
        faces_count = faces_conn.execute("SELECT COUNT(*) AS cnt FROM faces").fetchone()["cnt"]
        embeddings_count = faces_conn.execute("SELECT COUNT(*) AS cnt FROM faces WHERE embedding_path IS NOT NULL AND embedding_path != ''").fetchone()["cnt"]
        clusters_count = faces_conn.execute("SELECT COUNT(*) AS cnt FROM clusters").fetchone()["cnt"]
        review_pending_count = review_conn.execute(
            "SELECT COUNT(*) AS cnt FROM review_items WHERE status = 'pending'"
        ).fetchone()["cnt"]
        last_processed_row = faces_conn.execute(
            "SELECT last_processed_at, last_batch_size, last_error FROM ai_catalog_state WHERE catalog_id = ?",
            (catalog_id,),
        ).fetchone()
        last_processed_at = last_processed_row["last_processed_at"] if last_processed_row else None
        last_error = last_processed_row["last_error"] if last_processed_row else None
        return {
            "success": True,
            "catalogId": catalog_id,
            "catalogPath": str(paths["root_dir"]),
            "cachePath": str(paths["cache_dir"]),
            "facesCount": int(faces_count or 0),
            "embeddingsCount": int(embeddings_count or 0),
            "clustersCount": int(clusters_count or 0),
            "reviewPendingCount": int(review_pending_count or 0),
            "lastProcessedAt": last_processed_at,
            "status": "processing" if last_error and not last_processed_at else ("ready" if faces_count or embeddings_count else "idle"),
            "message": last_error or "IA do catálogo pronta",
        }
    finally:
        faces_conn.close()
        review_conn.close()


def _cloud_ai_list_review_items(catalog_id: str) -> Dict[str, Any]:
    _catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    try:
        rows = review_conn.execute("""
            SELECT r.id, r.face_id, r.suggested_person_id, r.confidence, r.status, r.decision, r.updated_at,
                   f.cloud_file_id, f.local_cache_path, f.bbox_json, f.embedding_path, f.person_id, f.status AS face_status
            FROM review_items r
            LEFT JOIN faces f ON f.id = r.face_id
            ORDER BY r.updated_at DESC
        """).fetchall()
        items = []
        for row in rows:
            items.append({
                "id": row["id"],
                "faceId": row["face_id"],
                "suggestedPersonId": row["suggested_person_id"],
                "confidence": row["confidence"],
                "status": row["status"],
                "decision": row["decision"],
                "updatedAt": row["updated_at"],
                "cloudFileId": row["cloud_file_id"],
                "localCachePath": row["local_cache_path"],
                "bbox": json.loads(row["bbox_json"] or "[]") if row["bbox_json"] else [],
                "embeddingPath": row["embedding_path"],
                "personId": row["person_id"],
                "faceStatus": row["face_status"],
            })
        return {"success": True, "catalogId": catalog_id, "items": items}
    finally:
        faces_conn.close()
        review_conn.close()


def _cloud_ai_find_best_person(
    faces_conn: sqlite3.Connection,
    current_face_id: str,
    embedding: np.ndarray,
    threshold: float = 0.78,
) -> tuple[Optional[str], Optional[str], float]:
    rows = faces_conn.execute("""
        SELECT id, person_id, embedding_path
        FROM faces
        WHERE id != ? AND embedding_path IS NOT NULL AND embedding_path != ''
    """, (current_face_id,)).fetchall()
    best_person_id = None
    best_cluster_id = None
    best_sim = 0.0
    for row in rows:
        other = _cloud_ai_load_vector(row["embedding_path"])
        if other is None:
            continue
        sim = float(np.dot(embedding, other))
        if sim > best_sim:
            best_sim = sim
            best_person_id = row["person_id"] or None
            best_cluster_id = row["person_id"] or None
    if best_sim >= threshold and best_person_id:
        return best_person_id, best_cluster_id, best_sim
    return None, None, best_sim


def _cloud_ai_upsert_cluster(
    conn: sqlite3.Connection,
    person_id: str,
    confidence: float,
    created: bool = False,
) -> None:
    row = conn.execute("SELECT confidence_avg, total_faces FROM clusters WHERE person_id = ?", (person_id,)).fetchone()
    if row:
        total_faces = int(row["total_faces"] or 0) + 1
        prev_avg = float(row["confidence_avg"] or 0.0)
        next_avg = ((prev_avg * (total_faces - 1)) + confidence) / max(total_faces, 1)
        conn.execute(
            "UPDATE clusters SET confidence_avg = ?, total_faces = ?, status = ? WHERE person_id = ?",
            (round(next_avg, 4), total_faces, "active", person_id),
        )
    else:
        conn.execute(
            "INSERT OR REPLACE INTO clusters (id, person_id, confidence_avg, total_faces, status) VALUES (?, ?, ?, ?, ?)",
            (f"cluster_{person_id}", person_id, round(confidence, 4), 1, "active" if created else "pending"),
        )


def _cloud_ai_upsert_person(conn: sqlite3.Connection, person_id: str, name: str = "") -> None:
    row = conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO people (id, name, reference_count, created_at) VALUES (?, ?, ?, ?)",
            (person_id, name or "Pessoa sem nome", 0, datetime.now().isoformat()),
        )


def _cloud_ai_record_reference(conn: sqlite3.Connection, face_id: str, person_id: str, cloud_file_id: str, bbox_json: str, embedding_path: str, quality_score: float) -> None:
    exists = conn.execute("SELECT id FROM reference_faces WHERE face_id = ? OR (cloud_file_id = ? AND person_id = ?)", (face_id, cloud_file_id, person_id)).fetchone()
    if exists:
        return
    conn.execute(
        "INSERT OR REPLACE INTO reference_faces (id, person_id, cloud_file_id, bbox_json, embedding_path, quality_score) VALUES (?, ?, ?, ?, ?, ?)",
        (face_id, person_id, cloud_file_id, bbox_json, embedding_path, quality_score),
    )
    conn.execute("UPDATE people SET reference_count = COALESCE(reference_count, 0) + 1 WHERE id = ?", (person_id,))


def _cloud_ai_process_catalog_impl(catalog_id: str, limit: int = 12, force: bool = False, recursive: bool = True) -> Dict[str, Any]:
    catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    _ensure_cloud_ai_layout(paths)
    _ensure_cloud_ai_schema(paths)
    _ensure_cloud_review_schema(paths)

    source_folder_id = catalog_row["source_folder_id"] or ""
    if not source_folder_id:
        raise HTTPException(status_code=400, detail="Catálogo cloud sem pasta de origem")

    files = _cloud_ai_list_drive_files_recursive(source_folder_id) if recursive else []
    if not files:
        try:
            from cloud.drive_manager import drive_manager
            files = [
                {
                    "id": f.id,
                    "name": f.name,
                    "parent": f.parent,
                    "modifiedTime": f.modifiedTime,
                    "mimeType": f.mimeType,
                }
                for f in drive_manager.list_files(source_folder_id)
            ]
        except Exception:
            files = []

    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    processed = 0
    skipped = 0
    errors = 0
    last_error = ""
    now = datetime.now().isoformat()
    try:
        existing_file_ids = {
            row["cloud_file_id"]
            for row in faces_conn.execute(
                "SELECT DISTINCT cloud_file_id FROM faces WHERE cloud_file_id IS NOT NULL AND cloud_file_id != ''"
            ).fetchall()
        }
        candidates = [f for f in files if force or f["id"] not in existing_file_ids]
        candidates = candidates[: max(1, int(limit or 12))]
        from scanner_engine import ensure_face_engine, get_app_face, FACE_INFERENCE_LOCK
        ensure_face_engine()
        app_face = get_app_face()
        if app_face is None:
            raise HTTPException(status_code=503, detail="Motor de face indisponível")
        for file_info in candidates:
            cloud_file_id = file_info["id"]
            source_path = _cloud_ai_resolve_source_path(cloud_file_id)
            if not source_path:
                skipped += 1
                continue
            try:
                img = cv2.imread(source_path)
                if img is None:
                    skipped += 1
                    continue
                with FACE_INFERENCE_LOCK:
                    with _suppress_stdout():
                        faces = app_face.get(img) or []
                if not faces:
                    skipped += 1
                    continue
                preview_path = _cloud_ai_copy_preview(paths, cloud_file_id, source_path)
                for idx, face in enumerate(faces):
                    face_id = str(uuid.uuid4())
                    bbox = [int(face.bbox[0]), int(face.bbox[1]), int(face.bbox[2]), int(face.bbox[3])]
                    bbox_json = json.dumps(bbox, ensure_ascii=False)
                    crop_path = _cloud_ai_face_crop(paths, face_id, img, bbox)
                    if not crop_path:
                        crop_path = str(paths["faces_dir"] / f"{face_id}.jpg")
                    emb = np.asarray(face.embedding, dtype="float32").reshape(-1)
                    norm = float(np.linalg.norm(emb))
                    if norm <= 0:
                        skipped += 1
                        continue
                    emb = emb / norm
                    vector_path = _cloud_ai_vector_path(paths, face_id)
                    np.save(str(vector_path), emb.astype("float32"))
                    confidence = float(getattr(face, "det_score", 0.0) or 0.0)
                    person_id, cluster_match_id, similarity = _cloud_ai_find_best_person(faces_conn, face_id, emb)
                    if not person_id:
                        person_id = f"person_{uuid.uuid4().hex[:12]}"
                        _cloud_ai_upsert_person(faces_conn, person_id, name=f"Pessoa {processed + idx + 1}")
                        _cloud_ai_upsert_cluster(faces_conn, person_id, confidence, created=True)
                    else:
                        _cloud_ai_upsert_person(faces_conn, person_id, name=f"Pessoa {person_id[-6:]}")
                        _cloud_ai_upsert_cluster(faces_conn, person_id, confidence, created=False)
                    local_cache_path = crop_path
                    faces_conn.execute(
                        """
                        INSERT OR REPLACE INTO faces (
                            id, photo_id, cloud_file_id, local_cache_path, bbox_json, embedding_path,
                            person_id, confidence, status, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            face_id,
                            cloud_file_id,
                            cloud_file_id,
                            local_cache_path,
                            bbox_json,
                            str(vector_path),
                            person_id,
                            confidence,
                            "processed",
                            now,
                        ),
                    )
                    review_conf = similarity if similarity > 0 else confidence
                    review_status = "pending" if review_conf < 0.82 else "ready"
                    review_decision = None if review_status == "pending" else "auto_accept"
                    review_item_id = f"review_{face_id}"
                    review_conn.execute(
                        """
                        INSERT OR REPLACE INTO review_items (
                            id, face_id, suggested_person_id, confidence, status, decision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            review_item_id,
                            face_id,
                            person_id,
                            round(float(review_conf), 4),
                            review_status,
                            review_decision,
                            now,
                        ),
                    )
                    if review_status != "pending" or confidence >= 0.92:
                        _cloud_ai_record_reference(
                            faces_conn,
                            face_id,
                            person_id,
                            cloud_file_id,
                            bbox_json,
                            str(vector_path),
                            round(confidence, 4),
                        )
                    processed += 1
                faces_conn.commit()
                review_conn.commit()
            except Exception as file_exc:
                errors += 1
                last_error = str(file_exc)
        faces_conn.execute(
            """
            INSERT OR REPLACE INTO ai_catalog_state (
                catalog_id, last_processed_at, last_batch_size, last_error, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (catalog_id, now, processed, last_error, now),
        )
        faces_conn.commit()
        _cloud_ai_refresh_clusters_json(paths)
        return {
            "success": True,
            "catalogId": catalog_id,
            "processed": processed,
            "skipped": skipped,
            "errors": errors,
            "lastProcessedAt": now,
            "status": "ready" if processed > 0 else "idle",
            "message": "IA persistente processada no catálogo" if processed > 0 else "Nenhuma nova face encontrada no cache",
        }
    except HTTPException:
        raise
    except Exception as e:
        last_error = str(e)
        try:
            faces_conn.execute(
                """
                INSERT OR REPLACE INTO ai_catalog_state (
                    catalog_id, last_processed_at, last_batch_size, last_error, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (catalog_id, now, processed, last_error, now),
            )
            faces_conn.commit()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=last_error or str(e))
    finally:
        faces_conn.close()
        review_conn.close()


def _cloud_ai_set_review_decision(catalog_id: str, review_id: str, decision: str) -> Dict[str, Any]:
    _catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    try:
        review = review_conn.execute("SELECT * FROM review_items WHERE id = ?", (review_id,)).fetchone()
        if not review:
            raise HTTPException(status_code=404, detail="Item de revisão não encontrado")
        now = datetime.now().isoformat()
        if decision == "confirm":
            review_conn.execute(
                "UPDATE review_items SET status = ?, decision = ?, updated_at = ? WHERE id = ?",
                ("resolved", "confirm", now, review_id),
            )
            face = faces_conn.execute("SELECT * FROM faces WHERE id = ?", (review["face_id"],)).fetchone()
            if face:
                person_id = review["suggested_person_id"] or face["person_id"]
                if person_id:
                    faces_conn.execute(
                        "UPDATE faces SET person_id = ?, status = ? WHERE id = ?",
                        (person_id, "confirmed", face["id"]),
                    )
                    _cloud_ai_upsert_person(faces_conn, person_id, name=f"Pessoa {person_id[-6:]}")
                    _cloud_ai_upsert_cluster(faces_conn, person_id, float(review["confidence"] or 0.0), created=False)
                    _cloud_ai_record_reference(
                        faces_conn,
                        face["id"],
                        person_id,
                        face["cloud_file_id"] or "",
                        face["bbox_json"] or "[]",
                        face["embedding_path"] or "",
                        float(review["confidence"] or 0.0),
                    )
        elif decision == "reject":
            review_conn.execute(
                "UPDATE review_items SET status = ?, decision = ?, updated_at = ? WHERE id = ?",
                ("rejected", "reject", now, review_id),
            )
            faces_conn.execute(
                "UPDATE faces SET status = ? WHERE id = ?",
                ("rejected", review["face_id"]),
            )
        else:
            raise HTTPException(status_code=400, detail="Decisão inválida")
        faces_conn.commit()
        review_conn.commit()
        _cloud_ai_refresh_clusters_json(paths)
        return {"success": True, "reviewId": review_id, "decision": decision}
    finally:
        faces_conn.close()
        review_conn.close()


@app.post("/api/cloud/catalogs")
def cloud_create_catalog(req: CloudCatalogCreateRequest):
    try:
        folder_id = req.source_folder_id or req.folderId
        event_name = (req.name or req.eventName).strip()
        source_folder_name = (req.source_folder_name or event_name).strip()
        total_files = req.total_files or req.totalFiles
        total_subfolders = req.total_subfolders or req.totalSubfolders
        source_breadcrumb = req.source_breadcrumb or req.sourceBreadcrumb or []

        if req.provider != "google_drive":
            return {"error": "Provedor cloud ainda não suportado", "status": "draft"}
        if not folder_id:
            return {"error": "folderId é obrigatório", "status": "draft"}
        if not event_name:
            return {"error": "eventName é obrigatório", "status": "draft"}
        if req.mode not in {"catalog", "face", "full"}:
            return {"error": "Modo de catálogo inválido", "status": "draft"}

        catalog_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        structure = _prepare_cloud_catalog_structure(
            catalog_id=catalog_id,
            name=event_name,
            provider=req.provider,
            source_folder_id=folder_id,
            source_folder_name=source_folder_name,
            source_breadcrumb=source_breadcrumb,
            references=req.references,
            total_files=int(total_files or 0),
            total_subfolders=int(total_subfolders or 0),
            mode=req.mode,
            now=now,
        )
        photo_files = _cloud_ai_list_drive_files_recursive(folder_id)
        if not photo_files:
            try:
                from cloud import drive_manager
                photo_files = [
                    {
                        "id": item.id,
                        "name": item.name,
                        "mimeType": item.mimeType,
                        "thumbnailUrl": item.thumbnailLink,
                        "webContentLink": item.webContentLink or item.webViewLink,
                        "size": item.size,
                        "parent": item.parent,
                    }
                    for item in drive_manager.list_files(folder_id)
                ]
            except Exception:
                photo_files = []
        conn = sqlite3.connect(str(_cloud_events_db_path()))
        try:
            _ensure_cloud_events_table(conn)
            conn.execute(
                """
                INSERT OR REPLACE INTO cloud_events (
                    id, name, type, provider, source_folder_id, source_folder_name,
                    source_breadcrumb_json, references_json, mode, total_files, total_subfolders,
                    references_count, status, catalog_path, cache_path, metadata_path, fpdb_path,
                    last_opened_at, cache_enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    catalog_id,
                    event_name,
                    "cloud",
                    req.provider,
                    folder_id,
                    source_folder_name,
                    json.dumps(source_breadcrumb, ensure_ascii=False),
                    json.dumps(req.references, ensure_ascii=False),
                    req.mode,
                    int(total_files or 0),
                    int(total_subfolders or 0),
                    len(req.references or []),
                    "indexed",
                    str(structure["root_dir"]),
                    str(structure["cache_dir"]),
                    str(structure["metadata_path"]),
                    str(structure["fpdb_path"]),
                    now,
                    1,
                    now,
                    now,
                )
            )
            conn.commit()
        finally:
            conn.close()

        fpdb_conn = sqlite3.connect(str(structure["fpdb_path"]))
        try:
            _ensure_cloud_event_sqlite(structure["fpdb_path"], structure["metadata"])
            _cloud_store_photo_rows(
                fpdb_conn,
                catalog_id=catalog_id,
                provider=req.provider,
                files=photo_files,
                now=now,
            )
            fpdb_conn.commit()
        finally:
            fpdb_conn.close()

        return {
            "success": True,
            "catalogId": catalog_id,
            "status": "indexed",
            "catalog": {
                "id": catalog_id,
                "source": "cloud",
                "type": "cloud",
                "name": event_name,
                "provider": req.provider,
                "sourceFolderId": folder_id,
                "sourceFolderName": source_folder_name,
                "sourceBreadcrumb": source_breadcrumb,
                "references": req.references,
                "mode": req.mode,
                "totalFiles": int(total_files or 0),
                "totalSubfolders": int(total_subfolders or 0),
                "referencesCount": len(req.references or []),
                "status": "indexed",
                "catalogPath": str(structure["root_dir"]),
                "cachePath": str(structure["cache_dir"]),
                "embeddingsPath": str(structure["root_dir"] / "Embeddings"),
                "facesDbPath": str(structure["embeddings_faces_db"]),
                "reviewStatePath": str(structure["review_state_db"]),
                "metadataPath": str(structure["metadata_path"]),
                "fpdbPath": str(structure["fpdb_path"]),
                "lastOpenedAt": now,
                "cacheEnabled": True,
                "cacheSize": 0,
                "lastSync": now,
                "createdAt": now,
                "updatedAt": now,
            },
            "photosCount": len(photo_files),
            "photosInserted": len(photo_files),
        }
    except Exception as e:
        return {"success": False, "error": str(e), "status": "draft"}


@app.get("/api/cloud/catalogs")
def cloud_list_catalogs():
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    conn.row_factory = sqlite3.Row
    try:
      _ensure_cloud_events_table(conn)
      rows = conn.execute(
          "SELECT * FROM cloud_events ORDER BY COALESCE(last_opened_at, updated_at, created_at) DESC, updated_at DESC, created_at DESC LIMIT 12"
      ).fetchall()
      return {"success": True, "catalogs": [_cloud_event_row_to_dict(row) for row in rows]}
    finally:
      conn.close()


@app.get("/api/cloud/catalogs/{catalog_id}")
def cloud_get_catalog(catalog_id: str):
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cloud_events_table(conn)
        now = datetime.now().isoformat()
        conn.execute(
            "UPDATE cloud_events SET updated_at = ?, last_opened_at = ? WHERE id = ?",
            (now, now, catalog_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM cloud_events WHERE id = ?", (catalog_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Catálogo cloud não encontrado")
        catalog = _cloud_event_row_to_dict(row)
        session = {}
        try:
            fpdb_path = Path(catalog.get("fpdbPath") or "")
            if fpdb_path.exists():
                session = _load_cloud_catalog_session(fpdb_path, catalog_id)
        except Exception:
            session = {}
        return {"success": True, "catalog": catalog, "session": session}
    finally:
        conn.close()


@app.get("/api/cloud/catalogs/{catalog_id}/session")
def cloud_get_catalog_session(catalog_id: str):
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cloud_events_table(conn)
        row = conn.execute("SELECT * FROM cloud_events WHERE id = ?", (catalog_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Catálogo cloud não encontrado")
        catalog = _cloud_event_row_to_dict(row)
        fpdb_path = Path(catalog.get("fpdbPath") or "")
        if not fpdb_path.exists():
            raise HTTPException(status_code=404, detail="Arquivo fpdb do catálogo não encontrado")
        return {"success": True, "session": _load_cloud_catalog_session(fpdb_path, catalog_id)}
    finally:
        conn.close()


@app.post("/api/cloud/catalogs/{catalog_id}/session")
def cloud_save_catalog_session(catalog_id: str, req: CloudCatalogStateUpsertRequest):
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cloud_events_table(conn)
        row = conn.execute("SELECT * FROM cloud_events WHERE id = ?", (catalog_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Catálogo cloud não encontrado")
        catalog = _cloud_event_row_to_dict(row)
        fpdb_path = Path(catalog.get("fpdbPath") or "")
        if not fpdb_path.exists():
            raise HTTPException(status_code=404, detail="Arquivo fpdb do catálogo não encontrado")
        _save_cloud_catalog_session(
            fpdb_path,
            catalog_id,
            req.dict(),
            req.backStack,
            req.forwardStack,
        )
        now = datetime.now().isoformat()
        conn.execute(
            "UPDATE cloud_events SET last_opened_at = ?, updated_at = ? WHERE id = ?",
            (now, now, catalog_id),
        )
        conn.commit()
        return {"success": True, "updatedAt": now}
    finally:
        conn.close()


@app.post("/api/cloud/catalogs/open-existing")
def cloud_open_existing_catalog(req: CloudCatalogOpenExistingRequest):
    metadata = _load_cloud_catalog_metadata(req.path)
    paths = _cloud_catalog_paths_from_any(req.path)
    if not paths:
        raise HTTPException(status_code=404, detail="Estrutura do catálogo cloud não encontrada")
    _ensure_cloud_ai_schema(_cloud_ai_paths_from_catalog_root(paths["root_dir"]))
    _ensure_cloud_review_schema(_cloud_ai_paths_from_catalog_root(paths["root_dir"]))

    catalog_id = str(metadata.get("id") or uuid.uuid4())
    now = datetime.now().isoformat()
    metadata.update({
        "id": catalog_id,
        "updatedAt": now,
        "lastOpenedAt": now,
        "type": metadata.get("type", "cloud"),
        "referencesCount": int(metadata.get("referencesCount", len(metadata.get("references", []))) or 0),
        "catalogPath": str(paths["root_dir"]),
        "cachePath": str(paths["cache_dir"]),
        "metadataPath": str(paths["metadata_path"]),
        "fpdbPath": str(paths["fpdb_path"]),
    })
    _ensure_cloud_event_sqlite(paths["fpdb_path"], metadata)
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    try:
        _ensure_cloud_events_table(conn)
        conn.execute(
            """
            INSERT OR REPLACE INTO cloud_events (
                id, name, type, provider, source_folder_id, source_folder_name,
                source_breadcrumb_json, references_json, mode, total_files, total_subfolders,
                references_count, status, catalog_path, cache_path, metadata_path, fpdb_path,
                last_opened_at, cache_enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                catalog_id,
                metadata.get("name", ""),
                metadata.get("type", "cloud"),
                metadata.get("provider", "google_drive"),
                metadata.get("sourceFolderId", ""),
                metadata.get("sourceFolderName", ""),
                json.dumps(metadata.get("sourceBreadcrumb", []), ensure_ascii=False),
                json.dumps(metadata.get("references", []), ensure_ascii=False),
                metadata.get("mode", "face"),
                int(metadata.get("totalFiles", 0) or 0),
                int(metadata.get("totalSubfolders", 0) or 0),
                int(metadata.get("referencesCount", len(metadata.get("references", []))) or 0),
                metadata.get("status", "indexed"),
                str(paths["root_dir"]),
                str(paths["cache_dir"]),
                str(paths["metadata_path"]),
                str(paths["fpdb_path"]),
                now,
                1,
                metadata.get("createdAt", now),
                now,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    catalog_dict = {
        "id": catalog_id,
        "source": "cloud",
        "type": metadata.get("type", "cloud"),
        "name": metadata.get("name", ""),
        "provider": metadata.get("provider", "google_drive"),
        "sourceFolderId": metadata.get("sourceFolderId", ""),
        "sourceFolderName": metadata.get("sourceFolderName", ""),
        "sourceBreadcrumb": metadata.get("sourceBreadcrumb", []),
        "references": metadata.get("references", []),
        "mode": metadata.get("mode", "face"),
        "totalFiles": int(metadata.get("totalFiles", 0) or 0),
        "totalSubfolders": int(metadata.get("totalSubfolders", 0) or 0),
        "referencesCount": int(metadata.get("referencesCount", len(metadata.get("references", []))) or 0),
        "status": metadata.get("status", "indexed"),
        "catalogPath": str(paths["root_dir"]),
        "cachePath": str(paths["cache_dir"]),
        "embeddingsPath": str(paths["root_dir"] / "Embeddings"),
        "facesDbPath": str(paths["root_dir"] / "Embeddings" / "faces.db"),
        "reviewStatePath": str(paths["root_dir"] / "Catalogo" / "review_state.db"),
        "metadataPath": str(paths["metadata_path"]),
        "fpdbPath": str(paths["fpdb_path"]),
        "lastOpenedAt": now,
        "cacheEnabled": True,
        "cacheSize": 0,
        "lastSync": now,
        "createdAt": metadata.get("createdAt", now),
        "updatedAt": now,
    }

    return {
        "success": True,
        "catalogId": catalog_id,
        "catalog": catalog_dict,
        "session": _load_cloud_catalog_session(paths["fpdb_path"], catalog_id),
    }


@app.post("/api/cloud/catalogs/{catalog_id}/ai/process")
def cloud_ai_process_catalog(catalog_id: str, req: CloudAiProcessRequest):
    return _cloud_ai_process_catalog_impl(catalog_id, limit=req.limit, force=req.force, recursive=req.recursive)


@app.get("/api/cloud/catalogs/{catalog_id}/ai/status")
def cloud_ai_catalog_status(catalog_id: str):
    return _cloud_ai_get_status_payload(catalog_id)


@app.get("/api/cloud/catalogs/{catalog_id}/ai/review-items")
def cloud_ai_catalog_review_items(catalog_id: str):
    return _cloud_ai_list_review_items(catalog_id)


@app.post("/api/cloud/catalogs/{catalog_id}/ai/review-items/{review_id}/confirm")
def cloud_ai_confirm_review_item(catalog_id: str, review_id: str):
    return _cloud_ai_set_review_decision(catalog_id, review_id, "confirm")


@app.post("/api/cloud/catalogs/{catalog_id}/ai/review-items/{review_id}/reject")
def cloud_ai_reject_review_item(catalog_id: str, review_id: str):
    return _cloud_ai_set_review_decision(catalog_id, review_id, "reject")


@app.delete("/api/cloud/catalogs/{catalog_id}")
def cloud_delete_catalog(catalog_id: str, scope: str = "recent"):
    scope = (scope or "recent").strip().lower()
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cloud_events_table(conn)
        row = conn.execute("SELECT * FROM cloud_events WHERE id = ?", (catalog_id,)).fetchone()
        if not row:
            return {"success": False, "error": "Catálogo cloud não encontrado"}
        if scope in {"catalog_cache", "all"}:
            catalog_path = Path(row["catalog_path"] or "")
            if catalog_path.exists():
                try:
                    if scope == "all":
                        shutil.rmtree(catalog_path, ignore_errors=True)
                    else:
                        for subpath in [
                            catalog_path / "Cache",
                            catalog_path / "Embeddings",
                            catalog_path / "Cloud",
                            catalog_path / "Exports",
                            catalog_path / "Logs",
                            catalog_path / "Catalogo" / "review_state.db",
                        ]:
                            if subpath.is_dir():
                                shutil.rmtree(subpath, ignore_errors=True)
                            elif subpath.exists():
                                try:
                                    subpath.unlink()
                                except Exception:
                                    pass
                except Exception as exc:
                    raise HTTPException(status_code=500, detail=f"Falha ao apagar arquivos do catálogo: {exc}")
        cur = conn.execute("DELETE FROM cloud_events WHERE id = ?", (catalog_id,))
        conn.commit()
        return {"success": cur.rowcount > 0, "scope": scope}
    finally:
        conn.close()


@app.post("/api/cloud/google/create-catalog")
def cloud_google_create_catalog(folder_id: str = "root", catalog_name: str = "", mode: str = "metadata_only"):
    try:
        from cloud.drive_cache import cache
        from cloud import is_authenticated, drive_manager
        import sqlite3

        if not catalog_name:
            return {"error": "Nome do catálogo é obrigatório"}

        catalog_name_safe = "".join(c for c in catalog_name if c.isalnum() or c in " _-").strip().replace(" ", "_")
        if not catalog_name_safe:
            return {"error": "Nome inválido"}

        BASE_DIR = Path(__file__).resolve().parents[1]
        catalogs_dir = BASE_DIR / "data" / "catalogs"
        catalogs_dir.mkdir(parents=True, exist_ok=True)

        catalog_path = catalogs_dir / f"{catalog_name_safe}.db"

        print(f"[CloudCatalog] catalog_path = {catalog_path}")
        print(f"[CloudCatalog] parent exists = {catalog_path.parent.exists()}")
        print(f"[CloudCatalog] writable = {os.access(str(catalog_path.parent), os.W_OK)}")

        if catalog_path.exists():
            return {"error": f"Catálogo '{catalog_name_safe}' já existe"}

        conn = sqlite3.connect(str(catalog_path))
        cur = conn.cursor()

        cur.execute("""
            CREATE TABLE IF NOT EXISTS alunos (
                aluno_id TEXT PRIMARY KEY,
                face_cache_path TEXT,
                class_name TEXT DEFAULT 'Sem turma',
                source_type TEXT DEFAULT 'local',
                drive_file_id TEXT,
                cloud_status TEXT DEFAULT 'pending',
                local_full_path TEXT,
                downloaded_full INTEGER DEFAULT 0
            )
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS ocorrencias (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                foto_path TEXT,
                aluno_id TEXT,
                x1 REAL, y1 REAL, x2 REAL, y2 REAL,
                photo_hash TEXT,
                blur_score REAL,
                blur_status TEXT,
                closed_eyes INTEGER,
                foreground_score REAL,
                is_foreground INTEGER,
                face_area_ratio REAL,
                center_score REAL,
                background_penalty_reason TEXT,
                source_type TEXT DEFAULT 'local',
                drive_file_id TEXT
            )
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS discarded_photos (
                foto_path TEXT PRIMARY KEY
            )
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS scan_checkpoints (
                scan_key TEXT PRIMARY KEY,
                ori_path TEXT,
                ref_path TEXT,
                last_batch_index INTEGER,
                total_batches INTEGER,
                updated_at REAL
            )
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS cloud_photos (
                id TEXT PRIMARY KEY,
                catalog_id TEXT,
                provider TEXT,
                cloud_file_id TEXT,
                name TEXT,
                mime_type TEXT,
                thumbnail_url TEXT,
                web_content_link TEXT,
                size INTEGER,
                parent_folder_id TEXT,
                status TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        """)

        indexed_files = []
        if is_authenticated():
            try:
                indexed_files = _cloud_ai_list_drive_files_recursive(folder_id)
            except Exception:
                indexed_files = []

        if not indexed_files:
            for filename in os.listdir(cache.metadata_dir):
                if filename.endswith('.json'):
                    file_id = filename[:-5]
                    metadata = cache.load_metadata(file_id)
                    if metadata and metadata.get('parent_folder') == folder_id:
                        indexed_files.append({
                            "id": metadata.get("drive_file_id", file_id),
                            "name": metadata.get("name") or file_id,
                            "mimeType": metadata.get("mime_type") or "image/jpeg",
                            "thumbnailUrl": metadata.get("thumbnail_url") or "",
                            "webContentLink": metadata.get("web_content_link") or "",
                            "size": metadata.get("size"),
                            "parent": metadata.get("parent_folder") or folder_id,
                        })

        now = datetime.now().isoformat()
        for f in indexed_files:
            drive_file_id = f.get("id") or f.get("drive_file_id")
            if not drive_file_id:
                continue
            foto_path = f"cloud://{drive_file_id}"
            cur.execute(
                "INSERT OR IGNORE INTO ocorrencias (foto_path, aluno_id, source_type, drive_file_id, blur_status) VALUES (?, ?, ?, ?, ?)",
                (foto_path, "Pessoa 1", "google_drive", drive_file_id, "unknown")
            )
            cur.execute(
                """
                INSERT OR REPLACE INTO cloud_photos (
                    id, catalog_id, provider, cloud_file_id, name, mime_type, thumbnail_url,
                    web_content_link, size, parent_folder_id, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    drive_file_id,
                    catalog_name_safe,
                    "google_drive",
                    drive_file_id,
                    f.get('name') or drive_file_id,
                    f.get('mimeType') or 'image/jpeg',
                    f.get('thumbnailUrl') or '',
                    f.get('webContentLink') or '',
                    int(f.get('size') or 0),
                    f.get('parent') or folder_id,
                    'indexed',
                    now,
                    now,
                )
            )

        conn.commit()
        conn.close()

        return {
            "status": "ok",
            "catalog": catalog_name_safe,
            "path": catalog_path,
            "photos_count": len(indexed_files),
            "message": f"Catálogo '{catalog_name_safe}' criado com {len(indexed_files)} fotos"
        }

    except Exception as e:
        return {"error": str(e)}


@app.get("/api/cloud/google/download-full")
def cloud_google_download_full(file_id: str = ""):
    try:
        from cloud.drive_cache import cache, download_queue
        from cloud import is_authenticated, drive_manager

        if not file_id:
            return {"error": "file_id obrigatório"}

        if cache.original_exists(file_id):
            local_path = cache.get_original_path(file_id)
            local_path_obj = Path(local_path)
            file_size = local_path_obj.stat().st_size if local_path_obj.exists() else 0
            is_valid = _is_valid_image_file(local_path)
            print(f"[CloudFull] cache hit: {local_path}, size={file_size}, valid={is_valid}")
            if is_valid:
                full_url = f"/api/cloud/full?file_id={file_id}"
                return {
                    "success": True,
                    "local_path": local_path,
                    "url": full_url,
                    "file_id": file_id
                }
            else:
                print(f"[CloudFull] cache corrompido, redisponibilizando: {local_path}")
                try:
                    local_path_obj.unlink()
                except Exception:
                    pass

        if not is_authenticated():
            return {"error": "Não conectado"}

        file_info = drive_manager.get_file_metadata(file_id)
        if not file_info:
            return {"error": "Arquivo não encontrado"}

        metadata = cache.load_metadata(file_id)
        if not metadata:
            return {"error": "Arquivo não indexado"}

        if download_queue.is_downloading(file_id):
            print(f"[CloudFull] ja esta baixando: {file_id}")
            return {"success": False, "status": "downloading", "file_id": file_id}

        download_queue.add_task(
            file_id=file_id,
            file_type="original",
            url=f"https://drive.google.com/uc?id={file_id}",
            dest_path=cache.get_original_dir(),
            priority=3
        )

        print(f"[CloudFull] downloading iniciado: {file_id}")
        return {"success": False, "status": "downloading", "file_id": file_id}

    except Exception as e:
        print(f"[CloudFull] erro: {e}")
        return {"error": str(e)}


@app.get("/api/photo-source/full")
def photo_source_full(path: str = ""):
    try:
        if not path:
            raise HTTPException(status_code=400, detail="path obrigatorio")

        from photo_sources import resolve_photo_source
        photo = {"foto_path": path}
        source = resolve_photo_source(photo)
        local_path = source.get_full_path(photo)

        if local_path and os.path.exists(local_path):
            print(f"[PhotoSource] full: {local_path}")
            return FileResponse(
                path=local_path,
                media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=86400"},
            )

        from photo_sources.google_drive_source import GoogleDrivePhotoSource
        if isinstance(source, GoogleDrivePhotoSource):
            source.trigger_download(photo)
            print(f"[PhotoSource] download triggered for: {path}")
            return Response(status_code=202, content='{"status":"downloading"}', media_type="application/json")

        raise HTTPException(status_code=404, detail="Arquivo nao encontrado")

    except HTTPException:
        raise
    except Exception as e:
        print(f"[PhotoSource] erro: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/ai/photo-status")
def ai_photo_status(photo_id: int = 0, catalog: str = "", foto_path: str = ""):
    try:
        BASE_DIR = Path(__file__).resolve().parents[1]
        catalogs_dir = BASE_DIR / "data" / "catalogs"

        if catalog:
            catalog_path = catalogs_dir / f"{catalog}.db"
            if not catalog_path.exists():
                return {"error": "Catalogo nao encontrado"}
            conn = sqlite3.connect(str(catalog_path))
            conn.row_factory = sqlite3.Row
            c = conn.cursor()

            status = {"processing": False, "ocr": False, "embedding": False, "face_detected": False}

            if photo_id:
                c.execute("SELECT status FROM photos WHERE id = ?", (photo_id,))
                row = c.fetchone()
                if row:
                    is_processed = row["status"] == "processed"
                    status["processing"] = row["status"] in ("pending", "curating")
                    status["ocr"] = is_processed
                    c.execute("SELECT 1 FROM faces WHERE photo_id = ? LIMIT 1", (photo_id,))
                    status["face_detected"] = c.fetchone() is not None
                    status["embedding"] = status["face_detected"]

            conn.close()
            return status

        if foto_path:
            from cloud.drive_cache import cache
            file_id = foto_path.replace("cloud://", "", 1) if foto_path.startswith("cloud://") else ""
            if file_id:
                return {
                    "has_full": cache.original_exists(file_id),
                    "has_thumb": cache.thumb_exists(file_id),
                }
            return {"has_full": False, "has_thumb": False}

        return {"error": "forneca photo_id+catalog ou foto_path"}

    except Exception as e:
        print(f"[AIStatus] erro: {e}")
        return {"error": str(e)}


@app.get("/api/ai/photo-details")
def ai_photo_details(photo_id: int = 0, catalog: str = "", foto_path: str = ""):
    try:
        BASE_DIR = Path(__file__).resolve().parents[1]
        catalogs_dir = BASE_DIR / "data" / "catalogs"

        details = {
            "processed": False,
            "face_detected": False,
            "embedding_ready": False,
            "possible_student": None,
            "face_confidence": None,
            "suggestions": [],
            "detected_objects": [],
        }

        if catalog:
            catalog_path = catalogs_dir / f"{catalog}.db"
            if not catalog_path.exists():
                return {**details, "error": "Catalogo nao encontrado"}

            conn = sqlite3.connect(str(catalog_path))
            conn.row_factory = sqlite3.Row
            c = conn.cursor()

            resolved_path = foto_path
            if not resolved_path and photo_id:
                c.execute("SELECT original_path, foto_path, status FROM photos WHERE id = ?", (photo_id,))
                row = c.fetchone()
                if row:
                    resolved_path = row["original_path"] or row["foto_path"]
                    details["processed"] = row["status"] == "processed"
                    if row["status"]:
                        details["processing"] = row["status"] in ("pending", "curating")

            if resolved_path:
                c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
                _has_alunos_photo = c.fetchone() is not None
                if _has_alunos_photo:
                    c.execute("""
                        SELECT o.aluno_id, a.aluno_id as student_name, a.class_name
                        FROM ocorrencias o
                        LEFT JOIN alunos a ON a.aluno_id = o.aluno_id
                        WHERE o.foto_path = ? LIMIT 1
                    """, (resolved_path,))
                else:
                    c.execute("""
                        SELECT o.aluno_id, o.aluno_id as student_name, NULL as class_name
                        FROM ocorrencias o
                        WHERE o.foto_path = ? LIMIT 1
                    """, (resolved_path,))
                occ = c.fetchone()
                if occ:
                    details["face_detected"] = True
                    details["possible_student"] = occ["student_name"] or occ["aluno_id"]
                    details["face_confidence"] = 0.85

                c.execute("SELECT 1 FROM face_embeddings WHERE foto_path = ? LIMIT 1", (resolved_path,))
                details["embedding_ready"] = c.fetchone() is not None

                c.execute("""
                    SELECT o.aluno_id, COUNT(*) as ocorrencias
                    FROM ocorrencias o
                    WHERE o.foto_path = ?
                    GROUP BY o.aluno_id ORDER BY ocorrencias DESC
                """, (resolved_path,))
                suggestions = []
                for row in c.fetchall():
                    suggestions.append({
                        "student": row["aluno_id"],
                        "confidence": min(0.95, 0.5 + row["ocorrencias"] * 0.1),
                    })
                details["suggestions"] = suggestions

            conn.close()

        elif foto_path:
            from cloud.drive_cache import cache
            file_id = foto_path.replace("cloud://", "", 1) if foto_path.startswith("cloud://") else ""
            if file_id:
                details["has_full"] = cache.original_exists(file_id)
                details["has_thumb"] = cache.thumb_exists(file_id)

                # Ler resultados de IA do cache metadata
                metadata = cache.load_metadata(file_id)
                if metadata:
                    if metadata.get("ai_face_detected"):
                        details["face_detected"] = True
                        details["face_confidence"] = metadata.get("ai_confidence")
                        details["embedding_ready"] = metadata.get("ai_embedding_ready", False)
                        details["ai_processed_at"] = metadata.get("ai_processed_at")
                    details["ocr_text"] = metadata.get("ai_ocr_text", "")
                    details["ocr_confidence"] = metadata.get("ai_ocr_confidence", 0.0)
                    details["ocr_confidence_pct"] = metadata.get("ai_ocr_confidence_pct", round(float(metadata.get("ai_ocr_confidence", 0.0)) * 100))
                    details["ocr_score"] = metadata.get("ai_ocr_score", metadata.get("ai_ocr_confidence", 0.0))
                    details["ocr_type"] = metadata.get("ai_ocr_type", "none")
                    details["ocr_label"] = metadata.get("ai_ocr_label", metadata.get("ai_ocr_type", "none"))

            # Try to find in catalogs by foto_path
            for db_file in catalogs_dir.glob("*.db"):
                try:
                    conn = sqlite3.connect(str(db_file))
                    conn.row_factory = sqlite3.Row
                    c = conn.cursor()
                    c.execute("SELECT 1 FROM ocorrencias WHERE foto_path = ? LIMIT 1", (foto_path,))
                    if c.fetchone():
                        c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
                        _ha2 = c.fetchone() is not None
                        if _ha2:
                            c.execute("""
                                SELECT o.aluno_id, a.aluno_id as student_name
                                FROM ocorrencias o
                                LEFT JOIN alunos a ON a.aluno_id = o.aluno_id
                                WHERE o.foto_path = ? LIMIT 1
                            """, (foto_path,))
                        else:
                            c.execute("""
                                SELECT o.aluno_id, o.aluno_id as student_name
                                FROM ocorrencias o
                                WHERE o.foto_path = ? LIMIT 1
                            """, (foto_path,))
                        occ = c.fetchone()
                        if occ:
                            details["face_detected"] = True
                            details["possible_student"] = occ["student_name"] or occ["aluno_id"]
                        details["catalog"] = db_file.stem

                        c.execute("SELECT 1 FROM face_embeddings WHERE foto_path = ? LIMIT 1", (foto_path,))
                        if c.fetchone():
                            details["embedding_ready"] = True
                    conn.close()
                    if details.get("embedding_ready"):
                        break
                except Exception:
                    pass

        return details

    except Exception as e:
        print(f"[AIDetails] erro: {e}")
        return {"error": str(e)}


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


@ app.post("/api/ai/process-photo")
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


@app.post("/api/ai/batch-status")
def ai_batch_status(req: AiBatchStatusReq):
    result_items = []
    cat = AppState.current_catalog if AppState.current_catalog else ""
    try:
        with get_db(cat) as conn:
            c = conn.cursor()
            for fp in req.foto_paths:
                item = {"foto_path": fp, "status": "unknown"}
                file_id = fp.replace("cloud://", "", 1) if fp.startswith("cloud://") else ""
                if file_id:
                    try:
                        from cloud.drive_cache import cache
                        meta = cache.load_metadata(file_id)
                        if meta and meta.get("ai_face_detected") is not None:
                            item["status"] = "completed"
                            item["face_detected"] = bool(meta.get("ai_face_detected"))
                            item["faces_count"] = int(meta.get("ai_faces_count", 0))
                            item["embedding_ready"] = bool(meta.get("ai_embedding_ready", False))
                            item["ocr_text"] = str(meta.get("ai_ocr_text", ""))
                            item["ocr_confidence"] = float(meta.get("ai_ocr_confidence", 0.0))
                            item["final_student"] = meta.get("ai_ocr_text")
                        else:
                            item["status"] = "pending"
                    except Exception:
                        item["status"] = "error"
                elif fp:
                    try:
                        c.execute(
                            "SELECT fe.embedding FROM face_embeddings fe WHERE fe.foto_path = ? LIMIT 1",
                            (fp,)
                        )
                        r = c.fetchone()
                        if r and r[0]:
                            item["status"] = "completed"
                            item["face_detected"] = True
                            item["embedding_ready"] = True
                        else:
                            item["status"] = "pending"
                    except Exception:
                        item["status"] = "pending"
                result_items.append(item)
    except Exception:
        pass
    return {"items": result_items}


@app.post("/api/photo/rating")
def set_photo_rating(foto_path: str = "", rating: int = 0):
    if not foto_path:
        return {"error": "foto_path obrigatorio"}
    rating = max(0, min(5, int(rating)))
    try:
        with get_db() as db:
            db.cursor().execute("""
                INSERT INTO photo_meta (foto_path, rating) VALUES (?, ?)
                ON CONFLICT(foto_path) DO UPDATE SET rating = excluded.rating
            """, (foto_path, rating))
            db.commit()
        print(f"[HOTKEY] rating {rating}: {foto_path}")
        return {"success": True, "rating": rating}
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/photo/favorite")
def toggle_photo_favorite(foto_path: str = ""):
    if not foto_path:
        return {"error": "foto_path obrigatorio"}
    try:
        with get_db() as db:
            cur = db.cursor()
            cur.execute("SELECT favorite FROM photo_meta WHERE foto_path = ?", (foto_path,))
            row = cur.fetchone()
            current = bool(row["favorite"]) if row else False
            new_val = 1 if not current else 0
            cur.execute("""
                INSERT INTO photo_meta (foto_path, rating, favorite) VALUES (?, 0, ?)
                ON CONFLict(foto_path) DO UPDATE SET favorite = excluded.favorite
            """, (foto_path, new_val))
            db.commit()
        print(f"[HOTKEY] favorite {'on' if new_val else 'off'}: {foto_path}")
        return {"success": True, "favorite": bool(new_val)}
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/photo/ratings")
def get_photo_ratings(req: AiBatchStatusReq):
    results: list = []
    if not req.foto_paths:
        return {"items": results}
    try:
        with get_db() as db:
            placeholders = ",".join(["?"] * len(req.foto_paths))
            cur = db.cursor()
            cur.execute(f"SELECT foto_path, rating, favorite FROM photo_meta WHERE foto_path IN ({placeholders})", req.foto_paths)
            rows = {r["foto_path"]: {"rating": r["rating"] or 0, "favorite": bool(r["favorite"])} for r in cur.fetchall()}
            for path in req.foto_paths:
                meta = rows.get(path, {"rating": 0, "favorite": False})
                results.append({"foto_path": path, "rating": meta["rating"], "favorite": meta["favorite"]})
    except Exception as e:
        print(f"[RATING] batch error: {e}")
        for path in req.foto_paths:
            results.append({"foto_path": path, "rating": 0, "favorite": False})
    return {"items": results}


@app.post("/api/ai/retry-face-detection")
def ai_retry_face_detection(foto_path: str = ""):
    try:
        if not foto_path:
            return {"error": "foto_path obrigatorio"}

        from services.photo_loader import load_photo_for_ai
        local_path = load_photo_for_ai({"foto_path": foto_path, "source_type": "google_drive" if foto_path.startswith("cloud://") else "local"})

        if not local_path or not os.path.exists(local_path):
            return {"error": "Imagem nao encontrada", "face_detected": False}

        import cv2
        import numpy as np
        from scanner_engine import ensure_face_engine, get_app_face

        ensure_face_engine()
        app_face = get_app_face()
        if app_face is None:
            return {"error": "Motor de deteccao nao disponivel", "face_detected": False}

        img = cv2.imread(local_path)
        if img is None:
            return {"error": "Falha ao ler imagem", "face_detected": False}

        h, w = img.shape[:2]
        print(f"[RetryFace] original: {w}x{h}")

        # Pre-processamento: redimensionar para 1280px max (ajuda rostos pequenos)
        max_dim = 1280
        scale = min(max_dim / w, max_dim / h, 1.0)
        if scale < 1.0:
            new_w, new_h = int(w * scale), int(h * scale)
            img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
            print(f"[RetryFace] redimensionado para: {new_w}x{new_h}")

        # Contraste leve (CLAHE) no canal L do LAB
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l = clahe.apply(l)
        lab = cv2.merge([l, a, b])
        img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

        # Tentar deteccao com threshold padrao
        from scanner_engine import FACE_INFERENCE_LOCK
        with FACE_INFERENCE_LOCK:
            with _suppress_stdout():
                faces = app_face.get(img) or []

        print(f"[RetryFace] deteccao padrao: {len(faces)} faces")

        # Fallback: se nao detectou, tentar com det_size maior e threshold menor
        if len(faces) == 0 and max(w, h) > 300:
            from insightface.app import FaceAnalysis
            old_det_size = app_face.det_size
            try:
                app_face.det_size = (1280, 1280)
                app_face.prepare(ctx_id=0, det_size=(1280, 1280))
                with FACE_INFERENCE_LOCK:
                    with _suppress_stdout():
                        faces = app_face.get(img) or []
                print(f"[RetryFace] fallback det_size=1280: {len(faces)} faces")
            except Exception:
                pass
            finally:
                app_face.det_size = old_det_size
                try:
                    app_face.prepare(ctx_id=0, det_size=old_det_size)
                except Exception:
                    pass

        result = {
            "face_detected": len(faces) > 0,
            "faces_count": len(faces),
            "fallback_used": len(faces) > 0,
        }

        if len(faces) > 0:
            face = faces[0]
            import math
            emb = face.embedding.astype("float32")
            norm = float(np.linalg.norm(emb))
            result["confidence"] = float(face.det_score) if hasattr(face, "det_score") else 0.0
            result["embedding_ready"] = norm > 0

            # Salvar no banco do catalogo se disponivel
            for db_file in Path(__file__).resolve().parents[1].glob("data/catalogs/*.db"):
                try:
                    conn = sqlite3.connect(str(db_file))
                    c = conn.cursor()
                    c.execute("SELECT rowid FROM ocorrencias WHERE foto_path = ? LIMIT 1", (foto_path,))
                    occ_row = c.fetchone()
                    if occ_row:
                        rowid = occ_row[0]
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
                        conn.commit()
                        print(f"[RetryFace] embedding salvo para: {foto_path}")
                        conn.close()
                        break
                except Exception:
                    pass

        print(f"[RetryFace] resultado: {result}")
        return result

    except Exception as e:
        print(f"[RetryFace] erro: {e}")
        return {"error": str(e), "face_detected": False}


import contextlib

@contextlib.contextmanager
def _suppress_stdout():
    import sys
    from io import StringIO
    old = sys.stdout
    sys.stdout = StringIO()
    try:
        yield
    finally:
        sys.stdout = old


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
