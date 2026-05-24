"""
Modelos Pydantic para o módulo review_manager.
"""
from __future__ import annotations

from typing import Optional, List
from pydantic import BaseModel


class SyncReferencesReq(BaseModel):
    catalog: str = ""


class ManualIdentifyReq(BaseModel):
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
    class_name: str = ""


class IgnoreUnknownClusterRequest(BaseModel):
    catalog: str = ""
    cluster_id: str
    rowids: list[int] = []


class GraduationAnalysisRequest(BaseModel):
    catalog: str = ""


class GraduationManualOverrideRequest(BaseModel):
    catalog: str = ""
    rowids: list[int]
    action: str
    item: str


class QualitySettingsReq(BaseModel):
    blur_blurry_threshold: float
    blur_attention_threshold: float
    min_photos_per_person: int
    manual_search_min_score: float


class MergePeopleReq(BaseModel):
    catalog: str
    source_ids: list[str]
    target_id: str


class MergePersonReq(BaseModel):
    catalog: str = ""
    source_person_id: str
    target_person_id: str
    confirmed_by_user: bool = True
