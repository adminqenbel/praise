import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from database.postgres import db
from services.site_service import (InvalidTransition, get_or_create_site, normalize_domain,
                                   record_ai_result, to_site_info, transition)
from tests.test_models import app  # noqa: F401  (fixture)


@pytest.mark.parametrize("raw,expected", [
    ("https://user:pw@WWW.Example.com:8080/a?b=1", "example.com"),
    ("example.com/path", "example.com"),
    ("http://sub.example.co.uk.", "sub.example.co.uk"),
    ("https://bücher.de", "xn--bcher-kva.de"),
    ("http://192.168.1.1/", None),
    ("http://[::1]/", None),
    ("localhost", None),
    ("", None),
    ("chrome://extensions", None),
])
def test_normalize_domain(raw, expected):
    assert normalize_domain(raw) == expected


def test_ai_result_stored_and_status_advances(app):
    s = get_or_create_site("g.com")
    assert record_ai_result(s, "gambling", 91, 0.95, {"gambling": 0.93, "adult": 0.02})
    db.session.commit()
    assert s.status == "AI_CLASSIFIED" and s.risk == 91
    info = to_site_info("g.com", s)
    assert info.source == "ai" and info.category_scores["gambling"] == 0.93


def test_ai_result_clamped(app):
    s = get_or_create_site("c.com")
    record_ai_result(s, "adult", 500, 7, {})
    assert s.risk == 100 and s.confidence == 1.0


def test_ai_never_overwrites_admin_verified(app):
    s = get_or_create_site("v.com")
    record_ai_result(s, "gambling", 90, 0.9, {})
    transition(s, "ADMIN_VERIFIED")
    assert record_ai_result(s, "education", 5, 0.9, {}) is False
    assert s.category == "gambling" and s.verified_at is not None


def test_invalid_transition_rejected(app):
    s = get_or_create_site("t.com")
    with pytest.raises(InvalidTransition):
        transition(s, "DISPUTED")


def test_seeded_sites_cover_subdomains_but_normal_rows_do_not(app):
    from database.models import Site
    from services.seed_sites import seed_sites
    from services.site_service import find_site
    seed_sites()
    assert find_site("accounts.google.com").domain == "google.com"
    assert find_site("google.com").source == "seed"
    assert find_site("notgoogle.com") is None and find_site("google.com.evil.io") is None
    db.session.add(Site(domain="blogspot.com", source="ai", status="AI_CLASSIFIED", category="general"))
    db.session.commit()
    assert find_site("someone.blogspot.com") is None      # only seeds vouch for subdomains
    assert seed_sites()[0] == 0                              # idempotent


def test_seeding_replaces_ai_guess_but_never_an_admin_decision(app):
    from database.models import Site
    from services.seed_sites import seed_sites
    from services.site_service import find_site
    db.session.add(Site(domain="google.com", source="ai", status="AI_CLASSIFIED", category="general",
                        risk=10, confidence=0.4))                      # weak guess from an earlier visit
    db.session.add(Site(domain="paypal.com", source="admin", status="ADMIN_VERIFIED", category="education",
                        risk=0))                                        # an admin's explicit call
    db.session.commit()
    seed_sites()
    g = find_site("accounts.google.com")
    assert g.domain == "google.com" and g.source == "seed" and g.status == "ADMIN_VERIFIED" and g.confidence == 1.0
    assert find_site("paypal.com").category == "education"              # admin decision untouched
