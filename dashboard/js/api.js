"use strict";

// Thin fetch wrapper: session cookie + CSRF header, JSON in/out, readable errors.
const Api = (() => {
  // Where the backend lives. It can be overridden with localStorage 'praiseApi'; the default is the local server.
  const base = (() => {
    try { return localStorage.getItem("praiseApi") || "http://localhost:5000"; }
    catch (e) { return "http://localhost:5000"; }
  })();
  // The CSRF token comes back from login/me and is sent on every change (POST, PUT, PATCH, DELETE).
  let csrf = null;

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // One place for every call: sends the login cookie, turns failures into readable messages, and remembers a fresh CSRF token.
  async function request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (csrf && method !== "GET") headers["X-CSRF-Token"] = csrf;
    let res;
    try {
      res = await fetch(base + path, {
        method, headers, credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, "Can't reach the server. Check that the backend is running.");
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
    if (data && data.csrf) csrf = data.csrf;
    return data;
  }

  return {
    ApiError,
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b === undefined ? {} : b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    del: (p) => request("DELETE", p),
  };
})();
