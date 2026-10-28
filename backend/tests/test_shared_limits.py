"""Limits shared by several workers through the rate_counters table."""
import pathlib
import sys

import pytest
from sqlalchemy.exc import OperationalError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import create_app
from database.models import RateCounter
from database.postgres import db
from services import ai_service, ratelimit
from services.ratelimit import RateLimiter, limiter
from tests.test_models import TestConfig, app  # noqa: F401  (fixture)


class SharedConfig(TestConfig):
    RATELIMIT_ENABLED = True
    RATELIMIT_SHARED = True


@pytest.fixture()
def shared_app():
    limiter.reset()
    app = create_app(SharedConfig)
    with app.app_context():
        db.create_all()
        yield app
        db.session.remove()
        db.drop_all()
    limiter.reset()


def test_two_workers_share_one_count(shared_app):
    worker_a, worker_b = RateLimiter(), RateLimiter()          # separate in-process state, as in two processes
    results = [worker_a.allow("k", 3, 60, shared=True)[0], worker_b.allow("k", 3, 60, shared=True)[0],
               worker_a.allow("k", 3, 60, shared=True)[0], worker_b.allow("k", 3, 60, shared=True)[0],
               worker_a.allow("k", 3, 60, shared=True)[0]]
    assert results == [True, True, True, False, False]
    ok, retry = worker_b.allow("k", 3, 60, shared=True)
    assert not ok and 1 <= retry <= 61
    assert worker_b.allow("other", 3, 60, shared=True)[0]       # keys are independent


def test_without_the_switch_each_worker_counts_alone(app):
    app.config["RATELIMIT_SHARED"] = False
    a, b = RateLimiter(), RateLimiter()
    assert all(a.allow("k", 2, 60, shared=True)[0] for _ in range(2)) and not a.allow("k", 2, 60, shared=True)[0]
    assert b.allow("k", 2, 60, shared=True)[0]                  # b has its own memory
    assert RateCounter.query.count() == 0


def test_a_new_window_starts_a_new_count(shared_app, monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(ratelimit.time, "time", lambda: now[0])
    rl = RateLimiter()
    assert rl.allow("k", 1, 60, shared=True)[0] and not rl.allow("k", 1, 60, shared=True)[0]
    now[0] += 61
    assert rl.allow("k", 1, 60, shared=True)[0]


def test_stored_keys_are_digests_not_emails(shared_app):
    RateLimiter().allow("login:1.2.3.4|someone@example.com", 5, 60, shared=True)
    row = RateCounter.query.one()
    assert "example.com" not in row.key and len(row.key) == 64


def test_finished_windows_are_pruned(shared_app, monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(ratelimit.time, "time", lambda: now[0])
    monkeypatch.setattr(ratelimit, "_last_prune", 0.0)
    RateLimiter().allow("old", 1, 10, shared=True)
    assert RateCounter.query.count() == 1
    now[0] += 100
    monkeypatch.setattr(ratelimit, "_last_prune", 0.0)
    RateLimiter().allow("new", 1, 10, shared=True)              # creating a row triggers the sweep
    assert [r.hits for r in RateCounter.query.all()] == [1] and RateCounter.query.count() == 1


def test_database_trouble_falls_back_to_the_local_count(shared_app, monkeypatch):
    def boom(*a, **k):
        raise OperationalError("select", {}, Exception("db down"))
    monkeypatch.setattr(ratelimit, "shared_allow", boom)
    rl = RateLimiter()
    assert rl.allow("k", 1, 60, shared=True)[0] and not rl.allow("k", 1, 60, shared=True)[0]


def test_login_limit_holds_across_workers(shared_app):
    c = shared_app.test_client()
    for _ in range(8):
        assert c.post("/api/auth/login", json={"email": "a@x.com", "password": "wrong-password"}).status_code == 401
    limiter.reset()                                             # a different worker has no memory of those
    assert c.post("/api/auth/login", json={"email": "a@x.com", "password": "wrong-password"}).status_code == 429


def test_the_ai_daily_budget_is_shared(shared_app):
    one, two = ai_service.SharedDailyBudget(3), ai_service.SharedDailyBudget(3)
    assert [one.take(), two.take(), one.take(), two.take(), one.take()] == [True, True, True, False, False]


def test_the_ai_budget_stays_local_when_sharing_is_off(app):
    b = ai_service.SharedDailyBudget(1)
    assert b.take() and not b.take() and RateCounter.query.count() == 0
