"""
Rotas de pessoas, fotos, busca e interação.
Extraídas de backend.py.
"""

import os
import time
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import people_data_manager as pdm
import review_manager as rm
import interaction_manager as im

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Pessoas ────────────────────────────────────────────────────

@router.get("/api/people")
def get_people(unknown: bool = False, catalog: str = ""):
    return pdm.get_people(unknown, catalog)


@router.get("/api/search/global")
def global_search(q: str = ""):
    return pdm.global_search(q)


@router.get("/api/suggestions")
def get_suggestions(aluno_id: str):
    return rm.get_suggestions(aluno_id)


@router.post("/api/rename-person")
def rename_person(req: rm.RenameReq):
    from utils import _invalidate_stats_caches
    _invalidate_stats_caches()
    result = rm.rename_person(req)
    pdm.invalidate_people_cache()
    return result


@router.post("/api/people/merge")
def merge_people(req: rm.MergePersonReq):
    """
    Mescla duas identidades de formando.
    - source_person_id: identidade que será absorvida/removida
    - target_person_id: identidade canônica que permanece
    """
    try:
        result = rm.merge_person_identities(req)
        pdm.invalidate_people_cache()
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/delete-person")
def delete_person(req: rm.DeletePersonReq):
    try:
        result = rm.delete_person(req)
        pdm.invalidate_people_cache()
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/delete-photo")
def delete_photo(req: rm.DeletePhotoReq):
    return rm.delete_photo(req)


# ── Fotos ──────────────────────────────────────────────────────

@router.get("/api/photos/all")
def get_all_photos(limit: int = None):
    return pdm.get_all_photos(limit)


@router.get("/api/photos")
def get_photos_page(catalog: str = "", limit: int = 100, offset: int = 0, subfolder: str = None):
    t0 = time.time()
    try:
        result = pdm.get_photos_page(catalog, limit, offset, subfolder)
        elapsed_ms = (time.time() - t0) * 1000
        logger.info(
            f"[photos-page] catalog={catalog or pdm.current_catalog()} offset={offset} limit={limit} subfolder={subfolder} total={result['total']} ms={elapsed_ms:.0f}"
        )
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[photos-page] ERROR catalog={catalog} offset={offset} limit={limit} subfolder={subfolder}")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": str(e), "detail": "Falha ao carregar fotos. Tente novamente."},
        )


@router.get("/api/photos/context")
def get_photo_context(path: str = "", catalog: str = ""):
    import urllib.parse
    try:
        decoded_path = urllib.parse.unquote(path or "").strip()
        if not decoded_path:
            return {"current": None, "previous": None, "next": None, "neighbors": [], "index": -1, "total": 0}
        photos = pdm.get_all_photos()
        if not photos:
            return {"current": None, "previous": None, "next": None, "neighbors": [], "index": -1, "total": 0}

        def _norm(value: str) -> str:
            return os.path.normcase(os.path.normpath(urllib.parse.unquote(value or "")))

        target_norm = _norm(decoded_path)
        index = next((i for i, photo in enumerate(photos) if _norm(str(photo.get("path", ""))) == target_norm), -1)

        if index < 0:
            base_name = os.path.basename(decoded_path)
            if base_name:
                index = next(
                    (i for i, photo in enumerate(photos) if os.path.basename(str(photo.get("path", ""))) == base_name),
                    -1,
                )

        if index < 0:
            return {"current": None, "previous": None, "next": None, "neighbors": [], "index": -1, "total": len(photos)}

        window = 3
        start = max(0, index - window)
        end = min(len(photos), index + window + 1)
        neighbors = photos[start:end]

        return {
            "current": photos[index],
            "previous": photos[index - 1] if index > 0 else None,
            "next": photos[index + 1] if index < len(photos) - 1 else None,
            "neighbors": neighbors,
            "index": index,
            "total": len(photos),
            "catalog": catalog or "",
        }
    except Exception as e:
        logger.exception("[photos/context] erro")
        return {"current": None, "previous": None, "next": None, "neighbors": [], "index": -1, "total": 0, "error": str(e)}


