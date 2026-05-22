import os
import shutil
import sqlite3
import json
import uuid
import time
import urllib.parse
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

# Create router
router = APIRouter()

# Constants
PLACEHOLDER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">'
    '<rect width="200" height="200" fill="#1a1a2e" rx="4"/>'
    '<circle cx="100" cy="80" r="28" fill="none" stroke="#374151" stroke-width="3"/>'
    '<path d="M55 155 L65 120 L82 132 L100 95 L118 132 L135 120 L145 155 Z" fill="none" stroke="#374151" stroke-width="2.5"/>'
    '</svg>'
)

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

# Request Models
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


# Helper functions
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


def _cloud_events_db_path() -> Path:
    base_dir = Path(__file__).resolve().parents[2]
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
    try:
        from backend import app_settings
    except ImportError:
        app_settings = {}
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
                background_penalty_reason TEXT,
                person_key TEXT DEFAULT '',
                reference_folder TEXT DEFAULT '',
                source_type TEXT DEFAULT 'local',
                drive_file_id TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno ON ocorrencias(aluno_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto ON ocorrencias(foto_path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto_path ON ocorrencias(foto_path)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS alunos (
                person_key TEXT PRIMARY KEY,
                aluno_id TEXT,
                face_cache_path TEXT,
                class_name TEXT DEFAULT 'Sem turma',
                reference_folder TEXT DEFAULT ''
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alunos_aluno_id ON alunos(aluno_id)")
        conn.execute("""
            INSERT OR IGNORE INTO alunos (person_key, aluno_id, face_cache_path, class_name, reference_folder)
            VALUES (?, ?, ?, ?, ?)
        """, ("__SYSTEM_CATALOG__", "system_catalog", "ABSENT", "Sem turma", ""))

        # Popular formandos reais detectados nas referências
        references = metadata.get("references", [])
        event_name = metadata.get("name", "")
        if references and event_name:
            try:
                from backend.scanner_engine import make_person_key
            except ImportError:
                from scanner_engine import make_person_key
                
            import unicodedata
            import re
            
            def clean_reference_name(folder_name: str) -> str:
                name = folder_name.strip()
                def remove_accents(s: str) -> str:
                    normalized = unicodedata.normalize('NFD', s)
                    return "".join(c for c in normalized if unicodedata.category(c) != 'Mn')
                upper_no_accents = remove_accents(name.upper())
                match = re.match(r'^#?\s*(BASE|REFERENCIA|REFERENCIAS)\b\s*', upper_no_accents)
                if match:
                    prefix_len = match.end()
                    cleaned_name = name[prefix_len:].strip()
                    if cleaned_name:
                        return cleaned_name
                return name

            for ref in references:
                if not ref or not ref.strip():
                    continue
                clean_student_name = clean_reference_name(ref)
                pk = make_person_key(
                    catalog=event_name,
                    class_name="Sem turma",
                    reference_folder=ref,
                    student_id=clean_student_name
                )
                conn.execute("""
                    INSERT OR IGNORE INTO alunos (person_key, aluno_id, face_cache_path, class_name, reference_folder)
                    VALUES (?, ?, ?, ?, ?)
                """, (pk, clean_student_name, "ABSENT", "Sem turma", ref))
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


def _cloud_store_photo_rows(conn: sqlite3.Connection, *, catalog_id: str, provider: str, files: List[Dict[str, Any]], now: str) -> int:
    if not files:
        return 0
    inserted = 0
    rows = []
    ocorrencias_rows = []
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
        ocorrencias_rows.append((
            "system_catalog",
            f"cloud://{file_id}",
            "unknown",
            "google_drive",
            file_id
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
    conn.executemany(
        """
        INSERT OR IGNORE INTO ocorrencias (
            aluno_id, foto_path, blur_status, source_type, drive_file_id
        ) VALUES (?, ?, ?, ?, ?)
        """,
        ocorrencias_rows,
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
    try:
        from backend import sanitize_catalog_name
    except ImportError:
        def sanitize_catalog_name(name):
            cleaned = "".join(
                ch for ch in (name or "").strip().replace(" ", "_")
                if ch.isalnum() or ch in ("_", "-", ".")
            ).strip("._")
            if not cleaned:
                raise HTTPException(400, "Nome de catalogo vazio ou invalido")
            return cleaned

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
    
    catalog_path_str = row["catalog_path"] or ""
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
        "catalogPath": catalog_path_str,
        "cachePath": row["cache_path"],
        "embeddingsPath": str(Path(catalog_path_str) / "Embeddings") if catalog_path_str else "",
        "facesDbPath": str(Path(catalog_path_str) / "Embeddings" / "faces.db") if catalog_path_str else "",
        "reviewStatePath": str(Path(catalog_path_str) / "Catalogo" / "review_state.db") if catalog_path_str else "",
        "metadataPath": row["metadata_path"],
        "fpdbPath": row["fpdb_path"],
        "lastOpenedAt": row["last_opened_at"],
        "cacheEnabled": bool(row["cache_enabled"]),
        "cacheSize": 0,
        "lastSync": row["updated_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# Endpoints
@router.get("/api/cloud/google/auth/start")
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


@router.get("/api/cloud/google/callback")
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


@router.get("/api/cloud/google/status")
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


@router.get("/api/cloud/status")
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


@router.get("/api/cloud/providers")
def cloud_providers():
    return {
        "providers": [
            {"provider": "google_drive", "name": "Google Drive", "enabled": True, "functional": True},
            {"provider": "dropbox", "name": "Dropbox", "enabled": False, "functional": False},
            {"provider": "onedrive", "name": "OneDrive", "enabled": False, "functional": False},
        ]
    }


@router.post("/api/cloud/google/logout")
def cloud_google_logout():
    try:
        from cloud import clear_token
        clear_token()
        return {"status": "ok"}
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/cloud/google/folders")
def cloud_google_folders(parent_id: str = "root"):
    try:
        from cloud import is_authenticated, drive_manager
        if not is_authenticated():
            return {"error": "Não conectado ao Google Drive", "folders": []}
        folders = drive_manager.list_folders(parent_id)
        return {"folders": [f.model_dump() for f in folders]}
    except Exception as e:
        return {"error": str(e), "folders": []}


def _enrich_folders_with_catalog_stats(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # Get all folder IDs
    folder_ids = [item["id"] for item in items if item.get("isFolder")]
    if not folder_ids:
        return items

    try:
        conn = sqlite3.connect(str(_cloud_events_db_path()))
        conn.row_factory = sqlite3.Row
        _ensure_cloud_events_table(conn)

        placeholders = ",".join(["?"] * len(folder_ids))
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT source_folder_id, total_files, total_subfolders, references_json, references_count "
            f"FROM cloud_events WHERE source_folder_id IN ({placeholders})",
            folder_ids
        )

        db_metadata = {}
        for row in cursor.fetchall():
            db_metadata[row["source_folder_id"]] = {
                "photoCount": row["total_files"],
                "subfolderCount": row["total_subfolders"],
                "referencesCount": row["references_count"],
                "references": json.loads(row["references_json"] or "[]"),
            }

        for item in items:
            if item.get("isFolder") and item["id"] in db_metadata:
                meta = db_metadata[item["id"]]
                item["photoCount"] = meta["photoCount"]
                item["subfolderCount"] = meta["subfolderCount"]
                item["referencesCount"] = meta["referencesCount"]
                item["referenceDetected"] = (meta["referencesCount"] or 0) > 0 or len(meta["references"]) > 0
    except Exception as e:
        print(f"[_enrich_folders_with_catalog_stats] erro: {e}")

    return items


@router.get("/api/cloud/google/list")
def cloud_google_list(folderId: str = "root", pageToken: Optional[str] = None, pageSize: Optional[int] = None):
    try:
        from concurrent.futures import ThreadPoolExecutor, TimeoutError
        from cloud import is_authenticated, drive_manager

        if not is_authenticated():
            return {"error": "Não conectado ao Google Drive", "items": [], "folders": [], "photos": 0, "subfolders": 0}

        # If paginated request params are supplied:
        if pageToken is not None or pageSize is not None:
            size = pageSize if pageSize is not None else 200

            def _load_page():
                return drive_manager.list_folder_items_page(folderId, page_size=size, page_token=pageToken)

            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_load_page)
                try:
                    res = future.result(timeout=12)
                except TimeoutError:
                    print(f"[cloud/google/list] timeout paginado folderId={folderId}")
                    return {"error": "Timeout ao listar pasta do Google Drive", "items": [], "nextPageToken": None}

            items = res.get("items", [])
            items = _enrich_folders_with_catalog_stats(items)
            next_page_token = res.get("nextPageToken")
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
                "nextPageToken": next_page_token,
            }

        # Legacy behavior (fetch all):
        def _load():
            return drive_manager.list_folder_items(folderId)

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_load)
            try:
                items = future.result(timeout=15)
            except TimeoutError:
                print(f"[cloud/google/list] timeout ao listar folderId={folderId}")
                return {"error": "Timeout ao listar pastas do Google Drive", "items": [], "folders": [], "photos": 0, "subfolders": 0}

        items = _enrich_folders_with_catalog_stats(items)
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


@router.get("/api/cloud/google/thumbnail-proxy")
def cloud_thumbnail_proxy(url: str):
    import requests
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code == 200:
            return Response(content=res.content, media_type=res.headers.get("Content-Type", "image/jpeg"))
        else:
            print(f"[thumbnail-proxy] status_code={res.status_code} para url={url}")
    except Exception as e:
        print(f"[thumbnail-proxy] erro ao buscar thumb: {e}")

    return Response(content=PLACEHOLDER_SVG, media_type="image/svg+xml")


@router.get("/api/cloud/google/summary")
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


@router.get("/api/cloud/google/index")
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


@router.get("/api/cloud/thumb")
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


@router.get("/api/cloud/full")
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


@router.get("/api/cloud/google/files")
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


@router.post("/api/cloud/catalogs")
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
        
        # Avoid direct import to prevent circularity
        try:
            from services.cloud_ai_service import _cloud_ai_list_drive_files_recursive
            photo_files = _cloud_ai_list_drive_files_recursive(folder_id)
        except Exception:
            photo_files = []
            
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


@router.get("/api/cloud/catalogs")
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


@router.get("/api/cloud/catalogs/{catalog_id}")
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


@router.get("/api/cloud/catalogs/{catalog_id}/session")
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


@router.post("/api/cloud/catalogs/{catalog_id}/session")
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
            req.model_dump() if hasattr(req, "model_dump") else req.dict(),
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


@router.post("/api/cloud/catalogs/open-existing")
def cloud_open_existing_catalog(req: CloudCatalogOpenExistingRequest):
    metadata = _load_cloud_catalog_metadata(req.path)
    paths = _cloud_catalog_paths_from_any(req.path)
    if not paths:
        raise HTTPException(status_code=404, detail="Estrutura do catálogo cloud não encontrada")
        
    try:
        from services.cloud_ai_service import _ensure_cloud_ai_schema, _ensure_cloud_review_schema, _cloud_ai_paths_from_catalog_root
        _ensure_cloud_ai_schema(_cloud_ai_paths_from_catalog_root(paths["root_dir"]))
        _ensure_cloud_review_schema(_cloud_ai_paths_from_catalog_root(paths["root_dir"]))
    except Exception:
        pass

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


@router.post("/api/cloud/catalogs/{catalog_id}/ai/process")
def cloud_ai_process_catalog(catalog_id: str, req: CloudAiProcessRequest):
    from services.cloud_ai_service import _cloud_ai_process_catalog_impl
    return _cloud_ai_process_catalog_impl(catalog_id, limit=req.limit, force=req.force, recursive=req.recursive)


@router.get("/api/cloud/catalogs/{catalog_id}/ai/status")
def cloud_ai_catalog_status(catalog_id: str):
    from services.cloud_ai_service import _cloud_ai_get_status_payload
    return _cloud_ai_get_status_payload(catalog_id)


@router.get("/api/cloud/catalogs/{catalog_id}/ai/review-items")
def cloud_ai_catalog_review_items(catalog_id: str):
    from services.cloud_ai_service import _cloud_ai_list_review_items
    return _cloud_ai_list_review_items(catalog_id)


@router.post("/api/cloud/catalogs/{catalog_id}/ai/review-items/{review_id}/confirm")
def cloud_ai_confirm_review_item(catalog_id: str, review_id: str):
    from services.cloud_ai_service import _cloud_ai_set_review_decision
    return _cloud_ai_set_review_decision(catalog_id, review_id, "confirm")


@router.post("/api/cloud/catalogs/{catalog_id}/ai/review-items/{review_id}/reject")
def cloud_ai_reject_review_item(catalog_id: str, review_id: str):
    from services.cloud_ai_service import _cloud_ai_set_review_decision
    return _cloud_ai_set_review_decision(catalog_id, review_id, "reject")


@router.delete("/api/cloud/catalogs/{catalog_id}")
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


@router.post("/api/cloud/google/create-catalog")
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

        BASE_DIR = Path(__file__).resolve().parents[2]
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
                from services.cloud_ai_service import _cloud_ai_list_drive_files_recursive
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
            "path": str(catalog_path),
            "photos_count": len(indexed_files),
            "message": f"Catálogo '{catalog_name_safe}' criado com {len(indexed_files)} fotos"
        }

    except Exception as e:
        return {"error": str(e)}


@router.get("/api/cloud/google/download-full")
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
