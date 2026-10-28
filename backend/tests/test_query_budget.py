"""Query budget for the hot path: POST /api/ext/check runs on every page a protected browser opens."""
import pathlib
import sys
import time

import pytest
from sqlalchemy import event

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai.classifier import Classifier
from database.models import Child, DomainRule, PolicyException, Site, SiteCategory, SiteReputation, TldRule
from database.postgres import db
from services import ai_service, policy_service
from services.seed_sites import seed_sites
from tests.test_ai import FakeBackend
from tests.test_ext_api import paired
from tests.test_models import app  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def reset_ai():
    yield
    ai_service.set_classifier(None)


class QueryCounter:
    """Counts the SQL statements the app sends while it is active (SQLAlchemy cursor hook)."""

    def __init__(self):
        self.statements = []

    def _hook(self, conn, cursor, statement, params, context, executemany):
        self.statements.append(" ".join(statement.split())[:120])

    def __enter__(self):
        event.listen(db.engine, "before_cursor_execute", self._hook)
        return self

    def __exit__(self, *exc):
        event.remove(db.engine, "before_cursor_execute", self._hook)

    @property
    def count(self):
        return len(self.statements)


def _post(app, ext, url, signals=None):
    body = {"url": url} if signals is None else {"url": url, "signals": signals}
    return app.test_client().post("/api/ext/check", json=body, headers=ext)


def _counted_check(app, ext, url, signals=None):
    with QueryCounter() as q:
        r = _post(app, ext, url, signals)
    assert r.status_code == 200, r.get_json()
    return r.get_json(), q


def _with_policy(cid):
    """Give the child a stored policy with the usual mix of rules (what the dashboard creates)."""
    child = db.session.get(Child, cid)
    pol = policy_service.create_policy_from_preset(child.parent_id, "Teen", "teen")
    pol.domain_rules.append(DomainRule(domain="blocked-example.com", action="BLOCK"))
    pol.domain_rules.append(DomainRule(domain="allowed-example.com", action="ALLOW"))
    pol.tld_rules.append(TldRule(tld=".xyz", action="BLOCK"))
    pol.exceptions.append(PolicyException(domain="ok-example.com"))
    db.session.add(pol)
    child.policy = pol
    db.session.commit()
    return pol.id


def test_query_counter_sees_statements(app):
    with QueryCounter() as q:
        db.session.execute(db.text("select 1"))
    assert q.count == 1


# Measured before the optimisation (a child with a stored policy of 4 rules): 14 statements for a seeded site
# and 13 for an unknown multi-label one. Now: device and child (1), the site with its ancestors, categories and
# reputation (1), the event insert (1). The flattened policy comes from the per-process cache.
WARM_BUDGET = 3


def test_check_is_within_its_query_budget_for_a_seeded_and_an_unknown_site(app):
    seed_sites()
    c, ext, cid = paired(app)
    _with_policy(cid)
    _counted_check(app, ext, "https://www.google.com/")          # warms the policy cache and last_seen
    body, q = _counted_check(app, ext, "https://mail.google.com/x")
    assert q.count <= WARM_BUDGET, q.statements
    body, q = _counted_check(app, ext, "https://a.b.c.unknown-example.org/")
    assert q.count <= WARM_BUDGET, q.statements                  # ancestors are one IN query, not one each


def test_cold_policy_load_is_a_handful_of_queries_not_one_per_list(app):
    c, ext, cid = paired(app)
    _with_policy(cid)
    _counted_check(app, ext, "https://example.org/")             # first request also records last_seen
    policy_service.clear_policy_cache()
    _, q = _counted_check(app, ext, "https://example.org/")
    assert q.count <= WARM_BUDGET + 5, q.statements              # the policy and its 4 lists


def test_last_seen_is_not_written_on_every_request(app):
    c, ext, cid = paired(app)
    _counted_check(app, ext, "https://example.org/")
    _, q = _counted_check(app, ext, "https://example.org/")
    assert not any(st.upper().startswith("UPDATE") for st in q.statements), q.statements


def test_policy_edits_take_effect_at_once_in_the_same_process(app):
    from database.models import Policy
    c, ext, cid = paired(app)
    pid = _with_policy(cid)
    body, _ = _counted_check(app, ext, "https://fresh-example.com/")
    assert body["level"] != "PARENT_RULE"
    pol = db.session.get(Policy, pid)
    pol.domain_rules.append(DomainRule(domain="fresh-example.com", action="BLOCK"))
    db.session.commit()
    body, _ = _counted_check(app, ext, "https://fresh-example.com/")
    assert body["action"] == "BLOCK" and body["level"] == "PARENT_RULE"
    pol.domain_rules[:] = [r for r in pol.domain_rules if r.domain != "fresh-example.com"]
    db.session.commit()
    body, _ = _counted_check(app, ext, "https://fresh-example.com/")
    assert body["level"] != "PARENT_RULE"


def test_policy_cache_expires_for_changes_made_by_another_process(app):
    c, ext, cid = paired(app)
    pid = _with_policy(cid)
    app.config["POLICY_CACHE_TTL"] = 0.05
    policy_service.clear_policy_cache()
    _counted_check(app, ext, "https://example.org/")             # cached, 50 ms life
    # a change written behind this process's back (another worker): raw SQL fires no ORM flush event
    db.session.execute(db.text("insert into domain_rules (policy_id, domain, action) values (:p, 'other.com', 'BLOCK')"),
                       {"p": pid})
    db.session.commit()
    time.sleep(0.1)
    body, _ = _counted_check(app, ext, "https://other.com/")
    assert body["level"] == "PARENT_RULE" and body["action"] == "BLOCK"


def test_policy_sync_query_count_does_not_grow_with_the_number_of_verified_sites(app):
    c, ext, cid = paired(app)
    app.test_client().get("/api/ext/policy-sync", headers=ext)     # first request also records last_seen

    def sync_count(tag, n):
        for i in range(n):
            site = Site(domain=f"v{tag}-{i}.example.com", category="general", risk=5, confidence=1.0,
                        source="admin", status="ADMIN_VERIFIED")
            site.categories.append(SiteCategory(category="general", score=1.0))
            site.reputation.append(SiteReputation(flag="phishing", feed="t"))
            db.session.add(site)
        db.session.commit()
        with QueryCounter() as q:
            r = app.test_client().get("/api/ext/policy-sync", headers=ext)
        assert r.status_code == 200
        return q.count

    few = sync_count("a", 3)
    many = sync_count("b", 40)
    assert many == few, (few, many)


def test_a_failed_classification_is_not_retried_for_every_page_load(app):
    class Flaky(FakeBackend):
        def generate(self, system, prompt):
            self.calls += 1
            raise RuntimeError("provider down")

    backend = Flaky()
    ai_service.set_classifier(Classifier(backend))
    c, ext, cid = paired(app)
    for _ in range(3):
        body, _ = _counted_check(app, ext, "https://never-seen-before.example.org/", {})
        assert body["ai"] == "unavailable"
    assert backend.calls == 1                                     # one provider call, two answered from memory
    ai_service.set_classifier(Classifier(FakeBackend()))          # a new classifier starts clean
    body, _ = _counted_check(app, ext, "https://never-seen-before.example.org/", {})
    assert body["ai"] == "classified"
