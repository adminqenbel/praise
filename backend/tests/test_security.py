import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import create_app
from database.postgres import db
from services.ratelimit import RateLimiter, limiter
from tests.test_models import TestConfig, app  # noqa: F401  (fixture)


class LimitedConfig(TestConfig):
    RATELIMIT_ENABLED = True


@pytest.fixture()
def limited_app():
    limiter.reset()
    app = create_app(LimitedConfig)
    with app.app_context():
        db.create_all()
        yield app
        db.session.remove()
        db.drop_all()
    limiter.reset()


def test_limiter_window_and_independent_keys():
    rl = RateLimiter()
    assert all(rl.allow("a", 3, 60)[0] for _ in range(3))
    ok, retry = rl.allow("a", 3, 60)
    assert not ok and 1 <= retry <= 61
    assert rl.allow("b", 3, 60)[0]                       # other keys unaffected
    rl2 = RateLimiter()
    assert rl2.allow("x", 1, 0.05)[0]
    import time
    time.sleep(0.08)
    assert rl2.allow("x", 1, 0.05)[0]                    # window expired


def test_login_brute_force_is_throttled_per_account(limited_app):
    c = limited_app.test_client()
    c.post("/api/auth/register", json={"email": "v@x.com", "password": "password123"})
    c.post("/api/auth/logout")
    codes = [c.post("/api/auth/login", json={"email": "v@x.com", "password": f"guess{i}"}).status_code
             for i in range(10)]
    assert codes[:8] == [401] * 8 and codes[8:] == [429, 429]
    r = c.post("/api/auth/login", json={"email": "v@x.com", "password": "password123"})
    assert r.status_code == 429 and "Retry-After" in r.headers      # even the right password waits
    # a different account from the same IP is not locked out by that
    assert c.post("/api/auth/login", json={"email": "other@x.com", "password": "x"}).status_code == 401


def test_pairing_code_guessing_is_throttled(limited_app):
    c = limited_app.test_client()
    codes = [c.post("/api/devices/pair", json={"code": "ABCD2345"}).status_code for _ in range(12)]
    assert codes[:10] == [400] * 10 and codes[10:] == [429, 429]


def test_registration_flood_is_throttled(limited_app):
    c = limited_app.test_client()
    codes = [c.post("/api/auth/register", json={"email": f"u{i}@x.com", "password": "password123"}).status_code
             for i in range(12)]
    assert codes[:10] == [201] * 10 and 429 in codes[10:]


def test_oversized_body_rejected(app_client=None):
    app = create_app(TestConfig)
    r = app.test_client().post("/api/auth/login", data=b"x" * (3 * 1024 * 1024),
                               content_type="application/json")
    assert r.status_code == 413


def test_huge_password_not_hashed(limited_app):
    c = limited_app.test_client()
    r = c.post("/api/auth/register", json={"email": "p@x.com", "password": "x" * 5000})
    assert r.status_code == 400
    assert c.post("/api/auth/login", json={"email": "p@x.com", "password": "x" * 5000}).status_code == 401


def test_security_headers_and_no_store(limited_app):
    r = limited_app.test_client().get("/api/auth/me")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Cache-Control"] == "no-store"
    assert r.headers["Referrer-Policy"] == "no-referrer"


