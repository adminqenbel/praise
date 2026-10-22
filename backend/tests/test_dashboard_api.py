import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai.classifier import Classifier
from database.models import Site, User
from database.postgres import db
from services import ai_service
from services.auth_service import hash_password
from tests.test_ai import FakeBackend
from tests.test_models import TestConfig, app  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def reset_ai():
    yield
    ai_service.set_classifier(None)


def register(app, email):
    c = app.test_client()
    r = c.post("/api/auth/register", json={"email": email, "password": "password123"})
    return c, {"X-CSRF-Token": r.get_json()["csrf"]}


def make_admin(app):
    db.session.add(User(email="admin@x.com", password_hash=hash_password("adminpass1"), role="admin"))
    db.session.commit()
    c = app.test_client()
    r = c.post("/api/auth/login", json={"email": "admin@x.com", "password": "adminpass1"})
    return c, {"X-CSRF-Token": r.get_json()["csrf"]}


def pair_child(app, c, h, name="K"):
    cid = c.post("/api/children", json={"name": name}, headers=h).get_json()["id"]
    code = c.post(f"/api/children/{cid}/devices", json={}, headers=h).get_json()["pairing_code"]
    token = app.test_client().post("/api/devices/pair", json={"code": code}).get_json()["token"]
    return cid, {"Authorization": f"Bearer {token}"}


# ---- policies ---------------------------------------------------------------------------

def test_create_policy_from_preset_and_assign_changes_decisions(app):
    ai_service.set_classifier(Classifier(FakeBackend()))   # always says gambling 0.93
    c, h = register(app, "p@x.com")
    cid, ext = pair_child(app, c, h)

    pol = c.post("/api/policies", json={"name": "Teen", "preset": "teen"}, headers=h).get_json()
    assert pol["rules"]["gambling"] == "BLOCK" and pol["unknown_action"] == "REVIEW"
    c.put(f"/api/children/{cid}/policy", json={"policy_id": pol["id"]}, headers=h)

    # parent allow-listing a domain flips the decision made for the child
    c.post(f"/api/policies/{pol['id']}/domains", json={"domain": "https://Lucky.com/x", "action": "ALLOW"},
           headers=h)
    r = app.test_client().post("/api/ext/check", json={"url": "https://lucky.com"}, headers=ext)
    assert r.get_json()["action"] == "ALLOW" and r.get_json()["level"] == "PARENT_RULE"


def test_policy_validation(app):
    c, h = register(app, "p@x.com")
    pid = c.post("/api/policies", json={"name": "P"}, headers=h).get_json()["id"]
    bad = [
        ("patch", f"/api/policies/{pid}", {"unknown_action": "NUKE"}),
        ("patch", f"/api/policies/{pid}", {"ai_min_confidence": 7}),
        ("patch", f"/api/policies/{pid}", {"settings": {"cookies": {"trackers": "MAYBE"}}}),
        ("patch", f"/api/policies/{pid}", {"settings": {"hacks": {}}}),
        ("put", f"/api/policies/{pid}/rules", {"rules": {"notacategory": "BLOCK"}}),
        ("put", f"/api/policies/{pid}/rules", {"rules": {"adult": "EXPLODE"}}),
        ("post", f"/api/policies/{pid}/domains", {"domain": "localhost", "action": "ALLOW"}),
        ("post", f"/api/policies/{pid}/domains", {"domain": "a.com", "action": "REVIEW"}),
        ("post", f"/api/policies/{pid}/tlds", {"tld": "not a tld!", "action": "BLOCK"}),
    ]
    for method, url, body in bad:
        assert getattr(c, method)(url, json=body, headers=h).status_code == 400, (url, body)


def test_policy_lists_dedupe_and_delete(app):
    c, h = register(app, "p@x.com")
    pid = c.post("/api/policies", json={"name": "P"}, headers=h).get_json()["id"]
    assert c.post(f"/api/policies/{pid}/tlds", json={"tld": "xyz", "action": "BLOCK"}, headers=h).status_code == 201
    assert c.post(f"/api/policies/{pid}/tlds", json={"tld": ".XYZ", "action": "BLOCK"}, headers=h).status_code == 409
    p = c.get(f"/api/policies/{pid}").get_json()
    assert p["tlds"][0]["tld"] == ".xyz"
    assert c.delete(f"/api/policies/{pid}/tlds/{p['tlds'][0]['id']}", headers=h).status_code == 200
    assert c.get(f"/api/policies/{pid}").get_json()["tlds"] == []


