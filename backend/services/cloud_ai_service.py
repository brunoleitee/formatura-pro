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
    from cloud.utils import _cloud_events_db_path, _ensure_cloud_events_table
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
        # Sync status to evento.fpdb for Formandos/Revisão visibility
        try:
            _cloud_ai_sync_to_catalog_fpdb(catalog_id, paths)
        except Exception:
            pass
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
    best_person_id = None
    best_cluster_id = None
    best_sim = 0.0
    # Search reference_faces first (higher priority)
    ref_rows = faces_conn.execute("""
        SELECT id, person_id, embedding_path
        FROM reference_faces
        WHERE embedding_path IS NOT NULL AND embedding_path != ''
    """).fetchall()
    for row in ref_rows:
        other = _cloud_ai_load_vector(row["embedding_path"])
        if other is None:
            continue
        sim = float(np.dot(embedding, other))
        if sim > best_sim:
            best_sim = sim
            best_person_id = row["person_id"]
            best_cluster_id = row["person_id"]
    if best_sim >= threshold and best_person_id:
        return best_person_id, best_cluster_id, best_sim
    # Fallback: search existing faces
    rows = faces_conn.execute("""
        SELECT id, person_id, embedding_path
        FROM faces
        WHERE id != ? AND embedding_path IS NOT NULL AND embedding_path != ''
    """, (current_face_id,)).fetchall()
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


