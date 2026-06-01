use std::path::Path;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use serde::{Serialize, Deserialize};
use walkdir::WalkDir;
use tauri::{Emitter, Manager};
use crate::db;
use crate::ai::{FaceEngine, align_face};

pub struct FaceEngineState {
    pub engine: Mutex<Option<FaceEngine>>,
}

pub struct ScanState {
    pub is_scanning: Mutex<bool>,
    pub cancel_requested: Mutex<bool>,
}

#[derive(Serialize, Clone)]
pub struct ScanProgress {
    pub running: bool,
    pub stopped: bool,
    pub processed_photos: usize,
    pub total_photos: usize,
    pub elapsed_seconds: f64,
    pub status_text: String,
}

#[derive(Deserialize)]
pub struct ScanRequest {
    pub catalog: String,
    pub scan_paths: Vec<String>,
}

#[derive(Serialize)]
pub struct PrecheckResult {
    pub files_count: usize,
    pub invalid_extensions_count: usize,
    pub scan_paths: Vec<String>,
}

struct ReferenceFace {
    person_key: String,
    aluno_id: String,
    embedding: Vec<f32>,
}

pub fn count_valid_images(paths: &[String]) -> (usize, usize) {
    let mut valid_count = 0;
    let mut invalid_count = 0;
    let exts = vec![".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"];
    
    for path_str in paths {
        let path = Path::new(path_str);
        if !path.exists() || !path.is_dir() {
            continue;
        }
        
        for entry in WalkDir::new(path).into_iter().flatten() {
            if entry.path().is_file() {
                if let Some(ext) = entry.path().extension().and_then(|s| s.to_str()) {
                    let ext_lower = format!(".{}", ext.to_lowercase());
                    if exts.contains(&ext_lower.as_str()) {
                        valid_count += 1;
                    } else {
                        invalid_count += 1;
                    }
                } else {
                    invalid_count += 1;
                }
            }
        }
    }
    
    (valid_count, invalid_count)
}

#[tauri::command]
pub async fn scan_precheck(req: ScanRequest) -> Result<PrecheckResult, String> {
    let (valid, invalid) = count_valid_images(&req.scan_paths);
    Ok(PrecheckResult {
        files_count: valid,
        invalid_extensions_count: invalid,
        scan_paths: req.scan_paths,
    })
}

#[tauri::command]
pub async fn stop_scan(state: tauri::State<'_, ScanState>) -> Result<serde_json::Value, String> {
    let mut cancel = state.cancel_requested.lock().unwrap();
    *cancel = true;
    Ok(serde_json::json!({ "success": true }))
}

