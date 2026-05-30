use std::sync::{Arc, Mutex};
use std::path::{Path, PathBuf};
use std::fs;
use std::time::{Instant, SystemTime};
use std::collections::{HashMap, HashSet};
use serde::{Serialize, Deserialize};
use chrono::{Local, DateTime};
use tauri::{State, Manager};
use zip::write::{FileOptions, ZipWriter};
use std::io::{Write, Seek};

use crate::db;

// Constantes estruturais para o ZIP/Excel OpenXML nativo
const CONTENT_TYPES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;

const ROOT_RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;

const WORKBOOK_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Resumo" sheetId="1" r:id="rId1"/>
<sheet name="Formandos" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>"#;

const WORKBOOK_RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExportReq {
    pub ids: Vec<String>,
    pub dest_path: String,
    pub mode: String, // "copy" ou "move"
    #[serde(default = "default_conflict_strategy")]
    pub conflict_strategy: String, // "copy", "overwrite", "skip", "recreate"
    #[serde(default)]
    pub include_quality: bool,
    #[serde(default = "default_true")]
    pub include_descarte: bool,
    #[serde(default)]
    pub organize_by_class: bool,
    #[serde(default = "default_export_format")]
    pub export_format: String, // "original" ou "jpg"
}

fn default_conflict_strategy() -> String { "copy".to_string() }
fn default_true() -> bool { true }
fn default_export_format() -> String { "original".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSummary {
    pub export_id: String,
    pub export_dir: String,
    pub pdf_path: String,
    pub dest_path: String,
    pub report_path: String,
    pub pdf_report_path: String,
    pub time_seconds: u64,
    pub time_str: String,
    pub folder_count: usize,
    pub photo_count: usize,
    pub mode: String,
    pub export_format: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportStatus {
    pub is_exporting: bool,
    pub progress: f32,
    pub status_text: String,
    pub total_files: usize,
    pub processed_files: usize,
    pub eta_seconds: u64,
    pub export_summary: Option<ExportSummary>,
    pub export_dir: String,
    pub pdf_path: String,
    pub export_id: String,
}

pub struct ExportState {
    pub status: Mutex<ExportStatus>,
}

impl ExportState {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(ExportStatus {
                is_exporting: false,
                progress: 0.0,
                status_text: "Ocioso".to_string(),
                total_files: 0,
                processed_files: 0,
                eta_seconds: 0,
                export_summary: None,
                export_dir: String::new(),
                pdf_path: String::new(),
                export_id: String::new(),
            }),
        }
    }
}

// Struct auxiliar para itens da lista de exportação
#[derive(Debug, Clone)]
struct WorkItem {
    aluno_id: String,
    source_path: String,
    dest_dir: PathBuf,
}

// 1. Sanitize folder name conforme backend legante
pub fn sanitize_folder_name(name: &str) -> String {
    let s = name.trim();
    if s.is_empty() {
        return "Sem_Nome".to_string();
    }
    let invalid_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let mut sanitized = String::new();
    for c in s.chars() {
        if invalid_chars.contains(&c) {
            sanitized.push('_');
        } else {
            sanitized.push(c);
        }
    }
    let res = sanitized.trim().to_string();
    if res.is_empty() { "Sem_Nome".to_string() } else { res }
}

fn clean_student_id(aid: &str) -> String {
    if aid == "#BASE" || aid == "#DESCARTE" {
        return aid.to_string();
    }
    // Remove "max_..." ou composto "catalogo::classe::ref::id"
    let cleaned = if aid.contains("::") {
        aid.split("::").last().unwrap_or(aid)
    } else {
        aid
    };
    
    // Tratamento adicional simples
    let mut cleaned_str = cleaned.trim().to_string();
    if cleaned_str.to_uppercase().starts_with("MAX_") {
        cleaned_str = cleaned_str[4..].to_string();
    }
    if cleaned_str.to_uppercase().starts_with("SEM_TURMA_") {
        cleaned_str = cleaned_str[10..].to_string();
    }
    
    // Desduplica caso de "123_123"
    let parts: Vec<&str> = cleaned_str.split('_').collect();
    if parts.len() >= 2 && parts[0] == parts[1] && !parts[0].is_empty() {
        cleaned_str = parts[0].to_string();
    }
    
    cleaned_str
}

fn student_export_dir(dest_path: &str, aid: &str, class_name: &str, organize_by_class: bool) -> PathBuf {
    let student_dir = sanitize_folder_name(&clean_student_id(aid));
    let export_base = Path::new(dest_path).join("Exportação");
    let class_str = class_name.trim();

    if !class_str.is_empty() && class_str != "Sem turma" && class_str != "__SEM_TURMA__" {
        if organize_by_class {
            let mut p = export_base;
            for part in class_str.replace('\\', "/").split('/') {
                if !part.trim().is_empty() {
                    p = p.join(sanitize_folder_name(part));
                }
            }
            p.join(student_dir)
        } else {
            let safe_class = sanitize_folder_name(class_str);
            export_base.join(format!("{} - {}", safe_class, student_dir))
        }
    } else {
        if organize_by_class {
            export_base.join("Sem turma").join(student_dir)
        } else {
            export_base.join(student_dir)
        }
    }
}

