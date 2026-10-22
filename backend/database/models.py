"""PostgreSQL system-of-record models.

Global site intelligence (sites, site_categories, site_reputation, site_reviews) holds
NO child-scoped data. Anything tied to a child/device lives in the events table.
"""
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from .postgres import db


# All timestamps are stored timezone-aware in UTC.
def utcnow():
    return datetime.now(timezone.utc)


# Free-form JSON: JSONB on PostgreSQL (indexable), plain JSON on SQLite (tests).
JSONDoc = db.JSON().with_variant(JSONB(), "postgresql")
# High-volume tables get 64-bit ids; SQLite only auto-increments a plain INTEGER key.
BigId = db.BigInteger().with_variant(db.Integer(), "sqlite")


# Lifecycle of a website's classification, from never seen to verified by an admin.
SITE_STATUSES = ("UNKNOWN", "AI_CLASSIFIED", "PENDING_REVIEW", "ADMIN_VERIFIED",
                 "DISPUTED", "RECLASSIFIED", "REVIEW_REQUIRED")


# A login. One account can own both a family space and a personal (adult) space; `role` separates admins from normal users.
class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(16), nullable=False, default="parent")
    # The space the dashboard is showing (family | adult). One login can hold both: see services/space_service.py.
    account_type = db.Column(db.String(8), nullable=False, default="family")
    has_family = db.Column(db.Boolean, nullable=False, default=True)
    has_adult = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    children = db.relationship("Child", back_populates="parent", cascade="all, delete-orphan")
    __table_args__ = (CheckConstraint("role in ('parent','admin')", name="ck_users_role"),
                      CheckConstraint("account_type in ('family','adult')", name="ck_users_account_type"))


# A named rule set (a preset plus the owner's changes). Its rows below say what is allowed, blocked or asked about.
class Policy(db.Model):
    __tablename__ = "policies"
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    name = db.Column(db.String(100), nullable=False)
    space = db.Column(db.String(8), nullable=False, default="family")  # family | adult: which space this rule set belongs to
    preset = db.Column(db.String(32), nullable=False, default="custom")
    unknown_action = db.Column(db.String(8), nullable=False, default="REVIEW")
    ai_enabled = db.Column(db.Boolean, nullable=False, default=True)
    ai_min_confidence = db.Column(db.Float, nullable=False, default=0.6)
    # cookie / download / escape protection toggles (flexible, small)
    settings = db.Column(db.JSON, nullable=False, default=dict)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    rules = db.relationship("PolicyRule", back_populates="policy", cascade="all, delete-orphan")
    domain_rules = db.relationship("DomainRule", back_populates="policy",
                                   cascade="all, delete-orphan")
    tld_rules = db.relationship("TldRule", back_populates="policy", cascade="all, delete-orphan")
    exceptions = db.relationship("PolicyException", back_populates="policy",
                                 cascade="all, delete-orphan")


# A person being protected: a child, or the account owner themself in the adult space (kind = self). Points at one policy.
class Child(db.Model):
    __tablename__ = "children"
    id = db.Column(db.Integer, primary_key=True)
    parent_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"),
                          nullable=False, index=True)
    name = db.Column(db.String(100), nullable=False)
    kind = db.Column(db.String(8), nullable=False, default="child")  # child | self (an adult protecting themselves)
    policy_id = db.Column(db.Integer, db.ForeignKey("policies.id", ondelete="SET NULL"))
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    parent = db.relationship("User", back_populates="children")
    policy = db.relationship("Policy")
    devices = db.relationship("Device", back_populates="child", cascade="all, delete-orphan")


