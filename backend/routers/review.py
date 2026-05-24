import logging
import traceback
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import review_manager as rm
import media_manager as mm

router = APIRouter()

BulkManualIdentifyReq = rm.BulkManualIdentifyReq
AssignUnknownClusterRequest = rm.AssignUnknownClusterRequest
IgnoreUnknownClusterRequest = rm.IgnoreUnknownClusterRequest
GraduationAnalysisRequest = rm.GraduationAnalysisRequest
GraduationManualOverrideRequest = rm.GraduationManualOverrideRequest


class BulkDiscardPhotoReq(BaseModel):
    catalog: str = ""
    photo_ids: Optional[List[int]] = None
    rowids: Optional[List[int]] = None
    foto_paths: Optional[List[str]] = None
    reason: Optional[str] = None

    def ids(self) -> List[int]:
        return self.photo_ids or self.rowids or []


class BulkRestorePhotoReq(BaseModel):
    catalog: str = ""
    photo_ids: Optional[List[int]] = None
    rowids: Optional[List[int]] = None
    foto_paths: Optional[List[str]] = None

    def ids(self) -> List[int]:
        return self.photo_ids or self.rowids or []


@router.get("/api/pendencies")
def get_pendencies(catalog: str = "", mode: str = "all"):
    return mm.get_pendencies(catalog, mode)


@router.get("/api/unknown-clusters")
def get_unknown_clusters(
    catalog: str = "",
    min_score: float = 0.58,
    min_cluster_size: int = 2,
    limit: int = 80
):
    return rm.get_unknown_clusters(catalog, min_score, min_cluster_size, limit)


@router.get("/api/review/unknown-clusters")
def get_review_unknown_clusters(
    catalog: str = "",
    min_score: float = 0.58,
    min_cluster_size: int = 2,
    limit: int = 100
):
    return rm.get_unknown_clusters(catalog, min_score, min_cluster_size, limit)


@router.get("/api/review/clusters")
def get_review_clusters(
    catalog: str = "",
    limit: int = 30,
    offset: int = 0,
):
    try:
        return rm.get_review_clusters_page(catalog, limit, offset)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/review/clusters/detail")
def get_review_cluster_detail(
    catalog: str = "",
    cluster_id: str = "",
):
    return rm.get_review_cluster_detail(catalog, cluster_id)


@router.get("/api/review/student-match-preview")
def get_student_match_preview(catalog: str, cluster_id: str, student: str):
    return rm.get_student_match_preview(catalog, cluster_id, student)


@router.post("/api/review/generate-all-embeddings")
def generate_all_embeddings(req: dict = {}):
    return rm.generate_all_embeddings(req.get("catalog", ""))


@router.post("/api/review/bulk-manual-identify")
def bulk_manual_identify(req: BulkManualIdentifyReq):
    return rm.bulk_manual_identify(req)


@router.post("/api/review/unknown-clusters/assign")
def assign_cluster(req: AssignUnknownClusterRequest):
    payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    print("[assign_unknown_cluster] payload:", payload, flush=True)
    try:
        return rm.assign_cluster(req)
    except HTTPException as e:
        return JSONResponse(
            status_code=e.status_code,
            content={
                "ok": False,
                "error": "assign_unknown_cluster_http_error",
                "detail": str(e.detail),
            },
        )
    except Exception as e:
        traceback.print_exc()
        logging.getLogger(__name__).exception("[assign_unknown_cluster] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "assign_unknown_cluster_failed",
                "detail": str(e),
            },
        )


@router.post("/api/migrate-person-keys")
def migrate_person_keys():
    return rm.migrate_person_keys()


@router.post("/api/review/unknown-clusters/ignore")
@router.post("/api/review/ignore")
@router.post("/api/unknown-clusters/ignore")
@router.post("/api/review/cluster/ignore")
@router.post("/api/review/bulk-ignore")
def ignore_cluster(req: IgnoreUnknownClusterRequest):
    try:
        return rm.ignore_cluster(req)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("[ignore_unknown_cluster] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "ignore_unknown_cluster_failed",
                "detail": str(e),
            },
        )


@router.post("/api/review/clusters/merge")
def merge_clusters(catalog: str = "", source_cluster_id: str = "", target_cluster_id: str = ""):
    try:
        return rm.merge_unknown_clusters(catalog, source_cluster_id, target_cluster_id)
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@router.get("/api/review/debug-cluster-similarities")
def debug_cluster_similarities(catalog: str = ""):
    try:
        return rm.debug_cluster_similarities(catalog)
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/review/debug-face-state")
def debug_face_state(rowid: int = 0, foto_path: str = ""):
    try:
        return rm.debug_face_state(rowid=rowid, foto_path=foto_path)
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/review/debug-student-matches")
def debug_student_matches(catalog: str = ""):
    try:
        return rm.debug_student_matches(catalog)
    except Exception as e:
        return {"error": str(e)}


@router.post("/api/review/graduation-analysis/start")
def start_graduation_analysis(req: GraduationAnalysisRequest):
    try:
        return rm.start_graduation_analysis(req)
    except HTTPException:
        raise
    except Exception as e:
        logging.getLogger(__name__).exception("[graduation_analysis_start] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "graduation_analysis_start_failed",
                "detail": str(e),
            },
        )


@router.get("/api/review/graduation-analysis/status")
def get_graduation_analysis_status(catalog: str = ""):
    try:
        return rm.get_graduation_analysis_status(catalog)
    except Exception as e:
        logging.getLogger(__name__).exception("[graduation_analysis_status] erro")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "graduation_analysis_status_failed",
                "detail": str(e),
            },
        )


@router.post("/api/review/graduation/manual-override")
def graduation_manual_override(req: GraduationManualOverrideRequest):
    try:
        return rm.graduation_manual_override(req)
    except Exception as e:
        logging.getLogger(__name__).exception("[graduation_manual_override] erro")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": str(e)},
        )


@router.post("/api/review/bulk-discard")
def bulk_discard_photos(req: BulkDiscardPhotoReq):
    from utils import _invalidate_stats_caches
    _invalidate_stats_caches()
    return rm.bulk_discard_photos(req)


@router.post("/api/review/bulk-restore")
def bulk_restore_photos(req: BulkRestorePhotoReq):
    from utils import _invalidate_stats_caches
    _invalidate_stats_caches()
    return rm.bulk_restore_photos(req)
