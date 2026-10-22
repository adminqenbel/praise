"""events and AI evidence move from MongoDB into PostgreSQL: events, ai_analyses

Revision ID: d4e6f8a0b2c4
Revises: c3d1e5a7b9f2
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "d4e6f8a0b2c4"
down_revision = "c3d1e5a7b9f2"
branch_labels = None
depends_on = None

JSONDoc = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
BigId = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade():
    op.create_table(
        "events",
        sa.Column("id", BigId, primary_key=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("child_id", sa.Integer(), sa.ForeignKey("children.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("devices.id", ondelete="SET NULL")),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("data", JSONDoc, nullable=False),
        sa.CheckConstraint("kind in ('browser','cookie','download','security')", name="ck_event_kind"),
    )
    op.create_index("ix_events_timestamp", "events", ["timestamp"])
    op.create_index("ix_events_child_kind_time", "events", ["child_id", "kind", "timestamp"])

    op.create_table(
        "ai_analyses",
        sa.Column("id", BigId, primary_key=True),
        sa.Column("domain", sa.String(length=255), nullable=False),
        sa.Column("model", sa.String(length=64)),
        sa.Column("risk_score", sa.Integer()),
        sa.Column("confidence", sa.Float()),
        sa.Column("categories", JSONDoc),
        sa.Column("evidence", JSONDoc),
        sa.Column("heuristics", JSONDoc),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_ai_analyses_domain", "ai_analyses", ["domain"])


def downgrade():
    op.drop_index("ix_ai_analyses_domain", table_name="ai_analyses")
    op.drop_table("ai_analyses")
    op.drop_index("ix_events_child_kind_time", table_name="events")
    op.drop_index("ix_events_timestamp", table_name="events")
    op.drop_table("events")
