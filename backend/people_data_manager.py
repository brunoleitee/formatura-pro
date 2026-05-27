import os
import time
import threading
import logging

from fastapi import HTTPException
from utils import validate_config

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
    validate_config(_cfg, ["get_db", "get_current_catalog", "get_catalog_dir", "get_blur_label", "load_quality_settings", "sqlite3"], "people_data_manager")


def _get(name, default=None):
    return _cfg.get(name, default)


def current_catalog():
    getter = _get("get_current_catalog")
    return getter() if getter else ""


def _get_cached_people(unknown: bool, catalog: str = ""):
    cat = catalog or current_catalog()
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
                        AND aluno_id NOT LIKE 'Pessoa%'
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


def _is_valid_formando(aluno_id: str, person_key: str = "") -> bool:
    """
    Verifica se um aluno tem identidade válida para aparecer na aba Formandos.
    Só é considerado formando real se tiver:
    - nome confirmado (não é "Pessoa X" nem desconhecido)
    - OU referência vinculada (person_key com pasta de referência válida)
    - OU confirmação manual
    """
    aid = str(aluno_id or "").strip().lower()
    if not aid:
        return False
    if aid.startswith("pessoa ") or aid in ("unknown", "desconhecido", "sem_nome", "nao_mapeado", "não_mapeado", "__unknown__", "system_catalog", "base", "referencia", "referência"):
        return False
    if aid.startswith("#base"):
        return False

    if person_key and "::" in person_key:
        parts = person_key.split("::")
        if len(parts) >= 4:
            ref_part = parts[2]
            if ref_part not in ("", "__SEM_REFERENCIA__"):
                return True
            student_part = parts[3]
            if student_part and not student_part.lower().startswith("pessoa ") and student_part.lower() not in ("unknown", "desconhecido", "sem_nome"):
                return True

    if not person_key or "::" not in person_key:
        if aid.startswith("pessoa ") or aid in ("unknown", "desconhecido", "sem_nome"):
            return False
        return True

    return True