def _cloud_ai_sync_to_catalog_fpdb(catalog_id: str, paths: Dict[str, Path]) -> Dict[str, Any]:
    fpdb_path = paths["root_dir"] / "Catalogo" / "evento.fpdb"
    faces_db_path = paths["faces_db"]
    review_db_path = paths["review_state_db"]
    if not faces_db_path.exists() or not fpdb_path.exists():
        return {"synced": 0}
    faces_conn = sqlite3.connect(str(faces_db_path))
    faces_conn.row_factory = sqlite3.Row
    review_conn = sqlite3.connect(str(review_db_path)) if review_db_path.exists() else None
    fpdb_conn = sqlite3.connect(str(fpdb_path))
    try:
        people_map = {}
        for p in faces_conn.execute("SELECT id, name FROM people").fetchall():
            people_map[p["id"]] = p["name"] or "Desconhecido"
        faces_rows = faces_conn.execute("""
            SELECT f.cloud_file_id, f.person_id, f.bbox_json, f.status, f.confidence, p.name as person_name
            FROM faces f LEFT JOIN people p ON p.id = f.person_id
        """).fetchall()
        clusters_count = faces_conn.execute("SELECT COUNT(*) FROM clusters").fetchone()[0]
        review_pending = 0
        if review_conn:
            review_pending = review_conn.execute("SELECT COUNT(*) FROM review_items WHERE status = 'pending'").fetchone()[0]
        state = faces_conn.execute(
            "SELECT last_processed_at, last_error, updated_at FROM ai_catalog_state WHERE catalog_id = ?",
            (catalog_id,),
        ).fetchone()
        fpdb_conn.execute("""
            CREATE TABLE IF NOT EXISTS ai_catalog_state (
                catalog_id TEXT PRIMARY KEY,
                faces_count INTEGER DEFAULT 0,
                embeddings_count INTEGER DEFAULT 0,
                clusters_count INTEGER DEFAULT 0,
                review_pending_count INTEGER DEFAULT 0,
                people_count INTEGER DEFAULT 0,
                last_processed_at TEXT,
                last_error TEXT,
                status TEXT DEFAULT 'idle',
                updated_at TEXT
            )
        """)
        fpdb_conn.execute("""
            INSERT OR REPLACE INTO ai_catalog_state
            (catalog_id, faces_count, embeddings_count, clusters_count, review_pending_count, people_count, last_processed_at, last_error, status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            catalog_id,
            len(faces_rows),
            sum(1 for f in faces_rows if f["person_id"]),
            clusters_count,
            review_pending,
            len(people_map),
            state["last_processed_at"] if state else None,
            state["last_error"] if state else None,
            "ready",
            state["updated_at"] if state else None,
        ))
        synced_ocorrencias = 0
        try:
            from scanner_engine import make_person_key
        except ImportError:
            from backend.scanner_engine import make_person_key

        for f in faces_rows:
            person_name = people_map.get(f["person_id"], f["person_name"] or "Desconhecido")
            cloud_file_id = f["cloud_file_id"]
            if not cloud_file_id:
                continue
            x1 = y1 = x2 = y2 = None
            if f["bbox_json"]:
                try:
                    bbox = json.loads(f["bbox_json"])
                    if len(bbox) >= 4:
                        x1, y1, x2, y2 = map(int, bbox[:4])
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
            pk = make_person_key(catalog=catalog_id, class_name="Sem turma", student_id=f["person_id"] or "")
            fpdb_conn.execute("""
                INSERT OR IGNORE INTO ocorrencias
                (aluno_id, foto_path, x1, y1, x2, y2, blur_status, source_type, drive_file_id, person_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (person_name, f"cloud://{cloud_file_id}", x1, y1, x2, y2, "unknown", "google_drive", cloud_file_id, pk))
            synced_ocorrencias += 1

        # ── Sync reference_faces: criar ocorrências + alunos para fotos de referência ──
        ref_rows = faces_conn.execute("""
            SELECT rf.id, rf.person_id, rf.cloud_file_id, rf.bbox_json, rf.embedding_path,
                   p.name as person_name
            FROM reference_faces rf
            LEFT JOIN people p ON p.id = rf.person_id
            WHERE rf.cloud_file_id IS NOT NULL AND rf.cloud_file_id != ''
        """).fetchall()

        for ref in ref_rows:
            ref_person_id = ref["person_id"]
            ref_person_name = people_map.get(ref_person_id, ref["person_name"] or "Desconhecido")
            ref_file_id = ref["cloud_file_id"]
            x1 = y1 = x2 = y2 = None
            if ref["bbox_json"]:
                try:
                    bbox = json.loads(ref["bbox_json"])
                    if len(bbox) >= 4:
                        x1, y1, x2, y2 = map(int, bbox[:4])
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
            ref_pk = make_person_key(catalog=catalog_id, class_name="Sem turma", student_id=ref_person_id)
            fpdb_conn.execute("""
                INSERT OR IGNORE INTO ocorrencias
                (aluno_id, foto_path, x1, y1, x2, y2, blur_status, source_type, drive_file_id, person_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (ref_person_name, f"cloud://{ref_file_id}", x1, y1, x2, y2, "unknown", "google_drive", ref_file_id, ref_pk))
            synced_ocorrencias += 1

        for pid, pname in people_map.items():
            pk = make_person_key(catalog=catalog_id, class_name="Sem turma", student_id=pid)
            fpdb_conn.execute("""
                INSERT OR REPLACE INTO alunos (person_key, aluno_id, face_cache_path, class_name, reference_folder)
                VALUES (?, ?, ?, ?, ?)
            """, (pk, pname, "CLOUD_AI", "Sem turma", ""))

        # ── Sync embeddings to face_embeddings table ──
        fpdb_conn.execute("""
            CREATE TABLE IF NOT EXISTS face_embeddings (
                occurrence_rowid INTEGER PRIMARY KEY,
                foto_path TEXT,
                x1 INTEGER, y1 INTEGER, x2 INTEGER, y2 INTEGER,
                mtime_ns INTEGER DEFAULT 0,
                size INTEGER DEFAULT 0,
                embedding BLOB,
                updated_at REAL DEFAULT (strftime('%s','now'))
            )
        """)

        # Collect all embedding sources (faces + reference_faces with person_id)
        all_embed_rows = faces_conn.execute("""
            SELECT id, cloud_file_id, bbox_json, embedding_path, person_id
            FROM faces
            WHERE embedding_path IS NOT NULL AND embedding_path != ''
              AND person_id IS NOT NULL
        """).fetchall()
        ref_embed_rows = faces_conn.execute("""
            SELECT id, cloud_file_id, bbox_json, embedding_path, person_id
            FROM reference_faces
            WHERE embedding_path IS NOT NULL AND embedding_path != ''
              AND person_id IS NOT NULL
        """).fetchall()
        seen_ids = set()
        for row in all_embed_rows:
            seen_ids.add(row["id"])
        for row in ref_embed_rows:
            if row["id"] not in seen_ids:
                all_embed_rows.append(row)
                seen_ids.add(row["id"])

        synced_embeddings = 0
        for emb_row in all_embed_rows:
            emb_path = emb_row["embedding_path"]
            if not emb_path or not os.path.exists(emb_path):
                continue
            emb = _cloud_ai_load_vector(emb_path)
            if emb is None:
                continue
            emb_blob = emb.astype("float32").tobytes()
            cid = emb_row["cloud_file_id"]
            if not cid:
                continue
            fpath = f"cloud://{cid}"
            x1 = y1 = x2 = y2 = None
            if emb_row["bbox_json"]:
                try:
                    bbox = json.loads(emb_row["bbox_json"])
                    if len(bbox) >= 4:
                        x1, y1, x2, y2 = map(int, bbox[:4])
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
            if x1 is not None:
                row = fpdb_conn.execute(
                    "SELECT rowid FROM ocorrencias WHERE foto_path = ? AND x1 = ? AND y1 = ? AND x2 = ? AND y2 = ?",
                    (fpath, x1, y1, x2, y2)
                ).fetchone()
            else:
                row = fpdb_conn.execute(
                    "SELECT rowid FROM ocorrencias WHERE foto_path = ? LIMIT 1",
                    (fpath,)
                ).fetchone()
            if row:
                fpdb_conn.execute(
                    "INSERT OR REPLACE INTO face_embeddings (occurrence_rowid, foto_path, x1, y1, x2, y2, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (row["rowid"], fpath, x1, y1, x2, y2, emb_blob)
                )
                synced_embeddings += 1

        logging.getLogger(__name__).info(
            "[cloud-ai-sync] catalog=%s ocorrencias=%d embeddings=%d ref_faces=%d",
            catalog_id, synced_ocorrencias, synced_embeddings, len(ref_rows),
        )
        fpdb_conn.commit()
        return {"synced": synced_ocorrencias, "embeddings": synced_embeddings, "people": len(people_map)}
    except Exception:
        fpdb_conn.rollback()
        raise
    finally:
        faces_conn.close()
        if review_conn:
            review_conn.close()
        fpdb_conn.close()


def _cloud_ai_process_references(faces_conn: sqlite3.Connection, catalog_id: str, paths: Dict[str, Path]) -> int:
    try:
        from cloud.drive_manager import drive_manager
        from services.face_engine import ensure_face_engine, get_app_face, FACE_INFERENCE_LOCK
    except Exception:
        return 0
    fpdb_path = paths["root_dir"] / "Catalogo" / "evento.fpdb"
    if not fpdb_path.exists():
        return 0
    import unicodedata, re
    def clean_ref_name(name: str) -> str:
        n = name.strip()
        def rm_acc(s):
            return "".join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')
        u = rm_acc(n.upper())
        m = re.match(r'^#?\s*(BASE|REFERENCIA|REFERENCIAS)\b\s*', u)
        if m:
            cleaned = n[m.end():].strip()
            if cleaned:
                return cleaned
        return n
    TECHNICAL_NAMES = {"#BASE", "BASE", "base", "referencia", "referência", "referencias", "referências"}
    try:
        fpdb = sqlite3.connect(str(fpdb_path))
        meta = fpdb.execute("SELECT source_breadcrumb FROM cloud_catalogs WHERE id = ?", (catalog_id,)).fetchone()
        try:
            from cloud.utils import _cloud_events_db_path, _ensure_cloud_events_table
            ce = sqlite3.connect(str(_cloud_events_db_path()))
            _ensure_cloud_events_table(ce)
            row = ce.execute("SELECT references_json, source_folder_id FROM cloud_events WHERE id = ?", (catalog_id,)).fetchone()
            source_folder_id = None
            if row:
                refs_json = row[0]
                source_folder_id = row[1]
            ce.close()
        except Exception:
            source_folder_id = None
            pass
        references = []
        references_folder_ids = []
        try:
            with (paths["root_dir"] / "Catalogo" / "metadata.json").open() as f:
                meta_data = json.load(f)
            references = meta_data.get("references", [])
            references_folder_ids = meta_data.get("referencesFolderIds", [])
        except Exception:
            pass

        if not references and not references_folder_ids:
            logging.getLogger(__name__).info("[cloud-ai-refs] Nenhuma referência encontrada no catálogo")
            return 0
        ensure_face_engine()
        app_face = get_app_face()
        if app_face is None:
            return 0
        processed = 0
        for i, ref_name in enumerate(references):
            # Usa IDs se disponíveis, senão busca pelo nome no source_folder_id
            try:
                ref_folder_id = None
                if i < len(references_folder_ids):
                    ref_folder_id = references_folder_ids[i]
                
                if not ref_folder_id and source_folder_id:
                    for folder in drive_manager.list_folders(source_folder_id):
                        if folder.name == ref_name:
                            ref_folder_id = folder.id
                            break
                
                if not ref_folder_id:
                    logging.getLogger(__name__).warning(f"[cloud-ai-ref] pasta de ref '{ref_name}' nao encontrada")
                    continue

                ref_items = drive_manager.list_folder_items(ref_folder_id) or []
            except Exception as e:
                logging.getLogger(__name__).warning(f"[cloud-ai-refs] Erro listando itens para ref {ref_name}: {e}")
                ref_items = []
            if not ref_items:
                ref_items = [{"id": "", "name": ref_name}]
            for item in ref_items:
                fid = item.get("id", "") or ""
                if not fid:
                    continue
                
                # Cria a pessoa usando o nome do arquivo
                item_name = item.get("name", "")
                clean_name = clean_ref_name(os.path.splitext(item_name)[0])
                if not clean_name or clean_name in TECHNICAL_NAMES:
                    continue
                
                skip = faces_conn.execute(
                    "SELECT id FROM people WHERE name = ?", (clean_name,)
                ).fetchone()
                if skip:
                    person_id = skip[0]
                else:
                    person_id = f"ref_{uuid.uuid4().hex[:12]}"
                    _cloud_ai_upsert_person(faces_conn, person_id, clean_name)
                
                src = _cloud_ai_resolve_source_path(fid)
                if not src:
                    try:
                        from cloud.drive_cache import cache
                        thumb_url = item.get("thumbnailUrl")
                        if thumb_url:
                            import requests
                            import re
                            thumb_url = re.sub(r'=[sw]\d+.*$', '=s1024', thumb_url)
                            resp = requests.get(thumb_url, timeout=10)
                            if resp.status_code == 200:
                                thumb_path = cache.get_thumb_path(fid)
                                with open(thumb_path, "wb") as f:
                                    f.write(resp.content)
                                src = thumb_path
                    except Exception:
                        pass
                
                if not src:
                    continue
                img = cv2.imread(src)
                if img is None:
                    continue
                with FACE_INFERENCE_LOCK:
                    with _suppress_stdout():
                        ref_faces = app_face.get(img) or []
                for fi, face in enumerate(ref_faces):
                    bbox = face.bbox.astype(int).tolist() if hasattr(face, 'bbox') else [0, 0, 100, 100]
                    emb = face.embedding if hasattr(face, 'embedding') else None
                    if emb is None:
                        continue
                    emb_norm = np.asarray(emb, dtype="float32").reshape(-1)
                    norm = float(np.linalg.norm(emb_norm))
                    if norm <= 0:
                        continue
                    emb_norm = emb_norm / norm
                    face_id = f"ref_face_{fid}_{fi}"
                    vector_path = paths["vectors_dir"] / f"{face_id}.npy"
                    try:
                        np.save(str(vector_path), emb_norm.astype("float32"))
                    except Exception:
                        continue
                    bbox_json = json.dumps(bbox)
                    _cloud_ai_record_reference(
                        faces_conn, face_id, person_id, fid, bbox_json, str(vector_path), 0.95
                    )
                    # Save face crop to cache
                    try:
                        crop_dir = paths["faces_dir"]
                        crop_path = crop_dir / f"{face_id}.jpg"
                        if not crop_path.exists():
                            x1, y1, x2, y2 = bbox[:4]
                            crop = img[y1:y2, x1:x2]
                            if crop.size > 0:
                                cv2.imwrite(str(crop_path), crop)
                    except Exception:
                        pass
                    processed += 1
        faces_conn.commit()
        logging.getLogger(__name__).info(f"[cloud-ai-refs] Processadas {processed} faces de referência para {len(references)} pastas")
        return processed
    except Exception as e:
        logging.getLogger(__name__).warning(f"[cloud-ai-refs] Erro ao processar referências: {e}")
        return 0
    finally:
        fpdb.close()


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

    # Processar pastas de referência (#BASE) antes das fotos do evento
    try:
        _cloud_ai_process_references(faces_conn, catalog_id, paths)
    except Exception:
        pass

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
                try:
                    from cloud.drive_cache import cache
                    thumb_url = file_info.get("thumbnailUrl")
                    if thumb_url:
                        import requests
                        import re
                        thumb_url = re.sub(r'=[sw]\d+.*$', '=s1024', thumb_url)
                        resp = requests.get(thumb_url, timeout=10)
                        if resp.status_code == 200:
                            thumb_path = cache.get_thumb_path(cloud_file_id)
                            with open(thumb_path, "wb") as f:
                                f.write(resp.content)
                            source_path = thumb_path
                except Exception:
                    pass

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
                        review_conf = 0.0 # Sem match
                        review_status = "pending" # Unidentified faces always go to review
                    else:
                        _cloud_ai_upsert_person(faces_conn, person_id, name=f"Pessoa {person_id[-6:]}")
                        _cloud_ai_upsert_cluster(faces_conn, person_id, confidence, created=False)
                        review_conf = similarity if similarity > 0 else confidence
                        review_status = "pending" if review_conf < 0.82 else "ready"
                    
                    local_cache_path = str(crop_path)
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
        try:
            _cloud_ai_sync_to_catalog_fpdb(catalog_id, paths)
        except Exception:
            pass
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