// 2. Constrói a lista de arquivos de exportação e seus destinos correspondentes
fn build_export_worklist(conn: &rusqlite::Connection, req: &ExportReq) -> Result<Vec<WorkItem>, String> {
    let mut worklist = Vec::new();
    let mut exported_paths = HashSet::new();
    
    // Carrega mapeamento de turmas/alunos em memória
    let mut student_classes = HashMap::new();
    let mut student_keys = HashMap::new();
    
    if let Ok(mut stmt) = conn.prepare("SELECT aluno_id, class_name, person_key FROM alunos") {
        let rows = stmt.query_map([], |r| {
            let aid: String = r.get(0)?;
            let class_name: String = r.get(1).unwrap_or_else(|_| "Sem turma".to_string());
            let pk: String = r.get(2).unwrap_or_default();
            Ok((aid, class_name, pk))
        });
        if let Ok(iterator) = rows {
            for item in iterator.flatten() {
                student_classes.insert(item.0.clone(), item.1);
                student_keys.insert(item.0, item.2);
            }
        }
    }

    // Carrega fotos descartadas manualmente
    let mut discarded_manual = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT foto_path FROM discarded_photos") {
        let rows = stmt.query_map([], |r| r.get::<_, String>(0));
        if let Ok(iterator) = rows {
            for item in iterator.flatten() {
                discarded_manual.insert(item);
            }
        }
    }

    // 1. Fotos de alunos selecionados
    for aid in &req.ids {
        let (student_pk, person_name, class_name) = if aid.contains("::") {
            let parts: Vec<&str> = aid.split("::").collect();
            let name = parts.last().cloned().unwrap_or(aid).to_string();
            let cls = if parts.len() >= 2 && parts[1] != "__SEM_TURMA__" { parts[1].to_string() } else { "Sem turma".to_string() };
            (aid.clone(), name, cls)
        } else {
            let pk = student_keys.get(aid).cloned().unwrap_or_default();
            let cls = student_classes.get(aid).cloned().unwrap_or_else(|| "Sem turma".to_string());
            (pk, aid.clone(), cls)
        };

        let mut fotos = Vec::new();
        if !student_pk.is_empty() {
            if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT foto_path FROM ocorrencias WHERE person_key = ?") {
                if let Ok(mut rows) = stmt.query([&student_pk]) {
                    while let Ok(Some(row)) = rows.next() {
                        if let Ok(p) = row.get::<_, String>(0) {
                            if !discarded_manual.contains(&p) {
                                fotos.push(p);
                            }
                        }
                    }
                }
            }
        } else {
            if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT foto_path FROM ocorrencias WHERE aluno_id = ?") {
                if let Ok(mut rows) = stmt.query([aid]) {
                    while let Ok(Some(row)) = rows.next() {
                        if let Ok(p) = row.get::<_, String>(0) {
                            if !discarded_manual.contains(&p) {
                                fotos.push(p);
                            }
                        }
                    }
                }
            }
        }

        let dest_dir = student_export_dir(&req.dest_path, &person_name, &class_name, req.organize_by_class);
        for f in fotos {
            let path = Path::new(&f);
            if path.exists() {
                worklist.push(WorkItem {
                    aluno_id: aid.clone(),
                    source_path: f.clone(),
                    dest_dir: dest_dir.clone(),
                });
                exported_paths.insert(f);
            }
        }
    }

    // 2. Cópia de fotos de referência (#BASE)
    // Coleta referências cadastradas na tabela alunos (face_cache_path)
    let mut ref_paths = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT face_cache_path FROM alunos WHERE face_cache_path IS NOT NULL AND face_cache_path != ''") {
        if let Ok(iterator) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for p in iterator.flatten() {
                ref_paths.push(p);
            }
        }
    }

    let base_dir = Path::new(&req.dest_path).join("#BASE");
    for f in ref_paths {
        let path = Path::new(&f);
        if path.exists() && !exported_paths.contains(&f) {
            worklist.push(WorkItem {
                aluno_id: "#BASE".to_string(),
                source_path: f.clone(),
                dest_dir: base_dir.clone(),
            });
            exported_paths.insert(f);
        }
    }

    // 3. Fotos descartadas manualmente se include_descarte for verdadeiro
    if req.include_descarte {
        let discard_dir = Path::new(&req.dest_path).join("DESCARTE");
        for f in &discarded_manual {
            let path = Path::new(f);
            if path.exists() && !exported_paths.contains(f) {
                worklist.push(WorkItem {
                    aluno_id: "#DESCARTE".to_string(),
                    source_path: f.clone(),
                    dest_dir: discard_dir.clone(),
                });
                exported_paths.insert(f.clone()); // f é uma referência, mas clonamos/copiamos no push
            }
        }

        // Fotos não identificadas ("Desconhecido" ou "Pessoa X")
        let mut photo_to_ids = HashMap::new();
        if let Ok(mut stmt) = conn.prepare("SELECT aluno_id, foto_path FROM ocorrencias") {
            if let Ok(iterator) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (aid, fpath) in iterator.flatten() {
                    photo_to_ids.entry(fpath).or_insert_with(Vec::new).push(aid);
                }
            }
        }

        for (fpath, ids) in photo_to_ids {
            let path = Path::new(&fpath);
            if !path.exists() || exported_paths.contains(&fpath) {
                continue;
            }
            let is_only_unidentified = ids.iter().all(|id_| {
                id_.is_empty() || id_ == "Desconhecido" || id_.starts_with("Pessoa ")
            });
            if is_only_unidentified {
                worklist.push(WorkItem {
                    aluno_id: "#DESCARTE".to_string(),
                    source_path: fpath.clone(),
                    dest_dir: discard_dir.clone(),
                });
                exported_paths.insert(fpath);
            }
        }
    }

    Ok(worklist)
}

