use std::path::{Path, PathBuf};
use std::collections::{HashSet, HashMap};
use serde::Serialize;
use walkdir::WalkDir;

use crate::db;
use crate::scanner;

const RAW_EXTENSIONS: &[&str] = &["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf", "srw", "x3f"];
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"];
const HEIC_EXTENSIONS: &[&str] = &["heic", "heif"];
const VIDEO_EXTENSIONS: &[&str] = &["mov", "mp4", "avi", "mts", "m2ts", "insv", "360"];

#[derive(Serialize)]
struct SubfolderCounts {
    #[serde(rename = "RAW")]
    raw: usize,
    #[serde(rename = "JPG")]
    jpg: usize,
    #[serde(rename = "PNG")]
    png: usize,
    #[serde(rename = "HEIC")]
    heic: usize,
    #[serde(rename = "MOV")]
    mov: usize,
}

#[derive(Serialize)]
pub struct TreeFolderEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    direct_files: usize,
    total_files: usize,
    has_children: bool,
    counts: SubfolderCounts,
    children: Vec<TreeFolderEntry>,
    camera: Option<String>,
}

#[derive(Serialize)]
struct ExplorerEntryInfo {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    size: Option<u64>,
    mtime: Option<f64>,
    ctime: Option<f64>,
}

#[derive(Serialize)]
struct ExplorerFileStatus {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    size: Option<u64>,
    mtime: Option<f64>,
    ctime: Option<f64>,
    in_db: bool,
    is_identified: bool,
    has_unknown: bool,
    discarded: bool,
    discarded_scope: Option<String>,
    discarded_global: bool,
    discarded_local: bool,
    faces: Vec<serde_json::Value>,
}

fn normalize_path(p: &str) -> String {
    p.replace("\\", "/").to_lowercase()
}

fn get_user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn get_logical_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let drive_path = format!("{}:\\", letter as char);
        if Path::new(&drive_path).exists() {
            drives.push(drive_path);
        }
    }
    drives
}

#[cfg(not(target_os = "windows"))]
fn get_logical_drives() -> Vec<String> {
    vec!["/".to_string()]
}

fn get_camera_model_native(file_path: &Path) -> Option<String> {
    let file = std::fs::File::open(file_path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let exifreader = exif::Reader::new();
    let exif = exifreader.read_from_container(&mut reader).ok()?;
    
    let make = exif.get_field(exif::Tag::Make, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string())
        .unwrap_or_default();
        
    let model = exif.get_field(exif::Tag::Model, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string())
        .unwrap_or_default();
        
    if make.is_empty() && model.is_empty() {
        return None;
    }
    
    let full = format!("{} {}", make, model).trim().to_string();
    let cleaned = full
        .replace("\"", "")
        .replace("CORPORATION", "")
        .replace("Canon ", "")
        .replace("NIKON ", "")
        .trim()
        .to_string();
        
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || name == "__pycache__" || name == "node_modules" || name == "dist" || name == "target" || name == ".venv" || name == ".git"
}

fn is_ignored_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("_crop_") || lower.contains("_processed") || lower.contains("debug_")
}

fn explorer_entry_info_native(path: &Path, entry_type: &str, custom_name: Option<&str>) -> ExplorerEntryInfo {
    let name = custom_name
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        
    let mut info = ExplorerEntryInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        entry_type: entry_type.to_string(),
        size: None,
        mtime: None,
        ctime: None,
    };
    
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.is_file() {
            info.size = Some(meta.len());
        }
        if let Ok(modified) = meta.modified() {
            if let Ok(duration) = modified.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                info.mtime = Some(duration.as_secs_f64());
            }
        }
        if let Ok(created) = meta.created() {
            if let Ok(duration) = created.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                info.ctime = Some(duration.as_secs_f64());
            }
        }
    }
    
    info
}

fn get_catalog_root_path(conn: &rusqlite::Connection) -> String {
    if let Ok(mut stmt) = conn.prepare("SELECT face_cache_path FROM alunos WHERE aluno_id = 'system_catalog'") {
        if let Ok(mut rows) = stmt.query([]) {
            if let Ok(Some(row)) = rows.next() {
                return row.get::<_, String>(0).unwrap_or_default();
            }
        }
    }
    String::new()
}

