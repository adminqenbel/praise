// The decision core: caches in front, detector and compiled policy behind. No HTTP in here, so tests and the benchmark can drive it directly.
// Detection is injected (`detect` module-shaped, or `detectVerdict(url, signals)` which may return a Promise), so nothing here depends on
// how good the real detector is. Detection can only ADD caution on an otherwise-unknown site; parent rules, verified sites and TLD
// blocks are final (docs/DETECTION-CONTRACT.md).
"use strict";

const crypto = require("node:crypto");
const { TtlLruCache, Coalescer } = require("./cache");
const policyLib = require("./policy");
const { silent } = require("./log");

const LEVELS = ["none", "low", "medium", "high"];
const NONE_VERDICT = Object.freeze({ score: 0, level: "none", reasons: [], brand: null, official: null, features: {} });

// Mirrors CACHE_TTL_SECONDS in backend/routes/child.py.
const DEFAULT_TTL_S = { ALLOW: 3600, BLOCK: 3600, WARN: 600 };

function levelOf(score) { return score >= 0.75 ? "high" : score >= 0.5 ? "medium" : score >= 0.25 ? "low" : "none"; }
const isThenable = (v) => v && typeof v.then === "function";
const str = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);

// Whatever the detector returns, the agent only ever emits this exact, bounded shape.
function cleanVerdict(v) {
  if (!v || typeof v !== "object") v = NONE_VERDICT;
  const s = Number(v.score);
  const score = Number.isFinite(s) ? Math.min(1, Math.max(0, Math.round(s * 1000) / 1000)) : 0;
  const features = {};
  if (v.features && typeof v.features === "object") {
    let n = 0;
    for (const k of Object.keys(v.features)) {
      if (n >= 64) break;
      if (typeof v.features[k] === "number" && Number.isFinite(v.features[k])) { features[k.slice(0, 64)] = v.features[k]; n++; }
    }
  }
  return {
    score,
    level: LEVELS.includes(v.level) ? v.level : levelOf(score),
    reasons: Array.isArray(v.reasons) ? v.reasons.filter((r) => typeof r === "string").slice(0, 6).map((r) => r.slice(0, 200)) : [],
    brand: str(v.brand, 100),
    official: str(v.official, 253),
    features,
  };
}

function parseable(url) { try { new URL(url); return true; } catch (e) { return false; } }

// Heads end just before the `cached` value; the caller appends `true}` or `false}`.
function head(obj) { return JSON.stringify(obj).slice(0, -1) + ',"cached":'; }