def test_settings_roundtrip_reaches_extension_snapshot(app):
    c, h = register(app, "p@x.com")
    cid, ext = pair_child(app, c, h)
    pid = c.post("/api/policies", json={"name": "P", "preset": "teen"}, headers=h).get_json()["id"]
    c.patch(f"/api/policies/{pid}", json={"settings": {"cookies": {"third_party": "BLOCK"}}}, headers=h)
    c.put(f"/api/children/{cid}/policy", json={"policy_id": pid}, headers=h)
    snap = app.test_client().get("/api/ext/policy-sync", headers=ext).get_json()
    assert snap["settings"]["cookies"]["third_party"] == "BLOCK"


def test_other_parents_cannot_read_or_edit_policy(app):
    c, h = register(app, "a@x.com")
    pid = c.post("/api/policies", json={"name": "P"}, headers=h).get_json()["id"]
    o, oh = register(app, "b@x.com")
    assert o.get(f"/api/policies/{pid}").status_code == 404
    assert o.patch(f"/api/policies/{pid}", json={"name": "x"}, headers=oh).status_code == 404
    assert o.post(f"/api/policies/{pid}/domains", json={"domain": "a.com", "action": "ALLOW"},
                  headers=oh).status_code == 404
    assert o.get("/api/policies").get_json()["policies"] == []
    cid, _ = pair_child(app, o, oh)
    assert o.put(f"/api/children/{cid}/policy", json={"policy_id": pid}, headers=oh).status_code == 404


# ---- review queue & shared intelligence -----------------------------------------------------

def test_admin_only_endpoints(app):
    c, h = register(app, "p@x.com")
    assert c.get("/api/admin/reviews").status_code == 403
    assert app.test_client().get("/api/admin/reviews").status_code == 401


def test_shared_intelligence_flow_second_family_blocked_without_ai(app):
    backend = FakeBackend()                                   # gambling 0.93 risk 91
    ai_service.set_classifier(Classifier(backend))

    c1, h1 = register(app, "fam1@x.com")
    _, ext1 = pair_child(app, c1, h1)
    r = app.test_client().post("/api/ext/check", json={"url": "https://unknownsite.com", "signals": {}},
                               headers=ext1).get_json()
    assert r["action"] == "BLOCK" and backend.calls == 1

    admin, ah = make_admin(app)
    queue = admin.get("/api/admin/reviews").get_json()["sites"]
    assert [s["domain"] for s in queue] == ["unknownsite.com"] and queue[0]["risk"] == 91
    sid = queue[0]["id"]

    out = admin.post(f"/api/admin/reviews/{sid}", json={"action": "CONFIRM_BLOCK", "note": "ok"},
                     headers=ah).get_json()
    assert out["status"] == "ADMIN_VERIFIED" and out["source"] == "admin"
    assert admin.get("/api/admin/reviews").get_json()["sites"] == []

    # a different family, a more lenient policy: the verified classification still applies
    c2, h2 = register(app, "fam2@x.com")
    cid2, ext2 = pair_child(app, c2, h2)
    pid = c2.post("/api/policies", json={"name": "T", "preset": "teen"}, headers=h2).get_json()["id"]
    c2.put(f"/api/children/{cid2}/policy", json={"policy_id": pid}, headers=h2)
    r2 = app.test_client().post("/api/ext/check", json={"url": "https://unknownsite.com"},
                                headers=ext2).get_json()
    assert r2["action"] == "BLOCK" and r2["level"] == "ADMIN_VERIFIED" and backend.calls == 1


def test_admin_allow_and_change_category(app):
    ai_service.set_classifier(Classifier(FakeBackend()))
    c, h = register(app, "p@x.com")
    _, ext = pair_child(app, c, h)
    app.test_client().post("/api/ext/check", json={"url": "https://fp.com", "signals": {}}, headers=ext)
    admin, ah = make_admin(app)
    sid = Site.query.filter_by(domain="fp.com").one().id

    assert admin.post(f"/api/admin/reviews/{sid}", json={"action": "CHANGE_CATEGORY"}, headers=ah
                      ).status_code == 400
    assert admin.post(f"/api/admin/reviews/{sid}", json={"action": "CHANGE_CATEGORY", "category": "zzz"},
                      headers=ah).status_code == 400
    out = admin.post(f"/api/admin/reviews/{sid}", json={"action": "ALLOW", "category": "education"},
                     headers=ah).get_json()
    assert out["category"] == "education" and out["risk"] <= 10
    # the false positive is now allowed for every family
    r = app.test_client().post("/api/ext/check", json={"url": "https://fp.com"}, headers=ext).get_json()
    assert r["action"] == "ALLOW"
    assert r["level"] == "ADMIN_VERIFIED"


