"""
Gerenciamento de conexão com banco SQLite, schemas e migrações.
"""

import os
import time
import shutil
import logging
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from state import AppState, _EMBEDDING_DISK_CACHE, LAST_BACKUPS
import state as _state

logger = logging.getLogger(__name__)


# ── Helpers de schema ──────────────────────────────────────────

def _table_exists(conn, table_name):
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
        return cur.fetchone() is not None
    except Exception:
        return False


def _table_columns(conn, table_name):
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table_name})")
    return [row[1] for row in cur.fetchall()]


def _safe_add_column(conn, table_name, column_name, definition):
    try:
        if column_name not in _table_columns(conn, table_name):
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")
    except Exception:
        pass


def ensure_quality_columns(conn):
    try:
        for col in ("blur_score", "blur_status", "closed_eyes",
                     "has_gown", "has_diploma", "has_sash", "has_cap",
                     "face_front_score", "graduation_score", "graduation_tags",
                     "graduation_analyzed_at"):
            _safe_add_column(conn, "ocorrencias", col, "REAL" if col in (
                "blur_score", "face_front_score", "graduation_score") else "TEXT")
        _safe_add_column(conn, "ocorrencias", "closed_eyes", "INTEGER DEFAULT 0")
        conn.commit()
    except Exception:
        pass


def ensure_graduation_columns(conn):
    try:
        for col in ("has_gown", "has_diploma", "has_sash", "has_cap",
                     "gown_confidence", "diploma_confidence", "sash_confidence",
                     "cap_confidence", "jabor_confidence", "has_jabor",
                     "manual_graduation_tags", "ai_graduation_tags",
                     "foreground_score", "is_foreground", "face_area_ratio",
                     "center_score", "background_penalty_reason"):
            _safe_add_column(conn, "ocorrencias", col, "REAL" if "confidence" in col or "score" in col or "ratio" in col else "TEXT")
        _safe_add_column(conn, "ocorrencias", "is_foreground", "INTEGER DEFAULT 1")
        _safe_add_column(conn, "ocorrencias", "face_area_ratio", "REAL")
        _safe_add_column(conn, "ocorrencias", "center_score", "REAL")
        _safe_add_column(conn, "ocorrencias", "background_penalty_reason", "TEXT")
        conn.commit()
    except Exception:
        pass


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
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
        has_alunos = cur.fetchone() is not None
        if has_alunos:
            cur.execute("PRAGMA table_info(alunos)")
            cols = [row[1] for row in cur.fetchall()]
            if "person_key" not in cols:
                cur.execute("ALTER TABLE alunos ADD COLUMN person_key TEXT DEFAULT ''")
            if "reference_folder" not in cols:
                cur.execute("ALTER TABLE alunos ADD COLUMN reference_folder TEXT DEFAULT ''")
            pk_col = None
            for row in cur.execute("PRAGMA table_info(alunos)"):
                if row[5] == 1:
                    pk_col = row[1]
                    break
            if pk_col == "aluno_id":
                _migrate_alunos_to_person_key_pk(conn, cur, cols)

        cur.execute("PRAGMA table_info(ocorrencias)")
        cols = [row[1] for row in cur.fetchall()]
        if "person_key" not in cols:
            cur.execute("ALTER TABLE ocorrencias ADD COLUMN person_key TEXT DEFAULT ''")
        if "reference_folder" not in cols:
            cur.execute("ALTER TABLE ocorrencias ADD COLUMN reference_folder TEXT DEFAULT ''")
        if "graduation_reviewed" not in cols:
            cur.execute("ALTER TABLE ocorrencias ADD COLUMN graduation_reviewed INTEGER DEFAULT 0")
        if "manual_graduation_tags" not in cols:
            cur.execute("ALTER TABLE ocorrencias ADD COLUMN manual_graduation_tags TEXT DEFAULT ''")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key ON ocorrencias(person_key)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key_aluno ON ocorrencias(person_key, aluno_id)")
        _ensure_ocorrencias_unique(cur)
        _backfill_ocorrencias_person_key(cur)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return True


