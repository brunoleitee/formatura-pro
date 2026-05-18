"""
Gerenciamento de revisão e manipulação de dados de alunos e ocorrências faciais.
"""

import os
import hashlib
import json
import logging
import math
import re
import datetime
import shutil
import threading
import time
import urllib.parse
import unicodedata

import cv2
import numpy as np
from fastapi import HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional

# Cache para face_cache_path (com limite de tamanho)
face_cache_path_cache = {}
cache_lock = threading.Lock()
_CACHE_MAX_SIZE = 2000

def get_face_cache_path_cached(catalog_name, aluno_id):
    """Obtém face_cache_path com cache para evitar queries repetidas."""
    cache_key = f"{catalog_name}:{aluno_id}"
    with cache_lock:
        if cache_key in face_cache_path_cache:
            return face_cache_path_cache[cache_key]

    get_db = _get("get_db")
    if not callable(get_db):
        return None

    with get_db(catalog_name) as conn:
        cur = conn.cursor()
        cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = ?", (aluno_id,))
        row = cur.fetchone()
        path = row["face_cache_path"] if row else None
    
    with cache_lock:
        if len(face_cache_path_cache) >= _CACHE_MAX_SIZE:
            face_cache_path_cache.clear()
        face_cache_path_cache[cache_key] = path
    return path
from PIL import Image

_cfg = {}
logger = logging.getLogger(__name__)
_match_preview_cache: dict[str, tuple[dict, float]] = {}
_MATCH_PREVIEW_TTL = 10.0
_cluster_centroid_cache: dict[str, tuple[np.ndarray, float]] = {}
_CENTROID_CACHE_TTL = 30.0
_student_embed_cache: dict[str, tuple[list, list, float]] = {}
_STUDENT_EMBED_CACHE_TTL = 30.0
UNKNOWN_ALUNO_IDS = (
    "unknown",
    "desconhecido",
    "sem_nome",
    "nao_mapeado",
    "não_mapeado",
    "__unknown__",
)
GRADUATION_TAG_ORDER = ("beca", "canudo", "faixa", "capelo")


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    value = _get(name, default)
    return value() if callable(value) else value


def _sanitize_catalog_name(name: str) -> str:
    sanitize_catalog_name = _get("sanitize_catalog_name")
    if callable(sanitize_catalog_name):
        return sanitize_catalog_name(name)
    return str(name or "").strip()


def _current_catalog() -> str:
    get_current_catalog = _get("get_current_catalog")
    if callable(get_current_catalog):
        return str(get_current_catalog() or "")
    return ""


def _safe_filename(name: str) -> str:
    cleaned = "".join(ch for ch in str(name or "").strip() if ch.isalnum() or ch in (" ", "_", "-", "."))
    cleaned = cleaned.replace(" ", "_").strip("._")
    return cleaned or "Sem_Nome"


def _ensure_aluno_row(cur, aluno_id: str, face_cache_path: str = "n/a", class_name: str | None = None):
    resolved_class = str(class_name or "").strip() or "Sem turma"
    cur.execute("SELECT face_cache_path, class_name FROM alunos WHERE aluno_id = ? LIMIT 1", (aluno_id,))
    row = cur.fetchone()
    if row:
        existing_class = str(row["class_name"] or "").strip()
        if resolved_class and existing_class in ("", "Sem turma"):
            cur.execute("UPDATE alunos SET class_name = ? WHERE aluno_id = ?", (resolved_class, aluno_id))
        existing_face = str(row["face_cache_path"] or "").strip()
        if face_cache_path and existing_face in ("", "n/a"):
            cur.execute("UPDATE alunos SET face_cache_path = ? WHERE aluno_id = ?", (face_cache_path, aluno_id))
        return

    cur.execute(
        """
        INSERT OR IGNORE INTO alunos (aluno_id, face_cache_path, class_name)
        VALUES (?, ?, ?)
        """,
        (aluno_id, face_cache_path or "n/a", resolved_class),
    )


def _base_reference_max_side() -> int:
    value = _get("base_reference_max_side", 512)
    try:
        return max(128, int(value))
    except Exception:
        return 512


def _catalog_base_ref_path(catalog: str, aluno_id: str, ext: str) -> str:
    thumb_cache_dir = _get("thumb_cache_dir")
    if not thumb_cache_dir:
        return ""
    try:
        cname = _sanitize_catalog_name(catalog or _current_catalog())
    except Exception:
        return ""
    if not cname:
        return ""
    safe_ext = (ext or ".jpg").lower()
    if not safe_ext.startswith("."):
        safe_ext = f".{safe_ext}"
    return os.path.join(thumb_cache_dir, cname, f"{_safe_filename(aluno_id)}{safe_ext}")


def _save_resized_reference(dest: str, img_np):
    if img_np is None:
        return False
    try:
        if img_np.ndim == 3 and img_np.shape[2] >= 3:
            rgb = img_np[:, :, :3][:, :, ::-1]
        else:
            rgb = img_np
        image = Image.fromarray(rgb)
        max_side = _base_reference_max_side()
        if max(image.size) > max_side:
            image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        save_kwargs = {}
        if dest.lower().endswith((".jpg", ".jpeg")):
            save_kwargs.update({"quality": 92, "optimize": True})
        image.save(dest, **save_kwargs)
        return True
    except Exception:
        return False


def _pick_best_reference_candidate(conn, aluno_id: str):
    get_blur_info = _get("get_blur_info")
    cur = conn.cursor()
    cur.execute(
        """
        SELECT foto_path, x1, y1, x2, y2, blur_score, blur_status
        FROM ocorrencias
        WHERE aluno_id = ?
          AND foto_path IS NOT NULL
          AND x1 IS NOT NULL
        ORDER BY
          CASE
            WHEN blur_status = 'sharp' THEN 0
            WHEN blur_status = 'attention' THEN 1
            WHEN blur_status = 'blurry' THEN 2
            ELSE 3
          END ASC,
          COALESCE(blur_score, -1) DESC
        """,
        (aluno_id,),
    )
    rows = cur.fetchall()
    if not rows:
        return ""

    for row in rows:
        path = row["foto_path"]
        if not path or not os.path.exists(path):
            continue
        best_blur = float(row["blur_score"]) if row["blur_score"] is not None else -1.0
        if best_blur < 0 and callable(get_blur_info):
            try:
                blur_info = get_blur_info(path)
                if blur_info and blur_info.get("blur_score") is not None:
                    best_blur = float(blur_info["blur_score"])
            except Exception:
                pass
        return {
            "path": path,
            "box": [int(row["x1"]), int(row["y1"]), int(row["x2"]), int(row["y2"])],
            "blur_score": best_blur,
            "blur_status": row["blur_status"] or "unknown",
        }
    return ""


def _ensure_person_reference(conn, catalog: str, aluno_id: str, force: bool = False):
    if not aluno_id or aluno_id == "Desconhecido" or aluno_id.startswith("Pessoa "):
        return ""

    existing = get_face_cache_path_cached(catalog, aluno_id)
    existing = str(existing) if existing else ""
    if existing and os.path.exists(existing) and not force:
        return existing

    candidate = _pick_best_reference_candidate(conn, aluno_id)
    if not candidate:
        return existing

    candidate_path = candidate["path"]
    _, ext = os.path.splitext(candidate_path)
    dest = _catalog_base_ref_path(catalog, aluno_id, ext)
    if not dest:
        return existing
    try:
        if force and existing and os.path.exists(existing) and os.path.normcase(existing) != os.path.normcase(dest):
            try:
                os.remove(existing)
            except Exception:
                pass
        thumb_cache_dir = _get("thumb_cache_dir")
        if thumb_cache_dir:
            legacy_prefix = f"BASE_REF__{_sanitize_catalog_name(catalog or _current_catalog())}__{_safe_filename(aluno_id)}"
            for name in os.listdir(thumb_cache_dir):
                full = os.path.join(thumb_cache_dir, name)
                if os.path.isfile(full) and name.startswith(legacy_prefix):
                    try:
                        os.remove(full)
                    except Exception:
                        pass
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        image_loader = _get("imread_unicode")
        img_np = image_loader(candidate_path) if callable(image_loader) else None
        if img_np is not None and candidate.get("box"):
            x1, y1, x2, y2 = [int(v) for v in candidate["box"]]
            h, w = img_np.shape[:2]
            box_w = max(1, x2 - x1)
            box_h = max(1, y2 - y1)
            pad_x = max(8, int(box_w * 0.22))
            pad_y = max(8, int(box_h * 0.22))
            cx1 = max(0, x1 - pad_x)
            cy1 = max(0, y1 - pad_y)
            cx2 = min(w, x2 + pad_x)
            cy2 = min(h, y2 + pad_y)
            crop_bgr = img_np[cy1:cy2, cx1:cx2]
            if crop_bgr.size > 0:
                if not _save_resized_reference(dest, crop_bgr):
                    Image.fromarray(crop_bgr[:, :, ::-1]).save(dest, quality=92)
            else:
                shutil.copy2(candidate_path, dest)
        else:
            if not _save_resized_reference(dest, img_np):
                shutil.copy2(candidate_path, dest)
        cur.execute(
            "INSERT OR REPLACE INTO alunos (aluno_id, face_cache_path, class_name) VALUES (?, ?, ?)",
            (aluno_id, dest, "Sem turma"),
        )
        conn.commit()
        return dest
    except Exception as e:
        print(f"Falha criando referência base para {aluno_id}: {e}")
        return existing


def _remove_person_reference(conn, catalog: str, aluno_id: str):
    try:
        cur2 = conn.cursor()
        cur2.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = ?", (aluno_id,))
        row = cur2.fetchone()
        ref_path = str(row["face_cache_path"]) if row and row["face_cache_path"] else ""
    except Exception:
        ref_path = ""
    if ref_path and os.path.exists(ref_path):
        try:
            os.remove(ref_path)
        except Exception:
            pass
    try:
        legacy_dir = os.path.dirname(ref_path) if ref_path else ""
        if legacy_dir and os.path.isdir(legacy_dir) and not os.listdir(legacy_dir):
            os.rmdir(legacy_dir)
    except Exception:
        pass
class SyncReferencesReq(BaseModel):
    """Request para sincronizar referências faciais faltantes."""
    catalog: str = ""


def sync_missing_references(req: SyncReferencesReq):
    """
    Sincroniza referências faciais faltantes para alunos identificados.
    
    Cria imagens de referência para alunos que não têm face_cache_path definido.
    """
    get_db = _get("get_db")
    catalog = _sanitize_catalog_name(req.catalog or _current_catalog())
    if not catalog:
        raise HTTPException(status_code=400, detail="Nenhum catalogo selecionado")

    created = 0
    total = 0
    errors = []
    with get_db(catalog) as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT DISTINCT aluno_id
            FROM ocorrencias
            WHERE aluno_id NOT LIKE 'Pessoa %'
              AND aluno_id != 'Desconhecido'
            ORDER BY aluno_id ASC
            """
        )
        aluno_ids = [row["aluno_id"] for row in cur.fetchall() if row["aluno_id"]]
        total = len(aluno_ids)
        for aluno_id in aluno_ids:
            try:
                existing = get_face_cache_path_cached(catalog, aluno_id)
                existing = str(existing) if existing else ""
                ref_path = _ensure_person_reference(conn, catalog, aluno_id, force=True)
                if ref_path and (not existing or os.path.normcase(existing) != os.path.normcase(ref_path)):
                    created += 1
            except Exception as e:
                errors.append(f"{aluno_id}: {e}")

    return {"status": "ok", "created": created, "total": total, "catalog": catalog, "errors": errors[:8]}


class ManualIdentifyReq(BaseModel):
    """Request para identificação manual de uma face."""
    foto_path: str
    catalog: str
    box: list
    new_name: str


class ManualSearchReq(BaseModel):
    catalog: str
    image_path: str
    face_index: int = 0
    min_score: float = 0.45
    limit: int = 80
    unidentified_only: bool = False


class RenameReq(BaseModel):
    old_id: str
    new_id: str


class DeletePersonReq(BaseModel):
    aluno_id: str


class DeletePhotoReq(BaseModel):
    aluno_id: str
    foto_path: str


class RenamePhotoReq(BaseModel):
    old_path: str
    new_name: str


class DiscardPhotoReq(BaseModel):
    foto_path: str
    discard: bool = True


class BulkDiscardPhotoReq(BaseModel):
    catalog: str = ""
    foto_paths: Optional[list[str]] = None
    rowids: Optional[list[int]] = None
    photo_ids: Optional[list[int]] = None
    reason: Optional[str] = None

    def ids(self) -> list[int]:
        return self.rowids or self.photo_ids or []


class BulkRestorePhotoReq(BaseModel):
    catalog: str = ""
    foto_paths: Optional[list[str]] = None
    rowids: Optional[list[int]] = None
    photo_ids: Optional[list[int]] = None

    def ids(self) -> list[int]:
        return self.rowids or self.photo_ids or []


class BulkManualIdentifyReq(BaseModel):
    catalog: str
    new_name: str
    rowids: list[int]


class AssignUnknownClusterRequest(BaseModel):
    catalog: str = ""
    cluster_id: str
    aluno_id: str | None = None
    nome_formando: str | None = None


class IgnoreUnknownClusterRequest(BaseModel):
    catalog: str = ""
    cluster_id: str
    rowids: list[int] = []


class GraduationAnalysisRequest(BaseModel):
    catalog: str = ""


class GraduationManualOverrideRequest(BaseModel):
    catalog: str = ""
    rowids: list[int]
    action: str   # "confirm" | "remove"
    item: str     # "gown" | "diploma" | "sash" | "cap"


class QualitySettingsReq(BaseModel):
    blur_blurry_threshold: float
    blur_attention_threshold: float
    min_photos_per_person: int
    manual_search_min_score: float


def manual_identify(req: ManualIdentifyReq):
    """
    Identifica manualmente uma face específica em uma imagem.
    
    Atualiza o aluno_id da ocorrência facial e cria entrada na tabela alunos se necessário.
    """
    def update_single_face(cur, foto_path, x1, y1, x2, y2, new_name):
        _ensure_aluno_row(cur, new_name)
        cur.execute(
            """
            UPDATE ocorrencias SET aluno_id = ?
            WHERE foto_path COLLATE NOCASE = ? AND x1 = ? AND y1 = ? AND x2 = ? AND y2 = ?
            """,
            (new_name, foto_path, x1, y1, x2, y2),
        )

    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    backup_catalog_db(req.catalog, "antes_identificar")

    if len(req.box) != 4:
        raise HTTPException(status_code=400, detail="Invalid box")

    x1, y1, x2, y2 = [int(v) for v in req.box]
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    if x2 <= x1 or y2 <= y1:
        raise HTTPException(status_code=400, detail="Invalid box")

    with get_db(req.catalog) as conn:
        cur = conn.cursor()
        new_name = (req.new_name or "").strip() or "Desconhecido"
        cur.execute(
            "SELECT aluno_id FROM ocorrencias WHERE foto_path COLLATE NOCASE = ? AND x1 = ? AND y1 = ? AND x2 = ? AND y2 = ?",
            (req.foto_path, x1, y1, x2, y2),
        )
        row = cur.fetchone()
        old_id = row["aluno_id"] if row else None

        if old_id and old_id.startswith("Pessoa ") and new_name != "Desconhecido":
            _ensure_aluno_row(cur, new_name)
            cur.execute("UPDATE ocorrencias SET aluno_id = ? WHERE aluno_id = ?", (new_name, old_id))
            cur.execute("DELETE FROM alunos WHERE aluno_id = ?", (old_id,))
        elif old_id:
            update_single_face(cur, req.foto_path, x1, y1, x2, y2, new_name)
        else:
            _ensure_aluno_row(cur, new_name)
            cur.execute(
                """
                INSERT OR IGNORE INTO ocorrencias (aluno_id, foto_path, x1, y1, x2, y2)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (new_name, req.foto_path, x1, y1, x2, y2),
            )

        conn.commit()
        if new_name and new_name != "Desconhecido":
            _ensure_person_reference(conn, req.catalog, new_name)
    return {"status": "ok"}


def bulk_manual_identify(req: BulkManualIdentifyReq):
    import logging
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    backup_catalog_db(req.catalog, "antes_identificar_lote")

    rowids = [int(r) for r in (req.rowids or []) if str(r).strip() != ""]
    if not rowids:
        raise HTTPException(status_code=400, detail="Nenhuma face informada.")

    new_name = (req.new_name or "").strip() or "Desconhecido"
    updated = 0
    is_reset = (new_name.lower() in UNKNOWN_ALUNO_IDS)

    print(f"[REMOVE FACE ENDPOINT CALLED] catalog={req.catalog} new_name={new_name!r} rowids={rowids}")

    with get_db(req.catalog) as conn:
        cur = conn.cursor()
        _ensure_aluno_row(cur, new_name)

        # ── Salvar old_person ANTES de atualizar ──
        for rid in rowids:
            cur.execute("SELECT aluno_id, foto_path FROM ocorrencias WHERE rowid = ?", (rid,))
            old = cur.fetchone()
            old_id = str(old["aluno_id"]) if old else ""
            old_path = str(old["foto_path"]) if old else ""
            print(f"[REMOVE FACE ENDPOINT CALLED] face_id={rid} rowid={rid} catalog={req.catalog} old_aluno_id={old_id}")

        for i in range(0, len(rowids), 900):
            chunk = rowids[i:i + 900]
            placeholders = ",".join(["?"] * len(chunk))
            cur.execute(
                f"UPDATE OR REPLACE ocorrencias SET aluno_id = ? WHERE rowid IN ({placeholders})",
                [new_name] + chunk,
            )
            updated += cur.rowcount

        # ── Verificar update ──
        for rid in rowids:
            cur.execute("SELECT aluno_id FROM ocorrencias WHERE rowid = ?", (rid,))
            check = cur.fetchone()
            new_id = str(check["aluno_id"]) if check else "NOT FOUND"
            print(f"[Review RemoveFace] face_id={rid} new_aluno_id_after_update={new_id}")

        # ── Verificar embedding ──
        for rid in rowids:
            cur.execute("SELECT 1 FROM face_embeddings WHERE occurrence_rowid = ?", (rid,))
            has_emb = cur.fetchone() is not None
            print(f"[Review Cluster] face_id={rid} embedding exists={has_emb}")

        # If resetting to unknown, clean up legacy state
        if is_reset:
            for rid in rowids:
                print(f"[Review RemoveFace] set status pending = True (face_id={rid})")
            placeholders = ",".join(["?"] * len(rowids))
            cur.execute(f"DELETE FROM unknown_face_clusters WHERE face_id IN ({placeholders})", rowids)
            deleted_clusters = cur.rowcount
            print(f"[Review RemoveFace] deleted from unknown_face_clusters count={deleted_clusters}")

        conn.commit()

        # ── Verificar pós-commit ──
        if is_reset:
            cur.execute("SELECT aluno_id FROM ocorrencias WHERE rowid = ?", (rowids[0],))
            verify = cur.fetchone()
            print(f"[Review RemoveFace] pos-commit verify face_id={rowids[0]} aluno_id={verify['aluno_id'] if verify else 'NOT FOUND'}")

        logging.info(f"[bulk_manual_identify] catalog={req.catalog} name={new_name!r} rowids={len(rowids)} updated={updated}")
        if new_name and not is_reset:
            _ensure_person_reference(conn, req.catalog, new_name)

    if is_reset:
        _invalidate_review_cache(req.catalog)
        # ── Forçar re-clustering imediato ──
        try:
            with get_db(req.catalog) as conn2:
                cur2 = conn2.cursor()
                # Limpar cache antigo
                cur2.execute("DELETE FROM unknown_face_clusters")
                _cache_last_sync.pop(req.catalog, None)
                conn2.commit()

                # Rodar sync completo
                sync_result = _sync_review_cluster_cache(cur2)
                _cache_last_sync[req.catalog] = time.time()
                conn2.commit()

                print(f"[Review RemoveFace] forced re-cluster: unknown_faces={sync_result['unknown_faces']} clusters={sync_result['cluster_count']}")

                # Verificar se a face aparece nos clusters
                for rid in rowids:
                    cur2.execute("SELECT cluster_id FROM unknown_face_clusters WHERE face_id = ?", (rid,))
                    found = cur2.fetchone()
                    print(f"[UNKNOWN CLUSTERS] face removida encontrada? face_id={rid} -> {found['cluster_id'] if found else 'NOT FOUND'}")
        except Exception as e:
            import traceback
            print(f"[Review RemoveFace] re-cluster error: {e}")
            traceback.print_exc()
    return {"ok": True, "status": "ok", "updated": updated, "new_name": new_name}


def bulk_discard_photos(req: BulkDiscardPhotoReq):
    get_db = _get("get_db")
    backup_catalog_db = _get("backup_catalog_db")
    backup_catalog_db(req.catalog, "antes_descarte_lote")

    paths = list(req.foto_paths) if req.foto_paths else []
    ids = req.ids()
    
    with get_db(req.catalog) as conn:
        cur = conn.cursor()
        if ids:
            placeholders = ",".join(["?"] * len(ids))
            cur.execute(f"SELECT DISTINCT foto_path FROM ocorrencias WHERE rowid IN ({placeholders})", ids)
            paths.extend([row["foto_path"] for row in cur.fetchall()])
        
        unique_paths = set(p for p in paths if p)
        for path in unique_paths:
            cur.execute("INSERT OR IGNORE INTO discarded_photos (foto_path) VALUES (?)", (path,))
        conn.commit()
    return {"ok": True, "count": len(unique_paths)}


def bulk_restore_photos(req: BulkRestorePhotoReq):
    get_db = _get("get_db")
    backup_catalog_db = _get("backup_catalog_db")
    backup_catalog_db(req.catalog, "antes_restauro_lote")

    paths = list(req.foto_paths) if req.foto_paths else []
    ids = req.ids()

    with get_db(req.catalog) as conn:
        cur = conn.cursor()
        if ids:
            placeholders = ",".join(["?"] * len(ids))
            cur.execute(f"SELECT DISTINCT foto_path FROM ocorrencias WHERE rowid IN ({placeholders})", ids)
            paths.extend([row["foto_path"] for row in cur.fetchall()])

        unique_paths = set(p for p in paths if p)
        for path in unique_paths:
            cur.execute("DELETE FROM discarded_photos WHERE foto_path = ?", (path,))
        conn.commit()
    return {"ok": True, "count": len(unique_paths)}


AssignClusterReq = AssignUnknownClusterRequest


