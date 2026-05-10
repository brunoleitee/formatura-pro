"""Serviços de IA do FormaturaPRO.

Este pacote concentra a camada nova de embeddings, busca vetorial,
persistência e análise facial avançada.
"""

from .embedding_service import PhotoEmbeddingService
from .face_quality_service import FaceQualityService
from .schema import PhotoAISchema
from .search_index import PhotoSearchIndex
from .text_search import PhotoTextSearch

__all__ = [
    "PhotoEmbeddingService",
    "FaceQualityService",
    "PhotoAISchema",
    "PhotoSearchIndex",
    "PhotoTextSearch",
]
