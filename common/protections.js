// Pure protection rules (no chrome.* calls): downloads, browser installers, escape/tamper
// URLs, cookie classification. Shared by the service worker and Node tests.
(function (root) {
  "use strict";

  // ---- settings ---------------------------------------------------------------------
  // Stored in policy.settings on the server. Anything missing falls back to the strict default.
  const DEFAULTS = {
    downloads: { enabled: true, archives: "ALLOW" },          // archives: ALLOW | BLOCK
    protections: { browser_installers: true, escape: true, tamper: true, storage_monitor: true },
    cookies: { monitor: true, third_party: "ALLOW", trackers: "BLOCK", unknown: "ASK", clear_on_close: false },
    // adult version (Praise Shield); the family extension ignores these groups
    safe_browsing: { warn_above_risk: 70, scam_checks: true },
    privacy: { block_trackers: true, strip_tracking_params: true, block_fingerprinting: true, privacy_report: true },
    sensitive_data: { warn: true, cards: true, ids: true, otp: true, passwords: true },
    passwords: { breach_check: true, reuse_check: false },
    companion: { chat: true },                                // a parent can switch the child's chat with Dori off
  };

  // Fill in every missing setting with its default, so code can read settings without checking they exist.
  function withDefaults(settings) {
    const s = settings && typeof settings === "object" ? settings : {};
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      out[k] = Object.assign({}, DEFAULTS[k], s[k] && typeof s[k] === "object" ? s[k] : {});
    }
    return out;
  }

  // ---- downloads --------------------------------------------------------------------
  const EXECUTABLE_EXT = new Set(["exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "com",
    "scr", "pif", "cpl", "dll", "sys", "jar", "apk", "xapk", "aab", "dmg", "pkg", "app", "deb",
    "rpm", "appimage", "run", "bin", "lnk", "reg", "iso", "vhd", "vhdx"]);
  // File types treated as dangerous downloads: scripts, macro documents and archives (programs are listed above), plus files that look like another browser's installer.
  const SCRIPT_EXT = new Set(["bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "hta", "sh", "bash", "command", "py", "pyw"]);
  const MACRO_EXT = new Set(["docm", "xlsm", "pptm", "dotm", "xlam"]);
  const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "cab"]);
  const BAD_MIME = new Set(["application/x-msdownload", "application/x-msdos-program",
    "application/vnd.microsoft.portable-executable", "application/x-dosexec",
    "application/vnd.android.package-archive", "application/x-sh", "application/x-bat",
    "application/x-msi", "application/java-archive", "application/x-apple-diskimage",
    "application/x-executable", "application/x-ms-installer"]);

  const INSTALLER_NAME = /(chrome|chromium|firefox|msedge|microsoftedge|edge|brave|opera|vivaldi|torbrowser|tor-browser|duckduckgo)[^\\/]*(setup|install|installer|stub|standalone|offline)/i;
  const INSTALLER_URL = [
    /^https?:\/\/dl\.google\.com\/(release2\/)?chrome/i,
    /^https?:\/\/download\.mozilla\.org\//i,
    /^https?:\/\/download-installer\.cdn\.mozilla\.net\//i,
    /^https?:\/\/[^/]*\.dl\.delivery\.mp\.microsoft\.com\/.*edge/i,
    /^https?:\/\/laptop-updates\.brave\.com\//i,
    /^https?:\/\/download\.opera\.com\//i,
    /^https?:\/\/downloads\.vivaldi\.com\//i,
    /^https?:\/\/(www\.)?torproject\.org\/dist\//i,
  ];

  // Lower-case extension of a file name, ignoring folders and trailing dots or spaces (which can hide '.exe').
  function fileExtension(name) {
    const base = String(name || "").split(/[\\/]/).pop().toLowerCase().replace(/[\s.]+$/, "");
    const i = base.lastIndexOf(".");
    return i > 0 ? base.slice(i + 1) : "";
  }

  // item: { filename, url, finalUrl, mime, danger }
  function evaluateDownload(item, settings) {
    const cfg = withDefaults(settings);
    if (!cfg.downloads.enabled) return { action: "ALLOW", kind: "disabled" };

    const name = item.filename || "";
    const url = item.finalUrl || item.url || "";
    const ext = fileExtension(name) || fileExtension(url.split(/[?#]/)[0]);
    const mime = String(item.mime || "").toLowerCase();

    const installerByName = INSTALLER_NAME.test(name.split(/[\\/]/).pop() || "") &&
      (EXECUTABLE_EXT.has(ext) || ARCHIVE_EXT.has(ext) || ext === "");
    if (installerByName || INSTALLER_URL.some((re) => re.test(url))) {
      return { action: "BLOCK", kind: "browser_installer", ext };
    }
    if (EXECUTABLE_EXT.has(ext)) return { action: "BLOCK", kind: "executable", ext };
    if (SCRIPT_EXT.has(ext)) return { action: "BLOCK", kind: "script", ext };
    if (MACRO_EXT.has(ext)) return { action: "BLOCK", kind: "suspicious", ext };
    if (BAD_MIME.has(mime)) return { action: "BLOCK", kind: "mime", ext };
    // Chrome's own verdict: anything other than "safe"/"accepted"/"" is a warning we honour.
    if (item.danger && !["safe", "accepted"].includes(item.danger)) {
      return { action: "BLOCK", kind: "browser_flagged", ext };
    }
    if (ARCHIVE_EXT.has(ext)) {
      return { action: cfg.downloads.archives === "BLOCK" ? "BLOCK" : "ALLOW", kind: "archive", ext };
    }
    return { action: "ALLOW", kind: "ok", ext };
  }

  // ---- navigation protections ------------------------------------------------------
  const INSTALLER_PAGES = [
    /^https?:\/\/(www\.)?google\.[a-z.]+\/chrome(\/|$|\?)/i,
    /^https?:\/\/(www\.)?mozilla\.org\/[a-z-]*\/?firefox\/(new|download|all|browsers)/i,
    /^https?:\/\/(www\.)?firefox\.com\/?/i,
    /^https?:\/\/(www\.)?microsoft\.com\/[a-z-]*\/edge\/(download|business\/download)/i,
    /^https?:\/\/brave\.com\/(download|[a-z-]+\/download)/i,
    /^https?:\/\/(www\.)?opera\.com\/([a-z-]+\/)?(download|computer)/i,
    /^https?:\/\/vivaldi\.com\/([a-z-]+\/)?download/i,
    /^https?:\/\/(www\.)?torproject\.org\/(download|[a-z-]+\/download)/i,
    /^https?:\/\/duckduckgo\.com\/app/i,
    /^https?:\/\/(www\.)?chromium\.org\/getting-involved\/download-chromium/i,
  ].concat(INSTALLER_URL);

  // Is this page or file the download of another web browser? (A way around the protection.)
  function isBrowserInstallerUrl(url) {
    return INSTALLER_PAGES.some((re) => re.test(String(url || "")));
  }

  // Links that hand the current page off to a different browser.
  const ESCAPE_SCHEMES = new Set(["microsoft-edge", "microsoft-edge-holographic", "googlechrome",
    "googlechromes", "firefox", "firefox-focus", "opera-http", "opera-https", "brave", "vivaldi",
    "intent", "x-safari-http", "x-safari-https"]);

  function isEscapeUrl(url) {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || ""));
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    return ESCAPE_SCHEMES.has(scheme) ? { scheme } : null;
  }

  // Browser pages a child could use to remove the extension or switch protections off.
  const TAMPER_PAGES = /^(chrome|edge|brave|opera|vivaldi):\/\/(extensions|flags|policy|management)(\/|\?|#|$)/i;

  function isTamperUrl(url) {
    return TAMPER_PAGES.test(String(url || ""));
  }

  // A web address that names a raw IP instead of a site (http://203.0.113.9/, http://[2001:db8::1]/). There is no
  // name to judge, so a child's browser would otherwise let it through unchecked. The URL parser already turns
  // tricks like http://0x7f.1/ or http://3405803785/ into dotted form. This computer (127.x, ::1) is left alone.
  function isIpUrl(url) {
    let u;
    try { u = new URL(String(url || "")); } catch (e) { return false; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !host.startsWith("127.");
    return host.includes(":") && host !== "::1";
  }

  // ---- cookies ---------------------------------------------------------------------------
  const TWO_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
    "edu.au", "co.in", "ac.in", "gov.in", "net.in", "org.in", "co.jp", "com.br", "co.nz", "co.za",
    "com.cn", "com.mx", "com.sg", "com.hk", "com.tr"]);

  // Approximate registrable domain (eTLD+1) without shipping the full public-suffix list.
  function registrableDomain(host) {
    const parts = String(host || "").toLowerCase().replace(/^\./, "").split(".");
    if (parts.length <= 2) return parts.join(".");
    const last2 = parts.slice(-2).join(".");
    return TWO_LEVEL.has(last2) ? parts.slice(-3).join(".") : last2;
  }

  // Domains known for advertising and analytics. 'Dual use' ones (like facebook.com) count as trackers only when they appear as third-party.
  const TRACKER_DOMAINS = new Set(["doubleclick.net", "google-analytics.com", "googlesyndication.com",
    "googleadservices.com", "googletagmanager.com", "facebook.net", "facebook.com", "adservice.google.com",
    "scorecardresearch.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "hotjar.com",
    "quantserve.com", "adnxs.com", "amazon-adsystem.com", "bing.com", "clarity.ms", "mixpanel.com",
    "segment.io", "segment.com", "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com",
    "adsrvr.org", "demdex.net", "everesttech.net", "mathtag.com", "bluekai.com", "krxd.net",
    "tiktok.com", "analytics.tiktok.com", "ads-twitter.com", "linkedin.com", "snapchat.com",
    "yahoo.com", "advertising.com", "adform.net", "smartadserver.com", "2mdn.net"]);
  // Domains that are trackers only when the cookie is third-party (they also run real sites).
  const DUAL_USE = new Set(["facebook.com", "bing.com", "tiktok.com", "linkedin.com", "yahoo.com",
    "snapchat.com"]);

  // Cookie names that usually reveal a purpose (analytics, advertising, sign-in, preferences) with how sure we are. Purposes are best guesses and are shown as such.
  const NAME_PATTERNS = [
    { re: /^(_ga|_gid|_gat|__utm[a-z]*|_gcl_[a-z]+|_hjid|_hjsession|_clck|_clsk|amplitude_id|mp_[a-z0-9]+_mixpanel|ajs_[a-z_]+)/i,
      purpose: "Analytics", confidence: 0.8 },
    { re: /^(_fbp|_fbc|fr|ide|test_cookie|nid|anid|_ttp|_tt_enable_cookie|muc_ads|_uetsid|_uetvid|__gads|__gpi|uuid2|tuuid|criteo[a-z_]*|cto_[a-z_]+|_pin_unauth|datr)$/i,
      purpose: "Advertising / tracking", confidence: 0.8 },
    { re: /^(phpsessid|jsessionid|asp\.net_sessionid|sessionid|session_id|sid|connect\.sid|csrf[a-z_-]*|xsrf-token|__host-[a-z_-]+|__secure-[a-z_-]+)$/i,
      purpose: "Sign-in or session (essential)", confidence: 0.75 },
    { re: /(consent|cookieconsent|cookie_notice|gdpr|optanon|cookiebot|euconsent)/i,
      purpose: "Cookie preferences", confidence: 0.75 },
    { re: /^(lang|locale|language|theme|timezone|currency|country)$/i,
      purpose: "Site preference", confidence: 0.65 },
  ];

  // cookie: { name, domain, session, expirationDate (unix seconds) }
  // ctx: { topDomains: Set of registrable domains currently open in tabs, now: ms }
  function classifyCookie(cookie, ctx) {
    const host = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    const reg = registrableDomain(host);
    const tops = (ctx && ctx.topDomains) || new Set();
    const now = (ctx && ctx.now) || Date.now();

    const thirdParty = tops.size > 0 && !tops.has(reg);   // unknown context => treat as first-party
    const persistent = !cookie.session && cookie.expirationDate != null;
    const lifetimeDays = persistent
      ? Math.max(0, Math.round((cookie.expirationDate * 1000 - now) / 86400000)) : 0;

    const trackerHost = TRACKER_DOMAINS.has(reg) && (!DUAL_USE.has(reg) || thirdParty);
    let purpose = "Unknown", confidence = 0.4, tracker = false;

    const byName = NAME_PATTERNS.find((p) => p.re.test(cookie.name || ""));
    if (trackerHost) {
      purpose = "Advertising / tracking"; confidence = 0.9; tracker = true;
    } else if (byName) {
      purpose = byName.purpose; confidence = byName.confidence;
      tracker = /Advertising|Analytics/.test(byName.purpose);
    } else if (thirdParty && persistent && lifetimeDays > 30) {
      purpose = "Possibly tracking"; confidence = 0.5; tracker = false;
    }
    return { domain: reg, name: cookie.name, thirdParty, persistent, lifetimeDays,
             purpose, confidence, tracker, unknown: purpose === "Unknown" };
  }

  // Decide what to do with a classified cookie: REMOVE (block), or KEEP (allow/ask-flag).
  function cookieAction(info, settings) {
    const c = withDefaults(settings).cookies;
    if (info.tracker && c.trackers === "BLOCK") return { remove: true, rule: "tracker" };
    if (info.thirdParty && c.third_party === "BLOCK") return { remove: true, rule: "third_party" };
    if (info.unknown && c.unknown === "BLOCK") return { remove: true, rule: "unknown" };
    if (info.unknown && c.unknown === "ASK") return { remove: false, rule: "ask" };
    return { remove: false, rule: "allow" };
  }

  // ---- network-level rules (declarativeNetRequest), generated into extension/rules/ ----------------
  // Cross-site identity and fingerprinting vendors. Honest label: these are the services whose
  // job is recognising you across sites, which is more than ordinary ad or analytics tracking.
  const FINGERPRINT_DOMAINS = ["fpjs.io", "fpcdn.io", "fingerprint.com", "iovation.com", "online-metrix.net",
    "bluecava.com", "tapad.com", "liveramp.com", "rlcdn.com", "id5-sync.com", "adsymptotic.com",
    "agkn.com", "bkrtx.com", "eyeota.net", "exelator.com", "lotame.com", "crwdcntrl.net"];

  // Tracking endpoints on domains that also run real sites, so only the tracking hosts are listed.
  const SPECIFIC_TRACKER_HOSTS = ["connect.facebook.net", "pixel.facebook.com", "analytics.tiktok.com",
    "bat.bing.com", "px.ads.linkedin.com", "snap.licdn.com", "sc-static.net", "analytics.yahoo.com",
    "udc.yahoo.com", "geo.yahoo.com", "ads.yahoo.com"];

  // Link-tracking parameters. removeParams needs exact names (no wildcards), so utm_* is spelled out.
  const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "utm_name", "utm_brand", "fbclid", "gclid", "gbraid", "wbraid", "dclid", "msclkid", "yclid", "twclid",
    "ttclid", "li_fat_id", "igshid", "mc_eid", "mc_cid", "_hsenc", "_hsmi", "vero_id", "oly_enc_id",
    "oly_anon_id", "__s", "_openstat", "s_cid"];

  const BLOCKED_TYPES = ["script", "xmlhttprequest", "image", "sub_frame", "ping", "media", "font", "stylesheet", "other"];

  // Tracker list for the network rules, without the dual-use domains (a site is never blocked from loading itself).
  function trackerBlockDomains() {
    return Array.from(new Set(Array.from(TRACKER_DOMAINS).filter((d) => !DUAL_USE.has(d)).concat(SPECIFIC_TRACKER_HOSTS))).sort();
  }

  function blockRule(id, domains) {
    // Third-party only, and never main_frame: visiting a site is never blocked, only what it pulls in.
    return { id, priority: 1, action: { type: "block" },
      condition: { requestDomains: domains, domainType: "thirdParty", resourceTypes: BLOCKED_TYPES } };
  }

  // The two block lists Chrome applies at network level: trackers and cross-site fingerprinting.
  function buildRulesets() {
    return { trackers: [blockRule(1, trackerBlockDomains())], fingerprint: [blockRule(1, FINGERPRINT_DOMAINS.slice().sort())] };
  }

  // Matches a URL that actually carries one of these tracking parameters, so clean URLs are never redirected.
  function trackingParamPattern(names) {
    return "[?&](" + (names || TRACKING_PARAMS).join("|") + ")=";   // names are [a-z0-9_] only: nothing to escape
  }

  // Chrome refuses a regex that compiles to more than about 2 KB (the whole list in one pattern is rejected with
  // "memoryLimitExceeded" and the rule is never installed), so the names are spread over several rules, each with a
  // small pattern. Every rule removes all the tracking parameters, so one redirect cleans the whole link.
  const PARAM_CHUNK = 8;
  function paramStripRules(firstId) {
    const rules = [];
    for (let i = 0; i < TRACKING_PARAMS.length; i += PARAM_CHUNK) {
      rules.push({ id: firstId + rules.length, priority: 1,
        action: { type: "redirect", redirect: { transform: { queryTransform: { removeParams: TRACKING_PARAMS.slice() } } } },
        condition: { regexFilter: trackingParamPattern(TRACKING_PARAMS.slice(i, i + PARAM_CHUNK)), resourceTypes: ["main_frame", "sub_frame"] } });
    }
    return rules;
  }

  function stripTrackingParams(url) {   // reference implementation, used by tests and the popup preview
    try {
      const u = new URL(url);
      let changed = false;
      for (const p of TRACKING_PARAMS) if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
      return changed ? u.toString() : url;
    } catch (e) { return url; }
  }

  const api = { DEFAULTS, withDefaults, FINGERPRINT_DOMAINS, TRACKING_PARAMS, trackerBlockDomains, buildRulesets,
    paramStripRules, PARAM_CHUNK, trackingParamPattern, stripTrackingParams, fileExtension, evaluateDownload, isBrowserInstallerUrl,
    isEscapeUrl, isTamperUrl, isIpUrl, registrableDomain, classifyCookie, cookieAction };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseRules = api;
})(typeof self !== "undefined" ? self : this);