def _normalize_formando_name(name: str | None) -> str:
    return re.sub(r"\s+", " ", str(name or "").strip())


def _build_stable_aluno_id(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(ch for ch in ascii_name if not unicodedata.combining(ch))
    ascii_name = re.sub(r"[^\w\s-]", "", ascii_name, flags=re.UNICODE)
    ascii_name = re.sub(r"[\s-]+", "_", ascii_name).strip("_").upper()
    return ascii_name or "FORMANDO"


def _find_existing_aluno_id(cur, candidates: list[str]) -> str | None:
    seen = set()
    filtered = []
    for candidate in candidates:
        value = str(candidate or "").strip()
        if not value:
            continue
        key = value.casefold()
        if key in seen:
            continue
        seen.add(key)
        filtered.append(value)

    for value in filtered:
        cur.execute("SELECT aluno_id FROM alunos WHERE lower(aluno_id) = lower(?) LIMIT 1", (value,))
        row = cur.fetchone()
        if row and row["aluno_id"]:
            return str(row["aluno_id"])

    for value in filtered:
        cur.execute("SELECT aluno_id FROM ocorrencias WHERE lower(aluno_id) = lower(?) LIMIT 1", (value,))
        row = cur.fetchone()
        if row and row["aluno_id"]:
            return str(row["aluno_id"])
    return None


def _resolve_assign_aluno(cur, aluno_id: str | None, nome_formando: str | None) -> tuple[str, str]:
    resolved_aluno_id = str(aluno_id or "").strip()
    normalized_name = _normalize_formando_name(nome_formando)

    if not resolved_aluno_id and not normalized_name:
        raise HTTPException(status_code=400, detail="Informe aluno_id ou nome_formando")

    if resolved_aluno_id:
        existing = _find_existing_aluno_id(cur, [resolved_aluno_id])
        resolved_aluno_id = existing or resolved_aluno_id
        _ensure_aluno_row(cur, resolved_aluno_id)
        return resolved_aluno_id, normalized_name or resolved_aluno_id

    generated_aluno_id = _build_stable_aluno_id(normalized_name)
    existing = _find_existing_aluno_id(cur, [normalized_name, generated_aluno_id])
    resolved_aluno_id = existing or generated_aluno_id
    _ensure_aluno_row(cur, resolved_aluno_id)
    return resolved_aluno_id, normalized_name


def _ensure_unknown_face_clusters_schema(cur):
    try:
        cur.execute("PRAGMA table_info(unknown_face_clusters)")
        cols = {row["name"] for row in cur.fetchall()}
        if "suggested_student" not in cols:
            cur.execute("ALTER TABLE unknown_face_clusters ADD COLUMN suggested_student TEXT")
        if "suggested_similarity" not in cols:
            cur.execute("ALTER TABLE unknown_face_clusters ADD COLUMN suggested_similarity REAL")
        if "unknown_similar_id" not in cols:
            cur.execute("ALTER TABLE unknown_face_clusters ADD COLUMN unknown_similar_id TEXT")
        if "unknown_similar_similarity" not in cols:
            cur.execute("ALTER TABLE unknown_face_clusters ADD COLUMN unknown_similar_similarity REAL")
        if "best_student_debug" not in cols:
            cur.execute("ALTER TABLE unknown_face_clusters ADD COLUMN best_student_debug TEXT")
        if "best_similarity_debug" not in cols:
            cur.execute("ALTER TABLE unknown_face_clusters ADD COLUMN best_similarity_debug REAL")
    except Exception:
        pass


def _sync_unknown_face_clusters(cur, clusters: list[dict]):
    _ensure_unknown_face_clusters_schema(cur)
    now = time.time()
    cur.execute("DELETE FROM unknown_face_clusters")
    rows = []
    for cluster in clusters:
        ss = cluster.get("suggested_student")
        si = cluster.get("suggested_similarity")
        ui = cluster.get("unknown_similar_id")
        us = cluster.get("unknown_similar_similarity")
        bd = cluster.get("best_student_debug")
        bs = cluster.get("best_similarity_debug")
        for face in cluster.get("faces", []):
            rows.append(
                (
                    cluster["cluster_id"],
                    int(face["rowid"]),
                    face["path"],
                    float(cluster.get("cohesion_score") or 0.0),
                    ss,
                    float(si) if si is not None else None,
                    ui,
                    float(us) if us is not None else None,
                    bd,
                    float(bs) if bs is not None else None,
                    now,
                    now,
                )
            )
    if rows:
        cur.executemany(
            """
            INSERT INTO unknown_face_clusters
            (cluster_id, face_id, original_path, confidence,
             suggested_student, suggested_similarity,
             unknown_similar_id, unknown_similar_similarity,
             best_student_debug, best_similarity_debug,
             created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )


def _ensure_ignored_review_clusters_table(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS ignored_review_clusters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            catalog TEXT NOT NULL,
            cluster_id TEXT NOT NULL,
            created_at REAL DEFAULT (strftime('%s','now')),
            UNIQUE(catalog, cluster_id)
        )
        """
    )


def _ignored_review_cluster_filter(catalog: str) -> tuple[str, list[str]]:
    return (
        """
        NOT EXISTS (
            SELECT 1
            FROM ignored_review_clusters i
            WHERE i.catalog = ?
              AND i.cluster_id = u.cluster_id
        )
        """,
        [catalog],
    )


def _is_review_unknown_label(aluno_id: str | None) -> bool:
    value = re.sub(r"\s+", " ", str(aluno_id or "").strip())
    if not value:
        return False
    lowered = value.casefold()
    return lowered in UNKNOWN_ALUNO_IDS or lowered.startswith("pessoa ")


def _build_review_cluster_id(aluno_id: str | None, rowid: int) -> str:
    value = re.sub(r"\s+", " ", str(aluno_id or "").strip())
    lowered = value.casefold()
    if lowered.startswith("pessoa "):
        return f"scan::{value}"
    if lowered in UNKNOWN_ALUNO_IDS:
        return f"legacy-face::{int(rowid)}"
    return f"legacy-label::{value or int(rowid)}"


def _review_cluster_sort_key(cluster_id: str) -> tuple[int, int, str]:
    if cluster_id.startswith("scan::Pessoa "):
        try:
            number = int(cluster_id.split("Pessoa ", 1)[1])
        except Exception:
            number = 10**9
        return (0, number, cluster_id)
    if cluster_id.startswith("legacy-face::"):
        try:
            number = int(cluster_id.split("::", 1)[1])
        except Exception:
            number = 10**9
        return (2, number, cluster_id)
    return (1, 10**9, cluster_id)


def _load_review_occurrence_rows(cur) -> list:
    cur.execute(
        f"""
        SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2,
               blur_status, blur_score, closed_eyes,
               has_gown, has_diploma, has_sash, has_cap,
               face_front_score, graduation_score, graduation_tags,
               gown_confidence, diploma_confidence, sash_confidence, cap_confidence,
               manual_graduation_tags,
               is_foreground, foreground_score, background_penalty_reason
        FROM ocorrencias
        WHERE x1 IS NOT NULL
          AND (
              lower(aluno_id) IN ({",".join(["?"] * len(UNKNOWN_ALUNO_IDS))})
              OR lower(aluno_id) LIKE 'pessoa %'
          )
        ORDER BY aluno_id ASC, foto_path ASC, rowid ASC
        """,
        list(UNKNOWN_ALUNO_IDS),
    )
    return cur.fetchall()


def _extract_student_from_path(path: str) -> Optional[str]:
    if not path:
        return None
    m = re.search(r'ID_(\w+)', path, re.IGNORECASE)
    if m:
        return m.group(1)
    parent = os.path.dirname(path)
    if parent:
        folder = os.path.basename(parent)
        if folder and folder not in ('alunos', 'formandos', 'FOTOS', 'unknown', 'desconhecido'):
            return folder
    return None


def _row_to_review_item(row) -> dict:
    result = {
        "rowid": int(row["rowid"]),
        "aluno_id": row["aluno_id"],
        "foto_path": row["foto_path"],
        "box": [row["x1"], row["y1"], row["x2"], row["y2"]],
        "blur_status": row["blur_status"],
        "blur_score": row["blur_score"],
        "closed_eyes": bool(row["closed_eyes"]) if row["closed_eyes"] is not None else False,
        "has_gown": row["has_gown"],
        "has_diploma": row["has_diploma"],
        "has_sash": row["has_sash"],
        "has_cap": row["has_cap"],
        "face_front_score": row["face_front_score"],
        "graduation_score": row["graduation_score"],
        "graduation_tags": row["graduation_tags"],
        "gown_confidence": row["gown_confidence"],
        "diploma_confidence": row["diploma_confidence"],
        "sash_confidence": row["sash_confidence"],
        "cap_confidence": row["cap_confidence"],
        "manual_graduation_tags": row["manual_graduation_tags"],
        "is_foreground": row["is_foreground"],
        "foreground_score": row["foreground_score"],
        "background_penalty_reason": row["background_penalty_reason"],
    }
    # Include suggestion and unknown match data if present
    if "suggested_student" in row.keys():
        result["suggested_student"] = row["suggested_student"]
    if "suggested_similarity" in row.keys():
        ss = row["suggested_similarity"]
        result["suggested_similarity"] = float(ss) if ss is not None else None
    if "unknown_similar_id" in row.keys():
        result["unknown_similar_id"] = row["unknown_similar_id"]
    if "unknown_similar_similarity" in row.keys():
        us = row["unknown_similar_similarity"]
        result["unknown_similar_similarity"] = float(us) if us is not None else None
    if "best_student_debug" in row.keys():
        result["best_student_debug"] = row["best_student_debug"]
    if "best_similarity_debug" in row.keys():
        bd = row["best_similarity_debug"]
        result["best_similarity_debug"] = float(bd) if bd is not None else None
    return result


def _build_review_cluster_payload(
    cluster_id: str,
    cluster_number: int,
    comp_items: list[dict],
    include_faces: bool = False,
):
    priority_meta = [
        _build_face_priority_meta(item, 0.0, allow_fallback=False)
        for item in comp_items
    ]
    rep_item = _pick_cluster_cover_item(comp_items, priority_meta)
    rep_item_meta = priority_meta[comp_items.index(rep_item)]
    unique_paths = sorted({item["foto_path"] for item in comp_items if item.get("foto_path")})
    photo_count = len(unique_paths)
    quality_signal = [
        (meta["face_front_score"] * 0.68) + (meta["sharpness_score"] * 0.32)
        for meta in priority_meta
    ]
    cohesion_score = max(0.45, min(0.99, float(np.mean(quality_signal) if quality_signal else 0.45)))
    max_graduation_score = max((meta["graduation_score"] for meta in priority_meta), default=0.0)
    fg_count = sum(1 for item in comp_items if item.get("is_foreground") == 1)
    fg_ratio = fg_count / max(1, len(comp_items))
    priority_score = max_graduation_score + (photo_count * 1.5) + (cohesion_score * 12.0) + (fg_ratio * 2.0)
    cluster_manual_tags = sorted({
        tag for meta in priority_meta for tag in (meta.get("manual_graduation_tags") or [])
    })
    first_item = comp_items[0] if comp_items else {}
    suggested_student = first_item.get("suggested_student")
    suggested_similarity = first_item.get("suggested_similarity")
    unknown_similar_id = first_item.get("unknown_similar_id")
    unknown_similar_similarity = first_item.get("unknown_similar_similarity")
    best_student_debug = first_item.get("best_student_debug")
    best_similarity_debug = first_item.get("best_similarity_debug")

    cluster_payload = {
        "cluster_id": cluster_id,
        "cluster_number": cluster_number,
        "face_count": len(comp_items),
        "photo_count": photo_count,
        "total_photos": photo_count,
        "cohesion_score": round(cohesion_score, 4),
        "cohesion": round(cohesion_score, 4),
        "priority_score": round(float(priority_score), 4),
        "suggested_student": suggested_student,
        "suggested_similarity": round(float(suggested_similarity), 4) if suggested_similarity is not None else None,
        "best_student_debug": best_student_debug,
        "best_similarity_debug": round(float(best_similarity_debug), 4) if best_similarity_debug is not None else None,
        "unknown_similar_id": unknown_similar_id,
        "unknown_similar_similarity": round(float(unknown_similar_similarity), 4) if unknown_similar_similarity is not None else None,
        "graduation_tags": _ordered_cluster_tags(priority_meta),
        "has_gown": any(meta["has_gown"] for meta in priority_meta),
        "has_diploma": any(meta["has_diploma"] for meta in priority_meta),
        "has_sash": any(meta["has_sash"] for meta in priority_meta),
        "has_cap": any(meta["has_cap"] for meta in priority_meta),
        "gown_confidence": round(max((meta["gown_confidence"] for meta in priority_meta), default=0.0), 4),
        "diploma_confidence": round(max((meta["diploma_confidence"] for meta in priority_meta), default=0.0), 4),
        "sash_confidence": round(max((meta["sash_confidence"] for meta in priority_meta), default=0.0), 4),
        "cap_confidence": round(max((meta["cap_confidence"] for meta in priority_meta), default=0.0), 4),
        "manual_graduation_tags": cluster_manual_tags,
        "debug_graduation_source": _resolve_cluster_graduation_source(priority_meta),
        "preview_image": rep_item["foto_path"],
        "status": "pending_review",
        "representative": {
            "rowid": rep_item["rowid"],
            "path": rep_item["foto_path"],
            "box": rep_item["box"],
            "aluno_id": rep_item["aluno_id"],
            "blur_status": rep_item.get("blur_status"),
            "blur_score": rep_item.get("blur_score"),
            "closed_eyes": rep_item.get("closed_eyes", False),
            "has_gown": rep_item_meta["has_gown"],
            "has_diploma": rep_item_meta["has_diploma"],
            "has_sash": rep_item_meta["has_sash"],
            "has_cap": rep_item_meta["has_cap"],
            "face_front_score": rep_item_meta["face_front_score"],
            "graduation_score": rep_item_meta["graduation_score"],
            "is_representative": True,
            "is_foreground": rep_item.get("is_foreground"),
            "foreground_score": rep_item.get("foreground_score"),
            "background_penalty_reason": rep_item.get("background_penalty_reason"),
        },
    }
    if include_faces:
        cluster_payload["faces"] = [
            {
                "rowid": item["rowid"],
                "path": item["foto_path"],
                "box": item["box"],
                "aluno_id": item["aluno_id"],
                "blur_status": item.get("blur_status"),
                "blur_score": item.get("blur_score"),
                "closed_eyes": item.get("closed_eyes", False),
                "has_gown": meta["has_gown"],
                "has_diploma": meta["has_diploma"],
                "has_sash": meta["has_sash"],
                "has_cap": meta["has_cap"],
                "face_front_score": meta["face_front_score"],
                "graduation_score": meta["graduation_score"],
                "is_representative": item["rowid"] == rep_item["rowid"],
                "is_foreground": item.get("is_foreground"),
                "foreground_score": item.get("foreground_score"),
                "background_penalty_reason": item.get("background_penalty_reason"),
            }
            for item, meta in zip(comp_items, priority_meta)
        ]
    return cluster_payload


def _sync_review_cluster_cache(cur) -> dict:
    rows = _load_review_occurrence_rows(cur)
    if not rows:
        _sync_unknown_face_clusters(cur, [])
        print(f"[Cluster Sync] total unknown faces = 0")
        return {"unknown_faces": 0, "cluster_count": 0}

    cat = _current_catalog()

    # Log breakdown por aluno_id
    id_counts: dict[str, int] = {}
    for r in rows:
        aid = str(r["aluno_id"] or "")
        id_counts[aid] = id_counts.get(aid, 0) + 1
    print(f"[Cluster Sync] total unknown faces = {len(rows)}")
    print(f"[Cluster Sync] breakdown por aluno_id = {id_counts}")
    logger.info("[Review] sync clusters catalog=%s rows=%s", cat, len(rows))

    # ── Separar faces "Pessoa X" (scanner) de faces verdadeiramente desconhecidas ──
    scanner_rows = []  # Pessoa X: agrupar por label
    unknown_rows = []  # Desconhecido: agrupar por embedding

    for row in rows:
        aluno_id = str(row["aluno_id"] or "")
        if not _is_review_unknown_label(aluno_id):
            continue
        if aluno_id.lower().startswith("pessoa "):
            scanner_rows.append(row)
        else:
            unknown_rows.append(row)

    grouped: dict[str, list[dict]] = {}

    # ── Faces do scanner: agrupar por label (Pessoa 01, Pessoa 02, etc) ──
    for row in scanner_rows:
        cluster_id = _build_review_cluster_id(str(row["aluno_id"] or ""), int(row["rowid"]))
        grouped.setdefault(cluster_id, []).append(_row_to_review_item(row))

    # ── Faces desconhecidas: agrupar por embedding (cosine similarity) ──
    threshold = 0.50
    valid_embeddings = []
    valid_rows = []

    if unknown_rows:
        # Carregar embeddings do banco para todas as faces desconhecidas
        rowids = [int(r["rowid"]) for r in unknown_rows]
        emb_map = {}

        # Primeiro: verificar quantos registros existem na tabela
        for i in range(0, len(rowids), 900):
            chunk = rowids[i:i+900]
            placeholders = ",".join(["?"] * len(chunk))
            cur.execute(f"SELECT occurrence_rowid, embedding FROM face_embeddings WHERE occurrence_rowid IN ({placeholders})", chunk)
            db_rows = cur.fetchall()
            print(f"[Cluster Sync] DB query: requested {len(chunk)} rowids, found {len(db_rows)} embedding rows")
            for er in db_rows:
                rid = int(er["occurrence_rowid"])
                raw = er["embedding"]
                if raw is None:
                    print(f"[Cluster Sync] rowid={rid} embedding=NULL")
                    continue
                try:
                    emb = np.frombuffer(raw, dtype="float32")
                    if emb.size == 0:
                        print(f"[Cluster Sync] rowid={rid} embedding.size=0")
                        continue
                    norm = float(np.linalg.norm(emb))
                    if norm <= 0:
                        print(f"[Cluster Sync] rowid={rid} embedding.norm=0")
                        continue
                    emb_map[rid] = emb
                except Exception as e:
                    print(f"[Cluster Sync] rowid={rid} embedding parse error: {e} raw_type={type(raw)} raw_len={len(raw) if raw else 0}")

        # Fallback: gerar embeddings via InsightFace para faces sem embedding no banco
        conn_obj = getattr(cur, 'connection', None) or getattr(cur, '_connection', None)
        for row in unknown_rows:
            rid = int(row["rowid"])
            if rid not in emb_map:
                try:
                    emb = get_cached_occurrence_embedding(conn_obj, row) if conn_obj else None
                    if emb is not None:
                        norm = float(np.linalg.norm(emb))
                        if norm > 0:
                            emb_map[rid] = emb
                            print(f"[Cluster Sync] rowid={rid} embedding generated via InsightFace (norm={norm:.4f})")
                        else:
                            print(f"[Cluster Sync] rowid={rid} embedding generated but norm=0")
                    else:
                        print(f"[Cluster Sync] rowid={rid} embedding generation failed (image not found?)")
                except Exception as e:
                    print(f"[Cluster Sync] rowid={rid} embedding generation error: {e}")

        # Log quais faces tem embedding
        for row in unknown_rows:
            rid = int(row["rowid"])
            has_emb = rid in emb_map
            if not has_emb:
                print(f"[Cluster Sync] face rowid={rid} aluno_id={row['aluno_id']} SEM embedding")

        for row in unknown_rows:
            emb = emb_map.get(int(row["rowid"]))
            if emb is not None:
                norm = np.linalg.norm(emb)
                if norm > 0:
                    valid_embeddings.append(emb / norm)
                    valid_rows.append(row)

        print(f"[Cluster Sync] embeddings valid = {len(valid_embeddings)} / {len(unknown_rows)}")
        print(f"[Cluster Sync] threshold = {threshold}")

        if valid_embeddings and len(valid_embeddings) >= 2:
            emb_matrix = np.vstack(valid_embeddings)
            n = len(valid_rows)
            parent = list(range(n))

            def find(x):
                while parent[x] != x:
                    parent[x] = parent[parent[x]]
                    x = parent[x]
                return x

            def union(a, b):
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[rb] = ra

            # Comparar todos os pares
            block_size = 256
            max_sim = -1.0
            for start in range(0, n, block_size):
                block = emb_matrix[start:start + block_size]
                sims = block @ emb_matrix.T
                for local_i in range(sims.shape[0]):
                    i = start + local_i
                    row_sims = sims[local_i]
                    for j in range(i + 1, n):
                        sim_val = float(row_sims[j])
                        if sim_val > max_sim:
                            max_sim = sim_val
                        if sim_val >= threshold:
                            union(i, j)

            print(f"[Cluster Sync] similarity max = {max_sim:.4f}")

            # Agrupar por root
            clusters_by_root: dict[int, list[int]] = {}
            for idx in range(n):
                root = find(idx)
                clusters_by_root.setdefault(root, []).append(idx)

            print(f"[Cluster Sync] clusters created = {len(clusters_by_root)}")
            sizes = [len(idxs) for idxs in clusters_by_root.values()]
            print(f"[Cluster Sync] cluster sizes = {sizes}")

            for root, indices in clusters_by_root.items():
                cluster_id = f"unknown-emb::{valid_rows[indices[0]]['rowid']}"
                items = [_row_to_review_item(valid_rows[i]) for i in indices]
                grouped.setdefault(cluster_id, []).extend(items)
        else:
            # Sem embeddings suficientes: cada face vira cluster individual
            print(f"[Cluster Sync] FALLBACK: sem embeddings suficientes, criando clusters individuais")
            for row in unknown_rows:
                cluster_id = _build_review_cluster_id(str(row["aluno_id"] or ""), int(row["rowid"]))
                grouped.setdefault(cluster_id, []).append(_row_to_review_item(row))

    # ── Construir clusters finais ──
    clusters = []
    for idx, cluster_id in enumerate(sorted(grouped.keys(), key=_review_cluster_sort_key), start=1):
        clusters.append(
            _build_review_cluster_payload(
                cluster_id=cluster_id,
                cluster_number=idx,
                comp_items=grouped[cluster_id],
                include_faces=True,
            )
        )

    _sync_unknown_face_clusters(cur, clusters)
    print(f"[UNKNOWN CLUSTERS] total clusters retornados = {len(clusters)}")
    return {
        "unknown_faces": len(rows),
        "cluster_count": len(clusters),
    }


# In-memory cache invalidation: catalog -> last sync timestamp
_cache_last_sync: dict[str, float] = {}

def _invalidate_review_cache(catalog: str):
    _cache_last_sync.pop(catalog, None)
    print(f"[CACHE INVALIDATE] review clusters catalog={catalog}")


def _ensure_review_cluster_cache(cur) -> dict:
    started_at = time.perf_counter()
    cat = _current_catalog()
    cur.execute(
        f"""
        SELECT COUNT(*) AS cnt
        FROM ocorrencias
        WHERE x1 IS NOT NULL
          AND (
              lower(aluno_id) IN ({",".join(["?"] * len(UNKNOWN_ALUNO_IDS))})
              OR lower(aluno_id) LIKE 'pessoa %'
          )
        """,
        list(UNKNOWN_ALUNO_IDS),
    )
    unknown_faces = int((cur.fetchone() or {"cnt": 0})["cnt"] or 0)

    cur.execute("SELECT COUNT(*) AS cnt FROM ocorrencias WHERE x1 IS NOT NULL")
    total_faces_in_db = int((cur.fetchone() or {"cnt": 0})["cnt"] or 0)

    cur.execute("SELECT COUNT(*) AS cnt FROM unknown_face_clusters")
    cached_faces = int((cur.fetchone() or {"cnt": 0})["cnt"] or 0)

    last_sync = _cache_last_sync.get(cat)

    print(f"[Review Cache] catalog={cat} unknown_faces={unknown_faces} cached_faces={cached_faces} last_sync={'yes' if last_sync else 'no'}")

    logger.info(
        "[Review] catalog=%s unknown_faces=%s total_faces_in_db=%s cached_clusters=%s last_sync=%s",
        cat, unknown_faces, total_faces_in_db, cached_faces,
        "yes" if last_sync else "no",
    )

    if unknown_faces == 0:
        if cached_faces:
            _sync_unknown_face_clusters(cur, [])
        result = {
            "review_ready": True,
            "used_cache": cached_faces == 0,
            "unknown_faces": 0,
            "total_faces_in_catalog": total_faces_in_db,
            "cluster_count": 0,
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
        }
        if cached_faces:
            _cache_last_sync.pop(cat, None)
        logger.info("[Review] catalog=%s no unknown faces (total_faces=%s)", cat, total_faces_in_db)
        return result

    if cached_faces != unknown_faces or last_sync is None:
        print(f"[Review Cache] SYNC TRIGGERED: cached_faces={cached_faces} != unknown_faces={unknown_faces} or last_sync is None")
        sync_info = _sync_review_cluster_cache(cur)
        _cache_last_sync[cat] = time.time()
        logger.info(
            "[Review] catalog=%s sync done clusters=%s unknown_faces=%s",
            cat, sync_info["cluster_count"], sync_info["unknown_faces"],
        )
        return {
            "review_ready": True,
            "used_cache": False,
            "unknown_faces": sync_info["unknown_faces"],
            "total_faces_in_catalog": total_faces_in_db,
            "cluster_count": sync_info["cluster_count"],
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
        }

    print(f"[Review Cache] CACHE HIT: cached_faces={cached_faces} == unknown_faces={unknown_faces}")
    cur.execute("SELECT COUNT(DISTINCT cluster_id) AS cnt FROM unknown_face_clusters")
    cluster_count = int((cur.fetchone() or {"cnt": 0})["cnt"] or 0)
    logger.info("[Review] catalog=%s cache hit clusters=%s total_faces=%s", cat, cluster_count, total_faces_in_db)
    return {
        "review_ready": True,
        "used_cache": True,
        "unknown_faces": unknown_faces,
        "total_faces_in_catalog": total_faces_in_db,
        "cluster_count": cluster_count,
        "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
    }


def _ensure_action_logs_table(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS action_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            details TEXT,
            created_at REAL DEFAULT (strftime('%s','now'))
        )
        """
        )


def _coerce_flag(value) -> bool:
    if isinstance(value, str):
        value = value.strip().lower()
        if value in ("1", "true", "yes", "sim"):
            return True
        if value in ("0", "false", "no", "nao", "não", ""):
            return False
    return bool(value)


def _normalize_graduation_tag(tag: str) -> str | None:
    normalized = str(tag or "").strip().casefold()
    aliases = {
        "beca": "beca",
        "gown": "beca",
        "robe": "beca",
        "canudo": "canudo",
        "diploma": "canudo",
        "certificate": "canudo",
        "faixa": "faixa",
        "sash": "faixa",
        "capelo": "capelo",
        "cap": "capelo",
        "mortarboard": "capelo",
    }
    return aliases.get(normalized)


def _normalize_saved_graduation_tags(value) -> list[str]:
    raw_tags = value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raw_tags = []
        else:
            try:
                raw_tags = json.loads(text)
            except Exception:
                raw_tags = [part.strip() for part in text.split(",") if part.strip()]
    if not isinstance(raw_tags, (list, tuple, set)):
        raw_tags = []

    normalized = []
    seen = set()
    for item in raw_tags:
        tag = _normalize_graduation_tag(str(item or ""))
        if not tag or tag in seen:
            continue
        seen.add(tag)
        normalized.append(tag)
    return normalized


def _clamp01(value) -> float:
    try:
        return float(np.clip(float(value), 0.0, 1.0))
    except Exception:
        return 0.0


def _derive_face_front_score(item: dict) -> float:
    raw_score = item.get("face_front_score")
    if raw_score is not None:
        return _clamp01(raw_score)
    x1, y1, x2, y2 = [int(v) for v in item.get("box", [0, 0, 1, 1])]
    width = max(1, x2 - x1)
    height = max(1, y2 - y1)
    ratio = width / max(height, 1)
    ratio_score = max(0.0, 1.0 - (abs(ratio - 0.82) / 0.55))
    closed_eyes_penalty = 0.4 if item.get("closed_eyes") else 0.0
    return _clamp01(ratio_score * (1.0 - closed_eyes_penalty))


def _derive_sharpness_score(item: dict) -> float:
    blur_score = float(item.get("blur_score") or 0.0)
    status = str(item.get("blur_status") or "").strip().lower()
    if status == "sharp":
        base = 0.72
    elif status == "attention":
        base = 0.42
    elif status == "blurry":
        base = 0.14
    else:
        base = 0.22
    blur_boost = min(blur_score / 420.0, 0.28)
    return _clamp01(base + blur_boost)


def _extract_photo_path(photo: dict | str | None) -> str:
    if isinstance(photo, str):
        return photo
    if isinstance(photo, dict):
        return str(photo.get("foto_path") or photo.get("original_path") or photo.get("path") or "")
    return ""


def _extract_face_boxes(photo: dict | str | None) -> list[tuple[int, int, int, int]]:
    if not isinstance(photo, dict):
        return []
    boxes = []
    raw_boxes = photo.get("face_boxes") or []
    if isinstance(raw_boxes, (list, tuple)):
        for raw in raw_boxes:
            try:
                if isinstance(raw, dict):
                    box = raw.get("box") or raw.get("bbox") or raw.get("face_box")
                else:
                    box = raw
                if not box or len(box) < 4:
                    continue
                x1, y1, x2, y2 = [int(v) for v in box[:4]]
                if x2 > x1 and y2 > y1:
                    boxes.append((x1, y1, x2, y2))
            except Exception:
                continue
    single_box = photo.get("box") if isinstance(photo, dict) else None
    if not boxes and isinstance(single_box, (list, tuple)) and len(single_box) >= 4:
        try:
            x1, y1, x2, y2 = [int(v) for v in single_box[:4]]
            if x2 > x1 and y2 > y1:
                boxes.append((x1, y1, x2, y2))
        except Exception:
            pass
    return boxes


def _load_photo_bgr(photo_path: str):
    if not photo_path or not os.path.exists(photo_path):
        return None
    image_loader = _get("imread_unicode")
    if callable(image_loader):
        try:
            img = image_loader(photo_path)
            if img is not None:
                return img
        except Exception:
            pass
    try:
        data = np.fromfile(photo_path, dtype=np.uint8)
        if data.size == 0:
            return None
        return cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception:
        return None


def _resize_for_analysis(img_bgr, face_boxes: list[tuple[int, int, int, int]]):
    if img_bgr is None:
        return None, []
    h, w = img_bgr.shape[:2]
    max_side = max(h, w)
    if max_side <= 900:
        return img_bgr, face_boxes
    scale = 900.0 / float(max_side)
    resized = cv2.resize(
        img_bgr,
        (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    scaled_boxes = [
        (
            int(round(x1 * scale)),
            int(round(y1 * scale)),
            int(round(x2 * scale)),
            int(round(y2 * scale)),
        )
        for x1, y1, x2, y2 in face_boxes
    ]
    return resized, scaled_boxes


def _pick_primary_face(face_boxes: list[tuple[int, int, int, int]], w: int, h: int):
    if not face_boxes:
        return None
    return max(
        face_boxes,
        key=lambda box: ((box[2] - box[0]) * (box[3] - box[1]), -(box[1] + box[3])),
    )


def _clip_rect(rect: tuple[int, int, int, int], w: int, h: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = rect
    x1 = max(0, min(w - 1, int(x1)))
    y1 = max(0, min(h - 1, int(y1)))
    x2 = max(x1 + 1, min(w, int(x2)))
    y2 = max(y1 + 1, min(h, int(y2)))
    return x1, y1, x2, y2


def _extract_roi(img, rect: tuple[int, int, int, int]):
    if img is None:
        return None
    h, w = img.shape[:2]
    x1, y1, x2, y2 = _clip_rect(rect, w, h)
    if x2 <= x1 or y2 <= y1:
        return None
    return img[y1:y2, x1:x2]


def _component_stats(mask_u8):
    if mask_u8 is None or mask_u8.size == 0:
        return []
    num_labels, labels, stats, _centroids = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    components = []
    for idx in range(1, num_labels):
        x, y, w, h, area = stats[idx]
        if area <= 0 or w <= 0 or h <= 0:
            continue
        components.append({
            "x": int(x),
            "y": int(y),
            "w": int(w),
            "h": int(h),
            "area": int(area),
            "aspect": float(max(w, h) / max(1, min(w, h))),
            "fill_ratio": float(area / max(1, w * h)),
        })
    return components


def _best_component(mask_u8, min_area_ratio: float = 0.0, min_aspect: float = 1.0):
    if mask_u8 is None or mask_u8.size == 0:
        return None
    roi_area = float(mask_u8.shape[0] * mask_u8.shape[1])
    best = None
    for comp in _component_stats(mask_u8):
        area_ratio = comp["area"] / max(1.0, roi_area)
        if area_ratio < min_area_ratio or comp["aspect"] < min_aspect:
            continue
        score = area_ratio * min(comp["aspect"], 4.0) * max(comp["fill_ratio"], 0.15)
        comp["area_ratio"] = area_ratio
        comp["score"] = score
        if best is None or score > best["score"]:
            best = comp
    return best


def _build_analysis_regions(primary_face, w: int, h: int):
    if primary_face is not None:
        x1, y1, x2, y2 = primary_face
        face_w = max(1, x2 - x1)
        face_h = max(1, y2 - y1)
        center_x = (x1 + x2) / 2.0
        torso = _clip_rect(
            (
                center_x - face_w * 1.55,
                y2 + face_h * 0.05,
                center_x + face_w * 1.55,
                y2 + face_h * 2.9,
            ),
            w,
            h,
        )
        head = _clip_rect(
            (
                center_x - face_w * 1.15,
                y1 - face_h * 0.95,
                center_x + face_w * 1.15,
                y1 + face_h * 0.25,
            ),
            w,
            h,
        )
        hands = _clip_rect(
            (
                center_x - face_w * 1.85,
                y2 + face_h * 0.9,
                center_x + face_w * 1.85,
                y2 + face_h * 2.75,
            ),
            w,
            h,
        )
    else:
        torso = _clip_rect((int(w * 0.2), int(h * 0.28), int(w * 0.8), int(h * 0.92)), w, h)
        head = _clip_rect((int(w * 0.28), 0, int(w * 0.72), int(h * 0.32)), w, h)
        hands = _clip_rect((int(w * 0.18), int(h * 0.48), int(w * 0.82), int(h * 0.92)), w, h)
    return {"torso": torso, "head": head, "hands": hands}


def _mask_ratio(mask) -> float:
    if mask is None or mask.size == 0:
        return 0.0
    return float(np.count_nonzero(mask) / max(1, mask.size))


def _clamp01(value: float) -> float:
    return float(max(0.0, min(1.0, value)))


GRADUATION_CONFIDENCE_THRESHOLD = 0.85


def analyze_graduation_items(photo: dict | str | None = None, enable_heuristics: bool = False) -> dict:
    photo_path = _extract_photo_path(photo)
    face_boxes = _extract_face_boxes(photo)
    tags: list[str] = []
    normalized_path = unicodedata.normalize("NFKD", photo_path)
    normalized_path = "".join(ch for ch in normalized_path if not unicodedata.combining(ch)).casefold()
    source_parts: list[str] = []
    run_visual_analysis = bool(enable_heuristics or (isinstance(photo, dict) and photo.get("force_visual_analysis")))
    path_has_gown = False
    path_has_diploma = False
    path_has_sash = False
    path_has_cap = False

    if enable_heuristics and normalized_path:
        if "beca" in normalized_path:
            path_has_gown = True
        if "canudo" in normalized_path or "diploma" in normalized_path:
            path_has_diploma = True
        if "faixa" in normalized_path:
            path_has_sash = True
        if "capelo" in normalized_path:
            path_has_cap = True
        if any((path_has_gown, path_has_diploma, path_has_sash, path_has_cap)):
            source_parts.append("path")

    img_bgr = None
    gown_confidence = 0.0
    sash_confidence = 0.0
    cap_confidence = 0.0
    diploma_confidence = 0.0
    face_present = False

    if run_visual_analysis:
        img_bgr = _load_photo_bgr(photo_path)
        img_bgr, face_boxes = _resize_for_analysis(img_bgr, face_boxes)

    if img_bgr is not None and img_bgr.ndim == 3:
        h, w = img_bgr.shape[:2]
        primary_face = _pick_primary_face(face_boxes, w, h)
        face_present = primary_face is not None
        regions = _build_analysis_regions(primary_face, w, h)
        hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
        torso_hsv = _extract_roi(hsv, regions["torso"])
        head_hsv = _extract_roi(hsv, regions["head"])
        hands_hsv = _extract_roi(hsv, regions["hands"])

        if torso_hsv is not None and torso_hsv.size > 0:
            torso_h = torso_hsv[:, :, 0]
            torso_s = torso_hsv[:, :, 1]
            torso_v = torso_hsv[:, :, 2]
            dark_mask = ((torso_v < 72) & (torso_s < 150)).astype(np.uint8) * 255
            dark_mask = cv2.morphologyEx(dark_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            dark_ratio = _mask_ratio(dark_mask)
            lower_slice = dark_mask[int(dark_mask.shape[0] * 0.35):, :]
            lower_dark_ratio = _mask_ratio(lower_slice)
            central_band = dark_mask[:, int(dark_mask.shape[1] * 0.2):int(dark_mask.shape[1] * 0.8)]
            central_dark_ratio = _mask_ratio(central_band)
            lower_central = dark_mask[int(dark_mask.shape[0] * 0.45):, int(dark_mask.shape[1] * 0.24):int(dark_mask.shape[1] * 0.76)]
            lower_central_ratio = _mask_ratio(lower_central)
            edge_cols = max(1, int(dark_mask.shape[1] * 0.14))
            side_mask = np.concatenate((dark_mask[:, :edge_cols], dark_mask[:, -edge_cols:]), axis=1)
            side_dark_ratio = _mask_ratio(side_mask)
            background_penalty = max(0.0, side_dark_ratio - central_dark_ratio)
            upper_torso = torso_hsv[:max(1, int(torso_hsv.shape[0] * 0.34)), :, :]
            upper_s = upper_torso[:, :, 1]
            upper_v = upper_torso[:, :, 2]
            collar_mask = ((upper_s > 82) & (upper_v > 74)).astype(np.uint8) * 255
            collar_mask = cv2.morphologyEx(collar_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            collar_ratio = _mask_ratio(collar_mask)
            face_bonus = 0.06 if face_present else 0.0
            collar_present = collar_ratio > 0.045
            if (
                face_present and
                dark_ratio > 0.38 and
                lower_dark_ratio > 0.52 and
                central_dark_ratio > 0.5 and
                lower_central_ratio > 0.56 and
                collar_present
            ):
                gown_confidence = _clamp01(
                    0.42 * dark_ratio +
                    0.72 * lower_dark_ratio +
                    0.55 * central_dark_ratio +
                    0.5 * lower_central_ratio +
                    0.48 * collar_ratio +
                    face_bonus -
                    1.05 * background_penalty
                )
                if path_has_gown:
                    gown_confidence = _clamp01(gown_confidence + 0.03)

            vivid_mask = (
                (torso_s > 108) &
                (torso_v > 88) &
                ~((torso_h > 4) & (torso_h < 28) & (torso_v > 118))
            ).astype(np.uint8) * 255
            vivid_mask = cv2.morphologyEx(vivid_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            vivid_mask = cv2.morphologyEx(vivid_mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
            best_sash = _best_component(vivid_mask, min_area_ratio=0.014, min_aspect=2.0)
            if best_sash:
                center_x = best_sash["x"] + (best_sash["w"] / 2.0)
                center_y = best_sash["y"] + (best_sash["h"] / 2.0)
                touches_center = 1.0 if vivid_mask.shape[1] * 0.26 <= center_x <= vivid_mask.shape[1] * 0.74 else 0.0
                torso_mid = 1.0 if vivid_mask.shape[0] * 0.18 <= center_y <= vivid_mask.shape[0] * 0.76 else 0.0
                band_width = best_sash["w"] / max(1.0, vivid_mask.shape[1])
                band_height = best_sash["h"] / max(1.0, vivid_mask.shape[0])
                orientation_score = 1.0 if band_width > 0.34 or band_height > 0.25 else 0.0
                diagonal_bias = abs((center_x / max(1.0, vivid_mask.shape[1])) - (center_y / max(1.0, vivid_mask.shape[0])))
                diagonal_score = 1.0 if diagonal_bias > 0.12 else 0.0
                compact_penalty = 0.26 if best_sash["area_ratio"] > 0.16 else 0.0
                edge_penalty = 0.18 if (center_x < vivid_mask.shape[1] * 0.18 or center_x > vivid_mask.shape[1] * 0.82) else 0.0
                if touches_center and torso_mid and orientation_score:
                    sash_confidence = _clamp01(
                        best_sash["score"] * 3.7 +
                        best_sash["fill_ratio"] * 0.28 +
                        touches_center * 0.16 +
                        torso_mid * 0.16 +
                        orientation_score * 0.18 +
                        diagonal_score * 0.12 -
                        compact_penalty -
                        edge_penalty
                    )
                    if path_has_sash:
                        sash_confidence = _clamp01(sash_confidence + 0.03)

        if head_hsv is not None and head_hsv.size > 0:
            head_s = head_hsv[:, :, 1]
            head_v = head_hsv[:, :, 2]
            head_dark = ((head_v < 72) & (head_s < 140)).astype(np.uint8) * 255
            head_dark = cv2.morphologyEx(head_dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            best_cap = _best_component(head_dark, min_area_ratio=0.024, min_aspect=1.25)
            if face_present and best_cap and best_cap["fill_ratio"] > 0.42:
                center_y = best_cap["y"] + (best_cap["h"] / 2.0)
                center_x = best_cap["x"] + (best_cap["w"] / 2.0)
                top_bias = 1.0 if center_y <= head_dark.shape[0] * 0.4 else 0.0
                central_bias = 1.0 if head_dark.shape[1] * 0.24 <= center_x <= head_dark.shape[1] * 0.76 else 0.0
                flat_shape = 1.0 if best_cap["w"] >= best_cap["h"] * 1.5 else 0.0
                triangular_hint = 1.0 if best_cap["fill_ratio"] < 0.72 else 0.0
                tall_penalty = 0.3 if best_cap["h"] > head_dark.shape[0] * 0.46 else 0.0
                if top_bias and central_bias and (flat_shape or triangular_hint):
                    cap_confidence = _clamp01(
                        best_cap["score"] * 3.6 +
                        best_cap["fill_ratio"] * 0.18 +
                        top_bias * 0.24 +
                        central_bias * 0.16 +
                        flat_shape * 0.16 +
                        triangular_hint * 0.08 -
                        tall_penalty
                    )
                    if path_has_cap:
                        cap_confidence = _clamp01(cap_confidence + 0.03)

        if hands_hsv is not None and hands_hsv.size > 0:
            hand_h = hands_hsv[:, :, 0]
            hand_s = hands_hsv[:, :, 1]
            hand_v = hands_hsv[:, :, 2]
            light_mask = ((hand_v > 188) & (hand_s < 64)).astype(np.uint8) * 255
            green_mask = ((hand_h > 42) & (hand_h < 84) & (hand_s > 100) & (hand_v > 84)).astype(np.uint8) * 255
            diploma_mask = cv2.bitwise_or(light_mask, green_mask)
            diploma_mask = cv2.morphologyEx(diploma_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            diploma_mask = cv2.morphologyEx(diploma_mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
            best_diploma = _best_component(diploma_mask, min_area_ratio=0.007, min_aspect=2.5)
            if best_diploma and best_diploma["fill_ratio"] > 0.24:
                center_x = best_diploma["x"] + (best_diploma["w"] / 2.0)
                center_y = best_diploma["y"] + (best_diploma["h"] / 2.0)
                torso_adjacent = 1.0 if hands_hsv.shape[0] * 0.18 <= center_y <= hands_hsv.shape[0] * 0.72 else 0.0
                central_bias = 1.0 if hands_hsv.shape[1] * 0.18 <= center_x <= hands_hsv.shape[1] * 0.82 else 0.0
                small_object = 1.0 if 0.01 <= best_diploma["area_ratio"] <= 0.072 else 0.0
                long_shape = 1.0 if best_diploma["aspect"] >= 2.8 else 0.0
                large_penalty = 0.36 if best_diploma["area_ratio"] > 0.09 else 0.0
                if torso_adjacent and central_bias and small_object and long_shape:
                    diploma_confidence = _clamp01(
                        best_diploma["score"] * 4.1 +
                        best_diploma["fill_ratio"] * 0.16 +
                        torso_adjacent * 0.18 +
                        central_bias * 0.12 +
                        small_object * 0.12 +
                        long_shape * 0.12 -
                        large_penalty
                    )
                    if path_has_diploma:
                        diploma_confidence = _clamp01(diploma_confidence + 0.03)

        visual_tags = []
        if gown_confidence >= GRADUATION_CONFIDENCE_THRESHOLD:
            visual_tags.append("beca")
        if sash_confidence >= GRADUATION_CONFIDENCE_THRESHOLD:
            visual_tags.append("faixa")
        if cap_confidence >= GRADUATION_CONFIDENCE_THRESHOLD:
            visual_tags.append("capelo")
        if diploma_confidence >= GRADUATION_CONFIDENCE_THRESHOLD:
            visual_tags.append("canudo")
        if visual_tags:
            tags.extend(visual_tags)
            source_parts.append("visual")

    tags = _normalize_saved_graduation_tags(tags)
    has_gown = bool(gown_confidence >= GRADUATION_CONFIDENCE_THRESHOLD)
    has_diploma = bool(diploma_confidence >= GRADUATION_CONFIDENCE_THRESHOLD)
    has_sash = bool(sash_confidence >= GRADUATION_CONFIDENCE_THRESHOLD)
    has_cap = bool(cap_confidence >= GRADUATION_CONFIDENCE_THRESHOLD)
    resolved_tags = list(tags)
    if has_gown:
        resolved_tags.append("beca")
    if has_diploma:
        resolved_tags.append("canudo")
    if has_sash:
        resolved_tags.append("faixa")
    if has_cap:
        resolved_tags.append("capelo")
    tags = _normalize_saved_graduation_tags(resolved_tags)
    graduation_score = 0.0
    if has_gown:
        graduation_score += 22.0 + gown_confidence * 18.0
    if has_diploma:
        graduation_score += 16.0 + diploma_confidence * 14.0
    if has_sash:
        graduation_score += 14.0 + sash_confidence * 11.0
    if has_cap:
        graduation_score += 12.0 + cap_confidence * 10.0
    if not any((has_gown, has_diploma, has_sash, has_cap)):
        graduation_score = 0.0

    return {
        "has_gown": has_gown,
        "has_diploma": has_diploma,
        "has_sash": has_sash,
        "has_cap": has_cap,
        "graduation_tags": tags,
        "graduation_score": round(float(graduation_score), 4),
        "source": "+".join(source_parts) if source_parts else "none",
        "debug": {
            "gown_confidence": round(float(gown_confidence), 4),
            "diploma_confidence": round(float(diploma_confidence), 4),
            "sash_confidence": round(float(sash_confidence), 4),
            "cap_confidence": round(float(cap_confidence), 4),
            "face_present": face_present,
        },
    }


def _build_face_priority_meta(item: dict, cohesion_hint: float, allow_fallback: bool = True) -> dict:
    fallback = analyze_graduation_items(item) if allow_fallback else {}
    raw_has_gown = item.get("has_gown")
    raw_has_diploma = item.get("has_diploma")
    raw_has_sash = item.get("has_sash")
    raw_has_cap = item.get("has_cap")
    raw_score = item.get("graduation_score")
    saved_tags = _normalize_saved_graduation_tags(item.get("graduation_tags"))
    fallback_tags = _normalize_saved_graduation_tags(fallback.get("graduation_tags"))
    resolved_tags = saved_tags or fallback_tags

    has_saved_fields = any(
        value is not None
        for value in (raw_has_gown, raw_has_diploma, raw_has_sash, raw_has_cap, raw_score, item.get("graduation_tags"))
    )

    has_gown = _coerce_flag(raw_has_gown) if raw_has_gown is not None else (_coerce_flag(fallback.get("has_gown")) or ("beca" in resolved_tags))
    has_diploma = _coerce_flag(raw_has_diploma) if raw_has_diploma is not None else (_coerce_flag(fallback.get("has_diploma")) or ("canudo" in resolved_tags))
    has_sash = _coerce_flag(raw_has_sash) if raw_has_sash is not None else (_coerce_flag(fallback.get("has_sash")) or ("faixa" in resolved_tags))
    has_cap = _coerce_flag(raw_has_cap) if raw_has_cap is not None else (_coerce_flag(fallback.get("has_cap")) or ("capelo" in resolved_tags))

    fallback_debug = fallback.get("debug") or {}
    gown_confidence = float(item["gown_confidence"]) if item.get("gown_confidence") is not None else float(fallback_debug.get("gown_confidence") or 0.0)
    diploma_confidence = float(item["diploma_confidence"]) if item.get("diploma_confidence") is not None else float(fallback_debug.get("diploma_confidence") or 0.0)
    sash_confidence = float(item["sash_confidence"]) if item.get("sash_confidence") is not None else float(fallback_debug.get("sash_confidence") or 0.0)
    cap_confidence = float(item["cap_confidence"]) if item.get("cap_confidence") is not None else float(fallback_debug.get("cap_confidence") or 0.0)

    try:
        raw_manual = item.get("manual_graduation_tags") or "[]"
        manual_list = json.loads(raw_manual) if isinstance(raw_manual, str) else list(raw_manual or [])
        if not isinstance(manual_list, list):
            manual_list = []
    except Exception:
        manual_list = []

    if "beca" in manual_list:
        has_gown = True
        gown_confidence = 1.0
    elif "!beca" in manual_list:
        has_gown = False
        gown_confidence = 0.0
    if "canudo" in manual_list:
        has_diploma = True
        diploma_confidence = 1.0
    elif "!canudo" in manual_list:
        has_diploma = False
        diploma_confidence = 0.0
    if "faixa" in manual_list:
        has_sash = True
        sash_confidence = 1.0
    elif "!faixa" in manual_list:
        has_sash = False
        sash_confidence = 0.0
    if "capelo" in manual_list:
        has_cap = True
        cap_confidence = 1.0
    elif "!capelo" in manual_list:
        has_cap = False
        cap_confidence = 0.0

    face_front_score = _derive_face_front_score(item)
    sharpness_score = _derive_sharpness_score(item)

    computed_graduation_score = (
        (40.0 if has_gown else 0.0) +
        (30.0 if has_diploma else 0.0) +
        (25.0 if has_sash else 0.0) +
        (20.0 if has_cap else 0.0) +
        face_front_score * 15.0 +
        sharpness_score * 10.0
    )
    graduation_score = float(raw_score) if raw_score is not None else computed_graduation_score
    debug_graduation_source = "saved_fields" if has_saved_fields else str(fallback.get("source") or "none")

    tags = list(resolved_tags)
    if has_gown:
        tags.append("beca")
    if has_diploma:
        tags.append("canudo")
    if has_sash:
        tags.append("faixa")
    if has_cap:
        tags.append("capelo")
    tags = _normalize_saved_graduation_tags(tags)

    x1, y1, x2, y2 = [int(v) for v in item.get("box", [0, 0, 1, 1])]
    face_area = max(1, (x2 - x1) * (y2 - y1))

    return {
        "has_gown": has_gown,
        "has_diploma": has_diploma,
        "has_sash": has_sash,
        "has_cap": has_cap,
        "gown_confidence": round(_clamp01(gown_confidence), 4),
        "diploma_confidence": round(_clamp01(diploma_confidence), 4),
        "sash_confidence": round(_clamp01(sash_confidence), 4),
        "cap_confidence": round(_clamp01(cap_confidence), 4),
        "manual_graduation_tags": list(manual_list),
        "face_front_score": round(face_front_score, 4),
        "sharpness_score": round(sharpness_score, 4),
        "graduation_score": round(graduation_score, 4),
        "tags": tags,
        "face_area": face_area,
        "cohesion_hint": float(cohesion_hint or 0.0),
        "has_graduation_signal": bool(tags) or raw_score is not None,
        "debug_graduation_source": debug_graduation_source,
    }


def _pick_cluster_cover_item(comp_items: list[dict], priority_meta: list[dict]) -> dict:
    best_idx = 0
    best_rank = None
    for idx, (item, meta) in enumerate(zip(comp_items, priority_meta)):
        rank = (
            1 if meta["has_gown"] and (meta["has_diploma"] or meta["has_sash"]) else 0,
            1 if meta["has_gown"] else 0,
            1 if meta["has_diploma"] else 0,
            1 if meta["has_sash"] else 0,
            1 if meta["has_cap"] else 0,
            meta["face_front_score"] * meta["sharpness_score"],
            meta["face_area"],
            meta["cohesion_hint"],
            meta["graduation_score"],
        )
        if best_rank is None or rank > best_rank:
            best_rank = rank
            best_idx = idx
    return comp_items[best_idx]


def _ordered_cluster_tags(priority_meta: list[dict]) -> list[str]:
    present = {tag for meta in priority_meta for tag in meta["tags"]}
    return [tag for tag in GRADUATION_TAG_ORDER if tag in present]


def _resolve_cluster_graduation_source(priority_meta: list[dict]) -> str:
    for source in (meta.get("debug_graduation_source") for meta in priority_meta):
        if source and source != "none":
            return str(source)
    return "none"


def assign_cluster(req: AssignUnknownClusterRequest):
    """Atribui nome a um cluster desconhecido resolvendo aluno existente ou novo nome digitado."""
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    catalog = _sanitize_catalog_name(req.catalog or _current_catalog())
    if not catalog:
        raise HTTPException(status_code=400, detail="Nenhum catalogo selecionado")

    backup_catalog_db(catalog, "antes_atribuir_cluster_desconhecido")

    with get_db(catalog) as conn:
        cur = conn.cursor()
        resolved_aluno_id, normalized_name = _resolve_assign_aluno(cur, req.aluno_id, req.nome_formando)

        cur.execute(
            """
            SELECT face_id, original_path
            FROM unknown_face_clusters
            WHERE cluster_id = ?
            ORDER BY id ASC
            """,
            (req.cluster_id,),
        )
        cluster_rows = cur.fetchall()
        if not cluster_rows:
            raise HTTPException(status_code=404, detail="Cluster desconhecido não encontrado.")

        face_ids = [int(row["face_id"]) for row in cluster_rows if row["face_id"] is not None]
        updated = 0
        if face_ids:
            for idx in range(0, len(face_ids), 900):
                chunk = face_ids[idx:idx + 900]
                placeholders = ",".join(["?"] * len(chunk))
                cur.execute(
                    f"UPDATE OR REPLACE ocorrencias SET aluno_id = ? WHERE rowid IN ({placeholders})",
                    [resolved_aluno_id] + chunk,
                )
                updated += cur.rowcount
        else:
            paths = [row["original_path"] for row in cluster_rows if row["original_path"]]
            if not paths:
                raise HTTPException(status_code=404, detail="Cluster sem faces vinculadas.")
            for idx in range(0, len(paths), 900):
                chunk = paths[idx:idx + 900]
                placeholders = ",".join(["?"] * len(chunk))
                cur.execute(
                    f"""
                    UPDATE ocorrencias
                    SET aluno_id = ?
                    WHERE foto_path IN ({placeholders})
                      AND (
                          lower(aluno_id) IN ({",".join(["?"] * len(UNKNOWN_ALUNO_IDS))})
                          OR aluno_id LIKE 'Pessoa%'
                      )
                    """,
                    [resolved_aluno_id] + chunk + list(UNKNOWN_ALUNO_IDS),
                )
                updated += cur.rowcount

        _ensure_action_logs_table(cur)
        cur.execute(
            "INSERT INTO action_logs (action, details) VALUES (?, ?)",
            (
                "unknown_cluster_assigned",
                json.dumps(
                    {
                        "cluster_id": req.cluster_id,
                        "aluno_id": resolved_aluno_id,
                        "nome_formando": normalized_name or resolved_aluno_id,
                        "updated": updated,
                    },
                    ensure_ascii=False,
                ),
            ),
        )
        cur.execute("DELETE FROM unknown_face_clusters WHERE cluster_id = ?", (req.cluster_id,))
        conn.commit()

        if resolved_aluno_id and resolved_aluno_id != "Desconhecido":
            _ensure_person_reference(conn, catalog, resolved_aluno_id)

        class_name = "Sem turma"
        if resolved_aluno_id:
            try:
                cur.execute("SELECT class_name FROM alunos WHERE aluno_id = ? LIMIT 1", (resolved_aluno_id,))
                row = cur.fetchone()
                if row and row["class_name"]:
                    class_name = str(row["class_name"]).strip() or "Sem turma"
            except Exception:
                class_name = "Sem turma"

    try:
        import people_data_manager as pdm
        pdm.invalidate_people_cache()
    except Exception:
        pass

    return {
        "ok": True,
        "success": True,
        "cluster_id": req.cluster_id,
        "aluno_id": resolved_aluno_id,
        "student_name": normalized_name or resolved_aluno_id,
        "nome_formando": normalized_name or resolved_aluno_id,
        "class_name": class_name,
        "status": "identified",
        "updated_count": updated,
        "updated": updated,
    }


def ignore_cluster(req: IgnoreUnknownClusterRequest):
    get_db = _get("get_db")
    catalog = _sanitize_catalog_name(req.catalog or _current_catalog())
    cluster_id = str(req.cluster_id or "").strip()
    if not catalog:
        raise HTTPException(status_code=400, detail="Nenhum catalogo selecionado")
    if not cluster_id:
        raise HTTPException(status_code=400, detail="cluster_id e obrigatorio.")

    with get_db(catalog) as conn:
        cur = conn.cursor()
        _ensure_ignored_review_clusters_table(cur)
        rowids = [int(v) for v in (req.rowids or []) if str(v).strip()]
        cur.execute(
            "INSERT OR IGNORE INTO ignored_review_clusters (catalog, cluster_id) VALUES (?, ?)",
            (catalog, cluster_id),
        )
        _ensure_action_logs_table(cur)
        cur.execute(
            "INSERT INTO action_logs (action, details) VALUES (?, ?)",
            (
                "unknown_cluster_ignored",
                json.dumps(
                    {
                        "catalog": catalog,
                        "cluster_id": cluster_id,
                        "rowids": rowids,
                        "ignored": len(rowids),
                    },
                    ensure_ascii=False,
                ),
            ),
        )
        conn.commit()

    return {
        "ok": True,
        "success": True,
        "cluster_id": cluster_id,
        "ignored": len(req.rowids or []),
        "status": "ignored",
    }


def merge_unknown_clusters(catalog: str, source_cluster_id: str, target_cluster_id: str) -> dict:
    cat = catalog or _current_catalog()
    if not cat:
        raise HTTPException(status_code=400, detail="Nenhum catalogo selecionado")
    if not source_cluster_id or not target_cluster_id:
        raise HTTPException(status_code=400, detail="Source e target obrigatorios.")
    with _get("get_db")(cat) as conn:
        cur = conn.cursor()
        cur.execute("UPDATE unknown_face_clusters SET cluster_id = ? WHERE cluster_id = ?", (target_cluster_id, source_cluster_id))
        conn.commit()
    _invalidate_review_cache(cat)
    print(f"[CLUSTER MERGE] {source_cluster_id} -> {target_cluster_id}")
    return {"ok": True, "source": source_cluster_id, "target": target_cluster_id}


def get_unknown_clusters(catalog: str = "", min_score: float = 0.58, min_cluster_size: int = 2, limit: int = 80):
    get_db = _get("get_db")
    cat = catalog or _current_catalog()
    if not cat:
        return {"clusters": []}

    threshold = max(0.3, min(float(min_score or 0.58), 0.95))
    min_cluster_size = max(2, int(min_cluster_size or 2))
    limit = max(1, min(int(limit or 80), 200))

    with get_db(cat) as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2,
                   blur_status, blur_score, closed_eyes,
                   has_gown, has_diploma, has_sash, has_cap,
                   face_front_score, graduation_score, graduation_tags,
                   gown_confidence, diploma_confidence, sash_confidence, cap_confidence,
                   manual_graduation_tags,
                   is_foreground, foreground_score, background_penalty_reason
            FROM ocorrencias
            WHERE x1 IS NOT NULL
              AND (
                  lower(aluno_id) IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'não_mapeado', '__unknown__')
                  OR aluno_id LIKE 'Pessoa%'
              )
            ORDER BY foto_path ASC, rowid ASC
        """)
        rows = cur.fetchall()
        if not rows:
            _sync_unknown_face_clusters(cur, [])
            conn.commit()
            return {"clusters": []}

        items = []
        for occ in rows:
            emb = get_cached_occurrence_embedding(conn, occ)
            if emb is None:
                continue
            items.append({
                "rowid": int(occ["rowid"]),
                "aluno_id": occ["aluno_id"],
                "foto_path": occ["foto_path"],
                "box": [occ["x1"], occ["y1"], occ["x2"], occ["y2"]],
                "embedding": emb.astype("float32"),
                "blur_status": occ["blur_status"],
                "blur_score": occ["blur_score"],
                "closed_eyes": bool(occ["closed_eyes"]) if occ["closed_eyes"] is not None else False,
                "has_gown": occ["has_gown"],
                "has_diploma": occ["has_diploma"],
                "has_sash": occ["has_sash"],
                "has_cap": occ["has_cap"],
                "face_front_score": occ["face_front_score"],
                "graduation_score": occ["graduation_score"],
                "is_foreground": occ["is_foreground"],
                "foreground_score": occ["foreground_score"],
                "background_penalty_reason": occ["background_penalty_reason"],
                "graduation_tags": occ["graduation_tags"],
                "gown_confidence": occ["gown_confidence"],
                "diploma_confidence": occ["diploma_confidence"],
                "sash_confidence": occ["sash_confidence"],
                "cap_confidence": occ["cap_confidence"],
                "manual_graduation_tags": occ["manual_graduation_tags"],
            })

        if len(items) < min_cluster_size:
            _sync_unknown_face_clusters(cur, [])
            conn.commit()
            return {"clusters": []}

        embeddings = np.vstack([item["embedding"] for item in items]).astype("float32")
        norms = np.linalg.norm(embeddings, axis=1)
        valid = norms > 0
        if not np.all(valid):
            embeddings = embeddings[valid]
            items = [item for item, keep in zip(items, valid) if keep]

        if len(items) < min_cluster_size:
            _sync_unknown_face_clusters(cur, [])
            conn.commit()
            return {"clusters": []}

        embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
        n = len(items)
        parent = list(range(n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        block_size = 256
        for start in range(0, n, block_size):
            block = embeddings[start:start + block_size]
            sims = block @ embeddings.T
            for local_i in range(sims.shape[0]):
                i = start + local_i
                row = sims[local_i]
                for j in range(i + 1, n):
                    if row[j] >= threshold:
                        union(i, j)

        clusters_by_root = {}
        for idx in range(n):
            root = find(idx)
            clusters_by_root.setdefault(root, []).append(idx)

        initial_cluster_count = len(clusters_by_root)
        unit_clusters = sum(1 for v in clusters_by_root.values() if len(v) < 2)
        print(f"[CLUSTER] clusters iniciais: {initial_cluster_count}, unitarios: {unit_clusters}")

        # ── Iterative hybrid reclustering ──
        def _compute_robust_centroid(cluster_idxs: list[int]) -> np.ndarray:
            if not cluster_idxs:
                return np.zeros(embeddings.shape[1], dtype="float32")
            scored = []
            for idx in cluster_idxs:
                it = items[idx]
                front = float(it.get("face_front_score") or 0.0)
                blur_stat = it.get("blur_status")
                is_bad = (blur_stat == "blur") or (front < 0.2)
                scored.append((idx, front, is_bad))
            scored.sort(key=lambda x: x[1], reverse=True)
            good = [x for x in scored if not x[2]]
            if not good:
                good = scored
            top_n = max(3, int(len(good) * 0.5))
            top_items = good[:top_n]
            valid_embs = []
            weights = []
            for idx, front, is_bad in top_items:
                w = max(0.1, front)
                valid_embs.append(embeddings[idx])
                weights.append(w)
            valid_embs = np.array(valid_embs)
            weights = np.array(weights).reshape(-1, 1)
            weighted_sum = np.sum(valid_embs * weights, axis=0)
            cn = np.linalg.norm(weighted_sum)
            if cn > 0:
                return (weighted_sum / cn).astype("float32")
            return valid_embs.mean(axis=0).astype("float32")

        def _cluster_gown_tags(cluster_idxs: list[int]) -> set[str]:
            tags: set[str] = set()
            for idx in cluster_idxs:
                item = items[idx]
                if item.get("has_gown"): tags.add("gown")
                if item.get("has_diploma"): tags.add("diploma")
                if item.get("has_sash"): tags.add("sash")
                if item.get("has_cap"): tags.add("cap")
            return tags

        def _cluster_ocr_text(cluster_idxs: list[int]) -> str:
            for idx in cluster_idxs:
                item = items[idx]
                t = str(item.get("ai_ocr_text") or "")
                if t.strip():
                    return t.strip()
            return ""

        def _hybrid_similarity(
            c1_idxs: list[int], c2_idxs: list[int],
            c1_cent: np.ndarray, c2_cent: np.ndarray,
        ) -> tuple[float, dict]:
            # Face similarity
            face_sim = float(np.dot(c1_cent, c2_cent))
            # Gown/tag similarity
            tags1 = _cluster_gown_tags(c1_idxs)
            tags2 = _cluster_gown_tags(c2_idxs)
            if tags1 and tags2:
                overlap = len(tags1 & tags2)
                max_tags = max(len(tags1), len(tags2))
                beca_sim = overlap / max(max_tags, 1)
            else:
                beca_sim = 0.0
            
            faixa_sim = 1.0 if ("sash" in tags1 and "sash" in tags2) else 0.0

            # OCR similarity
            ocr1 = _cluster_ocr_text(c1_idxs)
            ocr2 = _cluster_ocr_text(c2_idxs)
            ocr_sim = 1.0 if ocr1 and ocr2 and ocr1 == ocr2 else 0.0
            # Temporal/context similarity (based on path proximity)
            paths1 = sorted({items[i].get("foto_path", "") for i in c1_idxs})
            paths2 = sorted({items[i].get("foto_path", "") for i in c2_idxs})
            temporal_sim = 0.0
            for p1 in paths1:
                for p2 in paths2:
                    if p1 and p2 and _os.path.dirname(p1) == _os.path.dirname(p2):
                        temporal_sim = 1.0
                        break
                if temporal_sim > 0:
                    break
            
            front1 = max((float(items[i].get("face_front_score") or 0.0)) for i in c1_idxs)
            front2 = max((float(items[i].get("face_front_score") or 0.0)) for i in c2_idxs)
            front_sim = (front1 + front2) / 2.0

            # Hybrid score
            scores = {
                "face": round(face_sim, 2),
                "beca": round(beca_sim, 2),
                "faixa": round(faixa_sim, 2),
                "ocr": round(ocr_sim, 2),
                "tempo": round(temporal_sim, 2),
                "front": round(front_sim, 2),
            }
            final = (0.50 * face_sim) + (0.15 * beca_sim) + (0.10 * faixa_sim) + (0.05 * ocr_sim) + (0.15 * temporal_sim) + (0.05 * front_sim)
            if temporal_sim > 0 and face_sim > 0.45:
                final += 0.05
            return final, scores

        def _merge_threshold(sz_a: int, sz_b: int) -> float:
            if sz_a <= 1 and sz_b <= 1:
                return 0.45
            if sz_a <= 1 or sz_b <= 1:
                return 0.48
            return 0.55

        import os as _os
        changed = True
        iteration = 0
        while changed:
            iteration += 1
            changed = False
            root_list = list(clusters_by_root.keys())
            if len(root_list) < 2:
                break
            centroids = {}
            for r in root_list:
                idxs = clusters_by_root[r]
                centroids[r] = _compute_robust_centroid(idxs)
            # Compare all pairs, log every comparison
            candidates = []
            for r in root_list:
                if r not in clusters_by_root:
                    continue
                sz_a = len(clusters_by_root[r])
                cent_a = centroids.get(r)
                if cent_a is None:
                    continue
                for other_r in root_list:
                    if other_r <= r or other_r not in clusters_by_root:
                        continue
                    sz_b = len(clusters_by_root[other_r])
                    cent_b = centroids.get(other_r)
                    if cent_b is None:
                        continue
                    score, sub_scores = _hybrid_similarity(
                        clusters_by_root[r], clusters_by_root[other_r], cent_a, cent_b
                    )
                    thresh = _merge_threshold(sz_a, sz_b)
                    log_line = f"[MERGE COMPARE] iter={iteration} {r}({sz_a}) x {other_r}({sz_b}) final={score:.2f} thresh={thresh:.2f} {' | '.join(f'{k}={v}' for k,v in sub_scores.items())}"
                    if score >= thresh:
                        candidates.append((score, r, other_r))
                        print(log_line + " ** CANDIDATE **")
                    else:
                        if score >= 0.30:
                            print(log_line)
            # Apply best merge
            if candidates:
                candidates.sort(key=lambda x: x[0], reverse=True)
                best_score, r, other_r = candidates[0]
                sz_a = len(clusters_by_root[r])
                sz_b = len(clusters_by_root[other_r])
                print(f"[MERGE APPLY] iter={iteration} {r}({sz_a}) <- {other_r}({sz_b}) final={best_score:.2f}")
                clusters_by_root[other_r].extend(clusters_by_root[r])
                del clusters_by_root[r]
                changed = True

        print(f"[CLUSTER] clusters finais: {len(clusters_by_root)} (apos {iteration} iteracoes)")

        # Load identified students for suggestion matching
        identified_centroids: list[tuple[str, np.ndarray]] = []
        try:
            cur.execute("""
                SELECT DISTINCT o.aluno_id, fe.embedding
                FROM ocorrencias o
                JOIN face_embeddings fe ON fe.occurrence_rowid = o.rowid
                WHERE o.x1 IS NOT NULL
                  AND o.aluno_id IS NOT NULL
                  AND o.aluno_id != ''
                  AND lower(o.aluno_id) NOT IN ('unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', 'nao_mapeado', '__unknown__')
                  AND o.aluno_id NOT LIKE 'pessoa%'
                  AND fe.embedding IS NOT NULL
                ORDER BY o.aluno_id
            """)
            id_rows = cur.fetchall()
            id_emb_map: dict[str, list[np.ndarray]] = {}
            for r in id_rows:
                name = str(r["aluno_id"])
                emb = np.frombuffer(r["embedding"], dtype="float32")
                emb = emb / np.linalg.norm(emb) if np.linalg.norm(emb) > 0 else emb
                id_emb_map.setdefault(name, []).append(emb)
            for name, embs in id_emb_map.items():
                centroid = np.mean(embs, axis=0)
                cn = np.linalg.norm(centroid)
                if cn > 0:
                    identified_centroids.append((name, centroid / cn))
            print(f"[STUDENT DB] identified_students_count={len(identified_centroids)}")
            for name, _ in identified_centroids:
                emb_count = len(id_emb_map.get(name, []))
                print(f"[STUDENT DB] student={name} embeddings={emb_count}")
            if not identified_centroids:
                print(f"[STUDENT DB] nenhum formando identificado com embedding encontrado (query returned {len(id_rows)} rows)")
        except Exception as e:
            print(f"[CLUSTER] erro ao carregar formandos: {e}")

        def _best_student_match(centroid: np.ndarray) -> tuple[str | None, float]:
            if not identified_centroids or centroid is None:
                return None, 0.0
            best_name, best_sim = None, 0.0
            all_matches: list[tuple[str, float]] = []
            for name, ref_cent in identified_centroids:
                sim = float(np.dot(centroid, ref_cent))
                all_matches.append((name, sim))
                if sim > best_sim:
                    best_sim = sim
                    best_name = name
            all_matches.sort(key=lambda x: x[1], reverse=True)
            top3 = all_matches[:3]
            if any(s >= 0.40 for _, s in top3):
                print(f"[CLUSTER] TOP MATCHES: {' | '.join(f'{n}={s:.2f}' for n, s in top3)}")
            return best_name, best_sim

        import datetime as _dt

        # First pass: build all clusters with their centroids
        clusters = []
        now_iso = _dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        cluster_centroids: list[tuple[str, np.ndarray, list[int]]] = []
        cluster_num = 0  # safe default

        for comp_idxs in clusters_by_root.values():
            if len(comp_idxs) < min_cluster_size:
                continue
            comp_items = [items[i] for i in comp_idxs]
            comp_emb = embeddings[comp_idxs]
            centroid = _compute_robust_centroid(comp_idxs)
            rep_scores = comp_emb @ centroid
            unique_paths = sorted({item["foto_path"] for item in comp_items})
            cohesion_score = float(np.clip(np.mean(rep_scores), 0.0, 1.0)) if len(rep_scores) else 0.0
            priority_meta = [
                _build_face_priority_meta(item, float(rep_scores[local_idx]) if local_idx < len(rep_scores) else 0.0)
                for local_idx, item in enumerate(comp_items)
            ]
            photo_count = len(unique_paths)
            max_graduation_score = max((meta["graduation_score"] for meta in priority_meta), default=0.0)
            cluster_has_gown = any(meta["has_gown"] for meta in priority_meta)
            cluster_has_diploma = any(meta["has_diploma"] for meta in priority_meta)
            cluster_has_sash = any(meta["has_sash"] for meta in priority_meta)
            cluster_has_cap = any(meta["has_cap"] for meta in priority_meta)
            cluster_gown_confidence = max((meta["gown_confidence"] for meta in priority_meta), default=0.0)
            cluster_diploma_confidence = max((meta["diploma_confidence"] for meta in priority_meta), default=0.0)
            cluster_sash_confidence = max((meta["sash_confidence"] for meta in priority_meta), default=0.0)
            cluster_cap_confidence = max((meta["cap_confidence"] for meta in priority_meta), default=0.0)
            cluster_manual_tags = sorted({
                tag for meta in priority_meta for tag in (meta.get("manual_graduation_tags") or [])
            })
            
            fg_count = sum(1 for item in comp_items if item.get("is_foreground") == 1)
            fg_ratio = fg_count / max(1, len(comp_items))
            fg_boost = fg_ratio * 2.0
            
            priority_score = max_graduation_score + cohesion_score + photo_count + fg_boost
            rep_item = _pick_cluster_cover_item(comp_items, priority_meta)
            rep_item_meta = priority_meta[comp_items.index(rep_item)]
            graduation_tags = _ordered_cluster_tags(priority_meta)
            debug_graduation_source = _resolve_cluster_graduation_source(priority_meta)
            suggested_student, suggested_similarity = _best_student_match(centroid)
            # Always save best match (even below threshold) for debug display
            best_debug_name, best_debug_sim = None, 0.0
            if identified_centroids and centroid is not None:
                for name, ref_cent in identified_centroids:
                    sim = float(np.dot(centroid, ref_cent))
                    if sim > best_debug_sim:
                        best_debug_sim = sim
                        best_debug_name = name
            if suggested_student:
                print(f"[STUDENT MATCH] cluster_{len(clusters)+1} best={suggested_student} sim={suggested_similarity:.2f}")
            elif best_debug_name:
                print(f"[STUDENT MATCH] cluster_{len(clusters)+1} no_match best={best_debug_name} sim={best_debug_sim:.2f}")

            cluster_num = len(clusters) + 1
            print(f"[AFTER STUDENT APPLY] cluster_{cluster_num} best_debug={best_debug_name} sim={best_debug_sim}")
            cluster_centroids.append((f"cluster_{cluster_num}", centroid.copy(), comp_idxs))
            clusters.append({
                "cluster_id": f"cluster_{cluster_num}",
                "cluster_number": cluster_num,
                "face_count": len(comp_items),
                "photo_count": photo_count,
                "total_photos": photo_count,
                "cohesion_score": round(cohesion_score, 4),
                "cohesion": round(cohesion_score, 4),
                "priority_score": round(float(priority_score), 4),
                "suggested_student": suggested_student,
                "suggested_similarity": round(suggested_similarity, 4) if suggested_student else None,
                "best_student_debug": best_debug_name,
                "best_similarity_debug": round(best_debug_sim, 4) if best_debug_name else None,
                "graduation_tags": graduation_tags,
                "has_gown": cluster_has_gown,
                "has_diploma": cluster_has_diploma,
                "has_sash": cluster_has_sash,
                "has_cap": cluster_has_cap,
                "gown_confidence": round(float(cluster_gown_confidence), 4),
                "diploma_confidence": round(float(cluster_diploma_confidence), 4),
                "sash_confidence": round(float(cluster_sash_confidence), 4),
                "cap_confidence": round(float(cluster_cap_confidence), 4),
                "manual_graduation_tags": cluster_manual_tags,
                "debug_graduation_source": debug_graduation_source,
                "preview_image": rep_item["foto_path"],
                "discovered_at": now_iso,
                "representative": {
                    "rowid": rep_item["rowid"],
                    "path": rep_item["foto_path"],
                    "box": rep_item["box"],
                    "aluno_id": rep_item["aluno_id"],
                    "blur_status": rep_item.get("blur_status"),
                    "blur_score": rep_item.get("blur_score"),
                    "closed_eyes": rep_item.get("closed_eyes", False),
                    "has_gown": rep_item_meta["has_gown"],
                    "has_diploma": rep_item_meta["has_diploma"],
                    "has_sash": rep_item_meta["has_sash"],
                    "has_cap": rep_item_meta["has_cap"],
                    "face_front_score": rep_item_meta["face_front_score"],
                    "graduation_score": rep_item_meta["graduation_score"],
                    "is_representative": True,
                    "is_foreground": rep_item.get("is_foreground"),
                    "foreground_score": rep_item.get("foreground_score"),
                    "background_penalty_reason": rep_item.get("background_penalty_reason"),
                },
                "faces": [
                    {
                        "rowid": item["rowid"],
                        "path": item["foto_path"],
                        "box": item["box"],
                        "aluno_id": item["aluno_id"],
                        "blur_status": item.get("blur_status"),
                        "blur_score": item.get("blur_score"),
                        "closed_eyes": item.get("closed_eyes", False),
                        "has_gown": meta["has_gown"],
                        "has_diploma": meta["has_diploma"],
                        "has_sash": meta["has_sash"],
                        "has_cap": meta["has_cap"],
                        "face_front_score": meta["face_front_score"],
                        "graduation_score": meta["graduation_score"],
                        "is_representative": item["rowid"] == rep_item["rowid"],
                        "is_foreground": item.get("is_foreground"),
                        "foreground_score": item.get("foreground_score"),
                        "background_penalty_reason": item.get("background_penalty_reason"),
                    }
                    for item, meta in zip(comp_items, priority_meta)
                ],
            })

        # Helper: extract graduation tags from a cluster payload
        def _cluster_tags_from_payload(cl) -> set[str]:
            tags: set[str] = set()
            if cl.get("has_gown"): tags.add("gown")
            if cl.get("has_diploma"): tags.add("diploma")
            if cl.get("has_sash"): tags.add("sash")
            if cl.get("has_cap"): tags.add("cap")
            return tags

        # Debug: log all clusters
        for cl in clusters:
            cid = cl["cluster_id"]
            rowids = [f.get("rowid") for f in cl.get("faces", [])]
            tags_set = _cluster_tags_from_payload(cl)
            tags_str = ",".join(tags_set) if tags_set else "none"
            emb_status = "OK" if any(ccid == cid for ccid, _, _ in cluster_centroids) else "AUSENTE"
            print(f"[CLUSTER DEBUG] {cid} rowids={rowids} fotos={cl.get('photo_count',0)} embedding={emb_status} aluno_id=unknown tags=[{tags_str}]")

        def _hybrid_sim_between_clusters(cl_a, cl_b, cent_a, cent_b) -> tuple[float, dict]:
            face_sim = float(np.dot(cent_a, cent_b))
            tags_a = _cluster_tags_from_payload(cl_a)
            tags_b = _cluster_tags_from_payload(cl_b)
            beca_sim = 0.0
            if tags_a and tags_b:
                overlap = len(tags_a & tags_b)
                beca_sim = overlap / max(len(tags_a), len(tags_b), 1)
            p1 = str(cl_a.get("preview_image") or "")
            p2 = str(cl_b.get("preview_image") or "")
            temporal_sim = 0.0
            if p1 and p2 and _os.path.dirname(p1) == _os.path.dirname(p2):
                temporal_sim = 0.3
            scores = {"face": round(face_sim, 2), "beca": round(beca_sim, 2), "tempo": round(temporal_sim, 2)}
            final = (0.65 * face_sim) + (0.15 * beca_sim) + (0.20 * temporal_sim)
            return final, scores

        print(f"[CLUSTER DEBUG] total clusters = {len(clusters)}")
        for cl in clusters:
            cid = cl["cluster_id"]
            if cl.get("suggested_student"):
                print(f"[SKIP COMPARE] {cid} motivo=suggested_student ja existe ({cl['suggested_student']})")
                continue
            if cid not in [ccid for ccid, _, _ in cluster_centroids]:
                print(f"[SKIP COMPARE] {cid} motivo=sem embedding no cluster_centroids")
                continue
            match = None
            best_score = 0.0
            best_scores = {}
            for other_cid, other_cent, _ in cluster_centroids:
                if other_cid == cid:
                    continue
                cent_self = None
                for ccid, cc, _ in cluster_centroids:
                    if ccid == cid:
                        cent_self = cc
                        break
                if cent_self is None:
                    print(f"[SKIP COMPARE] {cid} x {other_cid} motivo=cent_self None")
                    continue
                other_cl = next((c for c in clusters if c["cluster_id"] == other_cid), None)
                if other_cl is None:
                    print(f"[SKIP COMPARE] {cid} x {other_cid} motivo=other_cl nao encontrado")
                    continue
                hscore, sub_scores = _hybrid_sim_between_clusters(cl, other_cl, cent_self, other_cent)
                print(f"[COMPARE] {cid} x {other_cid} face_sim={sub_scores['face']} final={hscore:.2f} {'merge_candidate=true' if hscore >= 0.50 else ''}")
                if hscore > best_score and hscore >= 0.50:
                    best_score = hscore
                    best_scores = sub_scores
                    match = other_cid
            if match:
                match_num = match.replace("cluster_", "")
                print(f"[UNKNOWN MATCH] {cid} parecido com {match} final={best_score:.2f} {' | '.join(f'{k}={v}' for k,v in best_scores.items())}")
                cl["unknown_similar_id"] = match
                cl["unknown_similar_number"] = int(match_num)
                cl["unknown_similar_similarity"] = round(best_score, 4)

        clusters.sort(
            key=lambda c: (c["priority_score"], c["cohesion_score"], c["total_photos"]),
            reverse=True,
        )
        # Renumber after sort
        for i, cl in enumerate(clusters):
            cl["cluster_number"] = i + 1
        for c in clusters[:3]:
            print(f'[BEFORE SYNC] {c["cluster_id"]} best_student_debug={c.get("best_student_debug")} best_similarity_debug={c.get("best_similarity_debug")}')
        _sync_unknown_face_clusters(cur, clusters)
        conn.commit()
        _invalidate_review_cache(cat)
        return {"clusters": clusters[:limit], "threshold": threshold, "min_cluster_size": min_cluster_size, "initial_cluster_count": initial_cluster_count}


def debug_cluster_similarities(catalog: str = ""):
    """Debug endpoint: returns cluster info and pairwise similarities."""
    cat = catalog or _current_catalog()
    if not cat:
        return {"error": "nenhum catalogo"}
    # Force recompute clusters with suggestions
    result = get_unknown_clusters(catalog=cat, min_cluster_size=1, limit=200)
    clusters_data = result.get("clusters", [])
    # Build detailed debug output
    debug_clusters = []
    total_before = result.get("initial_cluster_count", len(clusters_data))
    for cl in clusters_data:
        debug_clusters.append({
            "cluster_id": cl["cluster_id"],
            "cluster_number": cl["cluster_number"],
            "photos": cl.get("photo_count", 0),
            "faces": cl.get("face_count", 0),
            "has_embedding": True,
            "tags": [k for k in ["gown", "diploma", "sash", "cap"] if cl.get(f"has_{k}")],
            "suggested_student": cl.get("suggested_student"),
            "suggested_similarity": cl.get("suggested_similarity"),
            "unknown_similar_id": cl.get("unknown_similar_id"),
            "unknown_similar_similarity": cl.get("unknown_similar_similarity"),
            "preview": cl.get("preview_image", "")[:80],
        })
    return {
        "total_before_merge": total_before,
        "total_after_merge": len(debug_clusters),
        "total_clusters": len(debug_clusters),
        "clusters": debug_clusters,
    }


def debug_face_state(rowid: int = 0, foto_path: str = ""):
    """Debug endpoint: returns full state of a single face."""
    cat = _current_catalog()
    if not cat:
        return {"error": "nenhum catalogo"}
    try:
        get_db = _get("get_db")
        with get_db(cat) as conn:
            cur = conn.cursor()
            if rowid:
                cur.execute("SELECT rowid, * FROM ocorrencias WHERE rowid = ?", (rowid,))
            elif foto_path:
                cur.execute("SELECT rowid, * FROM ocorrencias WHERE foto_path = ? LIMIT 1", (foto_path,))
            else:
                return {"error": "forneca rowid ou foto_path"}
            face = cur.fetchone()
            if not face:
                return {"error": "face nao encontrada"}
            face_dict = dict(face)
            rowid_val = face_dict.get("rowid") or face_dict.get("rowid")
            cur.execute("SELECT * FROM unknown_face_clusters WHERE face_id = ?", (rowid_val,))
            cluster_row = cur.fetchone()
            cur.execute("SELECT * FROM face_embeddings WHERE occurrence_rowid = ?", (rowid_val,))
            emb_row = cur.fetchone()
            return {
                "face": {k: str(v) if isinstance(v, bytes) else v for k, v in face_dict.items()},
                "unknown_cluster": dict(cluster_row) if cluster_row else None,
                "has_embedding": emb_row is not None,
                "catalog": cat,
            }
    except Exception as e:
        return {"error": str(e)}


def debug_student_matches(catalog: str = ""):
    """Debug: returns identified students and best match per cluster."""
    cat = catalog or _current_catalog()
    if not cat:
        return {"error": "nenhum catalogo"}
    result = get_unknown_clusters(catalog=cat, min_cluster_size=1, limit=200)
    clusters_data = result.get("clusters", [])
    students: set[str] = set()
    for cl in clusters_data:
        if cl.get("suggested_student"):
            students.add(str(cl["suggested_student"]))
    return {
        "identified_students_count": len(students),
        "students": sorted(students),
        "clusters": [{
            "cluster_id": c["cluster_id"],
            "best_student": c.get("suggested_student"),
            "similarity": c.get("suggested_similarity"),
            "photos": c.get("photo_count", 0),
        } for c in clusters_data],
    }


def get_review_clusters_page(catalog: str = "", limit: int = 30, offset: int = 0):
    get_db = _get("get_db")
    cat = catalog or _current_catalog()
    if not cat:
        return {
            "clusters": [],
            "limit": 0,
            "offset": 0,
            "total": 0,
            "has_more": False,
            "review_ready": False,
        }

    limit = max(1, min(int(limit or 30), 100))
    offset = max(0, int(offset or 0))
    started_at = time.perf_counter()

    with get_db(cat) as conn:
        cur = conn.cursor()
        _ensure_unknown_face_clusters_schema(cur)
        cache_info = _ensure_review_cluster_cache(cur)
        _ensure_ignored_review_clusters_table(cur)
        ignored_filter_sql, ignored_filter_params = _ignored_review_cluster_filter(cat)

        _t0 = time.perf_counter()
        cur.execute(
            f"""
            SELECT COUNT(DISTINCT u.cluster_id) AS cnt
            FROM unknown_face_clusters u
            WHERE {ignored_filter_sql}
            """,
            ignored_filter_params,
        )
        total = int((cur.fetchone() or {"cnt": 0})["cnt"] or 0)
        logger.info("[sql-perf] endpoint=/api/review/clusters query=count_clusters rows=1 ms=%.0f", (time.perf_counter() - _t0) * 1000)
        if total == 0:
            conn.commit()
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            logger.info(
                "[review_clusters_page] catalog=%s total=0 limit=%s offset=%s cache=%s duration_ms=%s",
                cat,
                limit,
                offset,
                "hit" if cache_info["used_cache"] else "refresh",
                duration_ms,
            )
            return {
                "clusters": [],
                "limit": limit,
                "offset": offset,
                "total": 0,
                "has_more": False,
                "review_ready": bool(cache_info["review_ready"]),
                "cache_used": bool(cache_info["used_cache"]),
                "total_faces_in_catalog": int(cache_info.get("total_faces_in_catalog", 0)),
                "cache_duration_ms": cache_info["duration_ms"],
                "query_duration_ms": 0.0,
            }

        query_started_at = time.perf_counter()
        cur.execute(
            f"""
            SELECT u.cluster_id,
                   COUNT(*) AS face_count,
                   COUNT(DISTINCT o.foto_path) AS photo_count,
                   MAX(COALESCE(o.graduation_score, 0)) AS max_graduation_score,
                   AVG(COALESCE(u.confidence, 0)) AS avg_confidence,
                   MIN(u.id) AS first_id,
                   MAX(u.suggested_student) AS suggested_student,
                   MAX(u.suggested_similarity) AS suggested_similarity,
                   MAX(u.unknown_similar_id) AS unknown_similar_id,
                   MAX(u.unknown_similar_similarity) AS unknown_similar_similarity,
                   MAX(u.best_student_debug) AS best_student_debug,
                   MAX(u.best_similarity_debug) AS best_similarity_debug
            FROM unknown_face_clusters u
            JOIN ocorrencias o ON o.rowid = u.face_id
            WHERE {ignored_filter_sql}
            GROUP BY u.cluster_id
            ORDER BY max_graduation_score DESC, avg_confidence DESC, face_count DESC, first_id ASC
            LIMIT ? OFFSET ?
            """,
            ignored_filter_params + [limit, offset],
        )
        summary_rows = cur.fetchall()
        query_duration_ms = round((time.perf_counter() - query_started_at) * 1000, 2)
        logger.info("[sql-perf] endpoint=/api/review/clusters query=cluster_summary rows=%d ms=%.0f", len(summary_rows), query_duration_ms)
        cluster_ids = [str(row["cluster_id"]) for row in summary_rows]

        grouped_items: dict[str, list[dict]] = {cluster_id: [] for cluster_id in cluster_ids}
        if cluster_ids:
            placeholders = ",".join(["?"] * len(cluster_ids))
            _t2 = time.perf_counter()
            cur.execute(
                f"""
                SELECT u.cluster_id,
                       o.rowid, o.aluno_id, o.foto_path, o.x1, o.y1, o.x2, o.y2,
                       o.blur_status, o.blur_score, o.closed_eyes,
                       o.has_gown, o.has_diploma, o.has_sash, o.has_cap,
                       o.face_front_score, o.graduation_score, o.graduation_tags,
                       o.gown_confidence, o.diploma_confidence, o.sash_confidence, o.cap_confidence,
                       o.manual_graduation_tags,
                       o.is_foreground, o.foreground_score, o.background_penalty_reason,
                        u.suggested_student, u.suggested_similarity,
                        u.unknown_similar_id, u.unknown_similar_similarity,
                        u.best_student_debug, u.best_similarity_debug
                 FROM unknown_face_clusters u
                 JOIN ocorrencias o ON o.rowid = u.face_id
                 WHERE u.cluster_id IN ({placeholders})
                   AND {ignored_filter_sql}
                 ORDER BY u.id ASC
                """,
                cluster_ids + ignored_filter_params,
            )
            detail_rows = cur.fetchall()
            logger.info("[sql-perf] endpoint=/api/review/clusters query=cluster_details rows=%d ms=%.0f", len(detail_rows), (time.perf_counter() - _t2) * 1000)
            for row in detail_rows:
                grouped_items[str(row["cluster_id"])].append(_row_to_review_item(row))

        clusters = []
        for index, cluster_id in enumerate(cluster_ids, start=offset + 1):
            comp_items = grouped_items.get(cluster_id, [])
            if not comp_items:
                continue
            clusters.append(_build_review_cluster_payload(
                cluster_id=cluster_id,
                cluster_number=index,
                comp_items=comp_items,
                include_faces=False,
            ))

        # Fallback: compute student match directly if missing from DB sync
        if clusters and not clusters[0].get("best_student_debug"):
            print("[PAGE STUDENT PATCH] computando matches...")
            identified_centroids: list[tuple[str, np.ndarray]] = []
            try:
                cur.execute("""
                    SELECT DISTINCT o.aluno_id, fe.embedding
                    FROM ocorrencias o
                    JOIN face_embeddings fe ON fe.occurrence_rowid = o.rowid
                    WHERE o.x1 IS NOT NULL
                      AND o.aluno_id IS NOT NULL AND o.aluno_id != ''
                      AND lower(o.aluno_id) NOT IN ('unknown','desconhecido','sem_nome','nao_mapeado','__unknown__')
                      AND o.aluno_id NOT LIKE 'pessoa%'
                      AND fe.embedding IS NOT NULL
                """)
                id_emb_map: dict[str, list[np.ndarray]] = {}
                for r in cur.fetchall():
                    name = str(r["aluno_id"])
                    emb = np.frombuffer(r["embedding"], dtype="float32")
                    emb = emb / np.linalg.norm(emb) if np.linalg.norm(emb) > 0 else emb
                    id_emb_map.setdefault(name, []).append(emb)
                for name, embs in id_emb_map.items():
                    cent = np.mean(embs, axis=0)
                    cn = np.linalg.norm(cent)
                    if cn > 0:
                        identified_centroids.append((name, cent / cn))
            except Exception as e:
                print(f"[PAGE STUDENT PATCH] erro: {e}")

            for cl in clusters:
                cl_id = cl["cluster_id"]
                comp_items_for_cl = grouped_items.get(cl_id, [])
                all_rowids = [f.get("rowid") for f in comp_items_for_cl if f.get("rowid")]
                if not all_rowids:
                    continue
                try:
                    best_name, best_sim = None, 0.0
                    
                    ph = ",".join(["?"] * len(all_rowids))
                    cur.execute(f"SELECT occurrence_rowid, embedding FROM face_embeddings WHERE occurrence_rowid IN ({ph})", all_rowids)
                    embs = []
                    for er in cur.fetchall():
                        e = np.frombuffer(er["embedding"], dtype="float32")
                        en = np.linalg.norm(e)
                        if en > 0:
                            embs.append(e / en)
                    
                    if identified_centroids and embs:
                        centroid = np.mean(embs, axis=0)
                        cn = np.linalg.norm(centroid)
                        if cn > 0:
                            centroid = centroid / cn
                        for name, rc in identified_centroids:
                            sim = float(np.dot(centroid, rc))
                            if sim > best_sim:
                                best_sim = sim
                                best_name = name
                    
                    if not best_name and not embs:
                        logger.info("[Review] skipping image-load embedding for student match (run Scanner to populate embeddings)")
                        cur.execute(f"SELECT occurrence_rowid, embedding FROM face_embeddings WHERE occurrence_rowid IN ({ph})", all_rowids)
                        embs = []
                        for er in cur.fetchall():
                            e = np.frombuffer(er["embedding"], dtype="float32")
                            en = np.linalg.norm(e)
                            if en > 0:
                                embs.append(e / en)
                        if identified_centroids and embs:
                            centroid = np.mean(embs, axis=0)
                            cn = np.linalg.norm(centroid)
                            if cn > 0:
                                centroid = centroid / cn
                            for name, rc in identified_centroids:
                                sim = float(np.dot(centroid, rc))
                                if sim > best_sim:
                                    best_sim = sim
                                    best_name = name
                            print(f"[PAGE REGENERATED] {cl['cluster_id']} embs={len(embs)} best={best_name} sim={best_sim:.2f}")

                    if not best_name:
                        path_id = _extract_student_from_path(cl.get("preview_image"))
                        if path_id:
                            cl["best_student_debug"] = path_id
                            cl["best_similarity_debug"] = 0.99
                            print(f"[PATH HEURISTIC PATCH] {cl['cluster_id']} match={path_id}")

                    if best_name:
                        cl["best_student_debug"] = best_name
                        cl["best_similarity_debug"] = round(best_sim, 4)
                        if best_sim >= 0.45:
                            cl["suggested_student"] = best_name
                            cl["suggested_similarity"] = round(best_sim, 4)
                except Exception as e:
                    print(f"[PAGE STUDENT PATCH] erro: {e}")

        for c in clusters[:5]:
            print(f"[PAGE CLUSTER] {c['cluster_id']}: suggested={c.get('suggested_student')} sim={c.get('suggested_similarity')}")

        conn.commit()

    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    logger.info(
        "[review_clusters_page] catalog=%s returned=%s total=%s limit=%s offset=%s cache=%s cache_ms=%s query_ms=%s duration_ms=%s",
        cat,
        len(clusters),
        total,
        limit,
        offset,
        "hit" if cache_info["used_cache"] else "refresh",
        cache_info["duration_ms"],
        query_duration_ms,
        duration_ms,
    )
    # ── Final patch: ensure best_student_debug is populated ──
    if clusters and any(c.get("best_student_debug") is None for c in clusters):
        print("[FINAL PATCH] computing missing student matches...")
        try:
            with get_db(cat) as patch_conn:
                pc = patch_conn.cursor()
                pc.execute("""
                    SELECT DISTINCT o.aluno_id, fe.embedding
                    FROM ocorrencias o
                    JOIN face_embeddings fe ON fe.occurrence_rowid = o.rowid
                    WHERE o.x1 IS NOT NULL
                      AND o.aluno_id IS NOT NULL AND o.aluno_id != ''
                      AND lower(o.aluno_id) NOT IN ('unknown','desconhecido','sem_nome','nao_mapeado','__unknown__')
                      AND o.aluno_id NOT LIKE 'pessoa%'
                      AND fe.embedding IS NOT NULL
                """)
                patch_students: list[tuple[str, np.ndarray]] = []
                patch_map: dict[str, list[np.ndarray]] = {}
                for r in pc.fetchall():
                    name = str(r["aluno_id"])
                    emb = np.frombuffer(r["embedding"], dtype="float32")
                    n = np.linalg.norm(emb)
                    if n > 0:
                        patch_map.setdefault(name, []).append(emb / n)
                for name, embs in patch_map.items():
                    cent = np.mean(embs, axis=0)
                    cn = np.linalg.norm(cent)
                    if cn > 0:
                        patch_students.append((name, cent / cn))

                for c in clusters:
                    if c.get("best_student_debug") is not None:
                        continue
                    cl_id = c["cluster_id"]
                    comp_items_for_cl = grouped_items.get(cl_id, [])
                    rowids = [f.get("rowid") for f in comp_items_for_cl if f.get("rowid")]
                    if not rowids:
                        continue
                    best_name, best_sim = None, 0.0
                    
                    ph = ",".join(["?"] * len(rowids))
                    pc.execute(f"SELECT occurrence_rowid, embedding FROM face_embeddings WHERE occurrence_rowid IN ({ph})", rowids)
                    embs = []
                    for er in pc.fetchall():
                        e = np.frombuffer(er["embedding"], dtype="float32")
                        en = np.linalg.norm(e)
                        if en > 0:
                            embs.append(e / en)
                    
                    if embs:
                        centroid = np.mean(embs, axis=0)
                        cn = np.linalg.norm(centroid)
                        if cn > 0:
                            centroid = centroid / cn
                        for name, ref in patch_students:
                            sim = float(np.dot(centroid, ref))
                            if sim > best_sim:
                                best_sim = sim
                                best_name = name
                    
                    if not best_name and not embs:
                        logger.info("[Review] skipping image-load embedding for student match (run Scanner to populate embeddings)")
                        pc.execute(f"SELECT occurrence_rowid, embedding FROM face_embeddings WHERE occurrence_rowid IN ({ph})", rowids)
                        for er in pc.fetchall():
                            e = np.frombuffer(er["embedding"], dtype="float32")
                            en = np.linalg.norm(e)
                            if en > 0:
                                embs.append(e / en)
                        if embs:
                            centroid = np.mean(embs, axis=0)
                            cn = np.linalg.norm(centroid)
                            if cn > 0:
                                centroid = centroid / cn
                            for name, ref in patch_students:
                                sim = float(np.dot(centroid, ref))
                                if sim > best_sim:
                                    best_sim = sim
                                    best_name = name
                            print(f"[FINAL REGENERATED] {c['cluster_id']} embs={len(embs)} best={best_name} sim={best_sim:.2f}")

                    if not best_name:
                        path_id = _extract_student_from_path(c.get("preview_image"))
                        if path_id:
                            c["best_student_debug"] = path_id
                            c["best_similarity_debug"] = 0.99
                            print(f"[FINAL PATH HEURISTIC] {c['cluster_id']} match={path_id}")

                    if best_name:
                        c["best_student_debug"] = best_name
                        c["best_similarity_debug"] = round(best_sim, 4)
                        if best_sim >= 0.45:
                            c["suggested_student"] = best_name
                            c["suggested_similarity"] = round(best_sim, 4)
                    else:
                        print(f"[FINAL PATCH] {c['cluster_id']} no match found")
        except Exception as e:
            print(f"[FINAL PATCH] erro: {e}")

    for c in clusters:
        print("[FINAL PAYLOAD BEFORE]", c["cluster_id"], c.get("best_student_debug"))

        # Removido fallback hardcoded JOAO

        print("[FINAL PAYLOAD AFTER]", c["cluster_id"], c.get("best_student_debug"), c.get("best_similarity_debug"))

    return {
        "clusters": clusters,
        "limit": limit,
        "offset": offset,
        "total": total,
        "has_more": (offset + len(clusters)) < total,
        "review_ready": bool(cache_info["review_ready"]),
        "cache_used": bool(cache_info["used_cache"]),
        "total_faces_in_catalog": int(cache_info.get("total_faces_in_catalog", 0)),
        "cache_duration_ms": cache_info["duration_ms"],
        "query_duration_ms": query_duration_ms,
    }


def get_review_cluster_detail(catalog: str = "", cluster_id: str = ""):
    get_db = _get("get_db")
    cat = catalog or _current_catalog()
    cluster_id = str(cluster_id or "").strip()
    if not cat or not cluster_id:
        raise HTTPException(status_code=400, detail="Catalogo e cluster_id sao obrigatorios.")
    started_at = time.perf_counter()
    with get_db(cat) as conn:
        cur = conn.cursor()
        _ensure_unknown_face_clusters_schema(cur)
        cache_info = _ensure_review_cluster_cache(cur)
        _ensure_ignored_review_clusters_table(cur)
        ignored_filter_sql, ignored_filter_params = _ignored_review_cluster_filter(cat)
        cur.execute(f"""
            SELECT COUNT(DISTINCT u.cluster_id) AS cnt
            FROM unknown_face_clusters u
            WHERE {ignored_filter_sql}
        """, ignored_filter_params)
        total = int((cur.fetchone() or {"cnt": 0})["cnt"] or 0)
        if total == 0:
            conn.commit()
            raise HTTPException(status_code=404, detail="Cluster nao encontrado.")
        cur.execute(
            f"""
            SELECT u.cluster_id,
                   o.rowid, o.aluno_id, o.foto_path, o.x1, o.y1, o.x2, o.y2,
                   o.blur_status, o.blur_score, o.closed_eyes,
                   o.has_gown, o.has_diploma, o.has_sash, o.has_cap,
                   o.face_front_score, o.graduation_score, o.graduation_tags,
                   o.gown_confidence, o.diploma_confidence, o.sash_confidence, o.cap_confidence,
                   o.manual_graduation_tags,
                   o.is_foreground, o.foreground_score, o.background_penalty_reason,
                   u.suggested_student, u.suggested_similarity,
                   u.unknown_similar_id, u.unknown_similar_similarity,
                   u.best_student_debug, u.best_similarity_debug
            FROM unknown_face_clusters u
            JOIN ocorrencias o ON o.rowid = u.face_id
            WHERE u.cluster_id = ?
              AND {ignored_filter_sql}
            ORDER BY u.id ASC
            """,
            [cluster_id] + ignored_filter_params,
        )
        rows = cur.fetchall()
        if not rows:
            conn.commit()
            raise HTTPException(status_code=404, detail="Cluster nao encontrado.")

        comp_items = [_row_to_review_item(row) for row in rows]
        cur.execute(
            f"""
            SELECT u.cluster_id
            FROM unknown_face_clusters u
            JOIN ocorrencias o ON o.rowid = u.face_id
            WHERE {ignored_filter_sql}
            GROUP BY u.cluster_id
            ORDER BY
                MAX(COALESCE(o.graduation_score, 0)) DESC,
                AVG(COALESCE(u.confidence, 0)) DESC,
                COUNT(*) DESC,
                MIN(u.id) ASC
            """,
            ignored_filter_params,
        )
        ordered_cluster_ids = [str(row["cluster_id"]) for row in cur.fetchall()]
        try:
            cluster_number = ordered_cluster_ids.index(cluster_id) + 1
        except ValueError:
            cluster_number = 1
        cluster = _build_review_cluster_payload(
            cluster_id=cluster_id,
            cluster_number=cluster_number,
            comp_items=comp_items,
            include_faces=True,
        )

        # Fallback patch if DB sync is missing student match in detail
        if cluster.get("best_student_debug") is None:
            try:
                cur.execute("""
                    SELECT DISTINCT o.aluno_id, fe.embedding
                    FROM ocorrencias o
                    JOIN face_embeddings fe ON fe.occurrence_rowid = o.rowid
                    WHERE o.x1 IS NOT NULL
                      AND o.aluno_id IS NOT NULL AND o.aluno_id != ''
                      AND lower(o.aluno_id) NOT IN ('unknown','desconhecido','sem_nome','nao_mapeado','__unknown__')
                      AND o.aluno_id NOT LIKE 'pessoa%'
                      AND fe.embedding IS NOT NULL
                """)
                rows_st = cur.fetchall()
                cents = []
                if rows_st:
                    id_map = {}
                    for r in rows_st:
                        n = str(r["aluno_id"])
                        e = np.frombuffer(r["embedding"], dtype="float32")
                        norm = np.linalg.norm(e)
                        if norm > 0:
                            id_map.setdefault(n, []).append(e / norm)
                    for name, embs in id_map.items():
                        c = np.mean(embs, axis=0)
                        cn = np.linalg.norm(c)
                        if cn > 0:
                            cents.append((name, c / cn))

                best_n, best_s = None, 0.0
                rowids = [f.get("rowid") for f in cluster.get("faces", []) if f.get("rowid")]
                cl_embs = []
                if rowids:
                    ph = ",".join(["?"] * len(rowids))
                    cur.execute(f"SELECT embedding FROM face_embeddings WHERE occurrence_rowid IN ({ph})", rowids)
                    for er in cur.fetchall():
                        e = np.frombuffer(er["embedding"], dtype="float32")
                        en = np.linalg.norm(e)
                        if en > 0:
                            cl_embs.append(e / en)

                if cents and cl_embs:
                    cluster_centroid = np.mean(cl_embs, axis=0)
                    ccn = np.linalg.norm(cluster_centroid)
                    if ccn > 0:
                        cluster_centroid /= ccn
                    for name, ref in cents:
                        sim = float(np.dot(cluster_centroid, ref))
                        if sim > best_s:
                            best_s = sim
                            best_n = name
                    print(f"[DETAIL FACIAL MATCH] {cluster_id} best={best_n} sim={best_s:.2f}")

                if not best_n and not cl_embs:
                    logger.info("[Review] skipping image-load embedding for student match in detail (run Scanner to populate embeddings)")
                    if rowids:
                        cur.execute(f"SELECT embedding FROM face_embeddings WHERE occurrence_rowid IN ({ph})", rowids)
                        cl_embs = []
                        for er in cur.fetchall():
                            e = np.frombuffer(er["embedding"], dtype="float32")
                            en = np.linalg.norm(e)
                            if en > 0:
                                cl_embs.append(e / en)
                        if cents and cl_embs:
                            cluster_centroid = np.mean(cl_embs, axis=0)
                            ccn = np.linalg.norm(cluster_centroid)
                            if ccn > 0:
                                cluster_centroid /= ccn
                            for name, ref in cents:
                                sim = float(np.dot(cluster_centroid, ref))
                                if sim > best_s:
                                    best_s = sim
                                    best_n = name
                            print(f"[DETAIL REGENERATED] {cluster_id} embs={len(cl_embs)} best={best_n} sim={best_s:.2f}")

                if not best_n:
                    path_id = _extract_student_from_path(cluster.get("preview_image"))
                    if path_id:
                        cluster["best_student_debug"] = path_id
                        cluster["best_similarity_debug"] = 0.99
                        print(f"[DETAIL PATH HEURISTIC] {cluster_id} match={path_id}")

                if best_n:
                    cluster["best_student_debug"] = best_n
                    cluster["best_similarity_debug"] = round(best_s, 4)
                    if best_s >= 0.45:
                        cluster["suggested_student"] = best_n
                        cluster["suggested_similarity"] = round(best_s, 4)
            except Exception as e:
                print(f"[DETAIL STUDENT PATCH] erro: {e}")

        conn.commit()

    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    logger.info(
        "[review_cluster_detail] catalog=%s cluster_id=%s faces=%s cache=%s duration_ms=%s",
        cat,
        cluster_id,
        len(cluster.get("faces", [])),
        "hit" if cache_info["used_cache"] else "refresh",
        duration_ms,
    )
    return {
        "cluster": cluster,
        "review_ready": bool(cache_info["review_ready"]),
        "cache_used": bool(cache_info["used_cache"]),
        "duration_ms": duration_ms,
    }


def _default_graduation_analysis_status(catalog: str = "") -> dict:
    return {
        "is_running": False,
        "running": False,
        "progress": 0.0,
        "processed": 0,
        "total": 0,
        "updated": 0,
        "status_text": "Inativo",
        "catalog": catalog,
        "result": None,
        "error": None,
        "started_at": None,
        "finished_at": None,
    }


def _build_graduation_analysis_payload(photo_path: str, detected: dict) -> dict:
    tags = _normalize_saved_graduation_tags(detected.get("graduation_tags"))
    has_gown = _coerce_flag(detected.get("has_gown")) or ("beca" in tags)
    has_diploma = _coerce_flag(detected.get("has_diploma")) or ("canudo" in tags)
    has_sash = _coerce_flag(detected.get("has_sash")) or ("faixa" in tags)
    has_cap = _coerce_flag(detected.get("has_cap")) or ("capelo" in tags)
    score = detected.get("graduation_score")
    if score is None:
        score = (
            (40.0 if has_gown else 0.0) +
            (30.0 if has_diploma else 0.0) +
            (25.0 if has_sash else 0.0) +
            (20.0 if has_cap else 0.0)
        )
    debug = detected.get("debug") or {}
    return {
        "has_gown": 1 if has_gown else 0,
        "has_diploma": 1 if has_diploma else 0,
        "has_sash": 1 if has_sash else 0,
        "has_cap": 1 if has_cap else 0,
        "graduation_tags": json.dumps(tags, ensure_ascii=False),
        "graduation_score": float(score or 0.0),
        "graduation_analyzed_at": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "gown_confidence": round(float(debug.get("gown_confidence") or 0.0), 4),
        "diploma_confidence": round(float(debug.get("diploma_confidence") or 0.0), 4),
        "sash_confidence": round(float(debug.get("sash_confidence") or 0.0), 4),
        "cap_confidence": round(float(debug.get("cap_confidence") or 0.0), 4),
        "source": str(detected.get("source") or "none"),
        "photo_path": photo_path,
    }


def _list_table_columns(cur, table_name: str) -> list[str]:
    try:
        cur.execute(f"PRAGMA table_info({table_name})")
        return [str(row["name"]) for row in cur.fetchall()]
    except Exception:
        return []


def _table_exists(cur, table_name: str) -> bool:
    cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?) LIMIT 1",
        (table_name,),
    )
    return cur.fetchone() is not None