def get_people(unknown: bool = False, catalog: str = ""):
    invalidate_people_cache()
    cached = _get_cached_people(unknown, catalog)
    if cached is not None:
        return cached

    try:
        get_db = _get("get_db")
        cat = catalog or current_catalog()
        if not cat:
            print("[people] catalog recebido: <vazio> — retornando lista vazia")
            return []

        print(f"[people] catalog recebido: {cat}")

        with get_db(cat) as conn:
            cur = conn.cursor()
            if unknown:
                _t = time.perf_counter()
                cur.execute("""
                    SELECT aluno_id, COUNT(*) as total FROM ocorrencias
                    WHERE (lower(aluno_id) IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__', 'system_catalog')
                       OR aluno_id LIKE 'Pessoa%'
                       OR aluno_id LIKE '#BASE%'
                       OR lower(aluno_id) IN ('base', 'referencia', 'referência'))
                    GROUP BY aluno_id ORDER BY total DESC, aluno_id ASC
                """)
                rows = cur.fetchall()
                _sql_logger.info("[sql-perf] endpoint=/api/people query=unknown_people rows=%d ms=%.0f", len(rows), (time.perf_counter() - _t) * 1000)
                results = [{
                    "id": row["aluno_id"],
                    "name": row["aluno_id"],
                    "class_name": "Sem turma",
                    "person_key": "",
                    "total_photos": row["total"],
                    "cover_path": None,
                    "cover_box": None,
                    "avatar_path": None,
                } for row in rows]
            else:
                # Diagnostic: check person_key coverage
                cur.execute("SELECT COUNT(*) as total, COUNT(DISTINCT COALESCE(NULLIF(TRIM(person_key), ''), aluno_id)) as distinct_identity FROM ocorrencias WHERE lower(aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__', 'system_catalog') AND aluno_id NOT LIKE 'Pessoa%' AND aluno_id NOT LIKE '#BASE%' AND lower(aluno_id) NOT IN ('base', 'referencia', 'referência')")
                _diag = cur.fetchone()
                logging.getLogger(__name__).info(
                    "[people] diagnostic: total_rows=%d distinct_identities=%d",
                    _diag["total"], _diag["distinct_identity"],
                )

                _t = time.perf_counter()
                cur.execute("""
                    WITH stats AS (
                        SELECT 
                            COALESCE(NULLIF(TRIM(o.person_key), ''), o.aluno_id) AS identity_key,
                            o.aluno_id,
                            COUNT(*) AS total,
                            AVG(COALESCE(o.foreground_score, 0)) AS avg_quality,
                            COUNT(CASE WHEN pm.favorite = 1 THEN 1 END) AS favorites_count,
                            COUNT(CASE WHEN dp.foto_path IS NOT NULL THEN 1 END) AS discarded_count
                        FROM ocorrencias o
                        LEFT JOIN photo_meta pm ON pm.foto_path = o.foto_path
                        LEFT JOIN discarded_photos dp ON dp.foto_path = o.foto_path
                        WHERE lower(o.aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__', 'system_catalog')
                          AND o.aluno_id NOT LIKE 'Pessoa%'
                          AND o.aluno_id NOT LIKE '#BASE%'
                          AND lower(o.aluno_id) NOT IN ('base', 'referencia', 'referência')
                        GROUP BY COALESCE(NULLIF(TRIM(o.person_key), ''), o.aluno_id)
                    ),
                    covers AS (
                        SELECT identity_key, foto_path, x1, y1, x2, y2
                        FROM (
                            SELECT
                                COALESCE(NULLIF(TRIM(o2.person_key), ''), o2.aluno_id) AS identity_key,
                                o2.foto_path, o2.x1, o2.y1, o2.x2, o2.y2,
                                CASE
                                    WHEN o2.is_foreground = 1 AND COALESCE(o2.foreground_score, 0) >= 0.3 THEN 0
                                    ELSE 1
                                END AS tier,
                                ROW_NUMBER() OVER (
                                    PARTITION BY COALESCE(NULLIF(TRIM(o2.person_key), ''), o2.aluno_id)
                                    ORDER BY
                                        CASE
                                            WHEN o2.is_foreground = 1 AND COALESCE(o2.foreground_score, 0) >= 0.3 THEN 0
                                            ELSE 1
                                        END ASC,
                                        (o2.x1 IS NULL) ASC,
                                        (
                                            COALESCE(o2.foreground_score, 0) * 0.40 +
                                            COALESCE(o2.center_score, 0) * 0.20 +
                                            MIN(COALESCE(o2.blur_score, 0) / 300.0, 1.0) * 0.20 +
                                            MIN(COALESCE(o2.face_area_ratio, 0) / 0.15, 1.0) * 0.20
                                        ) DESC
                                ) as rn
                            FROM ocorrencias o2
                        ) WHERE rn = 1
                    )
                    SELECT
                        s.aluno_id,
                        s.identity_key,
                        s.total,
                        s.avg_quality,
                        s.favorites_count,
                        s.discarded_count,
                        cov.foto_path AS cover_path,
                        cov.x1,
                        cov.y1,
                        cov.x2,
                        cov.y2
                    FROM stats s
                    LEFT JOIN covers cov ON cov.identity_key = s.identity_key
                    ORDER BY s.aluno_id ASC
                """)
                rows = [dict(r) for r in cur.fetchall()]
                _sql_logger.info("[sql-perf] endpoint=/api/people query=people_stats rows=%d ms=%.0f", len(rows), (time.perf_counter() - _t) * 1000)

                # Log diagnósticos para catalog cloud
                try:
                    cur.execute("SELECT COUNT(*) as cnt FROM ocorrencias")
                    _total_photos = cur.fetchone()["cnt"]
                    print(f"[people] total photos catalog: {_total_photos}")
                except Exception:
                    pass
                print(f"[people] total identities: {len(rows)}")

                # Buscar alunos cadastrados na tabela alunos para incluir quem tem 0 fotos/ocorrências
                try:
                    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
                    _has_alunos_table = cur.fetchone() is not None
                    if _has_alunos_table:
                        # Obter chaves já presentes
                        seen_identities = set()
                        for r in rows:
                            identity_key = str(r["identity_key"] or "")
                            seen_identities.add(identity_key)

                        cur.execute("SELECT aluno_id, face_cache_path, class_name, person_key, reference_folder FROM alunos")
                        all_alunos = cur.fetchall()
                        for ar in all_alunos:
                            pk = str(ar["person_key"] or "")
                            aid = ar["aluno_id"]
                            identity = pk if pk else aid
                            
                            if identity not in seen_identities and aid != "system_catalog" and aid != "#BASE" and aid.lower() not in ("base", "referencia", "referência") and not aid.lower().startswith("pessoa "):
                                seen_identities.add(identity)
                                rows.append({
                                    "aluno_id": aid,
                                    "identity_key": identity,
                                    "total": 0,
                                    "avg_quality": 0.0,
                                    "favorites_count": 0,
                                    "discarded_count": 0,
                                    "cover_path": None,
                                    "x1": None,
                                    "y1": None,
                                    "x2": None,
                                    "y2": None
                                })
                except Exception as _alunos_err:
                    print(f"Erro ao mesclar alunos sem fotos: {_alunos_err}")
                
                _t = time.perf_counter()
                cur.execute("""
                    WITH ranked AS (
                        SELECT 
                            COALESCE(NULLIF(TRIM(person_key), ''), aluno_id) AS identity_key,
                            aluno_id, foto_path, x1, y1, x2, y2,
                            ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(TRIM(person_key), ''), aluno_id) ORDER BY rowid ASC) as rn
                        FROM ocorrencias
                        WHERE x1 IS NOT NULL
                          AND lower(aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__', 'system_catalog')
                          AND aluno_id NOT LIKE 'Pessoa%'
                          AND aluno_id NOT LIKE '#BASE%'
                          AND lower(aluno_id) NOT IN ('base', 'referencia', 'referência')
                    )
                    SELECT identity_key, aluno_id, foto_path, x1, y1, x2, y2 FROM ranked WHERE rn <= 4
                """)
                samples_data = cur.fetchall()
                _sql_logger.info("[sql-perf] endpoint=/api/people query=sample_photos rows=%d ms=%.0f", len(samples_data), (time.perf_counter() - _t) * 1000)
                samples_by_aluno = {}
                for s in samples_data:
                    aid = s["identity_key"]
                    if aid not in samples_by_aluno:
                        samples_by_aluno[aid] = []
                    samples_by_aluno[aid].append({
                        "path": s["foto_path"],
                        "box": [s["x1"], s["y1"], s["x2"], s["y2"]],
                    })

                # Check if alunos table exists for additional fields
                cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
                _has_alunos = cur.fetchone() is not None
                if _has_alunos:
                    cur.execute("""
                        SELECT aluno_id, face_cache_path, class_name, person_key FROM alunos
                    """)
                    alunos_map = {}
                    alunos_by_pk = {}
                    for ar in cur.fetchall():
                        aid = ar["aluno_id"]
                        pk = str(ar["person_key"] or "")
                        alunos_map[aid] = {
                            "face_cache_path": ar["face_cache_path"] or "",
                            "class_name": ar["class_name"] or "Sem turma",
                            "person_key": pk,
                        }
                        if pk:
                            alunos_by_pk[pk] = alunos_map[aid]
                else:
                    alunos_map = {}
                    alunos_by_pk = {}

                results = []
                for row in rows:
                    aluno_id = row["aluno_id"]
                    identity_key = str(row["identity_key"] or "")
                    person_key = identity_key if "::" in identity_key else ""
                    cover_path = row["cover_path"]
                    cover_box = None
                    if cover_path and row["x1"] is not None:
                        cover_box = [row["x1"], row["y1"], row["x2"], row["y2"]]

                    # Lookup by person_key first, then by aluno_id
                    aluno_extra = alunos_by_pk.get(person_key) or alunos_map.get(aluno_id) or {}
                    _row_fcp = row["face_cache_path"] if "face_cache_path" in row.keys() else ""
                    face_cache_path = str(aluno_extra.get("face_cache_path") or _row_fcp or "").strip()
                    avatar_path = None
                    if face_cache_path and os.path.exists(face_cache_path):
                        avatar_path = face_cache_path
                    elif cover_path and os.path.exists(cover_path):
                        avatar_path = cover_path
                    else:
                        avatar_path = cover_path if cover_path else None

                    if not person_key:
                        person_key = str(aluno_extra.get("person_key", "") or "").strip()

                    # class_name from person_key (nunca sobrescrever person_key com alunos_map quando já temos identity_key)
                    class_name = "Sem turma"
                    if person_key:
                        pk_parts = person_key.split("::")
                        if len(pk_parts) >= 2:
                            cn = pk_parts[1].strip()
                            if cn and cn != "__SEM_TURMA__":
                                class_name = cn

                    if person_key and "::" in person_key:
                        logging.getLogger(__name__).info(
                            "[people] returned person_key=%s name=%s class=%s",
                            person_key, aluno_id, class_name,
                        )

                    if not _is_valid_formando(aluno_id, person_key):
                        continue

                    results.append({
                        "id": person_key if person_key else aluno_id,
                        "name": aluno_id,
                        "class_name": class_name,
                        "person_key": person_key,
                        "total_photos": row["total"],
                        "favorites_count": row["favorites_count"],
                        "discarded_count": row["discarded_count"],
                        "avg_quality": row["avg_quality"],
                        "cover_path": cover_path,
                        "cover_box": cover_box,
                        "avatar_path": avatar_path,
                        "sample_photos": samples_by_aluno.get(identity_key, []),
                    })

        print(f"[people] total people retornadas: {len(results)}")

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


