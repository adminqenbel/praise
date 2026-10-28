"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { startAgent, tmpDir, rmDir, fakeApi, FAMILY, ADULT, sleep } = require("./helpers");
const { backoffDelay, jittered, createSync } = require("../src/sync");
const secrets = require("../src/secrets");
const store = require("../src/store");
const { filesIn } = require("../src/paths");

const DEVICE = "dev-token-" + "z".repeat(32);

// An agent that is paired to `api` (device token file written, API origin configured), manual sync only.
async function pairedAgent(api, over = {}) {
  const dir = tmpDir();
  secrets.writeDeviceToken(path.join(dir, "device-token"), DEVICE, { harden: false });
  const a = await startAgent({ dir, ...over, config: { api: api.origin, sync: { manual_min_gap_ms: 0, ...(over.sync || {}) }, ...(over.config || {}) } });
  return a;
}

test("backoffDelay: exponential, capped, jittered within [step/2, step]", () => {
  const cfg = { baseMs: 1000, maxMs: 30000 };
  assert.equal(backoffDelay(0, cfg, () => 0), 500);
  assert.equal(backoffDelay(0, cfg, () => 1), 1000);
  assert.equal(backoffDelay(3, cfg, () => 1), 8000);
  assert.equal(backoffDelay(10, cfg, () => 1), 30000);       // capped
  assert.equal(backoffDelay(10_000, cfg, () => 0), 15000);   // no overflow for huge attempt counts
  for (let i = 0; i < 200; i++) { const d = backoffDelay(4, cfg, Math.random); assert.ok(d >= 8000 && d <= 16000, String(d)); }
  const ds = new Set(Array.from({ length: 50 }, () => backoffDelay(5, cfg, Math.random)));
  assert.ok(ds.size > 10, "jitter actually varies");
});

test("jittered refresh interval stays within +-jitter", () => {
  assert.equal(jittered(1000, 0.2, () => 0), 800);
  assert.equal(jittered(1000, 0.2, () => 1), 1200);
  assert.equal(jittered(1000, 0.2, () => 0.5), 1000);
});

