import pathlib
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from config import Config, production_problems
from database.models import Device, OAuthIdentity, User
from database.postgres import db
from services import google_auth
from tests.test_ext_api import paired
from tests.test_models import app  # noqa: F401  (fixture)

DASH = "http://localhost:5500"


@pytest.fixture()
def google(app, monkeypatch):
    """Google switched on, with its token exchange replaced: tests set `who` to the account Google vouches for."""
    app.config.update(GOOGLE_CLIENT_ID="cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET="s",
                      API_ORIGIN="http://localhost:5000")
    who = {"sub": "g-1", "email": "parent@gmail.com", "email_verified": True}
    seen = []

    def fake(cfg, code, verifier, nonce):
        seen.append((code, verifier, nonce))
        if code == "bad":
            raise google_auth.GoogleAuthError("rejected")
        return dict(who)
    monkeypatch.setattr(google_auth, "claims_for_code", fake)
    return who, seen


def sign_in(client, code="abc", state=None, **start):
    """Run the whole browser round trip; returns the final redirect's (page, google_error)."""
    r = client.get("/api/auth/google/start", query_string=start)
    if "accounts.google.com" not in r.headers["Location"]:
        return _where(r)
    sent = parse_qs(urlparse(r.headers["Location"]).query)
    r = client.get("/api/auth/google/callback", query_string={"state": state or sent["state"][0], "code": code})
    return _where(r)


def _where(r):
    assert r.status_code == 302
    url = urlparse(r.headers["Location"])
    assert f"{url.scheme}://{url.netloc}" == DASH            # always back to the dashboard, never elsewhere
    return url.path.lstrip("/"), parse_qs(url.query).get("google_error", [None])[0]


def me(client):
    r = client.get("/api/auth/me")
    return r.get_json()["user"] if r.status_code == 200 else None


# ---- the request to Google ------------------------------------------------------------------------------------------

def test_start_sends_the_browser_to_google_with_state_nonce_and_pkce(app, google):
    r = app.test_client().get("/api/auth/google/start")
    url = urlparse(r.headers["Location"])
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.netloc == "accounts.google.com"
    assert q["client_id"] == "cid.apps.googleusercontent.com"
    assert q["redirect_uri"] == "http://localhost:5000/api/auth/google/callback"
    assert q["scope"] == "openid email profile" and q["response_type"] == "code"
    assert q["code_challenge_method"] == "S256" and len(q["code_challenge"]) == 43
    assert len(q["state"]) >= 40 and len(q["nonce"]) >= 40


def test_without_google_configured_the_button_says_so(app):
    app.config.update(GOOGLE_CLIENT_ID="", GOOGLE_CLIENT_SECRET="")   # backend/.env may hold real ones
    assert sign_in(app.test_client()) == ("home.html", "unavailable")


# ---- signing up and in ----------------------------------------------------------------------------------------------

def test_a_new_google_login_gets_a_family_account_without_a_password(app, google):
    c = app.test_client()
    assert sign_in(c, next="children.html") == ("children.html", None)
    user = me(c)
    assert user["email"] == "parent@gmail.com" and user["account_type"] == "family"
    assert user["google"] is True and user["has_password"] is False
    # no password to guess at
    for pw in ("", "password123"):
        assert app.test_client().post("/api/auth/login", json={"email": "parent@gmail.com", "password": pw}).status_code == 401


def test_a_new_google_login_can_choose_the_personal_space(app, google):
    c = app.test_client()
    sign_in(c, space="adult")
    assert me(c)["account_type"] == "adult"
    assert len(c.get("/api/children").get_json()["children"]) == 1      # the person's own profile


def test_the_same_google_account_signs_in_to_the_same_login_even_after_its_email_changes(app, google):
    who, _ = google
    first = app.test_client()
    sign_in(first)
    who["email"] = "renamed@gmail.com"
    again = app.test_client()
    assert sign_in(again) == ("home.html", None)
    assert me(again)["id"] == me(first)["id"]
    assert User.query.count() == 1


def test_google_is_never_joined_to_an_existing_account_by_email_alone(app, google):
    app.test_client().post("/api/auth/register", json={"email": "parent@gmail.com", "password": "password123"})
    c = app.test_client()
    assert sign_in(c) == ("home.html", "email_exists")
    assert me(c) is None and OAuthIdentity.query.count() == 0


def test_an_unverified_google_email_cannot_open_an_account(app, google):
    google[0]["email_verified"] = False
    c = app.test_client()
    assert sign_in(c) == ("home.html", "unverified")
    assert me(c) is None and User.query.count() == 0


def test_a_failed_exchange_or_a_cancel_signs_nobody_in(app, google):
    c = app.test_client()
    assert sign_in(c, code="bad") == ("home.html", "failed")
    assert me(c) is None
    r = c.get("/api/auth/google/start")
    state = parse_qs(urlparse(r.headers["Location"]).query)["state"][0]
    r = c.get("/api/auth/google/callback", query_string={"state": state, "error": "access_denied"})
    assert _where(r) == ("home.html", "cancelled") and me(c) is None