fn is_within_root(path: &Path, root: &Path) -> bool {
    if let (Ok(p_abs), Ok(r_abs)) = (path.canonicalize(), root.canonicalize()) {
        p_abs.starts_with(r_abs)
    } else {
        false
    }
}

fn get_supported_extensions(include_video: bool) -> HashSet<String> {
    let mut set = HashSet::new();
    for ext in RAW_EXTENSIONS { set.insert(ext.to_string()); }
    for ext in IMAGE_EXTENSIONS { set.insert(ext.to_string()); }
    for ext in HEIC_EXTENSIONS { set.insert(ext.to_string()); }
    if include_video {
        for ext in VIDEO_EXTENSIONS { set.insert(ext.to_string()); }
    }
    set
}

fn scan_tree_recursive(
    dir_path: &Path,
    depth: usize,
    max_depth: usize,
) -> (Vec<TreeFolderEntry>, usize, SubfolderCounts, bool, Option<String>) {
    let entries = match std::fs::read_dir(dir_path) {
        Ok(read) => {
            let mut list = Vec::new();
            for e in read.flatten() {
                list.push(e);
            }
            list.sort_by(|a, b| {
                a.file_name().to_string_lossy().to_lowercase()
                    .cmp(&b.file_name().to_string_lossy().to_lowercase())
            });
            list
        }
        Err(_) => return (Vec::new(), 0, SubfolderCounts { raw: 0, jpg: 0, png: 0, heic: 0, mov: 0 }, false, None),
    };

    let mut children = Vec::new();
    let mut direct_files = 0;
    let mut direct_counts = SubfolderCounts { raw: 0, jpg: 0, png: 0, heic: 0, mov: 0 };
    let mut has_children = false;
    let mut camera_model = None;

    for entry in entries {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        
        if path.is_dir() {
            if is_ignored_dir(&file_name) {
                continue;
            }
            has_children = true;
            let reached_limit = (depth + 1) >= max_depth;

            if reached_limit {
                let mut sub_has = false;
                let mut sub_direct = 0;
                let mut sub_counts = SubfolderCounts { raw: 0, jpg: 0, png: 0, heic: 0, mov: 0 };

                for sub_e in WalkDir::new(&path)
                    .min_depth(1)
                    .into_iter()
                    .filter_entry(|e| {
                        let name = e.file_name().to_string_lossy();
                        !is_ignored_dir(&name)
                    })
                    .flatten()
                {
                    let name = sub_e.file_name().to_string_lossy();
                    if name.starts_with('.') || name.starts_with('~') || is_ignored_file(&name) {
                        continue;
                    }
                    if sub_e.file_type().is_dir() {
                        sub_has = true;
                    } else if sub_e.file_type().is_file() {
                        if let Some(ext) = sub_e.path().extension().and_then(|s| s.to_str()) {
                            let ext_lower = ext.to_lowercase();
                            if RAW_EXTENSIONS.contains(&ext_lower.as_str()) {
                                sub_counts.raw += 1;
                                sub_direct += 1;
                            } else if IMAGE_EXTENSIONS.contains(&ext_lower.as_str()) {
                                sub_counts.jpg += 1;
                                sub_direct += 1;
                            } else if HEIC_EXTENSIONS.contains(&ext_lower.as_str()) {
                                sub_counts.heic += 1;
                                sub_direct += 1;
                            } else if VIDEO_EXTENSIONS.contains(&ext_lower.as_str()) {
                                sub_counts.mov += 1;
                                sub_direct += 1;
                            }
                        }
                    }
                }

                children.push(TreeFolderEntry {
                    name: file_name,
                    path: path.to_string_lossy().into_owned(),
                    entry_type: "folder".to_string(),
                    direct_files: sub_direct,
                    total_files: sub_direct,
                    has_children: sub_has,
                    counts: sub_counts,
                    children: Vec::new(),
                    camera: None,
                });
            } else {
                let (sub_children, sub_direct_files, sub_counts, sub_has, sub_camera) =
                    scan_tree_recursive(&path, depth + 1, max_depth);

                let mut sub_total = sub_direct_files;
                let mut agg_counts = SubfolderCounts {
                    raw: sub_counts.raw,
                    jpg: sub_counts.jpg,
                    png: sub_counts.png,
                    heic: sub_counts.heic,
                    mov: sub_counts.mov,
                };

                for sub in &sub_children {
                    sub_total += sub.total_files;
                    agg_counts.raw += sub.counts.raw;
                    agg_counts.jpg += sub.counts.jpg;
                    agg_counts.png += sub.counts.png;
                    agg_counts.heic += sub.counts.heic;
                    agg_counts.mov += sub.counts.mov;
                }

                children.push(TreeFolderEntry {
                    name: file_name,
                    path: path.to_string_lossy().into_owned(),
                    entry_type: "folder".to_string(),
                    direct_files: sub_direct_files,
                    total_files: sub_total,
                    has_children: sub_has || !sub_children.is_empty(),
                    counts: agg_counts,
                    children: sub_children,
                    camera: sub_camera,
                });
            }
        } else if path.is_file() {
            if file_name.starts_with('.') || file_name.starts_with('~') || is_ignored_file(&file_name) {
                continue;
            }
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                let ext_lower = ext.to_lowercase();
                let mut is_img = false;
                if RAW_EXTENSIONS.contains(&ext_lower.as_str()) {
                    direct_counts.raw += 1;
                    direct_files += 1;
                } else if IMAGE_EXTENSIONS.contains(&ext_lower.as_str()) {
                    direct_counts.jpg += 1;
                    direct_files += 1;
                    is_img = true;
                } else if HEIC_EXTENSIONS.contains(&ext_lower.as_str()) {
                    direct_counts.heic += 1;
                    direct_files += 1;
                } else if VIDEO_EXTENSIONS.contains(&ext_lower.as_str()) {
                    direct_counts.mov += 1;
                    direct_files += 1;
                }

                if camera_model.is_none() && is_img {
                    camera_model = get_camera_model_native(&path);
                }
            }
        }
    }

    (children, direct_files, direct_counts, has_children, camera_model)
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn explorer_ls(
    path: String,
    catalog: String,
    db_state: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let mut catalog_root = String::new();
    let mut conn_opt = None;
    
    let active_catalog = if catalog.is_empty() {
        let lock = db_state.current_catalog.lock().unwrap();
        lock.clone()
    } else {
        catalog
    };
    
    if !active_catalog.is_empty() {
        if let Ok(c) = db::establish_connection(&active_catalog) {
            catalog_root = get_catalog_root_path(&c);
            conn_opt = Some(c);
        }
    }

    if path.is_empty() {
        let home = get_user_home().unwrap_or_else(|| PathBuf::from("."));
        let desktop = home.join("Desktop");
        let documents = home.join("Documents");
        let pictures = home.join("Pictures");

        let mut dirs = vec![
            serde_json::json!({
                "name": "Este Computador",
                "path": "este_computador",
                "type": "drive",
                "size": null,
                "mtime": null,
                "ctime": null
            }),
            serde_json::json!(explorer_entry_info_native(&desktop, "dir", Some("Área de Trabalho"))),
            serde_json::json!(explorer_entry_info_native(&documents, "dir", Some("Documentos"))),
            serde_json::json!(explorer_entry_info_native(&home, "dir", home.file_name().and_then(|n| n.to_str()))),
            serde_json::json!(explorer_entry_info_native(&pictures, "dir", Some("Imagens"))),
        ];

        // Se houver fotos no catálogo, adiciona atalho para a primeira pasta do catálogo
        if let Some(ref conn) = conn_opt {
            if let Ok(mut stmt) = conn.prepare("SELECT foto_path FROM ocorrencias LIMIT 1") {
                if let Ok(mut rows) = stmt.query([]) {
                    if let Ok(Some(row)) = rows.next() {
                        if let Ok(foto_path) = row.get::<_, String>(0) {
                            if let Some(parent) = Path::new(&foto_path).parent() {
                                dirs.insert(1, serde_json::json!({
                                    "name": "Pasta do Catálogo Atual",
                                    "path": parent.to_string_lossy().into_owned(),
                                    "type": "dir"
                                }));
                            }
                        }
                    }
                }
            }
        }

        return Ok(serde_json::json!({
            "current_path": "",
            "dirs": dirs,
            "files": []
        }));
    }

    if path == "este_computador" {
        let drives = get_logical_drives();
        let dirs: Vec<serde_json::Value> = drives.iter().map(|d| {
            let name = if d.starts_with("C:") {
                format!("Disco Local ({})", &d[..2])
            } else {
                format!("Unidade ({})", &d[..2])
            };
            serde_json::json!(explorer_entry_info_native(Path::new(d), "drive", Some(&name)))
        }).collect();

        return Ok(serde_json::json!({
            "current_path": "este_computador",
            "dirs": dirs,
            "files": []
        }));
    }

    // Resolve caminhos especiais
    let resolved_path = if path == "desktop" || path == "downloads" || path == "documents" || path == "pictures" || path == "catalog" {
        let home = get_user_home().unwrap_or_else(|| PathBuf::from("."));
        if path == "desktop" {
            home.join("Desktop")
        } else if path == "downloads" {
            home.join("Downloads")
        } else if path == "documents" {
            home.join("Documents")
        } else if path == "pictures" {
            home.join("Pictures")
        } else {
            if !catalog_root.is_empty() {
                PathBuf::from(&catalog_root)
            } else if let Some(ref conn) = conn_opt {
                let mut p = home;
                if let Ok(mut stmt) = conn.prepare("SELECT foto_path FROM ocorrencias LIMIT 1") {
                    if let Ok(mut rows) = stmt.query([]) {
                        if let Ok(Some(row)) = rows.next() {
                            if let Ok(foto_path) = row.get::<_, String>(0) {
                                if let Some(parent) = Path::new(&foto_path).parent().and_then(|pa| pa.parent()) {
                                    p = parent.to_path_buf();
                                }
                            }
                        }
                    }
                }
                p
            } else {
                home
            }
        }
    } else {
        PathBuf::from(&path)
    };

    if !resolved_path.exists() || !resolved_path.is_dir() {
        return Err("Pasta nao encontrada".to_string());
    }

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    let is_recursive_view = !catalog_root.is_empty() && is_within_root(&resolved_path, Path::new(&catalog_root));

    if is_recursive_view {
        for entry in WalkDir::new(&resolved_path)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !is_ignored_dir(&name)
            })
            .flatten()
        {
            if entry.file_type().is_file() {
                let name = entry.file_name().to_string_lossy();
                if name.starts_with('.') || name.starts_with('~') || is_ignored_file(&name) {
                    continue;
                }
                if let Some(ext) = entry.path().extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if IMAGE_EXTENSIONS.contains(&ext_lower.as_str()) {
                        files.push(entry.path().to_path_buf());
                    }
                }
            }
        }
    } else {
        if let Ok(read) = std::fs::read_dir(&resolved_path) {
            for entry in read.flatten() {
                let p = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if p.is_dir() {
                    if is_ignored_dir(&name) {
                        continue;
                    }
                    dirs.push(explorer_entry_info_native(&p, "dir", None));
                } else if p.is_file() {
                    if name.starts_with('.') || name.starts_with('~') || is_ignored_file(&name) {
                        continue;
                    }
                    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                        let ext_lower = ext.to_lowercase();
                        if IMAGE_EXTENSIONS.contains(&ext_lower.as_str()) {
                            files.push(p);
                        }
                    }
                }
            }
        }
    }

    // Carrega dados de descarte e ocorrências faciais do SQLite do catálogo
    let mut discarded = HashSet::new();
    struct DbFace {
        aluno_id: String,
        box_coords: [i32; 4],
    }
    let mut db_map: HashMap<String, (String, Vec<DbFace>)> = HashMap::new();

    if let Some(ref conn) = conn_opt {
        if let Ok(mut stmt) = conn.prepare("SELECT foto_path FROM discarded_photos") {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    if let Ok(fp) = row.get::<_, String>(0) {
                        discarded.insert(normalize_path(&fp));
                    }
                }
            }
        }
        
        if let Ok(mut stmt) = conn.prepare("SELECT foto_path, aluno_id, x1, y1, x2, y2 FROM ocorrencias") {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    let fp: String = row.get(0).unwrap_or_default();
                    let aluno_id: String = row.get(1).unwrap_or_default();
                    let x1: i32 = row.get(2).unwrap_or(0);
                    let y1: i32 = row.get(3).unwrap_or(0);
                    let x2: i32 = row.get(4).unwrap_or(0);
                    let y2: i32 = row.get(5).unwrap_or(0);
                    
                    let norm = normalize_path(&fp);
                    let entry = db_map.entry(norm).or_insert_with(|| (fp, Vec::new()));
                    entry.1.push(DbFace {
                        aluno_id,
                        box_coords: [x1, y1, x2, y2],
                    });
                }
            }
        }
    }

    let mut file_status = Vec::new();
    for f in files {
        let fnorm = normalize_path(&f.to_string_lossy());
        let mut db_path = f.to_string_lossy().into_owned();
        let mut is_identified = false;
        let mut has_unknown = false;
        let mut faces_list = Vec::new();

        if let Some((real_path, faces)) = db_map.get(&fnorm) {
            db_path = real_path.clone();
            for face in faces {
                let is_unk = face.aluno_id.starts_with("Pessoa ") || face.aluno_id == "Desconhecido";
                if is_unk {
                    has_unknown = true;
                } else {
                    is_identified = true;
                }
                faces_list.push(serde_json::json!({
                    "aluno_id": face.aluno_id,
                    "box": face.box_coords
                }));
            }
        }

        let in_db = db_map.contains_key(&fnorm);
        let is_discarded = discarded.contains(&fnorm) || discarded.contains(&normalize_path(&db_path));

        let basic_info = explorer_entry_info_native(&f, "img", None);

        file_status.push(ExplorerFileStatus {
            name: basic_info.name,
            path: db_path,
            entry_type: "img".to_string(),
            size: basic_info.size,
            mtime: basic_info.mtime,
            ctime: basic_info.ctime,
            in_db,
            is_identified,
            has_unknown,
            discarded: is_discarded,
            discarded_scope: if is_discarded { Some("global".to_string()) } else { None },
            discarded_global: is_discarded,
            discarded_local: false,
            faces: faces_list,
        });
    }

    if !is_recursive_view {
        dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    }
    file_status.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(serde_json::json!({
        "current_path": resolved_path.to_string_lossy().into_owned(),
        "dirs": dirs,
        "files": file_status
    }))
}

