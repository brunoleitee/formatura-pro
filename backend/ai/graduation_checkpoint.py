"""Checkpoint leve para o classificador de itens de formatura."""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Sequence

import numpy as np
from PIL import Image

from .graduation_features import (
    GRADUATION_FEATURE_NAMES,
    GRADUATION_LABELS,
    extract_graduation_features,
    pick_primary_box,
    prepare_graduation_crop,
)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -60.0, 60.0)))


def _clamp01(value: float) -> float:
    return float(max(0.0, min(1.0, value)))


@dataclass(slots=True)
class GraduationCheckpoint:
    labels: tuple[str, ...] = GRADUATION_LABELS
    feature_names: tuple[str, ...] = GRADUATION_FEATURE_NAMES
    feature_mean: np.ndarray = field(default_factory=lambda: np.zeros(len(GRADUATION_FEATURE_NAMES), dtype=np.float32))
    feature_std: np.ndarray = field(default_factory=lambda: np.ones(len(GRADUATION_FEATURE_NAMES), dtype=np.float32))
    weights: np.ndarray = field(default_factory=lambda: np.zeros((len(GRADUATION_LABELS), len(GRADUATION_FEATURE_NAMES)), dtype=np.float32))
    bias: np.ndarray = field(default_factory=lambda: np.zeros(len(GRADUATION_LABELS), dtype=np.float32))
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GraduationCheckpoint":
        labels = tuple(data.get("labels") or GRADUATION_LABELS)
        feature_names = tuple(data.get("feature_names") or GRADUATION_FEATURE_NAMES)
        feature_mean = np.asarray(data.get("feature_mean") or np.zeros(len(feature_names)), dtype=np.float32)
        feature_std = np.asarray(data.get("feature_std") or np.ones(len(feature_names)), dtype=np.float32)
        weights = np.asarray(data.get("weights") or np.zeros((len(labels), len(feature_names))), dtype=np.float32)
        bias = np.asarray(data.get("bias") or np.zeros(len(labels)), dtype=np.float32)
        metadata = dict(data.get("metadata") or {})
        return cls(
            labels=labels,
            feature_names=feature_names,
            feature_mean=feature_mean,
            feature_std=feature_std,
            weights=weights,
            bias=bias,
            metadata=metadata,
        )

    @classmethod
    def load(cls, path: str) -> "GraduationCheckpoint":
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return cls.from_dict(data)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": "graduation_classifier_checkpoint_v1",
            "labels": list(self.labels),
            "feature_names": list(self.feature_names),
            "feature_mean": self.feature_mean.astype(float).tolist(),
            "feature_std": self.feature_std.astype(float).tolist(),
            "weights": self.weights.astype(float).tolist(),
            "bias": self.bias.astype(float).tolist(),
            "metadata": dict(self.metadata),
        }

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        payload = self.to_dict()
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

    def _normalize_features(self, features: np.ndarray) -> np.ndarray:
        scale = np.where(np.abs(self.feature_std) < 1e-6, 1.0, self.feature_std)
        return (features - self.feature_mean) / scale

    def predict_features(self, features: np.ndarray) -> dict[str, float]:
        x = np.asarray(features, dtype=np.float32).reshape(1, -1)
        normalized = self._normalize_features(x)
        logits = normalized @ self.weights.T + self.bias
        probs = _sigmoid(logits)[0]
        return {label: round(_clamp01(float(probs[idx])), 4) for idx, label in enumerate(self.labels)}

    def predict_crop(self, crop: Image.Image) -> dict[str, float]:
        features = extract_graduation_features(crop)
        return self.predict_features(features)

    def predict_batch_from_crops(self, crops: Sequence[Image.Image]) -> list[dict[str, float]]:
        return [self.predict_crop(crop) for crop in crops]

    def predict_batch(self, items: Sequence[dict[str, Any]], *, crop_expand: float = 0.65) -> list[dict[str, float]]:
        results: list[dict[str, float]] = []
        for item in items:
            photo_path = str(item.get("photo_path") or item.get("path") or "")
            face_boxes = item.get("face_boxes") or item.get("face_box") or []
            if not photo_path or not os.path.exists(photo_path):
                results.append({label: 0.0 for label in self.labels})
                continue

            try:
                with Image.open(photo_path) as image:
                    rgb = image.convert("RGB")
                    is_box_sequence = isinstance(face_boxes, Sequence) and not isinstance(face_boxes, (str, bytes))
                    box = pick_primary_box(face_boxes if is_box_sequence else [])
                    crop = prepare_graduation_crop(rgb, box, crop_expand=crop_expand)
                    results.append(self.predict_crop(crop))
            except Exception:
                results.append({label: 0.0 for label in self.labels})
        return results
