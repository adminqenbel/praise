"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TtlLruCache, Coalescer } = require("../src/cache");
const { createEngine } = require("../src/engine");
const { startAgent, FAMILY, ADULT, norm, fakeDetect, lib, sleep } = require("./helpers");

const entry = (head = "{}") => ({ status: 200, head });

test("LRU: oldest entry is evicted first and a read refreshes recency", () => {
  const c = new TtlLruCache({ maxEntries: 3, now: () => 0 });
  c.set("a", entry(), 1000); c.set("b", entry(), 1000); c.set("c", entry(), 1000);
  assert.ok(c.get("a"));                      // a is now the freshest
  c.set("d", entry(), 1000);                  // evicts b
  assert.equal(c.get("b"), undefined);
  for (const k of ["a", "c", "d"]) assert.ok(c.get(k), k);
  assert.equal(c.evictions, 1);
});

test("memory bound: total bytes stay under maxBytes", () => {
  const c = new TtlLruCache({ maxEntries: 1e6, maxBytes: 20000, now: () => 0 });
  for (let i = 0; i < 500; i++) c.set("k" + i, entry("x".repeat(200)), 1000);
  assert.ok(c.bytes <= 20000, String(c.bytes));
  assert.ok(c.size < 500);
  assert.ok(c.get("k499"));
});

test("TTL: entries expire, expired entries are removed on access, ttl <= 0 is not cached", () => {
  let t = 1000;
  const c = new TtlLruCache({ now: () => t });
  c.set("a", entry(), 500); c.set("zero", entry(), 0);
  assert.equal(c.get("zero"), undefined);
  t = 1499; assert.ok(c.get("a"));
  t = 1500; assert.equal(c.get("a"), undefined);
  assert.equal(c.size, 0); assert.equal(c.bytes, 0);
});

test("re-setting a key replaces it without leaking byte accounting", () => {
  const c = new TtlLruCache({ now: () => 0 });
  c.set("a", entry("x".repeat(100)), 1000); const one = c.bytes;
  c.set("a", entry("x".repeat(100)), 1000);
  assert.equal(c.bytes, one); assert.equal(c.size, 1);
});

function engineWith(over = {}) {
  let t = 1_000_000;
  const detect = over.detect || fakeDetect();
  const e = createEngine({ detect, lib, now: () => t, ...over.opts });
  e.setPolicy(norm(over.policy || ADULT));
  return { e, detect, tick: (ms) => { t += ms; } };
}

test("positive results are cached for the server's TTLs (ALLOW 1h, WARN 10min, BLOCK 1h) and then recomputed", () => {
  const { e, detect, tick } = engineWith();
  const url = "https://sus-site.com/";
  assert.equal(JSON.parse(e.decide(url).body).cache_ttl, 600);                       // WARN
  e.decide(url); e.decide(url);
  assert.equal(detect.calls.url, 1);
  tick(599_000); e.decide(url); assert.equal(detect.calls.url, 1);
  tick(2_000);  e.decide(url); assert.equal(detect.calls.url, 2);
  assert.equal(JSON.parse(e.decide("https://fine.com/").body).cache_ttl, 3600);      // ALLOW
});

test("a hit reports cached:true, a fresh result cached:false, bodies otherwise identical", () => {
  const { e } = engineWith();
  const a = JSON.parse(e.score("https://x.com/").body), b = JSON.parse(e.score("https://x.com/").body);
  assert.equal(a.cached, false); assert.equal(b.cached, true);
  delete a.cached; delete b.cached;
  assert.deepEqual(a, b);
});

test("negative caching: an invalid URL is remembered briefly and the detector is not asked", () => {
  const { e, detect, tick } = engineWith({ opts: { negativeTtlMs: 5000 } });
  for (let i = 0; i < 3; i++) assert.equal(e.score("not a url").status, 400);
  assert.equal(JSON.parse(e.score("not a url").body).cached, true);
  assert.equal(detect.calls.url, 0);
  tick(6000);
  assert.equal(JSON.parse(e.score("not a url").body).cached, false);       // expired, recomputed
});

test("negative caching: a detector failure is cached briefly (503 for score, degraded policy-only answer for decide)", () => {
  let calls = 0;
  const boom = { version: 1, scoreUrl() { calls++; throw new Error("boom https://leak.example"); }, scorePage() { throw new Error("x"); }, combine: (v) => v[0] };
  const { e, tick } = engineWith({ detect: boom, opts: { negativeTtlMs: 5000 } });
  assert.equal(e.score("https://x.com/").status, 503);
  assert.equal(e.score("https://x.com/").status, 503);
  assert.equal(calls, 1);
  const d = JSON.parse(e.decide("https://y.com/").body);
  assert.equal(d.action, "ALLOW"); assert.equal(d.degraded, true); assert.equal(d.cache_ttl, 5);   // policy still answers, retried soon
  assert.ok(!JSON.stringify(d).includes("leak"));
  tick(6000);
  e.score("https://x.com/"); assert.equal(calls, 3);
});

