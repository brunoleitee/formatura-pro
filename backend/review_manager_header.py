import os
import json
import time
import threading
import hashlib
import urllib.parse
import numpy as np
from datetime import datetime
from fastapi import HTTPException, Query
from pydantic import BaseModel

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    return _cfg.get(name, default)


def get_backup_name(base_name: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{base_name}_{timestamp}"


class MergePeopleReq(BaseModel):
    catalog: str
    source_ids: list[str]
    target_id: str


class RenameReq(BaseModel):
    old_id: str
    new_id: str


class DeletePersonReq(BaseModel):
    aluno_id: str


class DeletePhotoReq(BaseModel):
    aluno_id: str
    foto_path: str


class ManualSearchReq(BaseModel):
    catalog: str
    image_path: str
    face_index: int = 0
    unidentified_only: bool = False
    min_score: float = 0.45
    limit: int = 80