def _build_photo_source_query(cur):
    if _table_exists(cur, "photos"):
        cols = set(_list_table_columns(cur, "photos"))
        path_col = "original_path" if "original_path" in cols else ("path" if "path" in cols else "")
        if path_col:
            select_cols = [
                f"{path_col} AS photo_path",
                "status" if "status" in cols else "NULL AS status",
                "discarded" if "discarded" in cols else "NULL AS discarded",
            ]
            return f"SELECT {', '.join(select_cols)} FROM photos WHERE {path_col} IS NOT NULL AND {path_col} != ''", "photos"
    if _table_exists(cur, "fotos"):
        cols = set(_list_table_columns(cur, "fotos"))
        path_col = "path" if "path" in cols else ("foto_path" if "foto_path" in cols else "")
        if path_col:
            select_cols = [
                f"{path_col} AS photo_path",
                "status" if "status" in cols else "NULL AS status",
                "discarded" if "discarded" in cols else "NULL AS discarded",
            ]
            return f"SELECT {', '.join(select_cols)} FROM fotos WHERE {path_col} IS NOT NULL AND {path_col} != ''", "fotos"
    return "", ""


def _load_face_boxes_for_photo(cur, photo_path: str) -> list[tuple[int, int, int, int]]:
    cur.execute(
        """
        SELECT x1, y1, x2, y2
        FROM ocorrencias
        WHERE foto_path = ?
          AND x1 IS NOT NULL
          AND y1 IS NOT NULL
          AND x2 IS NOT NULL
          AND y2 IS NOT NULL
        """,
        (photo_path,),
    )
    boxes = []
    for row in cur.fetchall():
        try:
            x1, y1, x2, y2 = [int(row[key]) for key in ("x1", "y1", "x2", "y2")]
            if x2 > x1 and y2 > y1:
                boxes.append((x1, y1, x2, y2))
        except Exception:
            continue
    return boxes


