use std::sync::{Arc, Mutex};
use std::path::{Path, PathBuf};
use std::fs;
use std::collections::HashMap;
use std::time::{Instant, SystemTime};
use serde::{Serialize, Deserialize};
use chrono::{DateTime, Local};
use tauri::Manager;

#[allow(unused_imports)]
use tauri_plugin_shell::ShellExt;

mod db;
mod media;
mod ai;
mod scanner;
mod export;
mod media_explorer;

#[derive(Serialize)]
struct CatalogMeta {
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct TimingInfo {
    listdir: f64,
    metadata: f64,
    total: f64,
}

#[derive(Serialize)]
struct ListCatalogsResponse {
    current: String,
    catalogs: Vec<String>,
    catalog_meta: HashMap<String, CatalogMeta>,
    _timing: TimingInfo,
}

#[derive(Serialize)]
struct CatalogSettingsResponse {
    catalog: String,
    scan_paths: Vec<String>,
    root_path: String,
    selected_folders: serde_json::Value,
    quality: serde_json::Value,
    scanner: serde_json::Value,
    export: serde_json::Value,
    ui: serde_json::Value,
}

#[derive(Deserialize)]
struct CatalogSettingsReq {
    catalog: String,
    scan_paths: Vec<String>,
    root_path: String,
    selected_folders: serde_json::Value,
}

#[derive(Serialize)]
struct CatalogFolder {
    id: i64,
    path: String,
    include_subfolders: i32,
    photo_count: i32,
    last_scan_at: Option<f64>,
    status: String,
    folder_type: String,
}

fn get_catalog_dir(app: &tauri::AppHandle) -> PathBuf {
    // 1. Em desenvolvimento, checar caminhos relativos ao workspace do Tauri
    // PRIORIDADE: Primeiro local ("backend/catalogos") para evitar pastas legadas de backups no nível superior
    let dev_path_2 = PathBuf::from("backend/catalogos");
    if dev_path_2.exists() {
        return dev_path_2;
    }
    let dev_path_1 = PathBuf::from("../backend/catalogos");
    if dev_path_1.exists() {
        return dev_path_1;
    }
    
    // 2. Em produção ou fallback, usar LocalAppData/Formatura PRO/catalogos
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("Formatura PRO").join("catalogos");
        if p.exists() {
            return p;
        }
    }
    
    // Fallback padrão do Tauri para dados locais
    app.path().local_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("catalogos")
}

fn get_last_catalog() -> String {
    let paths = vec![
        PathBuf::from("backend/last_catalog.txt"),
        PathBuf::from("../backend/last_catalog.txt"),
    ];
    for p in paths {
        if p.exists() {
            if let Ok(content) = fs::read_to_string(p) {
                return content.trim().to_string();
            }
        }
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("Formatura PRO").join("last_catalog.txt");
        if let Ok(content) = fs::read_to_string(p) {
            return content.trim().to_string();
        }
    }
    String::new()
}

fn save_last_catalog(name: &str) {
    let paths = vec![
        PathBuf::from("backend/last_catalog.txt"),
        PathBuf::from("../backend/last_catalog.txt"),
    ];
    for p in paths {
        if p.parent().map_or(false, |parent| parent.exists()) {
            if fs::write(&p, name).is_ok() {
                return;
            }
        }
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("Formatura PRO").join("last_catalog.txt");
        fs::create_dir_all(p.parent().unwrap()).ok();
        fs::write(p, name).ok();
    }
}

fn format_system_time(st: SystemTime) -> String {
    let dt: DateTime<Local> = st.into();
    dt.format("%d/%m/%Y %H:%M:%S").to_string()
}

#[tauri::command]
fn list_catalogs(app_handle: tauri::AppHandle) -> Result<ListCatalogsResponse, String> {
    let start = Instant::now();
    let catalog_dir = get_catalog_dir(&app_handle);
    
    let mut dbs = Vec::new();
    let list_time;
    
    match fs::read_dir(&catalog_dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("db") {
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        if !name.is_empty() {
                            dbs.push(name.to_string());
                        }
                    }
                }
            }
            dbs.sort();
            list_time = start.elapsed().as_secs_f64();
        }
        Err(e) => {
            return Err(format!("Falha ao ler diretorio de catalogos: {}", e));
        }
    }
    
    let meta_start = Instant::now();
    let mut catalog_meta = HashMap::new();
    
    for name in &dbs {
        let path = catalog_dir.join(format!("{}.db", name));
        match fs::metadata(path) {
            Ok(meta) => {
                let created = meta.created().unwrap_or(SystemTime::now());
                let modified = meta.modified().unwrap_or(SystemTime::now());
                catalog_meta.insert(
                    name.clone(),
                    CatalogMeta {
                        created_at: format_system_time(created),
                        updated_at: format_system_time(modified),
                    },
                );
            }
            Err(_) => {
                catalog_meta.insert(
                    name.clone(),
                    CatalogMeta {
                        created_at: String::new(),
                        updated_at: String::new(),
                    },
                );
            }
        }
    }
    
    let meta_time = meta_start.elapsed().as_secs_f64();
    let total_time = start.elapsed().as_secs_f64();
    
    Ok(ListCatalogsResponse {
        current: get_last_catalog(),
        catalogs: dbs,
        catalog_meta,
        _timing: TimingInfo {
            listdir: (list_time * 1000.0).round() / 1000.0,
            metadata: (meta_time * 1000.0).round() / 1000.0,
            total: (total_time * 1000.0).round() / 1000.0,
        },
    })
}

