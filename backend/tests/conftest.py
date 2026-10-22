import os
import pathlib
import sys

from sqlalchemy.pool import NullPool

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from config import Config

# Every test builds its own app and engine. On PostgreSQL a pooled engine keeps its connections until it is garbage
# collected, which exhausts a hosted pooler (Supabase's session mode allows ~15 clients). Close each one after use.
# Use a throwaway database, never the Supabase project: its pooler ignores `options=-csearch_path`, so the fixtures'
# create_all/drop_all would run in `public`.
if os.environ.get("TEST_DATABASE_URL"):
    Config.SQLALCHEMY_ENGINE_OPTIONS = {"poolclass": NullPool}
