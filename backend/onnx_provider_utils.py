from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover - runtime opcional
    ort = None

_cuda_failed = False
_last_provider_mode: Optional[str] = None
_state_lock = threading.Lock()


def _build_cuda_provider_options() -> List[Dict[str, Any]]:
    return [
        {
            "device_id": 0,
            "arena_extend_strategy": "kNextPowerOfTwo",
            "cudnn_conv_algo_search": "DEFAULT",
            "do_copy_in_default_stream": 1,
        },
        {},
    ]


def _log_provider_mode(mode: str, log_info=None) -> None:
    global _last_provider_mode
    if log_info is None:
        return
    with _state_lock:
        if _last_provider_mode == mode:
            return
        _last_provider_mode = mode
    if mode == "cuda":
        log_info("[AI] CUDA ativa")
    else:
        log_info("[AI] CUDA indisponível, usando CPU")


def mark_cuda_failed(log_info=None) -> None:
    global _cuda_failed
    with _state_lock:
        already_failed = _cuda_failed
        _cuda_failed = True
        global _last_provider_mode
        _last_provider_mode = "cpu"
    if not already_failed:
        _log_provider_mode("cpu", log_info=log_info)


def get_onnx_providers(log_info=None, log_debug=None) -> Dict[str, Any]:
    available_providers: List[str] = ["CPUExecutionProvider"]
    provider_error = ""

    if ort is not None:
        try:
            available_providers = list(ort.get_available_providers())
        except Exception as exc:  # pragma: no cover - depende do runtime local
            provider_error = str(exc)
            if log_debug is not None:
                log_debug(f"Erro verificando providers ONNX: {exc}")
            available_providers = ["CPUExecutionProvider"]

    with _state_lock:
        cuda_allowed = (not _cuda_failed) and ("CUDAExecutionProvider" in available_providers)

    if cuda_allowed:
        _log_provider_mode("cuda", log_info=log_info)
        return {
            "available_providers": available_providers,
            "providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
            "provider_options": _build_cuda_provider_options(),
            "provider": "CUDAExecutionProvider",
            "ctx_id": 0,
            "device": "GPU",
            "label": "GPU NVIDIA",
            "cuda_allowed": True,
            "cuda_failed": False,
            "provider_error": provider_error,
        }

    _log_provider_mode("cpu", log_info=log_info)
    return {
        "available_providers": available_providers,
        "providers": ["CPUExecutionProvider"],
        "provider_options": None,
        "provider": "CPUExecutionProvider",
        "ctx_id": -1,
        "device": "CPU",
        "label": "CPU",
        "cuda_allowed": False,
        "cuda_failed": _cuda_failed,
        "provider_error": provider_error,
    }
