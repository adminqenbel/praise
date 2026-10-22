import pathlib
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from database.models import Device
from database.postgres import db
from tests.test_models import app  # noqa: F401  (fixture)


@pytest.fixture()
def client(app):
    return app.test_client()


def register(client, email="p@x.com", pw="password123"):
    r = client.post("/api/auth/register", json={"email": email, "password": pw})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["csrf"]


def test_register_login_logout(client):
    register(client)
    assert client.get("/api/auth/me").status_code == 200
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login",
                       json={"email": "p@x.com", "password": "bad"}).status_code == 401
    assert client.post("/api/auth/login",
                       json={"email": "p@x.com", "password": "password123"}).status_code == 200


def test_register_validation_and_duplicate(client):
    assert client.post("/api/auth/register", json={"email": "nope", "password": "x" * 9}
                       ).status_code == 400
    assert client.post("/api/auth/register", json={"email": "a@b.co", "password": "short"}
                       ).status_code == 400
    register(client)
    assert client.post("/api/auth/register", json={"email": "p@x.com", "password": "password123"}
                       ).status_code == 409


def test_register_cannot_choose_admin_role(client):
    client.post("/api/auth/register",
                json={"email": "a@b.co", "password": "password123", "role": "admin"})
    assert client.get("/api/auth/me").get_json()["user"]["role"] == "parent"


def test_csrf_required_on_mutations(client):
    csrf = register(client)
    assert client.post("/api/children", json={"name": "K"}).status_code == 403
    assert client.post("/api/children", json={"name": "K"},
                       headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert client.post("/api/children", json={"name": "K"},
                       headers={"X-CSRF-Token": csrf}).status_code == 201


def test_pairing_flow_and_one_time_code(client, app):
    csrf = register(client)
    h = {"X-CSRF-Token": csrf}
    cid = client.post("/api/children", json={"name": "K"}, headers=h).get_json()["id"]
    code = client.post(f"/api/children/{cid}/devices", json={}, headers=h
                       ).get_json()["pairing_code"]
    ext = app.test_client()  # extension has no session
    r = ext.post("/api/devices/pair", json={"code": code.lower()})
    assert r.status_code == 200 and r.get_json()["token"]
    assert r.get_json()["mode"] == "family"
    assert ext.post("/api/devices/pair", json={"code": code}).status_code == 400  # burned
    assert ext.post("/api/devices/pair", json={"code": "ZZZZZZZZ"}).status_code == 400


def test_expired_code_rejected(client, app):
    csrf = register(client)
    h = {"X-CSRF-Token": csrf}
    cid = client.post("/api/children", json={"name": "K"}, headers=h).get_json()["id"]
    r = client.post(f"/api/children/{cid}/devices", json={}, headers=h).get_json()
    d = db.session.get(Device, r["device_id"])
    d.pairing_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.session.commit()
    assert app.test_client().post("/api/devices/pair", json={"code": r["pairing_code"]}
                                  ).status_code == 400


def test_parent_cannot_touch_other_parents_child(client, app):
    csrf = register(client)
    cid = client.post("/api/children", json={"name": "K"}, headers={"X-CSRF-Token": csrf}
                      ).get_json()["id"]
    other = app.test_client()
    csrf2 = other.post("/api/auth/register", json={"email": "o@x.com", "password": "password123"}
                       ).get_json()["csrf"]
    h2 = {"X-CSRF-Token": csrf2}
    assert other.post(f"/api/children/{cid}/devices", json={}, headers=h2).status_code == 404
    assert other.get("/api/children").get_json()["children"] == []


def test_revoke_invalidates_token(client, app):
    from flask import g
    from services.auth_service import device_required

    @app.get("/_probe")
    @device_required
    def probe():
        return {"device": g.device.id}

    csrf = register(client)
    h = {"X-CSRF-Token": csrf}
    cid = client.post("/api/children", json={"name": "K"}, headers=h).get_json()["id"]
    dev = client.post(f"/api/children/{cid}/devices", json={}, headers=h).get_json()
    token = app.test_client().post("/api/devices/pair", json={"code": dev["pairing_code"]}
                                   ).get_json()["token"]

    bearer = {"Authorization": f"Bearer {token}"}
    assert app.test_client().get("/_probe", headers=bearer).status_code == 200
    assert app.test_client().get("/_probe").status_code == 401
    client.post(f"/api/devices/{dev['device_id']}/revoke", headers=h)
    assert app.test_client().get("/_probe", headers=bearer).status_code == 401
