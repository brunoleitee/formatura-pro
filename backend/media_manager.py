import hashlib
import io
import subprocess
import sys
import time
import os
import urllib.parse
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from fastapi import HTTPException
from fastapi.responses import FileResponse, StreamingResponse, Response
from PIL import ExifTags, Image

_cfg = {}
_thumb_cache_prune_lock = threading.Lock()
_thumb_cache_last_prune = 0.0
_THUMB_CACHE_PRUNE_INTERVAL_SEC = 300
_THUMB_CACHE_DEFAULT_MAX_BYTES = 1_500_000_000
_THUMB_CACHE_DEFAULT_MAX_FILES = 50_000

# Pool de workers para thumbnail engine
_THUMB_POOL = None
_THUMB_POOL_LOCK = threading.Lock()
_THUMB_POOL_MAX_WORKERS = 4

# Semáforo para limitar fallbacks Pillow simultâneos
_PILLOW_SEMAPHORE = None
_PILLOW_SEMAPHORE_LOCK = threading.Lock()
_PILLOW_MAX_CONCURRENT = 1

# Semáforo global para limitar thumbnails simultâneas
_THUMB_SEMAPHORE = None
_THUMB_SEMAPHORE_LOCK = threading.Lock()
_THUMB_MAX_CONCURRENT = 4

# Lock para evitar múltiplas gerações da mesma imagem
_GENERATING_LOCK = threading.Lock()
_GENERATING = set()

# Cache de resultados recentes para evitar regeneration
_RESULT_CACHE = {}
_RESULT_CACHE_LOCK = threading.Lock()
_RESULT_CACHE_TTL = 30.0
_RESULT_CACHE_MAX = 200


def _get_thumb_semaphore():
    global _THUMB_SEMAPHORE
    with _THUMB_SEMAPHORE_LOCK:
        if _THUMB_SEMAPHORE is None:
            _THUMB_SEMAPHORE = threading.Semaphore(_THUMB_MAX_CONCURRENT)
        return _THUMB_SEMAPHORE


def _is_generating(cache_path):
    with _GENERATING_LOCK:
        return cache_path in _GENERATING


def _start_generating(cache_path):
    with _GENERATING_LOCK:
        _GENERATING.add(cache_path)


def _finish_generating(cache_path, remove=False):
    with _GENERATING_LOCK:
        if remove:
            _GENERATING.discard(cache_path)
        else:
            if cache_path in _GENERATING:
                _GENERATING.discard(cache_path)


def _get_result_from_cache(cache_path):
    with _RESULT_CACHE_LOCK:
        entry = _RESULT_CACHE.get(cache_path)
        if entry and (time.time() - entry.get('_ts', 0)) < _RESULT_CACHE_TTL:
            return entry.get('_result')
        return None


def _put_result_in_cache(cache_path, result):
    with _RESULT_CACHE_LOCK:
        _RESULT_CACHE[cache_path] = {'_result': result, '_ts': time.time()}
        if len(_RESULT_CACHE) > _RESULT_CACHE_MAX:
            oldest = min(_RESULT_CACHE.items(), key=lambda x: x[1].get('_ts', 0))
            _RESULT_CACHE.pop(oldest[0], None)


def _get_pillow_semaphore():
    global _PILLOW_SEMAPHORE
    with _PILLOW_SEMAPHORE_LOCK:
        if _PILLOW_SEMAPHORE is None:
            _PILLOW_SEMAPHORE = threading.Semaphore(_PILLOW_MAX_CONCURRENT)
        return _PILLOW_SEMAPHORE


