"""Índice vetorial para busca por similaridade."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

try:
    import faiss  # type: ignore
except Exception:  # pragma: no cover - fallback local
    faiss = None

try:
    import numpy as np
except Exception:  # pragma: no cover - fallback local
    np = None


@dataclass
class IndexedVector:
    photo_id: str
    vector: List[float]
    metadata: Dict[str, Any] = field(default_factory=dict)


class PhotoSearchIndex:
    def __init__(self, dimension: int = 512, log_debug=None, log_info=None):
        self.dimension = dimension
        self._log_debug = log_debug or (lambda msg: None)
        self._log_info = log_info or (lambda msg: None)
        self._items: list[IndexedVector] = []
        self._faiss_index = None
        if faiss is not None:
            try:
                self._faiss_index = faiss.IndexFlatIP(self.dimension)
            except Exception as exc:
                self._log_debug(f"FAISS indisponivel: {exc}")
                self._faiss_index = None

    def _normalize(self, vector: List[float]) -> List[float]:
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]

    def add_photo_vector(self, photo_id: str, vector: List[float], metadata: Optional[Dict[str, Any]] = None) -> None:
        normalized = self._normalize(vector)
        self._items.append(IndexedVector(photo_id=photo_id, vector=normalized, metadata=metadata or {}))
        if self._faiss_index is not None and np is not None:
            array = np.asarray([normalized], dtype="float32")
            self._faiss_index.add(array)

    def clear(self) -> None:
        self._items = []
        if self._faiss_index is not None:
          self._faiss_index.reset()

    def search_similar(self, vector: List[float], limit: int = 20) -> List[Dict[str, Any]]:
        if not self._items:
            return []

        query = self._normalize(vector)
        results: list[Dict[str, Any]] = []

        if self._faiss_index is not None and np is not None and self._faiss_index.ntotal:
            scores, indices = self._faiss_index.search(np.asarray([query], dtype="float32"), min(limit, len(self._items)))
            for score, idx in zip(scores[0], indices[0]):
                if idx < 0 or idx >= len(self._items):
                    continue
                item = self._items[idx]
                results.append({
                    "photo_id": item.photo_id,
                    "score": float(score),
                    "metadata": item.metadata,
                })
            return results

        # Fallback simples em memória para manter a estrutura funcional.
        def cosine(item: IndexedVector) -> float:
            return sum(a * b for a, b in zip(query, item.vector))

        ordered = sorted(self._items, key=cosine, reverse=True)[:limit]
        for item in ordered:
            results.append({
                "photo_id": item.photo_id,
                "score": round(cosine(item), 6),
                "metadata": item.metadata,
            })
        return results

    def rebuild_index(self, records: Iterable[IndexedVector | Dict[str, Any]] | None = None) -> None:
        converted: list[IndexedVector] = []
        for record in records or []:
            if isinstance(record, IndexedVector):
                converted.append(record)
            else:
                converted.append(IndexedVector(
                    photo_id=str(record.get("photo_id") or ""),
                    vector=list(record.get("vector") or record.get("embedding") or []),
                    metadata=dict(record.get("metadata") or record),
                ))
        self._items = converted
        if self._faiss_index is not None and np is not None:
            self._faiss_index.reset()
            if self._items:
                data = np.asarray([self._normalize(item.vector) for item in self._items], dtype="float32")
                self._faiss_index.add(data)
