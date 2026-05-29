"""Classificador multi-label leve para itens de formatura.

O serviço tenta carregar um modelo ONNX local quando o arquivo existe.
Quando o modelo ainda não estiver disponível, usa um fallback conservador
local, sem HSV e sem VLM, para manter a revisão funcional.
"""

from __future__ import annotations

import hashlib
import math
import os
import threading
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import numpy as np
from PIL import Image, ImageOps

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover - runtime opcional
    ort = None

from onnx_provider_utils import get_onnx_providers, get_session_providers, mark_cuda_failed

GRADUATION_LABELS: tuple[str, ...] = ("beca", "faixa", "capelo", "canudo", "jabor")


@dataclass(slots=True)
class GraduationClassifierConfig:
    model_path: str | None = None
    models_dir: str | None = None
    image_size: int = 224
    batch_size: int = 32
    crop_expand: float = 0.65


def _clamp01(value: float) -> float:
    return float(max(0.0, min(1.0, value)))


def _sigmoid(x: float) -> float:
    return float(1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, x)))))


class GraduationClassifier:
    def __init__(self, config: GraduationClassifierConfig | None = None, *, log_info=None, log_debug=None):
        self.config = config or GraduationClassifierConfig()
        self._log_info = log_info or (lambda msg: None)
        self._log_debug = log_debug or (lambda msg: None)
        self._session = None
        self._session_lock = threading.Lock()
        self._runtime_ready = False
        self._fallback_logged = False

    def configure_runtime(self, *, app_settings: dict[str, Any] | None = None, data_dir: str | None = None) -> None:
        settings = app_settings or {}
        base_dir = data_dir or os.getcwd()
        self.config.batch_size = int(settings.get("graduation_classifier_batch_size") or self.config.batch_size)
        self.config.image_size = int(settings.get("graduation_classifier_image_size") or self.config.image_size)
        self.config.crop_expand = float(settings.get("graduation_classifier_crop_expand") or self.config.crop_expand)

        configured_model = settings.get("graduation_classifier_model_path") or self.config.model_path
        if configured_model and os.path.exists(configured_model):
            self.config.model_path = configured_model
        else:
            candidates = [
                os.path.join(base_dir, "ai", "models", "graduation_classifier.onnx"),
                os.path.join(base_dir, "backend", "ai", "models", "graduation_classifier.onnx"),
                os.path.join(base_dir, "models", "graduation_classifier.onnx"),
            ]
            for candidate in candidates:
                if os.path.exists(candidate):
                    self.config.model_path = candidate
                    break

        self.config.models_dir = settings.get("graduation_classifier_models_dir") or self.config.models_dir
        if not self.config.models_dir and self.config.model_path:
            self.config.models_dir = os.path.dirname(self.config.model_path)

        self._session = None
        self._runtime_ready = True

    def _resolve_model_path(self) -> str | None:
        if self.config.model_path and os.path.exists(self.config.model_path):
            return self.config.model_path
        if self.config.models_dir:
            candidate = os.path.join(self.config.models_dir, "graduation_classifier.onnx")
            if os.path.exists(candidate):
                return candidate
        return None

    def _load_session(self):
        model_path = self._resolve_model_path()
        if not model_path or ort is None:
            return None
        provider_info = get_onnx_providers(log_debug=self._log_debug)
        providers = provider_info["selected_providers"]
        try:
            session = ort.InferenceSession(model_path, providers=providers)
            real_providers = get_session_providers(session)
            if provider_info["provider"] == "CUDAExecutionProvider" and "CUDAExecutionProvider" not in real_providers:
                mark_cuda_failed()
                self._log_info("[GraduationClassifier] CUDA indisponível, usando CPU")
                fallback = get_onnx_providers(log_debug=self._log_debug)
                return ort.InferenceSession(model_path, providers=fallback["selected_providers"])
            self._log_info(f"[GraduationClassifier] modelo carregado: {model_path}")
            return session
        except Exception as exc:
            if providers and providers[0] == "CUDAExecutionProvider":
                mark_cuda_failed()
                self._log_info("[GraduationClassifier] CUDA indisponível, usando CPU")
                try:
                    fallback = get_onnx_providers(log_debug=self._log_debug)
                    return ort.InferenceSession(model_path, providers=fallback["selected_providers"])
                except Exception as cpu_exc:
                    self._log_debug(f"Falha ao carregar GraduationClassifier em CPU: {cpu_exc}")
                    return None
            self._log_debug(f"Falha ao carregar GraduationClassifier '{model_path}': {exc}")
            return None

    def _ensure_session(self):
        if self._session is not None or self._runtime_ready:
            return self._session
        with self._session_lock:
            if self._session is None:
                self._session = self._load_session()
                if self._session is None and not self._fallback_logged:
                    self._fallback_logged = True
                    self._log_info("[GraduationClassifier] modelo ONNX não encontrado; usando fallback local conservador")
        self._runtime_ready = True
        return self._session

    def _load_image(self, path: str) -> Image.Image | None:
        if not path or not os.path.exists(path):
            return None
        try:
            with Image.open(path) as image:
                return image.convert("RGB")
        except Exception as exc:
            self._log_debug(f"Falha ao abrir imagem '{path}': {exc}")
            return None

    def _pick_primary_box(self, boxes: Sequence[Sequence[float]] | None) -> tuple[float, float, float, float] | None:
        if not boxes:
            return None
        best = None
        best_area = -1.0
        for box in boxes:
            if len(box) < 4:
                continue
            x1, y1, x2, y2 = [float(v) for v in box[:4]]
            area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
            if area > best_area:
                best_area = area
                best = (x1, y1, x2, y2)
        return best

    def _expand_box(self, box: tuple[float, float, float, float], width: int, height: int) -> tuple[int, int, int, int]:
        x1, y1, x2, y2 = box
        face_w = max(1.0, x2 - x1)
        face_h = max(1.0, y2 - y1)
        cx = (x1 + x2) / 2.0
        top = y1 - (face_h * 0.35)
        bottom = y2 + (face_h * (1.9 + self.config.crop_expand))
        left = cx - (face_w * (1.25 + self.config.crop_expand * 0.2))
        right = cx + (face_w * (1.25 + self.config.crop_expand * 0.2))
        return (
            int(max(0, math.floor(left))),
            int(max(0, math.floor(top))),
            int(min(width, math.ceil(right))),
            int(min(height, math.ceil(bottom))),
        )

    def _prepare_crop(self, image: Image.Image, box: tuple[float, float, float, float] | None) -> Image.Image:
        width, height = image.size
        if box is None:
            left = int(width * 0.18)
            top = int(height * 0.04)
            right = int(width * 0.82)
            bottom = int(height * 0.86)
        else:
            left, top, right, bottom = self._expand_box(box, width, height)
        if right <= left or bottom <= top:
            left, top, right, bottom = 0, 0, width, height
        return image.crop((left, top, right, bottom))

    def _normalize_batch(self, images: Iterable[Image.Image]) -> np.ndarray:
        arrays = []
        size = int(self.config.image_size)
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        for image in images:
            resized = ImageOps.fit(image, (size, size), method=Image.Resampling.BICUBIC)
            arr = np.asarray(resized, dtype=np.float32) / 255.0
            arr = (arr - mean) / std
            arr = np.transpose(arr, (2, 0, 1))
            arrays.append(arr)
        if not arrays:
            return np.zeros((0, 3, size, size), dtype=np.float32)
        return np.stack(arrays, axis=0).astype(np.float32)

    def _fallback_features(self, crop: Image.Image) -> np.ndarray:
        gray = ImageOps.grayscale(crop)
        arr = np.asarray(gray, dtype=np.float32) / 255.0
        h, w = arr.shape
        top = arr[: max(1, h // 3), :]
        mid = arr[h // 3: max(h // 3 + 1, (2 * h) // 3), :]
        bottom = arr[max(1, (2 * h) // 3):, :]
        center = arr[h // 4: max(h // 4 + 1, (3 * h) // 4), w // 4: max(w // 4 + 1, (3 * w) // 4)]
        dx = np.abs(np.diff(arr, axis=1)).mean() if w > 1 else 0.0
        dy = np.abs(np.diff(arr, axis=0)).mean() if h > 1 else 0.0
        lap = np.abs(np.diff(arr, n=2, axis=0)).mean() if h > 2 else 0.0
        contrast = float(arr.max() - arr.min())
        top_mean = float(top.mean()) if top.size else 0.0
        mid_mean = float(mid.mean()) if mid.size else 0.0
        bottom_mean = float(bottom.mean()) if bottom.size else 0.0
        center_std = float(center.std()) if center.size else 0.0
        edge_like = float((dx + dy + lap) / 3.0)
        return np.array(
            [
                float(arr.mean()),
                float(arr.std()),
                edge_like,
                top_mean - bottom_mean,
                mid_mean - top_mean,
                contrast,
                center_std,
                float(w) / max(1.0, float(h)),
            ],
            dtype=np.float32,
        )

    def _fallback_scores(self, crop: Image.Image) -> dict[str, float]:
        features = self._fallback_features(crop)
        weights = {
            "beca": np.array([0.18, 0.12, 0.10, 0.05, 0.08, 0.12, 0.06, -0.04], dtype=np.float32),
            "faixa": np.array([0.08, 0.10, 0.08, 0.14, 0.10, 0.06, 0.04, 0.02], dtype=np.float32),
            "capelo": np.array([0.06, 0.09, 0.12, -0.01, 0.16, 0.08, 0.05, -0.02], dtype=np.float32),
            "canudo": np.array([0.03, 0.05, 0.03, 0.00, -0.02, 0.04, 0.02, -0.05], dtype=np.float32),
            "jabor": np.array([0.10, 0.08, 0.06, -0.02, 0.08, 0.05, 0.03, -0.03], dtype=np.float32),
        }
        bias = {
            "beca": -1.8,
            "faixa": -1.9,
            "capelo": -1.95,
            "canudo": -2.1,
            "jabor": -1.85,
        }
        scores: dict[str, float] = {}
        for label in GRADUATION_LABELS:
            raw = float(np.dot(features, weights[label]) + bias[label])
            scores[label] = round(_clamp01(_sigmoid(raw)), 4)
        return scores

    def _run_session(self, batch: np.ndarray) -> list[dict[str, float]]:
        if self._ensure_session() is None or batch.size == 0:
            return []
        assert self._session is not None
        inputs = self._session.get_inputs()
        if not inputs:
            return []
        input_name = inputs[0].name
        try:
            outputs = self._session.run(None, {input_name: batch})
            if not outputs:
                return []
            logits = np.asarray(outputs[0], dtype=np.float32)
            if logits.ndim == 1:
                logits = logits.reshape(1, -1)
            if logits.shape[-1] < len(GRADUATION_LABELS):
                return []
            scores: list[dict[str, float]] = []
            for row in logits:
                row_scores = {
                    label: round(_clamp01(float(row[idx])), 4)
                    for idx, label in enumerate(GRADUATION_LABELS)
                }
                scores.append(row_scores)
            return scores
        except Exception as exc:
            self._log_debug(f"Falha na inferência GraduationClassifier: {exc}")
            return []

    def predict_batch(self, items: Sequence[dict[str, Any]]) -> list[dict[str, float]]:
        if not items:
            return []
        images: list[Image.Image] = []
        fallback_indexes: list[int] = []
        fallback_results: list[dict[str, float] | None] = [None] * len(items)
        for idx, item in enumerate(items):
            photo_path = str(item.get("photo_path") or item.get("path") or "")
            image = self._load_image(photo_path)
            if image is None:
                fallback_results[idx] = {label: 0.0 for label in GRADUATION_LABELS}
                continue
            box = self._pick_primary_box(item.get("face_boxes") or item.get("face_box") or [])
            crop = self._prepare_crop(image, box)
            images.append(crop)
            fallback_indexes.append(idx)

        if not images:
            return [result or {label: 0.0 for label in GRADUATION_LABELS} for result in fallback_results]

        batch = self._normalize_batch(images)
        session_scores = self._run_session(batch)
        if not session_scores:
            session_scores = [self._fallback_scores(crop) for crop in images]

        for out_idx, result in zip(fallback_indexes, session_scores):
            fallback_results[out_idx] = result

        return [result or {label: 0.0 for label in GRADUATION_LABELS} for result in fallback_results]

    def predict(self, item: dict[str, Any]) -> dict[str, float]:
        return self.predict_batch([item])[0]


_CLASSIFIER_INSTANCE: GraduationClassifier | None = None
_CLASSIFIER_LOCK = threading.Lock()


def get_graduation_classifier() -> GraduationClassifier:
    global _CLASSIFIER_INSTANCE
    if _CLASSIFIER_INSTANCE is None:
        with _CLASSIFIER_LOCK:
            if _CLASSIFIER_INSTANCE is None:
                _CLASSIFIER_INSTANCE = GraduationClassifier()
    return _CLASSIFIER_INSTANCE
