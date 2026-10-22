"""Small in-process sliding-window rate limiter.

Single-process only (fine for local/dev and one-worker deployments). Running several
workers needs a shared store such as Redis; the call sites would not change.
"""
import logging
import threading
import time
from collections import defaultdict, deque
from functools import wraps

from flask import current_app, jsonify, request

log = logging.getLogger("praise.security")


# Remembers recent attempts per key and refuses new ones once the limit for the time window is reached.
class RateLimiter:
    def __init__(self):
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_s: float) -> tuple[bool, int]:
        """Record one attempt. Returns (allowed, seconds_until_retry)."""
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


def client_ip() -> str:
    # remote_addr only: X-Forwarded-For is client-controlled. Behind a proxy, ProxyFix (TRUSTED_PROXY_HOPS)
    # has already replaced remote_addr with the address the trusted proxy saw.
    return request.remote_addr or "unknown"


def rate_limit(name: str, limit: int, window_s: float, key_fn=None):
    """Decorator. Key defaults to the client IP; pass key_fn for per-account/per-device keys."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            if not current_app.config.get("RATELIMIT_ENABLED", True):
                return fn(*a, **kw)
            ident = key_fn() if key_fn else client_ip()
            ok, retry = limiter.allow(f"{name}:{ident}", limit, window_s)
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
