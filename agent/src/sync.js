// Policy sync: pulls /api/ext/policy-sync with the device token, keeps the last good snapshot on disk, and keeps enforcing it while
// offline. Failures back off exponentially with jitter; successful pulls are re-scheduled with jitter so many installs do not
// hit the API in step. The device token is read from its own file at call time and only ever goes into an Authorization header.
"use strict";

const policyLib = require("./policy");
const store = require("./store");
const { silent } = require("./log");

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// "Equal jitter": half of the exponential step is fixed, half is random, so retries never collapse to zero and never synchronise.
function backoffDelay(attempt, { baseMs, maxMs }, random = Math.random) {
  const step = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(step / 2 + random() * (step / 2));
}

function jittered(ms, jitter, random = Math.random) { return Math.round(ms * (1 - jitter + 2 * jitter * random())); }

async function readCapped(res, max) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw new Error("response too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createSync(deps) {
  const {
    engine, getConfig, getDeviceToken, files = null, fetchFn = globalThis.fetch, now = Date.now, random = Math.random,
    log = silent, setTimer = setTimeout, clearTimer = clearTimeout,
  } = deps;

  const st = {
    version: null, etag: null, fetchedAt: 0, lastAttemptAt: 0, lastError: null, failures: 0, revoked: false,
    child: "", mode: null, running: false, offline: false,
  };
  let inflight = null, last = null, lastDoneAt = 0, timer = null, stopped = true;

  // Load the persisted snapshot (if any, valid, and readable) so decisions work before the first successful pull.
  function restore() {
    if (!files) return { status: "none" };
    const r = store.loadSnapshot(files.snapshot);
    if (r.status !== "ok") return { status: r.status };
    const norm = policyLib.normalizeSnapshot(r.snapshot);
    if (!norm) return { status: "corrupt" };
    const { version } = engine.setPolicy(norm);
    Object.assign(st, { version, etag: r.etag, fetchedAt: r.fetchedAt, child: norm.child, mode: norm.mode });
    return { status: "ok", version };
  }

  async function doPull() {
    const cfg = getConfig();
    const token = getDeviceToken();
    if (!token || !cfg.api) return { ok: false, error: "not_configured" };
    st.lastAttemptAt = now();
    const ctl = new AbortController();
    const abortTimer = setTimeout(() => ctl.abort(), cfg.sync.timeout_ms);
    try {
      const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
      if (st.etag) headers["If-None-Match"] = st.etag;
      const res = await fetchFn(new URL("/api/ext/policy-sync", cfg.api).href, { headers, redirect: "error", signal: ctl.signal });
      if (res.status === 304) { st.fetchedAt = now(); st.offline = false; return { ok: true, changed: false, policy_version: st.version }; }
      if (res.status === 401 || res.status === 403) {
        st.revoked = true;      // keep enforcing the last policy, like the extension does
        try { await res.body?.cancel(); } catch (e) { /* ignore */ }
        return { ok: false, error: "revoked" };
      }
      if (!res.ok) {
        try { await res.body?.cancel(); } catch (e) { /* ignore */ }
        const ra = Number(res.headers.get("retry-after"));
        return { ok: false, error: "http_" + res.status, retryAfterMs: ra > 0 ? Math.min(ra, 3600) * 1000 : 0 };
      }
      let raw;
      try { raw = JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES)); } catch (e) { return { ok: false, error: "bad_payload" }; }
      const norm = policyLib.normalizeSnapshot(raw);
      if (!norm) return { ok: false, error: "bad_payload" };
      const version = policyLib.versionOf(norm);
      const unchanged = !!engine.policy && engine.policy.version === version;
      if (!unchanged) engine.setPolicy(norm);
      const etag = res.headers.get("etag");
      Object.assign(st, { version, etag: etag || null, fetchedAt: now(), child: norm.child, mode: norm.mode, revoked: false, offline: false });
      if (files && (!unchanged || !etag)) {
        try { store.saveSnapshot(files.snapshot, { snapshot: norm, etag, fetchedAt: st.fetchedAt }); } catch (e) { log.warn("snapshot save failed", { code: e.code || e.name }); }
      }
      return { ok: true, changed: !unchanged, policy_version: version };
    } catch (e) {
      st.offline = true;
      return { ok: false, error: e && e.name === "AbortError" ? "timeout" : "network" };   // never include e.message: it can carry URLs
    } finally { clearTimeout(abortTimer); }
  }

  // Coalesced: concurrent callers share one upstream request, and calls within `minGapMs` of the last one reuse its result.
  function pullNow({ minGapMs = 0 } = {}) {
    if (inflight) return inflight;
    if (minGapMs && last && now() - lastDoneAt < minGapMs) return Promise.resolve({ ...last, throttled: true });
    inflight = doPull().then((r) => {
      st.lastError = r.ok ? null : r.error;
      st.failures = r.ok || r.error === "not_configured" || r.error === "revoked" ? 0 : st.failures + 1;
      last = r; lastDoneAt = now(); inflight = null;
      return r;
    });
    return inflight;
  }

  function nextDelay(r) {
    const s = getConfig().sync;
    if (r.ok) return jittered(s.interval_ms, s.jitter, random);
    if (r.error === "revoked") return jittered(s.revoked_retry_ms, s.jitter, random);
    if (r.error === "not_configured") return jittered(s.unconfigured_poll_ms, s.jitter, random);
    return Math.max(r.retryAfterMs || 0, backoffDelay(st.failures - 1, { baseMs: s.backoff_base_ms, maxMs: s.backoff_max_ms }, random));
  }

  function schedule(ms) {
    if (stopped) return;
    clearTimer(timer);
    timer = setTimer(tick, ms);
    if (timer && timer.unref) timer.unref();
  }
  async function tick() {
    if (stopped) return;
    const r = await pullNow();
    log.info("sync", { ok: r.ok, error: r.error || "", changed: !!r.changed });
    schedule(nextDelay(r));
  }

  return {
    state: st, restore, pullNow, nextDelay, backoffDelay: (a) => backoffDelay(a, getConfig().sync, random),
    start() { stopped = false; st.running = true; schedule(0); },
    stop() { stopped = true; st.running = false; clearTimer(timer); return inflight ? inflight.catch(() => {}) : Promise.resolve(); },
  };
}

module.exports = { createSync, backoffDelay, jittered };