#[tauri::command]
pub async fn explorer_tree(path: String, max_depth: Option<usize>) -> Result<serde_json::Value, String> {
    if path.is_empty() {
        return Err("Path obrigatorio".to_string());
    }
    
    let dec_path = PathBuf::from(&path);
    if !dec_path.exists() || !dec_path.is_dir() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "Pasta nao encontrada",
            "path": path,
            "name": "",
            "direct_files": 0,
            "total_files": 0,
            "children": []
        }));
    }

    let limit = max_depth.unwrap_or(10);
    let base_name = dec_path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    let (children, direct_files, direct_counts, has_children, camera_model) =
        scan_tree_recursive(&dec_path, 0, limit);

    let mut total_files = direct_files;
    let mut total_raw = direct_counts.raw;
    let mut total_photos = direct_counts.jpg + direct_counts.heic + direct_counts.png;
    let mut total_jpg = direct_counts.jpg;

    for c in &children {
        total_files += c.total_files;
        total_raw += c.counts.raw;
        total_jpg += c.counts.jpg;
        total_photos += c.counts.jpg + c.counts.heic + c.counts.png;
    }

    Ok(serde_json::json!({
        "ok": true,
        "error": "",
        "path": dec_path.to_string_lossy().into_owned(),
        "name": base_name,
        "direct_files": direct_files,
        "total_files": total_files,
        "total_photos": total_photos,
        "total_raw": total_raw,
        "total_jpg": total_jpg,
        "has_children": has_children,
        "children": children,
        "camera": camera_model
    }))
}