fn load_references(
    conn: &rusqlite::Connection,
    catalog: &str,
    engine: &mut FaceEngine,
) -> Vec<ReferenceFace> {
    let mut refs = Vec::new();
    
    // 1. Tenta carregar pastas de referência registradas na tabela catalog_folders
    let mut stmt = match conn.prepare(
        "SELECT path, status FROM catalog_folders WHERE catalog_name = ? AND folder_type = 'reference'"
    ) {
        Ok(s) => s,
        Err(_) => return refs,
    };
    
    let rows = stmt.query_map([catalog], |row| {
        let path: String = row.get(0)?;
        let status: String = row.get(1)?;
        Ok((path, status))
    });
    
    let active_paths: Vec<String> = if let Ok(r) = rows {
        r.filter_map(|x| x.ok())
            .filter(|x| x.1 == "active")
            .map(|x| x.0)
            .collect()
    } else {
        Vec::new()
    };
    
    let exts = vec![".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"];
    
    for ref_dir in active_paths {
        let ref_path = Path::new(&ref_dir);
        if !ref_path.exists() || !ref_path.is_dir() {
            continue;
        }
        
        for entry in WalkDir::new(ref_path).into_iter().flatten() {
            if entry.path().is_file() {
                if let Some(ext) = entry.path().extension().and_then(|s| s.to_str()) {
                    let ext_lower = format!(".{}", ext.to_lowercase());
                    if exts.contains(&ext_lower.as_str()) {
                        let full_path = entry.path();
                        let file_stem = match full_path.file_stem().and_then(|s| s.to_str()) {
                            Some(s) => s.to_string(),
                            None => continue,
                        };
                        
                        if file_stem.trim().is_empty() || file_stem == "." || file_stem == ".." {
                            continue;
                        }
                        
                        let rel_path = match full_path.strip_prefix(ref_path) {
                            Ok(rp) => rp.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                            Err(_) => String::new(),
                        };
                        let class_name = if rel_path.is_empty() {
                            "Sem turma".to_string()
                        } else {
                            rel_path.replace("\\", "/")
                        };
                        
                        let person_key = format!(
                            "{}::{}::{}::{}",
                            catalog.to_uppercase(),
                            class_name.to_uppercase(),
                            file_stem.to_uppercase(),
                            file_stem.to_uppercase()
                        );
                        
                        if let Ok(img) = crate::media::load_image_with_orientation(full_path) {
                            if let Ok(faces) = engine.detect_faces(&img, 0.50) {
                                if !faces.is_empty() {
                                    let mut sorted_faces = faces;
                                    sorted_faces.sort_by(|a, b| {
                                        let area_a = (a.bbox.2 - a.bbox.0) * (a.bbox.3 - a.bbox.1);
                                        let area_b = (b.bbox.2 - b.bbox.0) * (b.bbox.3 - b.bbox.1);
                                        area_b.partial_cmp(&area_a).unwrap_or(std::cmp::Ordering::Equal)
                                    });
                                    
                                    let best_face = &sorted_faces[0];
                                    if let Ok(aligned) = align_face(&img, &best_face.kps) {
                                        if let Ok(emb) = engine.extract_embedding(&aligned) {
                                            conn.execute(
                                                "INSERT OR IGNORE INTO alunos (person_key, aluno_id, class_name, reference_folder) 
                                                 VALUES (?, ?, ?, ?)",
                                                (&person_key, &file_stem, &class_name, &file_stem),
                                            ).ok();
                                            
                                            let mtime = std::fs::metadata(full_path).ok()
                                                .and_then(|m| m.modified().ok())
                                                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                                .map(|d| d.as_nanos() as i64)
                                                .unwrap_or(0);
                                            let size = std::fs::metadata(full_path).ok().map(|m| m.len() as i64).unwrap_or(0);
                                            
                                            let emb_bytes = unsafe {
                                                std::slice::from_raw_parts(
                                                    emb.as_ptr() as *const u8,
                                                    emb.len() * 4
                                                )
                                            };
                                            
                                            conn.execute(
                                                "INSERT OR REPLACE INTO face_embeddings (foto_path, x1, y1, x2, y2, mtime_ns, size, embedding) 
                                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                                (full_path.to_str().unwrap(), 0, 0, 0, 0, mtime, size, emb_bytes),
                                            ).ok();
                                            
                                            refs.push(ReferenceFace {
                                                person_key: person_key.clone(),
                                                aluno_id: file_stem.clone(),
                                                embedding: emb,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    // 2. Além da pasta física, também lê referências conhecidas que já foram persistidas no banco!
    let mut stmt_db = match conn.prepare(
        "SELECT o.person_key, o.aluno_id, e.embedding 
         FROM face_embeddings e 
         JOIN ocorrencias o ON e.foto_path = o.foto_path AND e.x1 = o.x1 AND e.y1 = o.y1 AND e.x2 = o.x2 AND e.y2 = o.y2 
         WHERE o.aluno_id != 'Desconhecido' AND o.person_key != ''"
    ) {
        Ok(s) => s,
        Err(_) => return refs,
    };
    
    let db_rows = stmt_db.query_map([], |row| {
        let pkey: String = row.get(0)?;
        let aid: String = row.get(1)?;
        let bytes: Vec<u8> = row.get(2)?;
        Ok((pkey, aid, bytes))
    });
    
    if let Ok(r) = db_rows {
        for item in r.flatten() {
            let pkey = item.0;
            let aid = item.1;
            let bytes = item.2;
            
            if bytes.len() % 4 == 0 {
                let count = bytes.len() / 4;
                let mut emb = vec![0.0f32; count];
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        bytes.as_ptr(),
                        emb.as_mut_ptr() as *mut u8,
                        bytes.len()
                    );
                }
                refs.push(ReferenceFace {
                    person_key: pkey,
                    aluno_id: aid,
                    embedding: emb,
                });
            }
        }
    }
    
    refs
}

fn find_best_reference(
    emb: &[f32],
    references: &[ReferenceFace],
) -> (Option<String>, Option<String>, f32) {
    let mut best_pkey = None;
    let mut best_aid = None;
    let mut best_score = -1.0f32;
    
    for r in references {
        let mut score = 0.0f32;
        for i in 0..512 {
            score += emb[i] * r.embedding[i];
        }
        
        if score > best_score {
            best_score = score;
            best_pkey = Some(r.person_key.clone());
            best_aid = Some(r.aluno_id.clone());
        }
    }
    
    (best_pkey, best_aid, best_score)
}

#[tauri::command]
pub async fn start_scan(
    app: tauri::AppHandle,
    req: ScanRequest,
    state: tauri::State<'_, ScanState>,
) -> Result<serde_json::Value, String> {
    {
        let mut scanning = state.is_scanning.lock().unwrap();
        if *scanning {
            return Err("Uma varredura ja esta em andamento".to_string());
        }
        *scanning = true;
    }
    
    {
        let mut cancel = state.cancel_requested.lock().unwrap();
        *cancel = false;
    }
    
    let app_clone = app.clone();
    let catalog = req.catalog.clone();
    let scan_paths = req.scan_paths.clone();
    
    tauri::async_runtime::spawn(async move {
        let scan_state = app_clone.state::<ScanState>();
        let ai_state = app_clone.state::<FaceEngineState>();
        let start_time = Instant::now();
        
        let mut files = Vec::new();
        let exts = vec![".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"];
        
        for path_str in &scan_paths {
            let path = Path::new(path_str);
            if !path.exists() || !path.is_dir() {
                continue;
            }
            for entry in WalkDir::new(path).into_iter().flatten() {
                if entry.path().is_file() {
                    if let Some(ext) = entry.path().extension().and_then(|s| s.to_str()) {
                        let ext_lower = format!(".{}", ext.to_lowercase());
                        if exts.contains(&ext_lower.as_str()) {
                            files.push(entry.path().to_path_buf());
                        }
                    }
                }
            }
        }
        
        let total_files = files.len();
        let mut processed = 0;
        
        let conn = db::establish_connection(&catalog);
        let has_db = conn.is_ok();
        
        // 1. Carrega as referências de formandos conhecidas (pasta e banco) se o motor de IA estiver ativo
        let mut references = Vec::new();
        let mut has_ai = false;
        {
            let mut ai_lock = ai_state.engine.lock().unwrap();
            if let Some(ref mut engine) = *ai_lock {
                has_ai = true;
                if has_db {
                    if let Ok(ref c) = conn {
                        references = load_references(c, &catalog, engine);
                    }
                }
            }
        }
        
        // 2. Loop de processamento real de fotos
        for file in files {
            {
                let cancel = scan_state.cancel_requested.lock().unwrap();
                if *cancel {
                    log::info!("Varredura cancelada pelo usuario.");
                    break;
                }
            }
            
            let path_str = file.to_string_lossy();
            
            if has_db {
                if let Ok(ref c) = conn {
                    // Otimização Incremental: Verifica se a foto já foi escaneada antes
                    let mut exists = false;
                    if let Ok(mut stmt) = c.prepare("SELECT COUNT(*) FROM ocorrencias WHERE foto_path = ?") {
                        if let Ok(count) = stmt.query_row([&path_str.to_string()], |row| row.get::<_, i64>(0)) {
                            exists = count > 0;
                        }
                    }
                    
                    if !exists {
                        // Processamento Real de Fotos com IA
                        let mut faces_detected = Vec::new();
                        let mut loaded_img = None;
                        
                        if has_ai {
                            if let Ok(img) = crate::media::load_image_with_orientation(&file) {
                                let mut ai_lock = ai_state.engine.lock().unwrap();
                                if let Some(ref mut engine) = *ai_lock {
                                    if let Ok(faces) = engine.detect_faces(&img, 0.50) {
                                        faces_detected = faces;
                                        loaded_img = Some(img);
                                    }
                                }
                            }
                        }
                        
                        if !faces_detected.is_empty() && loaded_img.is_some() {
                            let img = loaded_img.unwrap();
                            let mut ai_lock = ai_state.engine.lock().unwrap();
                            let engine = ai_lock.as_mut().unwrap();
                            
                            for face in faces_detected {
                                let mut aluno_id = "Desconhecido".to_string();
                                let mut person_key = "".to_string();
                                
                                if let Ok(aligned) = align_face(&img, &face.kps) {
                                    if let Ok(emb) = engine.extract_embedding(&aligned) {
                                        // Busca vetorial de similaridade nativa!
                                        let (best_pkey, best_aid, score) = find_best_reference(&emb, &references);
                                        if score >= 0.50 {
                                            if let (Some(pkey), Some(aid)) = (best_pkey, best_aid) {
                                                person_key = pkey;
                                                aluno_id = aid;
                                            }
                                        }
                                        
                                        // Grava embedding na tabela face_embeddings
                                        let mtime = std::fs::metadata(&file).ok()
                                            .and_then(|m| m.modified().ok())
                                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                            .map(|d| d.as_nanos() as i64)
                                            .unwrap_or(0);
                                        let size = std::fs::metadata(&file).ok().map(|m| m.len() as i64).unwrap_or(0);
                                        
                                        let emb_bytes = unsafe {
                                            std::slice::from_raw_parts(
                                                emb.as_ptr() as *const u8,
                                                emb.len() * 4
                                            )
                                        };
                                        
                                        c.execute(
                                            "INSERT OR REPLACE INTO face_embeddings (foto_path, x1, y1, x2, y2, mtime_ns, size, embedding) 
                                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                            (&path_str, face.bbox.0 as i32, face.bbox.1 as i32, face.bbox.2 as i32, face.bbox.3 as i32, mtime, size, emb_bytes),
                                        ).ok();
                                    }
                                }
                                
                                // Insere ocorrência com o aluno identificado (ou Desconhecido se limiar não atingido)
                                c.execute(
                                    "INSERT OR IGNORE INTO ocorrencias (aluno_id, person_key, foto_path, x1, y1, x2, y2, foreground_score) 
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    (&aluno_id, &person_key, &path_str, face.bbox.0 as i32, face.bbox.1 as i32, face.bbox.2 as i32, face.bbox.3 as i32, 1.0),
                                ).ok();
                            }
                        } else {
                            // Se nenhuma face foi detectada, insere registro vazio/Desconhecido para a foto
                            c.execute(
                                "INSERT OR IGNORE INTO ocorrencias (aluno_id, foto_path, x1, y1, x2, y2, foreground_score) 
                                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                                ("Desconhecido", &path_str, 0, 0, 0, 0, 1.0),
                            ).ok();
                        }
                    }
                }
            }
            
            processed += 1;
            
            if processed % 5 == 0 || processed == total_files {
                let progress = ScanProgress {
                    running: true,
                    stopped: false,
                    processed_photos: processed,
                    total_photos: total_files,
                    elapsed_seconds: start_time.elapsed().as_secs_f64(),
                    status_text: format!("Processando foto {} de {}...", processed, total_files),
                };
                
                app_clone.emit("scan-progress", progress).ok();
            }
        }
        
        if has_db {
            if let Ok(ref c) = conn {
                let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64();
                for path_str in &scan_paths {
                    c.execute(
                        "UPDATE catalog_folders SET photo_count = ?, last_scan_at = ? WHERE path = ?",
                        (processed as i32, now_secs, path_str),
                    ).ok();
                }
            }
        }
        
        {
            let mut scanning = scan_state.is_scanning.lock().unwrap();
            *scanning = false;
        }
        
        let cancel = scan_state.cancel_requested.lock().unwrap();
        let final_progress = ScanProgress {
            running: false,
            stopped: *cancel,
            processed_photos: processed,
            total_photos: total_files,
            elapsed_seconds: start_time.elapsed().as_secs_f64(),
            status_text: if *cancel { "Varredura interrompida".to_string() } else { "Varredura concluida!".to_string() },
        };
        app_clone.emit("scan-progress", final_progress).ok();
    });
    
    Ok(serde_json::json!({ "success": true }))
}