# ---- the callback can't be replayed or forged -----------------------------------------------------------------------

def test_a_callback_from_someone_elses_attempt_is_refused(app, google):
    """Login CSRF: an attacker's own callback URL, opened in the victim's browser, must not sign the victim in."""
    attacker = app.test_client()
    r = attacker.get("/api/auth/google/start")
    attacker_state = parse_qs(urlparse(r.headers["Location"]).query)["state"][0]
    victim = app.test_client()
    victim.get("/api/auth/google/start")
    r = victim.get("/api/auth/google/callback", query_string={"state": attacker_state, "code": "abc"})
    assert _where(r) == ("home.html", "expired") and me(victim) is None
    # and with no attempt at all
    r = app.test_client().get("/api/auth/google/callback", query_string={"state": "x", "code": "abc"})
    assert _where(r) == ("home.html", "expired")


def test_each_attempt_works_once_and_not_after_ten_minutes(app, google):
    c = app.test_client()
    r = c.get("/api/auth/google/start")
    state = parse_qs(urlparse(r.headers["Location"]).query)["state"][0]
    assert _where(c.get("/api/auth/google/callback", query_string={"state": state, "code": "abc"}))[1] is None
    c.post("/api/auth/logout")
    assert _where(c.get("/api/auth/google/callback", query_string={"state": state, "code": "abc"}))[1] == "expired"
    old = app.test_client()
    old.get("/api/auth/google/start")
    with old.session_transaction() as s:
        s["google"] = {**s["google"], "at": s["google"]["at"] - 601}
        state = s["google"]["state"]
    assert _where(old.get("/api/auth/google/callback", query_string={"state": state, "code": "abc"}))[1] == "expired"


def test_the_return_page_is_only_ever_a_dashboard_page(app, google):
    for nxt in ("//evil.example/x", "https://evil.example", "../admin", "home.html?x=1", "HOME.html"):
        assert sign_in(app.test_client(), next=nxt)[0] == "home.html"


def test_the_verifier_and_nonce_from_start_reach_the_exchange(app, google):
    c = app.test_client()
    r = c.get("/api/auth/google/start")
    with c.session_transaction() as s:
        expected = (s["google"]["verifier"], s["google"]["nonce"])
    state = parse_qs(urlparse(r.headers["Location"]).query)["state"][0]
    c.get("/api/auth/google/callback", query_string={"state": state, "code": "the-code"})
    assert google[1][-1] == ("the-code", *expected)


# ---- linking Google to a password login -----------------------------------------------------------------------------

def test_a_signed_in_password_login_can_link_google_then_use_either(app, google):
    c = app.test_client()
    c.post("/api/auth/register", json={"email": "parent@gmail.com", "password": "password123"})
    assert sign_in(c, link="1") == ("home.html", None)
    assert me(c)["google"] is True and me(c)["has_password"] is True
    other = app.test_client()
    sign_in(other)
    assert me(other)["id"] == me(c)["id"]


def test_linking_needs_a_signed_in_login_and_a_google_account_nobody_else_uses(app, google):
    assert sign_in(app.test_client(), link="1") == ("home.html", "signed_out")
    sign_in(app.test_client())                                        # g-1 now belongs to parent@gmail.com
    c = app.test_client()
    c.post("/api/auth/register", json={"email": "someone@x.com", "password": "password123"})
    assert sign_in(c, link="1") == ("home.html", "in_use")
    assert me(c)["google"] is False


# ---- disconnect codes -----------------------------------------------------------------------------------------------

def _code(c, device_id):
    csrf = c.get("/api/auth/me").get_json()["csrf"]
    return c.post(f"/api/devices/{device_id}/disconnect-code", headers={"X-CSRF-Token": csrf})


def test_a_dashboard_disconnect_code_lets_that_browser_leave_once(app):
    c, ext, _ = paired(app)
    device_id = Device.query.one().id
    r = _code(c, device_id)
    assert r.status_code == 200 and len(r.get_json()["code"]) == 8
    leave = lambda body: app.test_client().post("/api/ext/disconnect", json=body, headers=ext)
    assert leave({"code": "WRONGXYZ"}).status_code == 403
    assert leave({"code": r.get_json()["code"].lower()}).status_code == 200
    assert Device.query.one().revoked is True


def test_a_disconnect_code_expires_and_is_only_for_its_own_browser(app):
    c, ext, _ = paired(app)
    dev = Device.query.one()
    code = _code(c, dev.id).get_json()["code"]
    dev.disconnect_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.session.commit()
    assert app.test_client().post("/api/ext/disconnect", json={"code": code}, headers=ext).status_code == 403
    assert Device.query.one().disconnect_code_hash is None and Device.query.one().revoked is False