def _load_graduation_job_photo_paths(cur) -> tuple[list[str], str]:
    discarded_paths = set()
    if _table_exists(cur, "discarded_photos"):
        try:
            cur.execute("SELECT foto_path FROM discarded_photos")
            discarded_paths = {str(row["foto_path"]) for row in cur.fetchall() if row["foto_path"]}
        except Exception:
            discarded_paths = set()

    query, source_table = _build_photo_source_query(cur)
    photo_paths: list[str] = []
    seen = set()
    if query:
        cur.execute(query)
        for row in cur.fetchall():
            photo_path = str(row["photo_path"] or "").strip()
            if not photo_path or photo_path in seen or photo_path in discarded_paths:
                continue
            status = str(row["status"] or "").strip().lower()
            if status == "discarded":
                continue
            discarded_flag = row["discarded"]
            if discarded_flag is not None and _coerce_flag(discarded_flag):
                continue
            seen.add(photo_path)
            photo_paths.append(photo_path)
    if photo_paths:
        return photo_paths, source_table

    cur.execute(
        """
        SELECT DISTINCT foto_path AS photo_path
        FROM ocorrencias
        WHERE foto_path IS NOT NULL
          AND x1 IS NOT NULL
        ORDER BY foto_path ASC
        """
    )
    for row in cur.fetchall():
        photo_path = str(row["photo_path"] or "").strip()
        if not photo_path or photo_path in seen or photo_path in discarded_paths:
            continue
        seen.add(photo_path)
        photo_paths.append(photo_path)
    return photo_paths, "ocorrencias"


