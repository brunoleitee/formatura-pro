"""Construção do dataset para treino do classificador de formatura."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np
from PIL import Image

from db import get_db
from ..graduation_features import GRADUATION_LABELS, extract_graduation_features, pick_primary_box, prepare_graduation_crop

LABEL_TO_INDEX = {label: idx for idx, label in enumerate(GRADUATION_LABELS)}
LABEL_TO_ITEM = {
    "beca": "gown",
    "faixa": "sash",
    "capelo": "cap",
    "canudo": "diploma",
    "jabor": "jabor",
}

POSITIVE_THRESHOLD = 0.75
NEGATIVE_THRESHOLD = 0.25


@dataclass(slots=True)
class TrainingSample:
    photo_path: str
    face_box: tuple[float, float, float, float] | None
    targets: np.ndarray
    source: str = "unknown"


def _parse_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return []
        if isinstance(parsed, list):
            return [str(item) for item in parsed if str(item).strip()]
    return []


def _parse_scores(value: Any) -> dict[str, float]:
    raw = value
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    scores = {label: 0.0 for label in GRADUATION_LABELS}
    if isinstance(raw, dict):
        for label in GRADUATION_LABELS:
            try:
                scores[label] = float(raw.get(label, 0.0) or 0.0)
            except Exception:
                scores[label] = 0.0
    return scores


def _manual_signals(tags: list[str]) -> dict[str, int]:
    signals: dict[str, int] = {}
    normalized = {tag.strip().lower() for tag in tags if tag and str(tag).strip()}
    for label, item in LABEL_TO_ITEM.items():
        if label in normalized:
            signals[label] = 1
        elif f"!{label}" in normalized or f"!{item}" in normalized:
            signals[label] = 0
    return signals


def _scores_to_signals(scores: dict[str, float]) -> dict[str, int]:
    signals: dict[str, int] = {}
    for label, score in scores.items():
        if score >= POSITIVE_THRESHOLD:
            signals[label] = 1
        elif score <= NEGATIVE_THRESHOLD:
            signals[label] = 0
    return signals


class GraduationDatasetBuilder:
    def __init__(self, catalog: str):
        self.catalog = catalog

    def iter_rows(self, limit: int | None = None) -> Iterable[dict[str, Any]]:
        query = """
            SELECT foto_path, x1, y1, x2, y2, graduation_scores, graduation_tags,
                   ai_graduation_tags, manual_graduation_tags, graduation_reviewed
            FROM ocorrencias
            WHERE foto_path IS NOT NULL AND foto_path != ''
            ORDER BY rowid ASC
        """
        params: tuple[Any, ...] = ()
        if limit is not None and limit > 0:
            query += " LIMIT ?"
            params = (int(limit),)

        with get_db(self.catalog) as conn:
            cur = conn.cursor()
            cur.execute(query, params)
            columns = [desc[0] for desc in cur.description]
            for row in cur.fetchall():
                yield {column: row[idx] for idx, column in enumerate(columns)}

    def build_samples(self, limit: int | None = None, include_unlabeled: bool = False) -> list[TrainingSample]:
        samples: list[TrainingSample] = []
        for row in self.iter_rows(limit=limit):
            labels = np.full(len(GRADUATION_LABELS), -1, dtype=np.int8)
            manual_tags = _parse_list(row.get("manual_graduation_tags"))
            ai_tags = _parse_list(row.get("ai_graduation_tags"))
            saved_tags = _parse_list(row.get("graduation_tags"))
            scores = _parse_scores(row.get("graduation_scores"))

            manual_signals = _manual_signals(manual_tags)
            score_signals = _scores_to_signals(scores)
            saved_positive = {label for label in ai_tags + saved_tags if label in LABEL_TO_INDEX}

            for label, idx in LABEL_TO_INDEX.items():
                if label in manual_signals:
                    labels[idx] = int(manual_signals[label])
                elif label in saved_positive:
                    labels[idx] = 1
                elif label in score_signals:
                    labels[idx] = int(score_signals[label])

            if not include_unlabeled and not np.any(labels != -1):
                continue

            box = None
            try:
                x1 = float(row.get("x1") or 0.0)
                y1 = float(row.get("y1") or 0.0)
                x2 = float(row.get("x2") or 0.0)
                y2 = float(row.get("y2") or 0.0)
                if x2 > x1 and y2 > y1:
                    box = (x1, y1, x2, y2)
            except Exception:
                box = None

            samples.append(
                TrainingSample(
                    photo_path=str(row.get("foto_path") or ""),
                    face_box=box,
                    targets=labels,
                    source="manual" if manual_tags else "weak",
                )
            )
        return samples

    def build_feature_matrix(self, samples: list[TrainingSample], *, crop_expand: float = 0.65) -> tuple[np.ndarray, np.ndarray]:
        features: list[np.ndarray] = []
        targets: list[np.ndarray] = []
        for sample in samples:
            if not sample.photo_path:
                continue
            try:
                with Image.open(sample.photo_path) as image:
                    rgb = image.convert("RGB")
                    crop = prepare_graduation_crop(rgb, sample.face_box, crop_expand=crop_expand)
                    features.append(extract_graduation_features(crop))
                    targets.append(sample.targets.astype(np.float32))
            except Exception:
                continue
        if not features:
            return np.zeros((0, 12), dtype=np.float32), np.zeros((0, len(GRADUATION_LABELS)), dtype=np.float32)
        return np.stack(features, axis=0).astype(np.float32), np.stack(targets, axis=0).astype(np.float32)
