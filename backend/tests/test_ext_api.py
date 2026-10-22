import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai.classifier import Classifier
from database.models import Child, Policy, PolicyRule, Site
from database.postgres import db
from services import ai_service, event_service, site_service
from tests.test_ai import FakeBackend
from tests.test_models import app  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def no_real_mongo(monkeypatch):
    sink = []
    monkeypatch.setattr(event_service, "insert", lambda coll, doc: sink.append((coll, doc)) or True)
    yield sink
    ai_service.set_classifier(None)


def paired(app, preset_policy=None):
    """Create parent+child+device through the real API; return (parent_client, ext_headers)."""
    c = app.test_client()
    csrf = c.post("/api/auth/register", json={"email": "p@x.com", "password": "password123"}
                  ).get_json()["csrf"]
    h = {"X-CSRF-Token": csrf}
    cid = c.post("/api/children", json={"name": "K"}, headers=h).get_json()["id"]
    code = c.post(f"/api/children/{cid}/devices", json={}, headers=h).get_json()["pairing_code"]
    token = app.test_client().post("/api/devices/pair", json={"code": code}).get_json()["token"]
    if preset_policy:
        child = db.session.get(Child, cid)
        child.policy = preset_policy
        db.session.commit()
    return c, {"Authorization": f"Bearer {token}"}, cid


def gambling_backend():
    return FakeBackend()  # GOOD fixture: gambling 0.93, risk 91


def test_requires_device_token(app):
    assert app.test_client().post("/api/ext/check", json={"url": "https://a.com"}).status_code == 401


def test_bad_url_rejected(app):
    _, h, _ = paired(app)
    ext = app.test_client()
    assert ext.post("/api/ext/check", json={"url": "chrome://settings"}, headers=h).status_code == 400


def test_unknown_gambling_site_blocked_stored_and_second_call_skips_ai(app, no_real_mongo):
    backend = gambling_backend()
    ai_service.set_classifier(Classifier(backend))
    _, h, _ = paired(app)  # no policy assigned => child_safe
    ext = app.test_client()

    r = ext.post("/api/ext/check", json={"url": "https://www.unknownsite.com/x", "signals": {}}, headers=h)
    body = r.get_json()
    assert body["action"] == "BLOCK" and body["category"] == "gambling" and body["risk"] == 91
    assert body["ai"] == "classified" and backend.calls == 1

    r2 = ext.post("/api/ext/check", json={"url": "https://unknownsite.com/other"}, headers=h)
    assert r2.get_json()["action"] == "BLOCK" and r2.get_json()["ai"] == "not_needed"
    assert backend.calls == 1  # no second Gemini call
    assert Site.query.one().status == "AI_CLASSIFIED"
    assert any(c == "browser_events" for c, _ in no_real_mongo)


def test_ai_unavailable_falls_back_to_unknown_default(app):
    from ai.gemini import UnavailableBackend
    ai_service.set_classifier(Classifier(UnavailableBackend()))
    _, h, _ = paired(app)
    body = app.test_client().post("/api/ext/check", json={"url": "https://n.com", "signals": {}}, headers=h
                                  ).get_json()
    assert body["action"] == "BLOCK" and body["ai"] == "unavailable"  # child_safe: unknown=BLOCK
    assert body["level"] == "UNKNOWN_DEFAULT"


def test_parent_allow_rule_skips_ai_entirely(app):
    backend = gambling_backend()
    ai_service.set_classifier(Classifier(backend))
    c, h, cid = paired(app)
    pol = Policy(owner_id=1, name="P", unknown_action="BLOCK")
    from database.models import DomainRule
    pol.domain_rules.append(DomainRule(domain="school.edu", action="ALLOW"))
    db.session.add(pol)
    db.session.flush()
    db.session.get(Child, cid).policy_id = pol.id
    db.session.commit()
    body = app.test_client().post("/api/ext/check", json={"url": "https://portal.school.edu"},
                                  headers=h).get_json()
    assert body["action"] == "ALLOW" and body["level"] == "PARENT_RULE" and backend.calls == 0