fn get_export_output_filename(source_path: &str, req: &ExportReq) -> String {
    let path = Path::new(source_path);
    let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("image.jpg").to_string();
    if req.export_format.trim().to_lowercase() == "jpg" {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
        format!("{}.jpg", stem)
    } else {
        filename
    }
}

fn next_available_dest_file(folder: &Path, filename: &str) -> PathBuf {
    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("jpg");
    
    let mut n = 2;
    loop {
        let candidate = folder.join(format!("{}_{}.{}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

fn unique_dest_file(folder: &Path, filename: &str, strategy: &str) -> PathBuf {
    let dest = folder.join(filename);
    if strategy == "replace" || strategy == "overwrite" || strategy == "recreate" || strategy == "skip" {
        return dest;
    }
    if !dest.exists() {
        return dest;
    }
    next_available_dest_file(folder, filename)
}

// 3. Conversão de imagens para JPEG nativo usando a crate image
fn save_as_jpeg(source_path: &str, dest_path: &Path) -> Result<(), String> {
    let ext = Path::new(source_path).extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    
    // Formatos RAW de câmera profissional: realizamos cópia direta física em vez de carregar
    let raw_exts = ["cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw"];
    if raw_exts.contains(&ext.as_str()) {
        fs::copy(source_path, dest_path).map_err(|e| format!("Erro copiando RAW: {}", e))?;
        return Ok(());
    }

    // Se já for JPEG/JPG, apenas copiar (otimização massiva de I/O)
    if ext == "jpg" || ext == "jpeg" {
        fs::copy(source_path, dest_path).map_err(|e| format!("Erro copiando JPEG: {}", e))?;
        return Ok(());
    }

    // Outros formatos tradicionais (PNG, WEBP, BMP): abrir via crate image e salvar
    match image::open(source_path) {
        Ok(img) => {
            img.save_with_format(dest_path, image::ImageFormat::Jpeg)
                .map_err(|e| format!("Falha salvando JPEG: {}", e))?;
            Ok(())
        }
        Err(_) => {
            // Em caso de falha de carregamento, faz o fallback seguro para cópia física bruta
            fs::copy(source_path, dest_path).map_err(|e| format!("Erro na cópia de fallback: {}", e))?;
            Ok(())
        }
    }
}

fn format_duration(seconds: u64) -> String {
    let sec = seconds % 60;
    let min = (seconds / 60) % 60;
    let hours = seconds / 3600;
    if hours > 0 {
        format!("{}h {}m {}s", hours, min, sec)
    } else if min > 0 {
        format!("{}m {}s", min, sec)
    } else {
        format!("{}s", sec)
    }
}

fn count_image_files(dir: &Path) -> usize {
    if !dir.is_dir() {
        return 0;
    }
    let image_exts = ["jpg", "jpeg", "png", "webp", "cr2", "cr3", "nef", "arw", "dng", "raf", "orf"];
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    if image_exts.contains(&ext.to_lowercase().as_str()) {
                        count += 1;
                    }
                }
            } else if p.is_dir() {
                count += count_image_files(&p);
            }
        }
    }
    count
}

fn count_base_photos_from_catalog(catalog: &str) -> usize {
    let mut count = 0;
    if let Ok(conn) = db::establish_connection(catalog) {
        if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT foto_path FROM ocorrencias WHERE aluno_id = ? OR aluno_id LIKE ?") {
            if let Ok(mut rows) = stmt.query(["#BASE", "#BASE%"]) {
                let mut paths = HashSet::new();
                while let Ok(Some(row)) = rows.next() {
                    if let Ok(p) = row.get::<_, String>(0) {
                        paths.insert(p);
                    }
                }
                count += paths.len();
            }
        }
        
        // Também ler tabela alunos face_cache_path
        if let Ok(mut stmt) = conn.prepare("SELECT face_cache_path FROM alunos WHERE face_cache_path IS NOT NULL AND face_cache_path != ''") {
            if let Ok(iterator) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                let mut ref_paths = HashSet::new();
                for f in iterator.flatten() {
                    let dir_name = Path::new(&f).parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()).unwrap_or("").to_uppercase();
                    if ["REFERENCIA", "REFERÊNCIA", "REFERENCIAS", "REFERÊNCIAS", "BASE", "#BASE", "REF"].contains(&dir_name.as_str()) {
                        ref_paths.insert(f);
                    }
                }
                count += ref_paths.len();
            }
        }
    }
    count
}