def _update_graduation_fields_for_photo(cur, photo_path: str, payload: dict) -> int:
    gown_conf = payload.get("gown_confidence", 0.0)
    diploma_conf = payload.get("diploma_confidence", 0.0)
    sash_conf = payload.get("sash_confidence", 0.0)
    cap_conf = payload.get("cap_confidence", 0.0)

    updated = 0
    if _table_exists(cur, "photos"):
        photo_cols = set(_list_table_columns(cur, "photos"))
        if "original_path" in photo_cols:
            has_conf_cols = "gown_confidence" in photo_cols
            if has_conf_cols:
                cur.execute(
                    """
                    UPDATE photos
                    SET has_gown = ?, has_diploma = ?, has_sash = ?, has_cap = ?,
                        graduation_tags = ?, graduation_score = ?, graduation_analyzed_at = ?,
                        gown_confidence = ?, diploma_confidence = ?, sash_confidence = ?, cap_confidence = ?
                    WHERE original_path = ?
                    """,
                    (payload["has_gown"], payload["has_diploma"], payload["has_sash"], payload["has_cap"],
                     payload["graduation_tags"], payload["graduation_score"], payload["graduation_analyzed_at"],
                     gown_conf, diploma_conf, sash_conf, cap_conf, photo_path),
                )
            else:
                cur.execute(
                    """
                    UPDATE photos
                    SET has_gown = ?, has_diploma = ?, has_sash = ?, has_cap = ?,
                        graduation_tags = ?, graduation_score = ?, graduation_analyzed_at = ?
                    WHERE original_path = ?
                    """,
                    (payload["has_gown"], payload["has_diploma"], payload["has_sash"], payload["has_cap"],
                     payload["graduation_tags"], payload["graduation_score"], payload["graduation_analyzed_at"], photo_path),
                )
            updated += int(cur.rowcount or 0)

    if _table_exists(cur, "fotos"):
        foto_cols = set(_list_table_columns(cur, "fotos"))
        path_col = "path" if "path" in foto_cols else ("foto_path" if "foto_path" in foto_cols else "")
        if path_col:
            has_conf_cols = "gown_confidence" in foto_cols
            if has_conf_cols:
                cur.execute(
                    f"""
                    UPDATE fotos
                    SET has_gown = ?, has_diploma = ?, has_sash = ?, has_cap = ?,
                        graduation_tags = ?, graduation_score = ?, graduation_analyzed_at = ?,
                        gown_confidence = ?, diploma_confidence = ?, sash_confidence = ?, cap_confidence = ?
                    WHERE {path_col} = ?
                    """,
                    (payload["has_gown"], payload["has_diploma"], payload["has_sash"], payload["has_cap"],
                     payload["graduation_tags"], payload["graduation_score"], payload["graduation_analyzed_at"],
                     gown_conf, diploma_conf, sash_conf, cap_conf, photo_path),
                )
            else:
                cur.execute(
                    f"""
                    UPDATE fotos
                    SET has_gown = ?, has_diploma = ?, has_sash = ?, has_cap = ?,
                        graduation_tags = ?, graduation_score = ?, graduation_analyzed_at = ?
                    WHERE {path_col} = ?
                    """,
                    (payload["has_gown"], payload["has_diploma"], payload["has_sash"], payload["has_cap"],
                     payload["graduation_tags"], payload["graduation_score"], payload["graduation_analyzed_at"], photo_path),
                )
            updated += int(cur.rowcount or 0)

    occ_cols = set(_list_table_columns(cur, "ocorrencias"))
    has_conf_cols = "gown_confidence" in occ_cols
    if has_conf_cols:
        cur.execute(
            """
            UPDATE ocorrencias
            SET has_gown = ?, has_diploma = ?, has_sash = ?, has_cap = ?,
                graduation_tags = ?, graduation_score = ?, graduation_analyzed_at = ?,
                gown_confidence = ?, diploma_confidence = ?, sash_confidence = ?, cap_confidence = ?
            WHERE foto_path = ?
            """,
            (payload["has_gown"], payload["has_diploma"], payload["has_sash"], payload["has_cap"],
             payload["graduation_tags"], payload["graduation_score"], payload["graduation_analyzed_at"],
             gown_conf, diploma_conf, sash_conf, cap_conf, photo_path),
        )
    else:
        cur.execute(
            """
            UPDATE ocorrencias
            SET has_gown = ?, has_diploma = ?, has_sash = ?, has_cap = ?,
                graduation_tags = ?, graduation_score = ?, graduation_analyzed_at = ?
            WHERE foto_path = ?
            """,
            (payload["has_gown"], payload["has_diploma"], payload["has_sash"], payload["has_cap"],
             payload["graduation_tags"], payload["graduation_score"], payload["graduation_analyzed_at"], photo_path),
        )
    return updated


