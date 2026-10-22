// Praise service worker: ONE extension for every Praise account.
//
// Until a pairing code is accepted it does nothing at all. The code decides what it becomes:
//   family  (a parent's code)   a child's browser. Sites are held on a "checking" page until judged, blocked ones get
//                               the door page, downloads and browser hand-offs are watched, and only a parent can
//                               disconnect it.
//   adult   (an adult's own code)   a personal shield. Pages load while they are judged alongside, risky ones get a
//                               warning page, trackers are blocked, and the sensitive-data guard runs on pages.
// The mode comes from the server (the account that issued the code) and is refreshed on every sync. A browser whose
// mode is somehow missing is treated as family, the stricter of the two.
importScripts("lib.js", "protections.js", "passwords.js", "pet-control.js", "guard-control.js");
const { normalizeDomain, offlineDecision, extractSignals, hostOf } = self.PraiseLib;
// Shared helpers: PraiseLib (URLs, offline decisions, page signals), PraiseRules (downloads, cookies, escape links) and PraisePasswords (breach check).
const R = self.PraiseRules;
const PW = self.PraisePasswords;

// Timings and limits. A normal check gives up after 8 s; a first-time check may wait up to 40 s for the AI. Decisions are cached (up to 2000) and the policy is re-synced every 5 minutes.
const DEFAULT_BACKEND = "https://api.praise.qenbel.site";
// A copy installed from the Chrome Web Store has an update_url; an unpacked developer copy doesn't. Only a developer
// copy may be pointed at another server (a local one): otherwise a child could pair the browser with a server of their own.
const DEV_BUILD = !(chrome.runtime.getManifest && "update_url" in chrome.runtime.getManifest());
const REQUEST_TIMEOUT_MS = 8000;
const CHECK_TIMEOUT_MS = 40000;   // a first-time check may wait on the AI service (with retries)
const SIGNAL_TIMEOUT_MS = 5000;
const CACHE_MAX = 2000;
const SYNC_MINUTES = 5;
const CONTINUE_MS = 60 * 60 * 1000;     // adult: "Continue anyway" is remembered for an hour
// Extension pages that replace a site: the door page for children, the warning page for adults.
const BLOCK_PAGE = chrome.runtime.getURL("block/block.html");   // family
const WARN_PAGE = chrome.runtime.getURL("warn/warn.html");      // adult
const EXTENSION_ORIGIN = chrome.runtime.getURL("");

// ---- state ---------------------------------------------------------------
// Everything the extension remembers (pairing token, mode, policy copy, pause time...). The token is only ever kept in chrome.storage.local, inside the extension.
async function getState() {
  return chrome.storage.local.get({
    backendUrl: DEFAULT_BACKEND, token: null, mode: null, profileName: null, snapshot: null,
    snapshotHash: null, revoked: false, lastSync: null, pausedUntil: 0, cont: {},
  });
}

// null while unpaired; otherwise "adult" or "family" (anything unknown counts as family)
const modeOf = (st) => (!st.token ? null : st.mode === "adult" ? "adult" : "family");
const isAdult = (st) => modeOf(st) === "adult";
const isPaused = (st) => isAdult(st) && st.pausedUntil > Date.now();
const settingsOf = (st) => R.withDefaults(st.snapshot && st.snapshot.settings);

// Decision cache: domain -> {decision, expiry}. When it grows past the limit the entries closest to expiring are dropped first.
async function getCache() { return (await chrome.storage.local.get({ cache: {} })).cache; }
async function setCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => cache[a].exp - cache[b].exp).slice(0, keys.length - CACHE_MAX).forEach((k) => delete cache[k]);
  }
  await chrome.storage.local.set({ cache });
}

// ---- backend ---------------------------------------------------------------
// Every call to the Praise server: adds the device token, times out, and never sends cookies (credentials: omit).
async function api(path, { method = "GET", body, auth = true, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const st = await getState();
  const headers = { "Content-Type": "application/json" };
  if (auth && st.token) headers.Authorization = "Bearer " + st.token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(st.backendUrl.replace(/\/+$/, "") + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal, credentials: "omit",
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, data };
  } finally { clearTimeout(timer); }
}

// For a brand-new site, fetch its page ourselves and extract a few public facts (title, description, a text snippet, whether it has a login form) for the AI. Page text is not executed.
async function fetchSignals(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SIGNAL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: "omit", redirect: "follow" });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return {};
    return extractSignals(await res.text());
  } catch (e) { return {}; } finally { clearTimeout(timer); }
}

// ---- decisions ------------------------------------------------------------------
// Used when the server cannot be reached: decide from the last synced policy and verified-site lists.
function offlineResult(domain, snapshot) {
  const d = offlineDecision(domain, snapshot);
  return { domain, action: d.action, can_continue: d.action === "WARN", category: null, risk: null,
           reason: d.reason, evidence: [], suggest: null, offline: true };
}