test("pull applies the snapshot, sends the device token only to the API, and persists it", async () => {
  const api = await fakeApi({ body: FAMILY, etag: '"v1"' });
  const a = await pairedAgent(api);
  try {
    const r = await a.call("/v1/sync", { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.match(r.json.policy_version, /^[0-9a-f]{16}$/);
    assert.equal(api.seen[0].url, "/api/ext/policy-sync");
    assert.equal(api.seen[0].auth, "Bearer " + DEVICE);
    assert.ok(!r.text.includes(DEVICE));
    assert.equal((await a.call("/v1/decide", { body: { url: "https://badsite.com/" } })).json.reason, "offline-parent-block");
    const saved = store.loadSnapshot(filesIn(a.agent.dirs).snapshot);
    assert.equal(saved.status, "ok"); assert.equal(saved.etag, '"v1"');
    assert.ok(!fs.readFileSync(filesIn(a.agent.dirs).snapshot, "utf8").includes(DEVICE));
  } finally { await a.stop(); await api.close(); }
});

test("POST /v1/sync with an empty body works, with junk is rejected", async () => {
  const api = await fakeApi({});
  const a = await pairedAgent(api);
  try {
    const r = await a.call("/v1/sync", { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal((await a.call("/v1/sync", { body: { evil: 1 } })).status, 400);
  } finally { await a.stop(); await api.close(); }
});

test("ETag: next pull sends If-None-Match, 304 keeps the policy and the cache", async () => {
  const api = await fakeApi({ body: ADULT, etag: '"abc"' });
  const a = await pairedAgent(api);
  try {
    const first = (await a.call("/v1/sync", { body: {} })).json;
    await a.call("/v1/decide", { body: { url: "https://sus-site.com/" } });
    const second = (await a.call("/v1/sync", { body: {} })).json;
    assert.equal(api.seen[1].inm, '"abc"');
    assert.equal(second.policy_version, first.policy_version);
    assert.equal(second.changed, false);
    assert.equal((await a.call("/v1/decide", { body: { url: "https://sus-site.com/" } })).json.cached, true);   // cache survived
  } finally { await a.stop(); await api.close(); }
});

test("a changed policy replaces the old one and clears cached decisions", async () => {
  const api = await fakeApi({ body: ADULT });
  const a = await pairedAgent(api);
  try {
    await a.call("/v1/sync", { body: {} });
    assert.equal((await a.call("/v1/decide", { body: { url: "https://fresh.com/" } })).json.action, "ALLOW");
    api.state.body = { ...ADULT, block_domains: ["fresh.com"] };
    const r = (await a.call("/v1/sync", { body: {} })).json;
    assert.equal(r.changed, true);
    assert.equal((await a.call("/v1/decide", { body: { url: "https://fresh.com/" } })).json.action, "BLOCK");
  } finally { await a.stop(); await api.close(); }
});

test("not paired: /v1/sync answers 409 not_configured and nothing is sent anywhere", async () => {
  const api = await fakeApi({});
  const dir = tmpDir();
  const a = await startAgent({ dir, config: { api: api.origin } });
  try {
    const r = await a.call("/v1/sync", { body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "not_configured");
    assert.equal(api.seen.length, 0);
  } finally { await a.stop(); await api.close(); }
});

test("revoked device token (401): keep enforcing the last policy, flag it, reset failure count", async () => {
  const api = await fakeApi({ body: ADULT });
  const a = await pairedAgent(api);
  try {
    await a.call("/v1/sync", { body: {} });
    api.state.status = 401;
    const r = await a.call("/v1/sync", { body: {} });
    assert.equal(r.status, 502); assert.equal(r.json.error, "revoked");
    const h = (await a.call("/v1/health", { method: "GET" })).json;
    assert.equal(h.policy.revoked, true); assert.equal(h.policy.loaded, true);
    assert.equal((await a.call("/v1/decide", { body: { url: "https://x.com/" } })).json.action, "ALLOW");
  } finally { await a.stop(); await api.close(); }
});

test("API errors (500, garbage, wrong shape, oversize) never replace a good policy", async () => {
  const api = await fakeApi({ body: ADULT });
  const a = await pairedAgent(api);
  try {
    await a.call("/v1/sync", { body: {} });
    const version = (await a.call("/v1/health", { method: "GET" })).json.policy.version;
    for (const [patch, error] of [[{ status: 500 }, "http_500"], [{ status: 200, raw: "<html>nope" }, "bad_payload"], [{ status: 200, raw: '{"hello":1}' }, "bad_payload"],
      [{ status: 200, raw: "[]" }, "bad_payload"], [{ status: 200, raw: JSON.stringify({ unknown_action: "ALLOW", pad: "x".repeat(9 * 1024 * 1024) }) }, "bad_payload"]]) {
      Object.assign(api.state, { status: 200, raw: null }, patch);
      const r = await a.call("/v1/sync", { body: {} });
      assert.equal(r.status, 502, error); assert.equal(r.json.error, error);
      assert.equal((await a.call("/v1/health", { method: "GET" })).json.policy.version, version);
    }
  } finally { await a.stop(); await api.close(); }
});

test("redirects are refused, so the device token cannot be forwarded to another host", async () => {
  const other = await fakeApi({});
  const api = await fakeApi({ redirectTo: other.origin + "/steal" });
  const a = await pairedAgent(api);
  try {
    const r = await a.call("/v1/sync", { body: {} });
    assert.equal(r.status, 502);
    assert.equal(other.seen.length, 0);
  } finally { await a.stop(); await api.close(); await other.close(); }
});

test("offline (connection refused): sync fails cleanly and the saved snapshot keeps being enforced", async () => {
  const api = await fakeApi({ body: FAMILY });
  const a = await pairedAgent(api);
  try {
    await a.call("/v1/sync", { body: {} });
    await api.close();                                    // API disappears
    const r = await a.call("/v1/sync", { body: {} });
    assert.equal(r.status, 502); assert.equal(r.json.error, "network");
    const h = (await a.call("/v1/health", { method: "GET" })).json;
    assert.equal(h.policy.offline, true);
    assert.equal((await a.call("/v1/decide", { body: { url: "https://badsite.com/" } })).json.action, "BLOCK");
    assert.equal((await a.call("/v1/decide", { body: { url: "https://wikipedia.org/" } })).json.action, "ALLOW");
  } finally { await a.stop(); }
});

test("slow API: the request times out instead of hanging", async () => {
  const api = await fakeApi({ body: FAMILY, delay: 1500 });
  const a = await pairedAgent(api, { sync: { timeout_ms: 150 } });
  try {
    const t0 = Date.now();
    const r = await a.call("/v1/sync", { body: {} });
    assert.equal(r.json.error, "timeout");
    assert.ok(Date.now() - t0 < 1200);
  } finally { await a.stop(); await api.close(); }
});

test("concurrent manual syncs share one upstream request; the min gap throttles bursts", async () => {
  const api = await fakeApi({ body: FAMILY, delay: 50 });
  const a = await pairedAgent(api, { sync: { manual_min_gap_ms: 5000 } });
  try {
    const rs = await Promise.all(Array.from({ length: 6 }, () => a.call("/v1/sync", { body: {} })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(api.seen.length, 1);
    await a.call("/v1/sync", { body: {} });
    assert.equal(api.seen.length, 1, "throttled by manual_min_gap_ms");
  } finally { await a.stop(); await api.close(); }
});

// Scheduler: drive it with an injected timer so delays can be inspected without waiting.
function schedulerHarness(statuses, { random = () => 0.5 } = {}) {
  const delays = [];
  let i = 0;
  const engine = { policy: null, setPolicy() { return { changed: true, version: "v" }; } };
  const cfg = { api: "http://127.0.0.1:1", sync: { interval_ms: 600000, jitter: 0.2, backoff_base_ms: 1000, backoff_max_ms: 16000, timeout_ms: 1000, revoked_retry_ms: 3600000, unconfigured_poll_ms: 30000 } };
  const fetchFn = async () => {
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s === "net") throw new TypeError("fetch failed");
    return new Response(s === 200 ? JSON.stringify(FAMILY) : "{}", { status: s, headers: s === 429 ? { "Retry-After": "30" } : {} });
  };
  let fire;
  const sync = createSync({
    engine, getConfig: () => cfg, getDeviceToken: () => DEVICE, fetchFn, random,
    setTimer: (fn, ms) => { delays.push(ms); fire = fn; return { unref() {} }; }, clearTimer() {},
  });
  return { sync, delays, tick: async () => { const f = fire; await f(); } };
}

test("scheduler: failures back off exponentially (with jitter), success returns to the jittered interval", async () => {
  const h = schedulerHarness(["net", 500, "net", 200, 200]);
  h.sync.start();
  assert.deepEqual(h.delays, [0]);
  await h.tick(); await h.tick(); await h.tick();
  // random()=0.5 => 75% of each exponential step: 1000, 2000, 4000
  assert.deepEqual(h.delays.slice(1), [750, 1500, 3000]);
  await h.tick();                            // success
  assert.equal(h.delays[4], 600000);         // 0.5 -> exactly the interval
  assert.equal(h.sync.state.failures, 0);
  h.sync.stop();
});

test("scheduler: Retry-After is honoured, a revoked token backs off for an hour, an unpaired agent polls slowly", async () => {
  const h = schedulerHarness([429, 401]);
  h.sync.start();
  await h.tick();
  assert.equal(h.delays[1], 30000);          // Retry-After 30s beats the 750ms backoff
  await h.tick();
  assert.equal(h.delays[2], 3600000);
  assert.equal(h.sync.state.revoked, true);
  h.sync.stop();
  const none = createSync({ engine: {}, getConfig: () => ({ api: "http://127.0.0.1:1", sync: { unconfigured_poll_ms: 30000, jitter: 0, interval_ms: 1, backoff_base_ms: 1, backoff_max_ms: 1, revoked_retry_ms: 1, timeout_ms: 1 } }), getDeviceToken: () => null, fetchFn: async () => { throw new Error("must not be called"); } });
  assert.deepEqual(await none.pullNow(), { ok: false, error: "not_configured" });
});

test("the real scheduler runs on its own: first pull at start, later pulls on the refresh interval", async () => {
  const api = await fakeApi({ body: FAMILY, etag: '"e"' });
  const dir = tmpDir();
  secrets.writeDeviceToken(path.join(dir, "device-token"), DEVICE, { harden: false });
  const a = await startAgent({ dir, agent: { sync: true }, config: { api: api.origin, sync: { interval_ms: 80, jitter: 0 } } });
  try {
    await sleep(500);
    assert.ok(api.seen.length >= 3, `pulls: ${api.seen.length}`);
    assert.equal(api.seen[0].inm, undefined);
    assert.equal(api.seen[1].inm, '"e"');
  } finally { await a.stop(); await api.close(); }
});

test("real scheduler recovers after an outage: retries with backoff, then converges", async () => {
  const api = await fakeApi({ body: FAMILY, status: 503 });
  const dir = tmpDir();
  secrets.writeDeviceToken(path.join(dir, "device-token"), DEVICE, { harden: false });
  const a = await startAgent({ dir, agent: { sync: true }, config: { api: api.origin, sync: { interval_ms: 60000, backoff_base_ms: 40, backoff_max_ms: 200 } } });
  try {
    await sleep(350);
    const failedPulls = api.seen.length;
    assert.ok(failedPulls >= 2 && failedPulls <= 8, `pulls during outage: ${failedPulls}`);     // backoff, not a hot loop
    api.state.status = 200;
    for (let i = 0; i < 40 && !a.agent.engine.policy; i++) await sleep(50);
    assert.ok(a.agent.engine.policy, "policy arrived after the API recovered");
  } finally { await a.stop(); await api.close(); }
});

test("event forwarding is off by default (409) and validated when on; batches go to /api/ext/events with the device token", async () => {
  const api = await fakeApi({});
  const off = await pairedAgent(api);
  try {
    assert.equal((await off.call("/v1/events", { body: { events: [{ kind: "cookie", data: {} }] } })).status, 409);
  } finally { await off.stop(); }
  const dir = tmpDir();
  secrets.writeDeviceToken(path.join(dir, "device-token"), DEVICE, { harden: false });
  const on = await startAgent({ dir, config: { api: api.origin, forward_events: true, events: { flush_at: 2 } } });
  try {
    const r = await on.call("/v1/events", { body: { events: [{ kind: "cookie", data: { domain: "a.com" } }, { kind: "BAD KIND", data: {} }, { kind: "download", data: { name: "x" } }] } });
    assert.equal(r.status, 202); assert.deepEqual(r.json, { accepted: 2, rejected: 1 });
    for (let i = 0; i < 40 && !api.seen.some((s) => s.url === "/api/ext/events"); i++) await sleep(25);
    const up = api.seen.find((s) => s.url === "/api/ext/events");
    assert.ok(up, "batch uploaded");
    assert.equal(up.auth, "Bearer " + DEVICE);
    assert.equal(JSON.parse(up.body).events.length, 2);
    assert.equal(on.agent.events.length, 0);
  } finally { await on.stop(); await api.close(); }
});

test("a failed event upload keeps the events queued", async () => {
  const api = await fakeApi({ eventsStatus: 500 });
  const dir = tmpDir();
  secrets.writeDeviceToken(path.join(dir, "device-token"), DEVICE, { harden: false });
  const a = await startAgent({ dir, config: { api: api.origin, forward_events: true } });
  try {
    await a.call("/v1/events", { body: { events: [{ kind: "cookie", data: {} }] } });
    const r = await a.agent.events.flush();
    assert.equal(r.sent, 0);
    assert.equal(a.agent.events.length, 1);
  } finally { await a.stop(); await api.close(); }
});
