"""Read-side queries over MongoDB events. Always scoped to an explicit list of child ids
that the caller already proved ownership of (never taken from request input)."""
from datetime import datetime, timedelta, timezone

from database.mongo import get_mongo

# Event kind -> MongoDB collection for read queries.
KIND_COLLECTIONS = {
    "browser": "browser_events",
    "cookie": "cookie_events",
    "download": "download_events",
    "security": "security_events",
}


# Start of the reporting window, limited to the 90 days the data is kept.
def _since(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 90)))


# Count events by one field and return the 50 biggest groups, for the dashboard's charts.
def _group(coll, match, key):
    rows = get_mongo()[coll].aggregate([
        {"$match": match}, {"$group": {"_id": key, "n": {"$sum": 1}}}, {"$sort": {"n": -1}},
        {"$limit": 50}])
    return {str(r["_id"]): r["n"] for r in rows if r["_id"] not in (None, "")}


# Newest-first page of events for the given children, with cursor paging via `before`.
def recent_events(child_ids, kind, limit=50, before=None, extra=None):
    coll = KIND_COLLECTIONS[kind]
    match = {"child_id": {"$in": list(child_ids)}}
    if before:
        match["timestamp"] = {"$lt": before}
    if extra:
        match.update(extra)
    docs = get_mongo()[coll].find(match).sort("timestamp", -1).limit(max(1, min(limit, 100)))
    out = []
    for d in docs:
        d["id"] = str(d.pop("_id"))
        ts = d["timestamp"]
        if ts.tzinfo is None:  # pymongo returns naive UTC datetimes; label them so browsers don't guess
            ts = ts.replace(tzinfo=timezone.utc)
        d["timestamp"] = ts.isoformat()
        out.append(d)
    return out


# All numbers and chart series for the home page in one call.
def dashboard_stats(child_ids, days=7):
    since = {"$gte": _since(days)}
    base = {"child_id": {"$in": list(child_ids)}, "timestamp": since}
    m = get_mongo()

    browser = {**base, "decision": {"$exists": True}}
    # A page counts as 'blocked' when the decision was BLOCK, REVIEW or ASK.
    blocked = {**browser, "decision.action": {"$in": ["BLOCK", "REVIEW", "ASK"]}}

    # blocked per day for the trend chart
    per_day = m["browser_events"].aggregate([
        {"$match": blocked},
        {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$timestamp"}},
                    "n": {"$sum": 1}}},
        {"$sort": {"_id": 1}}])

    # warnings and guard events per day (adult home chart)
    security_per_day = m["security_events"].aggregate([
        {"$match": base},
        {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$timestamp"}}, "n": {"$sum": 1}}},
        {"$sort": {"_id": 1}}])

    cookie_blocked = {**base, "type": "cookie", "action": "BLOCKED"}
    return {
        "days": days,
        "totals": {
            "checks": m["browser_events"].count_documents(browser),
            "blocked": m["browser_events"].count_documents(blocked),
            "unknown_sites": m["browser_events"].count_documents(
                {**browser, "decision.level": {"$in": ["AI", "UNKNOWN_DEFAULT"]}}),
            "ai_classifications": m["browser_events"].count_documents({**browser, "ai": "classified"}),
            "access_requests": m["browser_events"].count_documents({**base, "type": "access_request"}),
            "downloads_blocked": m["download_events"].count_documents({**base, "action": "BLOCK"}),
            "security_events": m["security_events"].count_documents(base),
            "trackers_blocked": m["cookie_events"].count_documents({**cookie_blocked, "rule": "tracker"}),
            "cookies_blocked": m["cookie_events"].count_documents(cookie_blocked),
        },
        "blocked_by_category": _group("browser_events", blocked, "$decision.category"),
        "downloads_by_kind": _group("download_events", {**base, "action": "BLOCK"}, "$kind"),
        "security_by_type": _group("security_events", base, "$type"),
        "cookies_by_purpose": _group("cookie_events", {**base, "type": "cookie"}, "$purpose"),
        "blocked_per_day": [{"day": r["_id"], "count": r["n"]} for r in per_day],
        "security_per_day": [{"day": r["_id"], "count": r["n"]} for r in security_per_day],
    }