// Ask 'what should happen to this URL?': cache first, then the server (twice if it wants page signals), and the offline answer if anything fails.
async function resolve(url) {
  const domain = normalizeDomain(url);
  if (!domain) return { domain: null, action: "ALLOW", reason: "not-a-website" };

  const cache = await getCache();
  const hit = cache[domain];
  if (hit && hit.exp > Date.now()) return hit.decision;

  const st = await getState();
  // What leaves the browser adapts too. A child's browser sends the address so a parent's rules can be exact. A
  // personal browser sends only the site's origin: paths and query strings can hold private tokens (reset links,
  // unlisted documents), and a site's verdict doesn't need them.
  const target = isAdult(st) ? new URL(url).origin + "/" : url;
  try {
    let r = await api("/api/ext/check", { method: "POST", body: { url: target }, timeout: CHECK_TIMEOUT_MS });
    if (r.ok && r.data && r.data.need_signals) {
      r = await api("/api/ext/check", { method: "POST", body: { url: target, signals: await fetchSignals(target) }, timeout: CHECK_TIMEOUT_MS });
    }
    if (r.status === 401) {                       // token revoked: keep enforcing the last policy
      await chrome.storage.local.set({ revoked: true });
      return offlineResult(domain, st.snapshot);
    }
    if (!r.ok || !r.data || !r.data.action) return offlineResult(domain, st.snapshot);

    const d = r.data;
    const decision = {
      domain: d.domain, action: d.action, can_continue: !!d.can_continue, category: d.category || null,
      risk: d.risk ?? null, reason: d.reason || "", ai: d.ai, evidence: d.evidence || [], suggest: d.suggest || null,
    };
    if (d.cache_ttl > 0) { cache[domain] = { decision, exp: Date.now() + d.cache_ttl * 1000 }; await setCache(cache); }
    return decision;
  } catch (e) {
    return offlineResult(domain, st.snapshot);   // adult default offline: allow unless a verified list says otherwise
  }
}

// family: the block page asks again while a child waits for a parent's yes: forget the cached "no" first.
async function recheck(url) {
  const domain = normalizeDomain(url);
  if (!domain) return { domain: null, action: "ALLOW", reason: "not-a-website" };
  const cache = await getCache();
  if (cache[domain]) { delete cache[domain]; await setCache(cache); }
  return resolve(url);
}

// ---- family: the door page --------------------------------------------------------
// Address of the door page, carrying only the facts it needs to explain the block.
function blockedUrl(decision, originalUrl) {
  const q = new URLSearchParams({
    mode: "blocked", u: originalUrl, d: decision.domain || "", a: decision.action,
    c: decision.category || "", r: decision.risk ?? "", why: decision.reason || "",
    off: decision.offline ? "1" : "",
  });
  return BLOCK_PAGE + "?" + q.toString();
}

// Address of the neutral 'checking' page shown while a site is being judged.
function checkingUrl(originalUrl) {
  return BLOCK_PAGE + "?" + new URLSearchParams({ mode: "checking", u: originalUrl });
}

// Tell the parent that the child asked to open a site (shows up under 'Asking to open a site').
async function requestAccess(domain) {
  const r = await api("/api/ext/events", {
    method: "POST",
    body: { events: [{ kind: "browser", data: { type: "access_request", domain } }] },
  });
  return { ok: r.ok };
}

// ---- adult: the warning page -------------------------------------------------------
// The warning page may be opened by any website, so it must not trust its own address.
// Details live here, keyed by a one-time random token; the page just asks for them.
const WARNING_TTL_MS = 10 * 60 * 1000;

async function stashWarning(decision, url) {
  const n = crypto.randomUUID();
  const { warnings } = await chrome.storage.session.get({ warnings: {} });
  const now = Date.now();
  for (const k of Object.keys(warnings)) if (warnings[k].exp < now) delete warnings[k];
  warnings[n] = { decision, url, exp: now + WARNING_TTL_MS };
  await chrome.storage.session.set({ warnings });
  return n;
}

async function getWarning(n) {
  const { warnings } = await chrome.storage.session.get({ warnings: {} });
  const w = warnings[String(n || "")];
  return w && w.exp > Date.now() ? w : null;
}

// Log the warning and move the tab to the warning page, which looks up its details with a one-time token.
async function showWarning(tabId, decision, url) {
  logEvent("security", { type: decision.action === "BLOCK" ? "site_blocked" : "warning_shown",
    domain: decision.domain, category: decision.category, risk: decision.risk });
  const n = await stashWarning(decision, url);
  chrome.tabs.update(tabId, { url: WARN_PAGE + "?n=" + encodeURIComponent(n) });
}

async function continueAnyway(n) {
  const w = await getWarning(n);
  if (!w || !w.decision.can_continue) return { ok: false };      // hard blocks can't be skipped
  const d = normalizeDomain(w.url);
  if (!d) return { ok: false };
  const st = await getState();
  const cont = Object.fromEntries(Object.entries(st.cont).filter(([, exp]) => exp > Date.now()));
  cont[d] = Date.now() + CONTINUE_MS;
  await chrome.storage.local.set({ cont });
  logEvent("security", { type: "warning_overridden", domain: d });
  return { ok: true, url: w.url };
}

// ---- navigation interception -----------------------------------------------------
// Every top-level navigation passes through here first. Nothing happens until the browser is paired.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;                       // top-level navigations only
  const st = await getState();
  if (!st.token || isPaused(st)) return;                   // not paired: nothing to enforce
  if (isAdult(st)) return adultNavigate(details, st);
  return familyNavigate(details, st);
});

