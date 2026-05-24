from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
import logging
import os
import urllib.parse
from db import get_db
import scanner_engine

router = APIRouter()

class AiBatchStatusReq:
    foto_paths: list[str]