#[tauri::command]
fn set_catalog(name: String, state: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let sanitized_name = name.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "");
    if sanitized_name.is_empty() {
        return Err("Nome de catalogo invalido".to_string());
    }
    
    // Abre a conexao SQLite sob demanda para inicializar as tabelas
    let _conn = db::establish_connection(&sanitized_name)
        .map_err(|e| format!("Falha ao conectar ao banco do catalogo: {}", e))?;
        
    // Salva o nome ativo no estado do Tauri
    let mut active = state.current_catalog.lock().unwrap();
    *active = sanitized_name.clone();
    
    // Grava no arquivo last_catalog.txt
    save_last_catalog(&sanitized_name);
    
    Ok(serde_json::json!({
        "status": "ok",
        "current": sanitized_name
    }))
}

#[tauri::command]
fn get_catalog_settings(catalog: String) -> Result<CatalogSettingsResponse, String> {
    // Abre conexao SQLite sob demanda
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Falha ao abrir conexao do banco: {}", e))?;
    
    let mut stmt = conn
        .prepare("SELECT scan_paths, root_path, selected_folders FROM catalog_settings WHERE catalog_name = ?")
        .map_err(|e| e.to_string())?;
        
    let mut rows = stmt
        .query_map([&catalog], |row| {
            let scan_paths_str: String = row.get(0).unwrap_or_default();
            let root_path: String = row.get(1).unwrap_or_default();
            let selected_folders_str: String = row.get(2).unwrap_or_default();
            Ok((scan_paths_str, root_path, selected_folders_str))
        })
        .map_err(|e| e.to_string())?;
        
    if let Some(Ok((scan_paths_str, root_path, selected_folders_str))) = rows.next() {
        let scan_paths = if scan_paths_str.is_empty() {
            Vec::new()
        } else {
            scan_paths_str.split('|').map(|s| s.to_string()).collect()
        };
        
        let selected_folders = if selected_folders_str.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&selected_folders_str).unwrap_or(serde_json::json!({}))
        };
        
        Ok(CatalogSettingsResponse {
            catalog,
            scan_paths,
            root_path,
            selected_folders,
            quality: serde_json::json!({}),
            scanner: serde_json::json!({}),
            export: serde_json::json!({}),
            ui: serde_json::json!({}),
        })
    } else {
        Ok(CatalogSettingsResponse {
            catalog,
            scan_paths: Vec::new(),
            root_path: String::new(),
            selected_folders: serde_json::json!({}),
            quality: serde_json::json!({}),
            scanner: serde_json::json!({}),
            export: serde_json::json!({}),
            ui: serde_json::json!({}),
        })
    }
}

#[tauri::command]
fn save_catalog_settings(req: CatalogSettingsReq) -> Result<serde_json::Value, String> {
    // Abre conexao SQLite sob demanda
    let conn = db::establish_connection(&req.catalog)
        .map_err(|e| format!("Falha ao abrir conexao do banco: {}", e))?;
    
    let scan_paths_str = req.scan_paths.join("|");
    let selected_folders_str = serde_json::to_string(&req.selected_folders).unwrap_or_else(|_| "{}".to_string());
    
    conn.execute(
        "INSERT OR REPLACE INTO catalog_settings (catalog_name, scan_paths, root_path, selected_folders)
         VALUES (?, ?, ?, ?)",
        [&req.catalog, &scan_paths_str, &req.root_path, &selected_folders_str],
    )
    .map_err(|e| format!("Falha ao salvar configuracoes do catalogo: {}", e))?;
    
    Ok(serde_json::json!({ "status": "ok" }))
}