// A child's browser: nothing renders before it has been judged.
async function familyNavigate(details, st) {
  if (await guardUrl(details.tabId, details.url, st)) return;   // installer / escape / tamper
  const domain = normalizeDomain(details.url);
  if (!domain) return;
  if (hostOf(details.url) === hostOf(st.backendUrl)) return;   // never lock out our own backend

  const cache = await getCache();
  const hit = cache[domain];
  if (hit && hit.exp > Date.now()) {
    if (hit.decision.action === "ALLOW") return;
    chrome.tabs.update(details.tabId, { url: blockedUrl(hit.decision, details.url) });
    return;
  }
  // Unknown to the cache: hold the tab on a neutral "checking" page until we have an answer,
  // so the site never renders before it has been judged.
  chrome.tabs.update(details.tabId, { url: checkingUrl(details.url) });
}

// A personal browser: an adult browsing normally shouldn't wait on every unfamiliar address. The check runs alongside
// the page load and the tab is moved to a warning page only when the answer is WARN or BLOCK.
async function adultNavigate(details, st) {
  const domain = normalizeDomain(details.url);
  if (!domain) return;
  if (hostOf(details.url) === hostOf(st.backendUrl)) return;
  const cache = await getCache();
  const hit = cache[domain];
  if ((st.cont[domain] || 0) > Date.now()) {                      // "Continue anyway" within the last hour...
    // ...never overrides a hard block that appeared since (for example a site later found to be malware)
    if (hit && hit.exp > Date.now() && hit.decision.action === "BLOCK") showWarning(details.tabId, hit.decision, details.url);
    return;
  }
  if (hit && hit.exp > Date.now()) {
    if (hit.decision.action !== "ALLOW") showWarning(details.tabId, hit.decision, details.url);
    return;
  }
  // Known-safe from the last policy sync: no need to ask the server at all.
  const local = offlineDecision(domain, st.snapshot);
  if (local.action === "ALLOW" && /verified-allow|exception|parent-allow/.test(local.reason)) return;

  // Unknown: let the page load, judge it alongside, and step in only if it's risky.
  const d = await resolve(details.url);
  if (d.action === "ALLOW") return;
  try {
    const tab = await chrome.tabs.get(details.tabId);
    const now = normalizeDomain(tab.url || tab.pendingUrl || "");
    if (now === domain) showWarning(details.tabId, d, details.url);
  } catch (e) { /* tab closed */ }
}

// ---- family: browser installers, browser hand-off, tamper pages --------------------------------
// Returns true when the navigation was redirected to the block page.
async function guardUrl(tabId, url, st) {
  const prot = settingsOf(st).protections;
  let category = null, detail = {};
  if (prot.escape) {
    const esc = R.isEscapeUrl(url);
    if (esc) { category = "external_browser"; detail = { scheme: esc.scheme }; }
  }
  if (!category && prot.tamper && R.isTamperUrl(url)) category = "tamper";
  if (!category && prot.escape && R.isIpUrl(url)) category = "ip_address";   // no site name to judge: a way around the rules
  if (!category && prot.browser_installers && R.isBrowserInstallerUrl(url)) category = "browser_installer";
  if (!category) return false;

  logEvent("security", { type: category, url: String(url).slice(0, 500), ...detail });
  chrome.tabs.update(tabId, {
    url: blockedUrl({ action: "BLOCK", category, domain: normalizeDomain(url) || "" }, url),
  });
  return true;
}

// chrome:// pages and external-protocol URLs don't always reach webNavigation; tabs.onUpdated sees them.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const url = info.url;
  if (!url || /^https?:/i.test(url) || url.startsWith(EXTENSION_ORIGIN)) return;
  const st = await getState();
  if (modeOf(st) !== "family") return;
  await guardUrl(tabId, url, st);
});

// ---- family: downloads ---------------------------------------------------------------------------
const handledDownloads = new Set();

// Check one download against the family's rules: record it, and cancel and erase it if it is a program, script or installer.
async function inspectDownload(item) {
  const st = await getState();
  if (modeOf(st) !== "family" || !item) return;
  const verdict = R.evaluateDownload(item, st.snapshot && st.snapshot.settings);
  const key = item.id + ":" + verdict.action;
  if (handledDownloads.has(key)) return;
  handledDownloads.add(key);
  if (handledDownloads.size > 500) handledDownloads.clear();

  logEvent("download", {
    filename: String(item.filename || "").split(/[\\/]/).pop().slice(0, 200),
    ext: verdict.ext, kind: verdict.kind, action: verdict.action,
    source: normalizeDomain(item.finalUrl || item.url || "") || null, mime: item.mime || null,
  });
  if (verdict.action === "BLOCK") {
    try { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); } catch (e) { /* already gone */ }
  }
}

chrome.downloads.onCreated.addListener(inspectDownload);
// filename / mime are often only known after the response headers arrive: re-check then.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.filename && !delta.mime && !delta.danger) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (item) inspectDownload(item);
});

// ---- family: site storage counts (localStorage / sessionStorage / IndexedDB / caches / service workers) --
const storageSeen = new Map();
chrome.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const st = await getState();
  if (modeOf(st) !== "family") return;
  if (!settingsOf(st).protections.storage_monitor) return;
  const domain = normalizeDomain(d.url);
  if (!domain) return;
  if (Date.now() - (storageSeen.get(domain) || 0) < 3600e3) return;
  storageSeen.set(domain, Date.now());
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: d.tabId },
      func: async () => {
        const n = (f) => { try { return f(); } catch (e) { return 0; } };
        const idb = indexedDB.databases ? (await indexedDB.databases()).length : 0;
        const cch = self.caches ? (await caches.keys()).length : 0;
        const sw = navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0;
        return { local_storage: n(() => localStorage.length), session_storage: n(() => sessionStorage.length),
                 indexed_db: idb, cache_storage: cch, service_workers: sw };
      },
    });
    if (res && res.result) logEvent("cookie", { type: "storage", domain, ...res.result });
  } catch (e) { /* page not scriptable (store pages, PDFs): skip */ }
});

