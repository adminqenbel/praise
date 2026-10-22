"""Event ingestion into the events table. Child-scoped data lives only here, never in global tables."""
from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import SQLAlchemyError

from database.models import Event
from database.postgres import db

# Event kinds the extension may report.
KINDS = ("browser", "cookie", "download", "security")
# Caps on a single upload: events per batch and characters per field.
MAX_BATCH = 100
MAX_FIELD = 2000
# Browsing history is private data: events older than this are deleted by `flask purge-events`.
RETENTION_DAYS = 90


def _clip(value, depth=0):
    """Bound untrusted event payloads: string length, nesting, list size."""
    if depth > 4:
        return None
    if isinstance(value, str):
        return value[:MAX_FIELD].replace("\x00", "")   # PostgreSQL JSONB refuses NUL characters
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_clip(v, depth + 1) for v in value[:50]]
    if isinstance(value, dict):
        # Keys that look like query operators or paths are never sent by our extension: drop them.
        return {str(k)[:64]: _clip(v, depth + 1) for k, v in list(value.items())[:50]
                if not str(k).startswith("$") and "." not in str(k)}
    return str(value)[:MAX_FIELD]


# Build one event for a child's device. Unknown kinds and non-object payloads are rejected; ids and time are added by
# the server, never taken from the extension.
def _build(kind: str, child_id: int, device_id: int, payload) -> Event | None:
    if kind not in KINDS:
        return None
    data = _clip(payload)
    if not isinstance(data, dict):
        return None
    return Event(kind=kind, child_id=child_id, device_id=device_id, data=data)


def _save(events: list[Event]) -> bool:
    """Best-effort write; a failed event write must never break browsing decisions."""
    if not events:
        return True
    try:
        db.session.add_all(events)
        db.session.commit()
        return True
    except SQLAlchemyError:
        db.session.rollback()
        return False


def record(kind: str, child_id: int, device_id: int, payload: dict) -> bool:
    event = _build(kind, child_id, device_id, payload)
    return event is not None and _save([event])


# Store up to 100 events from one upload in one write and report how many were accepted and rejected.
def record_batch(events, child_id: int, device_id: int) -> tuple[int, int]:
    built, rejected = [], 0
    for ev in (events if isinstance(events, list) else [])[:MAX_BATCH]:
        e = _build(str(ev.get("kind", "")), child_id, device_id, ev.get("data") or {}) \
            if isinstance(ev, dict) else None
        if e is None:
            rejected += 1
        else:
            built.append(e)
    if not _save(built):
        return 0, rejected + len(built)
    return len(built), rejected


def purge_older_than(days: int = RETENTION_DAYS) -> int:
    """Delete events older than `days`. Returns how many were removed."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    removed = Event.query.filter(Event.timestamp < cutoff).delete(synchronize_session=False)
    db.session.commit()
    return removed
