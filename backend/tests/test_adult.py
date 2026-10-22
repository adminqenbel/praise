import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai.classifier import Classifier
from ai.heuristics import phishing_signals
from database.models import Child, Policy, Site
from database.postgres import db
from policy.categories import Action
from policy.decision import Level, SiteInfo
from policy.engine import decide
from policy.presets import SHIELD_PRESETS, preset, preset_settings
from services import ai_service
from services.settings_service import SettingsError, validate_settings
from tests.test_ai import FakeBackend
from tests.test_models import app  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def isolate():
    yield
    ai_service.set_classifier(None)


def ai_site(domain, cat, risk, conf=0.9):
    return SiteInfo(domain, status="AI_CLASSIFIED", category=cat, risk=risk, confidence=conf, source="ai")


def adult(app, email="me@x.com"):
    c = app.test_client()
    r = c.post("/api/auth/register", json={"email": email, "password": "password123", "account_type": "adult"})
    assert r.status_code == 201, r.get_json()
    return c, {"X-CSRF-Token": r.get_json()["csrf"]}


def pair_self(app, c, h):
    kid = c.get("/api/children").get_json()["children"][0]
    code = c.post(f"/api/children/{kid['id']}/devices", json={"label": "Laptop"}, headers=h).get_json()["pairing_code"]
    token = app.test_client().post("/api/devices/pair", json={"code": code}).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def check(app, ext, url, signals=None):
    body = {"url": url} if signals is None else {"url": url, "signals": signals}
    return app.test_client().post("/api/ext/check", json=body, headers=ext).get_json()


# ---- engine ---------------------------------------------------------------------------------

def test_warn_flows_from_category_rule_and_is_continuable():
    d = decide(ai_site("x-scam.com", "scam", 88), preset("shield_balanced"))
    assert d.action == Action.WARN and d.level == Level.AI
    assert d.to_dict()["can_continue"] is True
    assert decide(ai_site("m.com", "malware", 99), preset("shield_balanced")).to_dict()["can_continue"] is False


def test_balanced_blocks_malware_warns_on_phishing_strict_blocks_phishing():
    assert decide(ai_site("a.com", "malware", 99), preset("shield_balanced")).action == Action.BLOCK
    assert decide(ai_site("a.com", "phishing", 90), preset("shield_balanced")).action == Action.WARN
    assert decide(ai_site("a.com", "phishing", 90), preset("shield_strict")).action == Action.BLOCK


def test_risky_but_uncategorised_site_gets_warned_only_above_the_threshold():
    cfg = preset("shield_balanced")                       # warn at 70
    assert decide(ai_site("a.com", "general", 75), cfg).action == Action.WARN
    assert decide(ai_site("a.com", "general", 69), cfg).action == Action.ALLOW
    assert decide(ai_site("a.com", "general", 99), preset("custom")).action == Action.ALLOW   # threshold off


def test_unknown_sites_are_allowed_for_adults_and_parent_rules_still_win():
    cfg = preset("shield_balanced")
    assert decide(SiteInfo("new.com"), cfg).action == Action.ALLOW
    cfg.block_domains.add("bad.com")
    assert decide(ai_site("bad.com", "general", 5), cfg).action == Action.BLOCK
    cfg.exceptions.add("scam.com")
    assert decide(ai_site("scam.com", "scam", 90), cfg).action == Action.ALLOW


def test_every_shield_preset_has_valid_settings():
    for name in SHIELD_PRESETS:
        assert validate_settings(preset_settings(name)) == preset_settings(name)


# ---- settings validation -----------------------------------------------------------------------

@pytest.mark.parametrize("bad", [
    {"safe_browsing": {"warn_above_risk": 101}}, {"safe_browsing": {"warn_above_risk": True}},
    {"safe_browsing": {"warn_above_risk": "70"}}, {"privacy": {"block_trackers": "yes"}},
    {"passwords": {"breach_check": 1}}, {"sensitive_data": {"nope": True}}, {"cookies": {"clear_on_close": "x"}},
])
def test_invalid_shield_settings_rejected(bad):
    with pytest.raises(SettingsError):
        validate_settings(bad)


# ---- accounts ----------------------------------------------------------------------------------------

def test_adult_registration_creates_self_profile_with_shield_rules(app):
    c, _ = adult(app)
    me = c.get("/api/auth/me").get_json()["user"]
    assert me["account_type"] == "adult"
    kids = c.get("/api/children").get_json()["children"]
    assert len(kids) == 1 and kids[0]["kind"] == "self" and kids[0]["policy_id"]
    pol = c.get(f"/api/policies/{kids[0]['policy_id']}").get_json()
    assert pol["rules"]["scam"] == "WARN" and pol["rules"]["malware"] == "BLOCK"
    assert pol["unknown_action"] == "ALLOW" and pol["settings"]["privacy"]["block_trackers"] is True


