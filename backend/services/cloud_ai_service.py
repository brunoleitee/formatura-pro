import os
import shutil
import sqlite3
import json
import uuid
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
import contextlib
import io
import cv2
import numpy as np

from fastapi import HTTPException

# Configure standard logger
logger = logging.getLogger("cloud_ai_service")


@contextlib.contextmanager
def _suppress_stdout():
    import sys
    from io import StringIO
    old = sys.stdout
    sys.stdout = StringIO()
    try:
        yield
    finally:
        sys.stdout = old


def _cloud_ai_paths_from_catalog_root(root_dir: Path) -> Dict[str, Path]:
    catalog_dir = root_dir / "Catalogo"
    embeddings_dir = root_dir / "Embeddings"
    cache_dir = root_dir / "Cache"
    faces_dir = cache_dir / "faces"
    previews_dir = cache_dir / "previews"
    vectors_dir = embeddings_dir / "vectors"
    faces_db = embeddings_dir / "faces.db"
    clusters_json = embeddings_dir / "clusters.json"
    review_state_db = catalog_dir / "review_state.db"
    return {
        "root_dir": root_dir,
        "catalog_dir": catalog_dir,
        "cache_dir": cache_dir,
        "faces_dir": faces_dir,
        "previews_dir": previews_dir,
        "embeddings_dir": embeddings_dir,
        "vectors_dir": vectors_dir,
        "faces_db": faces_db,
        "clusters_json": clusters_json,
        "review_state_db": review_state_db,
    }


