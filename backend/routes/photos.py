from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
import logging
import os
import urllib.parse
import backend_state
from db import get_db

router = APIRouter()

