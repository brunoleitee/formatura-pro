import os
import json
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

TOKEN_FILE = "data/cloud/google_token.json"


def get_token_path() -> str:
    os.makedirs("data/cloud", exist_ok=True)
    return os.path.join(TOKEN_FILE)


def save_token(token_data: Dict[str, Any]) -> None:
    try:
        with open(get_token_path(), "w", encoding="utf-8") as f:
            json.dump(token_data, f)
        logger.info("Token salvo com sucesso")
    except Exception as e:
        logger.error(f"Erro ao salvar token: {e}")


def load_token() -> Optional[Dict[str, Any]]:
    try:
        if os.path.exists(get_token_path()):
            with open(get_token_path(), "r", encoding="utf-8") as f:
                return json.load(f)
        return None
    except Exception as e:
        logger.error(f"Erro ao carregar token: {e}")
        return None


def clear_token() -> None:
    try:
        if os.path.exists(get_token_path()):
            os.remove(get_token_path())
        logger.info("Token removido")
    except Exception as e:
        logger.error(f"Erro ao remover token: {e}")


def is_authenticated() -> bool:
    token = load_token()
    if not token:
        return False
    expires_at = token.get("expires_at", 0)
    return datetime.now().timestamp() < expires_at


def get_auth_url() -> str:
    from google_auth_oauthlib import Flow
    from app.core.config import settings

    flow = Flow.from_client_secrets_file(
        "data/cloud/client_secrets.json",
        scopes=[
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/drive.file",
        ],
    )

    flow.redirect_uri = settings.BACKEND_URL + "/api/cloud/google-drive/callback"

    auth_url, _ = flow.authorization_url(prompt="consent")
    return auth_url


def exchange_code_for_token(code: str) -> Optional[Dict[str, Any]]:
    from google_auth_oauthlib import Flow

    try:
        flow = Flow.from_client_secrets_file(
            "data/cloud/client_secrets.json",
            scopes=[
                "https://www.googleapis.com/auth/drive.readonly",
                "https://www.googleapis.com/auth/drive.file",
            ],
        )

        flow.redirect_uri = "http://localhost:8000/api/cloud/google-drive/callback"
        flow.fetch_token(code=code)

        credentials = flow.credentials

        token_data = {
            "token": credentials.token,
            "refresh_token": credentials.refresh_token,
            "token_uri": credentials.token_uri,
            "client_id": credentials.client_id,
            "client_secret": credentials.client_secret,
            "scopes": list(credentials.scopes),
            "expires_at": credentials.expiry.timestamp(),
        }

        save_token(token_data)
        return token_data

    except Exception as e:
        logger.error(f"Erro ao trocar código por token: {e}")
        return None