use std::path::PathBuf;
use std::time::Instant;
use ndarray::{Array4, Array3, Ix3};
use image::DynamicImage;
use ort::{session::Session, inputs, value::Value, ep};

pub const REFERENCE_LANDMARKS: [(f32, f32); 5] = [
    (38.2946, 51.6963), // Olho esquerdo
    (73.5318, 51.5014), // Olho direito
    (56.0252, 71.7366), // Nariz
    (41.5493, 92.3655), // Canto esquerdo da boca
    (70.7299, 92.2041), // Canto direito da boca
];

#[derive(Clone, Debug)]
pub struct DetectedFace {
    pub bbox: (f32, f32, f32, f32), // (x1, y1, x2, y2)
    pub score: f32,
    pub kps: [(f32, f32); 5],
}

pub struct FaceEngine {
    detection_session: Option<Session>,
    recognition_session: Option<Session>,
}

impl FaceEngine {
    fn load_detection_session() -> Result<Session, String> {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "Nao foi possivel determinar a pasta Home do usuario".to_string())?;
            
        let base_dir = PathBuf::from(home)
            .join(".insightface")
            .join("models")
            .join("buffalo_l");
            
        let det_path = base_dir.join("det_10g.onnx");
        
        if !det_path.exists() {
            return Err(format!("Modelo de deteccao nao encontrado em: {:?}", det_path));
        }
        
