"""Busca por texto baseada em embeddings e índice vetorial."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .embedding_service import PhotoEmbeddingService
from .search_index import PhotoSearchIndex


class PhotoTextSearch:
    def __init__(
        self,
        embedding_service: PhotoEmbeddingService,
        search_index: PhotoSearchIndex,
        log_debug=None,
        log_info=None,
    ):
        self.embedding_service = embedding_service
        self.search_index = search_index
        self._log_debug = log_debug or (lambda msg: None)
        self._log_info = log_info or (lambda msg: None)

    def search_by_text(self, query: str, limit: int = 20) -> List[Dict[str, Any]]:
        if not query.strip():
            return []
        vector = self.embedding_service.build_text_embedding(query)
        return self.search_index.search_similar(vector, limit=limit)