def _create_error_placeholder(size=300):
    img = Image.new("RGB", (size, size), (200, 200, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    buf.seek(0)
    return buf


_PLACEHOLDER_CACHE = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def load_pil_with_orientation(path):
    img = Image.open(path)
    try:
        exif = img._getexif()
        if exif:
            orientation_key = None
            for key, val in ExifTags.TAGS.items():
                if val == "Orientation":
                    orientation_key = key
                    break
            if orientation_key and orientation_key in exif:
                orientation = exif[orientation_key]
                if orientation == 3:
                    img = img.rotate(180, expand=True)
                elif orientation == 6:
                    img = img.rotate(270, expand=True)
                elif orientation == 8:
                    img = img.rotate(90, expand=True)
    except Exception:
        pass
    return img


def _resolve_preview_path(path: str) -> str:
    decoded_path = urllib.parse.unquote(path or "").strip()
    if not decoded_path:
        raise HTTPException(status_code=400, detail="Caminho inválido")

    try:
        path_parts = Path(decoded_path).parts
        if any(part == ".." for part in path_parts):
            raise HTTPException(status_code=400, detail="Caminho inválido")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Caminho inválido")

    normalized_path = os.path.abspath(os.path.normpath(decoded_path))
    if not os.path.exists(normalized_path):
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")
    if os.path.isdir(normalized_path):
        raise HTTPException(status_code=400, detail="Caminho inválido")
    return normalized_path


def get_cached_thumb_path(decoded_path, kind, *params):
    thumb_dir = _get("thumb_cache_dir")
    stat = os.stat(decoded_path)
    key = "|".join([kind, decoded_path, str(stat.st_mtime_ns), str(stat.st_size), *map(str, params)])
    filename = hashlib.sha1(key.encode("utf-8", errors="ignore")).hexdigest() + ".jpg"
    return os.path.join(thumb_dir, filename)


def _thumb_cache_limits():
    app_settings = _get("app_settings", {}) or {}
    try:
        max_bytes = int(_get("thumb_cache_max_bytes", app_settings.get("thumb_cache_max_bytes", _THUMB_CACHE_DEFAULT_MAX_BYTES)))
    except Exception:
        max_bytes = _THUMB_CACHE_DEFAULT_MAX_BYTES
    try:
        max_files = int(_get("thumb_cache_max_files", app_settings.get("thumb_cache_max_files", _THUMB_CACHE_DEFAULT_MAX_FILES)))
    except Exception:
        max_files = _THUMB_CACHE_DEFAULT_MAX_FILES
    return max(0, max_bytes), max(0, max_files)


def _do_trim_thumb_cache():
    thumb_dir = _get("thumb_cache_dir")
    if not thumb_dir or not os.path.isdir(thumb_dir):
        return 0

    max_bytes, max_files = _thumb_cache_limits()
    if max_bytes <= 0 and max_files <= 0:
        return 0

    entries = []
    total_bytes = 0
    for root, _, files in os.walk(thumb_dir):
        for name in files:
            path = os.path.join(root, name)
            try:
                stat = os.stat(path)
            except Exception:
                continue
            total_bytes += stat.st_size
            entries.append((stat.st_mtime, stat.st_size, path))

    if not entries:
        return 0

    entries.sort(key=lambda item: item[0])
    target_files = max_files if max_files > 0 else len(entries)
    target_bytes = max_bytes if max_bytes > 0 else total_bytes
    if len(entries) <= target_files and total_bytes <= target_bytes:
        return 0

    removed = 0
    for _, size, path in entries:
        if len(entries) - removed <= target_files and total_bytes <= target_bytes:
            break
        try:
            os.remove(path)
            removed += 1
            total_bytes -= size
        except Exception:
            continue

    return removed


def _trim_thumb_cache(force=False):
    global _thumb_cache_last_prune
    now_ts = time.time()
    if not force and (now_ts - _thumb_cache_last_prune) < _THUMB_CACHE_PRUNE_INTERVAL_SEC:
        return
    _thumb_cache_last_prune = now_ts

    def _worker():
        with _thumb_cache_prune_lock:
            removed = _do_trim_thumb_cache()
        if removed:
            log_info = _get("log_info")
            if log_info:
                log_info(f"Thumb cache limpo: removidos {removed} arquivo(s)")

    t = threading.Thread(target=_worker, daemon=True)
    t.start()


def _log_thumb_perf(kind, decoded_path, size, elapsed_ms, cache_state, extra=""):
    log_info = _get("log_info")
    if not log_info:
        return
    try:
        tail = os.path.basename(decoded_path)
        endpoint = "image_thumb" if kind == "image" else "thumb"
        
        active_count = 0
        with _GENERATING_LOCK:
            active_count = len(_GENERATING)
        
        has_box = extra and ("box" in extra or "crop" in extra)
        sem_mode = extra if extra else cache_state
        
        wait_ms = 0
        if "wait=" in extra:
            import re
            m = re.search(r"wait=(\d+)ms", extra)
            if m:
                wait_ms = int(m.group(1))
        
        suffix = ""
        if extra and extra != cache_state:
            suffix = f" {extra}"
        
        log_info(f"[thumb-backend] endpoint={endpoint} size={size} box={int(has_box)} mode={sem_mode} wait={wait_ms:.0f}ms total={elapsed_ms:.0f}ms active={active_count} path={tail}{suffix}")
    except Exception:
        pass


def _get_thumb_engine_path():
    configured = _get("thumb_engine_path")
    if configured and os.path.exists(configured):
        return configured

    env_path = os.environ.get("FORM_PRO_THUMB_ENGINE")
    if env_path and os.path.exists(env_path):
        return env_path

    root_dir = Path(__file__).resolve().parent
    candidates = [
        root_dir / "main" / "src-tauri" / "binaries" / "FormaturaPRO-thumb-engine-x86_64-pc-windows-msvc.exe",
        root_dir / "main" / "src-tauri" / "binaries" / "FormaturaPRO-thumb-engine.exe",
    ]

    try:
        exe_dir = Path(sys.executable).resolve().parent
        candidates.extend([
            exe_dir / "FormaturaPRO-thumb-engine-x86_64-pc-windows-msvc.exe",
            exe_dir / "FormaturaPRO-thumb-engine.exe",
        ])
    except Exception:
        pass

    for candidate in candidates:
        try:
            if candidate.exists():
                return str(candidate)
        except Exception:
            continue
    return None


def _get_thumb_pool():
    global _THUMB_POOL
    with _THUMB_POOL_LOCK:
        if _THUMB_POOL is None:
            _THUMB_POOL = ThreadPoolExecutor(max_workers=_THUMB_POOL_MAX_WORKERS)
        return _THUMB_POOL


def _thumb_engine_worker(thumb_engine, kind, decoded_path, cache_path, size, params):
    cmd = [
        thumb_engine,
        kind,
        "--input",
        decoded_path,
        "--output",
        cache_path,
        "--size",
        str(size),
    ]
    if kind == "face":
        cmd.extend([
            "--x1", str(int(params.get("x1", 0))),
            "--y1", str(int(params.get("y1", 0))),
            "--x2", str(int(params.get("x2", 1))),
            "--y2", str(int(params.get("y2", 1))),
            "--expand", str(float(params.get("expand", 0.35))),
        ])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            return False, result.stderr if result.stderr else ""
        if os.path.exists(cache_path):
            return True, ""
        return False, "cache file not created"
    except Exception as e:
        return False, str(e)


def _run_thumb_engine(kind, decoded_path, cache_path, size, **params):
    thumb_engine = _get_thumb_engine_path()
    if not thumb_engine:
        return False

    pool = _get_thumb_pool()
    try:
        future = pool.submit(
            _thumb_engine_worker,
            thumb_engine, kind, decoded_path, cache_path, size, params
        )
        success, error_msg = future.result(timeout=6)
        if not success:
            log_info = _get("log_info")
            if log_info and error_msg:
                log_info(f"Thumb engine falhou ({kind}): {error_msg.strip()}")
            return False
        if os.path.exists(cache_path):
            _trim_thumb_cache()
            return True
        return False
    except Exception:
        return False


def photo_item_from_path(path, faces=None, discarded=False, include_blur=True):
    item = {
        "path": path,
        "name": os.path.basename(path),
        "type": os.path.splitext(path)[1].lower().lstrip(".") or "img",
        "size": None,
        "mtime": None,
        "ctime": None,
        "faces": faces or [],
        "discarded": discarded,
    }
    try:
        stat = os.stat(path)
        item["size"] = stat.st_size
        item["mtime"] = stat.st_mtime
        item["ctime"] = stat.st_ctime
    except Exception:
        pass
    if include_blur and os.path.exists(path):
        blur_info = _get("get_blur_info")(path)
        item.update(blur_info)
        
        # Integrar AI Automation Score se disponível
        automation = _get("automation")
        log_info = _get("log_info")
        if automation:
            if log_info: log_info(f"Calculando AI Score para: {os.path.basename(path)}")
            ai_data = automation.calculate_culling_score(blur_info, len(item["faces"]), img_path=path)
            item["ai_score"] = ai_data["score"]
            item["ai_recommendation"] = ai_data["recommendation"]
            item["ai_details"] = ai_data["details"]
        else:
            if log_info: log_info("AVISO: AI Automation não está disponível no Media Manager")
            
    return item


def _purge_placeholder_people(cur):
    removed = 0
    cur.execute("""
        DELETE FROM alunos
        WHERE aluno_id IS NOT NULL
          AND TRIM(aluno_id) != ''
          AND aluno_id != 'system_catalog'
          AND aluno_id != 'Desconhecido'
          AND (
              aluno_id LIKE 'Pessoa %'
              OR lower(aluno_id) = 'jk'
          )
          AND aluno_id NOT IN (
              SELECT DISTINCT aluno_id
              FROM ocorrencias
              WHERE aluno_id IS NOT NULL
                AND TRIM(aluno_id) != ''
          )
    """)
    removed += cur.rowcount or 0
    return removed


def get_pendencies(catalog: str = "", mode: str = "all"):
    get_db = _get("get_db")
    get_current_catalog = _get("get_current_catalog")
    load_quality_settings = _get("load_quality_settings")
    cat = catalog or get_current_catalog()
    if not cat:
        return {"summary": {}, "empty_people": [], "low_photo_people": [], "all_photos": [], "unknown_photos": [], "blurry_photos": [], "attention_photos": [], "closed_eyes_photos": [], "discarded_photos": []}

    with get_db(cat) as conn:
        cur = conn.cursor()
        _purge_placeholder_people(cur)
        conn.commit()
        placeholder_name_sql = """
            a.aluno_id IS NOT NULL
            AND TRIM(a.aluno_id) != ''
            AND a.aluno_id != 'system_catalog'
            AND a.aluno_id != 'Desconhecido'
            AND a.aluno_id NOT LIKE 'Pessoa %'
            AND lower(a.aluno_id) != 'jk'
        """
        cur.execute("""
            SELECT a.aluno_id FROM alunos a
            LEFT JOIN ocorrencias o ON o.aluno_id = a.aluno_id
            WHERE {placeholder_name_sql}
            GROUP BY a.aluno_id HAVING COUNT(o.foto_path) = 0
        """.format(placeholder_name_sql=placeholder_name_sql))
        empty_people = [{"id": r["aluno_id"], "name": r["aluno_id"], "total_photos": 0} for r in cur.fetchall()]

        min_photos = load_quality_settings()["min_photos_per_person"]
        cur.execute("""
            SELECT aluno_id, COUNT(DISTINCT foto_path) as total FROM ocorrencias
            WHERE aluno_id IS NOT NULL
              AND TRIM(aluno_id) != ''
              AND aluno_id NOT LIKE 'Pessoa %'
              AND aluno_id != 'Desconhecido'
              AND lower(aluno_id) != 'jk'
            GROUP BY aluno_id HAVING total < ?
        """, (min_photos,))
        low_photo_people = [{"id": r["aluno_id"], "name": r["aluno_id"], "total_photos": r["total"]} for r in cur.fetchall()]

        cur.execute("SELECT foto_path FROM discarded_photos LIMIT 500")
        discarded_photos = [photo_item_from_path(r["foto_path"], discarded=True) for r in cur.fetchall()]

        cur.execute("SELECT COUNT(*) as c FROM discarded_photos")
        total_discarded = cur.fetchone()["c"]

        cur.execute("SELECT DISTINCT foto_path FROM ocorrencias WHERE aluno_id LIKE 'Pessoa %' OR aluno_id = 'Desconhecido' LIMIT 500")
        unknown_photos = [photo_item_from_path(r["foto_path"]) for r in cur.fetchall()]

        cur.execute("SELECT COUNT(DISTINCT foto_path) as c FROM ocorrencias WHERE aluno_id LIKE 'Pessoa %' OR aluno_id = 'Desconhecido'")
        total_unknown = cur.fetchone()["c"]

        cur.execute("SELECT DISTINCT foto_path FROM ocorrencias WHERE blur_status = 'blurry' LIMIT 500")
        blurry_photos = [photo_item_from_path(r["foto_path"]) for r in cur.fetchall()]

        cur.execute("SELECT COUNT(DISTINCT foto_path) as c FROM ocorrencias WHERE blur_status = 'blurry'")
        total_blurry = cur.fetchone()["c"]

        cur.execute("SELECT DISTINCT foto_path FROM ocorrencias WHERE blur_status = 'attention' LIMIT 500")
        attention_photos = [photo_item_from_path(r["foto_path"]) for r in cur.fetchall()]

        cur.execute("SELECT COUNT(DISTINCT foto_path) as c FROM ocorrencias WHERE blur_status = 'attention'")
        total_attention = cur.fetchone()["c"]

        cur.execute("SELECT DISTINCT foto_path FROM ocorrencias WHERE closed_eyes = 1 LIMIT 500")
        closed_eyes_photos = [photo_item_from_path(r["foto_path"]) for r in cur.fetchall()]

        cur.execute("SELECT COUNT(DISTINCT foto_path) as c FROM ocorrencias WHERE closed_eyes = 1")
        total_closed_eyes = cur.fetchone()["c"]

        cur.execute("SELECT COUNT(DISTINCT foto_path) as c FROM ocorrencias WHERE blur_status IS NULL OR blur_status = 'unknown'")
        unaudited_count = cur.fetchone()["c"]

        summary = {
            "empty_people": len(empty_people),
            "low_photo_people": len(low_photo_people),
            "unknown_photos": total_unknown,
            "blurry_photos": total_blurry,
            "attention_photos": total_attention,
            "closed_eyes_photos": total_closed_eyes,
            "discarded_photos": total_discarded,
            "unaudited_photos": unaudited_count,
            "blur_limited": False,
        }

        all_problem_map = {}
        for items in [unknown_photos, blurry_photos, attention_photos, closed_eyes_photos, discarded_photos]:
            for item in items:
                all_problem_map[item["path"]] = item

        all_photos = sorted(all_problem_map.values(), key=lambda x: x["name"].lower())[:500]
        summary["all_photos"] = len(all_problem_map)

    return {
        "summary": summary,
        "empty_people": empty_people,
        "low_photo_people": low_photo_people,
        "all_photos": all_photos,
        "unknown_photos": unknown_photos,
        "blurry_photos": blurry_photos,
        "attention_photos": attention_photos,
        "closed_eyes_photos": closed_eyes_photos,
        "discarded_photos": discarded_photos,
    }


def analyze_culling(aluno_id: str, catalog: str = ""):
    get_db = _get("get_db")
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT DISTINCT foto_path FROM ocorrencias WHERE aluno_id = ? AND created_at IS NULL", (aluno_id,))
            missing = cur.fetchall()
            if missing:
                for r in missing:
                    p = r["foto_path"]
                    try:
                        if os.path.exists(p):
                            mt = os.path.getmtime(p)
                            cur.execute("UPDATE ocorrencias SET created_at = ? WHERE foto_path = ? AND aluno_id = ?", (mt, p, aluno_id))
                    except Exception:
                        pass
                conn.commit()

            cur.execute("""
                SELECT foto_path, blur_score, blur_status, closed_eyes, x1, y1, x2, y2, created_at
                FROM ocorrencias
                WHERE aluno_id = ?
                ORDER BY created_at ASC
            """, (aluno_id,))
            rows = [dict(r) for r in cur.fetchall()]

            if not rows:
                return {"picks": []}

            groups = []
            current_group = []
            last_time = None

            for r in rows:
                t = r["created_at"] or 0
                if last_time is None or (t - last_time) < 7:
                    current_group.append(r)
                else:
                    groups.append(current_group)
                    current_group = [r]
                last_time = t
            if current_group:
                groups.append(current_group)

            picks = []
            for g in groups:
                best_photo = None
                max_score = -1
                for p in g:
                    score = 0
                    score += (p["blur_score"] or 0)
                    if not p["closed_eyes"]:
                        score += 150
                    area = (p["x2"] - p["x1"]) * (p["y2"] - p["y1"])
                    score += area / 1000.0
                    if p["blur_status"] == "blurry":
                        score -= 500
                    if score > max_score:
                        max_score = score
                        best_photo = p["foto_path"]
                if best_photo:
                    picks.append(best_photo)

            return {"picks": picks}
    except Exception as e:
        _get("log_info")(f"ERRO no Culling: {e}")
        raise HTTPException(500, str(e))


def get_image_thumb(path: str, size: int = 300, quality: int = 80):
    started = time.perf_counter()
    
    if path.startswith("cloud://"):
        drive_file_id = path[8:]
        try:
            from cloud.drive_cache import cache, download_queue
            from cloud import is_authenticated, drive_manager
            thumb_path = cache.get_thumb_path(drive_file_id)
            if cache.thumb_exists(drive_file_id):
                return FileResponse(thumb_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            if is_authenticated():
                file_info = drive_manager.get_file_metadata(drive_file_id)
                if file_info:
                    download_queue.add_task(
                        file_id=drive_file_id,
                        file_type="thumb",
                        url=file_info.thumbnailLink or f"https://drive.google.com/uc?id={drive_file_id}",
                        dest_path=cache.get_thumb_dir(),
                        priority=1
                    )
        except Exception as e:
            _log_thumb_perf("cloud", drive_file_id, size, (time.perf_counter() - started) * 1000.0, "error", extra=str(e))
        return Response(status_code=202)
    
    decoded_path = _resolve_preview_path(path)
    log_info = _get("log_info")
    
    mode = "unknown"
    error_detail = ""
    
    try:
        if not os.path.exists(decoded_path):
            mode = "missing"
            raise HTTPException(status_code=404)
        
        cache_path = get_cached_thumb_path(decoded_path, "image", size, quality)
        
        cached_result = _get_result_from_cache(cache_path)
        if cached_result:
            mode = "result_cache"
            _log_thumb_perf("image", decoded_path, size, (time.perf_counter() - started) * 1000.0, "hit", extra="from_result_cache")
            return cached_result
        
        if os.path.exists(cache_path):
            mode = "cache_hit"
            _log_thumb_perf("image", decoded_path, size, (time.perf_counter() - started) * 1000.0, "hit")
            result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            _put_result_in_cache(cache_path, result)
            return result
        
        thumb_sem = _get_thumb_semaphore()
        wait_start = time.perf_counter()
        acquired = thumb_sem.acquire(timeout=15)
        wait_ms = (time.perf_counter() - wait_start) * 1000.0
        
        if not acquired:
            mode = "thumb_limit"
            error_detail = "muitas requisições simultâneas"
            if log_info:
                log_info(f"THUMB LIMIT: {os.path.basename(decoded_path)} - muitas requisições wait={wait_ms:.0f}ms")
            return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        
        if os.path.exists(cache_path):
            mode = "cache_hit_late"
            _log_thumb_perf("image", decoded_path, size, (time.perf_counter() - started) * 1000.0, "hit")
            thumb_sem.release()
            result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            _put_result_in_cache(cache_path, result)
            return result
        
        if _is_generating(cache_path):
            mode = "already_generating"
            elapsed = (time.perf_counter() - started) * 1000.0
            while _is_generating(cache_path) and elapsed < 5000:
                time.sleep(0.1)
                elapsed = (time.perf_counter() - started) * 1000.0
            
            if os.path.exists(cache_path):
                mode = "waited_generated"
                _log_thumb_perf("image", decoded_path, size, elapsed, "hit", extra="waited")
                thumb_sem.release()
                result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
                _put_result_in_cache(cache_path, result)
                return result
        
        _start_generating(cache_path)
        
        try:
            if log_info:
                log_info(f"THUMB generation: path={os.path.basename(decoded_path)} size={size} quality={quality}")
            
            # Motor Rust só é usado para qualidade padrão (80)
            if quality == 80 and _run_thumb_engine("image", decoded_path, cache_path, size):
                mode = "rust"
                _log_thumb_perf("image", decoded_path, size, (time.perf_counter() - started) * 1000.0, "rust")
                result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
                _put_result_in_cache(cache_path, result)
                return result
            
            pillow_sem = _get_pillow_semaphore()
            pillow_acquired = pillow_sem.acquire(timeout=10)
            
            if not pillow_acquired:
                mode = "pillow_limit"
                error_detail = "Pillow ocupado"
                if log_info:
                    log_info(f"THUMB PILLOW LIMIT: {os.path.basename(decoded_path)} - Pillow ocupado")
                thumb_sem.release()
                return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            
            try:
                mode = "pillow"
                if log_info:
                    log_info(f"THUMB PILLOW: path={os.path.basename(decoded_path)} quality={quality}")
                
                pil = load_pil_with_orientation(decoded_path)
                pil = pil.convert("RGB")
                pil.thumbnail((size, size), Image.Resampling.LANCZOS)
                
                buf = io.BytesIO()
                pil.save(buf, format="JPEG", quality=quality, optimize=True)
                buf.seek(0)
                
                saved = False
                try:
                    pil.save(cache_path, format="JPEG", quality=quality, optimize=True)
                    saved = True
                    _trim_thumb_cache()
                except Exception as save_err:
                    if log_info:
                        log_info(f"THUMB cache save error: {save_err}")
                
                mode = "pillow_done"
                _log_thumb_perf("image", decoded_path, size, (time.perf_counter() - started) * 1000.0, "miss", extra=f"wait={wait_ms:.0f}ms saved={saved} q={quality}")
                result = StreamingResponse(buf, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
                _put_result_in_cache(cache_path, result)
                return result
                
            except MemoryError as me:
                mode = "memory_error"
                error_detail = str(me)
                if log_info:
                    log_info(f"THUMB MEMORY ERROR: {os.path.basename(decoded_path)} - {error_detail}")
                thumb_sem.release()
                return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            except Exception as pil_err:
                mode = "pillow_error"
                error_detail = str(pil_err)
                if log_info:
                    log_info(f"THUMB PILLOW ERROR: {os.path.basename(decoded_path)} - {error_detail}")
                thumb_sem.release()
                return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            finally:
                pillow_sem.release()
                
        finally:
            _finish_generating(cache_path)
            thumb_sem.release()
            
    except HTTPException:
        raise
    except Exception as e:
        mode = "error"
        error_detail = str(e)
        elapsed = (time.perf_counter() - started) * 1000.0
        if log_info:
            log_info(f"THUMB ERROR: path={os.path.basename(decoded_path)} mode={mode} error={error_detail} time={elapsed:.0f}ms")
        return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        if _run_thumb_engine("image", decoded_path, cache_path, size):
            mode = "rust"
            _log_thumb_perf("image", decoded_path, size, (time.perf_counter() - started) * 1000.0, "rust")
            return FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        
        # Fallback Pillow com semáforo - limite estrito
        semaphore = _get_pillow_semaphore()
        acquired = semaphore.acquire(timeout=10)
        
        if not acquired:
            mode = "pillow_rejected"
            error_detail = "timeout no semáforo - muitas requisições"
            if log_info:
                log_info(f"THUMB PILLOW REJECTED: path={os.path.basename(decoded_path)} reason={error_detail}")
            # Retornar placeholder em vez de erro
            return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        
        try:
            mode = "pillow"
            if log_info:
                log_info(f"THUMB usando PILLOW: path={os.path.basename(decoded_path)}")
            
            pil = load_pil_with_orientation(decoded_path)
            pil = pil.convert("RGB")
            pil.thumbnail((size, size), Image.Resampling.LANCZOS)
            
            buf = io.BytesIO()
            pil.save(buf, format="JPEG", quality=80)
            buf.seek(0)
            try:
                pil.save(cache_path, format="JPEG", quality=80)
                _trim_thumb_cache()
            except Exception as save_err:
                if log_info:
                    log_info(f"THUMB erro ao salvar cache: {save_err}")
            
            mode = "pillow_success"
            _log_thumb_perf("image", decoded_path, size, (time.perf_counter() - started) * 1000.0, "miss")
            return StreamingResponse(buf, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            
        except MemoryError as me:
            mode = "memory_error"
            error_detail = str(me)
            if log_info:
                log_info(f"THUMB MEMORY ERROR: path={os.path.basename(decoded_path)} erro={error_detail}")
            return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        except Exception as pil_err:
            mode = "pillow_error"
            error_detail = str(pil_err)
            if log_info:
                log_info(f"THUMB PILLOW ERROR: path={os.path.basename(decoded_path)} erro={error_detail}")
            return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        finally:
            semaphore.release()
            
    except HTTPException:
        raise
    except Exception as e:
        mode = "error"
        error_detail = str(e)
        if log_info:
            log_info(f"THUMB ERRO final: path={os.path.basename(decoded_path)} mode={mode} erro={error_detail}")
        return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


def get_thumb(path: str, x1: int, y1: int, x2: int, y2: int, size: int = 120, expand: float = 0.35, quality: int = 80):
    started = time.perf_counter()
    decoded_path = urllib.parse.unquote(path)
    log_info = _get("log_info")
    
    mode = "unknown"
    error_detail = ""
    
    try:
        if not os.path.exists(decoded_path):
            mode = "missing"
            raise HTTPException(status_code=404)
        
        cache_path = get_cached_thumb_path(decoded_path, "face", x1, y1, x2, y2, size, expand, quality)
        
        cached_result = _get_result_from_cache(cache_path)
        if cached_result:
            mode = "result_cache"
            _log_thumb_perf("face", decoded_path, size, (time.perf_counter() - started) * 1000.0, "hit", extra="from_result_cache")
            return cached_result
        
        if os.path.exists(cache_path):
            mode = "cache_hit"
            _log_thumb_perf("face", decoded_path, size, (time.perf_counter() - started) * 1000.0, "hit", extra=f"expand={expand}")
            result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            _put_result_in_cache(cache_path, result)
            return result
        
        thumb_sem = _get_thumb_semaphore()
        wait_start = time.perf_counter()
        acquired = thumb_sem.acquire(timeout=15)
        wait_ms = (time.perf_counter() - wait_start) * 1000.0
        
        if not acquired:
            mode = "thumb_limit"
            if log_info:
                log_info(f"FACE THUMB LIMIT: {os.path.basename(decoded_path)} - muitas requisições")
            return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        
        if os.path.exists(cache_path):
            mode = "cache_hit_late"
            _log_thumb_perf("face", decoded_path, size, (time.perf_counter() - started) * 1000.0, "hit", extra=f"expand={expand}")
            thumb_sem.release()
            result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            _put_result_in_cache(cache_path, result)
            return result
        
        if _is_generating(cache_path):
            mode = "already_generating"
            elapsed = (time.perf_counter() - started) * 1000.0
            while _is_generating(cache_path) and elapsed < 5000:
                time.sleep(0.1)
                elapsed = (time.perf_counter() - started) * 1000.0
            
            if os.path.exists(cache_path):
                mode = "waited_generated"
                _log_thumb_perf("face", decoded_path, size, elapsed, "hit", extra="waited")
                thumb_sem.release()
                result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
                _put_result_in_cache(cache_path, result)
                return result
        
        _start_generating(cache_path)
        
        try:
            if _run_thumb_engine("face", decoded_path, cache_path, size, x1=x1, y1=y1, x2=x2, y2=y2, expand=expand):
                mode = "rust"
                _log_thumb_perf("face", decoded_path, size, (time.perf_counter() - started) * 1000.0, "rust", extra=f"expand={expand}")
                result = FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
                _put_result_in_cache(cache_path, result)
                return result
            
            pillow_sem = _get_pillow_semaphore()
            pillow_acquired = pillow_sem.acquire(timeout=10)
            
            if not pillow_acquired:
                mode = "pillow_limit"
                if log_info:
                    log_info(f"FACE PILLOW LIMIT: {os.path.basename(decoded_path)}")
                thumb_sem.release()
                return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            
            try:
                mode = "pillow"
                pil = load_pil_with_orientation(decoded_path).convert("RGB")
                w, h = pil.size
                if w == 0 or h == 0:
                    raise Exception("dimensão inválida")

                x1 = max(0, min(x1, w - 1))
                y1 = max(0, min(y1, h - 1))
                x2 = max(x1 + 1, min(x2, w))
                y2 = max(y1 + 1, min(y2, h))
                face_w, face_h = x2 - x1, y2 - y1

                v_expand = expand + 0.1
                left = max(0, x1 - int(face_w * expand))
                top = max(0, y1 - int(face_h * v_expand))
                right = min(w, x2 + int(face_w * expand))
                bottom = min(h, y2 + int(face_h * v_expand))

                crop = pil.crop((left, top, right, bottom))
                crop.thumbnail((size, size), Image.Resampling.LANCZOS)
                jpeg_quality = max(60, min(int(quality), 95))

                buf = io.BytesIO()
                crop.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
                buf.seek(0)
                
                saved = False
                try:
                    crop.save(cache_path, format="JPEG", quality=jpeg_quality, optimize=True)
                    saved = True
                    _trim_thumb_cache()
                except Exception as save_err:
                    if log_info:
                        log_info(f"FACE cache save error: {save_err}")
                
                mode = "pillow_done"
                _log_thumb_perf("face", decoded_path, size, (time.perf_counter() - started) * 1000.0, "miss", extra=f"wait={wait_ms:.0f}ms saved={saved} q={jpeg_quality}")
                result = StreamingResponse(buf, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
                _put_result_in_cache(cache_path, result)
                return result
                
            except MemoryError as me:
                mode = "memory_error"
                error_detail = str(me)
                if log_info:
                    log_info(f"FACE MEMORY ERROR: {os.path.basename(decoded_path)} - {error_detail}")
                thumb_sem.release()
                return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            except Exception as pil_err:
                mode = "pillow_error"
                error_detail = str(pil_err)
                if log_info:
                    log_info(f"FACE PILLOW ERROR: {os.path.basename(decoded_path)} - {error_detail}")
                thumb_sem.release()
                return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            finally:
                pillow_sem.release()
                
        finally:
            _finish_generating(cache_path)
            thumb_sem.release()
            
    except HTTPException:
        raise
    except Exception as e:
        mode = "error"
        error_detail = str(e)
        elapsed = (time.perf_counter() - started) * 1000.0
        if log_info:
            log_info(f"FACE ERROR: path={os.path.basename(decoded_path)} mode={mode} error={error_detail} time={elapsed:.0f}ms")
        return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    except HTTPException:
        raise
    except Exception as e:
        mode = "error"
        error_detail = str(e)
        if log_info:
            log_info(f"FACE THUMB ERRO final: path={os.path.basename(decoded_path)} mode={mode} erro={error_detail}")
        return StreamingResponse(_create_error_placeholder(size), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


def get_image(path: str):
    decoded_path = _resolve_preview_path(path)
    if os.path.exists(decoded_path):
        return FileResponse(decoded_path)
    raise HTTPException(status_code=404)

def get_image_resized(path: str, max_size: int = 1200):
    decoded_path = _resolve_preview_path(path)
    try:
        safe_size = max(1, min(int(max_size or 1200), 2560))
        cache_path = get_cached_thumb_path(decoded_path, f"resized_{safe_size}", safe_size)
        
        if os.path.exists(cache_path):
            return FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
        
        with Image.open(decoded_path) as img:
            img.thumbnail((safe_size, safe_size), Image.Resampling.LANCZOS)
            img.save(cache_path, format="JPEG", quality=85, optimize=True)
        
        return FileResponse(cache_path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    except HTTPException:
        raise
    except Exception as e:
        log_info = _get("log_info")
        if log_info:
            log_info(f"Erro ao redimensionar imagem: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def get_image_preview(path: str, size: int = 1920):
    safe_size = max(1, min(int(size or 1920), 2560))
    return get_image_resized(path, safe_size)


def explorer_entry_info(path, entry_type, name=None):
    info = {
        "name": name or os.path.basename(path),
        "path": path,
        "type": entry_type,
        "size": None,
        "mtime": None,
        "ctime": None,
    }
    try:
        stat = os.stat(path)
        info["mtime"] = stat.st_mtime
        info["ctime"] = stat.st_ctime
        if os.path.isfile(path):
            info["size"] = stat.st_size
    except Exception:
        pass
    return info


def _normalized_abs_path(path):
    return os.path.normcase(os.path.abspath(os.path.normpath(path)))


def _is_within_root(path, root):
    if not path or not root:
        return False
    try:
        abs_path = _normalized_abs_path(path)
        abs_root = _normalized_abs_path(root)
        return abs_path == abs_root or abs_path.startswith(abs_root + os.sep)
    except Exception:
        return False


def _get_catalog_root_path(get_db, catalog):
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = 'system_catalog'")
            row = cur.fetchone()
            if row and row["face_cache_path"]:
                return str(row["face_cache_path"])
    except Exception:
        pass
    return ""


def explorer_ls(path: str = "", catalog: str = ""):
    get_db = _get("get_db")
    catalog_root = _get_catalog_root_path(get_db, catalog) if catalog else ""

    if not path:
        home = os.path.expanduser("~")
        desktop = os.path.join(home, "Desktop")
        documents = os.path.join(home, "Documents")
        pictures = os.path.join(home, "Pictures")

        dirs = [
            {"name": "Este Computador", "path": "este_computador", "type": "drive", "size": None, "mtime": None, "ctime": None},
            {"name": "Área de Trabalho", "path": desktop, "type": "dir"},
            explorer_entry_info(documents, "dir", "Documentos"),
            explorer_entry_info(home, "dir", os.path.basename(home)),
            explorer_entry_info(pictures, "dir", "Imagens"),
        ]

        try:
            with get_db(catalog) as conn:
                cur = conn.cursor()
                cur.execute("SELECT foto_path FROM ocorrencias LIMIT 1")
                row = cur.fetchone()
                if row and row["foto_path"]:
                    catalog_dir = os.path.dirname(row["foto_path"])
                    dirs.insert(1, {"name": "Pasta do Catálogo Atual", "path": catalog_dir, "type": "dir"})
        except Exception:
            pass

        return {"current_path": "", "dirs": dirs, "files": []}

    if path == "este_computador":
        drives = []
        try:
            from ctypes import windll
            bitmask = windll.kernel32.GetLogicalDrives()
            import string
            for letter in string.ascii_uppercase:
                if bitmask & 1:
                    drives.append(letter + ":\\")
                bitmask >>= 1
        except Exception:
            pass
        dirs = [explorer_entry_info(d, "drive", f"Disco Local ({d[:2]})" if "C:" in d else f"Unidade ({d[:2]})") for d in drives]
        return {"current_path": "este_computador", "dirs": dirs, "files": []}

    if path in ["desktop", "downloads", "documents", "pictures", "catalog"]:
        home = os.path.expanduser("~")
        if path == "desktop":
            path = os.path.join(home, "Desktop")
        elif path == "downloads":
            path = os.path.join(home, "Downloads")
        elif path == "documents":
            path = os.path.join(home, "Documents")
        elif path == "pictures":
            path = os.path.join(home, "Pictures")
        elif path == "catalog":
            if catalog_root:
                path = catalog_root
            else:
                try:
                    with get_db(catalog) as conn:
                        cur = conn.cursor()
                        cur.execute("SELECT foto_path FROM ocorrencias LIMIT 1")
                        row = cur.fetchone()
                        if row and row["foto_path"]:
                            path = os.path.dirname(os.path.dirname(row["foto_path"]))
                except Exception:
                    pass

    path = urllib.parse.unquote(path)
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail="Path not found")

    dirs = []
    files = []
    recursive_catalog_view = bool(catalog_root and _is_within_root(path, catalog_root))
    try:
        if recursive_catalog_view:
            for root, _subdirs, filenames in os.walk(path):
                for filename in filenames:
                    if filename.lower().endswith((".jpg", ".jpeg", ".png")):
                        files.append(os.path.join(root, filename))
        else:
            entries = os.scandir(path)
            for e in entries:
                try:
                    if e.is_dir():
                        dirs.append(explorer_entry_info(e.path, "dir", e.name))
                    elif e.is_file() and e.name.lower().endswith((".jpg", ".jpeg", ".png")):
                        files.append(e.path)
                except Exception:
                    pass
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission Denied")

    file_status = []
    discarded = set()
    db_map = {}

    if catalog:
        try:
            with get_db(catalog) as conn:
                cur = conn.cursor()
                cur.execute("SELECT foto_path FROM discarded_photos")
                discarded = {r["foto_path"] for r in cur.fetchall()}

                cur.execute("SELECT foto_path, aluno_id, x1, y1, x2, y2 FROM ocorrencias")
                rows = cur.fetchall()
                for r in rows:
                    fp = r["foto_path"].lower().replace("\\", "/")
                    if fp not in db_map:
                        db_map[fp] = {"real_path": r["foto_path"], "faces": []}
                    db_map[fp]["faces"].append({
                        "aluno_id": r["aluno_id"],
                        "box": [r["x1"], r["y1"], r["x2"], r["y2"]],
                    })
        except Exception:
            pass

    for f in files:
        fnorm = f.lower().replace("\\", "/")
        db_path = f
        is_identified = False
        has_unknown = False
        faces = []

        if fnorm in db_map:
            faces = db_map[fnorm]["faces"]
            db_path = db_map[fnorm]["real_path"]
            for face in faces:
                if face["aluno_id"].startswith("Pessoa ") or face["aluno_id"] == "Desconhecido":
                    has_unknown = True

            identified_faces = [fc for fc in faces if not fc["aluno_id"].startswith("Pessoa ") and fc["aluno_id"] != "Desconhecido"]
            if identified_faces:
                is_identified = True

        # Adicionar informações de IA e Qualidade
        item_info = {
            "name": os.path.basename(f),
            "path": db_path,
            "type": "img",
            "size": None,
            "mtime": None,
            "ctime": None,
            "in_db": fnorm in db_map,
            "is_identified": is_identified,
            "has_unknown": has_unknown,
            "discarded": db_path in discarded or f in discarded,
            "faces": faces,
        }
        
        # Injetar Blur e AI Score apenas se disponível (não calcular síncrono no ls)
        get_blur_info = _get("get_blur_info")
        automation = _get("automation")
        
        # Tentar pegar do banco se possível (aqui poderíamos injetar dados do db_map se tivéssemos carregado blur_status etc)
        # Por enquanto, vamos apenas evitar o cálculo pesado síncrono se não for estritamente necessário
        # ou se o arquivo for muito grande.

        file_status.append(item_info)
        file_status[-1].update({k: v for k, v in explorer_entry_info(f, "img").items() if k in ("size", "mtime", "ctime")})

    if not recursive_catalog_view:
        dirs.sort(key=lambda x: x["name"].lower())
    file_status.sort(key=lambda x: x["name"].lower())

    return {"current_path": path, "dirs": dirs, "files": file_status}


def get_discard_candidates(catalog: str = ""):
    get_db = _get("get_db")
    with get_db(catalog) as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT foto_path, COUNT(*) as faces_cnt
            FROM ocorrencias
            GROUP BY foto_path
            HAVING faces_cnt > 1
            ORDER BY foto_path COLLATE NOCASE ASC
        """)
        paths = [r["foto_path"] for r in cur.fetchall()]
        cur.execute("SELECT foto_path, aluno_id, x1, y1, x2, y2 FROM ocorrencias")
        db_map = {}
        for r in cur.fetchall():
            fp = r["foto_path"]
            if fp not in db_map:
                db_map[fp] = []
            db_map[fp].append({
                "aluno_id": r["aluno_id"],
                "x1": r["x1"], "y1": r["y1"], "x2": r["x2"], "y2": r["y2"],
            })
        cur.execute("SELECT foto_path FROM discarded_photos")
        discarded = {r["foto_path"] for r in cur.fetchall()}
        items = []

    for fp in paths:
        item = {
            "path": fp,
            "name": os.path.basename(fp),
            "type": os.path.splitext(fp)[1].lower().lstrip(".") or "img",
            "size": None,
            "mtime": None,
            "ctime": None,
            "discarded": fp in discarded,
            "faces": db_map.get(fp, []),
        }
        try:
            stat = os.stat(fp)
            item["size"] = stat.st_size
            item["mtime"] = stat.st_mtime
            item["ctime"] = stat.st_ctime
        except Exception:
            pass
        # Injetar informações de IA apenas se já processado
        automation = _get("automation")
        get_blur_info = _get("get_blur_info")
        if automation and get_blur_info and os.path.exists(fp):
            # Passar check_only=True se a função suportar, ou apenas evitar se for lento
            pass 

        items.append(item)

    return items


RAW_EXTENSIONS = (".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf", ".srw", ".x3f")
VIDEO_EXTENSIONS = (".mov", ".mp4", ".avi", ".mts", ".m2ts", ".insv", ".360")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
HEIC_EXT = (".heic", ".heif")


def _get_camera_model(file_path):
    """Helper to extract camera model from EXIF."""
    try:
        with Image.open(file_path) as img:
            exif = img._getexif()
            if not exif:
                return None
            make = exif.get(271, "")  # Make
            model = exif.get(272, "") # Model
            if not make and not model:
                return None
            full = f"{make} {model}".strip()
            # Clean up common strings
            return full.replace("CORPORATION", "").replace("Canon ", "").replace("NIKON ", "").strip()
    except Exception:
        return None


_IGNORED_DIRS = frozenset({
    ".preview_ocr_debug", "__pycache__", ".git", "node_modules", "dist", "target", ".venv"
})

_IGNORED_FILE_PATTERNS = (
    "_crop_", "_processed", "debug_",
)


def _is_ignored_dir(name: str) -> bool:
    return name.startswith(".") or name in _IGNORED_DIRS


def _is_ignored_file(name: str) -> bool:
    lower = name.lower()
    for pat in _IGNORED_FILE_PATTERNS:
        if pat in lower:
            return True
    return False


def _scan_tree(path, depth=0, max_depth=2):
    """Recursively scan folder structure up to max_depth.
    Returns (children, direct_files, direct_counts, has_children).
    """
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name.lower())
    except PermissionError:
        return [], 0, {"RAW": 0, "JPG": 0, "PNG": 0, "HEIC": 0, "MOV": 0}, False

    children = []
    direct_files = 0
    direct_counts = {"RAW": 0, "JPG": 0, "PNG": 0, "HEIC": 0, "MOV": 0}
    has_children = False
    camera_model = None
    first_image = None

    for e in entries:
        if _is_ignored_dir(e.name):
            continue
        try:
            if e.is_dir():
                reached_limit = max_depth is not None and (depth + 1) >= max_depth

                if reached_limit:
                    # At depth limit: shallow scan to get counts for THIS folder
                    sub_has = False
                    sub_direct = 0
                    sub_counts = {"RAW": 0, "JPG": 0, "PNG": 0, "HEIC": 0, "MOV": 0}
                    try:
                        with os.scandir(e.path) as sub_entries:
                            for s in sub_entries:
                                if s.is_dir():
                                    sub_has = True
                                elif s.is_file():
                                    ext = os.path.splitext(s.name)[1].lower()
                                    if ext in RAW_EXTENSIONS: sub_counts["RAW"] += 1; sub_direct += 1
                                    elif ext in IMAGE_EXT: sub_counts["JPG"] += 1; sub_direct += 1
                                    elif ext in HEIC_EXT: sub_counts["HEIC"] += 1; sub_direct += 1
                                    elif ext in VIDEO_EXTENSIONS: sub_counts["MOV"] += 1; sub_direct += 1
                    except Exception: pass

                    children.append({
                        "name": e.name,
                        "path": e.path,
                        "type": "folder",
                        "direct_files": sub_direct,
                        "total_files": sub_direct,
                        "has_children": sub_has,
                        "counts": sub_counts,
                        "children": [],
                        "camera": None
                    })
                    has_children = True
                else:
                    sub_children, sub_direct, sub_counts, sub_has, sub_camera = _scan_tree(e.path, depth + 1, max_depth)

                    # Aggregate totals for this subfolder
                    sub_total = sub_direct
                    agg_counts = dict(sub_counts)
                    for sub in sub_children:
                        sub_total += sub["total_files"]
                        for k in agg_counts:
                            agg_counts[k] = agg_counts.get(k, 0) + sub["counts"].get(k, 0)

                    children.append({
                        "name": e.name,
                        "path": e.path,
                        "type": "folder",
                        "direct_files": sub_direct,
                        "total_files": sub_total,
                        "has_children": sub_has or len(sub_children) > 0,
                        "counts": agg_counts,
                        "children": sub_children,
                        "camera": sub_camera
                    })
                    has_children = True

            elif e.is_file():
                if _is_ignored_file(e.name):
                    continue
                ext = os.path.splitext(e.name)[1].lower()
                if ext in RAW_EXTENSIONS:
                    direct_counts["RAW"] += 1
                    direct_files += 1
                elif ext in IMAGE_EXT:
                    direct_counts["JPG"] += 1
                    direct_files += 1
                elif ext in HEIC_EXT:
                    direct_counts["HEIC"] += 1
                    direct_files += 1
                elif ext in VIDEO_EXTENSIONS:
                    direct_counts["MOV"] += 1
                    direct_files += 1
                
                if not camera_model and ext in IMAGE_EXT:
                    camera_model = _get_camera_model(e.path)
        except PermissionError:
            continue
        except Exception:
            continue

    return children, direct_files, direct_counts, has_children, camera_model


def explorer_tree(path: str, max_depth: int = 10):
    dec = urllib.parse.unquote(path)
    if not dec or not os.path.isdir(dec):
        return {"ok": False, "error": "Pasta não encontrada", "path": path, "name": "", "direct_files": 0, "total_files": 0, "children": []}

    base_name = os.path.basename(dec) or dec
    children, direct_files, direct_counts, has_children, camera_model = _scan_tree(dec, 0, max_depth)

    # Calculate totals: root files + recursive children
    total_files = direct_files
    total_raw = direct_counts.get("RAW", 0)
    total_jpg = direct_counts.get("JPG", 0)
    total_photos = direct_counts.get("JPG", 0) + direct_counts.get("HEIC", 0) + direct_counts.get("PNG", 0)

    for c in children:
        total_files += c["total_files"]
        total_raw += c["counts"].get("RAW", 0)
        total_jpg += c["counts"].get("JPG", 0)
        total_photos += c["counts"].get("JPG", 0) + c["counts"].get("HEIC", 0) + c["counts"].get("PNG", 0)

    return {
        "ok": True,
        "error": "",
        "path": dec,
        "name": base_name,
        "direct_files": direct_files,
        "total_files": total_files,
        "total_photos": total_photos,
        "total_raw": total_raw,
        "total_jpg": total_jpg,
        "has_children": has_children,
        "children": children,
        "camera": camera_model
    }


def explorer_photos(path: str, recursive: bool = False, limit: int = 0, offset: int = 0, include_raw: bool = True, include_video: bool = True):
    if not path:
        return {"ok": False, "error": "Path obrigatório", "path": "", "total": 0, "photos": []}

    dec = urllib.parse.unquote(path)
    dec = dec.replace("\\", "/").rstrip("/")

    if not os.path.exists(dec):
        return {"ok": False, "error": "Pasta não encontrada", "path": dec, "total": 0, "photos": []}

    if not os.path.isdir(dec):
        return {"ok": False, "error": "Caminho não é uma pasta", "path": dec, "total": 0, "photos": []}

    photo_paths = []
    SUPPORTED = set()
    SUPPORTED.update(RAW_EXTENSIONS)
    SUPPORTED.update(IMAGE_EXT)
    SUPPORTED.update(HEIC_EXT)
    if include_video:
        SUPPORTED.update(VIDEO_EXTENSIONS)

    try:
        if recursive:
            for root, _dirs, files in os.walk(dec):
                if _is_ignored_dir(os.path.basename(root)):
                    continue
                for fname in files:
                    if fname.startswith(".") or fname.startswith("~"):
                        continue
                    if _is_ignored_file(fname):
                        continue
                    ext = os.path.splitext(fname)[1].lower()
                    if ext in SUPPORTED:
                        full = os.path.join(root, fname)
                        photo_paths.append(full)
        else:
            for e in os.scandir(dec):
                if e.name.startswith(".") or e.name.startswith("~"):
                    continue
                if _is_ignored_dir(e.name):
                    continue
                if _is_ignored_file(e.name):
                    continue
                if e.is_file():
                    ext = os.path.splitext(e.name)[1].lower()
                    if ext in SUPPORTED:
                        photo_paths.append(e.path)
    except PermissionError:
        return {"ok": False, "error": "Sem permissão para acessar a pasta", "path": dec, "total": 0, "photos": []}

    if not include_raw:
        photo_paths = [p for p in photo_paths if os.path.splitext(p)[1].lower() not in RAW_EXTENSIONS]

    photo_paths.sort(key=lambda p: os.path.basename(p).lower())
    total = len(photo_paths)
    start = offset if offset > 0 else 0
    end = start + limit if limit > 0 else total
    page = photo_paths[start:end]

    photos = []
    for fp in page:
        ext = os.path.splitext(fp)[1].lower()
        is_raw = ext in RAW_EXTENSIONS
        is_video = ext in VIDEO_EXTENSIONS
        info = explorer_entry_info(fp, "img")
        fname = info["name"]
        parent = os.path.basename(os.path.dirname(fp))
        ftype = "raw" if is_raw else "video" if is_video else "image"
        encoded = urllib.parse.quote(fp, safe='')
        photos.append({
            "name": fname,
            "folder": parent,
            "path": info["path"],
            "ext": ext,
            "type": ftype,
            "size": info["size"],
            "mtime": info["mtime"],
            "is_raw": is_raw,
            "is_video": is_video,
            "thumb_url": f"/api/image_thumb?path={encoded}&size=300",
            "preview_url": f"/api/image_thumb?path={encoded}&size=1200",
        })

    return {
        "ok": True,
        "error": "",
        "path": dec,
        "recursive": recursive,
        "total": total,
        "limit": limit,
        "offset": offset,
        "photos": photos,
    }
