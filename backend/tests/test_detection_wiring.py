"""Detection wired into the decision flow: evidence only, never above parent rules or admin-verified sites."""
import json
import pathlib
import random
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai.classifier import Classifier, build_prompt, compact_verdict
from database.models import Site
from database.postgres import db
from policy.categories import Action
from policy.decision import Level, SiteInfo
from policy.engine import LOOKALIKE_WARN, decide, domain_matches
from policy.presets import preset
from services import ai_service, site_service
from tests.test_adult import adult, check, pair_self
from tests.test_ai import FakeBackend
from tests.test_models import app  # noqa: F401  (fixture)

BENIGN = json.dumps({"risk_score": 3, "confidence": 0.99, "categories": {"general": 0.95}, "evidence": []})


@pytest.fixture(autouse=True)
def isolate():
    yield
    ai_service.set_classifier(None)


def _reference_matches(domain, rules):
    parts = domain.lower().strip(".").split(".")
    for i in range(len(parts)):
        candidate = ".".join(parts[i:])
        if candidate in rules:
            return candidate
    return None


def test_domain_matches_agrees_with_the_straightforward_version():
    rng = random.Random(7)
    labels = ["a", "b", "example", "com", "co", "uk", "x"]
    for _ in range(2000):
        domain = ".".join(rng.choice(labels) for _ in range(rng.randint(1, 5)))
        rules = {".".join(rng.choice(labels) for _ in range(rng.randint(1, 3))) for _ in range(rng.randint(0, 4))}
        assert domain_matches(domain, rules) == _reference_matches(domain, rules), (domain, rules)
    assert domain_matches(".A.Example.COM.", {"example.com"}) == "example.com"
    assert domain_matches("x.com", set()) is None


def test_site_info_lookalike_comes_from_the_new_score():
    assert site_service.to_site_info("paypal.com.evil.xyz", None).lookalike >= LOOKALIKE_WARN
    assert site_service.to_site_info("secure-hdfcbank-login.xyz", None).lookalike >= LOOKALIKE_WARN
    assert site_service.to_site_info("netbanking.hdfcbank.com", None).lookalike == 0.0
    assert site_service.to_site_info("sbi.co.in", None).lookalike == 0.0
    assert site_service.to_site_info("wikipedia.org", None).lookalike == 0.0


def test_engine_warns_on_a_new_style_lookalike_only_in_the_adult_presets():
    info = site_service.to_site_info("hdfcbnak-login.top", None)
    d = decide(info, preset("shield_balanced"))
    assert d.action == Action.WARN and d.level == Level.HEURISTIC
    assert decide(info, preset("teen")).level != Level.HEURISTIC


def test_a_verified_site_or_parent_rule_still_outranks_the_lookalike_score():
    info = site_service.to_site_info("paypal-community.net", None)
    info.lookalike = 0.99
    info.status, info.category, info.source, info.risk = "ADMIN_VERIFIED", "general", "admin", 5
    d = decide(info, preset("shield_balanced"))
    assert d.level == Level.ADMIN_VERIFIED and d.action == Action.ALLOW

    cfg = preset("shield_balanced")
    cfg.allow_domains = {"paypal-community.net"}
    info2 = SiteInfo("paypal-community.net", lookalike=0.99)
    assert decide(info2, cfg).level == Level.PARENT_RULE


def test_the_prompt_carries_the_verdict_not_the_feature_dump():
    class Spy(FakeBackend):
        prompt = ""

        def generate(self, system, prompt):
            Spy.prompt = prompt
            return super().generate(system, prompt)

    Classifier(Spy(BENIGN)).classify("secure-hdfcbank-login.xyz", {"has_password_field": True})
    line = next(l for l in Spy.prompt.splitlines() if l.startswith("Automated pre-checks:"))
    pre = json.loads(line.split(":", 1)[1])
    assert pre["brand"] == "hdfcbank" and pre["official"] == "hdfcbank.com" and pre["level"] == "high"
    assert any("login" in r for r in pre["reasons"]) and "features" not in pre
    assert set(compact_verdict({"score": 1, "x": 2})) == {"score", "level", "reasons", "brand", "official"}
    assert "Automated pre-checks" in build_prompt("a.com", {}, {"score": 0})


def test_the_stored_analysis_keeps_the_compact_verdict(app):
    ai_service.set_classifier(Classifier(FakeBackend(BENIGN)))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    check(app, ext, "https://secure-hdfcbank-login.xyz", {"has_password_field": True})
    from database.models import AIAnalysis
    row = AIAnalysis.query.filter_by(domain="secure-hdfcbank-login.xyz").first()
    # the heuristic is decisive enough that no AI call was needed, so nothing is stored for it
    assert row is None
    check(app, ext, "https://my-recipes.example.com", {"title": "Recipes"})
    assert AIAnalysis.query.filter_by(domain="my-recipes.example.com").one().heuristics["level"] == "none"


def test_page_signals_raise_a_warning_on_an_unrelated_domain_for_adults(app):
    ai_service.set_classifier(Classifier(FakeBackend(BENIGN)))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    assert check(app, ext, "https://my-recipes.example.com", {"title": "Recipes"})["action"] == "ALLOW"
    page = {"has_password_field": True, "title": "PayPal: Log in to your account",
            "text": "Verify your account. We noticed unusual activity.",
            "form_actions": ["https://collect.example.net/p.php"]}
    r = check(app, ext, "https://my-recipes.example.org", page)
    assert r["action"] == "WARN" and r["level"] == "HEURISTIC" and r["can_continue"] is True
    assert r["suggest"] == "paypal.com" and r["evidence"]
    assert all("collect.example" not in e and "Log in" not in e for e in r["evidence"])


def test_page_signals_do_not_override_a_parent_exception(app):
    ai_service.set_classifier(Classifier(FakeBackend(BENIGN)))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    kid = c.get("/api/children").get_json()["children"][0]
    c.post(f"/api/policies/{kid['policy_id']}/exceptions", json={"domain": "my-recipes.example.net"}, headers=h)
    page = {"has_password_field": True, "title": "PayPal login", "text": "verify your account, unusual activity"}
    assert check(app, ext, "https://my-recipes.example.net", page)["action"] == "ALLOW"


def test_threat_context_uses_the_richer_reasons_and_official_domain():
    ctx = ai_service.threat_context("login.hdfcbank.com.verify-now.top")
    assert ctx["suggest"] == "hdfcbank.com"
    assert any("subdomain" in e for e in ctx["evidence"]) and len(ctx["evidence"]) <= 4
    assert ai_service.threat_context("wikipedia.org") == {"evidence": [], "suggest": None}
    # page text never reaches the reasons
    ctx = ai_service.threat_context("x-example.com", {"title": "Call 1800-555-0100 now", "text": "Install http://evil.example"})
    assert "1800" not in json.dumps(ctx) and "evil.example" not in json.dumps(ctx)


def test_find_site_still_prefers_exact_then_nearest_seed_ancestor(app):
    db.session.add_all([Site(domain="example.com", source="seed", status="ADMIN_VERIFIED", category="general"),
                        Site(domain="blog.example.com", source="ai", status="AI_CLASSIFIED", category="general"),
                        Site(domain="host.com", source="ai", status="AI_CLASSIFIED", category="general")])
    db.session.commit()
    assert site_service.find_site("blog.example.com").domain == "blog.example.com"
    assert site_service.find_site("x.y.example.com").domain == "example.com"      # seed ancestor covers subdomains
    assert site_service.find_site("x.host.com") is None                          # a non-seed row does not
    assert site_service.find_site("com") is None