// 4. Geração do relatório Excel (XLSX) na unha compactando XML no ZIP
fn write_xlsx_report<W: Write + Seek>(writer: W, summary_rows: &[Vec<String>], per_person_rows: &[Vec<String>]) -> Result<(), String> {
    let mut zip = ZipWriter::new(writer);
    
    zip.start_file::<_, ()>("[Content_Types].xml", FileOptions::default()).map_err(|e| e.to_string())?;
    zip.write_all(CONTENT_TYPES_XML.as_bytes()).map_err(|e| e.to_string())?;
    
    zip.start_file::<_, ()>("_rels/.rels", FileOptions::default()).map_err(|e| e.to_string())?;
    zip.write_all(ROOT_RELS_XML.as_bytes()).map_err(|e| e.to_string())?;
    
    zip.start_file::<_, ()>("xl/workbook.xml", FileOptions::default()).map_err(|e| e.to_string())?;
    zip.write_all(WORKBOOK_XML.as_bytes()).map_err(|e| e.to_string())?;
    
    zip.start_file::<_, ()>("xl/_rels/workbook.xml.rels", FileOptions::default()).map_err(|e| e.to_string())?;
    zip.write_all(WORKBOOK_RELS_XML.as_bytes()).map_err(|e| e.to_string())?;
    
    zip.start_file::<_, ()>("xl/worksheets/sheet1.xml", FileOptions::default()).map_err(|e| e.to_string())?;
    zip.write_all(xlsx_sheet_xml(summary_rows).as_bytes()).map_err(|e| e.to_string())?;
    
    zip.start_file::<_, ()>("xl/worksheets/sheet2.xml", FileOptions::default()).map_err(|e| e.to_string())?;
    zip.write_all(xlsx_sheet_xml(per_person_rows).as_bytes()).map_err(|e| e.to_string())?;
    
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn xlsx_sheet_xml(rows: &[Vec<String>]) -> String {
    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    xml.push_str("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\n");
    xml.push_str("<sheetData>\n");
    
    for (r_idx, row) in rows.iter().enumerate() {
        let r = r_idx + 1;
        xml.push_str(&format!("<row r=\"{}\">\n", r));
        for (c_idx, val) in row.iter().enumerate() {
            let col_name = xlsx_col_name(c_idx);
            let cell_ref = format!("{}{}", col_name, r);
            let escaped_val = html_escape(val);
            xml.push_str(&format!("<c r=\"{}\" t=\"inlineStr\"><is><t>{}</t></is></c>\n", cell_ref, escaped_val));
        }
        xml.push_str("</row>\n");
    }
    
    xml.push_str("</sheetData>\n");
    xml.push_str("</worksheet>");
    xml
}

fn xlsx_col_name(mut index: usize) -> String {
    let mut name = String::new();
    index += 1;
    while index > 0 {
        let (q, r) = ((index - 1) / 26, (index - 1) % 26);
        name.insert(0, (65 + r) as u8 as char);
        index = q;
    }
    name
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&apos;")
}

// 5. Geração do relatório PDF na unha gerando objetos binários PDF puros
fn write_simple_pdf(path: &Path, summary_rows: &[Vec<String>], per_person_rows: &[Vec<String>]) -> Result<(), String> {
    let max_pdf_rows = 150;
    let mut per_person_trimmed = per_person_rows.to_vec();
    if per_person_trimmed.len() > max_pdf_rows {
        let header = per_person_trimmed[0].clone();
        let data_rows = &per_person_trimmed[1..];
        let extra_count = data_rows.len() - (max_pdf_rows - 1);
        let mut truncated = vec![header];
        truncated.extend_from_slice(&data_rows[..max_pdf_rows - 1]);
        truncated.push(vec![
            format!("... e outros {} formandos no XLSX", extra_count),
            String::new(),
            String::new(),
        ]);
        per_person_trimmed = truncated;
    }

    let mut lines = vec![
        "FORMATURA PRO".to_string(),
        "RELATORIO DE EXPORTACAO".to_string(),
        String::new(),
    ];
    
    for row in &summary_rows[1..] {
        if row.len() >= 2 {
            lines.push(format!("{}: {}", row[0], row[1]));
        }
    }
    
    lines.push(String::new());
    lines.push("FORMANDOS".to_string());
    lines.push("ID Formando   | Pasta Destino    | Qtd Fotos".to_string());
    
    for row in &per_person_trimmed[1..] {
        if row.len() >= 3 {
            lines.push(format!("{:14} | {:17} | {:>9}", row[0], row[1], row[2]));
        }
    }

    let page_chunks: Vec<&[String]> = lines.chunks(46).collect();
    let mut objects: Vec<String> = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        String::new(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    
    let mut page_refs = Vec::new();
    
    for chunk in page_chunks {
        let mut content = String::new();
        let mut y = 800;
        for line in chunk {
            let size = if line == "FORMATURA PRO" {
                18
            } else if line.starts_with("RELATORIO") {
                12
            } else {
                9
            };
            content.push_str(&pdf_text_line(42, y, line, size));
            y -= 16;
        }
        
        let content_bytes = content.as_bytes();
        let content_obj_num = objects.len() + 1;
        objects.push(format!("<< /Length {} >>\nstream\n{}endstream", content_bytes.len(), content));
        
        let page_obj_num = objects.len() + 1;
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
            content_obj_num
        ));
        page_refs.push(format!("{} 0 R", page_obj_num));
    }
    
    objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", page_refs.join(" "), page_refs.len());
    
    let mut pdf_data = Vec::new();
    pdf_data.extend_from_slice(b"%PDF-1.4\n");
    
    let mut offsets = Vec::new();
    for (idx, obj) in objects.iter().enumerate() {
        offsets.push(pdf_data.len());
        let obj_str = format!("{} 0 obj\n{}\nendobj\n", idx + 1, obj);
        pdf_data.extend_from_slice(obj_str.as_bytes());
    }
    
    let xref_pos = pdf_data.len();
    pdf_data.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        pdf_data.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
    }
    
    pdf_data.extend_from_slice(format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF",
        objects.len() + 1,
        xref_pos
    ).as_bytes());
    
    fs::write(path, pdf_data).map_err(|e| e.to_string())?;
    Ok(())
}

