use std::path::{Path, PathBuf};
use std::fs;
use std::time::UNIX_EPOCH;
use sha1::{Sha1, Digest};
use std::io::BufWriter;
use std::fs::File;
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
use exif::{Reader, Tag, Value};

pub fn get_thumb_cache_dir() -> PathBuf {
    // 1. Em desenvolvimento, checar caminhos relativos ao workspace do Tauri
    // PRIORIDADE: Primeiro o diretório local ativo ("backend/thumb_cache") para evitar pegar pastas de backups/versões antigas no nível superior
    let dev_path_alt = PathBuf::from("backend/thumb_cache");
    if dev_path_alt.exists() {
        return dev_path_alt;
    }
    let dev_path = PathBuf::from("../backend/thumb_cache");
    if dev_path.exists() {
        return dev_path;
    }
    
    // 2. Em produção, usar LocalAppData
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("Formatura PRO").join("thumb_cache");
        fs::create_dir_all(&p).ok();
        p
    } else {
        let p = PathBuf::from(".").join("thumb_cache");
        fs::create_dir_all(&p).ok();
        p
    }
}

pub fn get_cached_thumb_path(decoded_path: &str, kind: &str, params: &[&str]) -> Result<PathBuf, String> {
    let path = Path::new(decoded_path);
    if !path.exists() {
        return Err("Arquivo original nao encontrado".to_string());
    }
    
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = metadata.modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    
    let size = metadata.len();
    
    // Constrói a chave identificadora idêntica ao Python
    // key = kind | decoded_path | mtime_ns | size | param1 | param2 ...
    let mut parts = vec![kind.to_string(), decoded_path.to_string(), mtime.to_string(), size.to_string()];
    for p in params {
        parts.push(p.to_string());
    }
    
    let key = parts.join("|");
    
    // Hash SHA1 do key
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    let result = hasher.finalize();
    let filename = format!("{:x}.jpg", result);
    
    Ok(get_thumb_cache_dir().join(filename))
}

pub fn read_image_orientation(path: &Path) -> u32 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut bufreader = std::io::BufReader::new(file);
    let reader = Reader::new();
    if let Ok(exif_data) = reader.read_from_container(&mut bufreader) {
        if let Some(field) = exif_data.get_field(Tag::Orientation, exif::In::PRIMARY) {
            match field.value {
                Value::Short(ref v) if !v.is_empty() => return v[0] as u32,
                _ => {}
            }
        }
    }
    1
}

pub fn load_image_with_orientation(path: &Path) -> Result<DynamicImage, String> {
    let mut img = image::open(path).map_err(|e| format!("Erro ao abrir imagem: {}", e))?;
    let orientation = read_image_orientation(path);
    
    // Corrige orientação EXIF
    img = match orientation {
        3 => img.rotate180(),
        6 => img.rotate90(),
        8 => img.rotate270(),
        _ => img,
    };
    
    Ok(img)
}

pub fn generate_image_thumb(input_path: &str, output_path: &str, size: u32, quality: u8) -> Result<(), String> {
    let path = Path::new(input_path);
    let img = load_image_with_orientation(path)?;
    
    // Redimensiona mantendo proporção de aspecto (Triangle rápido de excelente qualidade)
    let resized = img.resize(size, size, image::imageops::FilterType::Triangle);
    
    // Codifica em JPEG com a qualidade definida
    let file = File::create(output_path).map_err(|e| e.to_string())?;
    let ref mut w = BufWriter::new(file);
    let mut encoder = JpegEncoder::new_with_quality(w, quality);
    encoder.encode_image(&resized).map_err(|e| e.to_string())?;
    
    Ok(())
}

pub fn generate_face_thumb(
    input_path: &str,
    output_path: &str,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    size: u32,
    expand: f32,
    quality: u8,
) -> Result<(), String> {
    let path = Path::new(input_path);
    let img = load_image_with_orientation(path)?;
    
    let img_w = img.width() as f32;
    let img_h = img.height() as f32;
    
    // Cálculo do bounding box expandido para o rosto
    let w = (x2 - x1) as f32;
    let h = (y2 - y1) as f32;
    let cx = x1 as f32 + w / 2.0;
    let cy = y1 as f32 + h / 2.0;
    
    let side = w.max(h);
    let new_side = side * (1.0 + expand);
    
    let new_x1 = (cx - new_side / 2.0).max(0.0);
    let new_y1 = (cy - new_side / 2.0).max(0.0);
    
    let crop_x = new_x1.min(img_w) as u32;
    let crop_y = new_y1.min(img_h) as u32;
    let crop_w = (new_side.min(img_w - crop_x as f32)) as u32;
    let crop_h = (new_side.min(img_h - crop_y as f32)) as u32;
    
    if crop_w == 0 || crop_h == 0 {
        return Err("Caixa de corte nula ou invalida".to_string());
    }
    
    let cropped = img.crop_imm(crop_x, crop_y, crop_w, crop_h);
    let resized = cropped.resize(size, size, image::imageops::FilterType::Triangle);
    
    // Codifica em JPEG
    let file = File::create(output_path).map_err(|e| e.to_string())?;
    let ref mut w = BufWriter::new(file);
    let mut encoder = JpegEncoder::new_with_quality(w, quality);
    encoder.encode_image(&resized).map_err(|e| e.to_string())?;
    
    Ok(())
}
