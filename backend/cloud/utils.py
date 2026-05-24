import os
import sqlite3
from pathlib import Path

def _cloud_events_db_path() -> Path:
    # Resolve base_dir to the root directory (formatura-pro-novo)
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
            catalog_path TEXT,
            cache_path TEXT,
            metadata_path TEXT,
            fpdb_path TEXT,
            cache_enabled INTEGER DEFAULT 1,
            status TEXT,
            created_at TEXT,
            updated_at TEXT,
            last_opened_at TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_events_source_folder ON cloud_events(source_folder_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cloud_events_status ON cloud_events(status)")


def _cloud_catalogs_root_dir() -> Path:
    try:
        import backend_state
        app_settings = getattr(backend_state, "app_settings", {})
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
        candidate = base_dir / f"{desired_name} {counter}"
        counter += 1
    return candidate
