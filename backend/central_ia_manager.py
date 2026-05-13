import os
import sqlite3
import logging
from fastapi import APIRouter, HTTPException, Query, BackgroundTasks
from typing import List, Optional, Dict
from pydantic import BaseModel
import time

from services.ocr_engine import get_tesseract_status

router = APIRouter(prefix="/api/ai", tags=["Central IA"])

# Dependências injetadas pelo backend.py
get_db = None
mm = None
se = None
pipeline = None

def configure(get_db_func, mm_module=None, se_module=None):
    global get_db, mm, se, pipeline
    get_db = get_db_func
    mm = mm_module
    se = se_module
    
    # Inicializar o pipeline (o motor de face será obtido via se.get_app_face() quando necessário)
    from ai_services.central_pipeline import CentralAIPipeline
    pipeline = CentralAIPipeline(face_engine_provider=se, get_db=get_db, mm=mm)

@router.get("/central-stats")
async def get_central_stats(catalog: str = Query(...)):
    """
    Retorna os dados do resumo geral e da timeline para o dashboard Central IA.
    """
    try:
        with get_db(catalog) as db:
            c = db.cursor()
            
            # Resumo Geral
            c.execute("SELECT COUNT(*) FROM photos")
            total_photos = c.fetchone()[0] or 0
            
            c.execute("SELECT COUNT(*) FROM photos WHERE status = 'processed'")
            processed_photos = c.fetchone()[0] or 0
            
            c.execute("SELECT COUNT(*) FROM photos WHERE status = 'curating'")
            in_curation = c.fetchone()[0] or 0
            
            c.execute("SELECT COUNT(*) FROM photos WHERE status = 'pending'")
            pending = c.fetchone()[0] or 0
            
            c.execute("SELECT COUNT(*) FROM photos WHERE status = 'error'")
            errors = c.fetchone()[0] or 0
            
            # Mock de Timeline (Integrar com processing_jobs depois)
            timeline = {
                "import": {"processed": total_photos, "total": total_photos, "status": "completed" if total_photos > 0 else "pending"},
                "ocr": {"processed": 0, "total": total_photos, "status": "pending"},
                "ai": {"processed": processed_photos, "total": total_photos, "status": "running" if processed_photos < total_photos and processed_photos > 0 else "pending"},
                "review": {"processed": in_curation, "total": total_photos, "status": "pending"},
                "export": {"processed": 0, "total": total_photos, "status": "pending"}
            }
            
            # Cálculo de porcentagens para o frontend
            def calc_pct(val):
                return round((val / total_photos * 100), 1) if total_photos > 0 else 0

            ocr_status = get_tesseract_status()

            return {
                "total": total_photos,
                "processed": processed_photos,
                "inCuration": in_curation,
                "pending": pending,
                "errors": errors,
                "storageUsed": 0,
                "percents": {
                    "processed": calc_pct(processed_photos),
                    "inCuration": calc_pct(in_curation),
                    "pending": calc_pct(pending),
                    "errors": calc_pct(errors)
                },
                "timeline": timeline,
                "ocr": {
                    "available": ocr_status.get("available", False),
                    "message": "OCR indisponível: Tesseract não instalado"
                    if not ocr_status.get("available", False)
                    else "OCR disponível",
                    "status": "unavailable" if not ocr_status.get("available", False) else "available",
                }
            }
    except Exception as e:
        logging.error(f"Erro em get_central_stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/filmstrip")
async def get_filmstrip(
    catalog: str = Query(...),
    search: Optional[str] = None,
    status: Optional[str] = None,
    page: int = 1,
    limit: int = 50
):
    """
    Retorna as fotos para o carrossel superior (filmstrip).
    """
    try:
        offset = (page - 1) * limit
        with get_db(catalog) as db:
            c = db.cursor()
            
            query = "SELECT * FROM photos WHERE 1=1"
            params = []
            
            if status and status != "Todos":
                query += " AND status = ?"
                params.append(status.lower())
                
            if search:
                query += " AND (file_name LIKE ? OR original_path LIKE ?)"
                params.extend([f"%{search}%", f"%{search}%"])
                
            query += " ORDER BY id DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            
            c.execute(query, params)
            rows = c.fetchall()
            
            photos = []
            for row in rows:
                p = dict(row)
                photos.append({
                    "id": p["id"],
                    "fileName": p["file_name"],
                    "thumbnailUrl": p["thumbnail_path"],
                    "previewUrl": p["preview_path"],
                    "status": p["status"],
                    "favorite": bool(p["favorite"]),
                    "rating": p["rating"],
                    "colorLabel": p["color_label"],
                    "hasError": p["status"] == "error",
                    "suggestedPersonName": None, # Implementar join com faces/persons depois
                    "confidence": 0
                })
                
            return photos
    except Exception as e:
        logging.error(f"Erro em get_filmstrip: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/photos/{photo_id}")
