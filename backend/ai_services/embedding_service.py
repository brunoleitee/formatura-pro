"""Geração de embeddings de imagem e texto.

O serviço tenta carregar modelos ONNX reais quando os caminhos existem.
Se o modelo não estiver disponível, ele mantém um fallback determinístico
para não quebrar o restante do fluxo do app.
"""

from __future__ import annotations

import hashlib
import math
import os
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence

import numpy as np
from PIL import Image

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover - runtime opcional
    ort = None

try:
    from huggingface_hub import hf_hub_download
except Exception:  # pragma: no cover - runtime opcional
    hf_hub_download = None

try:
    from transformers import CLIPTokenizerFast
except Exception:  # pragma: no cover - runtime opcional
    CLIPTokenizerFast = None

from onnx_provider_utils import get_onnx_providers, get_session_providers, mark_cuda_failed


@dataclass
class EmbeddingConfig:
    dimension: int = 512
    model_name: str = "clip-vit-b32"
    hf_repo_id: str = "inference4j/clip-vit-base-patch32"
    models_dir: Optional[str] = None
    image_model_path: Optional[str] = None
    text_model_path: Optional[str] = None
    tokenizer_path: Optional[str] = None
    image_size: int = 224
    max_text_tokens: int = 77


class PhotoEmbeddingService:
    def __init__(self, config: EmbeddingConfig | None = None, log_debug=None, log_info=None):
        self.config = config or EmbeddingConfig()
        self._log_debug = log_debug or (lambda msg: None)
        self._log_info = log_info or (lambda msg: None)
        self._image_session = None
        self._text_session = None
        self._tokenizer = None
        self._runtime_ready = False

    def configure_runtime(self, *, app_settings: Optional[dict[str, Any]] = None, data_dir: Optional[str] = None) -> None:
        settings = app_settings or {}
        models_dir = settings.get("ai_embedding_models_dir")
        default_base = data_dir or os.getcwd()
        self.config.hf_repo_id = settings.get("ai_embedding_hf_repo_id") or self.config.hf_repo_id
        self.config.models_dir = models_dir or self.config.models_dir
        self.config.image_model_path = settings.get("ai_embedding_image_model_path") or self.config.image_model_path
        self.config.text_model_path = settings.get("ai_embedding_text_model_path") or self.config.text_model_path
        self.config.tokenizer_path = settings.get("ai_embedding_tokenizer_path") or self.config.tokenizer_path
        self.config.dimension = int(settings.get("ai_embedding_dimension") or self.config.dimension)
        self.config.image_size = int(settings.get("ai_embedding_image_size") or self.config.image_size)
        self.config.max_text_tokens = int(settings.get("ai_embedding_max_text_tokens") or self.config.max_text_tokens)

        if not self.config.image_model_path and models_dir:
            candidate = os.path.join(models_dir, "clip_image.onnx")
            if os.path.exists(candidate):
                self.config.image_model_path = candidate
        if not self.config.text_model_path and models_dir:
            candidate = os.path.join(models_dir, "clip_text.onnx")
            if os.path.exists(candidate):
                self.config.text_model_path = candidate

        if not self.config.image_model_path:
            candidate = os.path.join(default_base, "models", "clip_image.onnx")
            if os.path.exists(candidate):
                self.config.image_model_path = candidate
        if not self.config.text_model_path:
            candidate = os.path.join(default_base, "models", "clip_text.onnx")
            if os.path.exists(candidate):
                self.config.text_model_path = candidate

        if not self.config.models_dir and self.config.image_model_path:
            self.config.models_dir = os.path.dirname(self.config.image_model_path)
        if not self.config.models_dir and self.config.text_model_path:
            self.config.models_dir = os.path.dirname(self.config.text_model_path)

        self._runtime_ready = True
        self._image_session = None
        self._text_session = None
        self._tokenizer = None

    def _normalize(self, vector: Sequence[float]) -> List[float]:
        values = np.asarray(list(vector), dtype=np.float32)
        norm = float(np.linalg.norm(values)) or 1.0
        return [round(float(v / norm), 6) for v in values]

    def _pseudo_embedding(self, source: str, dimension: int) -> List[float]:
        seed = hashlib.sha256(source.encode("utf-8", errors="ignore")).digest()
        values: list[float] = []
        counter = 0
        while len(values) < dimension:
            block = hashlib.sha256(seed + counter.to_bytes(4, "little")).digest()
            for byte in block:
                values.append((byte / 255.0) * 2.0 - 1.0)
                if len(values) >= dimension:
                    break
            counter += 1
        norm = math.sqrt(sum(v * v for v in values)) or 1.0
        return [round(v / norm, 6) for v in values]

    def _load_session(self, model_path: Optional[str]):
        if not model_path or ort is None or not os.path.exists(model_path):
            return None
        provider_info = get_onnx_providers(log_debug=self._log_debug)
        providers = provider_info["selected_providers"]
        try:
            session = ort.InferenceSession(model_path, providers=providers)
            real_providers = get_session_providers(session)
            if provider_info["provider"] == "CUDAExecutionProvider" and "CUDAExecutionProvider" not in real_providers:
                mark_cuda_failed()
                self._log_info("[AI] CUDA indisponível, usando CPU")
                try:
                    fallback = get_onnx_providers(log_debug=self._log_debug)
                    return ort.InferenceSession(model_path, providers=fallback["selected_providers"])
                except Exception as cpu_exc:
                    self._log_debug(f"Falha ao carregar ONNX '{model_path}' em CPU: {cpu_exc}")
                    return session
            return session
        except Exception as exc:
            if providers and providers[0] != "CPUExecutionProvider":
                if providers[0] == "CUDAExecutionProvider":
                    mark_cuda_failed()
                    self._log_info("[AI] CUDA indisponível, usando CPU")
                else:
                    self._log_info("[AI] Provider indisponível, usando CPU")
                try:
                    fallback = get_onnx_providers(log_debug=self._log_debug)
                    return ort.InferenceSession(model_path, providers=fallback["selected_providers"])
                except Exception as cpu_exc:
                    self._log_debug(f"Falha ao carregar ONNX '{model_path}' em CPU: {cpu_exc}")
                    return None
            self._log_debug(f"Falha ao carregar ONNX '{model_path}': {exc}")
            return None

    def _resolve_downloaded_file(self, filename: str) -> Optional[str]:
        if not self.config.hf_repo_id or hf_hub_download is None:
            return None
        cache_dir = os.path.join(self.config.models_dir or os.getcwd(), self.config.hf_repo_id.replace("/", "_"))
        os.makedirs(cache_dir, exist_ok=True)
        local_path = os.path.join(cache_dir, filename)
        if os.path.exists(local_path):
            return local_path
        try:
            return hf_hub_download(repo_id=self.config.hf_repo_id, filename=filename, local_dir=cache_dir, local_dir_use_symlinks=False)
        except Exception as exc:
            self._log_debug(f"Falha ao baixar '{filename}' de {self.config.hf_repo_id}: {exc}")
            return None

    def _resolve_model_path(self, configured_path: Optional[str], filename: str) -> Optional[str]:
        if configured_path and os.path.exists(configured_path):
            return configured_path
        if self.config.models_dir:
            candidate = os.path.join(self.config.models_dir, filename)
            if os.path.exists(candidate):
                return candidate
        return self._resolve_downloaded_file(filename)

    def _ensure_tokenizer(self):
        if self._tokenizer is not None:
            return self._tokenizer
        if CLIPTokenizerFast is None:
            return None
        try:
            if self.config.tokenizer_path and os.path.exists(self.config.tokenizer_path):
                self._tokenizer = CLIPTokenizerFast.from_pretrained(self.config.tokenizer_path)
            elif self.config.models_dir and os.path.exists(os.path.join(self.config.models_dir, "vocab.json")):
                self._tokenizer = CLIPTokenizerFast.from_pretrained(self.config.models_dir)
            elif self.config.hf_repo_id:
                self._tokenizer = CLIPTokenizerFast.from_pretrained(self.config.hf_repo_id)
        except Exception as exc:
            self._log_debug(f"Falha ao carregar tokenizer CLIP: {exc}")
            self._tokenizer = None
        return self._tokenizer

    def _ensure_sessions(self) -> None:
        if self._image_session is None:
            image_path = self._resolve_model_path(self.config.image_model_path, "vision_model.onnx")
            self._image_session = self._load_session(image_path)
        if self._text_session is None:
            text_path = self._resolve_model_path(self.config.text_model_path, "text_model.onnx")
            self._text_session = self._load_session(text_path)
        self._ensure_tokenizer()

    def _prepare_image(self, image_path: str) -> np.ndarray:
        image = Image.open(image_path).convert("RGB")
        size = int(self.config.image_size)
        image = image.resize((size, size), Image.Resampling.BICUBIC)
        arr = np.asarray(image).astype(np.float32) / 255.0
        arr = (arr - np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)) / np.array(
            [0.26862954, 0.26130258, 0.27577711],
            dtype=np.float32,
        )
        arr = np.transpose(arr, (2, 0, 1))
        return np.expand_dims(arr, axis=0)

    def _tokenize_text(self, query: str, token_count: int) -> np.ndarray:
        tokenizer = self._ensure_tokenizer()
        if tokenizer is not None:
            inputs = tokenizer(
                query,
                padding="max_length",
                truncation=True,
                max_length=token_count,
                return_tensors="np",
            )
            token_ids = inputs.get("input_ids")
            if token_ids is not None:
                return token_ids.astype(np.int64)
        text = query.strip().lower()
        tokens = text.split()
        ids = [49406]
        for token in tokens[: max(token_count - 2, 1)]:
            digest = hashlib.sha1(token.encode("utf-8", errors="ignore")).digest()
            ids.append(int.from_bytes(digest[:4], "little") % 49408)
        ids.append(49407)
        while len(ids) < token_count:
            ids.append(0)
        return np.asarray([ids[:token_count]], dtype=np.int64)

    def _run_session(self, session, feeds: dict[str, np.ndarray]) -> List[float]:
        output_names = [o.name for o in session.get_outputs()]
        outputs = session.run(output_names or None, feeds)
        if not outputs:
            return []
        tensor = np.asarray(outputs[0]).astype(np.float32).reshape(-1)
        return self._normalize(tensor.tolist())

    def build_image_embedding(self, image_path: str, dimension: int | None = None) -> List[float]:
        """Retorna um vetor da imagem.

        Quando houver modelo ONNX configurado, o embedding vem do modelo.
        Caso contrário, usamos um fallback estável para manter o app funcional.
        """
        self._ensure_sessions()
        if self._image_session is not None:
            try:
                input_name = self._image_session.get_inputs()[0].name
                return self._run_session(self._image_session, {input_name: self._prepare_image(image_path)})
            except Exception as exc:
                self._log_debug(f"Falha no embedding ONNX da imagem '{image_path}': {exc}")
        return self._pseudo_embedding(f"image::{image_path}", dimension or self.config.dimension)

    def build_text_embedding(self, query: str, dimension: int | None = None) -> List[float]:
        """Retorna um vetor do texto digitado pelo usuário."""
        self._ensure_sessions()
        if self._text_session is not None:
            try:
                inputs = self._text_session.get_inputs()
                feeds: dict[str, np.ndarray] = {}
                token_count = self.config.max_text_tokens
                token_ids = self._tokenize_text(query, token_count)
                attention_mask = (token_ids != 0).astype(np.int64)
                for inp in inputs:
                    name = inp.name
                    if "mask" in name.lower():
                        feeds[name] = attention_mask
                    elif "token" in name.lower() or "ids" in name.lower() or inp.type == "tensor(int64)":
                        feeds[name] = token_ids
                    else:
                        feeds[name] = attention_mask if "attention" in name.lower() else np.zeros_like(token_ids, dtype=np.int64)
                return self._run_session(self._text_session, feeds)
            except Exception as exc:
                self._log_debug(f"Falha no embedding ONNX do texto '{query}': {exc}")
        return self._pseudo_embedding(f"text::{query.strip().lower()}", dimension or self.config.dimension)

    def validate_dimension(self, vector: Sequence[float]) -> bool:
        return len(vector) == self.config.dimension
