import os
import subprocess
import sys
import urllib.parse

from fastapi import HTTPException

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    value = _get(name, default)
    return value() if callable(value) else value


def find_photoshop_path():
    app_settings = _value("app_settings", {})
    if app_settings.get("photoshop_path"):
        p = app_settings["photoshop_path"]
        if os.path.exists(p):
            return p

    common_paths = [
        r"C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2024\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2023\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2022\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2021\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2020\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop CC 2019\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop CC 2018\Photoshop.exe",
    ]
    for p in common_paths:
        if os.path.exists(p):
            return p

    adobe_root = r"C:\Program Files\Adobe"
    if os.path.exists(adobe_root):
        try:
            for d in sorted(os.listdir(adobe_root), reverse=True):
                if "Photoshop" in d:
                    candidate = os.path.join(adobe_root, d, "Photoshop.exe")
                    if os.path.exists(candidate):
                        return candidate
        except Exception:
            pass

    return None


def open_folder(path: str):
    path = os.path.abspath(urllib.parse.unquote(path or ""))
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail="Pasta nao encontrada")
    try:
        if os.name == "nt":
            subprocess.Popen(
                ["explorer.exe", path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "ok"}


def open_photoshop(path: str):
    path = os.path.normpath(path or "")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Arquivo nao encontrado")

    ps_path = find_photoshop_path()
    try:
        if ps_path:
            subprocess.Popen([ps_path, path])
        else:
            if os.name == "nt":
                os.startfile(path)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "ok", "method": "photoshop" if ps_path else "default"}


def open_file(path: str):
    path = os.path.abspath(urllib.parse.unquote(path or ""))
    if not os.path.exists(path):
        folder = os.path.dirname(path)
        requested_name = os.path.basename(path).lower()
        if (
            requested_name.startswith("relatorio_exportacao_formaturapro")
            and requested_name.endswith(".pdf")
            and os.path.isdir(folder)
        ):
            matches = []
            try:
                for name in os.listdir(folder):
                    lower = name.lower()
                    if lower.startswith("relatorio_exportacao_formaturapro") and lower.endswith(".pdf"):
                        candidate = os.path.join(folder, name)
                        matches.append((os.path.getmtime(candidate), candidate))
            except Exception:
                matches = []
            if matches:
                path = sorted(matches, reverse=True)[0][1]
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail="Arquivo nao encontrado")
    try:
        if os.name == "nt":
            os.startfile(path)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "ok"}


def open_path(path: str):
    path = os.path.abspath(urllib.parse.unquote(path or ""))
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Caminho nao encontrado")
    try:
        if os.name == "nt":
            os.startfile(path)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "ok", "path": path, "kind": "folder" if os.path.isdir(path) else "file"}


def select_folder():
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askdirectory()
    root.destroy()
    return {"path": path}


def select_image():
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askopenfilename(filetypes=[
        ("Imagens", "*.jpg *.jpeg *.png"),
        ("Todos os arquivos", "*.*"),
    ])
    root.destroy()
    return {"path": path}