#[tauri::command]
pub async fn explorer_photos(
    path: String,
    recursive: bool,
    limit: usize,
    offset: usize,
    include_raw: bool,
    include_video: bool,
) -> Result<serde_json::Value, String> {
    if path.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "Path obrigatorio",
            "path": "",
            "total": 0,
            "photos": []
        }));
    }

    let dec_path = PathBuf::from(&path);
    if !dec_path.exists() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "Pasta nao encontrada",
            "path": path,
            "total": 0,
            "photos": []
        }));
    }
    if !dec_path.is_dir() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "Caminho nao e uma pasta",
            "path": path,
            "total": 0,
            "photos": []
        }));
    }

    let mut photo_paths = Vec::new();
    let supported = get_supported_extensions(include_video);

    if recursive {
        for entry in WalkDir::new(&dec_path)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !is_ignored_dir(&name)
            })
            .flatten()
        {
            if entry.file_type().is_file() {
                let name = entry.file_name().to_string_lossy();
                if name.starts_with('.') || name.starts_with('~') || is_ignored_file(&name) {
                    continue;
                }
                if let Some(ext) = entry.path().extension().and_then(|s| s.to_str()) {
                    if supported.contains(&ext.to_lowercase()) {
                        photo_paths.push(entry.path().to_path_buf());
                    }
                }
            }
        }
    } else {
        if let Ok(entries) = std::fs::read_dir(&dec_path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') || name.starts_with('~') || is_ignored_file(&name) {
                        continue;
                    }
                    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                        if supported.contains(&ext.to_lowercase()) {
                            photo_paths.push(p);
                        }
                    }
                }
            }
        }
    }

    if !include_raw {
        photo_paths.retain(|p| {
            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                !RAW_EXTENSIONS.contains(&ext.to_lowercase().as_str())
            } else {
                true
            }
        });
    }

    let total = photo_paths.len();
    let mut photos = Vec::new();

    if limit > 0 {
        photo_paths.sort_by(|a, b| {
            let name_a = a.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            let name_b = b.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            name_a.cmp(&name_b)
        });

        let start = offset;
        let end = (start + limit).min(total);

        let page = if start < total {
            &photo_paths[start..end]
        } else {
            &[]
        };

        for fp in page {
            let ext = fp.extension().and_then(|s| s.to_str()).unwrap_or_default().to_lowercase();
            let is_raw = RAW_EXTENSIONS.contains(&ext.as_str());
            let is_video = VIDEO_EXTENSIONS.contains(&ext.as_str());
            
            let basic_info = explorer_entry_info_native(fp, "img", None);
            let folder_name = fp.parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
                
            let ftype = if is_raw { "raw" } else if is_video { "video" } else { "image" };
            
            let fp_str = fp.to_string_lossy().into_owned();
            let encoded_path = url::form_urlencoded::byte_serialize(fp_str.as_bytes()).collect::<String>();
            let thumb_url = format!("thumb://localhost/?path={}&size=300", encoded_path);
            let preview_url = format!("thumb://localhost/?path={}&size=1200", encoded_path);

            photos.push(serde_json::json!({
                "name": basic_info.name,
                "folder": folder_name,
                "path": fp_str,
                "ext": format!(".{}", ext),
                "type": ftype,
                "size": basic_info.size,
                "mtime": basic_info.mtime,
                "is_raw": is_raw,
                "is_video": is_video,
                "thumb_url": thumb_url,
                "preview_url": preview_url,
            }));
        }
    }

    Ok(serde_json::json!({
        "ok": true,
        "error": "",
        "path": dec_path.to_string_lossy().into_owned(),
        "recursive": recursive,
        "total": total,
        "limit": limit,
        "offset": offset,
        "photos": photos
    }))
}

