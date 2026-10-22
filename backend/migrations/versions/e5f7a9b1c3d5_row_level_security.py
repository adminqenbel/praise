"""row level security on every table (PostgreSQL only)

Supabase publishes the public schema through its own REST API to anyone holding the project's anon key. With RLS on
and no policies, those API roles see and change nothing. The app connects as the tables' owner, which RLS does not
restrict. Every new table needs the same line in its own migration.

Revision ID: e5f7a9b1c3d5
Revises: d4e6f8a0b2c4
"""
from alembic import op

revision = "e5f7a9b1c3d5"
down_revision = "d4e6f8a0b2c4"
branch_labels = None
depends_on = None

TABLES = ("users", "policies", "children", "devices", "policy_rules", "domain_rules", "tld_rules", "exceptions",
          "sites", "site_categories", "site_reputation", "site_reviews", "events", "ai_analyses", "alembic_version")


def upgrade():
    if op.get_bind().dialect.name != "postgresql":
        return
    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')


def downgrade():
    if op.get_bind().dialect.name != "postgresql":
        return
    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY')