async def get_photo_details(photo_id: int, catalog: str = Query(...)):
    """
    Retorna os dados completos da foto selecionada no visualizador principal.
    """
    try:
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("SELECT * FROM photos WHERE id = ?", (photo_id,))
            row = c.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Foto não encontrada")
                
            p = dict(row)
            
            # Buscar faces detectadas para esta foto
            c.execute("SELECT * FROM faces WHERE photo_id = ?", (photo_id,))
            face_rows = c.fetchall()
            faces = [dict(f) for f in face_rows]
            
            # Buscar OCR
            c.execute("SELECT * FROM ocr_results WHERE photo_id = ?", (photo_id,))
            ocr_row = c.fetchone()
            ocr_text = ocr_row["raw_text"] if ocr_row else ""
            
            return {
                "id": p["id"],
                "fileName": p["file_name"],
                "previewUrl": p["preview_path"],
                "originalPath": p["original_path"],
                "width": p["width"],
                "height": p["height"],
                "fileSize": p["file_size"],
                "captureDate": p["capture_date"],
                "scannerOrigin": p["scanner_origin"],
                "status": p["status"],
                "rating": p["rating"],
                "colorLabel": p["color_label"],
                "favorite": bool(p["favorite"]),
                "faces": faces,
                "ocrText": ocr_text
            }
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Erro em get_photo_details: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/photo-suggestions/{photo_id}")
async def get_photo_suggestions(photo_id: int, catalog: str = Query(...)):
    """
    Retorna sugestões de faces para uma foto específica.
    """
    try:
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("""
                SELECT f.*, p.name as person_name 
                FROM faces f
                LEFT JOIN persons p ON f.suggested_person_id = p.id
                WHERE f.photo_id = ?
            """, (photo_id,))
            rows = c.fetchall()
            
            suggestions = []
            for row in rows:
                s = dict(row)
                suggestions.append({
                    "faceId": s["id"],
                    "photoId": s["photo_id"],
                    "cropUrl": s["crop_path"],
                    "suggestedPersonId": s["suggested_person_id"],
                    "suggestedPersonName": s["person_name"],
                    "confidence": s["confidence"],
                    "status": s["status"]
                })
            return suggestions
    except Exception as e:
        logging.error(f"Erro em get_photo_suggestions: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/global-suggestions")