#[tauri::command]
pub async fn preview_faces_native(
    path: String,
    ai_state: tauri::State<'_, scanner::FaceEngineState>,
) -> Result<serde_json::Value, String> {
    let decoded = PathBuf::from(&path);
        
    if !decoded.exists() || !decoded.is_file() {
        return Err("Arquivo nao encontrado".to_string());
    }
    
    let img = image::open(&decoded)
        .map_err(|e| format!("Falha ao ler imagem: {}", e))?;
        
    let w = img.width();
    let h = img.height();
    
    let mut ai_lock = ai_state.engine.lock().unwrap();
    let engine = ai_lock.as_mut()
        .ok_or_else(|| "Motor de IA nao carregado ou indisponivel".to_string())?;
        
    let detected = engine.detect_faces(&img, 0.5)?;
    
    let mut faces_list = Vec::new();
    for face in detected {
        let x1 = face.bbox.0 as i32;
        let y1 = face.bbox.1 as i32;
        let x2 = face.bbox.2 as i32;
        let y2 = face.bbox.3 as i32;
        
        let area = (x2 - x1).max(0) * (y2 - y1).max(0);
        let confidence = face.score;
        
        let fp_str = decoded.to_string_lossy().into_owned();
        let encoded_path = url::form_urlencoded::byte_serialize(fp_str.as_bytes()).collect::<String>();
        let crop_url = format!(
            "thumb://localhost/face?path={}&x1={}&y1={}&x2={}&y2={}&size=120&q=80",
            encoded_path, x1, y1, x2, y2
        );
        
        faces_list.push(serde_json::json!({
            "bbox": [x1, y1, x2, y2],
            "confidence": (confidence * 10000.0).round() / 10000.0,
            "area": area,
            "is_primary": false,
            "crop_url": crop_url,
        }));
    }
    
    faces_list.sort_by(|a, b| {
        let area_a = a["area"].as_i64().unwrap_or(0);
        let area_b = b["area"].as_i64().unwrap_or(0);
        area_b.cmp(&area_a)
    });
    
    if !faces_list.is_empty() {
        faces_list[0]["is_primary"] = serde_json::Value::Bool(true);
    }
    
    Ok(serde_json::json!({
        "ok": true,
        "path": decoded.to_string_lossy().into_owned(),
        "faces": faces_list,
        "width": w,
        "height": h
    }))
}