def test_adult_cannot_add_children_and_family_default_is_unchanged(app):
    c, h = adult(app)
    assert c.post("/api/children", json={"name": "Kid"}, headers=h).status_code == 403
    f = app.test_client()
    r = f.post("/api/auth/register", json={"email": "fam@x.com", "password": "password123"})
    assert r.get_json()["user"]["account_type"] == "family"
    assert f.get("/api/children").get_json()["children"] == []


def test_bad_account_type_rejected(app):
    r = app.test_client().post("/api/auth/register",
                               json={"email": "a@x.com", "password": "password123", "account_type": "admin"})
    assert r.status_code == 400


def test_shield_policy_can_be_created_and_edited(app):
    c, h = adult(app)
    p = c.post("/api/policies", json={"name": "Strict", "preset": "shield_strict"}, headers=h).get_json()
    assert p["rules"]["phishing"] == "BLOCK" and p["settings"]["cookies"]["third_party"] == "BLOCK"
    r = c.patch(f"/api/policies/{p['id']}", json={"settings": {"safe_browsing": {"warn_above_risk": 40}}}, headers=h)
    assert r.status_code == 200 and r.get_json()["settings"]["safe_browsing"]["warn_above_risk"] == 40
    assert c.put(f"/api/policies/{p['id']}/rules", json={"rules": {"scam": "WARN"}}, headers=h).status_code == 200


# ---- /check for adults -----------------------------------------------------------------------------------

SCAM = json.dumps({"risk_score": 92, "confidence": 0.9, "categories": {"scam": 0.92},
                   "evidence": ["Claims a prize that needs a fee", "Urgent countdown timer"]})


def test_scam_page_returns_warn_with_reasons_and_can_continue(app):
    ai_service.set_classifier(Classifier(FakeBackend(SCAM)))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    r = check(app, ext, "https://prize-winner-now.example.com", {"title": "You won!"})
    assert r["action"] == "WARN" and r["can_continue"] is True and r["category"] == "scam"
    assert r["cache_ttl"] == 600


def test_lookalike_bank_offers_the_real_site(app):
    ai_service.set_classifier(Classifier(FakeBackend(json.dumps(
        {"risk_score": 95, "confidence": 0.95, "categories": {"financial_phishing": 0.95}, "evidence": []}))))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    r = check(app, ext, "https://secure-hdfcbank-login.xyz", {"has_password_field": True})
    assert r["action"] == "WARN" and r["suggest"] == "hdfcbank.com"
    assert any("hdfc" in e.lower() for e in r["evidence"])


def test_ordinary_unknown_site_is_allowed_for_an_adult(app):
    benign = json.dumps({"risk_score": 5, "confidence": 0.95, "categories": {"general": 0.9}, "evidence": []})
    ai_service.set_classifier(Classifier(FakeBackend(benign)))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    assert check(app, ext, "https://my-recipes.example.com", {})["action"] == "ALLOW"


def test_policy_sync_offline_lists_include_warn(app):
    from services.seed_sites import seed_sites
    seed_sites()
    db.session.add(Site(domain="scammy.example.com", category="scam", risk=90, confidence=1.0,
                        source="admin", status="ADMIN_VERIFIED"))
    db.session.commit()
    c, h = adult(app)
    snap = app.test_client().get("/api/ext/policy-sync", headers=pair_self(app, c, h)).get_json()
    assert "scammy.example.com" in snap["verified"]["warn_exact"]
    assert "google.com" in snap["verified"]["allow"]
    assert snap["settings"]["passwords"]["breach_check"] is True


def test_heuristics_name_the_official_domain():
    h = phishing_signals("paypal-secure-login.top", {"has_password_field": True})
    assert h["brand"] == "paypal" and h["official"] == "paypal.com"
    assert phishing_signals("wikipedia.org")["official"] is None


# ---- deterministic look-alike warning (works with no AI at all) ---------------------------------------

def test_lookalike_warns_adults_even_when_the_ai_is_unavailable(app):
    from ai.gemini import UnavailableBackend
    ai_service.set_classifier(Classifier(UnavailableBackend()))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    r = check(app, ext, "https://secure-hdfcbank-login.xyz", {"has_password_field": True})
    assert r["action"] == "WARN" and r["level"] == "HEURISTIC" and r["ai"] == "not_needed"   # no AI call needed
    assert r["can_continue"] is True and r["suggest"] == "hdfcbank.com"


def test_lookalike_overrides_a_benign_ai_verdict_but_not_a_verified_site_or_parent_rule(app):
    benign = json.dumps({"risk_score": 3, "confidence": 0.99, "categories": {"general": 0.95}, "evidence": []})
    ai_service.set_classifier(Classifier(FakeBackend(benign)))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    assert check(app, ext, "https://secure-hdfcbank-login.xyz", {})["action"] == "WARN"

    # the real bank is verified, so it is never second-guessed
    from services.seed_sites import seed_sites
    seed_sites()
    assert check(app, ext, "https://netbanking.hdfcbank.com")["action"] == "ALLOW"

    # and an explicit parent/own rule beats the heuristic
    kid = c.get("/api/children").get_json()["children"][0]
    c.post(f"/api/policies/{kid['policy_id']}/exceptions", json={"domain": "secure-hdfcbank-login.xyz"}, headers=h)
    assert check(app, ext, "https://secure-hdfcbank-login.xyz", {})["action"] == "ALLOW"