def _ensure_cloud_ai_layout(paths: Dict[str, Path]) -> None:
    for key in ("faces_dir", "previews_dir", "vectors_dir"):
        paths[key].mkdir(parents=True, exist_ok=True)
    paths["faces_db"].touch(exist_ok=True)
    paths["review_state_db"].touch(exist_ok=True)
    if not paths["clusters_json"].exists():
        try:
            with paths["clusters_json"].open("w", encoding="utf-8") as f:
                json.dump({"clusters": []}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass


def _ensure_cloud_ai_schema(paths: Dict[str, Path]) -> None:
    _ensure_cloud_ai_layout(paths)
    conn = sqlite3.connect(str(paths["faces_db"]))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS faces (
                id TEXT PRIMARY KEY,
                photo_id TEXT,
                cloud_file_id TEXT,
                local_cache_path TEXT,
                bbox_json TEXT,
                embedding_path TEXT,
                person_id TEXT,
                confidence REAL,
                status TEXT,
                created_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS people (
                id TEXT PRIMARY KEY,
                name TEXT,
                reference_count INTEGER,
                created_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reference_faces (
                id TEXT PRIMARY KEY,
                person_id TEXT,
                cloud_file_id TEXT,
                bbox_json TEXT,
                embedding_path TEXT,
                quality_score REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS clusters (
                id TEXT PRIMARY KEY,
                person_id TEXT,
                confidence_avg REAL,
                total_faces INTEGER,
                status TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ai_catalog_state (
                catalog_id TEXT PRIMARY KEY,
                last_processed_at TEXT,
                last_batch_size INTEGER,
                last_error TEXT,
                updated_at TEXT
            )
        """)
        conn.commit()
    finally:
        conn.close()


def _ensure_cloud_review_schema(paths: Dict[str, Path]) -> None:
    _ensure_cloud_ai_layout(paths)
    conn = sqlite3.connect(str(paths["review_state_db"]))
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS review_items (
                id TEXT PRIMARY KEY,
                face_id TEXT,
                suggested_person_id TEXT,
                confidence REAL,
                status TEXT,
                decision TEXT,
                updated_at TEXT
            )
        """)
        conn.commit()
    finally:
        conn.close()


def _cloud_ai_paths_for_catalog(catalog_row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Path]:
    root_dir = Path(str(catalog_row["catalog_path"] if isinstance(catalog_row, sqlite3.Row) else catalog_row.get("catalog_path") or catalog_row.get("catalogPath") or "")).expanduser()
    if not root_dir.is_absolute():
        root_dir = Path(os.path.abspath(str(root_dir)))
    paths = _cloud_ai_paths_from_catalog_root(root_dir)
    _ensure_cloud_ai_schema(paths)
    _ensure_cloud_review_schema(paths)
    return paths


def _cloud_ai_connect_paths(catalog_row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Path]:
    if isinstance(catalog_row, sqlite3.Row):
        catalog_path = catalog_row["catalog_path"] or catalog_row["catalogPath"] if "catalogPath" in catalog_row.keys() else catalog_row["catalog_path"]
    else:
        catalog_path = catalog_row.get("catalog_path") or catalog_row.get("catalogPath")
    root_dir = Path(str(catalog_path or "")).expanduser()
    if not root_dir.is_absolute():
        root_dir = Path(os.path.abspath(str(root_dir)))
    return _cloud_ai_paths_from_catalog_root(root_dir)


def _cloud_ai_root_from_catalog_row(catalog_row: sqlite3.Row | Dict[str, Any]) -> Path:
    if isinstance(catalog_row, sqlite3.Row):
        catalog_path = catalog_row["catalog_path"]
    else:
        catalog_path = catalog_row.get("catalog_path") or catalog_row.get("catalogPath")
    root_dir = Path(str(catalog_path or "")).expanduser()
    if not root_dir.is_absolute():
        root_dir = Path(os.path.abspath(str(root_dir)))
    return root_dir


def _cloud_ai_copy_preview(paths: Dict[str, Path], cloud_file_id: str, source_path: str) -> str:
    preview_path = paths["previews_dir"] / f"{cloud_file_id}.jpg"
    if preview_path.exists():
        return str(preview_path)
    if source_path and os.path.exists(source_path):
        try:
            shutil.copy2(source_path, preview_path)
            return str(preview_path)
        except Exception:
            return str(source_path)
    return ""


def _cloud_ai_vector_path(paths: Dict[str, Path], face_id: str) -> Path:
    return paths["vectors_dir"] / f"{face_id}.npy"


def _cloud_ai_face_crop(paths: Dict[str, Path], face_id: str, image: np.ndarray, bbox: List[int]) -> str:
    crop_path = paths["faces_dir"] / f"{face_id}.jpg"
    try:
        x1, y1, x2, y2 = [max(0, int(v)) for v in bbox[:4]]
        h, w = image.shape[:2]
        x1 = min(x1, max(0, w - 1))
        x2 = min(max(x2, x1 + 1), w)
        y1 = min(y1, max(0, h - 1))
        y2 = min(max(y2, y1 + 1), h)
        crop = image[y1:y2, x1:x2]
        if crop.size > 0:
            cv2.imwrite(str(crop_path), crop)
            return str(crop_path)
    except Exception:
        pass
    return ""


def _cloud_ai_load_vector(vector_path: str) -> Optional[np.ndarray]:
    if not vector_path or not os.path.exists(vector_path):
        return None
    try:
        emb = np.load(vector_path)
        if emb is None:
            return None
        arr = np.asarray(emb, dtype="float32").reshape(-1)
        norm = float(np.linalg.norm(arr))
        if norm <= 0:
            return None
        return arr / norm
    except Exception:
        return None


def _cloud_ai_refresh_clusters_json(paths: Dict[str, Path]) -> None:
    conn = sqlite3.connect(str(paths["faces_db"]))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, person_id, confidence_avg, total_faces, status FROM clusters ORDER BY total_faces DESC, confidence_avg DESC"
        ).fetchall()
        payload = {
            "updatedAt": datetime.now().isoformat(),
            "clusters": [dict(row) for row in rows],
        }
        with paths["clusters_json"].open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    finally:
        conn.close()


def _cloud_ai_get_catalog_row(catalog_id: str) -> sqlite3.Row:
    from backend import _cloud_events_db_path, _ensure_cloud_events_table
    conn = sqlite3.connect(str(_cloud_events_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cloud_events_table(conn)
        row = conn.execute("SELECT * FROM cloud_events WHERE id = ?", (catalog_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Catálogo cloud não encontrado")
        return row
    finally:
        conn.close()


def _cloud_ai_resolve_source_path(cloud_file_id: str) -> str:
    try:
        from cloud.drive_cache import cache
        for candidate in (
            cache.get_preview_path(cloud_file_id),
            cache.get_thumb_path(cloud_file_id),
            cache.get_original_path(cloud_file_id),
        ):
            if candidate and os.path.exists(candidate):
                return candidate
    except Exception:
        pass
    return ""


def _cloud_ai_list_drive_files_recursive(folder_id: str, max_depth: int = 8) -> List[Dict[str, Any]]:
    try:
        from cloud.drive_manager import drive_manager
    except Exception:
        return []

    files: List[Dict[str, Any]] = []
    visited: set[str] = set()

    def walk(current_id: str, depth: int) -> None:
        if not current_id or current_id in visited or depth > max_depth:
            return
        visited.add(current_id)
        try:
            for item in drive_manager.list_folder_items(current_id):
                if item.get("isFolder"):
                    walk(str(item.get("id", "")), depth + 1)
                    continue
                files.append({
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "parent": item.get("parentId"),
                    "modifiedTime": item.get("modifiedTime"),
                    "mimeType": item.get("mimeType"),
                    "thumbnailUrl": item.get("thumbnailUrl"),
                    "webContentLink": item.get("webContentLink"),
                    "size": item.get("size"),
                })
        except Exception:
            pass

    walk(folder_id, 0)
    return files


def _cloud_ai_schema_paths_for_catalog(catalog_id: str) -> Tuple[sqlite3.Row, Dict[str, Path]]:
    catalog_row = _cloud_ai_get_catalog_row(catalog_id)
    paths = _cloud_ai_paths_for_catalog(catalog_row)
    return catalog_row, paths


def _cloud_ai_get_status_payload(catalog_id: str) -> Dict[str, Any]:
    catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    try:
        faces_count = faces_conn.execute("SELECT COUNT(*) AS cnt FROM faces").fetchone()["cnt"]
        embeddings_count = faces_conn.execute("SELECT COUNT(*) AS cnt FROM faces WHERE embedding_path IS NOT NULL AND embedding_path != ''").fetchone()["cnt"]
        clusters_count = faces_conn.execute("SELECT COUNT(*) AS cnt FROM clusters").fetchone()["cnt"]
        review_pending_count = review_conn.execute(
            "SELECT COUNT(*) AS cnt FROM review_items WHERE status = 'pending'"
        ).fetchone()["cnt"]
        last_processed_row = faces_conn.execute(
            "SELECT last_processed_at, last_batch_size, last_error FROM ai_catalog_state WHERE catalog_id = ?",
            (catalog_id,),
        ).fetchone()
        last_processed_at = last_processed_row["last_processed_at"] if last_processed_row else None
        last_error = last_processed_row["last_error"] if last_processed_row else None
        return {
            "success": True,
            "catalogId": catalog_id,
            "catalogPath": str(paths["root_dir"]),
            "cachePath": str(paths["cache_dir"]),
            "facesCount": int(faces_count or 0),
            "embeddingsCount": int(embeddings_count or 0),
            "clustersCount": int(clusters_count or 0),
            "reviewPendingCount": int(review_pending_count or 0),
            "lastProcessedAt": last_processed_at,
            "status": "processing" if last_error and not last_processed_at else ("ready" if faces_count or embeddings_count else "idle"),
            "message": last_error or "IA do catálogo pronta",
        }
    finally:
        faces_conn.close()
        review_conn.close()


def _cloud_ai_list_review_items(catalog_id: str) -> Dict[str, Any]:
    _catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    try:
        rows = review_conn.execute("""
            SELECT r.id, r.face_id, r.suggested_person_id, r.confidence, r.status, r.decision, r.updated_at,
                   f.cloud_file_id, f.local_cache_path, f.bbox_json, f.embedding_path, f.person_id, f.status AS face_status
            FROM review_items r
            LEFT JOIN faces f ON f.id = r.face_id
            ORDER BY r.updated_at DESC
        """).fetchall()
        items = []
        for row in rows:
            items.append({
                "id": row["id"],
                "faceId": row["face_id"],
                "suggestedPersonId": row["suggested_person_id"],
                "confidence": row["confidence"],
                "status": row["status"],
                "decision": row["decision"],
                "updatedAt": row["updated_at"],
                "cloudFileId": row["cloud_file_id"],
                "localCachePath": row["local_cache_path"],
                "bbox": json.loads(row["bbox_json"] or "[]") if row["bbox_json"] else [],
                "embeddingPath": row["embedding_path"],
                "personId": row["person_id"],
                "faceStatus": row["face_status"],
            })
        return {"success": True, "catalogId": catalog_id, "items": items}
    finally:
        faces_conn.close()
        review_conn.close()


def _cloud_ai_find_best_person(
    faces_conn: sqlite3.Connection,
    current_face_id: str,
    embedding: np.ndarray,
    threshold: float = 0.78,
) -> Tuple[Optional[str], Optional[str], float]:
    rows = faces_conn.execute("""
        SELECT id, person_id, embedding_path
        FROM faces
        WHERE id != ? AND embedding_path IS NOT NULL AND embedding_path != ''
    """, (current_face_id,)).fetchall()
    best_person_id = None
    best_cluster_id = None
    best_sim = 0.0
    for row in rows:
        other = _cloud_ai_load_vector(row["embedding_path"])
        if other is None:
            continue
        sim = float(np.dot(embedding, other))
        if sim > best_sim:
            best_sim = sim
            best_person_id = row["person_id"] or None
            best_cluster_id = row["person_id"] or None
    if best_sim >= threshold and best_person_id:
        return best_person_id, best_cluster_id, best_sim
    return None, None, best_sim


def _cloud_ai_upsert_cluster(
    conn: sqlite3.Connection,
    person_id: str,
    confidence: float,
    created: bool = False,
) -> None:
    row = conn.execute("SELECT confidence_avg, total_faces FROM clusters WHERE person_id = ?", (person_id,)).fetchone()
    if row:
        total_faces = int(row["total_faces"] or 0) + 1
        prev_avg = float(row["confidence_avg"] or 0.0)
        next_avg = ((prev_avg * (total_faces - 1)) + confidence) / max(total_faces, 1)
        conn.execute(
            "UPDATE clusters SET confidence_avg = ?, total_faces = ?, status = ? WHERE person_id = ?",
            (round(next_avg, 4), total_faces, "active", person_id),
        )
    else:
        conn.execute(
            "INSERT OR REPLACE INTO clusters (id, person_id, confidence_avg, total_faces, status) VALUES (?, ?, ?, ?, ?)",
            (f"cluster_{person_id}", person_id, round(confidence, 4), 1, "active" if created else "pending"),
        )


def _cloud_ai_upsert_person(conn: sqlite3.Connection, person_id: str, name: str = "") -> None:
    row = conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO people (id, name, reference_count, created_at) VALUES (?, ?, ?, ?)",
            (person_id, name or "Pessoa sem nome", 0, datetime.now().isoformat()),
        )


def _cloud_ai_record_reference(
    conn: sqlite3.Connection,
    face_id: str,
    person_id: str,
    cloud_file_id: str,
    bbox_json: str,
    embedding_path: str,
    quality_score: float
) -> None:
    exists = conn.execute(
        "SELECT id FROM reference_faces WHERE id = ? OR (cloud_file_id = ? AND person_id = ?)",
        (face_id, cloud_file_id, person_id)
    ).fetchone()
    if exists:
        return
    conn.execute(
        "INSERT OR REPLACE INTO reference_faces (id, person_id, cloud_file_id, bbox_json, embedding_path, quality_score) VALUES (?, ?, ?, ?, ?, ?)",
        (face_id, person_id, cloud_file_id, bbox_json, embedding_path, quality_score),
    )
    conn.execute("UPDATE people SET reference_count = COALESCE(reference_count, 0) + 1 WHERE id = ?", (person_id,))


def _cloud_ai_process_catalog_impl(
    catalog_id: str,
    limit: int = 12,
    force: bool = False,
    recursive: bool = True
) -> Dict[str, Any]:
    catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    _ensure_cloud_ai_layout(paths)
    _ensure_cloud_ai_schema(paths)
    _ensure_cloud_review_schema(paths)

    source_folder_id = catalog_row["source_folder_id"] or ""
    if not source_folder_id:
        raise HTTPException(status_code=400, detail="Catálogo cloud sem pasta de origem")

    files = _cloud_ai_list_drive_files_recursive(source_folder_id) if recursive else []
    if not files:
        try:
            from cloud.drive_manager import drive_manager
            files = [
                {
                    "id": f.id,
                    "name": f.name,
                    "parent": f.parent,
                    "modifiedTime": f.modifiedTime,
                    "mimeType": f.mimeType,
                }
                for f in drive_manager.list_files(source_folder_id)
            ]
        except Exception:
            files = []

    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    processed = 0
    skipped = 0
    errors = 0
    last_error = ""
    now = datetime.now().isoformat()
    try:
        existing_file_ids = {
            row["cloud_file_id"]
            for row in faces_conn.execute(
                "SELECT DISTINCT cloud_file_id FROM faces WHERE cloud_file_id IS NOT NULL AND cloud_file_id != ''"
            ).fetchall()
        }
        candidates = [f for f in files if force or f["id"] not in existing_file_ids]
        candidates = candidates[: max(1, int(limit or 12))]

        from services.face_engine import ensure_face_engine, get_app_face, FACE_INFERENCE_LOCK
        ensure_face_engine()
        app_face = get_app_face()
        if app_face is None:
            raise HTTPException(status_code=503, detail="Motor de face indisponível")

        for file_info in candidates:
            cloud_file_id = file_info["id"]
            source_path = _cloud_ai_resolve_source_path(cloud_file_id)
            if not source_path:
                skipped += 1
                continue
            try:
                img = cv2.imread(source_path)
                if img is None:
                    skipped += 1
                    continue
                with FACE_INFERENCE_LOCK:
                    with _suppress_stdout():
                        faces = app_face.get(img) or []
                if not faces:
                    skipped += 1
                    continue
                preview_path = _cloud_ai_copy_preview(paths, cloud_file_id, source_path)
                for idx, face in enumerate(faces):
                    face_id = str(uuid.uuid4())
                    bbox = [int(face.bbox[0]), int(face.bbox[1]), int(face.bbox[2]), int(face.bbox[3])]
                    bbox_json = json.dumps(bbox, ensure_ascii=False)
                    crop_path = _cloud_ai_face_crop(paths, face_id, img, bbox)
                    if not crop_path:
                        crop_path = str(paths["faces_dir"] / f"{face_id}.jpg")
                    emb = np.asarray(face.embedding, dtype="float32").reshape(-1)
                    norm = float(np.linalg.norm(emb))
                    if norm <= 0:
                        skipped += 1
                        continue
                    emb = emb / norm
                    vector_path = _cloud_ai_vector_path(paths, face_id)
                    np.save(str(vector_path), emb.astype("float32"))
                    confidence = float(getattr(face, "det_score", 0.0) or 0.0)
                    person_id, cluster_match_id, similarity = _cloud_ai_find_best_person(faces_conn, face_id, emb)
                    if not person_id:
                        person_id = f"person_{uuid.uuid4().hex[:12]}"
                        _cloud_ai_upsert_person(faces_conn, person_id, name=f"Pessoa {processed + idx + 1}")
                        _cloud_ai_upsert_cluster(faces_conn, person_id, confidence, created=True)
                    else:
                        _cloud_ai_upsert_person(faces_conn, person_id, name=f"Pessoa {person_id[-6:]}")
                        _cloud_ai_upsert_cluster(faces_conn, person_id, confidence, created=False)
                    local_cache_path = crop_path
                    faces_conn.execute(
                        """
                        INSERT OR REPLACE INTO faces (
                            id, photo_id, cloud_file_id, local_cache_path, bbox_json, embedding_path,
                            person_id, confidence, status, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            face_id,
                            cloud_file_id,
                            cloud_file_id,
                            local_cache_path,
                            bbox_json,
                            str(vector_path),
                            person_id,
                            confidence,
                            "processed",
                            now,
                        ),
                    )
                    review_conf = similarity if similarity > 0 else confidence
                    review_status = "pending" if review_conf < 0.82 else "ready"
                    review_decision = None if review_status == "pending" else "auto_accept"
                    review_item_id = f"review_{face_id}"
                    review_conn.execute(
                        """
                        INSERT OR REPLACE INTO review_items (
                            id, face_id, suggested_person_id, confidence, status, decision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            review_item_id,
                            face_id,
                            person_id,
                            round(float(review_conf), 4),
                            review_status,
                            review_decision,
                            now,
                        ),
                    )
                    if review_status != "pending" or confidence >= 0.92:
                        _cloud_ai_record_reference(
                            faces_conn,
                            face_id,
                            person_id,
                            cloud_file_id,
                            bbox_json,
                            str(vector_path),
                            round(confidence, 4),
                        )
                    processed += 1
                faces_conn.commit()
                review_conn.commit()
            except Exception as file_exc:
                errors += 1
                last_error = str(file_exc)
        faces_conn.execute(
            """
            INSERT OR REPLACE INTO ai_catalog_state (
                catalog_id, last_processed_at, last_batch_size, last_error, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (catalog_id, now, processed, last_error, now),
        )
        faces_conn.commit()
        _cloud_ai_refresh_clusters_json(paths)
        return {
            "success": True,
            "catalogId": catalog_id,
            "processed": processed,
            "skipped": skipped,
            "errors": errors,
            "lastProcessedAt": now,
            "status": "ready" if processed > 0 else "idle",
            "message": "IA persistente processada no catálogo" if processed > 0 else "Nenhuma nova face encontrada no cache",
        }
    except HTTPException:
        raise
    except Exception as e:
        last_error = str(e)
        try:
            faces_conn.execute(
                """
                INSERT OR REPLACE INTO ai_catalog_state (
                    catalog_id, last_processed_at, last_batch_size, last_error, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (catalog_id, now, processed, last_error, now),
            )
            faces_conn.commit()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=last_error or str(e))
    finally:
        faces_conn.close()
        review_conn.close()


def _cloud_ai_set_review_decision(
    catalog_id: str,
    review_id: str,
    decision: str
) -> Dict[str, Any]:
    _catalog_row, paths = _cloud_ai_schema_paths_for_catalog(catalog_id)
    faces_conn = sqlite3.connect(str(paths["faces_db"]))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(paths["review_state_db"]))
    review_conn.row_factory = sqlite3.Row
    try:
        review = review_conn.execute("SELECT * FROM review_items WHERE id = ?", (review_id,)).fetchone()
        if not review:
            raise HTTPException(status_code=404, detail="Item de revisão não encontrado")
        now = datetime.now().isoformat()
        if decision == "confirm":
            review_conn.execute(
                "UPDATE review_items SET status = ?, decision = ?, updated_at = ? WHERE id = ?",
                ("resolved", "confirm", now, review_id),
            )
            face = faces_conn.execute("SELECT * FROM faces WHERE id = ?", (review["face_id"],)).fetchone()
            if face:
                person_id = review["suggested_person_id"] or face["person_id"]
                if person_id:
                    faces_conn.execute(
                        "UPDATE faces SET person_id = ?, status = ? WHERE id = ?",
                        (person_id, "confirmed", face["id"]),
                    )
                    _cloud_ai_upsert_person(faces_conn, person_id, name=f"Pessoa {person_id[-6:]}")
                    _cloud_ai_upsert_cluster(faces_conn, person_id, float(review["confidence"] or 0.0), created=False)
                    _cloud_ai_record_reference(
                        faces_conn,
                        face["id"],
                        person_id,
                        face["cloud_file_id"] or "",
                        face["bbox_json"] or "[]",
                        face["embedding_path"] or "",
                        float(review["confidence"] or 0.0),
                    )
        elif decision == "reject":
            review_conn.execute(
                "UPDATE review_items SET status = ?, decision = ?, updated_at = ? WHERE id = ?",
                ("rejected", "reject", now, review_id),
            )
            faces_conn.execute(
                "UPDATE faces SET status = ? WHERE id = ?",
                ("rejected", review["face_id"]),
            )
        else:
            raise HTTPException(status_code=400, detail="Decisão inválida")
        faces_conn.commit()
        review_conn.commit()
        _cloud_ai_refresh_clusters_json(paths)
        return {"success": True, "reviewId": review_id, "decision": decision}
    finally:
        faces_conn.close()
        review_conn.close()
