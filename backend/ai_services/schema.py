"""Persistência local para metadados de IA."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Dict, Iterator, Optional


@dataclass
class PhotoAIMetadata:
    photo_id: str
    file_path: str
    ai_score: Optional[float] = None
    smile_score: Optional[float] = None
    eyes_score: Optional[float] = None
    face_count: Optional[int] = None
    caption: str = ""
    tags: Optional[list[str]] = None
    analysis_status: str = "pending"


class PhotoAISchema:
    def __init__(self, db_path: Optional[str] = None, data_dir: Optional[str] = None, log_debug=None, log_info=None):
        if db_path:
            self.db_path = db_path
        else:
            base_dir = data_dir or os.getcwd()
            self.db_path = os.path.join(base_dir, "formaturapro_ai.sqlite3")
        self._log_debug = log_debug or (lambda msg: None)
        self._log_info = log_info or (lambda msg: None)
        self.ensure_schema()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def ensure_schema(self) -> None:
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        with self.connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_photo_metadata (
                    photo_id TEXT PRIMARY KEY,
                    file_path TEXT NOT NULL,
                    file_mtime_ns INTEGER,
                    file_size INTEGER,
                    ai_score REAL,
                    smile_score REAL,
                    eyes_score REAL,
                    face_count INTEGER,
                    caption TEXT,
                    tags_json TEXT,
                    analysis_status TEXT NOT NULL DEFAULT 'pending',
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_photo_embeddings (
                    photo_id TEXT PRIMARY KEY,
                    file_path TEXT,
                    file_mtime_ns INTEGER,
                    file_size INTEGER,
                    embedding_json TEXT NOT NULL,
                    model_name TEXT,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self._ensure_columns(conn, "ai_photo_metadata", {
                "file_mtime_ns": "INTEGER",
                "file_size": "INTEGER",
            })
            self._ensure_columns(conn, "ai_photo_embeddings", {
                "file_path": "TEXT",
                "file_mtime_ns": "INTEGER",
                "file_size": "INTEGER",
            })
            conn.commit()

    def _ensure_columns(self, conn: sqlite3.Connection, table: str, columns: Dict[str, str]) -> None:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for column_name, column_type in columns.items():
            if column_name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column_name} {column_type}")

    def upsert_photo_metadata(self, metadata: Dict[str, Any]) -> None:
        tags = metadata.get("tags") or []
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO ai_photo_metadata (
                    photo_id, file_path, file_mtime_ns, file_size, ai_score, smile_score, eyes_score,
                    face_count, caption, tags_json, analysis_status, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(photo_id) DO UPDATE SET
                    file_path = excluded.file_path,
                    file_mtime_ns = excluded.file_mtime_ns,
                    file_size = excluded.file_size,
                    ai_score = excluded.ai_score,
                    smile_score = excluded.smile_score,
                    eyes_score = excluded.eyes_score,
                    face_count = excluded.face_count,
                    caption = excluded.caption,
                    tags_json = excluded.tags_json,
                    analysis_status = excluded.analysis_status,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    metadata.get("photo_id"),
                    metadata.get("file_path"),
                    metadata.get("file_mtime_ns"),
                    metadata.get("file_size"),
                    metadata.get("ai_score"),
                    metadata.get("smile_score"),
                    metadata.get("eyes_score"),
                    metadata.get("face_count"),
                    metadata.get("caption", ""),
                    json.dumps(tags, ensure_ascii=False),
                    metadata.get("analysis_status", "pending"),
                ),
            )
            conn.commit()

    def upsert_embedding(self, photo_id: str, embedding: list[float], model_name: str = "placeholder-clip") -> None:
        self.upsert_embedding_record(photo_id, None, None, None, embedding, model_name=model_name)

    def upsert_embedding_record(
        self,
        photo_id: str,
        file_path: Optional[str],
        file_mtime_ns: Optional[int],
        file_size: Optional[int],
        embedding: list[float],
        model_name: str = "placeholder-clip",
    ) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO ai_photo_embeddings (photo_id, file_path, file_mtime_ns, file_size, embedding_json, model_name, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(photo_id) DO UPDATE SET
                    file_path = excluded.file_path,
                    file_mtime_ns = excluded.file_mtime_ns,
                    file_size = excluded.file_size,
                    embedding_json = excluded.embedding_json,
                    model_name = excluded.model_name,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (photo_id, file_path, file_mtime_ns, file_size, json.dumps(embedding), model_name),
            )
            conn.commit()

    def get_photo_metadata(self, photo_id: str) -> Dict[str, Any]:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT * FROM ai_photo_metadata WHERE photo_id = ?",
                (photo_id,),
            ).fetchone()
        if not row:
            return {}
        return dict(row)

    def get_embedding_records(self) -> list[Dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT e.photo_id, e.file_path, e.file_mtime_ns, e.file_size, e.embedding_json,
                       e.model_name, m.ai_score, m.smile_score, m.eyes_score, m.face_count,
                       m.caption, m.tags_json, m.analysis_status
                FROM ai_photo_embeddings e
                LEFT JOIN ai_photo_metadata m ON m.photo_id = e.photo_id
                ORDER BY e.updated_at DESC
                """
            ).fetchall()
        records = []
        for row in rows:
            data = dict(row)
            try:
                data["embedding"] = json.loads(data.pop("embedding_json") or "[]")
            except Exception:
                data["embedding"] = []
            try:
                data["tags"] = json.loads(data.get("tags_json") or "[]")
            except Exception:
                data["tags"] = []
            records.append(data)
        return records

    def needs_reindex(self, file_path: str, mtime_ns: Optional[int], file_size: Optional[int]) -> bool:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT file_mtime_ns, file_size FROM ai_photo_embeddings WHERE photo_id = ?",
                (file_path,),
            ).fetchone()
        if not row:
            return True
        return row["file_mtime_ns"] != mtime_ns or row["file_size"] != file_size