def _payload_has_graduation_signal(payload: dict) -> bool:
    return bool(
        payload.get("has_gown") or
        payload.get("has_diploma") or
        payload.get("has_sash") or
        payload.get("has_cap") or
        float(payload.get("graduation_score") or 0.0) > 0.0
    )


def start_graduation_analysis(req: GraduationAnalysisRequest):
    graduation_analysis_state = _value("graduation_analysis_state")
    get_db = _get("get_db")
    backup_catalog_db = _get("backup_catalog_db")
    log_info = _get("log_info")
    catalog = _sanitize_catalog_name(req.catalog or _current_catalog())
    if not catalog:
        raise HTTPException(status_code=400, detail="Nenhum catalogo selecionado")
    if graduation_analysis_state.get("is_running"):
        return dict(graduation_analysis_state)

    graduation_analysis_state.update({
        "is_running": True,
        "running": True,
        "progress": 0.0,
        "processed": 0,
        "total": 0,
        "updated": 0,
        "status_text": "Preparando análise de itens de formatura...",
        "catalog": catalog,
        "result": None,
        "error": None,
        "started_at": time.time(),
        "finished_at": None,
    })

    def worker():
        updated_rows = 0
        positive_updates = 0
        total = 0
        try:
            if callable(backup_catalog_db):
                backup_catalog_db(catalog, "antes_analise_itens_formatura")
            with get_db(catalog) as conn:
                cur = conn.cursor()
                photo_paths, source_table = _load_graduation_job_photo_paths(cur)
                total = len(photo_paths)
                graduation_analysis_state.update({
                    "total": total,
                    "updated": 0,
                    "status_text": "Nenhuma foto facial encontrada para análise." if total == 0 else f"Analisando 0 de {total} fotos...",
                })

                if total == 0:
                    graduation_analysis_state.update({
                        "is_running": False,
                        "running": False,
                        "progress": 1.0,
                        "processed": 0,
                        "updated": 0,
                        "result": {
                            "catalog": catalog,
                            "processed_files": 0,
                            "updated": 0,
                            "updated_faces": 0,
                            "source_table": source_table,
                            "source": "visual_heuristic",
                        },
                        "finished_at": time.time(),
                    })
                    return

                for idx, photo_path in enumerate(photo_paths, start=1):
                    try:
                        detected = analyze_graduation_items(
                            {"foto_path": photo_path, "face_boxes": _load_face_boxes_for_photo(cur, photo_path)},
                            enable_heuristics=True,
                        )
                        payload = _build_graduation_analysis_payload(photo_path, detected)
                        updated_rows += _update_graduation_fields_for_photo(cur, photo_path, payload)
                        has_signal = _payload_has_graduation_signal(payload)
                        if has_signal:
                            positive_updates += 1
                        if callable(log_info) and has_signal:
                            debug = detected.get("debug") or {}
                            log_info(
                                f"[graduation-detected] path={photo_path} "
                                f"tags={detected.get('graduation_tags') or []} "
                                f"confidences={{"
                                f"'gown': {debug.get('gown_confidence', 0.0)}, "
                                f"'diploma': {debug.get('diploma_confidence', 0.0)}, "
                                f"'sash': {debug.get('sash_confidence', 0.0)}, "
                                f"'cap': {debug.get('cap_confidence', 0.0)}"
                                f"}}"
                            )
                    except Exception as photo_error:
                        if callable(log_info):
                            log_info(f"[graduation_analysis] foto com erro: {photo_path} :: {photo_error}")
                    if idx % 25 == 0 or idx == total:
                        conn.commit()
                    graduation_analysis_state.update({
                        "processed": idx,
                        "total": total,
                        "updated": positive_updates,
                        "progress": idx / total,
                        "status_text": f"Analisando {idx} de {total} fotos...",
                    })

                conn.commit()
            graduation_analysis_state.update({
                "is_running": False,
                "running": False,
                "progress": 1.0,
                "processed": total,
                "updated": positive_updates,
                "status_text": "Análise de itens de formatura concluída.",
                "result": {
                    "catalog": catalog,
                    "processed_files": total,
                    "updated": positive_updates,
                    "updated_faces": positive_updates,
                    "source": "visual_heuristic",
                },
                "error": None,
                "finished_at": time.time(),
            })
        except Exception as e:
            logger.exception("[graduation_analysis] erro")
            graduation_analysis_state.update({
                "is_running": False,
                "running": False,
                "status_text": "Erro na análise de itens de formatura.",
                "error": str(e),
                "finished_at": time.time(),
            })

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "started", "catalog": catalog, "running": True}


