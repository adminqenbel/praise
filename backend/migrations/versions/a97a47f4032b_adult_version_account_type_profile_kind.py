"""adult version: account_type, profile kind, WARN rule action

Revision ID: a97a47f4032b
Revises: bfd4251f32b4
"""
from alembic import op
import sqlalchemy as sa

revision = "a97a47f4032b"
down_revision = "bfd4251f32b4"
branch_labels = None
depends_on = None


def upgrade():
    # Existing rows are family accounts and child profiles, so the server defaults fill them in.
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("account_type", sa.String(length=8), nullable=False, server_default="family"))
        batch_op.create_check_constraint("ck_users_account_type", "account_type in ('family','adult')")
    with op.batch_alter_table("children", schema=None) as batch_op:
        batch_op.add_column(sa.Column("kind", sa.String(length=8), nullable=False, server_default="child"))
    with op.batch_alter_table("policy_rules", schema=None) as batch_op:
        batch_op.drop_constraint("ck_rule_action", type_="check")
        batch_op.create_check_constraint("ck_rule_action", "action in ('ALLOW','BLOCK','REVIEW','ASK','WARN')")


def downgrade():
    with op.batch_alter_table("policy_rules", schema=None) as batch_op:
        batch_op.drop_constraint("ck_rule_action", type_="check")
        batch_op.create_check_constraint("ck_rule_action", "action in ('ALLOW','BLOCK','REVIEW','ASK')")
    with op.batch_alter_table("children", schema=None) as batch_op:
        batch_op.drop_column("kind")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_constraint("ck_users_account_type", type_="check")
        batch_op.drop_column("account_type")
