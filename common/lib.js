// Pure helpers shared by the service worker (importScripts) and Node tests (require).
// No chrome.* calls in here.
(function (root) {
  "use strict";

  // Reduce a URL to its host without 'www.'. Anything that is not an ordinary website (other schemes, IP addresses, single-word hosts like localhost) returns null and is never checked.
  function normalizeDomain(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (host.startsWith("www.")) host = host.slice(4);
    if (!host.includes(".")) return null;                    // localhost, intranet names
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null; // IP literals
    return host;
  }

  // Rule lists arrive as arrays but are looked up as sets. compileRules turns a list into a Set once: a Set passes
  // through untouched, and an array is remembered (by identity, rebuilt if its length changes) so repeated lookups
  // against the same list never rebuild it.
  const EMPTY_SET = new Set();
  const COMPILED = new WeakMap();
  function compileRules(list) {
    if (list instanceof Set) return list;
    if (!Array.isArray(list) || !list.length) return EMPTY_SET;
    const hit = COMPILED.get(list);
    if (hit && hit.len === list.length) return hit.set;
    const set = new Set(list);
    COMPILED.set(list, { len: list.length, set });
    return set;
  }

  // Returns the matching rule when `domain` equals it or is a subdomain of it. `rules` is an array or a Set from compileRules.
  function domainMatches(domain, rules) {
    const set = compileRules(rules);
    if (!set.size || typeof domain !== "string") return null;
    let candidate = domain;
    for (;;) {
      if (set.has(candidate)) return candidate;
      const dot = candidate.indexOf(".");
      if (dot === -1) return null;
      candidate = candidate.slice(dot + 1);
    }
  }

  function tldOf(domain) {
    const i = domain.lastIndexOf(".");
    return i === -1 ? "" : domain.slice(i);
  }

  // The sets offlineDecision consults, built on first use and kept per snapshot object. Each list is checked against the
  // snapshot as it is now, so replacing a list on the snapshot is picked up (get(name) never serves a stale Set).
  const SNAPSHOT_LISTS = {
    exceptions: (s) => s.exceptions, block: (s) => s.block_domains, allow: (s) => s.allow_domains,
    vBlock: (s) => (s.verified || {}).block, vAllow: (s) => (s.verified || {}).allow, vWarn: (s) => (s.verified || {}).warn,
    vBlockExact: (s) => (s.verified || {}).block_exact, vAllowExact: (s) => (s.verified || {}).allow_exact,
    vWarnExact: (s) => (s.verified || {}).warn_exact, tlds: (s) => s.blocked_tlds,
  };
  function compileSnapshot(snap) {
    const memo = {};
    return {
      get(name) {
        const src = SNAPSHOT_LISTS[name](snap);
        const m = memo[name];
        if (m && m.src === src && (!Array.isArray(src) || m.len === src.length)) return m.set;
        const set = compileRules(src);
        memo[name] = { src, len: Array.isArray(src) ? src.length : 0, set };
        return set;
      },
    };
  }
  const SNAPSHOTS = new WeakMap();
  function compiledFor(snap) {
    if (snap.compiled && typeof snap.compiled.get === "function") return snap.compiled;     // supplied by the caller
    if (typeof snap !== "object") return compileSnapshot({});
    let c = SNAPSHOTS.get(snap);
    if (!c) { c = compileSnapshot(snap); SNAPSHOTS.set(snap, c); }
    return c;
  }

  // Used only when the backend is unreachable. Mirrors the top of the server priority
  // order (parent rules, then TLD policy) and otherwise applies the unknown-site default.
  function offlineDecision(domain, snap) {
    if (!snap) return { action: "BLOCK", reason: "offline-no-policy" };
    const c = compiledFor(snap);
    if (domainMatches(domain, c.get("exceptions"))) return { action: "ALLOW", reason: "offline-exception" };
    if (domainMatches(domain, c.get("block"))) return { action: "BLOCK", reason: "offline-parent-block" };
    if (domainMatches(domain, c.get("allow"))) return { action: "ALLOW", reason: "offline-parent-allow" };
    if (domainMatches(domain, c.get("vBlock")) || c.get("vBlockExact").has(domain)) return { action: "BLOCK", reason: "offline-verified-block" };
    if (domainMatches(domain, c.get("vAllow")) || c.get("vAllowExact").has(domain)) return { action: "ALLOW", reason: "offline-verified-allow" };
    if (domainMatches(domain, c.get("vWarn")) || c.get("vWarnExact").has(domain)) return { action: "WARN", reason: "offline-verified-warn" };
    if (c.get("tlds").has(tldOf(domain))) return { action: "BLOCK", reason: "offline-tld" };
    const unknown = snap.unknown_action || "BLOCK";
    // Family version: anything unclear stays closed. Adult version: ALLOW or WARN pass through.
    return { action: unknown === "ALLOW" || unknown === "WARN" ? unknown : "BLOCK", reason: "offline-unknown-default" };
  }

  const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

  // Turn &amp; and similar into plain characters in text pulled from HTML.
  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] || m);
  }

  // Cheap signal extraction from raw HTML (service workers have no DOM).
  function extractSignals(html) {
    html = String(html || "").slice(0, 400000);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const metaTag = html.match(/<meta[^>]+name=["']description["'][^>]*>/i);
    const description = metaTag ? ((metaTag[0].match(/content=["']([^"']*)["']/i) || [])[1] || "") : "";
    const body = html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    const text = decodeEntities(body).replace(/\s+/g, " ").trim();
    return {
      title: decodeEntities(title).replace(/\s+/g, " ").trim().slice(0, 200),
      description: decodeEntities(description).slice(0, 400),
      text: text.slice(0, 1500),
      has_password_field: /<input[^>]+type=["']?password/i.test(html),
      form_count: Math.min((html.match(/<form[\s>]/gi) || []).length, 100),
    };
  }

  // Host (with port) of a URL, or null; used to avoid blocking the Praise server itself.
  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return null; }
  }

  const api = { normalizeDomain, domainMatches, compileRules, compileSnapshot, tldOf, offlineDecision, extractSignals, hostOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseLib = api;
})(typeof self !== "undefined" ? self : this);
