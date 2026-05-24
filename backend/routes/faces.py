from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
import logging
from typing import Optional
import backend_state
import numpy as np
import os
import urllib.parse
from db import get_db
import media_manager as mm
from routes.media import get_thumb_slot, release_thumb_slot

router = APIRouter()

@router.get("/api/faces/similar")
def search_similar_faces(rowid: int, catalog: str = "", limit: int = 50):
    print(f"[faces/similar] rowid={rowid} catalog={repr(catalog)} limit={limit}")
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()

            cur.execute("SELECT embedding FROM face_embeddings WHERE occurrence_rowid = ?", (rowid,))
            base = cur.fetchone()
            print(f"[faces/similar] base_face={'found' if base else 'NOT FOUND'}, has_embedding={bool(base and base['embedding'])}")

            if not base or not base["embedding"]:
                return {"results": [], "message": "Embedding facial não disponível para este rosto. Execute uma nova varredura para gerar os embeddings."}

            query_emb = np.frombuffer(base["embedding"], dtype="float32").copy()
            norm = np.linalg.norm(query_emb)
            if norm == 0:
                return {"results": [], "message": "Embedding facial inválido para este rosto."}
            query_emb /= norm

            # Coordenadas vêm de ocorrencias (fonte canônica, sem JOIN em fotos)
            cur.execute("""
                SELECT fe.occurrence_rowid, fe.embedding,
                       o.foto_path, o.x1, o.y1, o.x2, o.y2, o.aluno_id
                FROM face_embeddings fe
                INNER JOIN ocorrencias o ON o.rowid = fe.occurrence_rowid
                WHERE fe.occurrence_rowid != ? AND fe.embedding IS NOT NULL
            """, (rowid,))
            rows = cur.fetchall()
            print(f"[faces/similar] candidates={len(rows)}")

        results = []
        for r in rows:
            try:
                emb = np.frombuffer(r["embedding"], dtype="float32").copy()
                n = np.linalg.norm(emb)
                if n == 0:
                    continue
                score = float(np.dot(query_emb, emb / n))
                path = r["foto_path"] or ""
                x1 = int(r["x1"] or 0)
                y1 = int(r["y1"] or 0)
                x2 = int(r["x2"] or 0)
                y2 = int(r["y2"] or 0)
                has_bbox = path and x2 > x1 and y2 > y1
                thumb = (
                    f"/api/faces/thumb?rowid={r['occurrence_rowid']}&catalog={urllib.parse.quote(catalog)}&size=180"
                    if has_bbox else
                    f"/api/image_thumb?path={urllib.parse.quote(path)}&size=180"
                    if path else ""
                )
                results.append({
                    "rowid": r["occurrence_rowid"],
                    "photo_path": path,
                    "thumb_url": thumb,
                    "score": score,
                    "aluno_id": r["aluno_id"],
                    "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                    "box": [x1, y1, x2, y2],
                })
            except Exception as row_err:
                print(f"[faces/similar] erro em row {r['occurrence_rowid']}: {row_err}")
                continue

        results.sort(key=lambda x: x["score"], reverse=True)
        print(f"[faces/similar] returning {min(len(results), limit)} results")
        return {"results": results[:limit]}

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[faces/similar] ERRO: {repr(e)}")
        traceback.print_exc()
        return {"results": [], "message": f"Erro ao buscar faces semelhantes: {e}"}

@router.get("/api/faces/thumb")
def get_face_thumb(rowid: int, catalog: str = "", size: int = 180):
    try:
        get_thumb_slot(size=size)
        with get_db(catalog) as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT foto_path, x1, y1, x2, y2 FROM ocorrencias WHERE rowid = ?",
                (rowid,)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Face não encontrada")
            path = row["foto_path"]
            x1 = int(row["x1"] or 0)
            y1 = int(row["y1"] or 0)
            x2 = int(row["x2"] or 0)
            y2 = int(row["y2"] or 0)

        if not path or x2 <= x1 or y2 <= y1:
            return mm.get_image_thumb(path, size) if path else HTTPException(status_code=400, detail="Bounding box inválido")

        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail="Arquivo de imagem não encontrado")

        return mm.get_thumb(path, x1, y1, x2, y2, size)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[faces/thumb] ERRO rowid={rowid}: {repr(e)}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        release_thumb_slot()
