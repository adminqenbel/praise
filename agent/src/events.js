// Optional event forwarding: local tools POST activity events to the agent, which uploads them to /api/ext/events in batches.
// Off by default (events can contain URLs). The queue lives in memory only and is bounded; a failed upload backs off and keeps the batch.
"use strict";

const { backoffDelay } = require("./sync");
const { silent } = require("./log");

const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_EVENT_BYTES = 4096;

// Returns a clean {kind, data} or null.
function validateEvent(ev) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  if (typeof ev.kind !== "string" || !KIND_RE.test(ev.kind)) return null;
  if (!ev.data || typeof ev.data !== "object" || Array.isArray(ev.data)) return null;
  const s = JSON.stringify(ev.data);
  if (s.length > MAX_EVENT_BYTES) return null;
  return { kind: ev.kind, data: JSON.parse(s) };
}

function createEventForwarder(deps) {
  const {
    getConfig, getDeviceToken, fetchFn = globalThis.fetch, log = silent, random = Math.random,
    setTimer = setTimeout, clearTimer = clearTimeout,
  } = deps;
  const queue = [];
  let timer = null, failures = 0, stopped = true, flushing = null;

  function enabled() { return !!getConfig().forward_events; }

  function add(events) {
    const cfg = getConfig().events;
    let accepted = 0, rejected = 0;
    for (const ev of events) {
      const clean = validateEvent(ev);
      if (!clean) { rejected++; continue; }
      queue.push(clean); accepted++;
    }
    if (queue.length > cfg.queue_max) queue.splice(0, queue.length - cfg.queue_max);   // drop the oldest
    if (queue.length >= cfg.flush_at) schedule(0);
    return { accepted, rejected };
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const cfg = getConfig();
      const token = getDeviceToken();
      if (!queue.length || !token || !cfg.api) return { sent: 0 };
      const batch = queue.slice(0, 100);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), cfg.sync.timeout_ms);
      try {
        const res = await fetchFn(new URL("/api/ext/events", cfg.api).href, {
          method: "POST", redirect: "error", signal: ctl.signal,
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ events: batch }),
        });
        try { await res.body?.cancel(); } catch (e) { /* ignore */ }
        if (!res.ok) { failures++; return { sent: 0, error: "http_" + res.status }; }
        queue.splice(0, batch.length);
        failures = 0;
        return { sent: batch.length };
      } catch (e) { failures++; return { sent: 0, error: "network" }; } finally { clearTimeout(t); }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function schedule(ms) {
    if (stopped || !enabled()) return;
    clearTimer(timer);
    timer = setTimer(async () => {
      if (!enabled() || !queue.length) { schedule(getConfig().events.flush_interval_ms); return; }
      const r = await flush();
      if (r.error) schedule(backoffDelay(failures - 1, { baseMs: 5000, maxMs: 15 * 60000 }, random));
      else schedule(queue.length ? 0 : getConfig().events.flush_interval_ms);
      if (r.error) log.warn("event upload failed", { error: r.error });
    }, ms);
    if (timer && timer.unref) timer.unref();
  }

  return {
    enabled, add, flush, get length() { return queue.length; },
    start() { stopped = false; schedule(getConfig().events.flush_interval_ms); },
    async stop() { stopped = true; clearTimer(timer); if (enabled()) await flush(); },
  };
}

module.exports = { createEventForwarder, validateEvent };
