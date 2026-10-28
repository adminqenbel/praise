// Policy snapshot handling: validate what /api/ext/policy-sync returned, normalise it, compile lookup indexes.
// compile().decide(domain) gives the same answers as PraiseLib.offlineDecision (tests compare them) but walks Sets of
// domain suffixes instead of rebuilding a Set per list per call. Indexes are built once per sync, never per request.
"use strict";

const crypto = require("node:crypto");

const MAX_LIST = 50000;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const TLD_RE = /^\.[a-z0-9-]{1,63}$/;

function cleanDomains(list) {
  const out = new Set();
  if (!Array.isArray(list)) return [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    let d = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (DOMAIN_RE.test(d)) out.add(d);
    if (out.size >= MAX_LIST) break;
  }
  return [...out].sort();
}

function cleanTlds(list) {
  const out = new Set();
  if (!Array.isArray(list)) return [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const t = "." + raw.trim().toLowerCase().replace(/^\.+/, "");
    if (TLD_RE.test(t)) out.add(t);
  }
  return [...out].sort();
}

// Returns a plain, sorted, bounded snapshot or null when the payload does not look like a policy at all.
function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!("unknown_action" in raw) && !Array.isArray(raw.block_domains) && !Array.isArray(raw.allow_domains)) return null;
  const v = raw.verified && typeof raw.verified === "object" ? raw.verified : {};
  const unknown = typeof raw.unknown_action === "string" ? raw.unknown_action.toUpperCase() : "BLOCK";
  const sb = raw.settings && raw.settings.safe_browsing;
  const risk = Math.trunc(Number(sb && sb.warn_above_risk));
  return {
    mode: raw.mode === "adult" ? "adult" : "family",       // anything but an explicit adult snapshot is treated as family (closed)
    unknown_action: unknown === "ALLOW" || unknown === "WARN" ? unknown : "BLOCK",
    exceptions: cleanDomains(raw.exceptions),
    block_domains: cleanDomains(raw.block_domains),
    allow_domains: cleanDomains(raw.allow_domains),
    blocked_tlds: cleanTlds(raw.blocked_tlds),
    verified: {
      allow: cleanDomains(v.allow), allow_exact: cleanDomains(v.allow_exact),
      warn: cleanDomains(v.warn), warn_exact: cleanDomains(v.warn_exact),
      block: cleanDomains(v.block), block_exact: cleanDomains(v.block_exact),
    },
    warn_above_risk: risk > 0 && risk <= 100 ? risk : 0,
    child: typeof raw.child === "string" ? raw.child.slice(0, 100) : "",
  };
}

// Same content => same version. The child's name is not part of it (it does not change any decision).
function versionOf(norm) {
  const { child, ...rest } = norm;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

// True when `domain` equals a member of `set` or is a subdomain of one.
function walk(set, domain) {
  if (set.size === 0) return false;
  let d = domain;
  for (;;) {
    if (set.has(d)) return true;
    const i = d.indexOf(".");
    if (i === -1) return false;
    d = d.slice(i + 1);
  }
}

function result(action, reason, source) { return Object.freeze({ action, reason, source }); }
const R = {
  exception: result("ALLOW", "offline-exception", "parent"),
  parentBlock: result("BLOCK", "offline-parent-block", "parent"),
  parentAllow: result("ALLOW", "offline-parent-allow", "parent"),
  verifiedBlock: result("BLOCK", "offline-verified-block", "verified"),
  verifiedAllow: result("ALLOW", "offline-verified-allow", "verified"),
  verifiedWarn: result("WARN", "offline-verified-warn", "verified"),
  tld: result("BLOCK", "offline-tld", "tld"),
  defBlock: result("BLOCK", "offline-unknown-default", "default"),
  defAllow: result("ALLOW", "offline-unknown-default", "default"),
  defWarn: result("WARN", "offline-unknown-default", "default"),
  noPolicy: result("BLOCK", "offline-no-policy", "none"),
};

function tldOf(domain) { const i = domain.lastIndexOf("."); return i === -1 ? "" : domain.slice(i); }

function compile(norm) {
  const s = (a) => new Set(a);
  const idx = {
    version: versionOf(norm),
    mode: norm.mode,
    warnAboveRisk: norm.warn_above_risk,
    exceptions: s(norm.exceptions), block: s(norm.block_domains), allow: s(norm.allow_domains), tlds: s(norm.blocked_tlds),
    vAllow: s(norm.verified.allow), vAllowX: s(norm.verified.allow_exact),
    vWarn: s(norm.verified.warn), vWarnX: s(norm.verified.warn_exact),
    vBlock: s(norm.verified.block), vBlockX: s(norm.verified.block_exact),
    unknown: norm.unknown_action === "ALLOW" ? R.defAllow : norm.unknown_action === "WARN" ? R.defWarn : R.defBlock,
    // Priority order and reasons mirror PraiseLib.offlineDecision exactly (parent rules, verified, TLD, unknown default).
    // Only the last step differs: in family mode "unclear" is always closed, whatever unknown_action says.
    decide(domain) {
      if (walk(this.exceptions, domain)) return R.exception;
      if (walk(this.block, domain)) return R.parentBlock;
      if (walk(this.allow, domain)) return R.parentAllow;
      if (walk(this.vBlock, domain) || this.vBlockX.has(domain)) return R.verifiedBlock;
      if (walk(this.vAllow, domain) || this.vAllowX.has(domain)) return R.verifiedAllow;
      if (walk(this.vWarn, domain) || this.vWarnX.has(domain)) return R.verifiedWarn;
      if (this.tlds.has(tldOf(domain))) return R.tld;
      return this.mode === "adult" ? this.unknown : R.defBlock;
    },
  };
  return idx;
}

const NO_POLICY = R.noPolicy;

module.exports = { normalizeSnapshot, versionOf, compile, walk, NO_POLICY, RESULTS: R };
