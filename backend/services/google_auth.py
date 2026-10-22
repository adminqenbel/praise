"""Sign in with Google: OpenID Connect authorization-code flow with PKCE, run entirely by this API.

The browser goes API -> Google -> API (callback) -> dashboard. The callback trades the one-time code for an ID token
straight with Google (server to server, with the client secret and the PKCE verifier), then checks the token's
signature, audience, issuer, expiry and nonce before anything in it is believed.
"""
import base64
import hashlib
import secrets
from urllib.parse import urlencode

import requests
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
TIMEOUT = 10   # seconds for each call to Google


class GoogleAuthError(Exception):
    """Google said no, didn't answer, or sent something that failed a check."""


def enabled(cfg) -> bool:
    return bool(cfg.get("GOOGLE_CLIENT_ID") and cfg.get("GOOGLE_CLIENT_SECRET"))


def redirect_uri(cfg) -> str:
    return str(cfg.get("API_ORIGIN", "")).rstrip("/") + "/api/auth/google/callback"


# Fresh secrets for one sign-in attempt: `state` ties the callback to this browser's session, `nonce` ties the ID token
# to this attempt, and the PKCE verifier makes a stolen code useless to anyone else.
def new_attempt() -> dict:
    return {"state": secrets.token_urlsafe(32), "nonce": secrets.token_urlsafe(32),
            "verifier": secrets.token_urlsafe(64)}


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def authorize_url(cfg, attempt: dict) -> str:
    return AUTH_URL + "?" + urlencode({
        "client_id": cfg["GOOGLE_CLIENT_ID"], "redirect_uri": redirect_uri(cfg), "response_type": "code",
        "scope": "openid email profile", "state": attempt["state"], "nonce": attempt["nonce"],
        "code_challenge": _challenge(attempt["verifier"]), "code_challenge_method": "S256",
        "prompt": "select_account"})


def claims_for_code(cfg, code: str, verifier: str, nonce: str) -> dict:
    """Trade the callback's code for verified identity claims: {sub, email, email_verified}."""
    if not code or len(code) > 2048:
        raise GoogleAuthError("no code")
    try:
        resp = requests.post(TOKEN_URL, timeout=TIMEOUT, data={
            "code": code, "client_id": cfg["GOOGLE_CLIENT_ID"], "client_secret": cfg["GOOGLE_CLIENT_SECRET"],
            "redirect_uri": redirect_uri(cfg), "grant_type": "authorization_code", "code_verifier": verifier})
    except requests.RequestException as e:
        raise GoogleAuthError("token endpoint unreachable") from e
    if resp.status_code != 200:
        raise GoogleAuthError(f"token endpoint answered {resp.status_code}")
    token = (resp.json() or {}).get("id_token")
    if not token:
        raise GoogleAuthError("no id_token")
    try:
        # Checks the signature against Google's published keys, the audience (our client id), issuer and expiry.
        claims = id_token.verify_oauth2_token(token, google_requests.Request(), cfg["GOOGLE_CLIENT_ID"],
                                              clock_skew_in_seconds=10)
    except ValueError as e:
        raise GoogleAuthError("id_token failed verification") from e
    if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise GoogleAuthError("nonce mismatch")
    if not claims.get("sub") or not claims.get("email"):
        raise GoogleAuthError("id_token lacks sub or email")
    return {"sub": str(claims["sub"]), "email": str(claims["email"]).strip().lower(),
            "email_verified": claims.get("email_verified") is True}