function createEngine(opts = {}) {
  const {
    detect, lib, now = Date.now, log = silent, hashKey = null,
    warnAt = 0.5, blockAt = 0.75, negativeTtlMs = 60000,
    ttlSeconds = DEFAULT_TTL_S, maxEntries = 10000, maxBytes = 16 * 1024 * 1024,
  } = opts;
  if (!lib) throw new Error("engine needs lib (PraiseLib)");
  const detectVerdict = opts.detectVerdict || (detect && ((url, signals) => {
    const u = detect.scoreUrl(url);
    return signals ? detect.combine([u, detect.scorePage(signals)]) : u;
  }));
  if (!detectVerdict) throw new Error("engine needs detect or detectVerdict");

  const cacheOpts = { maxEntries, maxBytes, now, hashKey };
  const scoreCache = new TtlLruCache(cacheOpts);
  const decideCache = new TtlLruCache(cacheOpts);
  const scoreFlight = new Coalescer();
  const decideFlight = new Coalescer();
  const state = { policy: null };
  const stats = { detectCalls: 0, detectFailures: 0 };

  const cacheKey = (url, signals) => (signals ? url + "\n" + crypto.createHash("sha1").update(JSON.stringify(signals)).digest("base64") : url);
  const hit = (e) => ({ status: e.status, body: e.head + "true}" });
  const fresh = (e) => ({ status: e.status, body: e.head + "false}" });

  function errorEntry(cache, key, status, code) {
    const e = { status, head: `{"error":"${code}","cached":`, neg: true };
    cache.set(key, e, negativeTtlMs);
    return e;
  }

  function runDetect(url, signals) {
    stats.detectCalls++;
    if (log.debugOn) log.debug("detect miss", { domain: lib.normalizeDomain(url) || "-" });
    return detectVerdict(url, signals);
  }

  // ---- score ----
  function computeScore(key, url, signals) {
    if (!parseable(url)) return fresh(errorEntry(scoreCache, key, 400, "invalid_url"));
    const ok = (v) => fresh(scoreCache.set(key, { status: 200, head: head(cleanVerdict(v)) }, ttlSeconds.ALLOW * 1000));
    const bad = () => { stats.detectFailures++; return fresh(errorEntry(scoreCache, key, 503, "detect_failed")); };
    let v;
    try { v = runDetect(url, signals); } catch (e) { return bad(); }
    return isThenable(v) ? v.then(ok, bad) : ok(v);
  }

  function score(url, signals) {
    const key = cacheKey(url, signals);
    const e = scoreCache.get(key);
    if (e) return hit(e);
    return scoreFlight.run(key, () => computeScore(key, url, signals));
  }

  // Up to the caller to cap the list; items are independent, errors are per item.
  function scoreBatch(urls) {
    const out = urls.map((u) => score(u));
    const join = (rs) => '{"results":[' + rs.map((r) => r.body).join(",") + "]}";
    return out.some(isThenable) ? Promise.all(out).then((rs) => ({ status: 200, body: join(rs) })) : { status: 200, body: join(out) };
  }

  // ---- decide ----
  function ttlFor(action) { return ttlSeconds[action] || ttlSeconds.BLOCK; }

  function finish(key, policy, base, verdict, degraded) {
    let action = base.action, reason = base.reason, source = base.source;
    const v = cleanVerdict(verdict);
    if (source === "default" && action !== "BLOCK") {      // detection may add caution here and nowhere else
      const warn = policy.warnAboveRisk ? Math.min(warnAt, policy.warnAboveRisk / 100) : warnAt;
      if (v.score >= blockAt) { action = "BLOCK"; reason = "detect-block"; source = "detection"; }
      else if (action === "ALLOW" && v.score >= warn) { action = "WARN"; reason = "detect-warn"; source = "detection"; }
    }
    const ttl = degraded ? Math.round(negativeTtlMs / 1000) : ttlFor(action);
    const body = { action, reason, source, can_continue: action === "WARN", cache_ttl: ttl, ...v };
    if (degraded) body.degraded = true;
    return fresh(decideCache.set(key, { status: 200, head: head(body), neg: !!degraded }, ttl * 1000));
  }

  function computeDecide(key, url, signals) {
    if (!parseable(url)) return fresh(errorEntry(decideCache, key, 400, "invalid_url"));
    const domain = lib.normalizeDomain(url);
    if (domain === null) {      // other schemes, IP literals, single-label hosts: never checked (same as the extension)
      const ttl = Math.round(negativeTtlMs / 1000);
      const b = { action: "ALLOW", reason: "not-a-website", source: "none", can_continue: false, cache_ttl: ttl, ...cleanVerdict(NONE_VERDICT) };
      return fresh(decideCache.set(key, { status: 200, head: head(b), neg: true }, negativeTtlMs));
    }
    const policy = state.policy;
    if (!policy) {               // fail closed, and do not cache: the first sync must take effect immediately
      const b = { action: "BLOCK", reason: policyLib.NO_POLICY.reason, source: "none", can_continue: false, cache_ttl: 0, ...cleanVerdict(NONE_VERDICT) };
      return { status: 200, body: head(b) + "false}" };
    }
    const base = policy.decide(domain);
    if (base.source !== "default") return finish(key, policy, base, NONE_VERDICT, false);
    if (base.action === "BLOCK" && policy.mode !== "adult") {
      // Family mode: unclear is closed, so detection cannot add anything. Skip the detector entirely.
      return finish(key, policy, base, NONE_VERDICT, false);
    }
    const done = (v) => finish(key, policy, base, v, false);
    const failed = () => { stats.detectFailures++; return finish(key, policy, base, NONE_VERDICT, true); };
    let v;
    try { v = runDetect(url, signals); } catch (e) { return failed(); }
    return isThenable(v) ? v.then(done, failed) : done(v);
  }

  function decide(url, signals) {
    const key = cacheKey(url, signals);
    const e = decideCache.get(key);
    if (e) return hit(e);
    return decideFlight.run(key, () => computeDecide(key, url, signals));
  }

  // ---- policy and persistence ----
  function setPolicy(norm) {
    if (!norm) { const had = !!state.policy; state.policy = null; if (had) clearCaches(); return { changed: had, version: null }; }
    const idx = policyLib.compile(norm);
    const changed = !state.policy || state.policy.version !== idx.version;
    state.policy = idx;
    if (changed) clearCaches();            // new rules => forget old decisions (the extension does the same)
    return { changed, version: idx.version };
  }

  function clearCaches() { scoreCache.clear(); decideCache.clear(); }

  function exportCache(limit) {
    return { score: scoreCache.dump(limit), decide: decideCache.dump(limit), policyVersion: state.policy ? state.policy.version : null };
  }
  function importCache(rows) {
    const s = [], d = [];
    for (const r of rows) (r[0] === "score" ? s : d).push(r.slice(1));
    scoreCache.loadWarm(s); decideCache.loadWarm(d);
  }

  return {
    score, scoreBatch, decide, setPolicy, clearCaches, exportCache, importCache,
    get policy() { return state.policy; },
    get detectVersion() { return detect ? detect.version : (opts.detectVersion || 0); },
    cacheStats() {
      return {
        entries: scoreCache.size + decideCache.size, bytes: scoreCache.bytes + decideCache.bytes,
        hits: scoreCache.hits + decideCache.hits, misses: scoreCache.misses + decideCache.misses,
        evictions: scoreCache.evictions + decideCache.evictions, coalesced: scoreFlight.shared + decideFlight.shared,
        detect_calls: stats.detectCalls, detect_failures: stats.detectFailures,
      };
    },
    _caches: { scoreCache, decideCache },
  };
}

module.exports = { createEngine, cleanVerdict, NONE_VERDICT, DEFAULT_TTL_S };