#[tauri::command]
pub async fn set_photo_rating(
    catalog: String,
    foto_path: String,
    rating: i32,
    db_state: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let active_catalog = if catalog.is_empty() {
        let lock = db_state.current_catalog.lock().unwrap();
        lock.clone()
    } else {
        catalog
    };
    if active_catalog.is_empty() {
        return Err("Nenhum catalogo ativo ou fornecido".to_string());
    }

    let conn = db::establish_connection(&active_catalog)
        .map_err(|e| format!("Erro ao conectar ao banco do catalogo: {}", e))?;
        
    conn.execute(
        "INSERT INTO photo_meta (foto_path, rating) VALUES (?, ?)
         ON CONFLICT(foto_path) DO UPDATE SET rating = excluded.rating",
        rusqlite::params![foto_path, rating],
    )
    .map_err(|e| format!("Erro ao salvar classificacao da foto: {}", e))?;
    
    Ok(serde_json::json!({
        "success": true,
        "rating": rating
    }))
}

#[tauri::command]
pub async fn toggle_photo_favorite(
    catalog: String,
    foto_path: String,
    db_state: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let active_catalog = if catalog.is_empty() {
        let lock = db_state.current_catalog.lock().unwrap();
        lock.clone()
    } else {
        catalog
    };
    if active_catalog.is_empty() {
        return Err("Nenhum catalogo ativo ou fornecido".to_string());
    }

    let conn = db::establish_connection(&active_catalog)
        .map_err(|e| format!("Erro ao conectar ao banco do catalogo: {}", e))?;
        
    let mut current_favorite = 0;
    if let Ok(mut stmt) = conn.prepare("SELECT favorite FROM photo_meta WHERE foto_path = ?") {
        if let Ok(mut rows) = stmt.query(rusqlite::params![foto_path]) {
            if let Ok(Some(row)) = rows.next() {
                current_favorite = row.get::<_, i32>(0).unwrap_or(0);
            }
        }
    }
    
    let next_favorite = 1 - current_favorite;
    
    conn.execute(
        "INSERT INTO photo_meta (foto_path, favorite) VALUES (?, ?)
         ON CONFLICT(foto_path) DO UPDATE SET favorite = excluded.favorite",
        rusqlite::params![foto_path, next_favorite],
    )
    .map_err(|e| format!("Erro ao salvar favorito da foto: {}", e))?;
    
    Ok(serde_json::json!({
        "success": true,
        "favorite": next_favorite == 1
    }))
}

