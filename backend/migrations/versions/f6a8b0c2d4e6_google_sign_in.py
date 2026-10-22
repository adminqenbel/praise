"""google sign-in and dashboard disconnect codes

A login may now have no password (Google only), Google identities are stored by their permanent subject, and a child's
browser leaves its account with a one-time code from the parent's dashboard instead of the parent's password.

Revision ID: f6a8b0c2d4e6
Revises: e5f7a9b1c3d5
"""
import sqlalchemy as sa
from alembic import op

revision = "f6a8b0c2d4e6"
down_revision = "e5f7a9b1c3d5"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "oauth_identities",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=16), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("provider in ('google')", name="ck_oauth_provider"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "subject", name="uq_oauth_provider_subject"),
    )
    with op.batch_alter_table("oauth_identities", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_oauth_identities_user_id"), ["user_id"], unique=False)
    if op.get_bind().dialect.name == "postgresql":
        op.execute('ALTER TABLE "oauth_identities" ENABLE ROW LEVEL SECURITY')

    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.alter_column("password_hash", existing_type=sa.String(length=255), nullable=True)

    with op.batch_alter_table("devices", schema=None) as batch_op:
        batch_op.add_column(sa.Column("disconnect_code_hash", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("disconnect_expires_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    with op.batch_alter_table("devices", schema=None) as batch_op:
        batch_op.drop_column("disconnect_expires_at")
        batch_op.drop_column("disconnect_code_hash")

    # Google-only logins have no password: give them a hash no password matches (werkzeug rejects a malformed hash).
    op.execute("UPDATE users SET password_hash = '!' WHERE password_hash IS NULL")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.alter_column("password_hash", existing_type=sa.String(length=255), nullable=False)

    with op.batch_alter_table("oauth_identities", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_oauth_identities_user_id"))
    op.drop_table("oauth_identities")
