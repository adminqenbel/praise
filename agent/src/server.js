// Praise local agent entry point. `node src/server.js` runs it; `createAgent()` builds one with injectable parts for tests and the benchmark.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const pkg = require("../package.json");
const { resolveDirs, filesIn } = require("./paths");
const { loadConfig } = require("./config");
const { createLogger } = require("./log");
const secrets = require("./secrets");
const store = require("./store");
const { createEngine } = require("./engine");
const { createSync } = require("./sync");
const { createEventForwarder } = require("./events");
const { createHttpServer } = require("./http");

// One implementation of detection and offline policy semantics: the repo's shared browser code (docs/DETECTION-CONTRACT.md).
function loadShared() {
  return { detect: require("../../common/detect.js"), lib: require("../../common/lib.js") };
}

function createAgent(opts = {}) {
  const dirs = opts.dirs || resolveDirs();
  const files = filesIn(dirs);
  const harden = opts.harden !== false;
  const config = loadConfig(files.config, opts.config);
  const log = opts.log || createLogger({ level: config.log_level });
  secrets.ensureDir(dirs.configDir, { harden });
  secrets.ensureDir(dirs.stateDir, { harden });

  const token = opts.token || secrets.loadOrCreateAgentToken(files.agentToken, { harden });
  const base = opts.detect && opts.lib ? {} : loadShared();
  const shared = { detect: opts.detect || base.detect, lib: opts.lib || base.lib };
  const cacheKey = crypto.createHash("sha256").update("praise-agent-cache-v1:" + token).digest();
  const hashKey = (s) => crypto.createHmac("sha256", cacheKey).update(s).digest("base64url").slice(0, 22);

  const engine = createEngine({
    detect: shared.detect, detectVerdict: opts.detectVerdict, detectVersion: opts.detectVersion, lib: shared.lib, log, hashKey, now: opts.now || Date.now,
    warnAt: config.detect.warn_at, blockAt: config.detect.block_at, negativeTtlMs: config.cache.negative_ttl_s * 1000,
    ttlSeconds: config.cache.ttl_s, maxEntries: config.cache.max_entries, maxBytes: config.cache.max_bytes,
  });

  // The device token is read from its file on every use, so `configure` takes effect without a restart. The live config is
  // re-read the same way for the API origin.
  const getConfig = () => (opts.liveConfig === false ? config : liveConfig());
  let liveCache = { at: 0, cfg: config };
  function liveConfig() {
    const t = Date.now();
    if (t - liveCache.at > 1000) liveCache = { at: t, cfg: loadConfig(files.config, opts.config) };
    return liveCache.cfg;
  }
  const getDeviceToken = opts.getDeviceToken || (() => secrets.readDeviceToken(files.deviceToken));

  const sync = createSync({ engine, getConfig, getDeviceToken, files, fetchFn: opts.fetch, log, random: opts.random, now: opts.now || Date.now,
                            setTimer: opts.setTimer, clearTimer: opts.clearTimer });
  const events = createEventForwarder({ getConfig, getDeviceToken, fetchFn: opts.fetch, log, random: opts.random });

  const info = () => {
    const p = engine.policy;
    return {
      ok: true, version: pkg.version, detect_version: engine.detectVersion,
      policy: { loaded: !!p, version: p ? p.version : null, mode: p ? p.mode : null, last_sync: sync.state.fetchedAt || null,
                revoked: sync.state.revoked, offline: sync.state.offline, paired: !!getDeviceToken() },
      cache: engine.cacheStats(),
    };
  };

  const httpd = createHttpServer({ engine, sync, events, token, config, log, info, now: opts.now });
  let persistTimer = null, started = false, stopped = false, port = null;
  const agent = { engine, sync, events, config, files, dirs, token, log, cacheLoaded: Promise.resolve(), get port() { return port; }, httpd };

  function persistCache() {
    const p = engine.policy;
    if (!p) return false;
    const rows = engine.exportCache(config.cache.persist_entries);
    try {
      store.saveCache(files.cache, { score: rows.score, decide: rows.decide, policyVersion: p.version, detectVersion: engine.detectVersion }, { harden: false });
      return true;
    } catch (e) { log.warn("cache save failed", { code: e.code || e.name }); return false; }
  }

  function loadCacheNow() {
    const p = engine.policy;
    if (!p) return;
    const r = store.loadCache(files.cache, { policyVersion: p.version, detectVersion: engine.detectVersion });
    if (r.rows.length) engine.importCache(r.rows);
    if (r.status === "corrupt") log.warn("cache file was corrupt and was ignored");
  }

  agent.persistCache = persistCache;

  agent.start = async () => {
    if (started) return port;
    started = true;
    const r = sync.restore();
    if (r.status === "corrupt") log.warn("policy snapshot was corrupt and was ignored");
    port = await httpd.listen(opts.port !== undefined ? opts.port : config.port);
    try { store.writeJsonAtomic(files.runtime, { pid: process.pid, port, started_at: Date.now() }, { harden: false }); } catch (e) { /* status just shows "unknown" */ }
    agent.cacheLoaded = new Promise((resolve) => setImmediate(() => { try { loadCacheNow(); } catch (e) { log.warn("cache load failed"); } resolve(); }));
    if (opts.sync !== false) sync.start();
    events.start();
    persistTimer = setInterval(persistCache, config.cache.persist_interval_ms);
    if (persistTimer.unref) persistTimer.unref();
    log.info("agent listening", { port, policy: engine.policy ? "loaded" : "missing" });
    return port;
  };

  // Graceful: stop accepting, finish in-flight work, flush events, write cache, remove the runtime marker.
  agent.stop = async () => {
    if (stopped || !started) return;
    stopped = true;
    clearInterval(persistTimer);
    await httpd.close();
    await sync.stop();
    try { await events.stop(); } catch (e) { /* best effort */ }
    persistCache();
    try { fs.unlinkSync(files.runtime); } catch (e) { /* already gone */ }
  };

  return agent;
}

async function main() {
  const agent = createAgent();
  try { await agent.start(); } catch (e) {
    process.stderr.write(e && e.code === "EADDRINUSE"
      ? `port ${agent.config.port} is already in use (another agent running?)\n`
      : `could not start: ${e && e.code ? e.code : e && e.name}\n`);
    process.exit(1);
  }
  process.stderr.write(`Praise agent listening on http://127.0.0.1:${agent.port} (token: run "node src/cli.js token")\n`);
  let shuttingDown = false;
  const quit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    agent.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  if (process.platform === "win32") process.on("SIGBREAK", quit);
}

if (require.main === module) main();

module.exports = { createAgent, main };
