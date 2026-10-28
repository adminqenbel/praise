"""Query budget for the hot path: POST /api/ext/check runs on every page a protected browser opens."""
import pathlib
import sys

import pytest
from sqlalchemy import event

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from database.postgres import db
from services import ai_service
from services.seed_sites import seed_sites
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
        self.statements.append(statement)

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


def test_query_counter_sees_statements(app):
    with QueryCounter() as q:
        db.session.execute(db.text("select 1"))
    assert q.count == 1


def test_measure(app):
    seed_sites()
    c, ext, _ = paired(app)
    _post(app, ext, "https://www.google.com/")      # warm any one-off work
    for label, url, sig in (("seeded", "https://mail.google.com/x", None),
                            ("unknown deep", "https://a.b.c.unknown-example.org/", None)):
        with QueryCounter() as q:
            r = _post(app, ext, url, sig)
        print("QUERIES", label, q.count, r.status_code)
