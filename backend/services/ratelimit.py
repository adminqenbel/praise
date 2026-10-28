"""Rate limiting: a small in-process sliding window, plus fixed-window counters in the database that every worker shares.

The in-process limiter is exact but per worker: with N workers the limits multiply by N. That is fine for a flood
guard on a hot path (the per-device `check` limit), but not for guarding passwords, pairing codes or AI spend. Limits
declared with `shared=True` count in the `rate_counters` table instead when RATELIMIT_SHARED is on (environment
variable or app config; off by default so a single-worker or test setup pays no extra query). If the database
cannot be reached the limiter falls back to the in-process count rather than failing the request.
"""
import hashlib
import logging
import os
import threading
import time
from collections import defaultdict, deque
from functools import wraps

from flask import current_app, has_app_context, jsonify, request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from database.models import RateCounter
from database.postgres import db

log = logging.getLogger("praise.security")


# Remembers recent attempts per key and refuses new ones once the limit for the time window is reached.
class RateLimiter:
    def __init__(self):
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_s: float, shared: bool = False) -> tuple[bool, int]:
        """Record one attempt. Returns (allowed, seconds_until_retry). `shared` counts it in the database
        (all workers) when that is switched on."""
        if shared and shared_enabled():
            try:
                return shared_allow(key, limit, window_s)
            except SQLAlchemyError:
                db.session.rollback()
                log.warning("shared rate limiter unavailable; using the in-process count", exc_info=True)
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window_s:
                q.popleft()
            if len(q) >= limit:
                return False, max(1, int(window_s - (now - q[0])) + 1)
            q.append(now)
            if len(self._hits) > 10000:          # bound memory: drop idle keys
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > window_s]:
                    self._hits.pop(k, None)
            return True, 0

    def reset(self):
        with self._lock:
            self._hits.clear()


# One shared limiter for the process.
limiter = RateLimiter()


# ---- counters shared by all workers ---------------------------------------------------------------------------
_PRUNE_EVERY = 60.0
_last_prune = 0.0


def shared_enabled() -> bool:
    if not has_app_context():
        return False
    flag = current_app.config.get("RATELIMIT_SHARED")
    if flag is None:
        flag = os.environ.get("RATELIMIT_SHARED", "") == "1"
    return bool(flag)


def shared_take(key: str, bucket: int, limit: int, expires_at: int) -> bool:
    """Atomically count one hit in (key, bucket) unless it already holds `limit`. Commits the session."""
    where = (RateCounter.key == key, RateCounter.bucket == bucket)
    for _ in range(3):
        # One UPDATE does the check and the increment, so two workers cannot both take the last slot.
        if db.session.execute(update(RateCounter).where(*where, RateCounter.hits < limit)
                              .values(hits=RateCounter.hits + 1)).rowcount:
            db.session.commit()
            return True
        if db.session.execute(select(RateCounter.hits).where(*where)).first() is not None:
            db.session.commit()
            return False                                   # the row exists and is full
        try:
            db.session.add(RateCounter(key=key, bucket=bucket, hits=1, expires_at=expires_at))
            db.session.commit()
            _prune()
            return True
        except IntegrityError:                             # another worker created it first: count on theirs
            db.session.rollback()
    return False


def shared_allow(key: str, limit: int, window_s: float) -> tuple[bool, int]:
    """Fixed window: at most `limit` hits per `window_s` seconds across every worker. A burst can straddle two
    windows (up to twice the limit within one window length), which is acceptable for abuse limits."""
    window = max(1, int(window_s))
    key = hashlib.sha256(key.encode("utf-8", "replace")).hexdigest()    # keys can hold an email; store only a digest
    now = time.time()
    bucket = int(now // window)
    end = (bucket + 1) * window
    ok = shared_take(key, bucket, limit, int(end) + window)
    return ok, 0 if ok else max(1, int(end - now) + 1)


def _prune() -> None:
    """Delete finished windows, at most once a minute per process."""
    global _last_prune
    now = time.monotonic()
    if now - _last_prune < _PRUNE_EVERY:
        return
    _last_prune = now
    try:
        db.session.execute(RateCounter.__table__.delete().where(RateCounter.expires_at < int(time.time())))
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()


def client_ip() -> str:
    # remote_addr only: X-Forwarded-For is client-controlled. Behind a proxy, ProxyFix (TRUSTED_PROXY_HOPS)
    # has already replaced remote_addr with the address the trusted proxy saw.
    return request.remote_addr or "unknown"


def rate_limit(name: str, limit: int, window_s: float, key_fn=None, shared: bool = False):
    """Decorator. Key defaults to the client IP; pass key_fn for per-account/per-device keys.
    `shared=True` counts across all workers (see the module docstring)."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            if not current_app.config.get("RATELIMIT_ENABLED", True):
                return fn(*a, **kw)
            ident = key_fn() if key_fn else client_ip()
            ok, retry = limiter.allow(f"{name}:{ident}", limit, window_s, shared=shared)
            if not ok:
                log.warning("rate limit hit: %s key=%s", name, ident)
                # Answer 429 with a Retry-After header so well-behaved clients wait.
                resp = jsonify(error=f"Too many attempts. Try again in {retry} seconds.")
                resp.status_code = 429
                resp.headers["Retry-After"] = str(retry)
                return resp
            return fn(*a, **kw)
        return wrapper
    return deco
