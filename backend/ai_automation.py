"""Camada de orquestração da IA do FormaturaPRO.

Este módulo mantém o score rápido atual e expõe ganchos para os novos
serviços de embedding, busca textual, análise facial e indexação.
"""

import os
import threading
from typing import Dict, Any, List, Optional

class AIAutomation:
    def __init__(self, log_debug=None, log_info=None):
        self._log_debug = log_debug or (lambda msg: None)
        self._log_info = log_info or (lambda msg: None)
        self._embedding_service = None
        self._face_quality_service = None
        self._search_index = None
        self._text_search = None
        self._schema = None
        self._app_settings = {}
        self._data_dir = None
        self._index_lock = threading.Lock()
        self._indexing_roots: set[str] = set()
        self._indexed_roots: set[str] = set()
        self._index_state = {
            "active": False,
            "root_path": "",
            "processed": 0,
            "total": 0,
            "message": "",
            "error": "",
        }

    def configure_runtime(self, *, app_settings=None, data_dir=None):
        self._app_settings = app_settings or {}
        self._data_dir = data_dir
        if self._embedding_service is not None:
            self._embedding_service.configure_runtime(app_settings=self._app_settings, data_dir=self._data_dir)
            if self._search_index is not None and self._search_index.dimension != self._embedding_service.config.dimension:
                from ai_services.search_index import PhotoSearchIndex
                self._search_index = PhotoSearchIndex(
                    dimension=self._embedding_service.config.dimension,
                    log_debug=self._log_debug,
                    log_info=self._log_info,
                )
                if self._text_search is not None:
                    self._text_search.search_index = self._search_index

    def _lazy_services(self):
        if self._embedding_service is not None:
            return

        try:
            from ai_services.embedding_service import PhotoEmbeddingService
            from ai_services.face_quality_service import FaceQualityService
            from ai_services.search_index import PhotoSearchIndex
            from ai_services.text_search import PhotoTextSearch
            from ai_services.schema import PhotoAISchema

            self._embedding_service = PhotoEmbeddingService(log_debug=self._log_debug, log_info=self._log_info)
            self._embedding_service.configure_runtime(app_settings=self._app_settings, data_dir=self._data_dir)
            self._search_index = PhotoSearchIndex(
                dimension=self._embedding_service.config.dimension,
                log_debug=self._log_debug,
                log_info=self._log_info,
            )
            self._face_quality_service = FaceQualityService(log_debug=self._log_debug, log_info=self._log_info)
            self._schema = PhotoAISchema(data_dir=self._data_dir, log_debug=self._log_debug, log_info=self._log_info)
            self._text_search = PhotoTextSearch(
                embedding_service=self._embedding_service,
                search_index=self._search_index,
                log_debug=self._log_debug,
                log_info=self._log_info,
            )
        except Exception as exc:
            self._log_debug(f"Falha ao inicializar servicos de IA: {exc}")
            self._embedding_service = None
            self._face_quality_service = None
            self._search_index = None
            self._text_search = None
            self._schema = None
    
    def _allowed_image_extensions(self):
        raw_exts = self._app_settings.get("image_extensions") if isinstance(self._app_settings, dict) else None
        if raw_exts:
            return tuple(ext.lower() for ext in raw_exts)
        return (".jpg", ".jpeg", ".png", ".webp", ".bmp")

    def _load_index_from_storage(self):
        if self._schema is None or self._search_index is None:
            return
        try:
            records = self._schema.get_embedding_records()
            if records:
                self._search_index.rebuild_index(records)
                self._log_info(f"Índice de IA carregado do SQLite: {len(records)} itens.")
        except Exception as exc:
            self._log_debug(f"Falha ao carregar índice salvo: {exc}")

    def get_index_status(self) -> Dict[str, Any]:
        with self._index_lock:
            return dict(self._index_state)

    def schedule_folder_indexing(self, root_path: str) -> Dict[str, Any]:
        root_abs = os.path.abspath(root_path or "")
        if not root_abs or not os.path.isdir(root_abs):
            return {"status": "skipped", "reason": "invalid_root"}
        self._lazy_services()
        if self._schema is None or self._embedding_service is None or self._search_index is None:
            return {"status": "unavailable"}
        with self._index_lock:
            if root_abs in self._indexing_roots:
                return {"status": "running", "root_path": root_abs}
            if root_abs in self._indexed_roots:
                return {"status": "done", "root_path": root_abs}
            self._indexing_roots.add(root_abs)
            self._index_state = {
                "active": True,
                "root_path": root_abs,
                "processed": 0,
                "total": 0,
                "message": "Indexando pasta automaticamente...",
                "error": "",
            }
        thread = threading.Thread(target=self._index_folder_worker, args=(root_abs,), daemon=True)
        thread.start()
        return {"status": "started", "root_path": root_abs}

    def _index_folder_worker(self, root_abs: str) -> None:
        processed = 0
        total = 0
        try:
            files: list[str] = []
            for current_root, _dirs, filenames in os.walk(root_abs):
                for filename in filenames:
                    if filename.lower().endswith(self._allowed_image_extensions()):
                        files.append(os.path.join(current_root, filename))
            total = len(files)
            with self._index_lock:
                self._index_state.update({
                    "active": True,
                    "root_path": root_abs,
                    "processed": 0,
                    "total": total,
                    "message": f"Indexando {total} foto(s)...",
                    "error": "",
                })
            for idx, file_path in enumerate(files, start=1):
                try:
                    stat = os.stat(file_path)
                    mtime_ns = getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))
                    file_size = stat.st_size
                    if self._schema and not self._schema.needs_reindex(file_path, mtime_ns, file_size):
                        processed = idx
                        continue
                    analysis = self.analyze_face_quality(file_path)
                    embedding = self.build_image_embedding(file_path)
                    record = {
                        "photo_id": file_path,
                        "file_path": file_path,
                        "file_mtime_ns": mtime_ns,
                        "file_size": file_size,
                        "analysis_status": analysis.get("status", "ok"),
                        "ai_score": analysis.get("score"),
                        "smile_score": analysis.get("smile_score"),
                        "eyes_score": analysis.get("eyes_score"),
                        "face_count": analysis.get("face_count"),
                        "caption": analysis.get("caption"),
                        "tags": analysis.get("tags") or [],
                        "embedding": embedding,
                    }
                    if self._schema is not None:
                        self._schema.upsert_photo_metadata(record)
                        self._schema.upsert_embedding_record(
                            file_path,
                            file_path,
                            mtime_ns,
                            file_size,
                            embedding,
                            model_name=self._embedding_service.config.model_name,
                        )
                    if self._search_index is not None:
                        self._search_index.add_photo_vector(file_path, embedding, metadata=record)
                    processed = idx
                    if idx % 25 == 0:
                        with self._index_lock:
                            self._index_state.update({
                                "processed": processed,
                                "total": total,
                                "message": f"Indexando {processed}/{total} fotos...",
                            })
                except Exception as exc:
                    self._log_debug(f"Falha ao indexar '{file_path}': {exc}")
            with self._index_lock:
                self._indexed_roots.add(root_abs)
                self._index_state.update({
                    "active": False,
                    "root_path": root_abs,
                    "processed": processed,
                    "total": total,
                    "message": f"Indexação concluída: {processed}/{total} foto(s).",
                    "error": "",
                })
        except Exception as exc:
            with self._index_lock:
                self._index_state.update({
                    "active": False,
                    "root_path": root_abs,
                    "processed": processed,
                    "total": total,
                    "message": "Falha ao indexar a pasta.",
                    "error": str(exc),
                })
            self._log_debug(f"Erro no indexador automático: {exc}")
        finally:
            with self._index_lock:
                self._indexing_roots.discard(root_abs)

    def calculate_culling_score(self, blur_info: Dict[str, Any], faces_count: int, img_path: str = None) -> Dict[str, Any]:
        """
        Calcula uma pontuação ultrarrápida (0-100) baseada em metadados já processados.
        Zero I/O de disco para garantir performance extrema na listagem de pastas.
        """
        try:
            score = 0
            blur_status = blur_info.get("blur_status", "unknown")
            blur_score = blur_info.get("blur_score", 0) or 0
            
            # 1. Base de Nitidez (Max 60 pontos)
            if blur_status == "blurry":
                score += min(blur_score / 4.0, 15)
            elif blur_status == "attention":
                score += 25 + min(blur_score / 10.0, 15)
            else: # sharp ou unknown com score alto
                score += 40 + min(blur_score / 15.0, 20)

            # 2. Bônus de Faces (Max 40 pontos)
            face_bonus = 0
            if faces_count > 0:
                if blur_status == "blurry":
                    face_bonus = 5 # Rosto borrado não ajuda muito
                elif blur_status == "attention":
                    face_bonus = 20
                else:
                    face_bonus = 30 # Rosto nítido é excelente
                
                # Bônus por múltiplas pessoas (composição)
                if faces_count > 1:
                    face_bonus += min((faces_count - 1) * 3, 10)
            
            score += face_bonus

            final_score = min(round(score, 1), 100)
            
            # Recomendações mais espaçadas
            recommendation = "keep"
            if final_score < 40:
                recommendation = "discard"
            elif final_score < 65:
                recommendation = "review"
                
            return {
                "score": final_score,
                "recommendation": recommendation,
                "details": {
                    "blur_score": blur_score,
                    "faces": faces_count
                }
            }
        except Exception as e:
            self._log_debug(f"Erro no score rápido: {e}")
            return {"score": 0, "recommendation": "error", "details": {}}

    def build_image_embedding(self, image_path: str, *, dimension: int = 512) -> List[float]:
        self._lazy_services()
        if self._embedding_service is None:
            return []
        return self._embedding_service.build_image_embedding(image_path, dimension=dimension)

    def build_text_embedding(self, query: str, *, dimension: int = 512) -> List[float]:
        self._lazy_services()
        if self._embedding_service is None:
            return []
        return self._embedding_service.build_text_embedding(query, dimension=dimension)

    def analyze_face_quality(self, image_path: str) -> Dict[str, Any]:
        self._lazy_services()
        if self._face_quality_service is None:
            return {"status": "unavailable"}
        return self._face_quality_service.analyze_face_quality(image_path)

    def analyze_photo(self, image_path: str, *, photo_id: Optional[str] = None) -> Dict[str, Any]:
        self._lazy_services()
        if self._embedding_service is None or self._face_quality_service is None:
            return {"status": "unavailable", "photo_id": photo_id or image_path}

        embedding = self._embedding_service.build_image_embedding(image_path)
        face_quality = self._face_quality_service.analyze_face_quality(image_path)
        result = {
            "status": "ok",
            "photo_id": photo_id or image_path,
            "image_path": image_path,
            "embedding": embedding,
            "face_quality": face_quality,
        }
        if self._schema is not None:
            try:
                stat = os.stat(image_path)
                mtime_ns = getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))
                self._schema.upsert_photo_metadata({
                    "photo_id": result["photo_id"],
                    "file_path": image_path,
                    "file_mtime_ns": mtime_ns,
                    "file_size": stat.st_size,
                    "analysis_status": "ok",
                    "ai_score": face_quality.get("score"),
                    "smile_score": face_quality.get("smile_score"),
                    "eyes_score": face_quality.get("eyes_score"),
                    "face_count": face_quality.get("face_count"),
                    "caption": face_quality.get("caption"),
                    "tags": face_quality.get("tags"),
                })
            except Exception as exc:
                self._log_debug(f"Erro ao persistir analise: {exc}")
            try:
                stat = os.stat(image_path)
                mtime_ns = getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))
                self._schema.upsert_embedding_record(
                    result["photo_id"],
                    image_path,
                    mtime_ns,
                    stat.st_size,
                    embedding,
                    model_name=self._embedding_service.config.model_name,
                )
            except Exception as exc:
                self._log_debug(f"Erro ao persistir embedding: {exc}")
        if self._search_index is not None:
            try:
                self._search_index.add_photo_vector(result["photo_id"], embedding, metadata=result)
            except Exception as exc:
                self._log_debug(f"Erro ao indexar vetor: {exc}")
        return result

    def search_by_text(self, query: str, limit: int = 20) -> List[Dict[str, Any]]:
        self._lazy_services()
        if self._text_search is None:
            return []
        if self._search_index is not None and not getattr(self._search_index, "_items", None):
            self._load_index_from_storage()
        return self._text_search.search_by_text(query, limit=limit)
