"""
Gerenciamento de revisão e manipulação de dados de alunos e ocorrências faciais.
"""

import os
import hashlib
import shutil
import threading
import time
import urllib.parse

import numpy as np
from fastapi import HTTPException, Query
from pydantic import BaseModel

# Cache para face_cache_path
face_cache_path_cache = {}
cache_lock = threading.Lock()

def get_face_cache_path_cached(catalog_name, aluno_id):
    """Obtém face_cache_path com cache para evitar queries repetidas."""
    from backend import get_db  # Import local para evitar circular
    cache_key = f"{catalog_name}:{aluno_id}"
    with cache_lock:
        if cache_key in face_cache_path_cache:
            return face_cache_path_cache[cache_key]
    
    with get_db(catalog_name) as conn:
        cur = conn.cursor()
        cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = ?", (aluno_id,))
        row = cur.fetchone()
        path = row["face_cache_path"] if row else None
    
    with cache_lock:
        face_cache_path_cache[cache_key] = path
    return path
from PIL import Image

_cfg = {}


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
        cur.execute("INSERT OR REPLACE INTO alunos (aluno_id, face_cache_path) VALUES (?, ?)", (aluno_id, dest))
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


class BulkManualIdentifyReq(BaseModel):
    catalog: str
    new_name: str
    rowids: list[int]


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
        cur.execute("INSERT OR IGNORE INTO alunos VALUES (?, ?)", (new_name, "n/a"))
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
            cur.execute("INSERT OR IGNORE INTO alunos VALUES (?, ?)", (new_name, "n/a"))
            cur.execute("UPDATE ocorrencias SET aluno_id = ? WHERE aluno_id = ?", (new_name, old_id))
            cur.execute("DELETE FROM alunos WHERE aluno_id = ?", (old_id,))
        elif old_id:
            update_single_face(cur, req.foto_path, x1, y1, x2, y2, new_name)
        else:
            cur.execute("INSERT OR IGNORE INTO alunos VALUES (?, ?)", (new_name, "n/a"))
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
    backup_catalog_db = _get("backup_catalog_db")
    get_db = _get("get_db")
    backup_catalog_db(req.catalog, "antes_identificar_lote")

    rowids = [int(r) for r in (req.rowids or []) if str(r).strip() != ""]
    if not rowids:
        raise HTTPException(status_code=400, detail="Nenhuma face informada.")

    new_name = (req.new_name or "").strip() or "Desconhecido"
    with get_db(req.catalog) as conn:
        cur = conn.cursor()
        cur.execute("INSERT OR IGNORE INTO alunos VALUES (?, ?)", (new_name, "n/a"))
        for i in range(0, len(rowids), 900):
            chunk = rowids[i:i + 900]
            placeholders = ",".join(["?"] * len(chunk))
            cur.execute(
                f"UPDATE ocorrencias SET aluno_id = ? WHERE rowid IN ({placeholders})",
                [new_name] + chunk,
            )
        conn.commit()
        if new_name and new_name != "Desconhecido":
            _ensure_person_reference(conn, req.catalog, new_name)

    return {"status": "ok", "updated": len(rowids), "new_name": new_name}


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
            SELECT rowid, aluno_id, foto_path, x1, y1, x2, y2
            FROM ocorrencias
            WHERE x1 IS NOT NULL
              AND (aluno_id = 'Desconhecido' OR aluno_id LIKE 'Pessoa %')
            ORDER BY foto_path ASC, rowid ASC
        """)
        rows = cur.fetchall()
        if not rows:
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
            })

        if len(items) < min_cluster_size:
            conn.commit()
            return {"clusters": []}

        embeddings = np.vstack([item["embedding"] for item in items]).astype("float32")
        norms = np.linalg.norm(embeddings, axis=1)
        valid = norms > 0
        if not np.all(valid):
            embeddings = embeddings[valid]
            items = [item for item, keep in zip(items, valid) if keep]

        if len(items) < min_cluster_size:
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

        clusters = []
        for comp_idxs in clusters_by_root.values():
            if len(comp_idxs) < min_cluster_size:
                continue
            comp_items = [items[i] for i in comp_idxs]
            comp_emb = embeddings[comp_idxs]
            centroid = comp_emb.mean(axis=0)
            centroid_norm = np.linalg.norm(centroid)
            if centroid_norm > 0:
                centroid = centroid / centroid_norm
            rep_scores = comp_emb @ centroid
            rep_local_idx = comp_idxs[int(np.argmax(rep_scores))]
            rep_item = items[rep_local_idx]
            unique_paths = sorted({item["foto_path"] for item in comp_items})
            cohesion_score = float(np.clip(np.mean(rep_scores), 0.0, 1.0)) if len(rep_scores) else 0.0
            clusters.append({
                "cluster_id": f"cluster_{len(clusters) + 1}",
                "face_count": len(comp_items),
                "photo_count": len(unique_paths),
                "cohesion_score": round(cohesion_score, 4),
                "representative": {
                    "rowid": rep_item["rowid"],
                    "path": rep_item["foto_path"],
                    "box": rep_item["box"],
                    "aluno_id": rep_item["aluno_id"],
                },
                "faces": [
                    {
                        "rowid": item["rowid"],
                        "path": item["foto_path"],
                        "box": item["box"],
                        "aluno_id": item["aluno_id"],
                    }
                    for item in comp_items
                ],
            })

        clusters.sort(key=lambda c: (c["cohesion_score"], c["face_count"], c["photo_count"]), reverse=True)
        conn.commit()
        return {"clusters": clusters[:limit], "threshold": threshold, "min_cluster_size": min_cluster_size}


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
        cur.execute("INSERT OR IGNORE INTO alunos (aluno_id, face_cache_path) VALUES (?, ?)", (target_name, "n/a"))
        
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
            return emb

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
        cur.execute("INSERT OR IGNORE INTO alunos VALUES (?, ?)", (req.new_id, "n/a"))
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
