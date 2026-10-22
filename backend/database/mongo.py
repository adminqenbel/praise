from pymongo import MongoClient

_client = None
_db = None


# Open the MongoDB client once at start-up (2 s timeout so a missing database fails fast instead of hanging requests).
def init_mongo(app):
    global _client, _db
    _client = MongoClient(app.config["MONGO_URL"], serverSelectionTimeoutMS=2000)
    _db = _client[app.config["MONGO_DB"]]


# Return the database handle for event and analysis collections.
def get_mongo():
    if _db is None:
        raise RuntimeError("Mongo not initialised")
    return _db


def ensure_indexes():
    """Idempotent. Event collections are queried by child/time and domain; AI analysis by domain."""
    db = get_mongo()
    for name in ("browser_events", "cookie_events", "download_events", "security_events"):
        db[name].create_index([("child_id", 1), ("timestamp", -1)])
    db["browser_events"].create_index([("domain", 1)])
    # Browsing history is private data: keep it 90 days, then let MongoDB delete it.
    for name in ("browser_events", "cookie_events", "download_events", "security_events"):
        db[name].create_index([("timestamp", 1)], expireAfterSeconds=90 * 86400, name="ttl_90d")
    db["ai_analysis"].create_index([("domain", 1), ("timestamp", -1)])