#[tauri::command]
pub async fn get_photos_ratings(
    catalog: String,
    foto_paths: Vec<String>,
    db_state: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let active_catalog = if catalog.is_empty() {
        let lock = db_state.current_catalog.lock().unwrap();
        lock.clone()
    } else {
        catalog
    };
    if active_catalog.is_empty() {
        return Err("Nenhum catalogo ativo ou fornecido".to_string());
    }

    let conn = db::establish_connection(&active_catalog)
        .map_err(|e| format!("Erro ao conectar ao banco do catalogo: {}", e))?;
        
    let mut stmt = conn.prepare("SELECT rating, favorite FROM photo_meta WHERE foto_path = ?")
        .map_err(|e| format!("Erro ao preparar query de ratings: {}", e))?;
        
    let mut items = Vec::new();
    for path in foto_paths {
        let mut rating = 0;
        let mut favorite = false;
        if let Ok(mut rows) = stmt.query(rusqlite::params![path]) {
            if let Ok(Some(row)) = rows.next() {
                rating = row.get::<_, i32>(0).unwrap_or(0);
                favorite = row.get::<_, i32>(1).unwrap_or(0) == 1;
            }
        }
        items.push(serde_json::json!({
            "foto_path": path,
            "rating": rating,
            "favorite": favorite
        }));
    }
    
    Ok(serde_json::json!({
        "items": items
    }))
}

