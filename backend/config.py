import os
from dotenv import load_dotenv

# Read backend/.env into the environment (it holds secrets and is never committed).
load_dotenv()


# Every setting comes from the environment with a safe local default, so the app starts on a fresh machine.
class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-change-me")
    # PostgreSQL: users, children, policies, sites, rules, reviews.
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg2://postgres:postgres@localhost:5432/praise"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    # MongoDB: browsing events and full AI analysis, kept for 90 days.
    MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    MONGO_DB = os.environ.get("MONGO_DB", "praise")
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
    MAX_CONTENT_LENGTH = 2 * 1024 * 1024        # reject oversized request bodies
    RATELIMIT_ENABLED = True
    SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "") == "1"   # set to 1 behind HTTPS
    # Login cookie hardening: hidden from page scripts and not sent on cross-site requests.
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
