import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai.classifier import Classifier
from app import create_app
from database.models import Site, SiteReview, User
from database.postgres import db
from services import ai_service, event_service
from services.ratelimit import limiter
from tests.test_ai import FakeBackend
from tests.test_dashboard_api import make_admin, pair_child, register
from tests.test_models import TestConfig, app  # noqa: F401  (fixture)

BENIGN = json.dumps({"risk_score": 5, "confidence": 0.95,
                     "categories": {"education": 0.95}, "evidence": ["looks like a school"]})


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(event_service, "insert", lambda c, d: True)
    yield
    ai_service.set_classifier(None)


def check(app, headers, url, signals=None):
    body = {"url": url}
    if signals is not None:
        body["signals"] = signals
    return app.test_client().post("/api/ext/check", json=body, headers=headers).get_json()


# ---- finding 1: one parent must not be able to unverify a shared site -------------------

def test_dispute_cannot_unverify_a_shared_site_but_reaches_the_admin(app):
    from services.seed_sites import seed_sites
    seed_sites()
    c, h = register(app, "p@x.com")
    r = c.post("/api/sites/google.com/dispute", json={"note": "blocks my homework"}, headers=h)
    assert r.status_code == 200 and r.get_json()["status"] == "ADMIN_VERIFIED"

    # every other family still gets the verified answer
    c2, h2 = register(app, "o@x.com")
    _, ext = pair_child(app, c2, h2)
    assert check(app, ext, "https://www.google.com")["action"] == "ALLOW"

    admin, ah = make_admin(app)
    queue = admin.get("/api/admin/reviews").get_json()["sites"]
    assert [s["domain"] for s in queue] == ["google.com"]
    sid = queue[0]["id"]
    admin.post(f"/api/admin/reviews/{sid}", json={"action": "ALLOW", "category": "general", "note": "kept"},
               headers=ah)
    assert admin.get("/api/admin/reviews").get_json()["sites"] == []     # resolved once an admin acts


# ---- finding 2: fabricated page signals must not loosen rules for other families ------------

def test_low_risk_ai_verdict_is_trusted_only_by_the_family_that_produced_it(app):
    backend = FakeBackend(BENIGN)
    ai_service.set_classifier(Classifier(backend))
    c1, h1 = register(app, "a@x.com")
    _, ext1 = pair_child(app, c1, h1)
    c2, h2 = register(app, "b@x.com")
    _, ext2 = pair_child(app, c2, h2)

    mine = check(app, ext1, "https://poison.example.com", {"title": "University course"})
    assert mine["category"] == "education" and mine["action"] == "ALLOW"

    # another family's device does NOT inherit that unverified, permissive verdict
    theirs = check(app, ext2, "https://poison.example.com")
    assert theirs["action"] == "BLOCK" and theirs["level"] == "UNKNOWN_DEFAULT"
    assert theirs["ai"] == "not_needed" and backend.calls == 1

    # once an admin verifies it, everyone gets it
    admin, ah = make_admin(app)
    sid = Site.query.filter_by(domain="poison.example.com").one().id
    admin.post(f"/api/admin/reviews/{sid}", json={"action": "ALLOW", "category": "education"}, headers=ah)
    assert check(app, ext2, "https://poison.example.com")["action"] == "ALLOW"


def test_high_risk_ai_verdict_is_shared_because_it_only_tightens(app):
    ai_service.set_classifier(Classifier(FakeBackend()))        # gambling, risk 91
    c1, h1 = register(app, "a@x.com")
    _, ext1 = pair_child(app, c1, h1)
    c2, h2 = register(app, "b@x.com")
    _, ext2 = pair_child(app, c2, h2)
    check(app, ext1, "https://casino.example.com", {})
    r = check(app, ext2, "https://casino.example.com")
    assert r["action"] == "BLOCK" and r["category"] == "gambling" and r["level"] == "AI"


# ---- finding 4: a family cannot drain the shared AI budget ------------------------------------

def test_family_ai_quota(app):
    class Limited(TestConfig):
        RATELIMIT_ENABLED = True
    limiter.reset()
    app2 = create_app(Limited)
    with app2.app_context():
        db.create_all()
        backend = FakeBackend(BENIGN)
        ai_service.set_classifier(Classifier(backend))
        c, h = register(app2, "q@x.com")
        _, ext = pair_child(app2, c, h)
        states = [check(app2, ext, f"https://site{i}.example.com", {})["ai"] for i in range(45)]
        assert states.count("classified") == 40 and states[40:] == ["unavailable"] * 5
        assert backend.calls == 40
        db.session.remove()
        db.drop_all()
    limiter.reset()


# ---- finding 5: an admin decision made during a slow AI call wins ---------------------------------

def test_admin_verification_during_ai_call_is_not_overwritten(app):
    class RacingBackend(FakeBackend):
        def generate(self, system, prompt):
            # while the "provider" is thinking, an admin verifies the site as education
            s = Site.query.filter_by(domain="race.example.com").one()
            s.category, s.source, s.status, s.risk = "education", "admin", "ADMIN_VERIFIED", 0
            db.session.commit()
            return super().generate(system, prompt)

    ai_service.set_classifier(Classifier(RacingBackend()))        # would answer gambling / 91
    c, h = register(app, "r@x.com")
    _, ext = pair_child(app, c, h)
    r = check(app, ext, "https://race.example.com", {})
    site = Site.query.filter_by(domain="race.example.com").one()
    assert (site.category, site.source, site.status) == ("education", "admin", "ADMIN_VERIFIED")
    assert r["level"] == "ADMIN_VERIFIED"


# ---- demo-account cleanup ---------------------------------------------------------------------------

def test_purge_demo_removes_only_demo_accounts(app):
    c, h = register(app, "parent@demo.test")
    pair_child(app, c, h)
    register(app, "real@family.com")
    out = app.test_cli_runner().invoke(args=["purge-demo"])
    assert "removed 1" in out.output
    assert [u.email for u in User.query.all()] == ["real@family.com"]
