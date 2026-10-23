"use strict";

// Thin fetch wrapper: session cookie + CSRF header, JSON in/out, readable errors, and a read cache so moving between
// pages doesn't wait on the network for data that was just fetched.
const Api = (() => {
  // Where the backend lives: the local dev server when the dashboard itself is served locally, otherwise the
  // production API. Each page's CSP connect-src lists exactly these two.
  const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
  const base = LOCAL_HOSTS.includes(location.hostname) ? "http://localhost:5000" : "https://api.praise.qenbel.site";
  // The CSRF token comes back from login/me and is sent on every change (POST, PUT, PATCH, DELETE).
  let csrf = null;
  // The space (family or adult) this tab shows. Every call names it, so a tab, or a prefetch for the other space, reads
  // the space it means no matter what the account last saved.
  let space = null;

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // One place for every call: sends the login cookie, turns failures into readable messages, and remembers a fresh CSRF token.
  // `timeout` (ms) gives up on a request that never answers; that reads as "no answer" (status 0).
  // A read carries no custom header, so the browser sends it at once instead of asking permission first (a second round trip).
  async function request(method, path, body, timeout) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (csrf && method !== "GET") headers["X-CSRF-Token"] = csrf;
    const stop = timeout ? new AbortController() : null;
    const timer = stop && setTimeout(() => stop.abort(), timeout);
    let res;
    try {
      res = await fetch(base + path, {
        method, headers, credentials: "include", signal: stop && stop.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, "Can't reach the server. Check your connection and try again in a minute.");
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
    if (data && data.csrf) csrf = data.csrf;
    return data;
  }

  // The API runs on a plan that sleeps when nobody has used it for a while and takes up to a minute to wake. While it
  // starts, a request gets no answer at all, or the host's own 502/503/504 (our API never sends those).
  const ASLEEP = (e) => e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;

  // A GET that waits for the server to wake instead of failing: it tries again every few seconds until the server
  // answers, or `giveUp` ms have passed. Any real answer (even 401 or 500) ends the wait. `onWait(ms)` hears each miss.
  // Only for reads: repeating a write that may have gone through could do it twice.
  async function patient(path, { onWait, giveUp = 120000, every = 2500, attempt = 15000,
                                 now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const started = now();
    for (;;) {
      try { return await request("GET", path, undefined, attempt); }
      catch (e) {
        if (!ASLEEP(e) || now() - started >= giveUp) throw e;
        if (onWait) onWait(now() - started);
        await sleep(every);
      }
    }
  }

  // Wake the server ahead of time: the landing pages call this so it is already up when a visitor reaches sign-up.
  // No cookies, no reading the answer, no complaint if it fails.
  function warm() {
    try { fetch(base + "/health", { mode: "no-cors", cache: "no-store", credentials: "omit" }).catch(() => {}); } catch (e) { /* ignore */ }
  }

  // ---- read cache ------------------------------------------------------------------------------------
  // A read younger than FRESH comes straight from memory. One younger than STALE is shown at once and checked again in
  // the background; if the answer differs, `onChange` listeners hear about it (the page redraws itself). Every change
  // (POST, PUT, PATCH, DELETE) empties the cache, so what you just did is never hidden by an old copy.
  const FRESH = 15000, STALE = 10 * 60 * 1000;
  const STORE = "praise.cache", ME = "praise.me";
  const KEEP = 1500000;                         // most characters of cached data kept for a reload of the tab
  const cache = new Map();                      // key -> { at, json }   (json: the answer as text, so each caller gets its own copy)
  const flying = new Map();                     // key -> Promise of the answer text: one request per key at a time
  const listeners = new Set();
  let generation = 0;                           // bumped by every change; an answer asked for before it is not stored
  let saveTimer = 0;
  let clock = Date.now;

  const store = (fn) => { try { return fn(window.sessionStorage); } catch (e) { return undefined; } };

  const keyOf = (path, forSpace) => (forSpace || "") + " " + path;
  const withSpace = (path, forSpace) => {
    const s = forSpace === undefined ? space : forSpace;
    if (!s || !path.startsWith("/api/") || path.startsWith("/api/auth/")) return path;
    return path + (path.includes("?") ? "&" : "?") + "space=" + s;
  };

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      let used = 0;
      const out = {};
      for (const [k, v] of [...cache.entries()].sort((a, b) => b[1].at - a[1].at)) {
        if ((used += v.json.length) > KEEP) break;
        out[k] = v;
      }
      store((s) => s.setItem(STORE, JSON.stringify(out)));
    }, 400);
  }

  // Bring back what an earlier page of this tab fetched, so a reload paints from the copy first.
  function restore() {
    const saved = store((s) => JSON.parse(s.getItem(STORE) || "null"));
    if (!saved || typeof saved !== "object") return;
    for (const [k, v] of Object.entries(saved)) if (v && typeof v.json === "string" && typeof v.at === "number" && !cache.has(k)) cache.set(k, v);
  }

  // Forget every cached read (after a change, a sign-out or a different account).
  function clear() {
    generation++;
    cache.clear(); flying.clear();
    clearTimeout(saveTimer);
    store((s) => s.removeItem(STORE));
  }

  // Fetch one read into the cache; shared by everyone asking for the same thing at the same time.
  function load(key, path) {
    if (flying.has(key)) return flying.get(key);
    const started = generation;
    const p = request("GET", path).then((data) => {
      const json = JSON.stringify(data);
      const old = cache.get(key);
      if (started === generation) { cache.set(key, { at: clock(), json }); persist(); }
      return { json, changed: !!old && old.json !== json };
    }).finally(() => flying.delete(key));
    flying.set(key, p);
    return p;
  }

  // GET with the cache. `space` overrides the tab's space (used to prefetch the other one); `fresh: true` skips the cache.
  async function get(path, { space: forSpace, fresh } = {}) {
    const key = keyOf(path, forSpace === undefined ? space : forSpace), url = withSpace(path, forSpace);
    const hit = cache.get(key), age = hit ? clock() - hit.at : Infinity;
    if (hit && !fresh && age < FRESH) return JSON.parse(hit.json);
    if (hit && !fresh && age < STALE) {
      load(key, url).then((r) => { if (r.changed) listeners.forEach((fn) => { try { fn(path); } catch (e) { /* a listener must not stop the others */ } }); }, () => {});
      return JSON.parse(hit.json);
    }
    return JSON.parse((await load(key, url)).json);
  }

  // Quietly fetch reads that a page will want next. Never throws, never more than three at once.
  function prefetch(paths, { space: forSpace } = {}) {
    const queue = paths.filter((p) => {
      const hit = cache.get(keyOf(p, forSpace === undefined ? space : forSpace));
      return !hit || clock() - hit.at >= FRESH;
    });
    const worker = async () => { for (let p; (p = queue.shift());) { try { await get(p, { space: forSpace, fresh: true }); } catch (e) { /* the page asks again when it needs it */ } } };
    return Promise.all([worker(), worker(), worker()]);
  }

  // A change went through: old copies of the reads can't be trusted any more.
  async function change(method, path, body) {
    const out = await request(method, withSpace(path), body);
    if (!/^\/api\/auth\/(chat|space)\b/.test(path)) clear();
    if (/^\/api\/auth\/(login|register|logout)\b/.test(path)) store((s) => s.removeItem(ME));   // a different account may be signing in
    return out;
  }

  // ---- who is signed in (kept for the tab, so a reload paints the page at once) -------------------------------
  const savedMe = () => store((s) => JSON.parse(s.getItem(ME) || "null")) || null;
  function saveMe(me) { store((s) => s.setItem(ME, JSON.stringify(me))); }
  // Take a saved answer as the current one: its CSRF token and space apply from now on, and its cached reads come back.
  function useMe(me) {
    if (me && me.csrf) csrf = me.csrf;
    if (me && me.user) space = me.user.account_type;
    restore();
  }
  // Ask the server who is signed in. Remembers the answer for the tab (and the space it names).
  async function whoAmI(options) {
    const me = await patient("/api/auth/me", options);
    saveMe(me);
    if (me && me.user) space = me.user.account_type;
    return me;
  }
  // Sign out, or a different account signs in: nothing from the old one may be shown again.
  function reset() {
    clear(); csrf = null; space = null;
    store((s) => s.removeItem(ME));
  }

  return {
    ApiError,
    base,   // pages navigate here for Google sign-in (a full page visit, not a fetch)
    patient,
    warm,
    get,
    prefetch,
    post: (p, b) => change("POST", p, b === undefined ? {} : b),
    put: (p, b) => change("PUT", p, b),
    patch: (p, b) => change("PATCH", p, b),
    del: (p) => change("DELETE", p),
    clear,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setSpace(s) { space = s; },
    get space() { return space; },
    savedMe, saveMe, useMe, whoAmI, reset,
    // for tests
    _clock(fn) { clock = fn; },
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Api;
