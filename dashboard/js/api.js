"use strict";

// Thin fetch wrapper: session cookie + CSRF header, JSON in/out, readable errors.
const Api = (() => {
  // Where the backend lives: the local dev server when the dashboard itself is served locally, otherwise the
  // production API. Each page's CSP connect-src lists exactly these two.
  const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
  const base = LOCAL_HOSTS.includes(location.hostname) ? "http://localhost:5000" : "https://api.praise.qenbel.site";
  // The CSRF token comes back from login/me and is sent on every change (POST, PUT, PATCH, DELETE).
  let csrf = null;

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // One place for every call: sends the login cookie, turns failures into readable messages, and remembers a fresh CSRF token.
  // `timeout` (ms) gives up on a request that never answers; that reads as "no answer" (status 0).
  async function request(method, path, body, timeout) {
    const headers = { "Content-Type": "application/json" };
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

  return {
    ApiError,
    base,   // pages navigate here for Google sign-in (a full page visit, not a fetch)
    patient,
    warm,
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b === undefined ? {} : b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    del: (p) => request("DELETE", p),
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Api;