#[tauri::command]
fn list_catalog_folders(catalog: String) -> Result<serde_json::Value, String> {
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Falha ao conectar ao banco: {}", e))?;
        
    let mut stmt = conn
        .prepare("SELECT id, path, include_subfolders, photo_count, last_scan_at, status, folder_type 
                  FROM catalog_folders WHERE catalog_name = ? ORDER BY id ASC")
        .map_err(|e| e.to_string())?;
        
    let rows = stmt
        .query_map([&catalog], |row| {
            Ok(CatalogFolder {
                id: row.get(0)?,
                path: row.get(1)?,
                include_subfolders: row.get(2)?,
                photo_count: row.get(3)?,
                last_scan_at: row.get(4)?,
                status: row.get(5)?,
                folder_type: row.get(6).unwrap_or_else(|_| "event".to_string()),
            })
        })
        .map_err(|e| e.to_string())?;
        
    let folders: Vec<CatalogFolder> = rows.filter_map(|r| r.ok()).collect();
    
    Ok(serde_json::json!({
        "folders": folders
    }))
}

#[tauri::command]
fn add_catalog_folder(
    catalog: String,
    path: String,
    include_subfolders: bool,
    folder_type: String,
) -> Result<serde_json::Value, String> {
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Falha ao conectar ao banco: {}", e))?;
        
    conn.execute(
        "INSERT OR IGNORE INTO catalog_folders (catalog_name, path, include_subfolders, status, folder_type) 
         VALUES (?, ?, ?, ?, ?)",
        (
            &catalog,
            &path,
            if include_subfolders { 1 } else { 0 },
            "active",
            &folder_type,
        ),
    )
    .map_err(|e| e.to_string())?;
    
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn remove_catalog_folder(
    catalog: String,
    folder_id: Option<i64>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Falha ao conectar ao banco: {}", e))?;
        
    if let Some(id) = folder_id {
        conn.execute(
            "DELETE FROM catalog_folders WHERE catalog_name = ? AND id = ?",
            (&catalog, id),
        )
        .map_err(|e| e.to_string())?;
    } else if let Some(p) = path {
        conn.execute(
            "DELETE FROM catalog_folders WHERE catalog_name = ? AND path = ?",
            (&catalog, &p),
        )
        .map_err(|e| e.to_string())?;
    } else {
        return Err("Informe folder_id ou path para exclusao".to_string());
    }
    
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn toggle_catalog_folder(
    catalog: String,
    folder_id: Option<i64>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Falha ao conectar ao banco: {}", e))?;
        
    if let Some(id) = folder_id {
        conn.execute(
            "UPDATE catalog_folders SET status = CASE WHEN status = 'active' THEN 'inactive' ELSE 'active' END 
             WHERE catalog_name = ? AND id = ?",
            (&catalog, id),
        )
        .map_err(|e| e.to_string())?;
    } else if let Some(p) = path {
        conn.execute(
            "UPDATE catalog_folders SET status = CASE WHEN status = 'active' THEN 'inactive' ELSE 'active' END 
             WHERE catalog_name = ? AND path = ?",
            (&catalog, &p),
        )
        .map_err(|e| e.to_string())?;
    } else {
        return Err("Informe folder_id ou path para alteracao".to_string());
    }
    
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn unload_ai_models(
    ai_state: tauri::State<'_, scanner::FaceEngineState>,
) -> Result<serde_json::Value, String> {
    let mut ai_lock = ai_state.engine.lock().unwrap();
    if let Some(ref mut engine) = *ai_lock {
        engine.unload();
        log::info!("Sessoes do ONNX Runtime descarregadas ativamente via IPC.");
    }
    Ok(serde_json::json!({ "success": true }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let backend_process: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>> = Arc::new(Mutex::new(None));
  let _backend_process_clone = Arc::clone(&backend_process);
  
  let db_state = db::DbState { current_catalog: Mutex::new(get_last_catalog()) };
  let scan_state = scanner::ScanState { is_scanning: Mutex::new(false), cancel_requested: Mutex::new(false) };
  let ai_state = scanner::FaceEngineState { engine: Mutex::new(crate::ai::FaceEngine::new().ok()) };
  let export_state = export::ExportState::new();
 
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(db_state)
    .manage(scan_state)
    .manage(ai_state)
    .manage(export_state)
    .invoke_handler(tauri::generate_handler![
        list_catalogs,
        set_catalog,
        get_catalog_settings,
        save_catalog_settings,
        list_catalog_folders,
        add_catalog_folder,
        remove_catalog_folder,
        toggle_catalog_folder,
        ai::test_load_ai_models,
        unload_ai_models,
        scanner::scan_precheck,
        scanner::start_scan,
        scanner::stop_scan,
        export::check_export_conflicts,
        export::export_quality,
        export::start_export,
        export::get_export_status,
        export::clear_export_summary,
        export::get_export_history,
        media_explorer::explorer_ls,
        media_explorer::explorer_tree,
        media_explorer::explorer_photos,
        media_explorer::preview_faces_native,
        media_explorer::set_photo_rating,
        media_explorer::toggle_photo_favorite,
        media_explorer::get_photos_ratings,
        media_explorer::get_photo_info
    ])
    .register_uri_scheme_protocol("thumb", move |_app_handle, request| {
      // 1. Converte e analisa a URL de forma resiliente a contrabarras do Windows decodificadas pelo WebView2
      let uri_str = request.uri().to_string();
      
      let mut path = String::new();
      let mut query = HashMap::new();
      let is_face = uri_str.contains("/face");

      if let Some(q_idx) = uri_str.find('?') {
          let query_str = &uri_str[q_idx + 1..];
          query = url::form_urlencoded::parse(query_str.as_bytes())
              .into_owned()
              .collect();
          path = query.get("path").cloned().unwrap_or_default();
      }

      // Preparação do log de debug de thumbnails no scratch
      let log_dir = PathBuf::from("scratch");
      std::fs::create_dir_all(&log_dir).ok();
      let log_file = log_dir.join("thumb_debug.log");
      let mut debug_info = format!(
          "--- THUMB REQUEST ---\nTimestamp: {}\nURI: {}\nParsed Path: {}\nOriginal Path Exists: {}\nIs Face: {}\n",
          chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
          uri_str,
          path,
          Path::new(&path).exists(),
          is_face
      );

      if path.is_empty() {
          let _ = std::fs::OpenOptions::new().create(true).write(true).append(true).open(&log_file).and_then(|mut f| {
              use std::io::Write;
              writeln!(f, "{}Error: Path is empty\n\n", debug_info)
          });
          return tauri::http::Response::builder()
              .status(400)
              .header("content-type", "text/plain")
              .header("access-control-allow-origin", "*")
              .body(b"Caminho original ausente".to_vec())
              .unwrap();
      }
      
      // Resolve o cache path
      let cache_path = if is_face {
          let x1: i32 = query.get("x1").and_then(|s| s.parse().ok()).unwrap_or(0);
          let y1: i32 = query.get("y1").and_then(|s| s.parse().ok()).unwrap_or(0);
          let x2: i32 = query.get("x2").and_then(|s| s.parse().ok()).unwrap_or(1);
          let y2: i32 = query.get("y2").and_then(|s| s.parse().ok()).unwrap_or(1);
          let size: u32 = query.get("size").and_then(|s| s.parse().ok()).unwrap_or(120);
          let expand: f32 = query.get("expand").and_then(|s| s.parse().ok()).unwrap_or(0.35);
          let quality: u8 = query.get("q").and_then(|s| s.parse().ok()).unwrap_or(80);
          
          let cache = media::get_cached_thumb_path(
              &path,
              "face",
              &[
                  &x1.to_string(),
                  &y1.to_string(),
                  &x2.to_string(),
                  &y2.to_string(),
                  &size.to_string(),
                  &expand.to_string(),
                  &quality.to_string(),
              ],
          );
          
          match cache {
              Ok(cp) => {
                  debug_info.push_str(&format!("Cache Path: {}\nCache Exists: {}\n", cp.to_string_lossy(), cp.exists()));
                  if !cp.exists() {
                      // Gera sob demanda
                      if let Err(e) = media::generate_face_thumb(&path, cp.to_str().unwrap(), x1, y1, x2, y2, size, expand, quality) {
                          let err_msg = format!("Erro ao gerar miniatura de face: {}", e);
                          log::error!("{}", err_msg);
                          debug_info.push_str(&format!("Error: {}\n\n", err_msg));
                          let _ = std::fs::OpenOptions::new().create(true).write(true).append(true).open(&log_file).and_then(|mut f| {
                              use std::io::Write;
                              writeln!(f, "{}", debug_info)
                          });
                          return tauri::http::Response::builder()
                              .status(500)
                              .header("content-type", "text/plain")
                              .header("access-control-allow-origin", "*")
                              .body(b"Erro de processamento de face".to_vec())
                              .unwrap();
                      }
                  }
                  cp
              }
              Err(e) => {
                  let err_msg = format!("Erro ao obter cache path: {}", e);
                  debug_info.push_str(&format!("Error: {}\n\n", err_msg));
                  let _ = std::fs::OpenOptions::new().create(true).write(true).append(true).open(&log_file).and_then(|mut f| {
                      use std::io::Write;
                      writeln!(f, "{}", debug_info)
                  });
                  return tauri::http::Response::builder()
                      .status(404)
                      .header("content-type", "text/plain")
                      .header("access-control-allow-origin", "*")
                      .body(e.into_bytes())
                      .unwrap();
              }
          }
      } else {
          let size: u32 = query.get("size").and_then(|s| s.parse().ok()).unwrap_or(400);
          let quality: u8 = query.get("q").and_then(|s| s.parse().ok()).unwrap_or(80);
          
          let cache = media::get_cached_thumb_path(
              &path,
              "image",
              &[&size.to_string(), &quality.to_string()],
          );
          
          match cache {
              Ok(cp) => {
                  debug_info.push_str(&format!("Cache Path: {}\nCache Exists: {}\n", cp.to_string_lossy(), cp.exists()));
                  if !cp.exists() {
                      // Gera sob demanda
                      if let Err(e) = media::generate_image_thumb(&path, cp.to_str().unwrap(), size, quality) {
                          let err_msg = format!("Erro ao gerar miniatura de imagem: {}", e);
                          log::error!("{}", err_msg);
                          debug_info.push_str(&format!("Error: {}\n\n", err_msg));
                          let _ = std::fs::OpenOptions::new().create(true).write(true).append(true).open(&log_file).and_then(|mut f| {
                              use std::io::Write;
                              writeln!(f, "{}", debug_info)
                          });
                          return tauri::http::Response::builder()
                              .status(500)
                              .header("content-type", "text/plain")
                              .header("access-control-allow-origin", "*")
                              .body(b"Erro de processamento de imagem".to_vec())
                              .unwrap();
                      }
                  }
                  cp
              }
              Err(e) => {
                  let err_msg = format!("Erro ao obter cache path: {}", e);
                  debug_info.push_str(&format!("Error: {}\n\n", err_msg));
                  let _ = std::fs::OpenOptions::new().create(true).write(true).append(true).open(&log_file).and_then(|mut f| {
                      use std::io::Write;
                      writeln!(f, "{}", debug_info)
                  });
                  return tauri::http::Response::builder()
                      .status(404)
                      .header("content-type", "text/plain")
                      .header("access-control-allow-origin", "*")
                      .body(e.into_bytes())
                      .unwrap();
              }
          }
      };
      
      debug_info.push_str("Status: SUCCESS\n\n");
      let _ = std::fs::OpenOptions::new().create(true).write(true).append(true).open(&log_file).and_then(|mut f| {
          use std::io::Write;
          writeln!(f, "{}", debug_info)
      });

      // Retorna o arquivo gerado
      match fs::read(&cache_path) {
          Ok(bytes) => {
              tauri::http::Response::builder()
                  .header("content-type", "image/jpeg")
                  .header("cache-control", "max-age=86400")
                  .header("access-control-allow-origin", "*")
                  .body(bytes)
                  .unwrap()
          }
          Err(e) => {
              tauri::http::Response::builder()
                  .status(500)
                  .header("content-type", "text/plain")
                  .header("access-control-allow-origin", "*")
                  .body(format!("Erro ao ler cache gerado: {}", e).into_bytes())
                  .unwrap()
          }
      }
    })
    .setup(move |app| {
      // Registra o plugin de logs tanto em dev quanto em producao para termos diagnostico
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;

      // Inicia o sidecar do backend em producao (em dev, rodamos o python de forma independente)
      #[cfg(not(debug_assertions))]
      {
        match app.shell().sidecar("backend") {
          Ok(sidecar) => {
            // Desativa a abertura automatica do navegador e garante a porta 8000
            let sidecar = sidecar
              .args(["--port", "8000"])
              .env("FORM_PRO_NO_BROWSER", "1");

            match sidecar.spawn() {
              Ok((_rx, child)) => {
                let mut process = _backend_process_clone.lock().unwrap();
                *process = Some(child);
                log::info!("Sidecar 'backend' iniciado com sucesso.");
              }
              Err(e) => {
                log::error!("Falha ao dar spawn no sidecar 'backend': {:?}", e);
              }
            }
          }
          Err(e) => {
            log::error!("Falha ao resolver o sidecar 'backend': {:?}", e);
          }
        }
      }

      Ok(())
    })
    .on_window_event(move |_window, event| {
      // Quando a janela principal e destruida, mata o processo do backend
      if let tauri::WindowEvent::Destroyed = event {
        let mut process = backend_process.lock().unwrap();
        if let Some(child) = process.take() {
          let _ = child.kill();
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