def test_reanalyze_triggers_fresh_ai_pass_and_ai_cannot_override_verified(app):
    backend = FakeBackend()
    ai_service.set_classifier(Classifier(backend))
    c, h = register(app, "p@x.com")
    _, ext = pair_child(app, c, h)
    chk = lambda: app.test_client().post("/api/ext/check", json={"url": "https://re.com", "signals": {}},
                                         headers=ext).get_json()
    chk()
    admin, ah = make_admin(app)
    sid = Site.query.one().id
    admin.post(f"/api/admin/reviews/{sid}", json={"action": "REANALYZE"}, headers=ah)
    assert Site.query.one().needs_reanalysis
    chk()
    assert backend.calls == 2 and not Site.query.one().needs_reanalysis

    admin.post(f"/api/admin/reviews/{sid}", json={"action": "CHANGE_CATEGORY", "category": "education"},
               headers=ah)
    chk()
    assert backend.calls == 2 and Site.query.one().category == "education"   # AI never overrides


def test_parent_dispute_flags_site_for_review(app):
    ai_service.set_classifier(Classifier(FakeBackend()))
    c, h = register(app, "p@x.com")
    _, ext = pair_child(app, c, h)
    app.test_client().post("/api/ext/check", json={"url": "https://dis.com", "signals": {}}, headers=ext)
    r = c.post("/api/sites/dis.com/dispute", json={"note": "This is my school"}, headers=h)
    assert r.status_code == 200 and r.get_json()["status"] == "REVIEW_REQUIRED"
    admin, _ = make_admin(app)
    assert [s["domain"] for s in admin.get("/api/admin/reviews").get_json()["sites"]] == ["dis.com"]
    assert c.post("/api/sites/never-seen.com/dispute", json={}, headers=h).status_code == 404


# ---- events / stats ---------------------------------------------------------------------------

def test_stats_and_events_scoped_to_own_children(app):
    ai_service.set_classifier(Classifier(FakeBackend()))
    c, h = register(app, "p@x.com")
    cid, ext = pair_child(app, c, h)
    other, oh = register(app, "o@x.com")
    ocid, oext = pair_child(app, other, oh)
    x = app.test_client()
    x.post("/api/ext/check", json={"url": "https://g.com", "signals": {}}, headers=ext)
    x.post("/api/ext/events", headers=ext, json={"events": [
        {"kind": "download", "data": {"kind": "executable", "action": "BLOCK", "ext": "exe"}},
        {"kind": "security", "data": {"type": "external_browser"}},
        {"kind": "cookie", "data": {"type": "cookie", "action": "BLOCKED", "rule": "tracker",
                                    "purpose": "Advertising / tracking"}},
        {"kind": "browser", "data": {"type": "access_request", "domain": "g.com"}}]})
    x.post("/api/ext/check", json={"url": "https://notmine.com", "signals": {}}, headers=oext)

    s = c.get("/api/stats").get_json()
    t = s["totals"]
    assert t["checks"] == 1 and t["blocked"] == 1 and t["ai_classifications"] == 1
    assert t["downloads_blocked"] == 1 and t["trackers_blocked"] == 1 and t["access_requests"] == 1
    assert s["blocked_by_category"] == {"gambling": 1}
    assert s["downloads_by_kind"] == {"executable": 1}
    assert s["security_by_type"] == {"external_browser": 1}
    assert len(s["blocked_per_day"]) == 1

    evs = c.get("/api/events?kind=browser&type=access_request").get_json()["events"]
    assert len(evs) == 1 and evs[0]["domain"] == "g.com" and evs[0]["child_id"] == cid
    assert c.get(f"/api/events?child_id={ocid}").status_code == 404      # someone else's child
    assert c.get("/api/events?kind=bogus").status_code == 400
    assert other.get("/api/stats").get_json()["totals"]["checks"] == 1   # their own data only


def test_event_timestamps_carry_timezone(app):
    c, h = register(app, "p@x.com")
    cid, ext = pair_child(app, c, h)
    app.test_client().post("/api/ext/events", headers=ext,
                           json={"events": [{"kind": "security", "data": {"type": "tamper"}}]})
    ts = c.get("/api/events?kind=security").get_json()["events"][0]["timestamp"]
    assert ts.endswith("+00:00")


def test_events_page_backwards_with_before_cursor(app):
    c, h = register(app, "p@x.com")
    cid, ext = pair_child(app, c, h)
    for i in range(3):
        app.test_client().post("/api/ext/events", headers=ext,
                               json={"events": [{"kind": "security", "data": {"type": f"t{i}"}}]})
    first = c.get("/api/events?kind=security&limit=2").get_json()["events"]
    assert [e["type"] for e in first] == ["t2", "t1"]
    from urllib.parse import quote
    rest = c.get(f"/api/events?kind=security&before={quote(first[-1]['timestamp'])}").get_json()["events"]
    assert [e["type"] for e in rest] == ["t0"]
