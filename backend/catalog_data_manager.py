import time
import os
from datetime import datetime

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def current_catalog():
    getter = _get("get_current_catalog")
    return getter() if getter else ""


def export_catalog_json(catalog: str = ""):
    get_db = _get("get_db")
    cat = catalog or current_catalog()
    if not cat:
        raise HTTPException(
            status_code=400, 
            detail="Nenhum catálogo selecionado. Escolha um catálogo existente ou crie um novo."
        )
    try:
        with get_db(cat) as conn:
            cur = conn.cursor()

            # Otimizar queries selecionando apenas campos necessários
            cur.execute("SELECT aluno_id, face_cache_path FROM alunos")
            alunos = [{"aluno_id": r[0], "face_cache_path": r[1]} for r in cur.fetchall()]

            cur.execute("SELECT aluno_id, foto_path, x1, y1, x2, y2, blur_score, blur_status, closed_eyes FROM ocorrencias")
            ocorrencias = [{"aluno_id": r[0], "foto_path": r[1], "x1": r[2], "y1": r[3], "x2": r[4], "y2": r[5], "blur_score": r[6], "blur_status": r[7], "closed_eyes": r[8]} for r in cur.fetchall()]

            cur.execute("SELECT foto_path, created_at FROM discarded_photos")
            descartadas = [{"foto_path": r[0], "created_at": r[1]} for r in cur.fetchall()]

        data = {
            "catalog_name": cat,
            "exported_at": datetime.now().isoformat(),
            "version": _get("app_version", ""),
            "alunos": alunos,
            "ocorrencias": ocorrencias,
            "discarded_photos": descartadas,
        }

        return JSONResponse(data)
    except Exception as e:
        raise HTTPException(500, str(e))


class ImportCatalogReq(BaseModel):
    catalog_name: str
    data: dict
    overwrite: bool = False


def import_catalog_json(req: ImportCatalogReq):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    catalog_db_path = _get("catalog_db_path")
    get_db = _get("get_db")
    backup_catalog_db = _get("backup_catalog_db")
    log_info = _get("log_info", print)

    cname = sanitize_catalog_name(req.catalog_name)
    db_path = catalog_db_path(cname)

    if os.path.exists(db_path) and not req.overwrite:
        raise HTTPException(
            status_code=400, 
            detail="O catálogo já existe. Use overwrite=true para sobrescrever ou escolha um nome diferente."
        )

    try:
        started = time.perf_counter()
        alunos_in = len(req.data.get("alunos", []))
        ocorrencias_in = len(req.data.get("ocorrencias", []))
        descartadas_in = len(req.data.get("discarded_photos", []))
        log_info(f"Import JSON: iniciando catalogo={cname} overwrite={req.overwrite} alunos={alunos_in} ocorrencias={ocorrencias_in} descartadas={descartadas_in}")
        backup_catalog_db(cname, "antes_import_json")
        with get_db(cname) as conn:
            cur = conn.cursor()

            if req.overwrite:
                cur.execute("DELETE FROM ocorrencias")
                cur.execute("DELETE FROM alunos")
                cur.execute("DELETE FROM discarded_photos")

            data = req.data
            alunos_rows = [
                (aluno["aluno_id"], aluno.get("face_cache_path", ""))
                for aluno in data.get("alunos", [])
                if "aluno_id" in aluno
            ]
            if alunos_rows:
                cur.executemany(
                    "INSERT OR REPLACE INTO alunos (aluno_id, face_cache_path) VALUES (?, ?)",
                    alunos_rows,
                )

            ocorrencias_rows = [
                (
                    occ.get("aluno_id"),
                    occ.get("foto_path"),
                    occ.get("x1", 0),
                    occ.get("y1", 0),
                    occ.get("x2", 0),
                    occ.get("y2", 0),
                )
                for occ in data.get("ocorrencias", [])
                if occ.get("foto_path")
            ]
            if ocorrencias_rows:
                cur.executemany(
                    """
                    INSERT OR IGNORE INTO ocorrencias (aluno_id, foto_path, x1, y1, x2, y2)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    ocorrencias_rows,
                )

            discarded_rows = [
                (disc["foto_path"],)
                for disc in data.get("discarded_photos", [])
                if "foto_path" in disc
            ]
            if discarded_rows:
                cur.executemany(
                    "INSERT OR IGNORE INTO discarded_photos (foto_path) VALUES (?)",
                    discarded_rows,
                )

            conn.commit()

        elapsed = time.perf_counter() - started
        log_info(f"Import JSON: concluido catalogo={cname} em {elapsed:.2f}s")
        return {
            "status": "ok",
            "imported": {
                "alunos": alunos_in,
                "ocorrencias": ocorrencias_in,
                "descartadas": descartadas_in,
                "duration_seconds": round(elapsed, 2),
            },
        }
    except Exception as e:
        raise HTTPException(500, str(e))


class MarkAbsentReq(BaseModel):
    aluno_ids: list


def mark_people_absent(req: MarkAbsentReq):
    cat = current_catalog()
    get_db = _get("get_db")
    if not cat:
        raise HTTPException(400, "Nenhum catalogo selecionado")
    try:
        with get_db(cat) as conn:
            cur = conn.cursor()

            marked = 0
            for aid in req.aluno_ids:
                cur.execute("SELECT * FROM alunos WHERE aluno_id = ?", (aid,))
                if not cur.fetchone():
                    cur.execute(
                        "INSERT INTO alunos (aluno_id, face_cache_path) VALUES (?, ?)",
                        (aid, "ABSENT"),
                    )
                    marked += 1

            conn.commit()

        return {"status": "ok", "marked": marked}
    except Exception as e:
        raise HTTPException(500, str(e))


def get_absent_people():
    cat = current_catalog()
    get_db = _get("get_db")
    if not cat:
        return []
    try:
        with get_db(cat) as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT a.aluno_id, COUNT(o.foto_path) as foto_count
                FROM alunos a
                LEFT JOIN ocorrencias o ON o.aluno_id = a.aluno_id
                WHERE a.face_cache_path = 'ABSENT' AND a.aluno_id != 'system_catalog'
                GROUP BY a.aluno_id
                """
            )
            result = [dict(r) for r in cur.fetchall()]
        return result
    except Exception:
        return []