// ---- events (batched to /api/ext/events) ----------------------------------------------------------
// Events are queued locally and uploaded in batches, so a short outage loses nothing and the server isn't called for every action.
let queueChain = Promise.resolve();
const FLUSH_AT = 20, QUEUE_MAX = 200;

// Add one event to the local queue (capped at 200); upload when 20 are waiting.
function logEvent(kind, data) {
  queueChain = queueChain.then(async () => {
    const { eventQueue } = await chrome.storage.local.get({ eventQueue: [] });
    eventQueue.push({ kind, data });
    if (eventQueue.length > QUEUE_MAX) eventQueue.splice(0, eventQueue.length - QUEUE_MAX);
    await chrome.storage.local.set({ eventQueue });
    if (eventQueue.length >= FLUSH_AT) await flushEvents();
  }).catch(() => {});
  return queueChain;
}

// Upload up to 100 queued events; they are removed from the queue only after the server accepted them.
async function flushEvents() {
  const { eventQueue } = await chrome.storage.local.get({ eventQueue: [] });
  if (!eventQueue.length) return;
  const batch = eventQueue.slice(0, 100);
  try {
    const r = await api("/api/ext/events", { method: "POST", body: { events: batch } });
    if (r.ok) {
      const cur = (await chrome.storage.local.get({ eventQueue: [] })).eventQueue;
      await chrome.storage.local.set({ eventQueue: cur.slice(batch.length) });
    }
  } catch (e) { /* offline: keep queued */ }
}

// ---- pairing, sync, disconnect, pause ---------------------------------------------------------------
// The server answers a pairing code with the kind of account that issued it; that is what the extension becomes.
async function pair(code, backendUrl) {
  const url = DEV_BUILD && backendUrl ? String(backendUrl).trim() : DEFAULT_BACKEND;
  try { new URL(url); } catch (e) { return { ok: false, error: "That server address isn't valid." }; }
  await chrome.storage.local.set({ backendUrl: url });
  try {
    const r = await api("/api/devices/pair", { method: "POST", auth: false, body: { code } });
    if (!r.ok) return { ok: false, error: (r.data && r.data.error) || "Pairing failed. Check the code." };
    const mode = r.data.mode === "adult" ? "adult" : "family";
    await chrome.storage.local.set({ token: r.data.token, mode, revoked: false, cache: {}, cont: {}, pausedUntil: 0 });
    await sync();
    await applyProtection();
    return { ok: true, mode };
  } catch (e) {
    return { ok: false, error: "Can't reach the server. Check the address and try again." };
  }
}

// Leaving the account. The server decides whether a parent's disconnect code (or password) is needed (a child's browser:
// yes, otherwise the child could simply switch the protection off; an adult's own: they just confirm in the popup). A browser that was
// already removed from the account can clear itself. Everything about the pairing goes, so the extension is neutral again;
// the buddy setting and remembered-password fingerprints are the person's own and stay.
const PAIRING_KEYS = ["token", "mode", "profileName", "snapshot", "snapshotHash", "revoked", "lastSync", "cache", "cont", "pausedUntil", "eventQueue"];
async function disconnect(code) {
  const st = await getState();
  let told = true;
  if (st.token && !st.revoked) {
    let r;
    try { r = await api("/api/ext/disconnect", { method: "POST", body: { code: String(code || "").slice(0, 256) } }); }
    catch (e) {
      // A child's browser can't leave without a parent. A person protecting themselves is never trapped.
      if (!isAdult(st)) return { ok: false, error: "Can't reach the server, so this browser can't be disconnected right now." };
      r = null; told = false;
    }
    if (r) {
      if (r.status === 403 || r.status === 429) return { ok: false, error: (r.data && r.data.error) || "That didn't work." };
      if (!r.ok && r.status !== 401) {
        if (!isAdult(st)) return { ok: false, error: "The server didn't answer. Try again in a moment." };
        told = false;
      }
    }
  }
  await chrome.storage.local.remove(PAIRING_KEYS);
  chrome.alarms.clear("unpause");
  await applyProtection();
  return { ok: true, told };
}

// Fetch the latest policy and settings. New rules clear the decision cache so old answers are not reused.
async function sync() {
  const st = await getState();
  if (!st.token) return;
  try {
    const r = await api("/api/ext/policy-sync");
    if (r.status === 401) { await chrome.storage.local.set({ revoked: true }); return; }
    if (!r.ok || !r.data) return;
    const { child, mode, ...snapshot } = r.data;
    const hash = JSON.stringify(snapshot);
    await chrome.storage.local.set({
      snapshot, snapshotHash: hash, profileName: child, revoked: false, lastSync: Date.now(),
      ...(mode ? { mode: mode === "adult" ? "adult" : "family" } : {}),
      ...(hash !== st.snapshotHash ? { cache: {} } : {}),            // new rules => forget old decisions
    });
    await applyProtection();
  } catch (e) { /* offline: keep last snapshot */ }
}