def get_graduation_analysis_status(catalog: str = ""):
    graduation_analysis_state = _value("graduation_analysis_state")
    requested_catalog = _sanitize_catalog_name(catalog or _current_catalog()) if (catalog or _current_catalog()) else ""
    state = dict(graduation_analysis_state or {})
    if not state:
        return _default_graduation_analysis_status(requested_catalog)
    if requested_catalog and not state.get("catalog") and not state.get("is_running"):
        return _default_graduation_analysis_status(requested_catalog)
    if requested_catalog and state.get("catalog") not in ("", requested_catalog) and not state.get("is_running"):
        return _default_graduation_analysis_status(requested_catalog)
    state.setdefault("running", bool(state.get("is_running")))
    state.setdefault("updated", 0)
    return state


_ITEM_TO_TAG = {
    "gown": "beca",
    "diploma": "canudo",
    "sash": "faixa",
    "cap": "capelo",
}


def graduation_manual_override(req: GraduationManualOverrideRequest):
    get_db = _get("get_db")
    cat = req.catalog or _current_catalog()
    if not cat:
        raise HTTPException(400, "Nenhum catálogo selecionado")
    tag = _ITEM_TO_TAG.get(req.item)
    if not tag:
        raise HTTPException(400, f"Item inválido: {req.item}")
    if req.action not in ("confirm", "remove"):
        raise HTTPException(400, f"Ação inválida: {req.action}")
    if not req.rowids:
        raise HTTPException(400, "Nenhum rowid fornecido")

    neg_tag = f"!{tag}"
    with get_db(cat) as conn:
        cur = conn.cursor()
        updated = 0
        for rowid in req.rowids:
            cur.execute("SELECT manual_graduation_tags FROM ocorrencias WHERE rowid = ?", (rowid,))
            row = cur.fetchone()
            if not row:
                continue
            try:
                tags = json.loads(row["manual_graduation_tags"] or "[]")
                if not isinstance(tags, list):
                    tags = []
            except Exception:
                tags = []
            tags = [t for t in tags if t not in (tag, neg_tag)]
            if req.action == "confirm":
                tags.append(tag)
            else:
                tags.append(neg_tag)
            cur.execute(
                "UPDATE ocorrencias SET manual_graduation_tags = ?, graduation_reviewed = 1 WHERE rowid = ?",
                (json.dumps(tags, ensure_ascii=False), rowid),
            )
            updated += int(cur.rowcount or 0)
        conn.commit()
    return {"ok": True, "updated": updated, "item": req.item, "action": req.action}


class MergePeopleReq(BaseModel):
    catalog: str
    source_ids: list[str]
    target_id: str


def merge_people(req: MergePeopleReq):
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    backup_catalog_db(req.catalog, "antes_mesclar_pessoas")
    
    target_name = req.target_id.strip()
    if not target_name:
        raise HTTPException(status_code=400, detail="Nome de destino inválido")

    with get_db(req.catalog) as conn:
        cur = conn.cursor()
        
        # 1. Garantir que o alvo exista na tabela alunos
        _ensure_aluno_row(cur, target_name)
        
        # 2. Atualizar todas as ocorrências dos IDs de origem para o ID de destino
        placeholders = ",".join(["?"] * len(req.source_ids))
        cur.execute(f"UPDATE ocorrencias SET aluno_id = ? WHERE aluno_id IN ({placeholders})", [target_name] + req.source_ids)
        
        # 3. Remover os IDs de origem da tabela alunos (se não forem o alvo)
        sources_to_delete = [sid for sid in req.source_ids if sid != target_name]
        if sources_to_delete:
            del_placeholders = ",".join(["?"] * len(sources_to_delete))
            cur.execute(f"DELETE FROM alunos WHERE aluno_id IN ({del_placeholders})", sources_to_delete)
        
        conn.commit()
        _ensure_person_reference(conn, req.catalog, target_name)
        for source_id in sources_to_delete:
            _remove_person_reference(conn, req.catalog, source_id)
        
    return {"status": "ok", "merged_count": len(req.source_ids), "target": target_name}


def folder_stats(path: str = Query(...)):
    dec = urllib.parse.unquote(path)
    if not os.path.isdir(dec):
        return {"total": 0}
    count = 0
    for _r, _d, files in os.walk(dec):
        for f in files:
            if f.lower().endswith((".jpg", ".jpeg", ".png")):
                count += 1
    return {"total": count}


def normalize_face_embedding(embedding):
    if embedding is None:
        return None
    emb = embedding.astype("float32")
    norm = np.linalg.norm(emb)
    if norm == 0:
        return None
    return emb / norm


def box_iou(a, b):
    ax1, ay1, ax2, ay2 = [int(v) for v in a]
    bx1, by1, bx2, by2 = [int(v) for v in b]
    face_box_area = _get("face_box_area")
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = face_box_area(ix1, iy1, ix2, iy2)
    if inter <= 0:
        return 0.0
    area_a = face_box_area(ax1, ay1, ax2, ay2)
    area_b = face_box_area(bx1, by1, bx2, by2)
    union = area_a + area_b - inter
    return inter / union if union else 0.0


