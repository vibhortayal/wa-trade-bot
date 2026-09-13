"""TradingView MCP OAuth: dynamic client registration, PKCE, token exchange/refresh.

Auth model: TradingView's MCP server uses OAuth 2.1 with a public client
(token_endpoint_auth_method "none"). The user approves once in their browser;
the refresh token is stored locally (0600) and used silently afterwards.
Tokens are never printed or logged.
"""
import base64
import hashlib
import json
import os
import secrets
import time
from urllib.parse import urlencode, urlparse, parse_qs

import requests

MCP_URL = "https://mcp.tradingview.com/mcp"
RESOURCE_META_URL = "https://mcp.tradingview.com/.well-known/oauth-protected-resource/mcp"
REDIRECT_URI = "http://localhost:8080/callback"
SCOPES = "mcp:read mcp:tools"

CONFIG_DIR = os.path.expanduser("~/.config/tradingview-mcp")
CLIENT_FILE = os.path.join(CONFIG_DIR, "client.json")
PENDING_FILE = os.path.join(CONFIG_DIR, "pending.json")
TOKENS_FILE = os.path.join(CONFIG_DIR, "tokens.json")

TIMEOUT = 30
_CLOCK_SKEW = 30  # refresh this many seconds before actual expiry


class AuthError(Exception):
    pass


def _ensure_dir():
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)


def _write_private(path, data):
    _ensure_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def discover():
    """Fetch protected-resource metadata, then the authorization server metadata."""
    r = requests.get(RESOURCE_META_URL, timeout=TIMEOUT)
    r.raise_for_status()
    prm = r.json()
    servers = prm.get("authorization_servers") or []
    if not servers:
        raise AuthError("protected-resource metadata lists no authorization servers")
    as_base = servers[0].rstrip("/")
    r = requests.get(as_base + "/.well-known/oauth-authorization-server", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def register_client(as_meta=None):
    """Dynamic client registration (RFC 7591). Persists and returns the client record."""
    as_meta = as_meta or discover()
    register_url = as_meta.get("registration_endpoint")
    if not register_url:
        raise AuthError("authorization server metadata has no registration_endpoint")
    existing = _read_json(CLIENT_FILE)
    if existing and existing.get("client_id"):
        return existing
    body = {
        "redirect_uris": [REDIRECT_URI],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "scope": SCOPES,
        "client_name": "tradingview-mcp-skill",
    }
    r = requests.post(register_url, json=body, timeout=TIMEOUT)
    if r.status_code >= 400:
        raise AuthError("client registration failed: HTTP %d: %s" % (r.status_code, r.text[:300]))
    data = r.json()
    record = {
        "client_id": data["client_id"],
        "registered_at": int(time.time()),
        "registration_endpoint": register_url,
    }
    if data.get("client_secret"):
        record["client_secret"] = data["client_secret"]
    _write_private(CLIENT_FILE, record)
    return record


def _pkce_pair():
    verifier = secrets.token_urlsafe(64)  # 86 chars, within RFC 7636 43-128 range
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def build_authorize_url(as_meta=None, client=None):
    """Build the PKCE authorize URL. Stores verifier+state for the callback step."""
    as_meta = as_meta or discover()
    client = client or register_client(as_meta)
    authorize_url = as_meta.get("authorization_endpoint")
    if not authorize_url:
        raise AuthError("authorization server metadata has no authorization_endpoint")
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)
    _write_private(PENDING_FILE, {"verifier": verifier, "state": state,
                                 "created_at": int(time.time())})
    params = {
        "response_type": "code",
        "client_id": client["client_id"],
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": MCP_URL,
        "state": state,
    }
    return authorize_url + "?" + urlencode(params)


