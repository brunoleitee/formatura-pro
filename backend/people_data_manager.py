import os
import time
import threading
import logging

from fastapi import HTTPException

_cfg = {}
_people_cache = {}
_people_cache_lock = threading.Lock()
_CACHE_TTL_SECONDS = 300

_img_dim_cache = {}
_img_dim_lock = threading.Lock()

_sql_logger = logging.getLogger(__name__)


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
    invalidate_people_cache()
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
                _t = time.perf_counter()
                cur.execute("""
                    SELECT aluno_id, COUNT(*) as total FROM ocorrencias
                    WHERE lower(aluno_id) IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__')
                       OR aluno_id LIKE 'Pessoa%'
                    GROUP BY aluno_id ORDER BY total DESC, aluno_id ASC
                """)
                rows = cur.fetchall()
                _sql_logger.info("[sql-perf] endpoint=/api/people query=unknown_people rows=%d ms=%.0f", len(rows), (time.perf_counter() - _t) * 1000)
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
                _t = time.perf_counter()
                cur.execute("""
                    WITH stats AS (
                        SELECT 
                            o.aluno_id, 
                            COUNT(*) AS total,
                            AVG(COALESCE(o.foreground_score, 0)) AS avg_quality,
                            COUNT(CASE WHEN pm.favorite = 1 THEN 1 END) AS favorites_count,
                            COUNT(CASE WHEN dp.foto_path IS NOT NULL THEN 1 END) AS discarded_count
                        FROM ocorrencias o
                        LEFT JOIN photo_meta pm ON pm.foto_path = o.foto_path
                        LEFT JOIN discarded_photos dp ON dp.foto_path = o.foto_path
                        WHERE lower(o.aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__')
                          AND o.aluno_id NOT LIKE 'Pessoa%'
                        GROUP BY o.aluno_id
                    ),
                    covers AS (
                        SELECT aluno_id, foto_path, x1, y1, x2, y2
                        FROM (
                            SELECT
                                aluno_id, foto_path, x1, y1, x2, y2,
                                CASE
                                    WHEN is_foreground = 1 AND COALESCE(foreground_score, 0) >= 0.3 THEN 0
                                    ELSE 1
                                END AS tier,
                                ROW_NUMBER() OVER (
                                    PARTITION BY aluno_id
                                    ORDER BY
                                        CASE
                                            WHEN is_foreground = 1 AND COALESCE(foreground_score, 0) >= 0.3 THEN 0
                                            ELSE 1
                                        END ASC,
                                        (x1 IS NULL) ASC,
                                        (
                                            COALESCE(foreground_score, 0) * 0.40 +
                                            COALESCE(center_score, 0) * 0.20 +
                                            MIN(COALESCE(blur_score, 0) / 300.0, 1.0) * 0.20 +
                                            MIN(COALESCE(face_area_ratio, 0) / 0.15, 1.0) * 0.20
                                        ) DESC
                                ) as rn
                            FROM ocorrencias
                        ) WHERE rn = 1
                    )
                    SELECT
                        s.aluno_id,
                        s.total,
                        s.avg_quality,
                        s.favorites_count,
                        s.discarded_count,
                        cov.foto_path AS cover_path,
                        cov.x1,
                        cov.y1,
                        cov.x2,
                        cov.y2,
                        a.face_cache_path,
                        a.class_name
                    FROM stats s
                    LEFT JOIN covers cov ON cov.aluno_id = s.aluno_id
                    LEFT JOIN alunos a ON a.aluno_id = s.aluno_id
                    ORDER BY s.aluno_id ASC
                """)
                rows = cur.fetchall()
                _sql_logger.info("[sql-perf] endpoint=/api/people query=people_stats rows=%d ms=%.0f", len(rows), (time.perf_counter() - _t) * 1000)
                
                _t = time.perf_counter()
                cur.execute("""
                    WITH ranked AS (
                        SELECT 
                            aluno_id, foto_path, x1, y1, x2, y2,
                            ROW_NUMBER() OVER (PARTITION BY aluno_id ORDER BY rowid ASC) as rn
                        FROM ocorrencias
                        WHERE x1 IS NOT NULL
                          AND lower(aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__')
                          AND aluno_id NOT LIKE 'Pessoa%'
                    )
                    SELECT * FROM ranked WHERE rn <= 4
                """)
                samples_data = cur.fetchall()
                _sql_logger.info("[sql-perf] endpoint=/api/people query=sample_photos rows=%d ms=%.0f", len(samples_data), (time.perf_counter() - _t) * 1000)
                samples_by_aluno = {}
                for s in samples_data:
                    aid = s["aluno_id"]
                    if aid not in samples_by_aluno:
                        samples_by_aluno[aid] = []
                    samples_by_aluno[aid].append({
                        "path": s["foto_path"],
                        "box": [s["x1"], s["y1"], s["x2"], s["y2"]],
                    })

                results = []
                for row in rows:
                    aluno_id = row["aluno_id"]
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
                        "id": aluno_id,
                        "name": aluno_id,
                        "class_name": str(row["class_name"] or "").strip() or "Sem turma",
                        "total_photos": row["total"],
                        "favorites_count": row["favorites_count"],
                        "discarded_count": row["discarded_count"],
                        "avg_quality": row["avg_quality"],
                        "cover_path": cover_path,
                        "cover_box": cover_box,
                        "avatar_path": avatar_path,
                        "sample_photos": samples_by_aluno.get(aluno_id, []),
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


