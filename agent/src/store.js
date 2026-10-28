// Persisted state: the policy snapshot and the decision cache. Versioned schema, atomic writes, and a reader that treats anything
// odd (missing, truncated, wrong schema, tampered shape) as "no data" instead of crashing the agent.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, writeFileAtomic } = require("./secrets");

const SCHEMA = 1;

function readJsonSafe(file, expectedSchema = SCHEMA) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { data: null, status: e.code === "ENOENT" ? "missing" : "unreadable" }; }
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { data: null, status: "corrupt" };
    if (obj.schema !== expectedSchema) return { data: null, status: "schema" };
    return { data: obj, status: "ok" };
  } catch (e) { return { data: null, status: "corrupt" }; }
}

function writeJsonAtomic(file, obj, opts = {}) {
  ensureDir(path.dirname(file), opts);
  writeFileAtomic(file, JSON.stringify({ schema: SCHEMA, ...obj }), { mode: 0o600, harden: false });
}

// ---- policy snapshot ----------------------------------------------------------------------------
// Stored: the normalised snapshot (arrays), its version, the API's ETag and when it was fetched.
function loadSnapshot(file) {
  const { data, status } = readJsonSafe(file);
  if (!data || !data.snapshot || typeof data.snapshot !== "object") return { snapshot: null, status: status === "ok" ? "corrupt" : status };
  return { snapshot: data.snapshot, etag: typeof data.etag === "string" ? data.etag : null, fetchedAt: Number(data.fetched_at) || 0, status: "ok" };
}

function saveSnapshot(file, { snapshot, etag, fetchedAt }, opts) {
  writeJsonAtomic(file, { snapshot, etag: etag || null, fetched_at: fetchedAt || Date.now() }, opts);
}

// ---- cache ----------------------------------------------------------------------------------------
// Stored: rows [hashedKey, status, head, expiresAtMs] plus the policy and detector versions they were computed under.
// Keys are HMACs, so the file holds no URLs; bodies hold verdicts and decisions only.
function loadCache(file, { policyVersion, detectVersion, now = Date.now() }) {
  const { data, status } = readJsonSafe(file);
  if (!data) return { rows: [], status };
  if (data.policy_version !== policyVersion || data.detect_version !== detectVersion) return { rows: [], status: "stale" };
  const rows = [];
  for (const kind of ["score", "decide"]) {
    const list = data[kind];
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      if (!Array.isArray(r) || r.length !== 4) continue;
      const [k, st, head, exp] = r;
      if (typeof k !== "string" || k.length > 64 || st !== 200 || typeof head !== "string" || head.length > 4096 || !(exp > now)) continue;
      try { JSON.parse(head + "true}"); } catch (e) { continue; }
      rows.push([kind, k, st, head, exp]);
    }
  }
  return { rows, status: "ok" };
}

function saveCache(file, { score, decide, policyVersion, detectVersion }, opts) {
  writeJsonAtomic(file, { policy_version: policyVersion, detect_version: detectVersion, saved_at: Date.now(), score, decide }, opts);
}

module.exports = { SCHEMA, readJsonSafe, writeJsonAtomic, loadSnapshot, saveSnapshot, loadCache, saveCache };
