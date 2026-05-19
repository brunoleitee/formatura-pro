from __future__ import annotations

import os
import threading
from typing import Any, Dict, List

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover - optional runtime dependency
    ort = None

_dml_failed = False
_state_lock = threading.Lock()
FORCE_CPU_ONNX = os.environ.get("FORCE_CPU_ONNX", "0") == "1"


def mark_cuda_failed() -> None:
    """Compatibilidade — não faz nada (CUDA não é mais usado)."""
    pass


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
    """Seleciona o melhor provider: DirectML → CPU."""
    global _dml_failed
    available_providers: List[str] = ["CPUExecutionProvider"]
    provider_error = ""

    if ort is not None:
        try:
            available_providers = list(ort.get_available_providers() or [])
        except Exception as exc:
            provider_error = str(exc)
            if log_debug is not None:
                log_debug(f"Erro verificando providers ONNX: {exc}")
            available_providers = ["CPUExecutionProvider"]

    # ── FORCE_CPU: pula tudo ──
    if FORCE_CPU_ONNX:
        return _build_result(available_providers, "CPUExecutionProvider",
                             provider_error=provider_error)

    # ── Tenta DirectML (qualquer GPU Windows) ──
    if "DmlExecutionProvider" in available_providers and not _dml_failed:
        return _build_result(available_providers, "DmlExecutionProvider",
                             provider_error=provider_error)

    # ── Fallback: CPU ──
    if log_debug:
        log_debug(f"[ONNX] DirectML indisponivel, usando CPU. Providers: {available_providers}")
    return _build_result(available_providers, "CPUExecutionProvider",
                         provider_error=provider_error)


def _build_result(available_providers: List[str], provider_name: str,
                  provider_error: str = "") -> Dict[str, Any]:
    """Monta o dict de resultado padronizado."""
    if provider_name == "DmlExecutionProvider":
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
