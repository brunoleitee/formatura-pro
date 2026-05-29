import csv
import os
import subprocess
import sys
import time
import urllib.parse
from collections import defaultdict

from fastapi import HTTPException, Query

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    value = _get(name, default)
    return value() if callable(value) else value


def open_logs():
    data_dir = _get("data_dir")
    os.makedirs(data_dir, exist_ok=True)
    try:
        if sys.platform.startswith("win"):
            os.startfile(data_dir)
        else:
            subprocess.Popen(["xdg-open", data_dir])
    except Exception as e:
        raise HTTPException(500, f"Não foi possível abrir logs: {e}")
    return {"status": "ok", "path": data_dir}


def open_app_folder():
    data_dir = _get("data_dir")
    os.makedirs(data_dir, exist_ok=True)
    try:
        if os.name == "nt":
            subprocess.Popen(["explorer.exe", data_dir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", data_dir])
        else:
            subprocess.Popen(["xdg-open", data_dir])
    except Exception as e:
        raise HTTPException(500, f"Não foi possível abrir a pasta do projeto: {e}")
    return {"status": "ok", "path": data_dir}


def create_catalog_backup(reason: str = Query("manual")):
    backup_catalog_db = _get("backup_catalog_db")
    current_catalog = _value("get_current_catalog")
    path = backup_catalog_db(current_catalog, reason)
    return {"status": "ok", "path": path}


def event_problems_report(catalog: str = ""):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    get_pendencies = _get("get_pendencies")
    data_dir = _get("data_dir")
    get_current_catalog = _value("get_current_catalog")
    use_cat = sanitize_catalog_name(catalog if catalog else get_current_catalog)
    data = get_pendencies(use_cat, "all")
    os.makedirs(data_dir, exist_ok=True)
    report_path = os.path.join(data_dir, f"relatorio_pendencias_{use_cat}_{time.strftime('%Y%m%d_%H%M%S')}.csv")
    rows = [
        ["Tipo", "ID/Arquivo", "Quantidade", "Detalhe"],
        ["Resumo", "Todas as fotos", data.get("summary", {}).get("all_photos", 0), ""],
        ["Resumo", "Fotos sem ID", data.get("summary", {}).get("unknown_photos", 0), ""],
        ["Resumo", "Fotos descartadas", data.get("summary", {}).get("discarded_photos", 0), ""],
        ["Resumo", "Pessoas com poucas fotos", data.get("summary", {}).get("low_photo_people", 0), ""],
        ["Resumo", "Pessoas sem fotos", data.get("summary", {}).get("empty_people", 0), ""],
    ]
    for item in data.get("unknown_photos", []):
        rows.append(["Sem ID", os.path.basename(item.get("path", "")), "", item.get("path", "")])
    for item in data.get("discarded_photos", []):
        rows.append(["Descartada", os.path.basename(item.get("path", "")), "", item.get("path", "")])
    for person in data.get("low_photo_people", []):
        rows.append(["Poucas fotos", person.get("id") or person.get("name"), person.get("total_photos", 0), ""])
    for person in data.get("empty_people", []):
        rows.append(["Sem fotos", person.get("id") or person.get("name"), 0, ""])
    with open(report_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerows(rows)
    return {"status": "ok", "path": report_path}


def discard_photo(req):
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    current_catalog = _value("get_current_catalog")
    backup_catalog_db(current_catalog, "antes_descarte")
    scope = str(getattr(req, "scope", "catalog") or "catalog").strip().lower()
    person_key = str(getattr(req, "person_key", "") or "").strip()
    with get_db(current_catalog) as conn:
        cur = conn.cursor()
        if scope == "person" and person_key:
            rowids = list(getattr(req, "rowids", None) or [])
            if not rowids and req.foto_path:
                cur.execute(
                    "SELECT rowid FROM ocorrencias WHERE foto_path = ? AND (person_key = ? OR ? = '')",
                    (req.foto_path, person_key, person_key),
                )
                rowids = [int(r["rowid"]) for r in cur.fetchall()]
            if req.discard:
                for rid in rowids:
                    cur.execute(
                        "INSERT OR IGNORE INTO discarded_local_faces (face_rowid, scope_key, foto_path) VALUES (?, ?, ?)",
                        (rid, person_key, req.foto_path),
                    )
            else:
                if rowids:
                    placeholders = ",".join(["?"] * len(rowids))
                    cur.execute(
                        f"DELETE FROM discarded_local_faces WHERE scope_key = ? AND face_rowid IN ({placeholders})",
                        (person_key, *rowids),
                    )
                else:
                    cur.execute(
                        "DELETE FROM discarded_local_faces WHERE scope_key = ? AND foto_path = ?",
                        (person_key, req.foto_path),
                    )
        else:
            if req.discard:
                cur.execute("INSERT OR IGNORE INTO discarded_photos (foto_path) VALUES (?)", (req.foto_path,))
            else:
                cur.execute("DELETE FROM discarded_photos WHERE foto_path = ?", (req.foto_path,))
        conn.commit()
    return {"status": "ok", "discarded": req.discard}


def clear_db():
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    current_catalog = _value("get_current_catalog")
    backup_catalog_db(current_catalog, "antes_limpar")
    with get_db(current_catalog) as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM ocorrencias")
        cur.execute("DELETE FROM alunos")
        cur.execute("DELETE FROM discarded_photos")
        cur.execute("DELETE FROM discarded_local_faces")
        conn.commit()
    return {"status": "ok"}


def get_catalog():
    get_db = _get("get_db")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = 'system_catalog'")
        r = cur.fetchone()
    return {"last_folder": r[0] if r else "Nenhum histórico"}


def get_drafts(catalog: str = "", path: str = ""):
    get_db = _get("get_db")
    explorer_entry_info = _get("explorer_entry_info")
    automation = _get("automation")
    from media_manager import photo_item_from_path

    with get_db(catalog) as conn:
        cur = conn.cursor()
        cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = 'system_catalog'")
        root_row = cur.fetchone()

        cur.execute("SELECT foto_path, aluno_id, x1, y1, x2, y2 FROM ocorrencias")
        all_faces = cur.fetchall()
        db_map = defaultdict(list)
        for r in all_faces:
            db_map[r["foto_path"]].append({
                "aluno_id": r["aluno_id"],
                "x1": r["x1"], "y1": r["y1"], "x2": r["x2"], "y2": r["y2"],
            })
        cur.execute("SELECT foto_path FROM discarded_photos")
        discarded = {r["foto_path"] for r in cur.fetchall()}

        root_path = root_row["face_cache_path"] if root_row and root_row["face_cache_path"] else ""
        current_path = urllib.parse.unquote(path or "")
        if root_path and os.path.isdir(root_path):
            root_abs = os.path.abspath(root_path)
            if current_path and os.path.isdir(os.path.abspath(current_path)):
                current_abs = os.path.abspath(current_path)
            else:
                current_abs = root_abs
        elif current_path and os.path.isdir(os.path.abspath(current_path)):
            root_abs = os.path.abspath(current_path)
            current_abs = root_abs
        else:
            root_abs = ""
            current_abs = ""

        dirs = []
        photo_paths = []
        if current_abs:
            try:
                for entry in os.scandir(current_abs):
                    if entry.is_dir():
                        dirs.append(explorer_entry_info(entry.path, "dir", entry.name))
                    elif entry.is_file() and entry.name.lower().endswith((".jpg", ".jpeg", ".png")):
                        photo_paths.append(entry.path)
            except PermissionError:
                pass
        else:
            photo_paths = sorted(db_map.keys())

        drafts = []
        for fp in sorted(set(photo_paths), key=lambda p: os.path.basename(p).lower()):
            item = photo_item_from_path(
                fp,
                faces=db_map.get(fp, []),
                discarded=fp in discarded,
            )
            drafts.append(item)

        index_root = root_abs or current_abs
        if automation and index_root and os.path.isdir(index_root):
            try:
                automation.schedule_folder_indexing(index_root)
            except Exception:
                pass

        dirs.sort(key=lambda x: x["name"].lower())
    return {"root_path": root_abs, "current_path": current_abs, "dirs": dirs, "photos": drafts}
