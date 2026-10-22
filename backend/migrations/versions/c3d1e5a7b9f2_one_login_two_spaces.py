"""one login, two spaces: users.has_family / has_adult, policies.space

Revision ID: c3d1e5a7b9f2
Revises: a97a47f4032b
"""
from alembic import op
import sqlalchemy as sa

revision = "c3d1e5a7b9f2"
down_revision = "a97a47f4032b"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("has_family", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch_op.add_column(sa.Column("has_adult", sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table("policies", schema=None) as batch_op:
        batch_op.add_column(sa.Column("space", sa.String(length=8), nullable=False, server_default="family"))
    # Existing logins keep exactly the one space they had.
    op.execute("UPDATE users SET has_family = (account_type = 'family'), has_adult = (account_type = 'adult')")
    op.execute("UPDATE policies SET space = 'adult' WHERE owner_id IN (SELECT id FROM users WHERE account_type = 'adult')")


def downgrade():
    with op.batch_alter_table("policies", schema=None) as batch_op:
        batch_op.drop_column("space")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("has_adult")
        batch_op.drop_column("has_family")