# One browser paired to a child. It proves who it is with a token; only hashes of the pairing code and token are stored.
class Device(db.Model):
    __tablename__ = "devices"
    id = db.Column(db.Integer, primary_key=True)
    child_id = db.Column(db.Integer, db.ForeignKey("children.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    label = db.Column(db.String(100))
    # Pairing: only hashes are stored. Code is one-time and expires.
    pairing_code_hash = db.Column(db.String(64), index=True)
    pairing_expires_at = db.Column(db.DateTime(timezone=True))
    token_hash = db.Column(db.String(64), unique=True, index=True)
    paired_at = db.Column(db.DateTime(timezone=True))
    last_seen = db.Column(db.DateTime(timezone=True))
    revoked = db.Column(db.Boolean, nullable=False, default=False)

    child = db.relationship("Child", back_populates="devices")


# Category -> action, for example gambling -> BLOCK. One row per category per policy.
class PolicyRule(db.Model):
    __tablename__ = "policy_rules"
    id = db.Column(db.Integer, primary_key=True)
    policy_id = db.Column(db.Integer, db.ForeignKey("policies.id", ondelete="CASCADE"),
                          nullable=False, index=True)
    category = db.Column(db.String(40), nullable=False)
    action = db.Column(db.String(8), nullable=False)

    policy = db.relationship("Policy", back_populates="rules")
    __table_args__ = (
        UniqueConstraint("policy_id", "category", name="uq_policy_category"),
        CheckConstraint("action in ('ALLOW','BLOCK','REVIEW','ASK','WARN')", name="ck_rule_action"),
    )


# A parent's explicit allow or block for one website (and its subdomains). The highest-priority rule type.
class DomainRule(db.Model):
    __tablename__ = "domain_rules"
    id = db.Column(db.Integer, primary_key=True)
    policy_id = db.Column(db.Integer, db.ForeignKey("policies.id", ondelete="CASCADE"),
                          nullable=False, index=True)
    domain = db.Column(db.String(255), nullable=False)
    action = db.Column(db.String(8), nullable=False)  # ALLOW | BLOCK

    policy = db.relationship("Policy", back_populates="domain_rules")
    __table_args__ = (
        UniqueConstraint("policy_id", "domain", name="uq_policy_domain"),
        CheckConstraint("action in ('ALLOW','BLOCK')", name="ck_domainrule_action"),
    )


# Allow or block a whole ending such as .xyz.
class TldRule(db.Model):
    __tablename__ = "tld_rules"
    id = db.Column(db.Integer, primary_key=True)
    policy_id = db.Column(db.Integer, db.ForeignKey("policies.id", ondelete="CASCADE"),
                          nullable=False, index=True)
    tld = db.Column(db.String(32), nullable=False)  # ".xyz"
    action = db.Column(db.String(8), nullable=False)  # ALLOW | BLOCK

    policy = db.relationship("Policy", back_populates="tld_rules")
    __table_args__ = (
        UniqueConstraint("policy_id", "tld", name="uq_policy_tld"),
        CheckConstraint("action in ('ALLOW','BLOCK')", name="ck_tldrule_action"),
    )


# A site a parent has approved after a request; always allowed for this policy.
class PolicyException(db.Model):
    __tablename__ = "exceptions"
    id = db.Column(db.Integer, primary_key=True)
    policy_id = db.Column(db.Integer, db.ForeignKey("policies.id", ondelete="CASCADE"),
                          nullable=False, index=True)
    domain = db.Column(db.String(255), nullable=False)
    note = db.Column(db.String(255))
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    policy = db.relationship("Policy", back_populates="exceptions")
    __table_args__ = (UniqueConstraint("policy_id", "domain", name="uq_exception_domain"),)


class Site(db.Model):
    """Global site intelligence: one row per registrable domain."""
    __tablename__ = "sites"
    id = db.Column(db.Integer, primary_key=True)
    domain = db.Column(db.String(255), unique=True, nullable=False, index=True)
    status = db.Column(db.String(20), nullable=False, default="UNKNOWN", index=True)
    category = db.Column(db.String(40))
    risk = db.Column(db.Integer)  # 0-100
    confidence = db.Column(db.Float)
    source = db.Column(db.String(8), nullable=False, default="none")  # none|seed|ai|admin
    first_seen = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    classified_at = db.Column(db.DateTime(timezone=True))
    verified_at = db.Column(db.DateTime(timezone=True))
    needs_reanalysis = db.Column(db.Boolean, nullable=False, default=False)
    # Whose device supplied the page signals for an AI classification. Unverified AI verdicts
    # that would loosen restrictions are only trusted by this family (see to_site_info).
    classified_by = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))

    categories = db.relationship("SiteCategory", back_populates="site",
                                 cascade="all, delete-orphan")
    reputation = db.relationship("SiteReputation", back_populates="site",
                                 cascade="all, delete-orphan")
    reviews = db.relationship("SiteReview", back_populates="site", cascade="all, delete-orphan")
    __table_args__ = (
        CheckConstraint("risk is null or (risk >= 0 and risk <= 100)", name="ck_site_risk"),
        CheckConstraint("status in ('" + "','".join(SITE_STATUSES) + "')", name="ck_site_status"),
    )