def test_cors_only_allows_the_dashboard_origin(limited_app):
    c = limited_app.test_client()
    ok = c.get("/health", headers={"Origin": limited_app.config["DASHBOARD_ORIGIN"]})
    assert ok.headers.get("Access-Control-Allow-Origin") == limited_app.config["DASHBOARD_ORIGIN"]
    assert ok.headers.get("Access-Control-Allow-Credentials") == "true"
    evil = c.get("/health", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in evil.headers


def test_the_browser_may_remember_the_cors_permission_check(limited_app):
    pre = limited_app.test_client().options("/api/children", headers={
        "Origin": limited_app.config["DASHBOARD_ORIGIN"], "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token"})
    assert pre.status_code == 200 and pre.headers["Access-Control-Max-Age"] == "7200"
    assert pre.headers["Access-Control-Allow-Origin"] == limited_app.config["DASHBOARD_ORIGIN"]
    assert "x-csrf-token" in pre.headers["Access-Control-Allow-Headers"].lower()


def test_session_cookie_flags(limited_app):
    r = limited_app.test_client().post("/api/auth/register",
                                       json={"email": "c@x.com", "password": "password123"})
    cookie = r.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie


def test_parent_cannot_use_another_parents_device_endpoints(limited_app):
    a = limited_app.test_client()
    csrf = a.post("/api/auth/register", json={"email": "a@x.com", "password": "password123"}).get_json()["csrf"]
    cid = a.post("/api/children", json={"name": "K"}, headers={"X-CSRF-Token": csrf}).get_json()["id"]
    dev = a.post(f"/api/children/{cid}/devices", json={}, headers={"X-CSRF-Token": csrf}).get_json()
    b = limited_app.test_client()
    csrf_b = b.post("/api/auth/register", json={"email": "b@x.com", "password": "password123"}).get_json()["csrf"]
    assert b.post(f"/api/devices/{dev['device_id']}/revoke", headers={"X-CSRF-Token": csrf_b}).status_code == 404


class ProductionConfig(TestConfig):
    PRAISE_ENV = "production"
    TESTING = False
    SECRET_KEY = "k" * 48
    SQLALCHEMY_DATABASE_URI = "postgresql://praise:pw@db.example.com:6543/postgres?sslmode=require"
    SESSION_COOKIE_SECURE = True
    DASHBOARD_ORIGIN = "https://app.example.com"
    AI_MODE = ""


@pytest.mark.parametrize("change, fragment", [
    ({"SECRET_KEY": "dev-only-change-me"}, "SECRET_KEY"),
    ({"SECRET_KEY": "short"}, "SECRET_KEY"),
    ({"SQLALCHEMY_DATABASE_URI": "postgresql+psycopg2://postgres:postgres@localhost:5432/praise"}, "DATABASE_URL"),
    ({"SQLALCHEMY_DATABASE_URI": "postgresql://praise:pw@db.example.com:6543/postgres"}, "sslmode"),
    ({"AI_MODE": "mock"}, "AI_MODE"),
    ({"SESSION_COOKIE_SECURE": False}, "SESSION_COOKIE_SECURE"),
    ({"DASHBOARD_ORIGIN": "http://app.example.com"}, "DASHBOARD_ORIGIN"),
])
def test_production_refuses_to_start_on_unsafe_settings(change, fragment):
    bad = type("Bad", (ProductionConfig,), change)
    with pytest.raises(RuntimeError, match=fragment):
        create_app(bad)


def test_production_starts_with_safe_settings():
    class Safe(ProductionConfig):
        SQLALCHEMY_DATABASE_URI = "postgresql+psycopg2://praise:pw@db.example.com:6543/postgres?sslmode=require"
    assert create_app(Safe).config["PRAISE_ENV"] == "production"


def test_hosted_database_urls_use_psycopg2():
    from config import database_url
    assert database_url("postgresql://u:p@h:6543/postgres").startswith("postgresql+psycopg2://u:p@h")
    assert database_url("postgres://u:p@h/db") == "postgresql+psycopg2://u:p@h/db"
    assert database_url("sqlite://") == "sqlite://"


def test_rate_limits_see_the_client_behind_one_trusted_proxy():
    class Proxied(LimitedConfig):
        TRUSTED_PROXY_HOPS = 1
    limiter.reset()
    app = create_app(Proxied)
    with app.app_context():
        db.create_all()
        c = app.test_client()
        # the proxy appends the address it saw; anything earlier in the header is the client's own claim
        hdr = lambda ip: {"X-Forwarded-For": f"6.6.6.6, {ip}"}
        codes = [c.post("/api/devices/pair", json={"code": "ABCD2345"}, headers=hdr("1.1.1.1")).status_code
                 for _ in range(11)]
        assert codes[-1] == 429
        assert c.post("/api/devices/pair", json={"code": "ABCD2345"}, headers=hdr("2.2.2.2")).status_code == 400
        db.session.remove()
        db.drop_all()
    limiter.reset()


def test_injection_shaped_inputs_are_inert(limited_app):
    c = limited_app.test_client()
    csrf = c.post("/api/auth/register", json={"email": "i@x.com", "password": "password123"}).get_json()["csrf"]
    h = {"X-CSRF-Token": csrf}
    # SQL-ish and operator-ish strings are treated as plain data
    assert c.get("/api/sites?q=%27%3B%20DROP%20TABLE%20users%3B--").status_code == 200
    assert c.get("/api/sites?status=%27%20OR%201%3D1").get_json()["sites"] == []
    assert c.get("/api/events?kind=browser&type[$ne]=x").status_code == 200   # becomes a harmless param
    r = c.post("/api/children", json={"name": "<script>alert(1)</script>"}, headers=h)
    assert r.status_code == 201          # stored as text; the dashboard renders with textContent
    assert c.post("/api/auth/login", json={"email": {"$ne": ""}, "password": {"$ne": ""}}).status_code == 401


# ---- health checks (host probe and keep-awake monitor) ----------------------------------------------------------------

def test_health_answers_without_touching_the_database(app):
    r = app.test_client().get("/health")
    assert r.status_code == 200 and r.get_json() == {"status": "ok"}


def test_ready_checks_the_database_and_reports_an_outage(app, monkeypatch):
    c = app.test_client()
    r = c.get("/health/ready")
    assert r.status_code == 200 and r.get_json() == {"status": "ok", "database": "ok"}

    def down(*a, **kw):
        raise RuntimeError("connection refused")
    monkeypatch.setattr(db.session, "execute", down)
    r = c.get("/health/ready")
    assert r.status_code == 503 and r.get_json() == {"status": "degraded", "database": "down"}
    assert "connection refused" not in r.get_data(as_text=True)          # no internals in the answer
    assert c.get("/health").status_code == 200                           # the host's own probe is unaffected


def test_ready_is_rate_limited(limited_app):
    c = limited_app.test_client()
    assert all(c.get("/health/ready").status_code == 200 for _ in range(60))
    assert c.get("/health/ready").status_code == 429