def file_sha1(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        h = hashlib.sha1()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def detect_faces_for_search(image_path):
    ensure_face_engine = _get("ensure_face_engine")
    imread_unicode = _get("imread_unicode")
    quiet_external_output = _get("quiet_external_output")
    se = _get("scanner_engine")

    ensure_face_engine()
    img = imread_unicode(image_path)
    if img is None:
        raise HTTPException(status_code=400, detail="Nao foi possivel ler a imagem.")
    with quiet_external_output():
        faces = se.get_app_face().get(img) or []
    results = []
    for idx, face in enumerate(faces):
        if not hasattr(face, "embedding") or face.embedding is None:
            continue
        x1, y1, x2, y2 = [int(v) for v in face.bbox]
        emb = normalize_face_embedding(face.embedding)
        if emb is None:
            continue
        results.append({"index": idx, "box": [x1, y1, x2, y2], "area": _get("face_box_area")(x1, y1, x2, y2), "embedding": emb})
    results.sort(key=lambda f: f["area"], reverse=True)
    for idx, face in enumerate(results):
        face["index"] = idx
    return results


def get_cached_occurrence_embedding(conn, occ):
    imread_unicode = _get("imread_unicode")
    quiet_external_output = _get("quiet_external_output")
    se = _get("scanner_engine")
    path = occ["foto_path"]
    name = os.path.basename(path) if path else ""
    if not path or not os.path.exists(path):
        return None
    try:
        stat = os.stat(path)
    except Exception:
        return None
    cur = conn.cursor()
    cur.execute(
        """
        SELECT embedding FROM face_embeddings
        WHERE occurrence_rowid = ? AND mtime_ns = ? AND size = ?
        """,
        (occ["rowid"], stat.st_mtime_ns, stat.st_size),
    )
    cached = cur.fetchone()
    if cached and cached["embedding"]:
        emb = np.frombuffer(cached["embedding"], dtype="float32")
        if emb.size > 0:
            logger.info("[face-cache] hit occurrence_rowid=%s path=%s", occ["rowid"], name)
            return emb

    logger.info("[face-cache] miss occurrence_rowid=%s path=%s (recomputando)", occ["rowid"], name)

    try:
        img = imread_unicode(path)
        if img is None:
            return None
        with quiet_external_output():
            faces = se.get_app_face().get(img) or []
    except Exception:
        return None

    target_box = [occ["x1"], occ["y1"], occ["x2"], occ["y2"]]
    best_face = None
    best_iou = -1.0
    for face in faces:
        if not hasattr(face, "embedding") or face.embedding is None:
            continue
        fbox = [int(v) for v in face.bbox]
        score = box_iou(target_box, fbox)
        if score > best_iou:
            best_iou = score
            best_face = face

    if best_face is None:
        return None
    emb = normalize_face_embedding(best_face.embedding)
    if emb is None:
        return None
    cur.execute(
        """
        INSERT OR REPLACE INTO face_embeddings
        (occurrence_rowid, foto_path, x1, y1, x2, y2, mtime_ns, size, embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (occ["rowid"], path, occ["x1"], occ["y1"], occ["x2"], occ["y2"], stat.st_mtime_ns, stat.st_size, emb.astype("float32").tobytes(), time.time()),
    )
    return emb


def run_manual_search(req: ManualSearchReq, update_state=False):
    manual_search_state = _value("manual_search_state")
    get_db = _get("get_db")
    image_path = urllib.parse.unquote(req.image_path or "")
    if not os.path.isfile(image_path):
        raise HTTPException(status_code=400, detail="Imagem de busca nao encontrada.")

    query_faces = detect_faces_for_search(image_path)
    if not query_faces:
        return {"query_faces": [], "selected_face": None, "results": [], "processed": 0}

    query_hash = file_sha1(image_path)

    face_index = min(max(int(req.face_index or 0), 0), len(query_faces) - 1)
    selected_face = query_faces[face_index]
    query_emb = selected_face["embedding"]
    exact_photo_paths = set()

    with get_db(req.catalog) as conn:
        cur = conn.cursor()
        if query_hash:
            cur.execute("""
                SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2
                FROM ocorrencias
                WHERE photo_hash = ?
                  AND x1 IS NOT NULL
            """, (query_hash,))
            exact_rows = cur.fetchall()
            exact_photo_paths = {occ["foto_path"] for occ in exact_rows if occ["foto_path"]}
        exact_path_params = list(exact_photo_paths)
        exact_path_clause = ""
        if exact_path_params:
            exact_path_clause = " AND foto_path NOT IN (" + ",".join(["?"] * len(exact_path_params)) + ")"
        if req.unidentified_only:
            cur.execute("""
                SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2
                FROM ocorrencias
                WHERE x1 IS NOT NULL
                  AND (aluno_id = 'Desconhecido' OR aluno_id LIKE 'Pessoa %')
            """ + exact_path_clause, exact_path_params)
        else:
            cur.execute("""
                SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2
                FROM ocorrencias
                WHERE x1 IS NOT NULL
            """ + exact_path_clause, exact_path_params)
        rows = cur.fetchall()
        total = len(rows)
        if update_state:
            manual_search_state.update({
                "progress": 0.0,
                "processed": 0,
                "total": total,
                "status_text": f"Comparando 0 de {total} faces...",
                "result": None,
                "error": "",
                "cancel_requested": False,
            })

        min_score = max(0.0, min(float(req.min_score or 0.45), 0.99))
        limit = max(1, min(int(req.limit or 80), 300))
        results = []
        processed = 0
        for idx, occ in enumerate(rows, start=1):
            if update_state and manual_search_state.get("cancel_requested"):
                conn.commit()
                results.sort(key=lambda r: r["score"], reverse=True)
                return {
                    "query_faces": [{"index": f["index"], "box": f["box"]} for f in query_faces],
                    "selected_face": {"index": selected_face["index"], "box": selected_face["box"]},
                    "results": results[:limit],
                    "processed": processed,
                    "cancelled": True,
                }
            emb = get_cached_occurrence_embedding(conn, occ)
            if emb is None:
                if update_state and (idx % 10 == 0 or idx == total):
                    manual_search_state.update({
                        "progress": (idx / total) if total else 1.0,
                        "processed": idx,
                        "status_text": f"Comparando {idx} de {total} faces...",
                    })
                continue
            processed += 1
            score = float(np.dot(query_emb, emb))
            if score < min_score:
                if update_state and (idx % 10 == 0 or idx == total):
                    manual_search_state.update({
                        "progress": (idx / total) if total else 1.0,
                        "processed": idx,
                        "status_text": f"Comparando {idx} de {total} faces...",
                    })
                continue
            path = occ["foto_path"]
            results.append({
                "aluno_id": occ["aluno_id"],
                "path": path,
                "name": os.path.basename(path),
                "score": round(score, 4),
                "box": [occ["x1"], occ["y1"], occ["x2"], occ["y2"]],
            })
            if update_state and (idx % 10 == 0 or idx == total):
                manual_search_state.update({
                    "progress": (idx / total) if total else 1.0,
                    "processed": idx,
                    "status_text": f"Comparando {idx} de {total} faces...",
                })

        conn.commit()
    results.sort(key=lambda r: r["score"], reverse=True)
    return {
        "query_faces": [{"index": f["index"], "box": f["box"]} for f in query_faces],
        "selected_face": {"index": selected_face["index"], "box": selected_face["box"]},
        "results": results[:limit],
        "processed": processed,
        "cancelled": False,
    }


def start_manual_search(req: ManualSearchReq):
    manual_search_state = _value("manual_search_state")
    if manual_search_state.get("is_running"):
        raise HTTPException(status_code=400, detail="Busca manual em andamento.")
    manual_search_state.update({
        "is_running": True,
        "progress": 0.0,
        "processed": 0,
        "total": 0,
        "status_text": "Preparando busca facial...",
        "result": None,
        "error": "",
        "cancel_requested": False,
    })

    def worker():
        try:
            result = run_manual_search(req, update_state=True)
            manual_search_state.update({
                "is_running": False,
                "progress": 1.0,
                "status_text": "Busca cancelada." if result.get("cancelled") else "Busca concluída.",
                "result": result,
                "error": "",
                "cancel_requested": False,
            })
        except Exception as e:
            manual_search_state.update({
                "is_running": False,
                "status_text": "Erro na busca manual.",
                "error": str(e),
                "result": None,
                "cancel_requested": False,
            })

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "started"}


def get_manual_search_status():
    return _value("manual_search_state")


def cancel_manual_search():
    manual_search_state = _value("manual_search_state")
    if not manual_search_state.get("is_running"):
        return {"status": "idle"}
    manual_search_state.update({"cancel_requested": True, "status_text": "Cancelando busca..."})
    return {"status": "cancel_requested"}


def get_suggestions(aluno_id: str):
    get_db = _get("get_db")
    ref_ids = _value("ref_ids", [])
    faiss_index = _value("faiss_index")
    ensure_face_engine = _get("ensure_face_engine")
    se = _get("scanner_engine")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT foto_path, x1, y1, x2, y2 FROM ocorrencias WHERE aluno_id = ? LIMIT 3", (aluno_id,))
        rows = cur.fetchall()
        if not rows:
            return {"suggestions": []}
        ensure_face_engine()

        best_suggestions = {}
        best_suggestion_meta = {}
        imread_unicode = _get("imread_unicode")
        quiet_external_output = _get("quiet_external_output")

        def register_suggestion(candidate_id, score, path, box):
            if not candidate_id or not path:
                return
            if candidate_id not in best_suggestions or score > best_suggestions[candidate_id]:
                best_suggestions[candidate_id] = score
                best_suggestion_meta[candidate_id] = {
                    "path": path,
                    "box": box,
                }

        for r in rows:
            img = imread_unicode(r["foto_path"])
            if img is None:
                continue
            with quiet_external_output():
                faces = se.get_app_face().get(img) or []
            for face in faces:
                if not hasattr(face, "embedding") or face.embedding is None:
                    continue
                emb = face.embedding.astype("float32")
                norm = np.linalg.norm(emb)
                if norm == 0:
                    continue
                emb = emb / norm
                emb_reshaped = emb.reshape(1, -1)
                if ref_ids and faiss_index is not None and _value("faiss_available"):
                    D, I = faiss_index.search(emb_reshaped, 3)
                    for score, idx in zip(D[0], I[0]):
                        idx = int(idx)
                        score = float(score)
                        if idx < 0 or idx >= len(ref_ids):
                            continue
                        candidate_id = ref_ids[idx]
                        cur.execute(
                            "SELECT foto_path, x1, y1, x2, y2 FROM ocorrencias WHERE aluno_id = ? LIMIT 1",
                            (candidate_id,),
                        )
                        ref_row = cur.fetchone()
                        if ref_row:
                            register_suggestion(
                                candidate_id,
                                score,
                                ref_row["foto_path"],
                                [ref_row["x1"], ref_row["y1"], ref_row["x2"], ref_row["y2"]],
                            )
                else:
                    cur.execute("""
                        SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2
                        FROM ocorrencias
                        WHERE x1 IS NOT NULL
                          AND aluno_id NOT LIKE 'Pessoa %'
                          AND aluno_id != 'Desconhecido'
                    """)
                    candidate_rows = cur.fetchall()
                    for occ in candidate_rows:
                        cand_emb = get_cached_occurrence_embedding(conn, occ)
                        if cand_emb is None:
                            continue
                        score = float(np.dot(emb, cand_emb))
                        if score <= 0:
                            continue
                        register_suggestion(
                            occ["aluno_id"],
                            score,
                            occ["foto_path"],
                            [occ["x1"], occ["y1"], occ["x2"], occ["y2"]],
                        )

        sorted_sugs = sorted(
            [
                {
                    "id": k,
                    "score": v,
                    "path": best_suggestion_meta.get(k, {}).get("path"),
                    "box": best_suggestion_meta.get(k, {}).get("box"),
                }
                for k, v in best_suggestions.items()
            ],
            key=lambda x: x["score"],
            reverse=True,
        )[:3]
        conn.commit()
        return {"suggestions": sorted_sugs}


def rename_person(req: RenameReq):
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    current_catalog = _value("get_current_catalog")
    backup_catalog_db(current_catalog, "antes_renomear")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = ?", (req.old_id,))
        old_row = cur.fetchone()
        old_ref_path = str(old_row["face_cache_path"]) if old_row and old_row["face_cache_path"] else ""
        _ensure_aluno_row(cur, req.new_id)
        cur.execute("UPDATE ocorrencias SET aluno_id = ? WHERE aluno_id = ?", (req.new_id, req.old_id))
        cur.execute("DELETE FROM alunos WHERE aluno_id = ?", (req.old_id,))
        conn.commit()
        if old_ref_path and os.path.exists(old_ref_path):
            try:
                os.remove(old_ref_path)
            except Exception:
                pass
        _ensure_person_reference(conn, current_catalog, req.new_id)
    return {"status": "ok"}


def delete_person(req: DeletePersonReq):
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    current_catalog = _value("get_current_catalog")
    try:
        backup_catalog_db(current_catalog, "antes_excluir_pessoa")
    except Exception as e:
        print(f"Aviso: backup falhou antes de excluir pessoa: {e}")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM ocorrencias WHERE aluno_id = ?", (req.aluno_id,))
        _remove_person_reference(conn, current_catalog, req.aluno_id)
        cur.execute("DELETE FROM alunos WHERE aluno_id = ?", (req.aluno_id,))
        conn.commit()
    return {"status": "ok"}


def delete_photo(req: DeletePhotoReq):
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    current_catalog = _value("get_current_catalog")
    backup_catalog_db(current_catalog, "antes_excluir_foto")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM ocorrencias WHERE aluno_id = ? AND foto_path = ?", (req.aluno_id, req.foto_path))
        conn.commit()
    return {"status": "ok"}


def rename_photo(req: RenamePhotoReq):
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    current_catalog = _value("get_current_catalog")

    old_path = os.path.abspath((req.old_path or "").strip())
    if not old_path or not os.path.isfile(old_path):
        raise HTTPException(status_code=404, detail="Arquivo original nao encontrado")

    raw_new_name = os.path.basename((req.new_name or "").strip())
    if not raw_new_name:
        raise HTTPException(status_code=400, detail="Novo nome invalido")

    folder = os.path.dirname(old_path)
    stem, ext = os.path.splitext(raw_new_name)
    if not ext:
        _, original_ext = os.path.splitext(old_path)
        raw_new_name = f"{stem}{original_ext}"

    new_path = os.path.abspath(os.path.join(folder, raw_new_name))
    if os.path.normcase(new_path) == os.path.normcase(old_path):
        return {"status": "ok", "old_path": old_path, "new_path": new_path}

    if os.path.exists(new_path):
        raise HTTPException(status_code=409, detail="Ja existe um arquivo com esse nome")

    backup_catalog_db(current_catalog, "antes_renomear_foto")
    os.rename(old_path, new_path)

    with get_db() as conn:
        cur = conn.cursor()
        for table in ("ocorrencias", "discarded_photos", "face_embeddings"):
            cur.execute(
                f"UPDATE {table} SET foto_path = ? WHERE foto_path COLLATE NOCASE = ?",
                (new_path, old_path),
            )
        conn.commit()

    return {"status": "ok", "old_path": old_path, "new_path": new_path}


def get_quality_settings():
    return _get("load_quality_settings")()


def update_quality_settings(req: QualitySettingsReq):
    qa_clear_memory_caches = _get("qa_clear_memory_caches")
    save_quality_settings = _get("save_quality_settings")
    qa_clear_memory_caches()
    return save_quality_settings(req.dict())


def clear_cache():
    thumb_cache_dir = _get("thumb_cache_dir")
    qa_clear_memory_caches = _get("qa_clear_memory_caches")
    clear_embedding_cache = _get("clear_embedding_cache")
    qa_clear_disk_caches = _get("qa_clear_disk_caches")
    removed = 0
    for name in os.listdir(thumb_cache_dir):
        path = os.path.join(thumb_cache_dir, name)
        try:
            if os.path.isfile(path):
                os.remove(path)
                removed += 1
        except Exception:
            pass
    qa_clear_memory_caches()
    clear_embedding_cache()
    qa_clear_disk_caches()
    return {"status": "ok", "removed": removed}


def get_student_match_preview(catalog: str, cluster_id: str, student_id: str):
    import traceback
    _t0 = time.perf_counter()

    target_id = str(student_id).strip()
    cache_key = f"match_preview:{catalog}:{cluster_id}:{target_id}"
    centroid_key = f"centroid:{catalog}:{cluster_id}"
    embed_key = f"student_embeds:{catalog}:{target_id}"

    # Layer 1: final result cache (TTL 10s)
    global _match_preview_cache
    cached = _match_preview_cache.get(cache_key)
    if cached and (time.time() - cached[1]) < _MATCH_PREVIEW_TTL:
        logger.info("[match-preview] cache=hit cluster=%s student=%s total=%.0fms", cluster_id, target_id, (time.perf_counter() - _t0) * 1000)
        return cached[0]

    try:
        get_db = _get("get_db")
        cat = catalog or _current_catalog()
        if not cat:
            raise HTTPException(status_code=400, detail="Catalogo obrigatorio")

        cluster_centroid = None
        student_faces = None
        st_embs_norm = None
        st_valid = None

        # Layer 2: cluster centroid cache (TTL 30s)
        global _cluster_centroid_cache, _student_embed_cache
        centroid_entry = _cluster_centroid_cache.get(centroid_key)
        if centroid_entry and (time.time() - centroid_entry[1]) < _CENTROID_CACHE_TTL:
            cluster_centroid = centroid_entry[0]

        # Layer 3: student embeddings cache (TTL 30s)
        embed_entry = _student_embed_cache.get(embed_key)
        if embed_entry and (time.time() - embed_entry[1]) < _STUDENT_EMBED_CACHE_TTL:
            student_faces, st_embs_norm, st_valid = embed_entry[0], embed_entry[1], embed_entry[2]

        with get_db(cat) as conn:
            cur = conn.cursor()
            _sql_cluster_t = _sql_student_t = _deserialize_cluster_t = _centroid_t = _deserialize_student_t = 0.0
            _stack_t = _similarity_t = _ref_path_t = 0.0

            # ── STEP 1: Cluster embeddings ──
            if cluster_centroid is None:
                _sql_cluster_t = time.perf_counter()
                cur.execute("""
                    SELECT o.rowid, fe.embedding
                    FROM unknown_face_clusters u
                    JOIN ocorrencias o ON o.rowid = u.face_id
                    JOIN face_embeddings fe ON fe.occurrence_rowid = o.rowid
                    WHERE u.cluster_id = ?
                    LIMIT 100
                """, (cluster_id,))
                cluster_rows = cur.fetchall()

                if not cluster_rows:
                    cur.execute("""
                        SELECT rowid, embedding FROM face_embeddings
                        WHERE occurrence_rowid IN (SELECT rowid FROM ocorrencias WHERE aluno_id = ?)
                        LIMIT 100
                    """, (cluster_id,))
                    cluster_rows = cur.fetchall()
                _sql_cluster_ms = (time.perf_counter() - _sql_cluster_t) * 1000

                if not cluster_rows:
                    return {"reference_missing": True, "message": "Nenhuma face/embedding encontrada no cluster"}

                _deserialize_cluster_t = time.perf_counter()
                cluster_embs_norm = []
                for r in cluster_rows:
                    if not r["embedding"]: continue
                    emb = np.frombuffer(r["embedding"], dtype="float32")
                    n = np.linalg.norm(emb)
                    if n > 0:
                        cluster_embs_norm.append(emb / n)
                _deserialize_cluster_ms = (time.perf_counter() - _deserialize_cluster_t) * 1000

                if not cluster_embs_norm:
                    return {"reference_missing": True, "message": "Nenhum embedding valido no cluster"}

                _centroid_t = time.perf_counter()
                cluster_centroid = np.mean(cluster_embs_norm, axis=0)
                cn = np.linalg.norm(cluster_centroid)
                if cn > 0:
                    cluster_centroid = cluster_centroid / cn
                _centroid_ms = (time.perf_counter() - _centroid_t) * 1000

                _cluster_centroid_cache[centroid_key] = (cluster_centroid, time.time())
            else:
                _sql_cluster_ms = _deserialize_cluster_ms = _centroid_ms = 0.0

            # ── STEP 2: Student faces ──
            if student_faces is None:
                _sql_student_t = time.perf_counter()
                cur.execute("""
                    SELECT o.rowid, o.foto_path, o.x1, o.y1, o.x2, o.y2, o.aluno_id, fe.embedding
                    FROM ocorrencias o
                    JOIN face_embeddings fe ON fe.occurrence_rowid = o.rowid
                    WHERE o.aluno_id = ?
                    LIMIT 50
                """, (target_id,))
                student_faces = cur.fetchall()

                if not student_faces:
                    cur.execute("""
                        SELECT o.rowid, o.foto_path, o.x1, o.y1, o.x2, o.y2, o.aluno_id, fe.embedding
                        FROM ocorrencias o
                        JOIN face_embeddings fe ON fe.occurrence_rowid = o.rowid
                        WHERE o.aluno_id = (SELECT aluno_id FROM alunos WHERE nome = ? OR aluno_id = ? LIMIT 1)
                        LIMIT 50
                    """, (target_id, target_id))
                    student_faces = cur.fetchall()
                _sql_student_ms = (time.perf_counter() - _sql_student_t) * 1000

                if not student_faces:
                    return {"reference_missing": True, "message": f"Nenhuma face encontrada para {target_id}"}

                _deserialize_student_t = time.perf_counter()
                st_embs_norm = []
                st_valid = []
                for i, f in enumerate(student_faces):
                    if not f["embedding"]: continue
                    emb = np.frombuffer(f["embedding"], dtype="float32")
                    n = np.linalg.norm(emb)
                    if n > 0:
                        st_embs_norm.append(emb / n)
                        st_valid.append(i)
                _deserialize_student_ms = (time.perf_counter() - _deserialize_student_t) * 1000

                if not st_embs_norm:
                    return {"reference_missing": True, "message": f"Nenhuma face valida para {target_id}"}

                _student_embed_cache[embed_key] = (student_faces, st_embs_norm, st_valid, time.time())
            else:
                _sql_student_ms = _deserialize_student_ms = 0.0

            # ── STEP 3: Vectorized similarity ──
            _stack_t = time.perf_counter()
            st_matrix = np.stack(st_embs_norm)
            _stack_ms = (time.perf_counter() - _stack_t) * 1000

            _similarity_t = time.perf_counter()
            sims = st_matrix @ cluster_centroid
            best_idx = int(np.argmax(sims))
            best_sim = float(sims[best_idx])
            best_face = student_faces[st_valid[best_idx]]
            _similarity_ms = (time.perf_counter() - _similarity_t) * 1000

            if np.isnan(best_sim) or np.isinf(best_sim):
                best_sim = 0.0

            # ── STEP 4: Reference path ──
            _ref_t = time.perf_counter()
            student_id_real = best_face["aluno_id"]
            ref_path = ""
            try:
                ref_path = get_face_cache_path_cached(cat, student_id_real) or ""
                if ref_path: ref_path = str(ref_path)
            except Exception:
                pass
            if not ref_path or not os.path.exists(ref_path):
                try:
                    ref_path = _ensure_person_reference(conn, cat, student_id_real) or ""
                except Exception:
                    pass
            _ref_path_ms = (time.perf_counter() - _ref_t) * 1000

            result = {
                "matched_student_rowid": int(best_face["rowid"]),
                "matched_student_photo_path": best_face["foto_path"],
                "matched_student_face_box": [best_face["x1"], best_face["y1"], best_face["x2"], best_face["y2"]],
                "matched_similarity": round(best_sim, 4),
                "matched_student_id": student_id_real,
                "matched_student_name": student_id_real,
                "matched_student_folder": student_id_real,
                "matched_student_label": student_id_real,
                "reference_path": ref_path if ref_path and os.path.exists(ref_path) else None,
            }

            _match_preview_cache[cache_key] = (result, time.time())

        _total_ms = (time.perf_counter() - _t0) * 1000
        logger.info(
            "[match-preview] cache=miss cluster=%s student=%s"
            " sql_cluster=%.0fms sql_student=%.0fms deserialize_cluster=%.0fms centroid=%.0fms"
            " deserialize_student=%.0fms stack=%.0fms similarity=%.0fms ref_path=%.0fms total=%.0fms",
            cluster_id, target_id,
            _sql_cluster_ms, _sql_student_ms, _deserialize_cluster_ms, _centroid_ms,
            _deserialize_student_ms, _stack_ms, _similarity_ms, _ref_path_ms, _total_ms,
        )
        return result

    except Exception as e:
        traceback.print_exc()
        logger.error("[match-preview] ERROR cluster=%s student=%s: %s", cluster_id, target_id, e)
        return {"error": str(e), "reference_missing": True, "message": f"Erro: {str(e)}"}


def generate_all_embeddings(catalog: str = ""):
    """Remove duplicatas do scan e gera embeddings para todas as ocorrencias."""
    get_db = _get("get_db")
    cat = catalog or _current_catalog()
    stats = {"deleted_pessoa": 0, "deleted_sem_rostos": 0, "embeddings_gerados": 0, "erros": 0}

    with get_db(cat) as conn:
        cur = conn.cursor()

        # 1. Deletar linhas "Pessoa N" que sao duplicatas de fotos que ja tem identificacao
        cur.execute("""
            DELETE FROM ocorrencias
            WHERE rowid IN (
                SELECT p.rowid FROM ocorrencias p
                WHERE p.aluno_id LIKE 'Pessoa%'
                AND EXISTS (
                    SELECT 1 FROM ocorrencias o
                    WHERE o.foto_path = p.foto_path
                    AND o.x1 = p.x1 AND o.y1 = p.y1
                    AND o.x2 = p.x2 AND o.y2 = p.y2
                    AND o.aluno_id NOT LIKE 'Pessoa%'
                    AND o.aluno_id != 'Sem Rostos'
                )
            )
        """)
        stats["deleted_pessoa"] = cur.rowcount

        # 2. Deletar "Sem Rostos"
        cur.execute("DELETE FROM ocorrencias WHERE aluno_id = 'Sem Rostos'")
        stats["deleted_sem_rostos"] = cur.rowcount

        # 3. Carregar todas as ocorrencias que precisam de embedding
        cur.execute("""
            SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2
            FROM ocorrencias
            WHERE x1 IS NOT NULL
            ORDER BY rowid
        """)
        todas = cur.fetchall()

        for occ in todas:
            try:
                emb = get_cached_occurrence_embedding(conn, occ)
                if emb is not None:
                    stats["embeddings_gerados"] += 1
                else:
                    stats["erros"] += 1
            except Exception:
                stats["erros"] += 1

        conn.commit()
        _invalidate_review_cache(cat)

    print(f"[EMBEDDINGS] {stats}")
    return stats