def test_admin_verified_site_blocks_without_ai(app):
    backend = gambling_backend()
    ai_service.set_classifier(Classifier(backend))
    _, h, _ = paired(app)
    s = site_service.get_or_create_site("verified.com")
    s.category, s.risk, s.source, s.status = "gambling", 95, "admin", "ADMIN_VERIFIED"
    db.session.commit()
    body = app.test_client().post("/api/ext/check", json={"url": "http://verified.com"},
                                  headers=h).get_json()
    assert body["action"] == "BLOCK" and body["level"] == "ADMIN_VERIFIED" and backend.calls == 0


def test_policy_sync_reflects_policy(app):
    pol = Policy(owner_id=1, name="P", unknown_action="REVIEW")
    pol.rules.append(PolicyRule(category="gambling", action="BLOCK"))
    c, h, cid = paired(app, preset_policy=None)
    db.session.add(pol)
    db.session.flush()
    db.session.get(Child, cid).policy_id = pol.id
    db.session.commit()
    snap = app.test_client().get("/api/ext/policy-sync", headers=h).get_json()
    assert snap["category_actions"]["gambling"] == "BLOCK" and snap["unknown_action"] == "REVIEW"


def test_events_batch_validated_and_clipped(app, no_real_mongo):
    _, h, _ = paired(app)
    evs = [{"kind": "download", "data": {"filename": "a.exe", "$where": "x", "n.o": 1,
                                         "big": "z" * 9999}},
           {"kind": "nonsense", "data": {}}, "junk"]
    r = app.test_client().post("/api/ext/events", json={"events": evs}, headers=h).get_json()
    assert r == {"accepted": 1, "rejected": 2}
    doc = no_real_mongo[-1][1]
    assert "$where" not in doc and "n.o" not in doc and len(doc["big"]) == 2000
    assert doc["child_id"] and doc["device_id"]


def test_unknown_site_without_signals_asks_extension_for_them(app):
    backend = gambling_backend()
    ai_service.set_classifier(Classifier(backend))
    _, h, _ = paired(app)
    body = app.test_client().post("/api/ext/check", json={"url": "https://fresh.com"},
                                  headers=h).get_json()
    assert body["need_signals"] is True and body["cache_ttl"] == 0 and backend.calls == 0
    again = app.test_client().post("/api/ext/check",
                                   json={"url": "https://fresh.com", "signals": {"title": "x"}},
                                   headers=h).get_json()
    assert again["ai"] == "classified" and backend.calls == 1


def test_seeded_google_is_allowed_under_child_safe_without_ai(app):
    from services.seed_sites import seed_sites
    backend = gambling_backend()
    ai_service.set_classifier(Classifier(backend))
    seed_sites()
    _, h, _ = paired(app)                       # no policy => strict child_safe
    ext = app.test_client()
    for url in ("https://www.google.com/search?q=x", "https://accounts.google.com/", "https://en.wikipedia.org/"):
        r = ext.post("/api/ext/check", json={"url": url}, headers=h).get_json()
        assert r["action"] == "ALLOW" and r["level"] == "ADMIN_VERIFIED", (url, r)
    # same list, same policy: seeded social media / money sites are closed
    assert ext.post("/api/ext/check", json={"url": "https://instagram.com"}, headers=h).get_json()["action"] == "BLOCK"
    assert ext.post("/api/ext/check", json={"url": "https://paypal.com"}, headers=h).get_json()["category"] == "payment"
    assert backend.calls == 0


def test_policy_sync_lists_verified_sites_for_offline_use(app):
    from services.seed_sites import seed_sites
    seed_sites()
    _, h, _ = paired(app)
    v = app.test_client().get("/api/ext/policy-sync", headers=h).get_json()["verified"]
    assert "google.com" in v["allow"] and "instagram.com" in v["block"] and "paypal.com" in v["block"]


def test_family_policy_sync_tells_the_extension_it_is_the_family_version(app):
    _c, ext, _ = paired(app)
    assert app.test_client().get("/api/ext/policy-sync", headers=ext).get_json()["mode"] == "family"