def exchange_code(callback_url, as_meta=None):
    """Exchange the pasted redirect URL's ?code= for tokens. Stores tokens, clears pending."""
    as_meta = as_meta or discover()
    token_url = as_meta.get("token_endpoint")
    if not token_url:
        raise AuthError("authorization server metadata has no token_endpoint")
    pending = _read_json(PENDING_FILE)
    if not pending:
        raise AuthError("no pending authorization; run 'auth --start' first")
    qs = parse_qs(urlparse(callback_url).query)
    if qs.get("error"):
        raise AuthError("authorization failed: %s %s" % (
            qs["error"][0], (qs.get("error_description") or [""])[0]))
    code = (qs.get("code") or [None])[0]
    state = (qs.get("state") or [None])[0]
    if not code:
        raise AuthError("no ?code= found in the pasted URL")
    if not state or not secrets.compare_digest(state, pending["state"]):
        raise AuthError("state mismatch; possible tampering - start over with 'auth --start'")
    client = register_client(as_meta)
    body = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": client["client_id"],
        "code_verifier": pending["verifier"],
        "resource": MCP_URL,
    }
    r = requests.post(token_url, data=body, timeout=TIMEOUT)
    if r.status_code >= 400:
        raise AuthError("token exchange failed: HTTP %d: %s" % (r.status_code, r.text[:300]))
    _store_token_response(r.json())
    try:
        os.remove(PENDING_FILE)
    except OSError:
        pass


def _store_token_response(data):
    if "access_token" not in data:
        raise AuthError("token response missing access_token: %s" % str(data)[:200])
    record = {
        "access_token": data["access_token"],
        "token_type": data.get("token_type", "Bearer"),
        "expires_at": int(time.time()) + int(data.get("expires_in", 3600)) - _CLOCK_SKEW,
        "scope": data.get("scope", ""),
        "resource": MCP_URL,
        "obtained_at": int(time.time()),
    }
    if data.get("refresh_token"):
        record["refresh_token"] = data["refresh_token"]
    else:
        old = _read_json(TOKENS_FILE) or {}
        if old.get("refresh_token"):
            record["refresh_token"] = old["refresh_token"]  # keep previous on rotation-less refresh
    _write_private(TOKENS_FILE, record)


def refresh_tokens(as_meta=None):
    """Use the refresh token to get a new access token. Returns the token record."""
    as_meta = as_meta or discover()
    token_url = as_meta.get("token_endpoint")
    tokens = _read_json(TOKENS_FILE) or {}
    if not tokens.get("refresh_token"):
        raise AuthError("no refresh token stored; run 'auth --start' first")
    client = register_client(as_meta)
    body = {
        "grant_type": "refresh_token",
        "refresh_token": tokens["refresh_token"],
        "client_id": client["client_id"],
        "resource": MCP_URL,
    }
    r = requests.post(token_url, data=body, timeout=TIMEOUT)
    if r.status_code >= 400:
        raise AuthError("token refresh failed: HTTP %d: %s" % (r.status_code, r.text[:300]))
    _store_token_response(r.json())
    return _read_json(TOKENS_FILE)


def get_access_token():
    """Return a valid access token, refreshing if expired. Raises AuthError if not authorized."""
    tokens = _read_json(TOKENS_FILE)
    if not tokens or not tokens.get("access_token"):
        raise AuthError("not authorized; run 'tv.py auth --start' first")
    if tokens.get("expires_at", 0) <= time.time():
        tokens = refresh_tokens()
    return tokens["access_token"]


def status():
    """Non-sensitive auth status for display."""
    client = _read_json(CLIENT_FILE)
    tokens = _read_json(TOKENS_FILE)
    pending = _read_json(PENDING_FILE)
    return {
        "registered": bool(client and client.get("client_id")),
        "client_id": (client or {}).get("client_id"),
        "authorized": bool(tokens and tokens.get("access_token")),
        "token_expires_in_s": max(0, (tokens or {}).get("expires_at", 0) - int(time.time())),
        "has_refresh_token": bool((tokens or {}).get("refresh_token")),
        "pending_authorize": bool(pending),
    }