@router.get("/api/photos/{aluno_id}")
def get_person_photos(aluno_id: str, catalog: str = ""):
    from urllib.parse import unquote
    decoded = unquote(aluno_id)
    logger.info(f"[photos-api] incoming={aluno_id} decoded={decoded}")
    try:
        if "::" in decoded:
            logger.info(f"[photos-api] mode=person_key person_key={decoded}")
            result = pdm.get_photos_by_person_key(decoded, catalog)
            logger.info(f"[photos-api] photos_found={len(result)}")
            if not result:
                try:
                    from db import get_db
                    with get_db() as conn:
                        cur = conn.cursor()
                        cur.execute("""
                            SELECT DISTINCT person_key, aluno_id, COUNT(*) as cnt
                            FROM ocorrencias
                            WHERE person_key IS NOT NULL AND person_key != ''
                              AND aluno_id = ?
                            GROUP BY person_key
                            ORDER BY cnt DESC
                            LIMIT 10
                        """, (decoded.split("::")[-1] if "::" in decoded else decoded,))
                        samples = [dict(r) for r in cur.fetchall()]
                        logger.info(f"[photos-api] person_keys_for_aluno: {samples}")
                except Exception as log_e:
                    logger.info(f"[photos-api] debug_query_error: {log_e}")
            return result
        logger.info(f"[photos-api] mode=legacy aluno_id={decoded}")
        result = pdm.get_photos(decoded, catalog)
        logger.info(f"[photos-api] photos_found={len(result)}")
        return result
    except Exception as e:
        logger.exception("[photos] erro ao buscar fotos de %s", decoded)
        return []


@router.get("/api/culling/analyze/{aluno_id}")
def analyze_culling(aluno_id: str, catalog: str = ""):
    import media_manager as mm
    return mm.analyze_culling(aluno_id, catalog)


@router.get("/api/photo-info")
def get_photo_info(path: str, catalog: str = ""):
    try:
        import urllib.parse
        decoded_path = urllib.parse.unquote(path)
        if not os.path.exists(decoded_path):
            return {"faces": [], "discarded": False}
        from db import get_db
        get_db_fn = get_db
        with get_db_fn() as conn:
            cur = conn.cursor()
            try:
                cur.execute("SELECT discarded FROM fotos WHERE path = ?", (decoded_path,))
                row = cur.fetchone()
                discarded = bool(row["discarded"]) if row else False
            except Exception:
                discarded = False
            cur.execute("""
                SELECT x1, y1, x2, y2, aluno_id FROM ocorrencias 
                WHERE foto_path = ? AND aluno_id IS NOT NULL
            """, (decoded_path,))
            faces = []
            for f in cur.fetchall():
                if f["x1"] is not None:
                    faces.append({"box": [f["x1"], f["y1"], f["x2"], f["y2"]], "name": f["aluno_id"]})
        return {"faces": faces, "discarded": discarded}
    except Exception as e:
        return {"faces": [], "discarded": False}


# ── Identificação manual ───────────────────────────────────────

@router.post("/api/manual_identify")
def manual_identify(req: rm.ManualIdentifyReq):
    result = rm.manual_identify(req)
    pdm.invalidate_people_cache()
    return result


@router.post("/api/manual-search-photo")
def manual_search_photo(req: rm.ManualSearchReq):
    return rm.run_manual_search(req, update_state=False)


@router.post("/api/manual-search/start")
def start_manual_search(req: rm.ManualSearchReq):
    return rm.start_manual_search(req)


@router.get("/api/manual-search/status")
def get_manual_search_status():
    return rm.get_manual_search_status()


@router.post("/api/manual-search/cancel")
def cancel_manual_search():
    return rm.cancel_manual_search()


# ── Interação com sistema de arquivos ──────────────────────────

@router.get("/api/select-folder")
def select_folder():
    return im.select_folder()


@router.get("/api/select-image")
def select_image():
    import media_manager as mm
    return mm.select_image()


@router.get("/api/select-file")
def select_file():
    import media_manager as mm
    return mm.select_file()


@router.get("/api/folder-stats")
def folder_stats(path: str):
    return rm.folder_stats(path)


# ── Explorer ───────────────────────────────────────────────────

@router.get("/api/explorer/ls")
def explorer_ls(path: str = "", catalog: str = ""):
    import media_manager as mm
    return mm.explorer_ls(path, catalog)


@router.get("/api/explorer/tree")
def explorer_tree(path: str = "", max_depth: int = 3):
    import media_manager as mm
    return mm.explorer_tree(path, max_depth)


@router.get("/api/explorer/photos")
def explorer_photos(path: str = "", recursive: bool = False, limit: int = 0):
    import media_manager as mm
    return mm.explorer_photos(path, recursive, limit)


# ── Ações diversas ─────────────────────────────────────────────

class OpenFolderReq(BaseModel):
    path: str


@router.post("/api/open-folder")
def open_folder(req: OpenFolderReq):
    return im.open_folder(req.path)


@router.post("/api/open-photoshop")
def open_photoshop(req: OpenFolderReq):
    return im.open_photoshop(req.path)


@router.post("/api/open-file")
def open_file(req: OpenFolderReq):
    return im.open_file(req.path)