#[tauri::command]
pub async fn get_photo_info(
    catalog: String,
    path: String,
    db_state: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let active_catalog = if catalog.is_empty() {
        let lock = db_state.current_catalog.lock().unwrap();
        lock.clone()
    } else {
        catalog
    };
    if active_catalog.is_empty() {
        return Err("Nenhum catalogo ativo ou fornecido".to_string());
    }

    let conn = db::establish_connection(&active_catalog)
        .map_err(|e| format!("Erro ao conectar ao banco do catalogo: {}", e))?;
        
    let mut discarded = false;
    if let Ok(mut stmt) = conn.prepare("SELECT 1 FROM discarded_photos WHERE foto_path = ?") {
        if let Ok(mut rows) = stmt.query(rusqlite::params![path]) {
            if let Ok(Some(_)) = rows.next() {
                discarded = true;
            }
        }
    }
    
    let mut faces = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT x1, y1, x2, y2, aluno_id FROM ocorrencias WHERE foto_path = ? AND aluno_id IS NOT NULL") {
        if let Ok(mut rows) = stmt.query(rusqlite::params![path]) {
            while let Ok(Some(row)) = rows.next() {
                let x1: Option<i32> = row.get(0).ok();
                let y1: Option<i32> = row.get(1).ok();
                let x2: Option<i32> = row.get(2).ok();
                let y2: Option<i32> = row.get(3).ok();
                let name: String = row.get(4).unwrap_or_default();
                
                if let (Some(x1_val), Some(y1_val), Some(x2_val), Some(y2_val)) = (x1, y1, x2, y2) {
                    faces.push(serde_json::json!({
                        "box": [x1_val, y1_val, x2_val, y2_val],
                        "name": name
                    }));
                }
            }
        }
    }
    
    Ok(serde_json::json!({
        "faces": faces,
        "discarded": discarded
    }))
}
