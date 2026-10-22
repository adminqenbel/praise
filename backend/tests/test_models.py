import os
import pathlib
import sys

import pytest
from sqlalchemy.exc import IntegrityError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import create_app
from config import Config
from database.models import Child, Device, Policy, PolicyRule, Site, User
from database.postgres import db


class TestConfig(Config):
    # Set TEST_DATABASE_URL to run the suite on PostgreSQL (use a throwaway database: the
    # fixtures drop all tables). Defaults to in-memory SQLite.
    SQLALCHEMY_DATABASE_URI = os.environ.get("TEST_DATABASE_URL", "sqlite://")
    TESTING = True
    RATELIMIT_ENABLED = False
    MONGO_DB = "praise_test"


@pytest.fixture()
def app():
    app = create_app(TestConfig)
    with app.app_context():
        db.create_all()
        yield app
        db.session.remove()
        db.drop_all()


def test_parent_child_device_policy_chain(app):
    u = User(email="p@x.com", password_hash="h")
    db.session.add(u)
    db.session.flush()
    pol = Policy(owner_id=u.id, name="Teen", preset="teen")
    pol.rules.append(PolicyRule(category="gambling", action="BLOCK"))
    db.session.add(pol)
    db.session.flush()
    c = Child(parent_id=u.id, name="Kid", policy_id=pol.id)
    c.devices.append(Device(label="laptop"))
    db.session.add(c)
    db.session.commit()
    assert Child.query.one().devices[0].label == "laptop"
    assert Child.query.one().policy.rules[0].category == "gambling"


def test_site_risk_constraint(app):
    db.session.add(Site(domain="a.com", risk=150))
    with pytest.raises(IntegrityError):
        db.session.commit()


def test_site_domain_unique(app):
    db.session.add(Site(domain="a.com"))
    db.session.commit()
    db.session.add(Site(domain="a.com"))
    with pytest.raises(IntegrityError):
        db.session.commit()


def test_duplicate_policy_rule_rejected(app):
    u = User(email="q@x.com", password_hash="h")
    db.session.add(u)
    db.session.flush()
    pol = Policy(owner_id=u.id, name="P")
    pol.rules.append(PolicyRule(category="adult", action="BLOCK"))
    pol.rules.append(PolicyRule(category="adult", action="ALLOW"))
    db.session.add(pol)
    with pytest.raises(IntegrityError):
        db.session.commit()