class SiteCategory(db.Model):
    """Per-category probability for a site (latest classification)."""
    __tablename__ = "site_categories"
    id = db.Column(db.Integer, primary_key=True)
    site_id = db.Column(db.Integer, db.ForeignKey("sites.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    category = db.Column(db.String(40), nullable=False)
    score = db.Column(db.Float, nullable=False)

    site = db.relationship("Site", back_populates="categories")
    __table_args__ = (UniqueConstraint("site_id", "category", name="uq_site_category"),)


class SiteReputation(db.Model):
    """Trusted security/reputation feed entries (malware, phishing lists)."""
    __tablename__ = "site_reputation"
    id = db.Column(db.Integer, primary_key=True)
    site_id = db.Column(db.Integer, db.ForeignKey("sites.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    flag = db.Column(db.String(40), nullable=False)  # malware | phishing | ...
    feed = db.Column(db.String(64), nullable=False)
    added_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    site = db.relationship("Site", back_populates="reputation")


# One admin decision about a site. Kept as an audit trail.
class SiteReview(db.Model):
    __tablename__ = "site_reviews"
    id = db.Column(db.Integer, primary_key=True)
    site_id = db.Column(db.Integer, db.ForeignKey("sites.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    reviewer_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    action = db.Column(db.String(20), nullable=False)  # CONFIRM_BLOCK|ALLOW|CHANGE_CATEGORY|REANALYZE|DISPUTE
    previous_category = db.Column(db.String(40))
    new_category = db.Column(db.String(40))
    note = db.Column(db.String(500))
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    site = db.relationship("Site", back_populates="reviews")


# Something one browser reported, or one check decided: the parent's activity view. `data` keeps the shape the extension
# sent (clipped); the server adds who and when. Deleting a profile deletes its events. Kept 90 days (`flask purge-events`).
class Event(db.Model):
    __tablename__ = "events"
    id = db.Column(BigId, primary_key=True)
    kind = db.Column(db.String(16), nullable=False)  # browser | cookie | download | security
    child_id = db.Column(db.Integer, db.ForeignKey("children.id", ondelete="CASCADE"), nullable=False)
    device_id = db.Column(db.Integer, db.ForeignKey("devices.id", ondelete="SET NULL"))
    timestamp = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    data = db.Column(JSONDoc, nullable=False, default=dict)
    __table_args__ = (
        db.Index("ix_events_child_kind_time", "child_id", "kind", "timestamp"),
        CheckConstraint("kind in ('browser','cookie','download','security')", name="ck_event_kind"),
    )


# The model's full answer for one classification, kept for administrators. Global data: nothing about a person.
class AIAnalysis(db.Model):
    __tablename__ = "ai_analyses"
    id = db.Column(BigId, primary_key=True)
    domain = db.Column(db.String(255), nullable=False, index=True)
    model = db.Column(db.String(64))
    risk_score = db.Column(db.Integer)
    confidence = db.Column(db.Float)
    categories = db.Column(JSONDoc)
    evidence = db.Column(JSONDoc)
    heuristics = db.Column(JSONDoc)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
