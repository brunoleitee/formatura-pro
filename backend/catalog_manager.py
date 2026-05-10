import os
import time

from fastapi import HTTPException
from pydantic import BaseModel

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


class SetCatalogReq(BaseModel):
    name: str


class RenameCatalogReq(BaseModel):
    old_name: str
    new_name: str


def list_catalogs():
    data_dir = _get("data_dir")
    catalog_dir = _get("catalog_dir")
    current_catalog = _get("get_current_catalog")
    log_path = os.path.join(data_dir, "debug_timing.txt")

    start = time.time()
    try:
        dbs = sorted(
            f.replace(".db", "")
            for f in os.listdir(catalog_dir)
            if f.endswith(".db") and f.replace(".db", "") != ""
        )
        list_time = time.time() - start
    except Exception:
        dbs = []
        list_time = 0

    if not current_catalog() and dbs:
        _get("set_current_catalog")(dbs[0])

    catalog_meta = {}
    meta_start = time.time()
    for name in dbs:
        path = os.path.join(catalog_dir, f"{name}.db")
        try:
            stat = os.stat(path)
            catalog_meta[name] = {
                "created_at": time.strftime("%d/%m/%Y %H:%M:%S", time.localtime(stat.st_ctime)),
                "updated_at": time.strftime("%d/%m/%Y %H:%M:%S", time.localtime(stat.st_mtime)),
            }
        except Exception:
            catalog_meta[name] = {"created_at": "", "updated_at": ""}
    meta_time = time.time() - meta_start
    total_time = time.time() - start

    try:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(f"listdir: {list_time:.3f}s, metadata: {meta_time:.3f}s, total: {total_time:.3f}s\n")
    except Exception:
        pass

    return {
        "current": current_catalog(),
        "catalogs": dbs,
        "catalog_meta": catalog_meta,
        "_timing": {
            "listdir": round(list_time, 3),
            "metadata": round(meta_time, 3),
            "total": round(total_time, 3),
        },
    }


def set_catalog(req: SetCatalogReq):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    catalog_db_path = _get("catalog_db_path")
    get_db = _get("get_db")
    set_current_catalog = _get("set_current_catalog")
    try:
        cname = sanitize_catalog_name(req.name)
    except Exception:
        cname = "Novo_Catalogo"
    set_current_catalog(cname)
    db_path = catalog_db_path(cname)
    if os.path.exists(db_path):
        return {"status": "ok", "current": cname}
    with get_db() as conn:
        pass
    return {"status": "ok", "current": cname}


def rename_catalog(req: RenameCatalogReq):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    catalog_dir = _get("catalog_dir")
    get_current_catalog = _get("get_current_catalog")
    set_current_catalog = _get("set_current_catalog")

    old_name = sanitize_catalog_name(req.old_name)
    new_name = sanitize_catalog_name(req.new_name)
    if old_name == new_name:
        return {"status": "ok", "current": get_current_catalog()}
    old_p = os.path.join(catalog_dir, f"{old_name}.db")
    new_p = os.path.join(catalog_dir, f"{new_name}.db")
    if os.path.exists(new_p):
        raise HTTPException(409, "Ja existe um catalogo com esse nome")
    if os.path.exists(old_p):
        os.rename(old_p, new_p)
    if get_current_catalog() == old_name:
        set_current_catalog(new_name)
    return {"status": "ok", "current": get_current_catalog()}


def delete_catalog(req: SetCatalogReq):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    catalog_dir = _get("catalog_dir")
    get_current_catalog = _get("get_current_catalog")
    set_current_catalog = _get("set_current_catalog")

    cname = sanitize_catalog_name(req.name)
    p = os.path.join(catalog_dir, f"{cname}.db")
    if os.path.exists(p):
        os.remove(p)
    if get_current_catalog() == cname:
        set_current_catalog("")
    return {"status": "ok"}