async def get_global_suggestions(catalog: str = Query(...), limit: int = 10):
    """
    Retorna sugestões globais de faces para o card de sugestão IA.
    """
    try:
        with get_db(catalog) as db:
            c = db.cursor()
            # Buscar faces com status 'detected' e confiança alta
            c.execute("""
                SELECT f.*, p.original_path, p.file_name 
                FROM faces f
                JOIN photos p ON f.photo_id = p.id
                WHERE f.status = 'detected'
                ORDER BY f.detection_score DESC
                LIMIT ?
            """, (limit,))
            rows = c.fetchall()
            
            suggestions = []
            for row in rows:
                s = dict(row)
                suggestions.append({
                    "id": s["id"],
                    "photoId": s["photo_id"],
                    "fileName": s["file_name"],
                    "originalPath": s["original_path"],
                    "cropUrl": s["crop_path"],
                    "confidence": s["detection_score"],
                    "suggestedPersonName": s["suggested_person_name"] or "Novo Formando",
                    "reason": "Similaridade Visual"
                })
            return suggestions
    except Exception as e:
        logging.error(f"Erro em get_global_suggestions: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ImportRequest(BaseModel):
    event_id: Optional[int] = 1
    folder_path: str
    copy_files: Optional[bool] = False

class ConfirmRequest(BaseModel):
    face_id: int
    person_id: int

class RejectRequest(BaseModel):
    face_id: int

@router.post("/import/folder")
async def import_folder(req: ImportRequest, background_tasks: BackgroundTasks, catalog: str = Query(...)):
    """
    Inicia a importação de uma pasta local para o catálogo.
    """
    if not os.path.isdir(req.folder_path):
        raise HTTPException(status_code=400, detail="Caminho da pasta inválido")
        
    try:
        with get_db(catalog) as db:
            c = db.cursor()
            # Criar um job de processamento
            c.execute("""
                INSERT INTO processing_jobs (event_id, type, status, started_at)
                VALUES (?, 'import', 'running', ?)
            """, (req.event_id, time.time()))
            job_id = c.lastrowid
            db.commit()
            
        background_tasks.add_task(process_import_task, catalog, job_id, req.folder_path, req.event_id)
        
        return {"job_id": job_id, "message": "Importação iniciada em segundo plano"}
    except Exception as e:
        logging.error(f"Erro em import_folder: {e}")
        raise HTTPException(status_code=500, detail=str(e))

async def process_import_task(catalog: str, job_id: int, folder_path: str, event_id: int):
    """
    Tarefa de background para processar a importação de arquivos.
    """
    try:
        valid_exts = ('.jpg', '.jpeg', '.png')
        files = [f for f in os.listdir(folder_path) if f.lower().endswith(valid_exts)]
        total = len(files)
        
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("UPDATE processing_jobs SET total = ? WHERE id = ?", (total, job_id))
            db.commit()
            
            processed = 0
            for filename in files:
                full_path = os.path.join(folder_path, filename)
                try:
                    stat = os.stat(full_path)
                    
                    # Gerar caminhos de thumbnail e preview usando o media_manager
                    thumb_path = ""
                    preview_path = ""
                    
                    if mm:
                        try:
                            # Thumbnail pequena (320px)
                            thumb_path = mm.get_cached_thumb_path(full_path, "image", 320)
                            if not os.path.exists(thumb_path):
                                mm._run_thumb_engine("image", full_path, thumb_path, 320)
                            
                            # Preview médio (1600px)
                            preview_path = mm.get_cached_thumb_path(full_path, "image", 1600)
                            if not os.path.exists(preview_path):
                                mm._run_thumb_engine("image", full_path, preview_path, 1600)
                        except Exception as e_mm:
                            logging.error(f"Erro ao gerar thumbs no media_manager: {e_mm}")

                    c.execute("""
                        INSERT INTO photos (event_id, file_name, original_path, thumbnail_path, preview_path, file_size, capture_date, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
                    """, (event_id, filename, full_path, thumb_path, preview_path, stat.st_size, time.ctime(stat.st_mtime)))
                    
                    processed += 1
                    if processed % 10 == 0:
                        c.execute("UPDATE processing_jobs SET processed = ?, progress = ? WHERE id = ?", 
                                 (processed, processed/total, job_id))
                        db.commit()
                except Exception as ex:
                    logging.error(f"Erro ao importar arquivo {filename}: {ex}")
            
            c.execute("UPDATE processing_jobs SET status = 'completed', finished_at = ?, progress = 1.0 WHERE id = ?", 
                     (time.time(), job_id))
            db.commit()
            
    except Exception as e:
        logging.error(f"Erro no process_import_task: {e}")
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("UPDATE processing_jobs SET status = 'error', error_message = ? WHERE id = ?", 
                     (str(e), job_id))
            db.commit()

@router.post("/process")
async def start_ai_processing(catalog: str = Query(...), background_tasks: BackgroundTasks = None):
    """
    Inicia o processamento de IA (Detecção/Reconhecimento) para fotos pendentes.
    """
    try:
        with get_db(catalog) as db:
            c = db.cursor()
            # Buscar fotos pendentes
            c.execute("SELECT id FROM photos WHERE status = 'pending'")
            rows = c.fetchall()
            photo_ids = [r["id"] for r in rows]
            
            if not photo_ids:
                return {"message": "Nenhuma foto pendente para processar"}
                
            # Criar um job
            c.execute("""
                INSERT INTO processing_jobs (type, status, total, started_at)
                VALUES ('ai_process', 'running', ?, ?)
            """, (len(photo_ids), time.time()))
            job_id = c.lastrowid
            db.commit()
            
        if background_tasks:
            background_tasks.add_task(run_ai_pipeline_task, catalog, job_id, photo_ids)
            
        return {"job_id": job_id, "message": f"Processamento de {len(photo_ids)} fotos iniciado"}
    except Exception as e:
        logging.error(f"Erro em start_ai_processing: {e}")
        raise HTTPException(status_code=500, detail=str(e))

async def run_ai_pipeline_task(catalog: str, job_id: int, photo_ids: List[int]):
    """
    Tarefa de background para executar o pipeline em lote.
    """
    try:
        total = len(photo_ids)
        processed = 0
        
        # Garantir que o motor de face está pronto
        if se:
             se.ensure_face_engine()
        
        for pid in photo_ids:
            success = pipeline.process_photo(pid, catalog)
            processed += 1
            
            if processed % 5 == 0:
                with get_db(catalog) as db:
                    c = db.cursor()
                    c.execute("UPDATE processing_jobs SET processed = ?, progress = ? WHERE id = ?", 
                             (processed, processed/total, job_id))
                    db.commit()
        
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("UPDATE processing_jobs SET status = 'completed', finished_at = ?, progress = 1.0 WHERE id = ?", 
                     (time.time(), job_id))
            db.commit()
            
    except Exception as e:
        logging.error(f"Erro no run_ai_pipeline_task: {e}")
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("UPDATE processing_jobs SET status = 'error', error_message = ? WHERE id = ?", 
                     (str(e), job_id))
            db.commit()

@router.post("/review/confirm")
async def confirm_suggestion(req: ConfirmRequest, catalog: str = Query(...)):
    """
    Confirma uma sugestão da IA vinculando a face a uma pessoa.
    """
    try:
        face_id = req.face_id
        person_id = req.person_id
        with get_db(catalog) as db:
            c = db.cursor()
            # Atualizar status da face
            c.execute("UPDATE faces SET status = 'confirmed', suggested_person_id = ? WHERE id = ?", 
                     (person_id, face_id))
            
            # Criar ou atualizar ocorrência (compatibilidade com sistema antigo)
            c.execute("SELECT photo_id, x, y, width, height FROM faces WHERE id = ?", (face_id,))
            face = c.fetchone()
            c.execute("SELECT original_path FROM photos WHERE id = ?", (face["photo_id"],))
            photo = c.fetchone()
            c.execute("SELECT name FROM persons WHERE id = ?", (person_id,))
            person = c.fetchone()
            
            x1, y1 = face["x"], face["y"]
            x2, y2 = x1 + face["width"], y1 + face["height"]
            
            c.execute("""
                INSERT OR REPLACE INTO ocorrencias (aluno_id, foto_path, x1, y1, x2, y2)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (person["name"], photo["original_path"], x1, y1, x2, y2))
            
            db.commit()
            return {"message": "Sugestão confirmada"}
    except Exception as e:
        logging.error(f"Erro em confirm_suggestion: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/review/reject")
async def reject_suggestion(req: RejectRequest, catalog: str = Query(...)):
    """
    Rejeita uma sugestão da IA.
    """
    try:
        face_id = req.face_id
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("UPDATE faces SET status = 'rejected' WHERE id = ?", (face_id,))
            db.commit()
            return {"message": "Sugestão rejeitada"}
    except Exception as e:
        logging.error(f"Erro em reject_suggestion: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ExportRequest(BaseModel):
    option: str

@router.post("/export")
async def export_review(req: ExportRequest, catalog: str = Query(...)):
    """
    Simula o início de uma exportação baseada na revisão IA.
    """
    try:
        # Por enquanto, apenas cria um registro e retorna sucesso
        with get_db(catalog) as db:
            c = db.cursor()
            c.execute("""
                INSERT INTO exports (type, path, status)
                VALUES (?, ?, 'completed')
            """, (req.option, "C:/Export/Review",))
            db.commit()
            
        return {"message": "Exportação concluída (simulada)"}
    except Exception as e:
        logging.error(f"Erro em export_review: {e}")
        raise HTTPException(status_code=500, detail=str(e))