fn pdf_text_line(x: i32, y: i32, text: &str, size: i32) -> String {
    let max_len = 115;
    let safe_text = if text.len() > max_len { &text[..max_len] } else { text };
    format!("BT /F1 {} Tf {} {} Td ({}) Tj ET\n", size, x, y, pdf_escape(safe_text))
}

fn pdf_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
     .replace('(', "\\(")
     .replace(')', "\\)")
}

// 6. Limpeza prévia para a estratégia de "Recriar destino"
fn prepare_recreate_destination(dest_path: &str, strategy: &str) {
    if strategy != "recreate" {
        return;
    }
    let p = Path::new(dest_path);
    if !p.is_dir() {
        return;
    }
    if let Ok(entries) = fs::read_dir(p) {
        for entry in entries.flatten() {
            let target = entry.path();
            if target.is_dir() {
                fs::remove_dir_all(target).ok();
            } else {
                fs::remove_file(target).ok();
            }
        }
    }
}

// 7. Implementação do Worker e Threads de Exportação
fn run_export_worker(
    req: ExportReq,
    catalog_name: String,
    app_handle: tauri::AppHandle,
) {
    let state = app_handle.state::<ExportState>();
    // 1. Atualiza estado inicial
    let export_uuid = uuid::Uuid::new_v4().to_string();
    {
        let mut status = state.status.lock().unwrap();
        status.is_exporting = true;
        status.progress = 0.0;
        status.status_text = "Preparando diretórios...".to_string();
        status.total_files = 0;
        status.processed_files = 0;
        status.eta_seconds = 0;
        status.export_summary = None;
        status.export_dir = req.dest_path.clone();
        status.export_id = export_uuid.clone();
    }

    // Cria a pasta de destino
    let dest_path_buf = PathBuf::from(&req.dest_path);
    fs::create_dir_all(&dest_path_buf).ok();
    
    // Aplica a estratégia recreate se aplicável
    prepare_recreate_destination(&req.dest_path, &req.conflict_strategy);

    let conn_res = db::establish_connection(&catalog_name);
    let conn = match conn_res {
        Ok(c) => c,
        Err(e) => {
            let mut status = state.status.lock().unwrap();
            status.is_exporting = false;
            status.status_text = format!("Erro ao abrir banco de dados: {}", e);
            return;
        }
    };

    // Constrói a lista de arquivos de exportação
    let worklist = match build_export_worklist(&conn, &req) {
        Ok(wl) => wl,
        Err(e) => {
            let mut status = state.status.lock().unwrap();
            status.is_exporting = false;
            status.status_text = format!("Erro construindo lista: {}", e);
            return;
        }
    };

    let total = worklist.len();
    if total == 0 {
        let mut status = state.status.lock().unwrap();
        status.is_exporting = false;
        status.status_text = "Nenhuma foto selecionada para exportar!".to_string();
        return;
    }

    {
        let mut status = state.status.lock().unwrap();
        status.total_files = total;
        status.status_text = "Copiando mídias...".to_string();
    }

    // Cria as pastas de destino físicas para evitar I/O redundante em threads
    let export_base = dest_path_buf.join("Exportação");
    fs::create_dir_all(&export_base).ok();

    for item in &worklist {
        fs::create_dir_all(&item.dest_dir).ok();
    }

    // Histórico de progresso e estatísticas
    let start_time = Instant::now();
    let file_report_rows = vec![vec![
        "Formando/Pasta".to_string(),
        "Arquivo".to_string(),
        "Origem".to_string(),
        "Destino".to_string(),
        "Status".to_string(),
    ]];

    // Thread pool concorrente leve usando threads controladas
    let worklist_arc = Arc::new(worklist);
    let req_arc = Arc::new(req.clone());
    let state_lock = Arc::new(Mutex::new((
        0, 
        Vec::<String>::new(), 
        HashSet::<String>::new(), 
        HashMap::<String, usize>::new(), 
        file_report_rows
    )));

    let mut thread_handles = Vec::new();
    let num_threads = 6; // Balanceamento ideal entre I/O e concorrência

    for t_id in 0..num_threads {
        let wl = Arc::clone(&worklist_arc);
        let rq = Arc::clone(&req_arc);
        let lock = Arc::clone(&state_lock);
        let app_handle_clone = app_handle.clone();

        let handle = std::thread::spawn(move || {
            let chunk_size = (wl.len() + num_threads - 1) / num_threads;
            let start = t_id * chunk_size;
            let end = std::cmp::min(start + chunk_size, wl.len());

            for idx in start..end {
                // Checa cancelamento voluntário
                {
                    let export_state = app_handle_clone.state::<ExportState>();
                    let status = export_state.status.lock().unwrap();
                    if !status.is_exporting {
                        break;
                    }
                }

                let item = &wl[idx];
                let output_filename = get_export_output_filename(&item.source_path, &rq);
                let dest_file = unique_dest_file(&item.dest_dir, &output_filename, &rq.conflict_strategy);

                let status;
                let mut success = true;

                // Aplica regras de pular arquivo se for skip/incremental
                if (rq.conflict_strategy == "skip" || rq.conflict_strategy == "incremental") && dest_file.exists() {
                    status = "Ignorado (existe)".to_string();
                    success = false;
                } else {
                    let export_format = rq.export_format.trim().to_lowercase();
                    if export_format == "jpg" {
                        let ext = Path::new(&item.source_path).extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                        if ext == "jpg" || ext == "jpeg" {
                            if fs::copy(&item.source_path, &dest_file).is_ok() {
                                status = "Copiado JPG".to_string();
                            } else {
                                status = "Erro na cópia".to_string();
                                success = false;
                            }
                        } else {
                            if save_as_jpeg(&item.source_path, &dest_file).is_ok() {
                                status = "Convertido JPG".to_string();
                            } else {
                                status = "Erro na conversão".to_string();
                                success = false;
                            }
                        }
                    } else {
                        // Modo de mover arquivos físicos ou cópia padrão
                        if rq.mode == "move" && item.aluno_id != "#BASE" {
                            if fs::rename(&item.source_path, &dest_file).is_ok() {
                                status = "Movido".to_string();
                            } else {
                                if fs::copy(&item.source_path, &dest_file).is_ok() {
                                    fs::remove_file(&item.source_path).ok();
                                    status = "Movido (cópia)".to_string();
                                } else {
                                    status = "Erro ao mover".to_string();
                                    success = false;
                                }
                            }
                        } else {
                            if fs::copy(&item.source_path, &dest_file).is_ok() {
                                status = "Copiado".to_string();
                            } else {
                                status = "Erro na cópia".to_string();
                                success = false;
                            }
                        }
                    }
                }

                // Atualiza o progresso global com segurança
                {
                    let mut data = lock.lock().unwrap();
                    data.0 += 1; // processed count
                    let processed = data.0;
                    
                    if success {
                        data.1.push(dest_file.to_string_lossy().to_string());
                        data.2.insert(item.dest_dir.to_string_lossy().to_string());
                        if item.aluno_id != "#BASE" && item.aluno_id != "#DESCARTE" {
                            *data.3.entry(item.aluno_id.clone()).or_insert(0) += 1;
                        }
                    }

                    data.4.push(vec![
                        item.aluno_id.clone(),
                        output_filename,
                        item.source_path.clone(),
                        dest_file.to_string_lossy().to_string(),
                        status,
                    ]);

                    // Notifica progresso ao Tauri a cada 5 arquivos
                    if processed % 5 == 0 || processed == wl.len() {
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let avg = elapsed / (processed as f64);
                        let eta = (avg * ((wl.len() - processed) as f64)) as u64;
                        let progress = ((processed as f32) / (wl.len() as f32)) * 100.0;

                        let export_state = app_handle_clone.state::<ExportState>();
                        let mut status_state = export_state.status.lock().unwrap();
                        status_state.processed_files = processed;
                        status_state.eta_seconds = eta;
                        status_state.progress = (progress * 10.0).round() / 10.0;
                    }
                }
            }
        });
        thread_handles.push(handle);
    }

    for h in thread_handles {
        h.join().ok();
    }

    // Extrai os resultados consolidados
    let state_data = Arc::into_inner(state_lock).unwrap().into_inner().unwrap();
    let processed_files_total = state_data.0;
    let files_copied = state_data.1;
    let folders_exported_set = state_data.2;
    let counts_per_person = state_data.3;
    let _report_file_rows = state_data.4;

    let elapsed_total = start_time.elapsed().as_secs();

    // 8. Grava histórico na tabela do SQLite
    let folders_json = serde_json::to_string(&folders_exported_set.iter().cloned().collect::<Vec<String>>()).unwrap_or_else(|_| "[]".to_string());
    let files_json = serde_json::to_string(&files_copied).unwrap_or_else(|_| "[]".to_string());
    let timestamp_str = DateTime::<Local>::from(SystemTime::now()).to_rfc3339();

    conn.execute(
        "INSERT INTO export_history (uuid, dest_path, mode, files_json, folders_json, timestamp) 
         VALUES (?, ?, ?, ?, ?, ?)",
        (&export_uuid, &req.dest_path, &req.mode, &files_json, &folders_json, &timestamp_str),
    ).ok();

    // 9. Constrói e salva os relatórios Excel (XLSX) e PDF
    let report_xlsx_path = export_base.join("Relatorio_Exportacao_FormaturaPRO.xlsx");
    let report_pdf_path = export_base.join("Relatorio_Exportacao_FormaturaPRO.pdf");

    let base_photos_total = count_base_photos_from_catalog(&catalog_name);

    let mut per_person_rows = vec![vec![
        "ID Formando".to_string(),
        "Pasta Destino".to_string(),
        "Qtd Fotos".to_string(),
    ]];

    // Ordenar formandos alfabeticamente
    let mut sorted_aids: Vec<&String> = counts_per_person.keys().collect();
    sorted_aids.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));

    for aid in sorted_aids {
        let dest_dir = student_export_dir(&req.dest_path, aid, "", req.organize_by_class);
        let display_name = clean_student_id(aid);
        let folder_display = dest_dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| display_name.clone());
        
        let actual_count = count_image_files(&dest_dir);
        per_person_rows.push(vec![
            display_name,
            folder_display,
            actual_count.to_string(),
        ]);
    }

    let summary_rows = vec![
        vec!["Relatorio de Exportacao".to_string(), String::new()],
        vec!["Catalogo".to_string(), catalog_name],
        vec!["Data/Hora".to_string(), DateTime::<Local>::from(SystemTime::now()).format("%d/%m/%Y %H:%M:%S").to_string()],
        vec!["Formato".to_string(), if req.export_format.trim().to_lowercase() == "jpg" { "JPEG convertido".to_string() } else { "Original".to_string() }],
        vec!["Fotos Exportadas".to_string(), processed_files_total.to_string()],
        vec!["Fotos Base".to_string(), base_photos_total.to_string()],
        vec!["Pastas Criadas".to_string(), folders_exported_set.len().to_string()],
        vec!["Tempo Total".to_string(), format_duration(elapsed_total)],
        vec!["Destino".to_string(), req.dest_path.clone()],
    ];

    // Excel
    if let Ok(xlsx_file) = fs::File::create(&report_xlsx_path) {
        write_xlsx_report(xlsx_file, &summary_rows, &per_person_rows).ok();
    }

    // PDF
    write_simple_pdf(&report_pdf_path, &summary_rows, &per_person_rows).ok();

    let summary = ExportSummary {
        export_id: export_uuid.clone(),
        export_dir: req.dest_path.clone(),
        pdf_path: report_pdf_path.to_string_lossy().to_string(),
        dest_path: req.dest_path.clone(),
        report_path: report_xlsx_path.to_string_lossy().to_string(),
        pdf_report_path: report_pdf_path.to_string_lossy().to_string(),
        time_seconds: elapsed_total,
        time_str: format_duration(elapsed_total),
        folder_count: folders_exported_set.len(),
        photo_count: processed_files_total,
        mode: req.mode.clone(),
        export_format: req.export_format.clone(),
    };

    // Finaliza o estado
    {
        let mut status = state.status.lock().unwrap();
        status.is_exporting = false;
        status.progress = 100.0;
        status.status_text = "Exportação concluída com sucesso!".to_string();
        status.export_summary = Some(summary);
        status.pdf_path = report_pdf_path.to_string_lossy().to_string();
    }
}