        Session::builder()
            .map_err(|e| format!("Erro ao criar builder para det_10g: {}", e))?
            .with_execution_providers([
                ep::DirectML::default().build(),
                ep::CPU::default().build(),
            ])
            .map_err(|e| format!("Falha ao configurar providers para det_10g: {}", e))?
            .commit_from_file(&det_path)
            .map_err(|e| format!("Falha ao carregar det_10g.onnx: {}", e))
    }

    fn load_recognition_session() -> Result<Session, String> {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "Nao foi possivel determinar a pasta Home do usuario".to_string())?;
            
        let base_dir = PathBuf::from(home)
            .join(".insightface")
            .join("models")
            .join("buffalo_l");
            
        let rec_path = base_dir.join("w600k_r50.onnx");
        
        if !rec_path.exists() {
            return Err(format!("Modelo de reconhecimento nao encontrado em: {:?}", rec_path));
        }
        
        Session::builder()
            .map_err(|e| format!("Erro ao criar builder para w600k_r50: {}", e))?
            .with_execution_providers([
                ep::DirectML::default().build(),
                ep::CPU::default().build(),
            ])
            .map_err(|e| format!("Falha ao configurar providers para w600k_r50: {}", e))?
            .commit_from_file(&rec_path)
            .map_err(|e| format!("Falha ao carregar w600k_r50.onnx: {}", e))
    }

    pub fn new() -> Result<Self, String> {
        log::info!("Inicializando FaceEngine com carregamento antecipado das sessoes de IA...");
        let det_session = Self::load_detection_session()?;
        let rec_session = Self::load_recognition_session()?;
            
        Ok(FaceEngine {
            detection_session: Some(det_session),
            recognition_session: Some(rec_session),
        })
    }

    pub fn unload(&mut self) {
        log::info!("Descarregando sessoes do ONNX Runtime no FaceEngine (liberando VRAM/RAM)...");
        self.detection_session = None;
        self.recognition_session = None;
    }

    fn ensure_detection_session(&mut self) -> Result<&mut Session, String> {
        if self.detection_session.is_none() {
            log::info!("Carregando sessao de deteccao SCRFD sob demanda (lazy loading)...");
            let session = Self::load_detection_session()?;
            self.detection_session = Some(session);
        }
        Ok(self.detection_session.as_mut().unwrap())
    }

    fn ensure_recognition_session(&mut self) -> Result<&mut Session, String> {
        if self.recognition_session.is_none() {
            log::info!("Carregando sessao de reconhecimento ArcFace sob demanda (lazy loading)...");
            let session = Self::load_recognition_session()?;
            self.recognition_session = Some(session);
        }
        Ok(self.recognition_session.as_mut().unwrap())
    }

    pub fn detect_faces(&mut self, img: &DynamicImage, score_threshold: f32) -> Result<Vec<DetectedFace>, String> {
        let orig_w = img.width() as f32;
        let orig_h = img.height() as f32;
        
        // 1. Pre-processamento SCRFD: normaliza e monta tensor [1, 3, 640, 640]
        let input_tensor = preprocess_scrfd(img);
        
        // Cria o Value do ONNX Runtime explicitamente para evitar erros de trait From
        let input_value = Value::from_array(input_tensor)
            .map_err(|e| format!("Erro ao criar valor de tensor de entrada: {}", e))?;
        
        // Garante que a sessao de deteccao esta ativa
        let session = self.ensure_detection_session()?;

        // 2. Inferencia de deteccao
        let outputs = session.run(inputs![input_value])
            .map_err(|e| format!("Erro ao rodar deteccao SCRFD: {}", e))?;
            
        // 3. Mapeamento de outputs ONNX por shapes (imune a variacoes de nomes de nos)
        struct ScrfdOutputViews {
            scores_8: Option<Array3<f32>>,
            bboxes_8: Option<Array3<f32>>,
            kpss_8: Option<Array3<f32>>,
            scores_16: Option<Array3<f32>>,
            bboxes_16: Option<Array3<f32>>,
            kpss_16: Option<Array3<f32>>,
            scores_32: Option<Array3<f32>>,
            bboxes_32: Option<Array3<f32>>,
            kpss_32: Option<Array3<f32>>,
        }
        
        let mut views = ScrfdOutputViews {
            scores_8: None, bboxes_8: None, kpss_8: None,
            scores_16: None, bboxes_16: None, kpss_16: None,
            scores_32: None, bboxes_32: None, kpss_32: None,
        };
        
        for value in outputs.values() {
            let tensor_d: ndarray::ArrayViewD<'_, f32> = value.try_extract_array::<f32>()
                .map_err(|e: ort::Error| format!("Erro ao extrair array do tensor: {}", e))?;
            let shape = tensor_d.shape();
            if shape.len() == 3 && shape[0] == 1 {
                let n = shape[1];
                let d = shape[2];
                
                // .to_owned() resolve lifetimes copiando os dados locais do tensor para a struct views
                let view = tensor_d.into_dimensionality::<Ix3>()
                    .map_err(|e: ndarray::ShapeError| format!("Erro de dimensionalidade do array: {}", e))?
                    .to_owned();
                
                match (n, d) {
                    (12800, 1) => views.scores_8 = Some(view),
                    (12800, 4) => views.bboxes_8 = Some(view),
                    (12800, 10) => views.kpss_8 = Some(view),
                    
                    (3200, 1) => views.scores_16 = Some(view),
                    (3200, 4) => views.bboxes_16 = Some(view),
                    (3200, 10) => views.kpss_16 = Some(view),
                    
                    (800, 1) => views.scores_32 = Some(view),
                    (800, 4) => views.bboxes_32 = Some(view),
                    (800, 10) => views.kpss_32 = Some(view),
                    _ => {}
                }
            }
        }
        
        let mut candidates = Vec::new();
        
        // 4. Decodifica candidatos por strides
        let strides = [(8, 80, 80), (16, 40, 40), (32, 20, 20)];
        for &(stride, gh, gw) in &strides {
            let (scores_opt, bboxes_opt, kpss_opt) = match stride {
                8 => (views.scores_8.as_ref(), views.bboxes_8.as_ref(), views.kpss_8.as_ref()),
                16 => (views.scores_16.as_ref(), views.bboxes_16.as_ref(), views.kpss_16.as_ref()),
                32 => (views.scores_32.as_ref(), views.bboxes_32.as_ref(), views.kpss_32.as_ref()),
                _ => continue,
            };
            
            if let (Some(scores), Some(bboxes), Some(kpss)) = (scores_opt, bboxes_opt, kpss_opt) {
                let mut idx = 0;
                for h in 0..gh {
                    for w in 0..gw {
                        let anchor_x = (w as f32) * (stride as f32);
                        let anchor_y = (h as f32) * (stride as f32);
                        
                        for _ in 0..2 { // 2 ancoras por local
                            let score = scores[[0, idx, 0]];
                            if score >= score_threshold {
                                let dist_l = bboxes[[0, idx, 0]] * (stride as f32);
                                let dist_t = bboxes[[0, idx, 1]] * (stride as f32);
                                let dist_r = bboxes[[0, idx, 2]] * (stride as f32);
                                let dist_b = bboxes[[0, idx, 3]] * (stride as f32);
                                
                                let x1 = anchor_x - dist_l;
                                let y1 = anchor_y - dist_t;
                                let x2 = anchor_x + dist_r;
                                let y2 = anchor_y + dist_b;
                                
                                let mut kps = [(0.0f32, 0.0f32); 5];
                                for j in 0..5 {
                                    let kp_x = anchor_x + kpss[[0, idx, j * 2]] * (stride as f32);
                                    let kp_y = anchor_y + kpss[[0, idx, j * 2 + 1]] * (stride as f32);
                                    kps[j] = (kp_x, kp_y);
                                }
                                
                                candidates.push(DetectedFace {
                                    bbox: (x1, y1, x2, y2),
                                    score,
                                    kps,
                                });
                            }
                            idx += 1;
                        }
                    }
                }
            }
        }
        
        // 5. NMS (Non-Maximum Suppression)
        let filtered = apply_nms(candidates, 0.40);
        
        // 6. Redimensiona coordenadas de volta ao tamanho original da foto
        let scale_x = orig_w / 640.0;
        let scale_y = orig_h / 640.0;
        
        let mut final_faces = Vec::new();
        for face in filtered {
            let x1 = (face.bbox.0 * scale_x).max(0.0).min(orig_w);
            let y1 = (face.bbox.1 * scale_y).max(0.0).min(orig_h);
            let x2 = (face.bbox.2 * scale_x).max(0.0).min(orig_w);
            let y2 = (face.bbox.3 * scale_y).max(0.0).min(orig_h);
            
            let mut kps = [(0.0, 0.0); 5];
            for j in 0..5 {
                kps[j] = (
                    (face.kps[j].0 * scale_x).max(0.0).min(orig_w),
                    (face.kps[j].1 * scale_y).max(0.0).min(orig_h),
                );
            }
            
            final_faces.push(DetectedFace {
                bbox: (x1, y1, x2, y2),
                score: face.score,
                kps,
            });
        }
        
        Ok(final_faces)
    }

    pub fn extract_embedding(&mut self, aligned_face: &DynamicImage) -> Result<Vec<f32>, String> {
        // 1. Pre-processamento ArcFace: normaliza [1, 3, 112, 112]
        let input_tensor = preprocess_arcface(aligned_face);
        
        // Cria o Value do ONNX Runtime explicitamente para evitar erros de trait From
        let input_value = Value::from_array(input_tensor)
            .map_err(|e| format!("Erro ao criar valor de tensor de entrada ArcFace: {}", e))?;
            
        // Garante que a sessao de reconhecimento esta ativa
        let session = self.ensure_recognition_session()?;

        // 2. Inferencia ArcFace
        let outputs = session.run(inputs![input_value])
            .map_err(|e| format!("Erro ao rodar extracao ArcFace: {}", e))?;
            
        let value = outputs.values().next()
            .ok_ok_or_else(|| "Nenhum output retornado pelo ArcFace".to_string())?;
            
        let tensor_d: ndarray::ArrayViewD<'_, f32> = value.try_extract_array::<f32>()
            .map_err(|e: ort::Error| format!("Erro ao extrair array do embedding: {}", e))?;
        let flat_embedding = tensor_d.as_slice()
            .ok_ok_or_else(|| "Falha ao ler slice do tensor ArcFace".to_string())?;
            
        // 3. Normalizacao L2 do vetor (essencial para similaridade de cosseno via produto escalar)
        let mut emb = flat_embedding.to_vec();
        let mut norm = 0.0f32;
        for &val in &emb {
            norm += val * val;
        }
        norm = norm.sqrt();
        
        if norm > 0.0 {
            for val in &mut emb {
                *val /= norm;
            }
        }
        
        Ok(emb)
    }
}

