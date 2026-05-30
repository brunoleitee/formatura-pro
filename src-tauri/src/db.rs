use std::path::PathBuf;
use std::fs;
use rusqlite::{Connection, Result};
use std::sync::Mutex;

pub struct DbState {
    pub current_catalog: Mutex<String>,
}

pub fn get_catalog_db_path(catalog: &str) -> PathBuf {
    // 1. Em desenvolvimento, checar caminhos relativos ao workspace do Tauri
    let dev_path = PathBuf::from("../backend/catalogos");
    let catalog_dir = if dev_path.exists() {
        dev_path
    } else {
        let dev_path_alt = PathBuf::from("backend/catalogos");
        if dev_path_alt.exists() {
            dev_path_alt
        } else {
            // Em produção, usar LocalAppData
            if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                PathBuf::from(local_app_data).join("Formatura PRO").join("catalogos")
            } else {
                PathBuf::from(".").join("catalogos")
            }
        }
    };
    
    fs::create_dir_all(&catalog_dir).ok();
    catalog_dir.join(format!("{}.db", catalog))
}

pub fn establish_connection(catalog: &str) -> Result<Connection> {
    let db_path = get_catalog_db_path(catalog);
    let conn = Connection::open(&db_path)?;
    
    // Configurações de performance do SQLite (WAL e Synchronous Normal)
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    
    // Criar tabelas fundamentais caso não existam (conforme db.py)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ocorrencias (
            aluno_id TEXT, foto_path TEXT,
            x1 INTEGER, y1 INTEGER, x2 INTEGER, y2 INTEGER,
            photo_hash TEXT,
            blur_score REAL, blur_status TEXT, closed_eyes INTEGER,
            has_gown INTEGER, has_diploma INTEGER, has_sash INTEGER, has_cap INTEGER,
            face_front_score REAL, graduation_score REAL,
            graduation_scores TEXT DEFAULT '{}',
            graduation_tags TEXT DEFAULT '[]',
            graduation_analyzed_at TEXT,
            foreground_score REAL, is_foreground INTEGER DEFAULT 1,
            face_area_ratio REAL, center_score REAL,
            background_penalty_reason TEXT,
            person_key TEXT DEFAULT '',
            reference_folder TEXT DEFAULT '',
            graduation_reviewed INTEGER DEFAULT 0,
            manual_graduation_tags TEXT DEFAULT ''
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS alunos (
            person_key TEXT PRIMARY KEY, aluno_id TEXT,
            face_cache_path TEXT, class_name TEXT DEFAULT 'Sem turma',
            reference_folder TEXT DEFAULT ''
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS discarded_photos (
            foto_path TEXT PRIMARY KEY,
            created_at REAL DEFAULT (strftime('%s','now'))
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS catalog_settings (
            catalog_name TEXT PRIMARY KEY,
            scan_paths TEXT DEFAULT '',
            root_path TEXT DEFAULT '',
            selected_folders TEXT DEFAULT '{}'
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS catalog_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            catalog_name TEXT NOT NULL, path TEXT NOT NULL,
            include_subfolders INTEGER DEFAULT 1,
            photo_count INTEGER DEFAULT 0, last_scan_at REAL,
            status TEXT DEFAULT 'active', folder_type TEXT DEFAULT 'event',
            created_at REAL DEFAULT (strftime('%s','now'))
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS export_history (
            uuid TEXT PRIMARY KEY,
            dest_path TEXT,
            mode TEXT,
            files_json TEXT,
            folders_json TEXT,
            timestamp TEXT,
            created_at REAL DEFAULT (strftime('%s','now'))
        )",
        [],
    )?;

    conn.execute("CREATE INDEX IF NOT EXISTS idx_export_history_dest ON export_history(dest_path)", [])?;

    // Índices recomendados para alta performance nas buscas
    conn.execute("CREATE INDEX IF NOT EXISTS idx_alunos_aluno_id ON alunos(aluno_id)", [])?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ocor_aluno ON ocorrencias(aluno_id)", [])?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ocor_foto ON ocorrencias(foto_path)", [])?;
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_folder_unique ON catalog_folders(catalog_name, path)", [])?;
    
    Ok(conn)
}
