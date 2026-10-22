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

  // Returns the matching rule when `domain` equals it or is a subdomain of it.
  function domainMatches(domain, rules) {
    const set = new Set(rules || []);
    const parts = domain.split(".");
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(i).join(".");
      if (set.has(candidate)) return candidate;
    }
    return null;
  }

  function tldOf(domain) {
    const i = domain.lastIndexOf(".");
    return i === -1 ? "" : domain.slice(i);
  }

  // Used only when the backend is unreachable. Mirrors the top of the server priority
  // order (parent rules, then TLD policy) and otherwise applies the unknown-site default.
  function offlineDecision(domain, snap) {
    if (!snap) return { action: "BLOCK", reason: "offline-no-policy" };
    if (domainMatches(domain, snap.exceptions)) return { action: "ALLOW", reason: "offline-exception" };
    if (domainMatches(domain, snap.block_domains)) return { action: "BLOCK", reason: "offline-parent-block" };
    if (domainMatches(domain, snap.allow_domains)) return { action: "ALLOW", reason: "offline-parent-allow" };
    const v = snap.verified || {};
    if (domainMatches(domain, v.block) || (v.block_exact || []).includes(domain)) return { action: "BLOCK", reason: "offline-verified-block" };
    if (domainMatches(domain, v.allow) || (v.allow_exact || []).includes(domain)) return { action: "ALLOW", reason: "offline-verified-allow" };
    if (domainMatches(domain, v.warn) || (v.warn_exact || []).includes(domain)) return { action: "WARN", reason: "offline-verified-warn" };
    if ((snap.blocked_tlds || []).includes(tldOf(domain))) return { action: "BLOCK", reason: "offline-tld" };
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

  const api = { normalizeDomain, domainMatches, tldOf, offlineDecision, extractSignals, hostOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseLib = api;
})(typeof self !== "undefined" ? self : this);
