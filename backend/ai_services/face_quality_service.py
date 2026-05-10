"""Análise facial básica para qualidade de foto.

Este módulo já deixa a estrutura pronta para integrar InsightFace,
landmarks e regras como sorriso/olhos fechados.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class FaceQualityConfig:
    minimum_score: float = 0.0
    maximum_score: float = 100.0


class FaceQualityService:
    def __init__(self, config: FaceQualityConfig | None = None, log_debug=None, log_info=None):
        self.config = config or FaceQualityConfig()
        self._log_debug = log_debug or (lambda msg: None)
        self._log_info = log_info or (lambda msg: None)

    def analyze_face_quality(self, image_path: str) -> Dict[str, Any]:
        """Retorna uma estrutura inicial de qualidade facial.

        A implementação real pode usar InsightFace + landmarks + EAR.
        Aqui deixamos o contrato estável para o resto da pipeline.
        """
        exists = os.path.exists(image_path)
        size_hint = os.path.getsize(image_path) if exists else 0
        base_score = 50.0 if exists else 0.0
        if size_hint > 0:
            base_score = min(60.0 + (size_hint % 40), self.config.maximum_score)

        return {
            "status": "placeholder",
            "score": round(base_score, 1),
            "smile_score": 0.0,
            "eyes_score": 0.0,
            "face_count": 0,
            "has_smile": False,
            "has_closed_eyes": False,
            "caption": "",
            "tags": [],
        }
