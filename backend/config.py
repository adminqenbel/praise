import os
from dotenv import load_dotenv

# Read backend/.env into the environment (it holds secrets and is never committed).
load_dotenv()


DEV_SECRET_KEY = "dev-only-change-me"
DEV_DATABASE_URL = "postgresql+psycopg2://postgres:postgres@localhost:5432/praise"


def database_url(raw: str) -> str:
    """Pin the psycopg2 driver. Hosts hand out postgres:// or postgresql:// URLs, which SQLAlchemy 2.1 maps to
    psycopg 3; that driver's automatic prepared statements break behind a transaction pooler (Supabase :6543)."""
    for prefix in ("postgres://", "postgresql://"):
        if raw.startswith(prefix):
            return "postgresql+psycopg2://" + raw[len(prefix):]
    return raw


# Every setting comes from the environment with a safe local default, so the app starts on a fresh machine.
# PRAISE_ENV=production turns those defaults into a refusal to start (see production_problems).
class Config:
    PRAISE_ENV = os.environ.get("PRAISE_ENV", "development")
    SECRET_KEY = os.environ.get("SECRET_KEY", DEV_SECRET_KEY)
    # PostgreSQL: users, children, policies, sites, rules, reviews, events (kept 90 days) and AI evidence.
    SQLALCHEMY_DATABASE_URI = database_url(os.environ.get("DATABASE_URL", DEV_DATABASE_URL))
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    # A pooled connection can be closed by the database's pooler (Supabase) between requests: test it before use.
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True, "pool_recycle": 300}
    # How many reverse proxies sit in front of the app (Render: its load balancer). Each one appends to
    # X-Forwarded-For; trusting exactly that many lets rate limits see the real client address. 0 = trust none.
    TRUSTED_PROXY_HOPS = int(os.environ.get("TRUSTED_PROXY_HOPS", "0"))
    # Classifier settings: key, model and a per-day call cap that stops runaway cost.
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
    AI_MODE = os.environ.get("AI_MODE", "")  # "mock" = offline keyword classifier (dev only)
    # Optional local model that rewords the buddies' lines. Off unless COMPANION_LLM=ollama.
    COMPANION_LLM = os.environ.get("COMPANION_LLM", "")
    OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    COMPANION_MODEL = os.environ.get("COMPANION_MODEL", "qwen2.5:3b-instruct")
    AI_DAILY_BUDGET = int(os.environ.get("AI_DAILY_BUDGET", "500"))
    GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
    # Where the dashboard is served from; the only origin CORS lets in.
    DASHBOARD_ORIGIN = os.environ.get("DASHBOARD_ORIGIN", "http://localhost:5500")
    # This API's own public address. Google sends the browser back to API_ORIGIN/api/auth/google/callback.
    API_ORIGIN = os.environ.get("API_ORIGIN", "http://localhost:5000")
    # Google sign-in (optional): an OAuth "Web application" client. Empty = the button reports it isn't set up.
    GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
    GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    MAX_CONTENT_LENGTH = 2 * 1024 * 1024        # reject oversized request bodies
    RATELIMIT_ENABLED = True
    SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "") == "1"   # set to 1 behind HTTPS
    # Login cookie hardening: hidden from page scripts and not sent on cross-site requests.
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"


def production_problems(cfg) -> list[str]:
    """Settings that are fine on a developer's machine but unsafe once real families use the service."""
    problems = []
    key = cfg.get("SECRET_KEY") or ""
    if key in (DEV_SECRET_KEY, "change-me") or len(key) < 32:
        problems.append("SECRET_KEY must be a random value of at least 32 characters")
    url = cfg.get("SQLALCHEMY_DATABASE_URI") or ""
    if url == DEV_DATABASE_URL or "@localhost" in url or "@127.0.0.1" in url or url.startswith("sqlite"):
        problems.append("DATABASE_URL still points at a local development database")
    elif "sslmode=require" not in url and "sslmode=verify-full" not in url:
        problems.append("DATABASE_URL must end with ?sslmode=require so the connection is encrypted")
    if cfg.get("AI_MODE") == "mock":
        problems.append("AI_MODE=mock is the offline test classifier: leave AI_MODE unset")
    if not cfg.get("SESSION_COOKIE_SECURE"):
        problems.append("SESSION_COOKIE_SECURE must be 1 (the service is HTTPS only)")
    if not str(cfg.get("DASHBOARD_ORIGIN", "")).startswith("https://"):
        problems.append("DASHBOARD_ORIGIN must be the https:// address of the dashboard")
    if cfg.get("GOOGLE_CLIENT_ID"):
        if not cfg.get("GOOGLE_CLIENT_SECRET"):
            problems.append("GOOGLE_CLIENT_SECRET is missing (GOOGLE_CLIENT_ID is set)")
        if not str(cfg.get("API_ORIGIN", "")).startswith("https://"):
            problems.append("API_ORIGIN must be the https:// address of this API for Google sign-in")
    return problems