// Auxiliar para contornar Option no mapping
trait OkOr {
    type Value;
    fn ok_ok_or_else<F: FnOnce() -> String>(self, f: F) -> Result<Self::Value, String>;
}
impl<T> OkOr for Option<T> {
    type Value = T;
    fn ok_ok_or_else<F: FnOnce() -> String>(self, f: F) -> Result<Self::Value, String> {
        self.ok_or_else(f)
    }
}

pub fn preprocess_scrfd(img: &DynamicImage) -> Array4<f32> {
    let resized = img.resize_exact(640, 640, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();
    
    let mut tensor = Array4::<f32>::zeros((1, 3, 640, 640));
    
    for y in 0..640 {
        for x in 0..640 {
            let pixel = rgb.get_pixel(x, y);
            // Normalização InsightFace SCRFD: (pixel - 127.5) / 128.0
            let r = (pixel[0] as f32 - 127.5) / 128.0;
            let g = (pixel[1] as f32 - 127.5) / 128.0;
            let b = (pixel[2] as f32 - 127.5) / 128.0;
            
            tensor[[0, 0, y as usize, x as usize]] = r;
            tensor[[0, 1, y as usize, x as usize]] = g;
            tensor[[0, 2, y as usize, x as usize]] = b;
        }
    }
    
    tensor
}

pub fn preprocess_arcface(img: &DynamicImage) -> Array4<f32> {
    let rgb = img.to_rgb8();
    let mut tensor = Array4::<f32>::zeros((1, 3, 112, 112));
    
    for y in 0..112 {
        for x in 0..112 {
            let pixel = rgb.get_pixel(x, y);
            // Normalização ArcFace: (pixel - 127.5) / 127.5
            let r = (pixel[0] as f32 - 127.5) / 127.5;
            let g = (pixel[1] as f32 - 127.5) / 127.5;
            let b = (pixel[2] as f32 - 127.5) / 127.5;
            
            tensor[[0, 0, y as usize, x as usize]] = r;
            tensor[[0, 1, y as usize, x as usize]] = g;
            tensor[[0, 2, y as usize, x as usize]] = b;
        }
    }
    
    tensor
}

pub fn align_face(img: &DynamicImage, kps: &[(f32, f32); 5]) -> Result<DynamicImage, String> {
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_u = 0.0;
    let mut sum_v = 0.0;
    
    for i in 0..5 {
        sum_x += kps[i].0;
        sum_y += kps[i].1;
        sum_u += REFERENCE_LANDMARKS[i].0;
        sum_v += REFERENCE_LANDMARKS[i].1;
    }
    
    let mean_x = sum_x / 5.0;
    let mean_y = sum_y / 5.0;
    let mean_u = sum_u / 5.0;
    let mean_v = sum_v / 5.0;
    
    let mut num_a = 0.0;
    let mut num_b = 0.0;
    let mut den = 0.0;
    
    for i in 0..5 {
        let dx = kps[i].0 - mean_x;
        let dy = kps[i].1 - mean_y;
        let du = REFERENCE_LANDMARKS[i].0 - mean_u;
        let dv = REFERENCE_LANDMARKS[i].1 - mean_v;
        
        num_a += dx * du + dy * dv;
        num_b += dx * dv - dy * du;
        den += dx * dx + dy * dy;
    }
    
    if den.abs() < 1e-5 {
        return Err("Pontos de landmarks faciais colineares ou invalidos".to_string());
    }
    
    let a = num_a / den;
    let b = num_b / den;
    let tx = mean_u - (a * mean_x - b * mean_y);
    let ty = mean_v - (b * mean_x + a * mean_y);
    
    let det = a * a + b * b;
    if det.abs() < 1e-7 {
        return Err("Transformacao afim singular".to_string());
    }
    
    let mut aligned_img = image::ImageBuffer::new(112, 112);
    let orig_w = img.width() as f32;
    let orig_h = img.height() as f32;
    
    let rgb_img = img.to_rgb8();
    
    for v_idx in 0..112 {
        for u_idx in 0..112 {
            let u = u_idx as f32;
            let v = v_idx as f32;
            
            // Mapeamento inverso
            let x = (a * (u - tx) + b * (v - ty)) / det;
            let y = (-b * (u - tx) + a * (v - ty)) / det;
            
            if x >= 0.0 && x < orig_w - 1.0 && y >= 0.0 && y < orig_h - 1.0 {
                let x0 = x.floor() as u32;
                let x1 = x0 + 1;
                let y0 = y.floor() as u32;
                let y1 = y0 + 1;
                
                let wx1 = x - x0 as f32;
                let wx0 = 1.0 - wx1;
                let wy1 = y - y0 as f32;
                let wy0 = 1.0 - wy1;
                
                let p00 = rgb_img.get_pixel(x0, y0);
                let p10 = rgb_img.get_pixel(x1, y0);
                let p01 = rgb_img.get_pixel(x0, y1);
                let p11 = rgb_img.get_pixel(x1, y1);
                
                let r = (p00[0] as f32 * wx0 * wy0 +
                         p10[0] as f32 * wx1 * wy0 +
                         p01[0] as f32 * wx0 * wy1 +
                         p11[0] as f32 * wx1 * wy1) as u8;
                         
                let g = (p00[1] as f32 * wx0 * wy0 +
                         p10[1] as f32 * wx1 * wy0 +
                         p01[1] as f32 * wx0 * wy1 +
                         p11[1] as f32 * wx1 * wy1) as u8;
                         
                let b_val = (p00[2] as f32 * wx0 * wy0 +
                             p10[2] as f32 * wx1 * wy0 +
                             p01[2] as f32 * wx0 * wy1 +
                             p11[2] as f32 * wx1 * wy1) as u8;
                
                aligned_img.put_pixel(u_idx, v_idx, image::Rgb([r, g, b_val]));
            } else {
                aligned_img.put_pixel(u_idx, v_idx, image::Rgb([0, 0, 0]));
            }
        }
    }
    
    Ok(DynamicImage::ImageRgb8(aligned_img))
}

pub fn apply_nms(mut candidates: Vec<DetectedFace>, iou_threshold: f32) -> Vec<DetectedFace> {
    candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    
    let mut selected: Vec<DetectedFace> = Vec::new();
    
    for cand in candidates {
        let mut keep = true;
        for sel in &selected {
            if iou(&cand.bbox, &sel.bbox) > iou_threshold {
                keep = false;
                break;
            }
        }
        if keep {
            selected.push(cand);
        }
    }
    
    selected
}

fn iou(box1: &(f32, f32, f32, f32), box2: &(f32, f32, f32, f32)) -> f32 {
    let x1 = box1.0.max(box2.0);
    let y1 = box1.1.max(box2.1);
    let x2 = box1.2.min(box2.2);
    let y2 = box1.3.min(box2.3);
    
    let intersection = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    let area1 = (box1.2 - box1.0) * (box1.3 - box1.1);
    let area2 = (box2.2 - box2.0) * (box2.3 - box2.1);
    let union = area1 + area2 - intersection;
    
    if union <= 0.0 { 0.0 } else { intersection / union }
}

#[tauri::command]
pub fn test_load_ai_models() -> Result<serde_json::Value, String> {
    let start = Instant::now();
    let mut engine = FaceEngine::new()?;
    let elapsed = start.elapsed().as_millis();
    
    let det_inputs = engine.ensure_detection_session()?.inputs().len();
    let det_outputs = engine.ensure_detection_session()?.outputs().len();
    
    let rec_inputs = engine.ensure_recognition_session()?.inputs().len();
    let rec_outputs = engine.ensure_recognition_session()?.outputs().len();
    
    Ok(serde_json::json!({
        "status": "success",
        "elapsed_ms": elapsed,
        "models": {
            "detection": {
                "inputs_count": det_inputs,
                "outputs_count": det_outputs
            },
            "recognition": {
                "inputs_count": rec_inputs,
                "outputs_count": rec_outputs
            }
        }
    }))
}
