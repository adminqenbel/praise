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
    "yahoo.com", "advertising.com", "adform.net", "smartadserver.com", "2mdn.net",
    // ad verification, exchanges and native-ad networks
    "adsafeprotected.com", "moatads.com", "doubleverify.com", "serving-sys.com", "yieldmo.com", "sharethrough.com", "indexww.com",
    "3lift.com", "triplelift.com", "teads.tv", "media.net", "contextweb.com", "lijit.com", "sovrn.com", "33across.com", "gumgum.com",
    "onetag-sys.com", "bidswitch.net", "bidr.io", "smaato.net", "inmobi.com", "mopub.com", "exponential.com", "tribalfusion.com",
    "zedo.com", "revcontent.com", "mgid.com", "adblade.com", "adroll.com", "sitescout.com", "owneriq.net", "ml314.com",
    // session-replay, product analytics and audience measurement
    "fullstory.com", "mouseflow.com", "crazyegg.com", "luckyorange.com", "inspectlet.com", "heapanalytics.com", "amplitude.com",
    "chartbeat.com", "chartbeat.net", "parsely.com", "imrworldwide.com", "quantcount.com", "hs-analytics.net", "hsadspixel.net",
    "mc.yandex.ru", "mc.yandex.com", "stats.wp.com", "pixel.wp.com", "analytics.google.com"]);
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
  const FINGERPRINT_DOMAINS = ["fpjs.io", "fpcdn.io", "fpjscdn.net", "fingerprint.com", "fingerprintjs.com",
    "bluecava.com", "tapad.com", "liveramp.com", "rlcdn.com", "id5-sync.com", "adsymptotic.com",
    "agkn.com", "bkrtx.com", "eyeota.net", "exelator.com", "lotame.com", "crwdcntrl.net",
    "intentiq.com", "liadm.com", "pippio.com", "semasio.net", "mxptint.net", "turn.com", "adgrx.com", "netmng.com"];
  // Device-risk scripts that banks and shops load to stop fraud. They do fingerprint, but blocking them can make a
  // legitimate sign-in or payment fail, so they are deliberately NOT in any generated ruleset (listed for transparency).
  const FRAUD_SCRIPT_DOMAINS = ["iovation.com", "online-metrix.net", "threatmetrix.com", "iesnare.com", "forter.com",
    "kount.com", "siftscience.com", "riskified.com"];

  // Tracking endpoints on domains that also run real sites, so only the tracking hosts are listed.
  const SPECIFIC_TRACKER_HOSTS = ["connect.facebook.net", "pixel.facebook.com", "analytics.tiktok.com",
    "bat.bing.com", "px.ads.linkedin.com", "snap.licdn.com", "sc-static.net", "analytics.yahoo.com",
    "udc.yahoo.com", "geo.yahoo.com", "ads.yahoo.com"];

  // Link-tracking parameters. removeParams needs exact names (no wildcards), so utm_* is spelled out.
  const TRACKING_PARAMS = Array.from(new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "utm_name", "utm_brand", "fbclid", "gclid", "gbraid", "wbraid", "dclid", "msclkid", "yclid", "twclid",
    "ttclid", "li_fat_id", "igshid", "mc_eid", "mc_cid", "_hsenc", "_hsmi", "vero_id", "oly_enc_id",
    "oly_anon_id", "__s", "_openstat", "s_cid",
    "utm_cid", "utm_reader", "utm_viz_id", "utm_pubreferrer", "utm_swu", "gclsrc", "_gl", "igsh", "mkt_tok", "__hstc", "__hssc",
    "__hsfp", "wickedid", "vero_conv", "rb_clickid", "ml_subscriber", "ml_subscriber_hash", "_kx", "trk_contact",
    "trk_msg", "trk_module", "trk_sid", "fb_action_ids", "fb_action_types", "fb_source", "mc_tc", "sc_cid", "ef_id", "cjevent",
    "cjdata", "irclickid", "sscid", "epik", "pk_campaign", "pk_kwd", "piwik_campaign", "piwik_kwd", "matomo_campaign"]));

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

  // ---- privacy techniques: switches, request-header and upgrade rules, page-world hardening -------------------------
  // Every technique is individually switchable. techniqueOptions() turns the policy settings into the flat options the
  // builders take: the older privacy.* switches keep their meaning, and an optional settings.techniques group carries the
  // newer ones. Anything that could change how a normal site behaves (HTTPS upgrade, WebRTC guard) is off unless asked for.
  const TECHNIQUE_DEFAULTS = {
    strip_params: true,                // remove tracking parameters from links (queryTransform)
    send_gpc: true,                    // Sec-GPC: 1 on every request
    send_dnt: false,                   // DNT: 1 (deprecated, and one more bit for fingerprinting, so off by default)
    trim_referrer: true,               // drop Referer on third-party requests to tracking hosts
    https_upgrade: false,              // http:// main-frame navigations -> https:// (no fallback in Chrome, so opt in)
    https_upgrade_exceptions: [],      // sites that must stay on http
    harden: { canvas: true, webgl: true, audio: true, hardware: true, plugins: true, webrtc: false, gpc_api: true, referrer: true },
  };

  function cleanDomainList(list) {
    if (!Array.isArray(list)) return [];
    const out = new Set();
    for (const d of list) {
      const h = String(d || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
      if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && out.size < 500) out.add(h);
    }
    return Array.from(out).sort();
  }

  // Merge options over the defaults (flat keys; harden may be partial). Unknown or mistyped values fall back.
  function resolveTechniques(options) {
    const o = options && typeof options === "object" ? options : {};
    const D = TECHNIQUE_DEFAULTS;
    const bool = (v, d) => (typeof v === "boolean" ? v : d);
    const h = o.harden && typeof o.harden === "object" ? o.harden : {};
    const harden = {};
    for (const k of Object.keys(D.harden)) harden[k] = bool(h[k], D.harden[k]);
    return { strip_params: bool(o.strip_params, D.strip_params), send_gpc: bool(o.send_gpc, D.send_gpc), send_dnt: bool(o.send_dnt, D.send_dnt),
      trim_referrer: bool(o.trim_referrer, D.trim_referrer), https_upgrade: bool(o.https_upgrade, D.https_upgrade),
      https_upgrade_exceptions: cleanDomainList(o.https_upgrade_exceptions), harden };
  }

  // From policy settings: privacy.strip_tracking_params, privacy.block_fingerprinting (the master switch for page hardening)
  // and the optional settings.techniques group.
  function techniqueOptions(settings) {
    const s = settings && typeof settings === "object" ? settings : {};
    const privacy = s.privacy && typeof s.privacy === "object" ? s.privacy : {};
    const t = s.techniques && typeof s.techniques === "object" ? s.techniques : {};
    const flat = Object.assign({}, t);
    if (typeof t.strip_params !== "boolean" && typeof privacy.strip_tracking_params === "boolean") flat.strip_params = privacy.strip_tracking_params;
    const r = resolveTechniques(flat);
    if (privacy.block_fingerprinting === false) for (const k of Object.keys(r.harden)) r.harden[k] = false;
    return r;
  }

  // Chrome's documented rule limits (declarativeNetRequest). The generators stay far below them.
  const LIMITS = { dynamicRules: 30000, unsafeDynamicRules: 5000, regexRules: 1000, staticGuaranteedRules: 30000, regexFilterChars: 512 };
  // Fixed rule ids, so the extension can replace "everything Praise installed" without tracking what was added:
  // 1..99 tracking parameters, 100.. request headers, 200.. HTTPS upgrade. Ids never move between releases.
  const RULE_IDS = { params: 1, gpc: 100, dnt: 101, referrer: 110, httpsUpgrade: 200, httpsLocal: 201, httpsCaptive: 210, httpsUser: 211 };
  function reservedRuleIds() {
    const ids = [];
    for (let i = 1; i <= 99; i++) ids.push(i);
    for (let i = 100; i <= 119; i++) ids.push(i);
    for (let i = 200; i <= 219; i++) ids.push(i);
    return ids;
  }

  const ALL_TYPES = ["main_frame", "sub_frame", "xmlhttprequest", "script", "image", "stylesheet", "font", "media", "ping", "other"];

  function headerRule(id, header, value) {
    return { id, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header, operation: "set", value }] },
      condition: { urlFilter: "|http", resourceTypes: ALL_TYPES.slice() } };
  }
  const gpcRule = (id) => headerRule(id == null ? RULE_IDS.gpc : id, "Sec-GPC", "1");
  const dntRule = (id) => headerRule(id == null ? RULE_IDS.dnt : id, "DNT", "1");

  // No Referer to hosts whose only job is tracking: the address of the page you are on is the most useful thing to them.
  function referrerRule(id) {
    const hosts = Array.from(new Set(trackerBlockDomains().concat(FINGERPRINT_DOMAINS))).sort();
    return { id: id == null ? RULE_IDS.referrer : id, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "remove" }] },
      condition: { requestDomains: hosts, domainType: "thirdParty", resourceTypes: BLOCKED_TYPES.slice() } };
  }

  // http:// pages that must never be upgraded: raw IPs, intranet names, local suffixes, explicit ports (dev servers).
  const HTTPS_KEEP_PATTERNS = [
    "^http://([^/?#@]*@)?(\\d{1,3}\\.){3}\\d{1,3}([:/?#]|$)",
    "^http://([^/?#@]*@)?\\[",
    "^http://([^/?#@]*@)?[^/?#:.@]+([:/?#]|$)",
    "^http://([^/?#@]*@)?[^/?#@]*:\\d+([/?#]|$)",
    "^http://([^/?#@]*@)?[^/?#:@]*\\.(local|localhost|internal|lan|home|corp|test|invalid|intranet|localdomain|example|onion|arpa)([:/?#]|$)",
  ];
  // Captive-portal and connectivity checks work over plain http by design.
  const HTTPS_KEEP_DOMAINS = ["neverssl.com", "captive.apple.com", "connectivitycheck.gstatic.com", "detectportal.firefox.com",
    "msftconnecttest.com", "msftncsi.com", "clients3.google.com", "nmcheck.gnome.org", "network-test.debian.org"];

  // One upgrade rule, and higher-priority "allow" rules for everything that must stay on http (plus the caller's own list).
  function httpsUpgradeRules(exceptions) {
    const rules = [{ id: RULE_IDS.httpsUpgrade, priority: 1, action: { type: "upgradeScheme" },
      condition: { urlFilter: "|http://", resourceTypes: ["main_frame"] } }];
    HTTPS_KEEP_PATTERNS.forEach((re, i) => rules.push({ id: RULE_IDS.httpsLocal + i, priority: 2, action: { type: "allow" },
      condition: { regexFilter: re, resourceTypes: ["main_frame"] } }));
    rules.push({ id: RULE_IDS.httpsCaptive, priority: 2, action: { type: "allow" },
      condition: { requestDomains: HTTPS_KEEP_DOMAINS.slice(), resourceTypes: ["main_frame"] } });
    const own = cleanDomainList(exceptions);
    if (own.length) rules.push({ id: RULE_IDS.httpsUser, priority: 2, action: { type: "allow" }, condition: { requestDomains: own, resourceTypes: ["main_frame"] } });
    return rules;
  }

  // Static rulesets for the privacy techniques (one file each, so the extension can switch them on and off one by one).
  function buildPrivacyRulesets() {
    return { strip_params: paramStripRules(RULE_IDS.params), gpc: [gpcRule()], dnt: [dntRule()], referrer: [referrerRule()],
      https_upgrade: httpsUpgradeRules([]) };
  }

  // Dynamic rules for the techniques that are on. Send `removeRuleIds` together with `rules` to
  // chrome.declarativeNetRequest.updateDynamicRules: it clears everything Praise owns first, so it is safe to repeat.
  function buildDynamicRules(options) {
    const o = resolveTechniques(options);
    const rules = [];
    if (o.strip_params) rules.push.apply(rules, paramStripRules(RULE_IDS.params));
    if (o.send_gpc) rules.push(gpcRule());
    if (o.send_dnt) rules.push(dntRule());
    if (o.trim_referrer) rules.push(referrerRule());
    if (o.https_upgrade) rules.push.apply(rules, httpsUpgradeRules(o.https_upgrade_exceptions));
    return { rules, removeRuleIds: reservedRuleIds() };
  }

  const RULE_ACTIONS = new Set(["block", "allow", "allowAllRequests", "redirect", "upgradeScheme", "modifyHeaders"]);
  const RESOURCE_TYPES = new Set(["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest",
    "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"]);

  // Problems that would make Chrome reject (or silently ignore) a rule list. Empty array means it is fine.
  // kind: "dynamic" (default) or "static".
  function checkRules(rules, kind) {
    const problems = [];
    if (!Array.isArray(rules)) return ["rules is not an array"];
    const ids = new Set();
    let regex = 0, unsafe = 0;
    for (const r of rules) {
      const tag = "rule " + (r && r.id);
      if (!r || !Number.isInteger(r.id) || r.id < 1) { problems.push(tag + ": id must be a positive integer"); continue; }
      if (ids.has(r.id)) problems.push(tag + ": duplicate id");
      ids.add(r.id);
      if (!Number.isInteger(r.priority) || r.priority < 1) problems.push(tag + ": priority must be a positive integer");
      const type = r.action && r.action.type;
      if (!RULE_ACTIONS.has(type)) problems.push(tag + ": unknown action " + type);
      if (type === "redirect" || type === "upgradeScheme" || type === "modifyHeaders") unsafe++;
      if (type === "modifyHeaders" && !((r.action.requestHeaders || []).length || (r.action.responseHeaders || []).length)) problems.push(tag + ": modifyHeaders without headers");
      if (type === "redirect" && !(r.action.redirect && (r.action.redirect.transform || r.action.redirect.url))) problems.push(tag + ": redirect without a target");
      const c = r.condition;
      if (!c || typeof c !== "object") { problems.push(tag + ": no condition"); continue; }
      if (c.regexFilter != null) {
        regex++;
        if (typeof c.regexFilter !== "string" || c.regexFilter.length > LIMITS.regexFilterChars) problems.push(tag + ": regexFilter too long");
        else { try { new RegExp(c.regexFilter); } catch (e) { problems.push(tag + ": regexFilter does not compile"); } }
        if (c.urlFilter != null) problems.push(tag + ": regexFilter and urlFilter together");
      }
      for (const t of c.resourceTypes || []) if (!RESOURCE_TYPES.has(t)) problems.push(tag + ": unknown resource type " + t);
      for (const d of (c.requestDomains || []).concat(c.excludedRequestDomains || [])) {
        if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d)) problems.push(tag + ": bad domain " + d);
      }
      if (type === "block" && (c.resourceTypes || []).includes("main_frame")) problems.push(tag + ": blocks main_frame");
    }
    if (regex > LIMITS.regexRules) problems.push("too many regex rules: " + regex);
    if (kind === "static") { if (rules.length > LIMITS.staticGuaranteedRules) problems.push("too many static rules: " + rules.length); }
    else {
      if (rules.length > LIMITS.dynamicRules) problems.push("too many dynamic rules: " + rules.length);
      if (unsafe > LIMITS.unsafeDynamicRules) problems.push("too many redirect/header rules: " + unsafe);
    }
    return problems;
  }

  // ---- page-world hardening ---------------------------------------------------------------------------------------
  // installHardening runs in the page's own JavaScript world (a MAIN-world content script at document_start). It is
  // deliberately self-contained (no references to anything outside its own body) so that hardeningSource() can ship it
  // as text. `win` is the window (a stub in tests); `opts` are the harden.* switches; `seed` makes the noise
  // stable for the life of the page: the same canvas read twice gives the same answer, as a fingerprinter expects.
  function installHardening(win, opts, seed) {
    const o = opts || {};
    const mark = Symbol.for("praise.hardened");
    if (!win || win[mark]) return [];
    try { Object.defineProperty(win, mark, { value: true }); } catch (e) { /* frozen window */ }
    const applied = [];
    const base = (seed >>> 0) || 0x9e3779b9;
    // 32-bit integer hash of a position; the same position always gets the same value for this page.
    const hash = (x) => { x = (Math.imul(x, 0x9e3779b1) + base) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); return (x ^ (x >>> 16)) >>> 0; };
    const patch = (obj, name, make) => {
      try {
        const orig = obj && obj[name];
        if (typeof orig !== "function") return false;
        const fn = make(orig);
        Object.defineProperty(fn, "name", { value: orig.name, configurable: true });
        Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true, enumerable: false });
        return true;
      } catch (e) { return false; }
    };
    const getter = (obj, name, value) => {
      try { Object.defineProperty(obj, name, { get: () => value, configurable: true, enumerable: true }); return true; } catch (e) { return false; }
    };
    // Flip the lowest bit of one colour channel in about one pixel in 64 (alpha is never touched). Invisible, and
    // enough to change the hash of the whole image.
    const perturb = (data) => {
      for (let i = 0; i + 3 < data.length; i += 4) {
        const k = hash(i >>> 2);
        if ((k & 63) === 0) data[i + ((k >>> 6) % 3)] ^= 1;
      }
    };
    const AREA = 256;                    // tiny canvases (feature tests, icons) are left alone

    if (o.canvas && win.CanvasRenderingContext2D && win.HTMLCanvasElement) {
      const ctxProto = win.CanvasRenderingContext2D.prototype, cvProto = win.HTMLCanvasElement.prototype;
      const origGet = ctxProto.getImageData;
      let ok = patch(ctxProto, "getImageData", (orig) => function () {
        const img = orig.apply(this, arguments);
        if (img && img.data && img.width * img.height >= AREA) perturb(img.data);
        return img;
      });
      for (const name of ["toDataURL", "toBlob"]) {
        ok = patch(cvProto, name, (orig) => function () {
          try {
            if (this.width * this.height >= AREA) {
              const copy = this.ownerDocument.createElement("canvas");
              copy.width = this.width; copy.height = this.height;
              const c2 = copy.getContext("2d");
              if (c2) {
                c2.drawImage(this, 0, 0);
                const img = origGet.call(c2, 0, 0, copy.width, copy.height);
                perturb(img.data);
                c2.putImageData(img, 0, 0);
                return orig.apply(copy, arguments);
              }
            }
          } catch (e) { /* tainted or lost context: fall through to the real call */ }
          return orig.apply(this, arguments);
        }) || ok;
      }
      if (ok) applied.push("canvas");
    }

    if (o.webgl) {
      let ok = false;
      for (const cls of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
        if (!win[cls]) continue;
        ok = patch(win[cls].prototype, "readPixels", (orig) => function () {
          const r = orig.apply(this, arguments);
          const px = arguments[6];
          if (px && px.BYTES_PER_ELEMENT === 1 && px.length >= AREA * 4) perturb(px);
          return r;
        }) || ok;
      }
      if (ok) applied.push("webgl");
    }

    if (o.audio) {
      let ok = false;
      const seen = new WeakSet();
      if (win.AudioBuffer) {
        ok = patch(win.AudioBuffer.prototype, "getChannelData", (orig) => function () {
          const arr = orig.apply(this, arguments);
          if (arr && arr.length >= 128 && !seen.has(arr)) {
            seen.add(arr);
            for (let i = 0; i < arr.length; i += 8) { const k = hash(i); if ((k & 7) === 0) arr[i] += ((k & 8) ? 1 : -1) * 1e-7; }
          }
          return arr;
        });
      }
      if (win.AnalyserNode) {
        ok = patch(win.AnalyserNode.prototype, "getFloatFrequencyData", (orig) => function (arr) {
          const r = orig.apply(this, arguments);
          if (arr && arr.length) for (let i = 0; i < arr.length; i++) arr[i] += ((hash(i) & 1) ? 1 : -1) * 1e-4;
          return r;
        }) || ok;
      }
      if (ok) applied.push("audio");
    }

    const nav = win.navigator;
    let navProto = nav && Object.getPrototypeOf(nav);
    if (navProto === Object.prototype) navProto = null;      // never add properties to every object
    if (o.hardware && nav && navProto) {
      let ok = false;
      const hc = nav.hardwareConcurrency, dm = nav.deviceMemory;
      if (typeof hc === "number") ok = getter(navProto, "hardwareConcurrency", hc >= 8 ? 8 : hc >= 4 ? 4 : hc >= 2 ? 2 : 1) || ok;
      if (typeof dm === "number") ok = getter(navProto, "deviceMemory", Math.min(dm, 4)) || ok;
      if (ok) applied.push("hardware");
    }

    if (o.plugins && nav && navProto) {
      // Browsers already report one fixed list of PDF viewers; anything else (a plug-in that adds itself) is hidden.
      const STANDARD = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
      try {
        const real = nav.plugins;
        const list = [];
        for (let i = 0; real && i < real.length; i++) if (STANDARD.indexOf(real[i].name) !== -1) list.push(real[i]);
        if (real && list.length !== real.length) {
          const view = { length: list.length, item: (i) => list[i] || null, namedItem: (n) => list.find((p) => p.name === n) || null,
            refresh: () => {}, [Symbol.iterator]: () => list[Symbol.iterator]() };
          list.forEach((p, i) => { view[i] = p; });
          if (getter(navProto, "plugins", view)) applied.push("plugins");
        }
      } catch (e) { /* leave plugins alone */ }
    }

    if (o.gpc_api && nav && navProto && nav.globalPrivacyControl === undefined) {
      if (getter(navProto, "globalPrivacyControl", true)) applied.push("gpc_api");
    }

    if (o.webrtc) {
      // Raw private addresses in ICE candidates tell every site your LAN address. Candidates with a .local (mDNS) name
      // are what browsers send when they are protecting you already, so only the raw ones are dropped.
      const PRIVATE = /(^|[\s:])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|f[cd][0-9a-f]{2}:[0-9a-f:]+|fe80:[0-9a-f:]*)(\s|$)/i;
      const leaks = (ev) => !!(ev && ev.candidate && typeof ev.candidate.candidate === "string" && PRIVATE.test(ev.candidate.candidate));
      for (const cls of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
        const P = win[cls] && win[cls].prototype;
        if (!P || typeof P.addEventListener !== "function") continue;
        const wrapped = new WeakMap();
        const wrap = (fn) => {
          if (typeof fn !== "function") return fn;
          let w = wrapped.get(fn);
          if (!w) { w = function (ev) { return leaks(ev) ? undefined : fn.apply(this, arguments); }; wrapped.set(fn, w); }
          return w;
        };
        patch(P, "addEventListener", (orig) => function (type, fn) {
          if (type === "icecandidate") arguments[1] = wrap(fn);
          return orig.apply(this, arguments);
        });
        patch(P, "removeEventListener", (orig) => function (type, fn) {
          if (type === "icecandidate" && wrapped.has(fn)) arguments[1] = wrapped.get(fn);
          return orig.apply(this, arguments);
        });
        try {
          const prev = Object.getOwnPropertyDescriptor(P, "onicecandidate");
          if (prev && prev.set) {
            const mine = new WeakMap();
            Object.defineProperty(P, "onicecandidate", { configurable: true, enumerable: true,
              get() { return mine.has(this) ? mine.get(this) : prev.get.call(this); },
              set(fn) { mine.set(this, fn); prev.set.call(this, wrap(fn)); } });
          }
        } catch (e) { /* leave the property alone */ }
        if (applied.indexOf("webrtc") === -1) applied.push("webrtc");
      }
    }

    if (o.referrer && win.document && typeof win.document.addEventListener === "function") {
      // A page that sets a policy sending full URLs to other sites (unsafe-url, no-referrer-when-downgrade) is overruled for
      // links that leave the site: only the origin goes along. Policies set by headers are not visible from here.
      const LEAKY = ["unsafe-url", "no-referrer-when-downgrade"];
      win.document.addEventListener("click", (ev) => {
        try {
          const doc = win.document;
          const a = ev.target && ev.target.closest && ev.target.closest("a[href], area[href]");
          if (!a || a.hasAttribute("referrerpolicy") || !a.href) return;
          const meta = doc.querySelector && doc.querySelector("meta[name=referrer]");
          const policy = meta && String(meta.getAttribute("content") || "").trim().toLowerCase();
          if (LEAKY.indexOf(policy) !== -1 && new win.URL(a.href, win.location.href).origin !== win.location.origin) {
            a.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
          }
        } catch (e) { /* never get in the way of a click */ }
      }, true);
      applied.push("referrer");
    }
    return applied;
  }

  // The same function as text, ready to be written to a file or run with chrome.scripting.executeScript({ world: "MAIN" }).
  // Without a seed, the page picks a random one when it loads.
  function hardeningSource(options, seed) {
    const h = resolveTechniques({ harden: options }).harden;
    const seedExpr = Number.isFinite(seed) ? String(seed >>> 0) : "((crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0)";
    return "(" + installHardening.toString() + ")(self, " + JSON.stringify(h) + ", " + seedExpr + ");\n";
  }

  const api = { DEFAULTS, withDefaults, FINGERPRINT_DOMAINS, FRAUD_SCRIPT_DOMAINS, TRACKING_PARAMS, trackerBlockDomains, buildRulesets,
    paramStripRules, PARAM_CHUNK, trackingParamPattern, stripTrackingParams, fileExtension, evaluateDownload, isBrowserInstallerUrl,
    isEscapeUrl, isTamperUrl, isIpUrl, registrableDomain, classifyCookie, cookieAction,
    TECHNIQUE_DEFAULTS, techniqueOptions, resolveTechniques, LIMITS, RULE_IDS, reservedRuleIds, buildPrivacyRulesets, buildDynamicRules,
    httpsUpgradeRules, HTTPS_KEEP_DOMAINS, checkRules, installHardening, hardeningSource };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseRules = api;
})(typeof self !== "undefined" ? self : this);