def test_only_the_parent_can_make_a_disconnect_code(app):
    c, _, _ = paired(app)
    device_id = Device.query.one().id
    stranger = app.test_client()
    stranger.post("/api/auth/register", json={"email": "s@x.com", "password": "password123"})
    assert _code(stranger, device_id).status_code == 404
    assert app.test_client().post(f"/api/devices/{device_id}/disconnect-code").status_code == 401
    assert c.post(f"/api/devices/{device_id}/disconnect-code").status_code == 403       # no CSRF token


def test_the_popup_field_still_takes_the_parents_password(app):
    _, ext, _ = paired(app)
    assert app.test_client().post("/api/ext/disconnect", json={"code": "password123"}, headers=ext).status_code == 200


def test_a_google_only_parent_has_no_password_to_type_but_codes_work(app, google):
    c = app.test_client()
    sign_in(c)
    csrf = c.get("/api/auth/me").get_json()["csrf"]
    h = {"X-CSRF-Token": csrf}
    cid = c.post("/api/children", json={"name": "K"}, headers=h).get_json()["id"]
    pair = c.post(f"/api/children/{cid}/devices", json={}, headers=h).get_json()["pairing_code"]
    ext = {"Authorization": "Bearer " + app.test_client().post("/api/devices/pair", json={"code": pair}).get_json()["token"]}
    for body in ({}, {"password": ""}, {"code": ""}):
        assert app.test_client().post("/api/ext/disconnect", json=body, headers=ext).status_code == 403
    code = _code(c, Device.query.one().id).get_json()["code"]
    assert app.test_client().post("/api/ext/disconnect", json={"code": code}, headers=ext).status_code == 200


# ---- the exchange with Google itself --------------------------------------------------------------------------------

class _Resp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


def test_the_exchange_believes_only_a_verified_token_with_our_nonce(monkeypatch):
    cfg = {"GOOGLE_CLIENT_ID": "cid", "GOOGLE_CLIENT_SECRET": "s", "API_ORIGIN": "https://api.example"}
    posted = []
    monkeypatch.setattr(google_auth.requests, "post", lambda url, **kw: posted.append(kw["data"]) or _Resp(200, {"id_token": "t"}))
    claims = {"sub": "1", "email": "A@Gmail.com", "email_verified": True, "nonce": "n"}
    monkeypatch.setattr(google_auth.id_token, "verify_oauth2_token", lambda tok, req, aud, **kw: dict(claims))
    assert google_auth.claims_for_code(cfg, "code", "verifier", "n") == {"sub": "1", "email": "a@gmail.com", "email_verified": True}
    assert posted[0]["code_verifier"] == "verifier" and posted[0]["redirect_uri"] == "https://api.example/api/auth/google/callback"

    with pytest.raises(google_auth.GoogleAuthError):
        google_auth.claims_for_code(cfg, "code", "verifier", "another-nonce")
    claims["email_verified"] = "true"                                 # only a real boolean true counts
    assert google_auth.claims_for_code(cfg, "code", "verifier", "n")["email_verified"] is False

    def bad_token(*a, **kw):
        raise ValueError("Token expired")
    monkeypatch.setattr(google_auth.id_token, "verify_oauth2_token", bad_token)
    with pytest.raises(google_auth.GoogleAuthError):
        google_auth.claims_for_code(cfg, "code", "verifier", "n")
    monkeypatch.setattr(google_auth.requests, "post", lambda url, **kw: _Resp(400, {"error": "invalid_grant"}))
    with pytest.raises(google_auth.GoogleAuthError):
        google_auth.claims_for_code(cfg, "code", "verifier", "n")
    with pytest.raises(google_auth.GoogleAuthError):
        google_auth.claims_for_code(cfg, "", "verifier", "n")


# ---- production settings --------------------------------------------------------------------------------------------

def test_production_refuses_half_configured_google(app):
    base = {k: getattr(Config, k) for k in dir(Config) if k.isupper()}
    base.update(SECRET_KEY="k" * 40, SQLALCHEMY_DATABASE_URI="postgresql+psycopg2://u:p@db.example:6543/x?sslmode=require",
                SESSION_COOKIE_SECURE=True, DASHBOARD_ORIGIN="https://app.example", AI_MODE="")
    assert not [p for p in production_problems(base) if "GOOGLE" in p or "API_ORIGIN" in p]
    assert any("GOOGLE_CLIENT_SECRET" in p for p in production_problems({**base, "GOOGLE_CLIENT_ID": "x"}))
    assert any("API_ORIGIN" in p for p in production_problems(
        {**base, "GOOGLE_CLIENT_ID": "x", "GOOGLE_CLIENT_SECRET": "y", "API_ORIGIN": "http://api.example"}))
