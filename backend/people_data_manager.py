import os
import time
import threading

from fastapi import HTTPException

_cfg = {}
_people_cache = {}
_people_cache_lock = threading.Lock()
_CACHE_TTL_SECONDS = 300

_img_dim_cache = {}
_img_dim_lock = threading.Lock()


def get_image_dimensions(p):
    with _img_dim_lock:
        if p in _img_dim_cache:
            return _img_dim_cache[p]

    try:
        from PIL import Image
        with Image.open(p) as img:
            w, h = img.width, img.height
            try:
                exif = img._getexif()
                if exif and exif.get(274) in [5, 6, 7, 8]:
                    w, h = h, w
            except Exception:
                pass
            with _img_dim_lock:
                _img_dim_cache[p] = (w, h)
            return w, h
    except Exception:
        return None, None


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def current_catalog():
    getter = _get("get_current_catalog")
    return getter() if getter else ""


def _get_cached_people(unknown: bool):
    cat = current_catalog()
    key = f"{cat}:{unknown}"
    now = time.time()

    with _people_cache_lock:
        if key in _people_cache:
            data, timestamp = _people_cache[key]
            if now - timestamp < _CACHE_TTL_SECONDS:
                return data
    return None


def global_search(q: str = ""):
    get_catalog_dir = _get("get_catalog_dir")
    if not q or len(q) < 2:
        return []
    results = []
    try:
        dbs = [f.replace(".db", "") for f in os.listdir(get_catalog_dir()) if f.endswith(".db") and f.replace(".db", "") != ""]
        for db_name in dbs:
            try:
                sqlite = _get("sqlite3")
                db_path = os.path.join(get_catalog_dir(), f"{db_name}.db")
                with sqlite.connect(db_path) as conn:
                    cur = conn.cursor()
                    search_query = f"%{q}%"
                    cur.execute("""
                        SELECT DISTINCT aluno_id
                        FROM ocorrencias
                        WHERE aluno_id LIKE ?
                        AND aluno_id NOT LIKE 'Pessoa %'
                        AND aluno_id != 'Desconhecido'
                        LIMIT 20
                    """, (search_query,))
                    rows = cur.fetchall()
                    for row in rows:
                        results.append({"name": row[0], "catalog": db_name})
            except Exception:
                continue
    except Exception as e:
        print(f"Erro na busca global: {e}")
    return results[:100]