def test_family_accounts_do_not_get_heuristic_warnings(app):
    from policy.presets import preset
    d = decide(SiteInfo("secure-hdfcbank-login.xyz", lookalike=0.9), preset("teen"))
    assert d.level != Level.HEURISTIC


# ---- dashboard numbers for the adult home ----------------------------------------------------------------

def test_adult_stats_count_warnings_per_day_and_by_type(app):
    c, h = adult(app)
    ext = pair_self(app, c, h)
    events = [{"kind": "security", "data": {"type": t, "domain": "x.example.com"}} for t in
              ("warning_shown", "warning_shown", "warning_overridden", "sensitive_breached", "sensitive_sent_anyway")]
    events.append({"kind": "cookie", "data": {"type": "cookie", "action": "BLOCKED", "rule": "tracker", "purpose": "Advertising / tracking"}})
    app.test_client().post("/api/ext/events", json={"events": events}, headers=ext)
    s = c.get("/api/stats").get_json()
    assert s["security_by_type"] == {"warning_shown": 2, "warning_overridden": 1, "sensitive_breached": 1, "sensitive_sent_anyway": 1}
    assert len(s["security_per_day"]) == 1 and s["security_per_day"][0]["count"] == 5
    assert s["totals"]["trackers_blocked"] == 1


# ---- review fix: the AI's own words must never reach a warning ----------------------------------------------

def test_ai_free_text_evidence_is_not_sent_to_the_browser(app):
    hostile = json.dumps({"risk_score": 95, "confidence": 0.95, "categories": {"scam": 0.95},
                          "evidence": ["Your device is infected. Call 1800-555-0100 now", "Install the cleaner at http://evil.example/x"]})
    ai_service.set_classifier(Classifier(FakeBackend(hostile)))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    r = check(app, ext, "https://tech-support-help.example.com", {"title": "Alert"})
    assert r["action"] == "WARN" and r["category"] == "scam"
    blob = json.dumps(r)
    assert "1800" not in blob and "evil.example" not in blob and "infected" not in blob


def test_lookalike_reasons_still_come_from_our_own_checks(app):
    ai_service.set_classifier(Classifier(FakeBackend(json.dumps({"risk_score": 5, "confidence": 0.9, "categories": {"general": 0.9}, "evidence": ["ignore me"]}))))
    c, h = adult(app)
    ext = pair_self(app, c, h)
    r = check(app, ext, "https://secure-hdfcbank-login.xyz", {"has_password_field": True})
    assert r["evidence"] and all("hdfc" in e.lower() or "tld" in e.lower() or "login" in e.lower() or "password" in e.lower() or "hyphen" in e.lower() for e in r["evidence"])
    assert "ignore me" not in json.dumps(r)


# ---- disconnecting a browser --------------------------------------------------------------------------------
def test_adult_can_disconnect_their_own_browser_and_the_token_stops_working(app):
    c, h = adult(app)
    ext = pair_self(app, c, h)
    assert app.test_client().post("/api/ext/disconnect", json={}, headers=ext).status_code == 200
    assert app.test_client().post("/api/ext/check", json={"url": "https://a.com"}, headers=ext).status_code == 401
    dev = c.get("/api/children").get_json()["children"][0]["devices"][0]
    assert dev["revoked"] is True


def test_family_browser_needs_the_parents_password_to_disconnect(app):
    from tests.test_ext_api import paired
    c, ext, _ = paired(app)
    post = lambda **b: app.test_client().post("/api/ext/disconnect", json=b, headers=ext)
    assert post().status_code == 403
    assert post(password="wrong-password").status_code == 403
    assert post(password="x" * 5000).status_code == 403
    # still connected after the failed tries
    assert app.test_client().post("/api/ext/check", json={"url": "https://a.com"}, headers=ext).status_code != 401
    assert post(password="password123").status_code == 200
    assert app.test_client().post("/api/ext/check", json={"url": "https://a.com"}, headers=ext).status_code == 401


def test_disconnect_needs_a_device_token(app):
    assert app.test_client().post("/api/ext/disconnect", json={}).status_code == 401


def test_the_pairing_code_tells_the_one_extension_which_kind_of_account_it_joined(app):
    """One extension, two behaviours: the account that issued the code decides which."""
    c, h = adult(app)
    kid = c.get("/api/children").get_json()["children"][0]
    code = c.post(f"/api/children/{kid['id']}/devices", json={"label": "Laptop"}, headers=h).get_json()["pairing_code"]
    r = app.test_client().post("/api/devices/pair", json={"code": code}).get_json()
    assert r["mode"] == "adult"
    ext = {"Authorization": f"Bearer {r['token']}"}
    assert app.test_client().get("/api/ext/policy-sync", headers=ext).get_json()["mode"] == "adult"