// 8. Commands do Tauri no Rust expostos

#[tauri::command]
pub fn check_export_conflicts(
    req: ExportReq,
    state: State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let catalog = state.current_catalog.lock().unwrap().clone();
    if catalog.is_empty() {
        return Err("Nenhum catalogo ativo".to_string());
    }
    
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Conexao SQLite falhou: {}", e))?;
        
    let worklist = build_export_worklist(&conn, &req)?;
    let mut conflicts = Vec::new();
    
    for item in &worklist {
        let output_filename = get_export_output_filename(&item.source_path, &req);
        let dest_file = unique_dest_file(&item.dest_dir, &output_filename, &req.conflict_strategy);
        if dest_file.exists() {
            conflicts.push(serde_json::json!({
                "aluno_id": item.aluno_id,
                "source": item.source_path,
                "dest": dest_file.to_string_lossy(),
                "name": output_filename,
            }));
        }
    }
    
    // Checa conflito também do arquivo de relatórios
    let export_base = Path::new(&req.dest_path).join("Exportação");
    let xlsx_report = export_base.join("Relatorio_Exportacao_FormaturaPRO.xlsx");
    let pdf_report = export_base.join("Relatorio_Exportacao_FormaturaPRO.pdf");
    
    if xlsx_report.exists() {
        conflicts.push(serde_json::json!({
            "aluno_id": "Relatorio",
            "source": "",
            "dest": xlsx_report.to_string_lossy(),
            "name": "Relatorio_Exportacao_FormaturaPRO.xlsx",
        }));
    }
    
    if pdf_report.exists() {
        conflicts.push(serde_json::json!({
            "aluno_id": "Relatorio",
            "source": "",
            "dest": pdf_report.to_string_lossy(),
            "name": "Relatorio_Exportacao_FormaturaPRO.pdf",
        }));
    }
    
    Ok(serde_json::json!({
        "has_conflicts": !conflicts.is_empty(),
        "count": conflicts.len(),
        "samples": conflicts.into_iter().take(8).collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn export_quality(
    req: ExportReq,
    state: State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let catalog = state.current_catalog.lock().unwrap().clone();
    if catalog.is_empty() {
        return Err("Nenhum catalogo ativo".to_string());
    }
    
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Conexao SQLite falhou: {}", e))?;
        
    let worklist = build_export_worklist(&conn, &req)?;
    
    let selected_ids: HashSet<String> = req.ids.iter().cloned().collect();
    
    let mut photo_paths = HashSet::new();
    let mut discard_paths = HashSet::new();
    let mut folders_with_photos = HashSet::new();
    let mut person_photo_counts = HashMap::new();
    
    for item in &worklist {
        let path = Path::new(&item.source_path);
        if path.exists() {
            if item.aluno_id == "#DESCARTE" {
                discard_paths.insert(item.source_path.clone());
            } else {
                photo_paths.insert(item.source_path.clone());
                folders_with_photos.insert(item.aluno_id.clone());
                *person_photo_counts.entry(item.aluno_id.clone()).or_insert(0) += 1;
            }
        }
    }
    
    let mut empty_folders = Vec::new();
    let mut low_photo_folders = Vec::new();
    
    for aid in &selected_ids {
        let count = person_photo_counts.get(aid).cloned().unwrap_or(0);
        if count == 0 {
            empty_folders.push(aid.clone());
        } else if count <= 2 {
            low_photo_folders.push(serde_json::json!({
                "id": aid,
                "photos": count
            }));
        }
    }
    
    empty_folders.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    
    // Contagem rápida de fotos borradas e olhos fechados do catálogo
    let mut blurry_count = 0;
    let mut attention_count = 0;
    let mut closed_eyes_count = 0;
    let mut unknown_photo_count = 0;
    
    if req.include_quality && !photo_paths.is_empty() {
        let paths_vec: Vec<String> = photo_paths.iter().cloned().collect();
        // SQL Chunking para evitar erro de limites de variáveis no rusqlite
        for chunk in paths_vec.chunks(900) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT blur_status, MAX(closed_eyes) as has_closed_eyes, aluno_id, foto_path 
                 FROM ocorrencias 
                 WHERE foto_path IN ({})
                 GROUP BY foto_path",
                placeholders
            );
            
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let params = rusqlite::params_from_iter(chunk);
            let mut rows = stmt.query(params).map_err(|e| e.to_string())?;
            
            while let Ok(Some(row)) = rows.next() {
                let blur_status: String = row.get(0).unwrap_or_default();
                let has_closed: i32 = row.get(1).unwrap_or(0);
                let aid: String = row.get(2).unwrap_or_default();
                
                if blur_status == "blurry" {
                    blurry_count += 1;
                } else if blur_status == "attention" {
                    attention_count += 1;
                }
                
                if has_closed > 0 {
                    closed_eyes_count += 1;
                }
                
                if aid.is_empty() || aid == "Desconhecido" || aid.starts_with("Pessoa ") {
                    unknown_photo_count += 1;
                }
            }
        }
    }
    
    Ok(serde_json::json!({
        "catalog": catalog,
        "selected_folders": selected_ids.len(),
        "folders_with_photos": folders_with_photos.len(),
        "empty_folders": empty_folders.len(),
        "empty_folder_samples": empty_folders.into_iter().take(8).collect::<Vec<_>>(),
        "low_photo_folders": low_photo_folders.into_iter().take(8).collect::<Vec<_>>(),
        "total_photos": photo_paths.len(),
        "discarded_photos": discard_paths.len(),
        "unknown_photos": unknown_photo_count,
        "blurry_photos": blurry_count,
        "attention_photos": attention_count,
        "closed_eyes_photos": closed_eyes_count,
        "blur_limited": false,
        "quality_skipped": !req.include_quality,
    }))
}

#[tauri::command]
pub fn start_export(
    req: ExportReq,
    state: State<'_, db::DbState>,
    export_state: State<'_, ExportState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let catalog = state.current_catalog.lock().unwrap().clone();
    if catalog.is_empty() {
        return Err("Nenhum catalogo ativo".to_string());
    }
    
    {
        let status = export_state.status.lock().unwrap();
        if status.is_exporting {
            return Err("Ja existe uma exportacao em andamento".to_string());
        }
    }
    
    // Roda a exportação em segundo plano numa thread Tokio
    let app_handle_clone = app_handle.clone();
    
    std::thread::spawn(move || {
        run_export_worker(req, catalog, app_handle_clone);
    });
    
    Ok(serde_json::json!({ "status": "started" }))
}

#[tauri::command]
pub fn get_export_status(
    export_state: State<'_, ExportState>,
) -> Result<serde_json::Value, String> {
    let status = export_state.status.lock().unwrap();
    Ok(serde_json::to_value(&*status).unwrap_or(serde_json::json!({})))
}

#[tauri::command]
pub fn clear_export_summary(
    export_state: State<'_, ExportState>,
) -> Result<serde_json::Value, String> {
    let mut status = export_state.status.lock().unwrap();
    status.export_summary = None;
    status.progress = 0.0;
    status.processed_files = 0;
    status.total_files = 0;
    status.eta_seconds = 0;
    status.export_id = String::new();
    status.status_text = "Ocioso".to_string();
    Ok(serde_json::json!({ "status": "ok" }))
}

#[tauri::command]
pub fn get_export_history(
    state: State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let catalog = state.current_catalog.lock().unwrap().clone();
    if catalog.is_empty() {
        return Err("Nenhum catalogo ativo".to_string());
    }
    
    let conn = db::establish_connection(&catalog)
        .map_err(|e| format!("Conexao SQLite falhou: {}", e))?;
        
    let mut stmt = conn
        .prepare("SELECT uuid, dest_path, mode, folders_json, files_json, timestamp FROM export_history ORDER BY created_at DESC LIMIT 50")
        .map_err(|e| e.to_string())?;
        
    let rows = stmt.query_map([], |row| {
        let uuid: String = row.get(0)?;
        let dest_path: String = row.get(1)?;
        let mode: String = row.get(2)?;
        let folders_json: String = row.get(3)?;
        let files_json: String = row.get(4)?;
        let timestamp: String = row.get(5)?;
        
        let folders: Vec<String> = serde_json::from_str(&folders_json).unwrap_or_default();
        let files: Vec<String> = serde_json::from_str(&files_json).unwrap_or_default();
        
        // Data formatada legível no formato DD/MM/AAAA HH:MM:SS
        let formatted_date = if let Ok(dt) = DateTime::parse_from_rfc3339(&timestamp) {
            let local_dt: DateTime<Local> = dt.into();
            local_dt.format("%d/%m/%Y %H:%M:%S").to_string()
        } else {
            timestamp.clone()
        };
        
        // Sumário técnico formatado compatível com o histórico de JSON
        Ok(serde_json::json!({
            "export_id": uuid,
            "dest_path": dest_path,
            "export_dir": dest_path,
            "mode": mode,
            "folder_count": folders.len(),
            "photo_count": files.len(),
            "time_str": "Concluído",
            "created_at": formatted_date,
            "report_path": "",
            "pdf_report_path": "",
        }))
    }).map_err(|e| e.to_string())?;
    
    let history: Vec<serde_json::Value> = rows.flatten().collect();
    
    Ok(serde_json::json!({
        "history": history
    }))
}
