import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from policy.categories import Action
from policy.decision import Level, SiteInfo
from policy.engine import decide, domain_matches
from policy.presets import preset


def ai_site(domain, cat, conf=0.93, risk=91):
    return SiteInfo(domain, status="AI_CLASSIFIED", category=cat, risk=risk,
                    confidence=conf, source="ai")


def test_domain_matches_subdomain_not_suffix_collision():
    assert domain_matches("a.b.school.edu", {"school.edu"}) == "school.edu"
    assert domain_matches("notschool.edu", {"school.edu"}) is None


def test_ai_gambling_blocked_by_policy():
    d = decide(ai_site("unknownsite.com", "gambling"), preset("child_safe"))
    assert d.action == Action.BLOCK and d.level == Level.AI


def test_parent_allow_beats_ai_block():
    p = preset("child_safe")
    p.allow_domains.add("unknownsite.com")
    d = decide(ai_site("unknownsite.com", "gambling"), p)
    assert d.action == Action.ALLOW and d.level == Level.PARENT_RULE


def test_parent_block_beats_admin_verified_allow():
    p = preset("teen")
    p.block_domains.add("x.com")
    s = SiteInfo("x.com", status="ADMIN_VERIFIED", category="general", source="admin")
    assert decide(s, p).action == Action.BLOCK


def test_exception_beats_block_rule():
    p = preset("child_safe")
    p.block_domains.add("bank.com")
    p.exceptions.add("bank.com")
    assert decide(SiteInfo("bank.com"), p).action == Action.ALLOW


def test_admin_verified_beats_tld_block():
    p = preset("teen")
    p.blocked_tlds.add(".xyz")
    s = SiteInfo("ok.xyz", status="ADMIN_VERIFIED", category="education", source="admin")
    d = decide(s, p)
    assert d.action == Action.ALLOW and d.level == Level.ADMIN_VERIFIED


def test_reputation_blocks_before_category_allow():
    s = SiteInfo("m.com", category="social_media", source="seed", reputation_flag="malware")
    assert decide(s, preset("teen")).level == Level.REPUTATION


def test_tld_block_for_unknown():
    p = preset("teen")
    p.blocked_tlds.add(".xyz")
    d = decide(SiteInfo("whatever.xyz"), p)
    assert d.action == Action.BLOCK and d.level == Level.TLD


def test_low_confidence_ai_goes_to_review():
    d = decide(ai_site("a.com", "gambling", conf=0.3), preset("child_safe"))
    assert d.action == Action.REVIEW


def test_security_category_blocks_even_without_rule():
    d = decide(ai_site("p.com", "financial_phishing"), preset("custom"))
    assert d.action == Action.BLOCK


def test_unknown_defaults_per_preset():
    assert decide(SiteInfo("n.com"), preset("child_safe")).action == Action.BLOCK
    assert decide(SiteInfo("n.com"), preset("teen")).action == Action.REVIEW


def test_ai_disabled_falls_to_unknown_default():
    p = preset("teen")
    p.ai_enabled = False
    d = decide(ai_site("g.com", "gambling"), p)
    assert d.level == Level.UNKNOWN_DEFAULT
