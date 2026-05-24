import os
import contextlib
import logging
import io
from typing import Any

# Central cache for catalog stats
_catalog_stats_cache: dict[str, tuple[dict, float]] = {}
_CATALOG_STATS_TTL = 3.5

def _invalidate_stats_caches():
    """Limpa caches de estatísticas de catálogo para forçar recarregamento"""
    _catalog_stats_cache.clear()
    try:
        import system_manager as sm
        sm._invalidate_stats_cache()
    except Exception:
        pass

def log_debug(msg, *args, **kwargs):
    logging.debug(msg, *args, **kwargs)

def log_info(msg, *args, **kwargs):
    logging.info(msg, *args, **kwargs)

@contextlib.contextmanager
def quiet_external_output(verbose=False):
    if verbose:
        yield
        return
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield

@contextlib.contextmanager
def _suppress_stdout():
    import sys
    from io import StringIO
    old = sys.stdout
    sys.stdout = StringIO()
    try:
        yield
    finally:
        sys.stdout = old

def validate_config(cfg: dict[str, Any], required: list[str], module: str = "") -> None:
    """Valida em startup se todas as chaves obrigatórias foram injetadas no _cfg."""
    missing = [k for k in required if k not in cfg]
    if missing:
        raise RuntimeError(
            f"Configuração incompleta para {module or 'módulo'}: "
            f"chaves faltando: {', '.join(missing)}"
        )


def sanitize_catalog_name(name):
    """Limpa nome de catálogos para ser usado como nome de pasta/arquivo"""
    cleaned = "".join(
        ch for ch in (name or "").strip().replace(" ", "_")
        if ch.isalnum() or ch in ("_", "-", ".")
    ).strip("._")
    if not cleaned:
        raise ValueError("Nome de catalogo vazio ou invalido")
    return cleaned

def sanitize_folder_name(name):
    """Remove caracteres inválidos para nomes de pastas no Windows/Linux/Mac."""
    if name is None:
        return "Desconhecido"
    sanitized = str(name)
    invalid_chars = '/\\:*?"<>|'
    for char in invalid_chars:
        sanitized = sanitized.replace(char, "_")
    return sanitized.strip() or "Sem_Nome"
