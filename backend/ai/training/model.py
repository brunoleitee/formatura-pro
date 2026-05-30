"""Treinador simples multi-label para o classificador de formatura."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Sequence

import numpy as np

from ..graduation_checkpoint import GraduationCheckpoint
from ..graduation_features import GRADUATION_FEATURE_NAMES, GRADUATION_LABELS


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -60.0, 60.0)))


def _safe_std(values: np.ndarray) -> np.ndarray:
    std = values.std(axis=0).astype(np.float32)
    std[std < 1e-6] = 1.0
    return std


@dataclass(slots=True)
class TrainingReport:
    epochs: int
    samples: int
    losses: list[float] = field(default_factory=list)
    positives: dict[str, int] = field(default_factory=dict)
    active_labels: tuple[str, ...] = field(default_factory=tuple)
    inactive_labels: tuple[str, ...] = field(default_factory=tuple)


@dataclass(slots=True)
class GraduationLinearModel:
    feature_mean: np.ndarray
    feature_std: np.ndarray
    weights: np.ndarray
    bias: np.ndarray

    def to_checkpoint(self, *, metadata: dict[str, Any] | None = None) -> GraduationCheckpoint:
        return GraduationCheckpoint(
            feature_mean=self.feature_mean.astype(np.float32),
            feature_std=self.feature_std.astype(np.float32),
            weights=self.weights.astype(np.float32),
            bias=self.bias.astype(np.float32),
            metadata=metadata or {},
        )

    def predict_features(self, features: np.ndarray) -> dict[str, float]:
        checkpoint = self.to_checkpoint()
        return checkpoint.predict_features(features)


class GraduationModelTrainer:
    def __init__(
        self,
        *,
        labels: Sequence[str] = GRADUATION_LABELS,
        feature_names: Sequence[str] = GRADUATION_FEATURE_NAMES,
        learning_rate: float = 0.15,
        epochs: int = 320,
        l2: float = 0.0015,
        seed: int = 42,
    ):
        self.labels = tuple(labels)
        self.feature_names = tuple(feature_names)
        self.learning_rate = float(learning_rate)
        self.epochs = int(epochs)
        self.l2 = float(l2)
        self.seed = int(seed)

    def train(self, features: np.ndarray, targets: np.ndarray) -> tuple[GraduationLinearModel, TrainingReport]:
        if features.ndim != 2:
            raise ValueError("features deve ter forma [amostras, features]")
        if targets.ndim != 2:
            raise ValueError("targets deve ter forma [amostras, classes]")
        if features.shape[0] != targets.shape[0]:
            raise ValueError("features e targets precisam ter o mesmo número de amostras")
        if targets.shape[1] != len(self.labels):
            raise ValueError("targets precisa ter uma coluna por classe")

        x_mean = features.mean(axis=0).astype(np.float32)
        x_std = _safe_std(features.astype(np.float32))
        x_norm = (features.astype(np.float32) - x_mean) / x_std

        rng = np.random.default_rng(self.seed)
        weights = rng.normal(0.0, 0.02, size=(len(self.labels), x_norm.shape[1])).astype(np.float32)
        bias = np.zeros(len(self.labels), dtype=np.float32)

        positives = {label: int(np.sum(targets[:, idx] == 1)) for idx, label in enumerate(self.labels)}
        active_indices = [idx for idx, label in enumerate(self.labels) if positives[label] > 0]
        inactive_indices = [idx for idx in range(len(self.labels)) if idx not in active_indices]
        if not active_indices:
            raise ValueError("Nenhuma classe positiva encontrada para treino.")

        active_labels = tuple(self.labels[idx] for idx in active_indices)
        active_targets = targets[:, active_indices].astype(np.float32)
        known_mask = active_targets != -1
        positive_weight = np.ones(len(active_labels), dtype=np.float32)
        for idx, label in enumerate(active_labels):
            pos = max(1, int(np.sum(active_targets[:, idx] == 1)))
            neg = max(1, int(np.sum(known_mask[:, idx])) - pos)
            positive_weight[idx] = float(neg / pos)

        losses: list[float] = []
        normalizer = max(1, int(np.sum(known_mask)))
        for epoch in range(self.epochs):
            logits = x_norm @ weights[active_indices].T + bias[active_indices]
            probs = _sigmoid(logits)

            target = np.where(known_mask, active_targets, probs)
            pos_mask = (active_targets == 1).astype(np.float32)
            sample_weight = np.where(pos_mask > 0, positive_weight, 1.0).astype(np.float32)
            sample_weight = np.where(known_mask, sample_weight, 0.0)

            diff = (probs - target) * sample_weight
            grad_w = (diff.T @ x_norm) / normalizer + (self.l2 * weights[active_indices])
            grad_b = diff.sum(axis=0) / normalizer

            weights[active_indices] -= self.learning_rate * grad_w
            bias[active_indices] -= self.learning_rate * grad_b

            clipped = np.clip(probs, 1e-6, 1.0 - 1e-6)
            loss_matrix = np.where(
                known_mask,
                -(active_targets * np.log(clipped) + (1.0 - active_targets) * np.log(1.0 - clipped)),
                0.0,
            )
            weighted_loss = float(np.sum(loss_matrix * np.where(pos_mask > 0, positive_weight, 1.0)) / normalizer)
            losses.append(weighted_loss)

            if epoch > 25 and abs(losses[-2] - losses[-1]) < 1e-5:
                break

        model = GraduationLinearModel(feature_mean=x_mean, feature_std=x_std, weights=weights, bias=bias)
        report = TrainingReport(
            epochs=len(losses),
            samples=int(features.shape[0]),
            losses=losses,
            positives=positives,
            active_labels=active_labels,
            inactive_labels=tuple(self.labels[idx] for idx in inactive_indices),
        )
        return model, report

    @staticmethod
    def build_metadata(
        *,
        catalog: str,
        samples: int,
        report: TrainingReport,
    ) -> dict[str, Any]:
        return {
            "catalog": catalog,
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "samples": samples,
            "epochs": report.epochs,
            "loss_final": report.losses[-1] if report.losses else None,
            "positives": report.positives,
            "active_labels": list(report.active_labels),
            "inactive_labels": list(report.inactive_labels),
            "labels": list(GRADUATION_LABELS),
            "feature_names": list(GRADUATION_FEATURE_NAMES),
        }
