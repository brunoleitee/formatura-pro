from __future__ import annotations

import os
import threading
import ctypes
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover - optional runtime dependency
    ort = None

_cuda_failed = False
_cuda_preflight_done = False
_cuda_preflight_error = ""
_state_lock = threading.Lock()
FORCE_CPU_ONNX = os.environ.get("FORCE_CPU_ONNX", "0") == "1"


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


def mark_cuda_failed() -> None:
    global _cuda_failed
    with _state_lock:
        _cuda_failed = True


def _cuda_provider_loadable() -> bool:
    global _cuda_preflight_done, _cuda_preflight_error, _cuda_failed
    if os.name != "nt" or ort is None:
        return True

    with _state_lock:
        if _cuda_preflight_done:
            return not _cuda_failed

    error = ""
    loadable = True
    try:
        ort_dir = Path(getattr(ort, "__file__", "")).resolve().parent
        candidates = [
            ort_dir / "capi" / "onnxruntime_providers_cuda.dll",
            ort_dir / "onnxruntime_providers_cuda.dll",
        ]
        cuda_dll = next((path for path in candidates if path.exists()), None)
        if cuda_dll is not None:
            ctypes.CDLL(str(cuda_dll))
        else:
            loadable = False
            error = "Rodando em CPU (CUDA não disponível)"
    except Exception as exc:
        loadable = False
        error = str(exc)

    with _state_lock:
        _cuda_preflight_done = True
        if not loadable:
            _cuda_failed = True
            _cuda_preflight_error = error
    return loadable


def get_session_providers(target: Any) -> List[str]:
    if target is None:
        return []

    candidates = [target]
    models = getattr(target, "models", None)
    if isinstance(models, dict):
        candidates.extend(models.values())
    elif models is not None:
        candidates.append(models)

    for candidate in candidates:
        try:
            session = getattr(candidate, "session", None)
            if session is not None and hasattr(session, "get_providers"):
                providers = list(session.get_providers() or [])
                if providers:
                    return providers
            if hasattr(candidate, "get_providers"):
                providers = list(candidate.get_providers() or [])
                if providers:
                    return providers
        except Exception:
            continue

    return []


def get_onnx_providers(log_debug=None) -> Dict[str, Any]:
    available_providers: List[str] = ["CPUExecutionProvider"]
    provider_error = ""

    if ort is not None:
        try:
            available_providers = list(ort.get_available_providers() or [])
        except Exception as exc:  # pragma: no cover - runtime specific
            provider_error = str(exc)
            if log_debug is not None:
                log_debug(f"Erro verificando providers ONNX: {exc}")
            available_providers = ["CPUExecutionProvider"]

    with _state_lock:
        cuda_failed = _cuda_failed

    if FORCE_CPU_ONNX or cuda_failed:
        return {
            "available_providers": available_providers,
            "selected_providers": ["CPUExecutionProvider"],
            "providers": ["CPUExecutionProvider"],
            "provider_options": None,
            "provider": "CPUExecutionProvider",
            "ctx_id": -1,
            "device": "CPU",
            "label": "CPU",
            "cuda_allowed": False,
            "cuda_failed": True,
            "provider_error": provider_error,
        }

    if "CUDAExecutionProvider" in available_providers:
        if _cuda_provider_loadable():
            return {
                "available_providers": available_providers,
                "selected_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
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
        with _state_lock:
            cuda_preflight_error = _cuda_preflight_error
        return {
            "available_providers": available_providers,
            "selected_providers": ["CPUExecutionProvider"],
            "providers": ["CPUExecutionProvider"],
            "provider_options": None,
            "provider": "CPUExecutionProvider",
            "ctx_id": -1,
            "device": "CPU",
            "label": "CPU",
            "cuda_allowed": False,
            "cuda_failed": True,
            "provider_error": provider_error or cuda_preflight_error,
        }

    if "DmlExecutionProvider" in available_providers:
        return {
            "available_providers": available_providers,
            "selected_providers": ["DmlExecutionProvider", "CPUExecutionProvider"],
            "providers": ["DmlExecutionProvider", "CPUExecutionProvider"],
            "provider_options": None,
            "provider": "DmlExecutionProvider",
            "ctx_id": 0,
            "device": "GPU",
            "label": "GPU DirectML",
            "cuda_allowed": False,
            "cuda_failed": False,
            "provider_error": provider_error,
        }

    return {
        "available_providers": available_providers,
        "selected_providers": ["CPUExecutionProvider"],
        "providers": ["CPUExecutionProvider"],
        "provider_options": None,
        "provider": "CPUExecutionProvider",
        "ctx_id": -1,
        "device": "CPU",
        "label": "CPU",
        "cuda_allowed": False,
        "cuda_failed": False,
        "provider_error": provider_error,
    }
