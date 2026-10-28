// Agent configuration: config.json in the per-user config dir, merged over safe defaults and clamped. It holds no secrets (tokens have their own files).
"use strict";

const fs = require("node:fs");
const { writeFileAtomic, ensureDir } = require("./secrets");
const path = require("node:path");

const DEFAULT_API = "https://api.praise.qenbel.site";
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

const DEFAULTS = {
  port: 47615,
  api: DEFAULT_API,
  allowed_origins: [],          // explicit chrome-extension://<id> origins; none by default
  log_level: "info",
  forward_events: false,
  sync: { interval_ms: 10 * 60000, jitter: 0.2, backoff_base_ms: 5000, backoff_max_ms: 15 * 60000, timeout_ms: 10000,
          revoked_retry_ms: 60 * 60000, unconfigured_poll_ms: 30000, manual_min_gap_ms: 2000 },
  events: { flush_at: 20, flush_interval_ms: 60000, queue_max: 500 },
  limits: { max_body_bytes: 64 * 1024, conn_rps: 500, conn_burst: 1000, global_rps: 2000, global_burst: 4000,
            authfail_rps: 5, authfail_burst: 20, max_connections: 64, headers_timeout_ms: 5000, request_timeout_ms: 10000,
            keepalive_timeout_ms: 30000, shutdown_grace_ms: 3000, max_batch: 100 },
  cache: { max_entries: 10000, max_bytes: 16 * 1024 * 1024, negative_ttl_s: 60, persist_entries: 2000, persist_interval_ms: 10 * 60000,
           ttl_s: { ALLOW: 3600, BLOCK: 3600, WARN: 600 } },
  detect: { warn_at: 0.5, block_at: 0.75 },
};

const num = (v, def, min, max) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

// An API origin must be https, or plain http only for a loopback host (local development backend). Returns the origin or null.
function normalizeApiOrigin(value) {
  let u;
  try { u = new URL(String(value)); } catch (e) { return null; }
  if (u.username || u.password) return null;
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.origin;
  return null;
}

function merge(defs, input, clampers) {
  const out = {};
  for (const k of Object.keys(defs)) {
    const d = defs[k];
    const v = input && typeof input === "object" ? input[k] : undefined;
    if (d && typeof d === "object" && !Array.isArray(d)) out[k] = merge(d, v, clampers && clampers[k]);
    else if (typeof d === "number") out[k] = num(v, d, ...((clampers && clampers[k]) || [0, Number.MAX_SAFE_INTEGER]));
    else out[k] = d;
  }
  return out;
}

const RANGES = {
  sync: { interval_ms: [1, 24 * 3600000], jitter: [0, 0.9], backoff_base_ms: [1, 3600000], backoff_max_ms: [1, 24 * 3600000], timeout_ms: [100, 120000],
          revoked_retry_ms: [1, 24 * 3600000], unconfigured_poll_ms: [1, 3600000], manual_min_gap_ms: [0, 60000] },
  limits: { max_body_bytes: [256, 1024 * 1024], max_batch: [1, 100], max_connections: [1, 1024] },
  detect: { warn_at: [0, 1.5], block_at: [0, 1.5] },
};

function sanitize(input) {
  const cfg = merge(DEFAULTS, input, RANGES);
  const i = input && typeof input === "object" ? input : {};
  cfg.port = Number.isInteger(i.port) && i.port >= 0 && i.port <= 65535 ? i.port : DEFAULTS.port;
  cfg.api = normalizeApiOrigin(i.api) || DEFAULT_API;
  cfg.allowed_origins = Array.isArray(i.allowed_origins) ? [...new Set(i.allowed_origins.filter((o) => typeof o === "string" && EXTENSION_ORIGIN_RE.test(o)))] : [];
  cfg.log_level = ["error", "warn", "info", "debug"].includes(i.log_level) ? i.log_level : "info";
  cfg.forward_events = i.forward_events === true;
  const ttl = i.cache && i.cache.ttl_s;
  cfg.cache.ttl_s = {};
  for (const a of ["ALLOW", "BLOCK", "WARN"]) cfg.cache.ttl_s[a] = num(ttl && ttl[a], DEFAULTS.cache.ttl_s[a], 0, 86400);
  return cfg;
}

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

function deepMerge(a, b) {
  if (!isPlain(a) || !isPlain(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

// `overrides` (tests, command-line flags) win over the file. Anything invalid in either is replaced by the default.
function loadConfig(file, overrides) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* missing or invalid: defaults */ }
  return sanitize(overrides ? deepMerge(isPlain(raw) ? raw : {}, overrides) : raw);
}

// Persist only the user-set keys, not the whole defaults tree.
function saveConfigPatch(file, patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (e) { /* fresh */ }
  const next = { ...cur, ...patch };
  ensureDir(path.dirname(file));
  writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

module.exports = { DEFAULTS, DEFAULT_API, EXTENSION_ORIGIN_RE, sanitize, loadConfig, saveConfigPatch, normalizeApiOrigin };