// adult only
async function setPause(minutes) {
  const st = await getState();
  if (!isAdult(st)) return { error: "off" };
  let until = 0;
  if (minutes === "tomorrow") { const d = new Date(); d.setHours(24, 0, 0, 0); until = d.getTime(); }
  else if (typeof minutes === "number" && minutes > 0) until = Date.now() + minutes * 60000;
  await chrome.storage.local.set({ pausedUntil: until });
  await applyProtection();
  if (until) chrome.alarms.create("unpause", { when: until }); else chrome.alarms.clear("unpause");
  return { pausedUntil: until };
}

// Rules that remove tracking codes (like utm_source) from links.
const PARAM_RULES = R.paramStripRules(1);                 // a few rules (see protections.js), ids 1..n
const PARAM_RULE_IDS = PARAM_RULES.map((r) => r.id);
// Name and toolbar icon for each state: neutral (not paired), family, adult.
const LOOKS = {
  family: { title: "Praise: family protection", icons: { 16: "icons/family-16.png", 48: "icons/family-48.png", 128: "icons/family-128.png" } },
  adult: { title: "Praise Shield", icons: { 16: "icons/adult-16.png", 48: "icons/adult-48.png", 128: "icons/adult-128.png" } },
  neutral: { title: "Praise", icons: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" } },
};

// Makes the browser match the current state: how the extension presents itself (name and icon), which tracker rulesets
// are on, whether tracking parameters are stripped, and what the toolbar badge shows. Network protections belong to the
// personal side only, and paused (or unpaired, or a child's browser) turns them off.
async function applyProtection() {
  const st = await getState();
  const mode = modeOf(st);
  const off = isPaused(st) || mode !== "adult";
  const cfg = settingsOf(st);
  const dnr = chrome.declarativeNetRequest;

  const look = LOOKS[mode || "neutral"];
  try { await chrome.action.setTitle({ title: look.title }); await chrome.action.setIcon({ path: look.icons }); } catch (e) { /* cosmetic */ }

  const want = [];
  if (!off && cfg.privacy.block_trackers) want.push("trackers");
  if (!off && cfg.privacy.block_fingerprinting) want.push("fingerprint");
  const all = ["trackers", "fingerprint"];
  await dnr.updateEnabledRulesets({ enableRulesetIds: want, disableRulesetIds: all.filter((x) => !want.includes(x)) });

  const have = (await dnr.getDynamicRules()).filter((r) => PARAM_RULE_IDS.includes(r.id)).length;
  const wantParamRule = !off && cfg.privacy.strip_tracking_params;
  if (wantParamRule && have !== PARAM_RULE_IDS.length) {
    await dnr.updateDynamicRules({ removeRuleIds: PARAM_RULE_IDS, addRules: PARAM_RULES });    // replace, so a half-installed set is repaired
  } else if (!wantParamRule && have) {
    await dnr.updateDynamicRules({ removeRuleIds: PARAM_RULE_IDS });
  }

  // Badge: "II" while paused; otherwise Chrome shows how many requests were blocked on the page.
  // (Setting badge text switches the automatic count off, so it is re-enabled afterwards.)
  if (isPaused(st)) {
    await chrome.action.setBadgeText({ text: "II" });
    await chrome.action.setBadgeBackgroundColor({ color: "#f08a24" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: !off });
    await chrome.action.setBadgeBackgroundColor({ color: "#2fbf9b" });
  }
}

// ---- cookies: transparency + removal (values are never read or sent) ----------------------------
// The sites currently open in tabs: a cookie from any other site is 'third-party'. Cached for 3 s.
let topDomainsCache = { at: 0, set: new Set() };
async function getTopDomains() {
  if (Date.now() - topDomainsCache.at < 3000) return topDomainsCache.set;
  const set = new Set();
  for (const t of await chrome.tabs.query({})) {
    const d = normalizeDomain(t.url || "");
    if (d) set.add(R.registrableDomain(d));
  }
  topDomainsCache = { at: Date.now(), set };
  return set;
}

const cookieUrl = (c) => (c.secure ? "https://" : "http://") + c.domain.replace(/^\./, "") + c.path;
async function removeCookie(c) {
  try { await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId, partitionKey: c.partitionKey }); return true; }
  catch (e) { return false; }
}

const seenCookies = new Map();          // "domain|name" -> last logged ms (limits log volume)
// Watch cookies as they are set: classify each one (purpose, first/third-party, lifetime), remove it if the rules say so, and log it. Cookie values are never read.
chrome.cookies.onChanged.addListener(async ({ removed, cookie }) => {
  if (removed) return;
  const st = await getState();
  if (!st.token || isPaused(st)) return;
  const cfg = settingsOf(st);
  if (!cfg.cookies.monitor) return;
  const backendHost = (hostOf(st.backendUrl) || "").split(":")[0];
  if (backendHost && cookie.domain.replace(/^\./, "") === backendHost) return;

  const info = R.classifyCookie(cookie, { topDomains: await getTopDomains(), now: Date.now() });
  const act = R.cookieAction(info, cfg);
  if (act.remove) await removeCookie(cookie);
  const key = info.domain + "|" + info.name;
  if (act.remove || Date.now() - (seenCookies.get(key) || 0) > 3600e3) {
    seenCookies.set(key, Date.now());
    if (seenCookies.size > 2000) seenCookies.clear();
    logEvent("cookie", { type: "cookie", domain: info.domain, name: info.name, third_party: info.thirdParty,
      persistent: info.persistent, lifetime_days: info.lifetimeDays, purpose: info.purpose, confidence: info.confidence,
      action: act.remove ? "BLOCKED" : (act.rule === "ask" ? "ASK" : "ALLOWED"), rule: act.rule });
  }
});