def _get_cloud_names_map(cur):
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_photos'")
        if cur.fetchone() is not None:
            cur.execute("SELECT cloud_file_id, name FROM cloud_photos")
            return {r["cloud_file_id"]: r["name"] for r in cur.fetchall() if r["cloud_file_id"] and r["name"]}
    except Exception:
        pass
    return {}


def _resolve_photo_name(path, cloud_names):
    if path.startswith("cloud://"):
        file_id = path[8:]
        if file_id in cloud_names:
            return cloud_names[file_id]
    return os.path.basename(path)


def get_photos(aluno_id: str, catalog: str = ""):
    get_db = _get("get_db")
    get_blur_label = _get("get_blur_label")
    load_quality_settings = _get("load_quality_settings")
    cat = catalog if catalog else current_catalog()
    if not cat:
        return []
    with get_db(cat) as conn:
        cur = conn.cursor()
        cur.execute("SELECT foto_path FROM discarded_photos")
        discarded = {r["foto_path"] for r in cur.fetchall()}

        # Tentar buscar pela person_key (se tabela alunos existir)
        person_key_filter = ""
        class_name = "Sem turma"
        try:
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
            if cur.fetchone() is not None:
                cur.execute("SELECT person_key, class_name FROM alunos WHERE aluno_id = ? OR person_key = ? LIMIT 1", (aluno_id, aluno_id))
                row = cur.fetchone()
                if row:
                    person_key_filter = str(row["person_key"] or "").strip()
                    class_name = str(row["class_name"] or "").strip() or "Sem turma"
        except Exception:
            pass

        if person_key_filter:
            cur.execute("""
                SELECT rowid, foto_path, x1, y1, x2, y2, blur_score, blur_status, closed_eyes,
                       is_foreground, foreground_score, background_penalty_reason, person_key
                FROM ocorrencias
                WHERE person_key = ?
                   OR (aluno_id = ? AND (person_key IS NULL OR person_key = ''))
            """, (person_key_filter, aluno_id))
        else:
            cur.execute("""
                SELECT rowid, foto_path, x1, y1, x2, y2, blur_score, blur_status, closed_eyes,
                       is_foreground, foreground_score, background_penalty_reason, person_key
                FROM ocorrencias
                WHERE aluno_id = ? OR person_key = ?
            """, (aluno_id, aluno_id))
        rows = cur.fetchall()

        cloud_names = _get_cloud_names_map(cur)

        unique_photos = {}
        for r in rows:
            p = r["foto_path"]
            if p not in unique_photos:
                unique_photos[p] = {
                    "path": p,
                    "name": _resolve_photo_name(p, cloud_names),
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
                face_data = {
                    "rowid": r["rowid"],
                    "aluno_id": aluno_id,
                    "x1": r["x1"], "y1": r["y1"],
                    "x2": r["x2"], "y2": r["y2"],
                    "is_foreground": r["is_foreground"],
                    "foreground_score": r["foreground_score"],
                    "background_penalty_reason": r["background_penalty_reason"],
                }
                _r_pk = r["person_key"] if "person_key" in r.keys() else ""
                if _r_pk:
                    face_data["person_key"] = str(_r_pk)
                unique_photos[p]["faces"].append(face_data)

        if unique_photos:
            paths = list(unique_photos.keys())
            for i in range(0, len(paths), 900):
                chunk = paths[i:i + 900]
                placeholders = ",".join(["?"] * len(chunk))
                cur.execute(f"SELECT foto_path, COUNT(aluno_id) as cnt FROM ocorrencias WHERE foto_path IN ({placeholders}) GROUP BY foto_path", chunk)
                for c in cur.fetchall():
                    unique_photos[c["foto_path"]]["total_faces_in_db"] = c["cnt"]

    return list(unique_photos.values())


def get_photos_by_person_key(person_key: str, catalog: str = ""):
    """
    Busca fotos filtradas por person_key (identidade composta).
    Com fallback tolerante para normalização.
    """
    get_db = _get("get_db")
    get_blur_label = _get("get_blur_label")
    load_quality_settings = _get("load_quality_settings")
    cat = catalog if catalog else current_catalog()
    if not cat:
        return []

    import logging as _log
    _log.getLogger(__name__).info("[get_photos_by_person_key] buscando key=%s", person_key)

    def _fetch_photos(cur, where_clause, params) -> list:
        cur.execute(f"""
            SELECT rowid, foto_path, x1, y1, x2, y2, blur_score, blur_status, closed_eyes,
                   is_foreground, foreground_score, background_penalty_reason, person_key
            FROM ocorrencias
            WHERE {where_clause}
        """, params)
        return cur.fetchall()

    try:
        with get_db(cat) as conn:
            cur = conn.cursor()

            # Diagnostic: check if any rows have this person_key
            cur.execute("SELECT COUNT(*) as cnt FROM ocorrencias WHERE person_key = ?", (person_key,))
            _cnt = cur.fetchone()["cnt"]
            if _cnt == 0:
                cur.execute("SELECT COUNT(*) as cnt FROM ocorrencias WHERE person_key IS NOT NULL AND person_key != ''")
                _total_pk = cur.fetchone()["cnt"]
                cur.execute("SELECT COUNT(*) as cnt FROM ocorrencias WHERE aluno_id = ?", (person_key.split("::")[-1] if "::" in person_key else person_key,))
                _by_name = cur.fetchone()["cnt"]
                _log.getLogger(__name__).info(
                    "[get_photos_by_person_key] person_key=%s NOT FOUND: total_rows_with_pk=%d rows_with_name=%d",
                    person_key, _total_pk, _by_name,
                )

            cur.execute("SELECT foto_path FROM discarded_photos")
            discarded = {r["foto_path"] for r in cur.fetchall()}

            # ── Estratégia 1: match exato ──
            rows = _fetch_photos(cur, "person_key = ?", (person_key,))
            _log.getLogger(__name__).info("[get_photos_by_person_key] exact match: %d rows", len(rows))

            # ── Estratégia 2: case-insensitive ──
            if not rows:
                rows = _fetch_photos(cur, "UPPER(person_key) = UPPER(?)", (person_key,))
                _log.getLogger(__name__).info("[get_photos_by_person_key] upper match: %d rows", len(rows))

            # ── Estratégia 3: remover espaços duplicados ──
            if not rows:
                import re as _re
                normalized = _re.sub(r"\s+", " ", person_key.strip().upper())
                rows = _fetch_photos(cur, "UPPER(person_key) = ?", (normalized,))
                _log.getLogger(__name__).info("[get_photos_by_person_key] normalized match: %d rows key=%s", len(rows), normalized)

            # ── Estratégia 4: LIKE com os segmentos mais significativos ──
            if not rows:
                pk_parts = person_key.split("::")
                # Usar últimos 2 segmentos: class_name::person_name
                if len(pk_parts) >= 2:
                    suffix = "::" + "::".join(pk_parts[-2:])
                    suffix_upper = suffix.upper()
                    rows = _fetch_photos(cur, "UPPER(person_key) LIKE ?", (f"%{suffix_upper}",))
                    _log.getLogger(__name__).info("[get_photos_by_person_key] suffix match: %d rows suffix=%s", len(rows), suffix_upper)

            # ── Estratégia 5: fallback por catalog + último segmento (person_name) ──
            if not rows:
                pk_parts = person_key.split("::")
                person_name_seg = pk_parts[-1].strip().upper() if len(pk_parts) >= 1 else ""
                if person_name_seg:
                    rows = _fetch_photos(cur, "UPPER(aluno_id) = UPPER(?)", (person_name_seg,))
                    _log.getLogger(__name__).info("[get_photos_by_person_key] name fallback: %d rows name=%s", len(rows), person_name_seg)

            # ── Diagnóstico: se ainda sem resultados, listar exemplos ──
            if not rows:
                cur.execute("""
                    SELECT DISTINCT person_key, aluno_id, COUNT(*) as cnt
                    FROM ocorrencias
                    WHERE person_key IS NOT NULL AND person_key != ''
                    GROUP BY person_key
                    ORDER BY cnt DESC
                    LIMIT 20
                """)
                samples = [dict(r) for r in cur.fetchall()]
                _log.getLogger(__name__).info(
                    "[get_photos_by_person_key] ZERO photos for key=%s available_keys=%s",
                    person_key, samples[:5],
                )

            # Extrair nome legível
            pk_parts = person_key.split("::")
            display_name = pk_parts[-1] if len(pk_parts) >= 1 else "Desconhecido"

            cloud_names = _get_cloud_names_map(cur)

            unique_photos = {}
            for r in rows:
                p = r["foto_path"]
                if p not in unique_photos:
                    unique_photos[p] = {
                        "path": p,
                        "name": _resolve_photo_name(p, cloud_names),
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
                    face_data = {
                        "rowid": r["rowid"],
                        "aluno_id": display_name,
                        "person_key": person_key,
                        "x1": r["x1"], "y1": r["y1"],
                        "x2": r["x2"], "y2": r["y2"],
                        "is_foreground": r["is_foreground"],
                        "foreground_score": r["foreground_score"],
                        "background_penalty_reason": r["background_penalty_reason"],
                    }
                    _r_pk2 = r["person_key"] if "person_key" in r.keys() else ""
                    if _r_pk2:
                        face_data["person_key"] = str(_r_pk2)
                    unique_photos[p]["faces"].append(face_data)

            if unique_photos:
                paths = list(unique_photos.keys())
                for i in range(0, len(paths), 900):
                    chunk = paths[i:i + 900]
                    placeholders = ",".join(["?"] * len(chunk))
                    cur.execute(f"SELECT foto_path, COUNT(aluno_id) as cnt FROM ocorrencias WHERE foto_path IN ({placeholders}) GROUP BY foto_path", chunk)
                    for c in cur.fetchall():
                        unique_photos[c["foto_path"]]["total_faces_in_db"] = c["cnt"]

            return list(unique_photos.values())
    except Exception as e:
        _log.getLogger(__name__).exception("[get_photos_by_person_key] erro: %s", e)
        return []


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


def get_photos_page(catalog="", limit=100, offset=0, subfolder=None):
    get_db = _get("get_db")
    get_blur_label = _get("get_blur_label")
    load_quality_settings = _get("load_quality_settings")
    cat = catalog if catalog else current_catalog()
    if not cat:
        return {"photos": [], "total": 0, "limit": limit, "offset": offset, "hasMore": False}

    try:
        with get_db(cat) as conn:
            cur = conn.cursor()

            if subfolder:
                subfolder_clean = subfolder.replace("\\", "/").strip("/")
                cur.execute(
                    "SELECT COUNT(DISTINCT foto_path) FROM ocorrencias WHERE REPLACE(foto_path, char(92), '/') LIKE '%/' || ? || '/%'",
                    (subfolder_clean,)
                )
                main_total = cur.fetchone()[0]
            else:
                cur.execute("SELECT COUNT(DISTINCT foto_path) FROM ocorrencias")
                main_total = cur.fetchone()[0]

            cur.execute("SELECT foto_path FROM discarded_photos")
            discarded = {r["foto_path"] for r in cur.fetchall()}

            cur.execute("SELECT path FROM catalog_folders WHERE catalog_name = ? AND status = 'inactive'", (cat,))
            inactive_folders = [os.path.normpath(r["path"]).lower() for r in cur.fetchall()]

            if subfolder:
                subfolder_clean = subfolder.replace("\\", "/").strip("/")
                base_query = """
                    SELECT foto_path,
                           MAX(blur_score) as blur_score,
                           MAX(blur_status) as blur_status,
                           MAX(closed_eyes) as closed_eyes,
                           COUNT(CASE WHEN x1 IS NOT NULL THEN 1 END) as face_count
                    FROM ocorrencias
                    WHERE REPLACE(foto_path, char(92), '/') LIKE '%/' || ? || '/%'
                    GROUP BY foto_path
                    ORDER BY foto_path
                    LIMIT ? OFFSET ?
                """
                cur.execute(base_query, (subfolder_clean, limit, offset))
            else:
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
            cloud_names = _get_cloud_names_map(cur)
            
            unique_photos = {}
            for r in rows:
                p = r["foto_path"]
                p_norm = os.path.normpath(p).lower()
                is_inactive = any(p_norm.startswith(inf + os.sep) or p_norm.startswith(inf + "/") for inf in inactive_folders)
                entry = {
                    "path": p,
                    "name": _resolve_photo_name(p, cloud_names),
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
                    if subfolder:
                        p_norm = p.replace("\\", "/")
                        sub_clean = subfolder.replace("\\", "/").strip("/")
                        if f"/{sub_clean}/" not in p_norm:
                            continue
                    unique_photos[p] = photo

        total = main_total
        return {
            "photos": list(unique_photos.values()),
            "total": total,
            "limit": limit,
            "offset": offset,
            "hasMore": (offset + limit) < total,
        }
    except Exception:
        logging.getLogger(__name__).exception("[get_photos_page] erro inesperado")
        return {"photos": [], "total": 0, "limit": limit, "offset": offset, "hasMore": False}


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
        cloud_names = _get_cloud_names_map(cur)
        unique_photos = {}
        for r in rows:
            p = r["foto_path"]
            p_norm = os.path.normpath(p).lower()
            is_inactive = any(p_norm.startswith(inf + os.sep) or p_norm.startswith(inf + "/") for inf in inactive_folders)
            unique_photos[p] = {
                "path": p,
                "name": _resolve_photo_name(p, cloud_names),
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