def _backfill_ocorrencias_person_key(cur):
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
        if not cur.fetchone():
            return
        cur.execute("SELECT COUNT(*) FROM ocorrencias WHERE person_key IS NULL OR TRIM(person_key) = ''")
        count = cur.fetchone()[0]
        if count == 0:
            return
        logger.info("[migration] Backfilling person_key em %d ocorrencias", count)
        cur.execute("""
            SELECT aluno_id, person_key FROM alunos
            WHERE person_key IS NOT NULL AND TRIM(person_key) != ''
              AND aluno_id IS NOT NULL AND TRIM(aluno_id) != ''
        """)
        name_to_pk = {}
        ambiguous = set()
        for row in cur.fetchall():
            aid, pk = row[0], row[1]
            if aid in name_to_pk and name_to_pk[aid] != pk:
                ambiguous.add(aid)
            else:
                name_to_pk[aid] = pk
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
            logger.info("[migration] person_key atualizado em %d ocorrencias", updated)
        if ambiguous:
            logger.info("[migration] %d nomes ambiguos precisam de re-scan: %s",
                        len(ambiguous), ", ".join(sorted(ambiguous)[:5]))
    except Exception as e:
        logger.warning("[migration] Backfill person_key falhou: %s", e)


def _ensure_ocorrencias_unique(cur):
    cur.execute("PRAGMA index_list(ocorrencias)")
    has_unique = False
    for idx in cur.fetchall():
        if idx[2]:
            cur.execute(f"PRAGMA index_info({idx[1]})")
            cols = {row[2] for row in cur.fetchall()}
            if cols == {"foto_path", "x1", "y1", "x2", "y2"}:
                has_unique = True
                break
    if has_unique:
        return
    logger.info("[migration] Adicionando UNIQUE constraint em ocorrencias(foto_path, x1, y1, x2, y2)")
    cur.execute("""
        DELETE FROM ocorrencias WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM ocorrencias GROUP BY foto_path, x1, y1, x2, y2
        )
    """)
    removed = cur.rowcount
    if removed:
        logger.info("[migration] Removidas %d duplicatas de ocorrencias", removed)
    cur.execute("DROP TABLE IF EXISTS ocorrencias_new")
    cur.execute("PRAGMA table_info(ocorrencias)")
    col_defs = []
    for row in cur.fetchall():
        cname, ctype, notnull, dflt = row[1], row[2], row[3], row[4]
        parts = f"{cname} {ctype}"
        if notnull:
            parts += " NOT NULL"
        if dflt is not None:
            parts += f" DEFAULT {dflt}"
        col_defs.append(parts)
    col_defs.append("UNIQUE(foto_path, x1, y1, x2, y2)")
    cur.execute(f"CREATE TABLE ocorrencias_new ({', '.join(col_defs)})")
    existing_cols = [row[1] for row in cur.execute("PRAGMA table_info(ocorrencias)").fetchall()]
    col_list = ", ".join(existing_cols)
    cur.execute(f"INSERT OR IGNORE INTO ocorrencias_new ({col_list}) SELECT {col_list} FROM ocorrencias")
    cur.execute("DROP TABLE ocorrencias")
    cur.execute("ALTER TABLE ocorrencias_new RENAME TO ocorrencias")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto ON ocorrencias(foto_path)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key ON ocorrencias(person_key)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_person_key_aluno ON ocorrencias(person_key, aluno_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno_foto ON ocorrencias(aluno_id, foto_path)")
    logger.info("[migration] UNIQUE constraint adicionado em ocorrencias")


def _migrate_alunos_to_person_key_pk(conn, cur, existing_cols):
    import scanner_engine as _se
    cur.execute("SELECT * FROM alunos")
    rows = cur.fetchall()
    col_names = [d[0] for d in cur.description]
    base_cols = {"aluno_id", "face_cache_path", "class_name", "person_key", "reference_folder"}
    extra_cols = [c for c in col_names if c not in base_cols]
    all_new_cols = ["person_key", "aluno_id", "face_cache_path", "class_name", "reference_folder"] + extra_cols
    extra_col_defs = []
    for c in extra_cols:
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
    migrated = 0
    for row in rows:
        data = dict(zip(col_names, row))
        aluno_id = data.get("aluno_id", "")
        class_name = str(data.get("class_name", "") or "").strip() or "Sem turma"
        person_key = str(data.get("person_key", "") or "").strip()
        reference_folder = str(data.get("reference_folder", "") or "").strip()
        face_cache_path = data.get("face_cache_path", "n/a")
        if not person_key:
            if aluno_id == "system_catalog":
                person_key = "__SYSTEM_CATALOG__"
            else:
                person_key = _se.make_person_key(
                    class_name=class_name,
                    reference_folder=reference_folder or class_name,
                    student_id=aluno_id,
                )
        vals = [person_key, aluno_id, face_cache_path, class_name, reference_folder]
        for c in extra_cols:
            vals.append(data.get(c, None))
        placeholders = ",".join(["?"] * len(vals))
        col_list = ",".join(all_new_cols)
        try:
            cur.execute(f"INSERT OR IGNORE INTO alunos_new ({col_list}) VALUES ({placeholders})", vals)
            migrated += 1
        except Exception as _mig_err:
            logger.warning("[migration] insert error aluno=%s: %s", vals[1] if len(vals) > 1 else "?", _mig_err)
    cur.execute("DROP TABLE alunos")
    cur.execute("ALTER TABLE alunos_new RENAME TO alunos")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_alunos_aluno_id ON alunos(aluno_id)")
    conn.commit()
    logger.info("[migration] alunos: PK migrada de aluno_id para person_key (%d registros)", migrated)


# ── Conexão ────────────────────────────────────────────────────

class DbConnection:
    def __init__(self, cat=None):
        self.cat = cat
        self.conn = None
        self.closed = False

    def __enter__(self):
        from utils import sanitize_catalog_name
        use_cat = sanitize_catalog_name(self.cat if self.cat else AppState.current_catalog)
        if not use_cat:
            raise HTTPException(400, "Nenhum catálogo/evento selecionado! Crie um novo primeiro!")

        db_path = None
        try:
            base_dir = Path(__file__).resolve().parents[1]
            cloud_db_path = base_dir / "data" / "cloud" / "cloud_events.db"
            if cloud_db_path.exists():
                with sqlite3.connect(str(cloud_db_path)) as cloud_conn:
                    cloud_conn.row_factory = sqlite3.Row
                    row = cloud_conn.execute(
                        "SELECT fpdb_path FROM cloud_events WHERE name = ? OR id = ?",
                        (use_cat, use_cat)
                    ).fetchone()
                    if row and row["fpdb_path"]:
                        candidate_path = Path(row["fpdb_path"])
                        if candidate_path.exists():
                            db_path = str(candidate_path)
                            logger.info(f"[get_db] Redirecting cloud catalog '{use_cat}' to: {db_path}")
        except Exception as e:
            logger.error(f"[get_db] Error checking cloud catalog redirect for '{use_cat}': {e}")

        if not db_path:
            db_path = os.path.join(_state.CATALOG_DIR, f"{use_cat}.db")
            from utils import sanitize_catalog_name as _scn
            if os.path.commonpath([_state.CATALOG_DIR, os.path.abspath(db_path)]) != _state.CATALOG_DIR:
                raise HTTPException(400, "Nome de catalogo invalido")
        try:
            self.conn = sqlite3.connect(db_path, timeout=30)
            self.conn.row_factory = sqlite3.Row
            try:
                self.conn.execute("PRAGMA journal_mode=WAL")
                self.conn.execute("PRAGMA synchronous=NORMAL")
            except Exception as pragma_err:
                logger.warning(f"Falha ao configurar PRAGMA WAL no banco {db_path}: {pragma_err}")
        except Exception as e:
            logger.error(f"FATAL: Erro ao conectar ao banco {db_path}: {e}")
            self.conn = None
            raise HTTPException(500, f"Falha ao abrir banco de dados: {e}")
        c = self.conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS ocorrencias (
                aluno_id TEXT, foto_path TEXT,
                x1 INTEGER, y1 INTEGER, x2 INTEGER, y2 INTEGER,
                photo_hash TEXT,
                blur_score REAL, blur_status TEXT, closed_eyes INTEGER,
                has_gown INTEGER, has_diploma INTEGER, has_sash INTEGER, has_cap INTEGER,
                face_front_score REAL, graduation_score REAL,
                graduation_tags TEXT DEFAULT '[]',
                graduation_analyzed_at TEXT,
                foreground_score REAL, is_foreground INTEGER DEFAULT 1,
                face_area_ratio REAL, center_score REAL,
                background_penalty_reason TEXT
            )
        """)
        # Migração: adicionar colunas que podem faltar em bancos existentes
        try:
            cur = self.conn.cursor()
            cur.execute("PRAGMA table_info(ocorrencias)")
            existing_cols = {row[1] for row in cur.fetchall()}
            if "photo_hash" not in existing_cols:
                cur.execute("ALTER TABLE ocorrencias ADD COLUMN photo_hash TEXT")
                self.conn.commit()
        except Exception as e:
            logger.warning("Falha ao migrar banco de dados para adicionar photo_hash: %s", e)
        ensure_quality_columns(self.conn)
        ensure_graduation_columns(self.conn)
        ensure_identity_columns(self.conn)
        c.execute("""
            CREATE TABLE IF NOT EXISTS alunos (
                person_key TEXT PRIMARY KEY, aluno_id TEXT,
                face_cache_path TEXT, class_name TEXT DEFAULT 'Sem turma',
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
                foto_path TEXT, x1 INTEGER, y1 INTEGER, x2 INTEGER, y2 INTEGER,
                mtime_ns INTEGER, size INTEGER,
                embedding BLOB,
                updated_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS scan_checkpoints (
                scan_key TEXT PRIMARY KEY,
                ori_path TEXT, ref_path TEXT,
                last_batch_index INTEGER, total_batches INTEGER,
                created_at REAL DEFAULT (strftime('%s','now')),
                updated_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno ON ocorrencias(aluno_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto ON ocorrencias(foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto_path ON ocorrencias(foto_path)")
        try:
            c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_photo_hash ON ocorrencias(photo_hash)")
        except Exception as e:
            logger.warning("Falha ao criar indice idx_ocor_photo_hash: %s", e)
        c.execute("""
            CREATE TABLE IF NOT EXISTS export_history (
                uuid TEXT PRIMARY KEY, dest_path TEXT,
                mode TEXT, files_json TEXT, folders_json TEXT, timestamp TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS photo_meta (
                foto_path TEXT PRIMARY KEY,
                rating INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS unknown_face_clusters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cluster_id TEXT NOT NULL, face_id INTEGER,
                original_path TEXT, confidence REAL,
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
                DELETE FROM ocorrencias WHERE rowid NOT IN (
                    SELECT MIN(rowid) FROM ocorrencias
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
                catalog_name TEXT NOT NULL, path TEXT NOT NULL,
                include_subfolders INTEGER DEFAULT 1,
                photo_count INTEGER DEFAULT 0, last_scan_at REAL,
                status TEXT DEFAULT 'active', folder_type TEXT DEFAULT 'event',
                created_at REAL DEFAULT (strftime('%s','now'))
            )
        """)
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_folder_unique ON catalog_folders(catalog_name, path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_discarded_foto ON discarded_photos(foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_photo_meta_foto ON photo_meta(foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_x1 ON ocorrencias(x1)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno_foto ON ocorrencias(aluno_id, foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto_aluno ON ocorrencias(foto_path, aluno_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_alunos_id_class ON alunos(aluno_id, class_name)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_blur_foto ON ocorrencias(blur_status, foto_path)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ufc_cluster_face ON unknown_face_clusters(cluster_id, face_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno_x1 ON ocorrencias(aluno_id, x1)")
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
            logger.error("ERRO CRITICO: Tentativa de obter cursor em banco nao inicializado.")
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
    from utils import sanitize_catalog_name
    use_cat = sanitize_catalog_name(cat if cat else AppState.current_catalog)
    if not use_cat:
        return ""
    try:
        base_dir = Path(__file__).resolve().parents[1]
        cloud_db_path = base_dir / "data" / "cloud" / "cloud_events.db"
        if cloud_db_path.exists():
            with sqlite3.connect(str(cloud_db_path)) as cloud_conn:
                cloud_conn.row_factory = sqlite3.Row
                row = cloud_conn.execute(
                    "SELECT fpdb_path FROM cloud_events WHERE name = ? OR id = ?",
                    (use_cat, use_cat)
                ).fetchone()
                if row and row["fpdb_path"]:
                    candidate_path = Path(row["fpdb_path"])
                    if candidate_path.exists():
                        return str(candidate_path)
    except Exception:
        pass
    return os.path.join(_state.CATALOG_DIR, f"{use_cat}.db")


def backup_catalog_db(cat=None, reason="backup"):
    try:
        from utils import sanitize_catalog_name
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
        dest = os.path.join(_state.BACKUP_DIR, f"{use_cat}_{safe_reason}_{stamp}.db.bak")
        shutil.copy2(src, dest)
        LAST_BACKUPS[key] = {"time": now, "path": dest}
        return dest
    except Exception as e:
        print(f"Falha criando backup do catálogo: {e}")
        return ""


# ── Cache de embeddings ────────────────────────────────────────

def get_embedding_cache_path():
    return os.path.join(_state.DATA_DIR, "embedding_cache_v2.db")


def load_embedding_disk_cache():
    global _EMBEDDING_DISK_CACHE
    path = get_embedding_cache_path()
    if not os.path.exists(path):
        return
    try:
        conn = sqlite3.connect(path)
        cur = conn.cursor()
        cur.execute("CREATE TABLE IF NOT EXISTS emb_cache ("
                     "path_hash TEXT PRIMARY KEY, foto_path TEXT, "
                     "x1 INTEGER, y1 INTEGER, x2 INTEGER, y2 INTEGER, "
                     "mtime_ns INTEGER, size INTEGER, embedding BLOB)")
        cur.execute("SELECT path_hash, embedding, mtime_ns, size FROM emb_cache")
        for row in cur.fetchall():
            _EMBEDDING_DISK_CACHE[row[0]] = {
                "embedding": row[1], "mtime_ns": row[2], "size": row[3],
            }
        conn.close()
    except Exception as e:
        logger.warning("Erro ao carregar cache de embeddings: %s", e)


def save_embedding_disk_cache():
    path = get_embedding_cache_path()
    try:
        conn = sqlite3.connect(path)
        cur = conn.cursor()
        cur.execute("CREATE TABLE IF NOT EXISTS emb_cache ("
                     "path_hash TEXT PRIMARY KEY, foto_path TEXT, "
                     "x1 INTEGER, y1 INTEGER, x2 INTEGER, y2 INTEGER, "
                     "mtime_ns INTEGER, size INTEGER, embedding BLOB)")
        with conn:
            for key, data in _EMBEDDING_DISK_CACHE.items():
                cur.execute(
                    "INSERT OR REPLACE INTO emb_cache (path_hash, embedding, mtime_ns, size) VALUES (?, ?, ?, ?)",
                    (key, data["embedding"], data["mtime_ns"], data["size"]),
                )
        conn.close()
    except Exception as e:
        logger.warning("Erro ao salvar cache de embeddings: %s", e)


def get_cached_embedding(foto_path, x1, y1, x2, y2, mtime_ns, size):
    import hashlib
    key = hashlib.md5(f"{foto_path}:{x1}:{y1}:{x2}:{y2}:{mtime_ns}:{size}".encode()).hexdigest()
    entry = _EMBEDDING_DISK_CACHE.get(key)
    if entry and entry["mtime_ns"] == mtime_ns and entry["size"] == size:
        return entry["embedding"]
    return None


def set_cached_embedding(foto_path, x1, y1, x2, y2, mtime_ns, size, embedding):
    import hashlib
    key = hashlib.md5(f"{foto_path}:{x1}:{y1}:{x2}:{y2}:{mtime_ns}:{size}".encode()).hexdigest()
    _EMBEDDING_DISK_CACHE[key] = {"embedding": embedding, "mtime_ns": mtime_ns, "size": size}


def clear_embedding_cache():
    _EMBEDDING_DISK_CACHE.clear()
    path = get_embedding_cache_path()
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


# ── Scan checkpoints ───────────────────────────────────────────

def get_scan_checkpoint(conn, scan_key):
    cur = conn.cursor()
    cur.execute("SELECT * FROM scan_checkpoints WHERE scan_key = ?", (scan_key,))
    return cur.fetchone()


def save_scan_checkpoint(conn, scan_key, ori_path, ref_path, last_batch_index, total_batches):
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO scan_checkpoints
        (scan_key, ori_path, ref_path, last_batch_index, total_batches, updated_at)
        VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    """, (scan_key, ori_path, ref_path, last_batch_index, total_batches))


def clear_scan_checkpoint(conn, scan_key):
    cur = conn.cursor()
    cur.execute("DELETE FROM scan_checkpoints WHERE scan_key = ?", (scan_key,))