// adult: removes every cookie that looks like a tracker. Sign-in and preference cookies are left alone.
async function clearTrackingCookies() {
  const ctx = { topDomains: await getTopDomains(), now: Date.now() };
  let removed = 0;
  for (const c of await chrome.cookies.getAll({})) {
    if (R.classifyCookie(c, ctx).tracker && await removeCookie(c)) removed++;
  }
  if (removed) logEvent("cookie", { type: "cleanup", removed });
  return { removed };
}

// Remove every cookie of one site (the popup's 'clear this site' button).
async function clearSiteCookies(url) {
  const domain = normalizeDomain(url);
  if (!domain) return { removed: 0 };
  const reg = R.registrableDomain(domain);
  let removed = 0;
  for (const c of await chrome.cookies.getAll({})) {
    if (R.registrableDomain(c.domain) === reg && await removeCookie(c)) removed++;
  }
  return { removed };
}

// adult: closing a tab is a natural moment to sweep trackers (alarms can't fire sooner than ~30 s).
chrome.tabs.onRemoved.addListener(async () => {
  const st = await getState();
  if (isAdult(st)) chrome.alarms.create("clearTrackers", { delayInMinutes: 0.5 });
});

// What Praise Shield did on the page the person is looking at.
async function pageReport(tabId, url) {
  const domain = normalizeDomain(url || "");
  const out = { domain, blocked: { trackers: 0, fingerprint: 0, links: 0 }, site: { total: 0, tracking: 0 }, trackingInBrowser: 0 };
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    for (const m of rulesMatchedInfo) {
      const id = m.rule.rulesetId;
      if (id === "trackers") out.blocked.trackers++;
      else if (id === "fingerprint") out.blocked.fingerprint++;
      else if (id === "_dynamic") out.blocked.links++;
    }
  } catch (e) { /* counts are rate-limited by Chrome: leave them at zero */ }

  const ctx = { topDomains: await getTopDomains(), now: Date.now() };
  const reg = domain ? R.registrableDomain(domain) : null;
  for (const c of await chrome.cookies.getAll({})) {
    const info = R.classifyCookie(c, ctx);
    if (info.tracker) out.trackingInBrowser++;
    if (reg && R.registrableDomain(c.domain) === reg) { out.site.total++; if (info.tracker) out.site.tracking++; }
  }
  return out;
}

// ---- adult: sensitive-data guard (answers the content script) ---------------------------------------------------
// Plain-language reasons shown by the sensitive-data guard, keyed by category.
const RISK_WORDS = {
  scam: "This site looks like a scam.",
  phishing: "This site may be pretending to be another site to steal your details.",
  financial_phishing: "This looks like a fake bank or payment page.",
  malware: "This site is known to spread harmful software.",
  suspicious_domain: "Something about this address looks off.",
  dangerous_download: "This site pushes dangerous downloads.",
};

// The content script asks about the page it is on. We use the sender's own address, never a value
// the page could have supplied, and answer from the same cached verdict used for navigation.
async function guardStatus(url) {
  const st = await getState();
  const cfg = settingsOf(st);
  const off = { settings: { warn: false }, passwords: { breach_check: false, reuse_check: false } };
  if (!isAdult(st) || isPaused(st)) return off;
  const domain = normalizeDomain(url || "");
  if (!domain || hostOf(url) === hostOf(st.backendUrl)) return off;
  // Password checks don't depend on the warning setting; with it off we skip the site check only.
  if (!cfg.sensitive_data.warn) return { settings: { warn: false }, passwords: cfg.passwords };

  const d = await resolve(url);
  const risky = d.action !== "ALLOW"
    ? { reason: RISK_WORDS[d.category] || (d.offline ? "This site was flagged earlier." : "Our check rated this site risky.") }
    : null;
  return { settings: cfg.sensitive_data, passwords: cfg.passwords, risky, suggest: d.suggest || null };
}

const GUARD_OUTCOMES = new Set(["shown", "cancelled", "sent_anyway", "breached", "reused"]);
const GUARD_KINDS = new Set(["card", "card_cvc", "id", "otp", "password"]);

// Record what the person chose in the guard dialog. Only the kind of data is stored (card, ID, code, password), never the value.
function guardEvent(url, outcome, kinds) {
  const domain = normalizeDomain(url || "");
  if (!domain || !GUARD_OUTCOMES.has(outcome)) return { ok: false };
  const clean = (Array.isArray(kinds) ? kinds : []).filter((k) => GUARD_KINDS.has(k)).slice(0, 5);   // kinds only, never values
  logEvent("security", { type: "sensitive_" + outcome, domain, kinds: clean });
  return { ok: true };
}

// ---- adult: password safety ---------------------------------------------------------------------------------
// Breach check: the page sends only the first five characters of a SHA-1 (see common/passwords.js);
// we relay that to the Pwned Passwords range API and hand the reply back. The password and its
// full hash never reach this worker. Nothing else about the person goes to that service.
const RANGE_URL = "https://api.pwnedpasswords.com/range/";
const RANGE_TTL_MS = 60 * 60 * 1000;
const rangeCache = new Map();

