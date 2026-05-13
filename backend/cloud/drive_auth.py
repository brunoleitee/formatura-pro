import os
import json
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

CURRENT_FILE = Path(__file__).resolve()
BASE_DIR = CURRENT_FILE.parents[2]
DATA_DIR = BASE_DIR / "data" / "cloud"

DATA_DIR.mkdir(parents=True, exist_ok=True)

CLIENT_SECRETS_FILE = DATA_DIR / "client_secrets.json"
TOKEN_FILE = DATA_DIR / "google_token.json"

print("=" * 60)
print(f"[GoogleDrive] CURRENT_FILE = {CURRENT_FILE}")
print(f"[GoogleDrive] BASE_DIR = {BASE_DIR}")
print(f"[GoogleDrive] DATA_DIR = {DATA_DIR}")
print(f"[GoogleDrive] CLIENT_SECRETS_FILE = {CLIENT_SECRETS_FILE}")
print(f"[GoogleDrive] CLIENT_SECRETS EXISTS = {CLIENT_SECRETS_FILE.exists()}")
if CLIENT_SECRETS_FILE.exists():
    try:
        with open(CLIENT_SECRETS_FILE) as f:
            data = json.load(f)
            print(f"[GoogleDrive] CLIENT_SECRETS keys = {list(data.keys())}")
    except Exception as e:
        print(f"[GoogleDrive] Error reading: {e}")
print("=" * 60)

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
]

REDIRECT_URI = "http://localhost:8000/"

_oauth_states: Dict[str, str] = {}


def get_token_path() -> str:
    return str(TOKEN_FILE)


def save_token(token_data: Dict[str, Any]) -> None:
    try:
        with open(get_token_path(), "w", encoding="utf-8") as f:
            json.dump(token_data, f)
        logger.info("Token salvo com sucesso")
    except Exception as e:
        logger.error(f"Erro ao salvar token: {e}")


def load_token() -> Optional[Dict[str, Any]]:
    try:
        if TOKEN_FILE.exists():
            with open(get_token_path(), "r", encoding="utf-8") as f:
                return json.load(f)
        return None
    except Exception as e:
        logger.error(f"Erro ao carregar token: {e}")
        return None


def clear_token() -> None:
    try:
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
        logger.info("Token removido")
    except Exception as e:
        logger.error(f"Erro ao remover token: {e}")


def is_authenticated() -> bool:
    token = load_token()
    if not token:
        return False
    expires_at = token.get("expires_at", 0)
    return datetime.now().timestamp() < expires_at


def get_client_secrets_path() -> str:
    if not CLIENT_SECRETS_FILE.exists():
        raise FileNotFoundError(
            f"Client secrets não encontrado em: {CLIENT_SECRETS_FILE}\n"
            f"Crie o arquivo em: {CLIENT_SECRETS_FILE}\n"
            f"Formato: {json.dumps({'web': {'client_id': 'SEU_CLIENT_ID', 'client_secret': 'SEU_CLIENT_SECRET', 'redirect_uris': ['http://localhost:8000/api/cloud/google/callback']}}, indent=2)}"
        )
    return str(CLIENT_SECRETS_FILE)


def get_auth_url() -> str:
    from google_auth_oauthlib.flow import Flow
    from app.core.config import settings

    flow = Flow.from_client_secrets_file(
        get_client_secrets_path(),
        scopes=SCOPES,
        redirect_uri=settings.BACKEND_URL + "/",
    )

    auth_url, _ = flow.authorization_url(prompt="consent")
    return auth_url


def exchange_code_for_token(code: str, state: str = None) -> Optional[Dict[str, Any]]:
    try:
        from google_auth_oauthlib.flow import Flow

        code_verifier = _oauth_states.pop(state, None)
        if state:
            print(f"[OAuth] state={state[:20]}... code_verifier={'found' if code_verifier else 'MISSING'}")

        print(f"[OAuth] exchange_code: code={code[:40]}...")
        print(f"[OAuth] redirect_uri={REDIRECT_URI}")
        print(f"[OAuth] client_secrets={CLIENT_SECRETS_FILE}")
        print(f"[OAuth] scopes={SCOPES}")

        flow = Flow.from_client_secrets_file(
            get_client_secrets_path(),
            scopes=SCOPES,
            redirect_uri=REDIRECT_URI,
        )

        if code_verifier:
            flow.code_verifier = code_verifier

        flow.fetch_token(code=code)
        print(f"[OAuth] fetch_token OK")

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
        print(f"[OAuth] token saved to {TOKEN_FILE}")
        return token_data

    except Exception:
        import traceback
        print("=" * 80)
        print("[Google OAuth] ERRO FETCH TOKEN")
        print(f"code = {code[:40]}...")
        print(f"redirect_uri = {REDIRECT_URI}")
        print(f"client_secrets = {CLIENT_SECRETS_FILE}")
        print(f"scopes = {SCOPES}")
        traceback.print_exc()
        print("=" * 80)
        import sys as _sys
        _sys.stdout.flush()
        logger.error(f"Erro ao trocar código por token", exc_info=True)
        raise


def get_login_url() -> Optional[str]:
    try:
        from google_auth_oauthlib.flow import Flow

        flow = Flow.from_client_secrets_file(
            get_client_secrets_path(),
            scopes=SCOPES,
            redirect_uri=REDIRECT_URI,
        )

        auth_url, state = flow.authorization_url(prompt="consent", access_type="offline")
        _oauth_states[state] = flow.code_verifier
        print(f"[OAuth] login_url generated redirect_uri={REDIRECT_URI} state={state[:20]}...")
        return auth_url
    except Exception as e:
        print(f"[OAuth] get_login_url ERROR: {e}")
        logger.error(f"Erro ao gerar URL de login: {e}")
        return None


def get_user_info() -> Optional[Dict[str, Any]]:
    if not is_authenticated():
        return None
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        token_data = load_token()
        if not token_data:
            return None

        credentials = Credentials(
            token=token_data.get("token"),
            refresh_token=token_data.get("refresh_token"),
            token_uri=token_data.get("token_uri"),
            client_id=token_data.get("client_id"),
            client_secret=token_data.get("client_secret"),
            scopes=token_data.get("scopes", []),
        )

        service = build("oauth2", "v2", credentials=credentials)
        user_info = service.userinfo().get().execute()

        return {
            "email": user_info.get("email"),
            "name": user_info.get("name"),
            "picture": user_info.get("picture"),
        }
    except Exception as e:
        logger.error(f"Erro ao buscar info do usuário: {e}")
        return None