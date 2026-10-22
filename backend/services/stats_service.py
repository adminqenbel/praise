"""Read-side queries over the events table. Always scoped to an explicit list of child ids
that the caller already proved ownership of (never taken from request input)."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from database.models import Event
from database.postgres import db
from services.event_service import KINDS, RETENTION_DAYS


# Start of the reporting window, limited to the days the data is kept.
def _since(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=max(1, min(days, RETENTION_DAYS)))


# Timestamps are UTC; one without a zone (SQLite, or a client's cursor) is labelled so browsers don't guess.
def _utc(ts: datetime) -> datetime:
    return ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts.astimezone(timezone.utc)


def _field(*path):
    """A text value inside the event's JSON, e.g. _field("decision", "action")."""
    return Event.data[path if len(path) > 1 else path[0]].as_string()


def _scope(child_ids, kind, since=None):
    where = [Event.kind == kind, Event.child_id.in_(list(child_ids))]
    if since is not None:
        where.append(Event.timestamp >= since)
    return where


def _count(where) -> int:
    return db.session.scalar(select(func.count(Event.id)).where(*where))


# Count events by one field and return the 50 biggest groups, for the dashboard's charts.
def _group(where, key) -> dict:
    n = func.count(Event.id)
    rows = db.session.execute(select(key, n).where(*where).group_by(key).order_by(n.desc()).limit(50))
    return {str(k): c for k, c in rows if k not in (None, "")}


# Events per UTC day, oldest first.
def _per_day(where) -> list:
    day = func.date(Event.timestamp)
    rows = db.session.execute(select(day, func.count(Event.id)).where(*where).group_by(day).order_by(day))
    return [{"day": str(d), "count": c} for d, c in rows]


# Newest-first page of events for the given children, with cursor paging via `before`.
def recent_events(child_ids, kind, limit=50, before=None, extra=None):
    q = select(Event).where(*_scope(child_ids, kind))
    if before:
        q = q.where(Event.timestamp < _utc(before))
    for key, value in (extra or {}).items():
        q = q.where(_field(key) == value)
    rows = db.session.scalars(q.order_by(Event.timestamp.desc(), Event.id.desc()).limit(max(1, min(limit, 100))))
    # Same shape the dashboard has always read: the reported fields, plus who and when (the server's values win).
    return [{**(e.data or {}), "id": str(e.id), "child_id": e.child_id, "device_id": e.device_id,
             "timestamp": _utc(e.timestamp).isoformat()} for e in rows]


# All numbers and chart series for the home page in one call.
def dashboard_stats(child_ids, days=7):
    since = _since(days)
    browser = _scope(child_ids, "browser", since)
    cookie = _scope(child_ids, "cookie", since)
    download = _scope(child_ids, "download", since)
    security = _scope(child_ids, "security", since)

    checks = browser + [_field("decision", "action").isnot(None)]
    # A page counts as 'blocked' when the decision was BLOCK, REVIEW or ASK.
    blocked = checks + [_field("decision", "action").in_(["BLOCK", "REVIEW", "ASK"])]
    downloads_blocked = download + [_field("action") == "BLOCK"]
    cookies = cookie + [_field("type") == "cookie"]
    cookies_blocked = cookies + [_field("action") == "BLOCKED"]
    return {
        "days": days,
        "totals": {
            "checks": _count(checks),
            "blocked": _count(blocked),
            "unknown_sites": _count(checks + [_field("decision", "level").in_(["AI", "UNKNOWN_DEFAULT"])]),
            "ai_classifications": _count(checks + [_field("ai") == "classified"]),
            "access_requests": _count(browser + [_field("type") == "access_request"]),
            "downloads_blocked": _count(downloads_blocked),
            "security_events": _count(security),
            "trackers_blocked": _count(cookies_blocked + [_field("rule") == "tracker"]),
            "cookies_blocked": _count(cookies_blocked),
        },
        "blocked_by_category": _group(blocked, _field("decision", "category")),
        "downloads_by_kind": _group(downloads_blocked, _field("kind")),
        "security_by_type": _group(security, _field("type")),
        "cookies_by_purpose": _group(cookies, _field("purpose")),
        "blocked_per_day": _per_day(blocked),     # trend chart
        "security_per_day": _per_day(security),   # warnings and guard events per day (adult home chart)
    }


__all__ = ["KINDS", "dashboard_stats", "recent_events"]