async function passwordSettings() {
  const st = await getState();
  return { st, cfg: settingsOf(st), on: isAdult(st) && !isPaused(st) };
}

// Relay the 5-character hash prefix to the breach service and return its list. Only the prefix leaves; the password itself never reaches this worker.
async function breachRange(prefix) {
  const { cfg, on } = await passwordSettings();
  if (!on || !cfg.passwords.breach_check) return { error: "off" };
  if (!PW.isPrefix(prefix)) return { error: "bad prefix" };
  const hit = rangeCache.get(prefix);
  if (hit && hit.exp > Date.now()) return { text: hit.text };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(RANGE_URL + prefix, {
      headers: { "Add-Padding": "true" }, credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal,
    });
    if (!res.ok) return { error: "unavailable" };
    const text = await res.text();
    if (text.length > 2_000_000) return { error: "unavailable" };
    if (rangeCache.size > 100) rangeCache.clear();
    rangeCache.set(prefix, { text, exp: Date.now() + RANGE_TTL_MS });
    return { text };
  } catch (e) { return { error: "unavailable" }; } finally { clearTimeout(timer); }
}

// Reuse check (opt-in): the page derives a slow, salted fingerprint of the password and sends only
// that. We remember which sites each fingerprint was seen on. Passwords are never stored or sent.
const PW_STORE_MAX = 500;

// Load the on-device store of password fingerprints (with its random salt), or make a new one.
async function loadPwStore() {
  const { pwStore } = await chrome.storage.local.get({ pwStore: null });
  if (pwStore && pwStore.salt) return pwStore;
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return { salt, hashes: {} };
}

async function reuseSalt() {
  const { cfg, on } = await passwordSettings();
  if (!on || !cfg.passwords.reuse_check) return { error: "off" };
  const store = await loadPwStore();
  await chrome.storage.local.set({ pwStore: store });
  return { salt: store.salt };
}

// Compare a password fingerprint with the ones seen on other sites. Returns only site names, and optionally remembers this one.
async function reuseCheck(url, hash, record) {
  const { cfg, on } = await passwordSettings();
  if (!on || !cfg.passwords.reuse_check) return { others: [] };
  const domain = normalizeDomain(url || "");
  if (!domain || !/^[0-9a-f]{64}$/.test(String(hash))) return { others: [] };
  const reg = R.registrableDomain(domain);
  const store = await loadPwStore();
  const entry = store.hashes[hash];
  const others = entry ? entry.domains.filter((d) => d !== reg) : [];
  if (record) {
    const e = store.hashes[hash] || { domains: [], at: 0 };
    if (!e.domains.includes(reg)) e.domains = e.domains.concat(reg).slice(-10);
    e.at = Date.now();
    store.hashes[hash] = e;
    const keys = Object.keys(store.hashes);
    if (keys.length > PW_STORE_MAX) keys.sort((a, b) => store.hashes[a].at - store.hashes[b].at).slice(0, keys.length - PW_STORE_MAX).forEach((k) => delete store.hashes[k]);
    await chrome.storage.local.set({ pwStore: store });
  }
  return { others: others.slice(0, 5) };
}

// Erase every stored fingerprint (popup button).
async function forgetPasswords() {
  await chrome.storage.local.remove("pwStore");
  return { ok: true };
}

// ---- the page buddy and the guard follow the pairing -----------------------------------------------------------
// Neither exists before a pairing code is accepted. The buddy is on from then until the person switches it off; the
// guard is registered only for a personal (adult) browser.
self.PraisePetControl.install(chrome);
self.PraiseGuardControl.install(chrome);

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create("sync", { periodInMinutes: SYNC_MINUTES }); applyProtection(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create("sync", { periodInMinutes: SYNC_MINUTES }); sync(); applyProtection(); });
// Timers: re-sync every 5 minutes, end a pause, and sweep tracking cookies after a tab closes.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "sync") { sync(); flushEvents(); }
  if (a.name === "unpause") { chrome.storage.local.set({ pausedUntil: 0 }).then(applyProtection); }
  if (a.name === "clearTrackers") {
    getState().then((st) => {
      if (isAdult(st) && !isPaused(st) && settingsOf(st).cookies.clear_on_close) clearTrackingCookies();
    });
  }
});

// ---- optional local-model wording for the buddy ------------------------------------------------------------
// Asks the server to reword one template line. The server only answers when its local model is on; after a few
// "no answer" replies we stop asking for ten minutes so a server without a model isn't pinged for every line.
let lineMisses = 0, lineQuietUntil = 0;
async function polishLine(who, kind, line) {
  if (Date.now() < lineQuietUntil) return { line: null };
  try {
    const r = await api("/api/ext/companion-line", { method: "POST", timeout: 3000,
      body: { who: who === "adult" ? "adult" : "family", kind: String(kind || "").slice(0, 20), line: String(line || "").slice(0, 200) } });
    const out = r.ok && r.data && typeof r.data.line === "string" ? r.data.line : null;
    if (out) lineMisses = 0;
    else if (++lineMisses >= 3) { lineMisses = 0; lineQuietUntil = Date.now() + 10 * 60 * 1000; }
    return { line: out };
  } catch (e) { return { line: null }; }
}