_REF_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def _collect_ref_photos(cat, discarded):
    """Coleta fotos das pastas de referência do catálogo."""
    get_db = _get("get_db")
    ref_photos = {}
    inactive_paths = set()
    try:
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute("SELECT path, status FROM catalog_folders WHERE catalog_name = ? AND folder_type = 'reference'", (cat,))
            ref_rows = cur.fetchall()
            ref_paths = [r["path"] for r in ref_rows]
            inactive_paths = {r["path"] for r in ref_rows if r["status"] != "active"}
    except Exception:
        return ref_photos
    for ref_dir in ref_paths:
        if not ref_dir or not os.path.isdir(ref_dir):
            continue
        is_inactive = ref_dir in inactive_paths
        for root, _, files in os.walk(ref_dir):
            for fname in files:
                ext = os.path.splitext(fname)[1].lower()
                if ext not in _REF_IMAGE_EXTS:
                    continue
                p = os.path.normpath(os.path.join(root, fname))
                if p in ref_photos:
                    continue
                ref_photos[p] = {
                    "path": p,
                    "name": fname,
                    "type": ext.lstrip(".") or "img",
                    "size": None, "mtime": None, "ctime": None,
                    "faces": [],
                    "total_faces_in_db": 0,
                    "discarded": p in discarded,
                    "blur_score": None,
                    "blur_status": None,
                    "blur_label": "",
                    "closed_eyes": False,
                    "source": "reference",
                    "folder_active": not is_inactive,
                }
                try:
                    stat = os.stat(p)
                    ref_photos[p]["size"] = stat.st_size
                    ref_photos[p]["mtime"] = stat.st_mtime
                    w, h = get_image_dimensions(p)
                    ref_photos[p]["width"] = w
                    ref_photos[p]["height"] = h
                except Exception:
                    ref_photos[p]["width"] = None
                    ref_photos[p]["height"] = None
    return ref_photos


def get_photos_page(catalog="", limit=100, offset=0):
    get_db = _get("get_db")
    get_blur_label = _get("get_blur_label")
    load_quality_settings = _get("load_quality_settings")
    cat = catalog if catalog else current_catalog()
    if not cat:
        return {"photos": [], "total": 0, "limit": limit, "offset": offset, "hasMore": False}

    with get_db() as conn:
        cur = conn.cursor()

        cur.execute("SELECT COUNT(DISTINCT foto_path) FROM ocorrencias")
        main_total = cur.fetchone()[0]

        cur.execute("SELECT foto_path FROM discarded_photos")
        discarded = {r["foto_path"] for r in cur.fetchall()}

        cur.execute("SELECT path FROM catalog_folders WHERE catalog_name = ? AND status = 'inactive'", (cat,))
        inactive_folders = [os.path.normpath(r["path"]).lower() for r in cur.fetchall()]

        base_query = """
            SELECT foto_path,
                   MAX(blur_score) as blur_score,
                   MAX(blur_status) as blur_status,
                   MAX(closed_eyes) as closed_eyes,
                   COUNT(CASE WHEN x1 IS NOT NULL THEN 1 END) as face_count
            FROM ocorrencias
            GROUP BY foto_path
            ORDER BY foto_path
            LIMIT ? OFFSET ?
        """
        cur.execute(base_query, (limit, offset))
        rows = cur.fetchall()

        qs = load_quality_settings()
        unique_photos = {}
        for r in rows:
            p = r["foto_path"]
            p_norm = os.path.normpath(p).lower()
            is_inactive = any(p_norm.startswith(inf + os.sep) or p_norm.startswith(inf + "/") for inf in inactive_folders)
            entry = {
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
                "source": "event",
                "folder_active": not is_inactive,
            }
            try:
                stat = os.stat(p)
                entry["size"] = stat.st_size
                entry["mtime"] = stat.st_mtime
                w, h = get_image_dimensions(p)
                entry["width"] = w
                entry["height"] = h
            except Exception:
                entry["width"] = None
                entry["height"] = None
            unique_photos[p] = entry

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

    # Add ref photos (only on first page, they are typically few)
    if offset == 0:
        ref_photos = _collect_ref_photos(cat, discarded)
        for p, photo in ref_photos.items():
            if p not in unique_photos:
                unique_photos[p] = photo

    total = main_total
    return {
        "photos": list(unique_photos.values()),
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": (offset + limit) < total,
    }


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
        # Buscar pastas inativas para marcar fotos
        cur.execute("SELECT path FROM catalog_folders WHERE catalog_name = ? AND status = 'inactive'", (cat,))
        inactive_folders = [os.path.normpath(r["path"]).lower() for r in cur.fetchall()]
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
            p_norm = os.path.normpath(p).lower()
            is_inactive = any(p_norm.startswith(inf + os.sep) or p_norm.startswith(inf + "/") for inf in inactive_folders)
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
                "source": "event",
                "folder_active": not is_inactive,
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

    # ── Adicionar fotos de referência ──
    ref_photos = _collect_ref_photos(cat, discarded)
    for p, photo in ref_photos.items():
        if p not in unique_photos:
            unique_photos[p] = photo

    return list(unique_photos.values())