def get_people(unknown: bool = False):
    cached = _get_cached_people(unknown)
    if cached is not None:
        return cached

    try:
        get_db = _get("get_db")
        cat = current_catalog()
        if not cat:
            return []
        with get_db() as conn:
            cur = conn.cursor()
            if unknown:
                cur.execute("""
                    SELECT aluno_id, COUNT(*) as total FROM ocorrencias
                    WHERE lower(aluno_id) IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'não_mapeado', '__unknown__')
                       OR aluno_id LIKE 'Pessoa%'
                    GROUP BY aluno_id ORDER BY total DESC, aluno_id ASC
                """)
            else:
                cur.execute("""
                    SELECT aluno_id, COUNT(*) as total FROM ocorrencias
                    WHERE lower(aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'não_mapeado', '__unknown__')
                      AND aluno_id NOT LIKE 'Pessoa%'
                    GROUP BY aluno_id ORDER BY aluno_id ASC
                """)

            rows = cur.fetchall()
            results = []

            for row in rows:
                aluno_id = row["aluno_id"]
                cover_path = None
                cover_box = None
                class_name = "Sem turma"
                try:
                    cur.execute("SELECT foto_path, x1, y1, x2, y2 FROM ocorrencias WHERE aluno_id = ? LIMIT 1", (aluno_id,))
                    cover_row = cur.fetchone()
                    if cover_row:
                        cover_path = cover_row["foto_path"]
                        if cover_row["x1"] is not None:
                            cover_box = [cover_row["x1"], cover_row["y1"], cover_row["x2"], cover_row["y2"]]
                    cur.execute("SELECT face_cache_path, class_name FROM alunos WHERE aluno_id = ?", (aluno_id,))
                    ref_row = cur.fetchone()
                    if ref_row and ref_row["face_cache_path"]:
                        ref_path = ref_row["face_cache_path"]
                        if os.path.exists(ref_path):
                            cover_path = ref_path
                            cover_box = None
                    if ref_row and ref_row["class_name"]:
                        class_name = str(ref_row["class_name"]).strip() or "Sem turma"
                except:
                    pass

                results.append({
                    "id": aluno_id,
                    "name": aluno_id,
                    "class_name": class_name,
                    "total_photos": row["total"],
                    "cover_path": cover_path,
                    "cover_box": cover_box,
                })

        with _people_cache_lock:
            key = f"{cat}:{unknown}"
            _people_cache[key] = (results, time.time())

        return results
    except Exception as e:
        import traceback
        print(f"ERRO em get_people: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def get_people(unknown: bool = False):
    cached = _get_cached_people(unknown)
    if cached is not None:
        return cached

    try:
        get_db = _get("get_db")
        cat = current_catalog()
        if not cat:
            return []

        with get_db() as conn:
            cur = conn.cursor()
            if unknown:
                cur.execute("""
                    SELECT aluno_id, COUNT(*) as total FROM ocorrencias
                    WHERE lower(aluno_id) IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nÃ£o_mapeado', '__unknown__')
                       OR aluno_id LIKE 'Pessoa%'
                    GROUP BY aluno_id ORDER BY total DESC, aluno_id ASC
                """)
                rows = cur.fetchall()
                results = [{
                    "id": row["aluno_id"],
                    "name": row["aluno_id"],
                    "class_name": "Sem turma",
                    "total_photos": row["total"],
                    "cover_path": None,
                    "cover_box": None,
                    "avatar_path": None,
                } for row in rows]
            else:
                cur.execute("""
                    WITH counts AS (
                        SELECT aluno_id, COUNT(*) AS total
                        FROM ocorrencias
                        WHERE lower(aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nÃ£o_mapeado', '__unknown__')
                          AND aluno_id NOT LIKE 'Pessoa%'
                        GROUP BY aluno_id
                    ),
                    first_rows AS (
                        SELECT aluno_id, MIN(rowid) AS first_rowid
                        FROM ocorrencias
                        GROUP BY aluno_id
                    ),
                    covers AS (
                        SELECT o.aluno_id, o.foto_path, o.x1, o.y1, o.x2, o.y2
                        FROM ocorrencias o
                        JOIN first_rows f
                          ON f.aluno_id = o.aluno_id
                         AND f.first_rowid = o.rowid
                    )
                    SELECT
                        c.aluno_id,
                        c.total,
                        cov.foto_path AS cover_path,
                        cov.x1,
                        cov.y1,
                        cov.x2,
                        cov.y2,
                        a.face_cache_path,
                        a.class_name
                    FROM counts c
                    LEFT JOIN covers cov ON cov.aluno_id = c.aluno_id
                    LEFT JOIN alunos a ON a.aluno_id = c.aluno_id
                    ORDER BY c.aluno_id ASC
                """)
                rows = cur.fetchall()
                results = []
                for row in rows:
                    cover_path = row["cover_path"]
                    cover_box = None
                    if cover_path and row["x1"] is not None:
                        cover_box = [row["x1"], row["y1"], row["x2"], row["y2"]]

                    face_cache_path = str(row["face_cache_path"] or "").strip()
                    avatar_path = None
                    if face_cache_path and os.path.exists(face_cache_path):
                        avatar_path = face_cache_path
                    elif cover_path and os.path.exists(cover_path):
                        avatar_path = cover_path
                    else:
                        avatar_path = cover_path if cover_path else None

                    results.append({
                        "id": row["aluno_id"],
                        "name": row["aluno_id"],
                        "class_name": str(row["class_name"] or "").strip() or "Sem turma",
                        "total_photos": row["total"],
                        "cover_path": cover_path,
                        "cover_box": cover_box,
                        "avatar_path": avatar_path,
                    })

        with _people_cache_lock:
            key = f"{cat}:{unknown}"
            _people_cache[key] = (results, time.time())

        return results
    except Exception as e:
        import traceback
        print(f"ERRO em get_people (optimized): {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def invalidate_people_cache():
    global _people_cache
    with _people_cache_lock:
        _people_cache = {}


def get_photos(aluno_id: str):
    get_db = _get("get_db")
    get_blur_label = _get("get_blur_label")
    load_quality_settings = _get("load_quality_settings")
    cat = current_catalog()
    if not cat:
        return []
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT foto_path FROM discarded_photos")
        discarded = {r["foto_path"] for r in cur.fetchall()}
        cur.execute("SELECT rowid, foto_path, x1, y1, x2, y2, blur_score, blur_status, closed_eyes, is_foreground, foreground_score, background_penalty_reason FROM ocorrencias WHERE aluno_id = ?", (aluno_id,))
        rows = cur.fetchall()

        unique_photos = {}
        for r in rows:
            p = r["foto_path"]
            if p not in unique_photos:
                unique_photos[p] = {
                    "path": p,
                    "name": os.path.basename(p),
                    "type": os.path.splitext(p)[1].lower().lstrip(".") or "img",
                    "size": None,
                    "mtime": None,
                    "ctime": None,
                    "faces": [],
                    "total_faces_in_db": 1,
                    "discarded": p in discarded,
                    "blur_score": r["blur_score"],
                    "blur_status": r["blur_status"],
                    "blur_label": get_blur_label(r["blur_score"], load_quality_settings()),
                    "closed_eyes": bool(r["closed_eyes"]),
                }
                try:
                    stat = os.stat(p)
                    unique_photos[p]["size"] = stat.st_size
                    unique_photos[p]["mtime"] = stat.st_mtime
                    unique_photos[p]["ctime"] = stat.st_ctime
                    
                    w, h = get_image_dimensions(p)
                    unique_photos[p]["width"] = w
                    unique_photos[p]["height"] = h
                except Exception:
                    unique_photos[p]["width"] = None
                    unique_photos[p]["height"] = None
                    pass
            if r["x1"] is not None:
                unique_photos[p]["faces"].append({
                    "rowid": r["rowid"],
                    "aluno_id": aluno_id,
                    "x1": r["x1"], "y1": r["y1"],
                    "x2": r["x2"], "y2": r["y2"],
                    "is_foreground": r["is_foreground"],
                    "foreground_score": r["foreground_score"],
                    "background_penalty_reason": r["background_penalty_reason"]
                })

        if unique_photos:
            paths = list(unique_photos.keys())
            for i in range(0, len(paths), 900):
                chunk = paths[i:i + 900]
                placeholders = ",".join(["?"] * len(chunk))
                cur.execute(f"SELECT foto_path, COUNT(aluno_id) as cnt FROM ocorrencias WHERE foto_path IN ({placeholders}) GROUP BY foto_path", chunk)
                for c in cur.fetchall():
                    unique_photos[c["foto_path"]]["total_faces_in_db"] = c["cnt"]

    return list(unique_photos.values())


def get_all_photos(limit: int = None):
    get_db = _get("get_db")
    get_blur_label = _get("get_blur_label")
    load_quality_settings = _get("load_quality_settings")
    cat = current_catalog()
    if not cat:
        return []
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT foto_path FROM discarded_photos")
        discarded = {r["foto_path"] for r in cur.fetchall()}
        base_query = """
            SELECT foto_path,
                   MAX(blur_score) as blur_score,
                   MAX(blur_status) as blur_status,
                   MAX(closed_eyes) as closed_eyes,
                   COUNT(CASE WHEN x1 IS NOT NULL THEN 1 END) as face_count
            FROM ocorrencias
            GROUP BY foto_path
            ORDER BY foto_path
        """
        params = ()
        if limit is not None and int(limit) > 0:
            base_query += "\nLIMIT ?"
            params = (int(limit),)
        cur.execute(base_query, params)
        rows = cur.fetchall()
        qs = load_quality_settings()
        unique_photos = {}
        for r in rows:
            p = r["foto_path"]
            unique_photos[p] = {
                "path": p,
                "name": os.path.basename(p),
                "type": os.path.splitext(p)[1].lower().lstrip(".") or "img",
                "size": None, "mtime": None, "ctime": None,
                "faces": [],
                "total_faces_in_db": r["face_count"],
                "discarded": p in discarded,
                "blur_score": r["blur_score"],
                "blur_status": r["blur_status"],
                "blur_label": get_blur_label(r["blur_score"], qs),
                "closed_eyes": bool(r["closed_eyes"]),
            }
            try:
                stat = os.stat(p)
                unique_photos[p]["size"] = stat.st_size
                unique_photos[p]["mtime"] = stat.st_mtime
                
                w, h = get_image_dimensions(p)
                unique_photos[p]["width"] = w
                unique_photos[p]["height"] = h
            except Exception:
                unique_photos[p]["width"] = None
                unique_photos[p]["height"] = None
                pass
        if unique_photos:
            paths = list(unique_photos.keys())
            for i in range(0, len(paths), 900):
                chunk = paths[i:i + 900]
                placeholders = ",".join(["?"] * len(chunk))
                cur.execute(
                    f"SELECT rowid, foto_path, aluno_id, x1, y1, x2, y2 FROM ocorrencias WHERE foto_path IN ({placeholders})",
                    chunk
                )
                for c in cur.fetchall():
                    fp = c["foto_path"]
                    if fp in unique_photos:
                        unique_photos[fp]["faces"].append({
                            "rowid": c["rowid"],
                            "aluno_id": c["aluno_id"],
                            "x1": c["x1"], "y1": c["y1"],
                            "x2": c["x2"], "y2": c["y2"],
                        })
    return list(unique_photos.values())