// ---- talking with the buddy -----------------------------------------------------------------------------------------
// The chat panel (on a page or in the popup) answers everyday questions itself and asks here only for the rest. The
// message goes to the paired server, whose optional local model may answer; a null reply means "use the buddy's own
// words". After a few empty replies in a row (no model on that server) we stop asking for five minutes.
// A parent can switch the chat off for a child's browser (settings.companion.chat); nothing is sent then.
let chatMisses = 0, chatQuietUntil = 0;
async function chatWith(msg) {
  const st = await getState();
  if (!st.token || st.revoked) return { reply: null };
  if (modeOf(st) === "family" && settingsOf(st).companion.chat === false) return { reply: null, off: true };
  const message = String(msg.message || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!message || Date.now() < chatQuietUntil) return { reply: null };
  const history = (Array.isArray(msg.history) ? msg.history : []).slice(-6)
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .map((t) => ({ role: t.role, content: t.content.slice(0, 300) }));
  try {
    const r = await api("/api/ext/chat", { method: "POST", timeout: 25000, body: { message, history } });
    if (r.ok && r.data && r.data.off) return { reply: null, off: true };
    const reply = r.ok && r.data && typeof r.data.reply === "string" ? r.data.reply : null;
    if (reply) chatMisses = 0;
    else if (r.ok && ++chatMisses >= 3) { chatMisses = 0; chatQuietUntil = Date.now() + 5 * 60 * 1000; }
    return { reply };
  } catch (e) { return { reply: null }; }
}

// ---- messages ---------------------------------------------------------------------------------------------------
// Content scripts run inside web pages, so they may only send the few messages they need (and only the guard sends
// them). Everything that changes protection or touches stored data (pair, pause, clear cookies, forget passwords...)
// must come from one of our own pages (popup, block page, warning page). Defence in depth: a page can't reach these.
const CONTENT_MESSAGES = new Set(["guard", "guardEvent", "breachRange", "reuseSalt", "reuseCheck", "chat"]);
// What each kind of browser may ask for. Anything outside its own set is refused, so a child's browser can never be
// told to pause itself, and a personal browser has no door page to ask a parent through.
const FAMILY_ONLY = new Set(["resolve", "recheck", "access_request"]);
const ADULT_ONLY = new Set(["guard", "guardEvent", "breachRange", "reuseSalt", "reuseCheck", "forgetPasswords", "pause",
  "report", "clearSite", "clearTrackers", "warning", "continue"]);

// The one message door. Requests are accepted only from this extension; pages that run inside websites may only send the few messages the guard and chat need; each mode may only use its own set.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const type = msg && msg.type;
  const fromOurPage = typeof sender.url === "string" && sender.url.startsWith(EXTENSION_ORIGIN);
  if (!fromOurPage && !CONTENT_MESSAGES.has(type)) return false;
  (async () => {
    const st = await getState();
    const mode = modeOf(st);
    if ((ADULT_ONLY.has(type) && mode !== "adult") || (FAMILY_ONLY.has(type) && mode !== "family")) return { error: "off" };
    switch (type) {
      case "resolve": return resolve(String(msg.url || ""));
      case "recheck": return recheck(String(msg.url || ""));
      case "access_request": return requestAccess(String(msg.domain || "").slice(0, 255));
      case "guard": return guardStatus(sender.url);
      case "breachRange": return breachRange(String(msg.prefix || ""));
      case "reuseSalt": return reuseSalt();
      case "reuseCheck": return reuseCheck(sender.url, msg.hash, !!msg.record);
      case "forgetPasswords": return forgetPasswords();
      case "guardEvent": return guardEvent(sender.url, msg.outcome, msg.kinds);
      case "companion_line": return polishLine(msg.who, msg.kind, msg.line);
      case "chat": return chatWith(msg);
      case "pair": return pair(String(msg.code || "").trim(), msg.backendUrl);
      case "disconnect": return disconnect(msg.code);
      case "sync": await sync(); return { ok: true };
      case "pause": return setPause(msg.minutes);
      case "report": return pageReport(Number(msg.tabId), String(msg.url || ""));
      case "clearSite": return clearSiteCookies(String(msg.url || ""));
      case "clearTrackers": return clearTrackingCookies();
      case "warning": return getWarning(msg.n).then((w) => (w ? { decision: w.decision, url: w.url } : null));
      case "continue": return continueAnyway(msg.n);
      // What the popup shows: pairing state, profile name, last sync and, for adults, pause time and password-check settings.
      case "status": {
        const out = { paired: !!st.token, mode, profile: st.profileName, revoked: st.revoked, lastSync: st.lastSync,
                      backendUrl: st.backendUrl, devBuild: DEV_BUILD, chat: mode === "adult" || settingsOf(st).companion.chat !== false };
        if (mode === "adult") {
          const cfg = settingsOf(st);
          const { pwStore } = await chrome.storage.local.get({ pwStore: null });
          Object.assign(out, { pausedUntil: st.pausedUntil, breachCheck: cfg.passwords.breach_check,
                               reuseCheck: cfg.passwords.reuse_check, reuseCount: pwStore ? Object.keys(pwStore.hashes).length : 0 });
        }
        return out;
      }
      default: return { error: "unknown message" };
    }
  })().then(sendResponse);
  return true;   // async response
});
