// Token buckets for rate limiting. Time is passed in so the hot path calls Date.now() once per request and tests can control it.
"use strict";

class TokenBucket {
  constructor(ratePerSec, burst, nowMs = Date.now()) {
    this.rate = ratePerSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.last = nowMs;
  }
  take(nowMs, n = 1) {
    const dt = nowMs - this.last;
    if (dt > 0) { this.tokens = Math.min(this.burst, this.tokens + dt * this.rate); this.last = nowMs; }
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
  // Seconds until one token is available (for Retry-After).
  retryAfter() { return Math.max(1, Math.ceil((1 - this.tokens) / (this.rate * 1000))); }
}

module.exports = { TokenBucket };