test("a new policy version clears cached decisions; the same version does not", () => {
  const { e, detect } = engineWith();
  e.decide("https://sus-site.com/"); e.decide("https://sus-site.com/");
  assert.equal(detect.calls.url, 1);
  assert.equal(e.setPolicy(norm(ADULT)).changed, false);
  e.decide("https://sus-site.com/"); assert.equal(detect.calls.url, 1);
  assert.equal(e.setPolicy(norm({ ...ADULT, allow_domains: ["sus-site.com"] })).changed, true);
  assert.equal(JSON.parse(e.decide("https://sus-site.com/").body).reason, "offline-parent-allow");
});

test("signals are part of the cache key: same URL with different page signals is scored separately", () => {
  const { e, detect } = engineWith();
  e.decide("https://plain.com/");
  e.decide("https://plain.com/", { has_password_field: true });
  e.decide("https://plain.com/", { has_password_field: true });
  assert.equal(detect.calls.page, 1);
  assert.equal(detect.calls.url, 2);
});

test("coalescing: identical in-flight lookups share one detector call (async detector)", async () => {
  let calls = 0;
  const detectVerdict = async () => { calls++; await sleep(30); return { score: 0.6, level: "medium", reasons: ["r"], brand: null, official: null, features: {} }; };
  const e = createEngine({ detectVerdict, detectVersion: 1, lib });
  e.setPolicy(norm(ADULT));
  const rs = await Promise.all(Array.from({ length: 25 }, () => e.decide("https://shared.com/")));
  assert.equal(calls, 1);
  assert.ok(rs.every((r) => JSON.parse(r.body).action === "WARN"));
  assert.equal(e.cacheStats().coalesced, 24);
  await e.decide("https://shared.com/"); assert.equal(calls, 1);          // now a cache hit
  await Promise.all([e.decide("https://one.com/"), e.decide("https://two.com/")]); assert.equal(calls, 3);   // different keys are not merged
});

test("coalescing over HTTP: concurrent identical requests hit the detector once", async () => {
  let calls = 0;
  const a = await startAgent({ policy: ADULT, agent: { detectVerdict: async () => { calls++; await sleep(40); return { score: 0 }; }, detectVersion: 1 } });
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, () => a.call("/v1/score", { body: { url: "https://same.example/" } })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(calls, 1);
  } finally { await a.stop(); }
});

test("a rejected async detector does not wedge the key: the next call retries", async () => {
  let n = 0;
  const detectVerdict = async () => { n++; if (n === 1) throw new Error("first fails"); return { score: 0 }; };
  const e = createEngine({ detectVerdict, detectVersion: 1, lib, opts: {}, negativeTtlMs: 1 });
  e.setPolicy(norm(ADULT));
  assert.equal((await e.score("https://flaky.com/")).status, 503);
  await sleep(5);
  assert.equal((await e.score("https://flaky.com/")).status, 200);
  assert.equal(e.cacheStats().detect_failures, 1);
});

test("Coalescer: synchronous work never registers an in-flight entry", () => {
  const c = new Coalescer();
  assert.equal(c.run("k", () => 5), 5);
  assert.equal(c.pending, 0);
});

test("score-batch: up to 100 URLs in one call, per-item errors, 101 rejected", async () => {
  const a = await startAgent();
  try {
    const urls = Array.from({ length: 100 }, (_, i) => `https://site${i}.com/`);
    urls[3] = "garbage";
    const r = await a.call("/v1/score-batch", { body: { urls } });
    assert.equal(r.status, 200);
    assert.equal(r.json.results.length, 100);
    assert.equal(r.json.results[3].error, "invalid_url");
    assert.equal(r.json.results[0].level, "none");
    assert.equal((await a.call("/v1/score-batch", { body: { urls: [...urls, "https://x.com/"] } })).status, 400);
    assert.equal((await a.call("/v1/score-batch", { body: { urls: [] } })).status, 400);
    assert.equal((await a.call("/v1/score-batch", { body: { urls: [5] } })).status, 400);
  } finally { await a.stop(); }
});

test("score endpoint returns the contract's Verdict plus cached, with only whitelisted, bounded fields", async () => {
  const hostile = { version: 1, scoreUrl: () => ({ score: 7, level: "bogus", reasons: Array.from({ length: 20 }, () => "r".repeat(500)), brand: "b", official: "o.com", features: { a: 1, b: "x" }, secret: "page text" }), scorePage: () => ({}), combine: (v) => v[0] };
  const a = await startAgent({ detect: hostile });
  try {
    const r = await a.call("/v1/score", { body: { url: "https://x.com/" } });
    assert.equal(r.json.score, 1);
    assert.equal(r.json.level, "high");
    assert.equal(r.json.reasons.length, 6); assert.equal(r.json.reasons[0].length, 200);
    assert.deepEqual(r.json.features, { a: 1 });
    assert.ok(!("secret" in r.json));
    assert.equal(r.json.cached, false);
  } finally { await a.stop(); }
});
