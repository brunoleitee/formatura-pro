from __future__ import annotations

import os
from typing import Any, Dict

_OCR_STATE: Dict[str, Any] = {
    "checked": False,
    "available": False,
    "message": "OCR não verificado",
    "warning_logged": False,
    "cmd": "",
}


def _configure_tesseract_cmd() -> None:
    cmd = os.environ.get("TESSERACT_CMD", "").strip()
    if not cmd:
        return

    try:
        if os.path.exists(cmd):
            import pytesseract

            pytesseract.pytesseract.tesseract_cmd = cmd
            _OCR_STATE["cmd"] = cmd
    except Exception:
        pass


def _probe_tesseract() -> bool:
    _configure_tesseract_cmd()
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        _OCR_STATE["available"] = True
        _OCR_STATE["message"] = "OCR disponível"
    except Exception:
        _OCR_STATE["available"] = False
        _OCR_STATE["message"] = "Tesseract não instalado ou fora do PATH"
    finally:
        _OCR_STATE["checked"] = True
    return bool(_OCR_STATE["available"])


def is_tesseract_available() -> bool:
    if not _OCR_STATE["checked"]:
        return _probe_tesseract()
    return bool(_OCR_STATE["available"])


def get_tesseract_status() -> Dict[str, Any]:
    if not _OCR_STATE["checked"]:
        _probe_tesseract()
    return {
        "available": bool(_OCR_STATE["available"]),
        "message": _OCR_STATE["message"],
        "cmd": _OCR_STATE["cmd"],
        "checked": bool(_OCR_STATE["checked"]),
        "warning_logged": bool(_OCR_STATE["warning_logged"]),
    }


def log_tesseract_unavailable_once(log_info=None) -> None:
    if is_tesseract_available():
        return
    if _OCR_STATE["warning_logged"]:
        return
    _OCR_STATE["warning_logged"] = True
    if log_info is not None:
        log_info("[OCR] Tesseract indisponível. OCR desativado.")


def run_tesseract_safe(image, config: str = "") -> str:
    if not is_tesseract_available():
        return ""
    try:
        import pytesseract

        return (pytesseract.image_to_string(image, config=config, lang="por") or "").strip()
    except Exception:
        return ""
