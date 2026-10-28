"""shared rate-limit and AI-budget counters

Several workers need one count for login attempts, pairing codes and the AI daily budget; a per-process dictionary
multiplies the limits by the number of workers.

Revision ID: a7c9e1b3d5f8
Revises: f6a8b0c2d4e6
"""
import sqlalchemy as sa
from alembic import op

revision = "a7c9e1b3d5f8"
down_revision = "f6a8b0c2d4e6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "rate_counters",
        sa.Column("key", sa.String(length=190), nullable=False),
        sa.Column("bucket", sa.BigInteger(), nullable=False),
        sa.Column("hits", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("key", "bucket"),
    )
    with op.batch_alter_table("rate_counters", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_rate_counters_expires_at"), ["expires_at"], unique=False)
    if op.get_bind().dialect.name == "postgresql":
        op.execute('ALTER TABLE "rate_counters" ENABLE ROW LEVEL SECURITY')


def downgrade():
    with op.batch_alter_table("rate_counters", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_rate_counters_expires_at"))
    op.drop_table("rate_counters")
