"""Event ingestion into MongoDB. Child-scoped data lives only here, never in global tables."""
from datetime import datetime, timezone

from database.mongo import get_mongo

# Event kinds the extension may report, and the MongoDB collection each one is stored in.
COLLECTIONS = {
    "browser": "browser_events",
    "cookie": "cookie_events",
    "download": "download_events",
    "security": "security_events",
}
# Caps on a single upload: events per batch and characters per field.
MAX_BATCH = 100
MAX_FIELD = 2000


def _clip(value, depth=0):
    """Bound untrusted event payloads: string length, nesting, list size."""
    if depth > 4:
        return None
    if isinstance(value, str):
        return value[:MAX_FIELD]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_clip(v, depth + 1) for v in value[:50]]
    if isinstance(value, dict):
        return {str(k)[:64]: _clip(v, depth + 1) for k, v in list(value.items())[:50]
                if not str(k).startswith("$") and "." not in str(k)}
    return str(value)[:MAX_FIELD]


def insert(collection: str, doc: dict) -> bool:
    """Best-effort write; a Mongo outage must never break browsing decisions."""
    try:
        get_mongo()[collection].insert_one(doc)
        return True
    except Exception:
        return False


# Store one event for a child's device. Unknown kinds and non-object payloads are rejected; ids and time are added by the server, never taken from the extension.
def record(kind: str, child_id: int, device_id: int, payload: dict) -> bool:
    name = COLLECTIONS.get(kind)
    if name is None:
        return False
    doc = _clip(payload)
    if not isinstance(doc, dict):
        return False
    doc.update(child_id=child_id, device_id=device_id, timestamp=datetime.now(timezone.utc))
    return insert(name, doc)


# Store up to 100 events from one upload and report how many were accepted and rejected.
def record_batch(events, child_id: int, device_id: int) -> tuple[int, int]:
    accepted = rejected = 0
    for ev in (events if isinstance(events, list) else [])[:MAX_BATCH]:
        if isinstance(ev, dict) and record(str(ev.get("kind", "")), child_id, device_id,
                                           ev.get("data") or {}):
            accepted += 1
        else:
            rejected += 1
    return accepted, rejected
