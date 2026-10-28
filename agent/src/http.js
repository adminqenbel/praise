// The HTTP surface. Order of checks on every request (cheapest and most hostile-facing first):
//   Host header (DNS rebinding) -> Origin (cross-origin browser pages) -> bearer token (timing-safe) -> rate limits
//   -> method/route -> Content-Type and body size -> strict validation -> handler.
// Bound to 127.0.0.1 only. Responses are fixed-shape JSON; errors never carry stack traces, messages or request data.
"use strict";

const http = require("node:http");
const { secretsEqual, digestOf } = require("./secrets");
const { TokenBucket } = require("./ratelimit");
const { silent } = require("./log");

const BUCKET = Symbol("praise.bucket");

class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}

const bad = (detail) => new HttpError(400, "invalid_request", detail);

// ---- strict input validation -----------------------------------------------------------------------
const MAX_URL = 2048;

function expectObject(body, allowed, label = "body") {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad(`${label} must be a JSON object`);
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad(`unknown field: ${k.slice(0, 40)}`);
}

function checkUrl(u, label = "url") {
  if (typeof u !== "string" || u.length === 0 || u.length > MAX_URL) throw bad(`${label} must be a string of 1..${MAX_URL} characters`);
  // Control characters have no business in a URL and are a classic smuggling aid.
  if (/[\u0000-\u001f\u007f]/.test(u)) throw bad(`${label} contains control characters`);
  return u;
}

function strField(o, k, max) {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > max) throw bad(`signals.${k} must be a string up to ${max} characters`);
  return v;
}
function intField(o, k, max) {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 0 || v > max) throw bad(`signals.${k} must be an integer 0..${max}`);
  return v;
}
function listField(o, k, maxItems, maxLen) {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > maxItems || v.some((s) => typeof s !== "string" || s.length > maxLen)) throw bad(`signals.${k} must be an array of up to ${maxItems} short strings`);
  return v;
}

const SIGNAL_KEYS = ["title", "description", "text", "has_password_field", "form_count", "form_actions", "external_script_hosts", "hidden_iframes", "inline_script_entropy"];

// Rebuilds signals field by field (fixed key order), so nothing unvalidated reaches the detector and cache keys are stable.
function cleanSignals(s) {
  if (s === undefined || s === null) return undefined;
  expectObject(s, SIGNAL_KEYS, "signals");
  const out = {};
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  put("title", strField(s, "title", 300));
  put("description", strField(s, "description", 600));
  put("text", strField(s, "text", 4000));
  if (s.has_password_field !== undefined) { if (typeof s.has_password_field !== "boolean") throw bad("signals.has_password_field must be a boolean"); out.has_password_field = s.has_password_field; }
  put("form_count", intField(s, "form_count", 1000));
  put("form_actions", listField(s, "form_actions", 50, MAX_URL));
  put("external_script_hosts", listField(s, "external_script_hosts", 100, 255));
  put("hidden_iframes", intField(s, "hidden_iframes", 1000));
  if (s.inline_script_entropy !== undefined) {
    if (typeof s.inline_script_entropy !== "number" || !(s.inline_script_entropy >= 0 && s.inline_script_entropy <= 16)) throw bad("signals.inline_script_entropy must be a number 0..16");
    out.inline_script_entropy = s.inline_script_entropy;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseUrlBody(b) {
  expectObject(b, ["url", "signals"]);
  return { url: checkUrl(b.url), signals: cleanSignals(b.signals) };
}

function parseBatchBody(b, max) {
  expectObject(b, ["urls"]);
  if (!Array.isArray(b.urls) || b.urls.length === 0 || b.urls.length > max) throw bad(`urls must be an array of 1..${max} URLs`);
  return { urls: b.urls.map((u, i) => checkUrl(u, `urls[${i}]`)) };
}

function parseEventsBody(b, max) {
  expectObject(b, ["events"]);
  if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > max) throw bad(`events must be an array of 1..${max} items`);
  return { events: b.events };
}

// ---- server ----------------------------------------------------------------------------------------
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function errorBody(code, detail) {
  return detail ? JSON.stringify({ error: code, detail }) : JSON.stringify({ error: code });
}

function createHttpServer(deps) {
  const { engine, sync, events, token, config, log = silent, now = Date.now, info } = deps;
  const L = config.limits;
  const tokenDigest = digestOf(token);
  const allowedOrigins = new Set(config.allowed_origins);
  const globalBucket = new TokenBucket(L.global_rps, L.global_burst, now());
  const authFailBucket = new TokenBucket(L.authfail_rps, L.authfail_burst, now());
  let allowedHosts = new Set();
  let inflight = 0;
  let closing = false;

  const server = http.createServer({ maxHeaderSize: 8192, keepAlive: true, requestTimeout: L.request_timeout_ms, headersTimeout: L.headers_timeout_ms,
                                     keepAliveTimeout: L.keepalive_timeout_ms }, handle);
  server.maxConnections = L.max_connections;
  server.maxHeadersCount = 40;
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });

  function send(res, status, body, extra) {
    if (res.headersSent || res.writableEnded) return;
    const headers = Object.assign({ "Content-Length": Buffer.byteLength(body) }, JSON_HEADERS, extra);
    res.writeHead(status, headers);
    res.end(body);
  }
  const fail = (res, status, code, extra) => send(res, status, errorBody(code), extra);

  // Response headers for an allowed cross-origin caller. Only reached for an explicitly configured chrome-extension:// origin.
  function corsHeaders(origin) {
    return origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
  }

  const routes = {
    "GET /v1/health": { body: false, run: () => ({ status: 200, body: JSON.stringify(info()) }) },
    "POST /v1/score": { body: true, parse: parseUrlBody, run: (p) => engine.score(p.url, p.signals) },
    "POST /v1/decide": { body: true, parse: parseUrlBody, run: (p) => engine.decide(p.url, p.signals) },
    "POST /v1/score-batch": { body: true, parse: (b) => parseBatchBody(b, L.max_batch), run: (p) => engine.scoreBatch(p.urls) },
    "POST /v1/sync": { body: "optional", parse: (b) => { expectObject(b || {}, []); return {}; }, run: () => runSync() },
    "POST /v1/events": { body: true, parse: (b) => parseEventsBody(b, 100), run: (p) => runEvents(p) },
  };
  const knownPaths = new Set(Object.keys(routes).map((k) => k.split(" ")[1]));

  function runSync() {
    return sync.pullNow({ minGapMs: config.sync.manual_min_gap_ms }).then((r) => {
      if (r.ok) return { status: 200, body: JSON.stringify({ ok: true, policy_version: r.policy_version, changed: !!r.changed }) };
      if (r.error === "not_configured") return { status: 409, body: JSON.stringify({ ok: false, error: "not_configured", policy_version: sync.state.version }) };
      if (r.error === "revoked") return { status: 502, body: JSON.stringify({ ok: false, error: "revoked", policy_version: sync.state.version }) };
      return { status: 502, body: JSON.stringify({ ok: false, error: r.error || "sync_failed", policy_version: sync.state.version }) };
    });
  }

  function runEvents(p) {
    if (!events || !events.enabled()) return { status: 409, body: errorBody("events_disabled") };
    const r = events.add(p.events);
    return { status: 202, body: JSON.stringify({ accepted: r.accepted, rejected: r.rejected }) };
  }

  function handle(req, res) {
    if (closing) { res.setHeader("Connection", "close"); }
    const t = now();
    const headers = req.headers;

    // 1. Host: a rebinding page reaches us under its own hostname; refuse anything that is not exactly our loopback address.
    const host = headers.host;
    if (!host || !allowedHosts.has(host.toLowerCase())) return fail(res, 403, "forbidden_host");

    // 2. Origin: browsers always send it on cross-origin requests. Only a configured extension origin gets through (and CORS headers).
    const origin = headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) return fail(res, 403, "forbidden_origin");
    if (origin === undefined && headers["sec-fetch-site"] === "cross-site") return fail(res, 403, "forbidden_origin");
    const cors = origin !== undefined ? corsHeaders(origin) : undefined;

    // Preflight from an allowed origin: no credentials involved, so it is answered before auth.
    if (req.method === "OPTIONS") {
      if (origin === undefined) return fail(res, 405, "method_not_allowed");
      return send(res, 204, "", Object.assign({ "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "authorization, content-type",
                                                 "Access-Control-Max-Age": "600" }, cors));
    }

    // 3. Bearer token, constant-time. Failures draw from a small separate budget so a flood of guesses cannot drain the real one.
    const auth = headers.authorization;
    const presented = auth && auth.length > 7 && auth.charCodeAt(6) === 32 && auth.slice(0, 6).toLowerCase() === "bearer" ? auth.slice(7).trim() : "";
    if (!secretsEqual(presented, tokenDigest)) {
      if (!authFailBucket.take(t)) return fail(res, 429, "rate_limited", Object.assign({ "Retry-After": String(authFailBucket.retryAfter()) }, cors));
      return fail(res, 401, "unauthorized", Object.assign({ "WWW-Authenticate": "Bearer" }, cors));
    }

    // 4. Rate limits (per connection, then global). Authenticated callers only.
    const sock = req.socket;
    const bucket = sock[BUCKET] || (sock[BUCKET] = new TokenBucket(L.conn_rps, L.conn_burst, t));
    if (!bucket.take(t) || !globalBucket.take(t)) return fail(res, 429, "rate_limited", Object.assign({ "Retry-After": "1" }, cors));

    // 5. Route.
    const url = req.url;
    const route = routes[req.method + " " + url];
    if (!route) {
      if (knownPaths.has(url)) return fail(res, 405, "method_not_allowed", Object.assign({ Allow: url === "/v1/health" ? "GET" : "POST" }, cors));
      return fail(res, 404, "not_found", cors);
    }

    if (!route.body) return finish(route, undefined, res, cors);

    // 6. Body: JSON only, size-capped before and while reading.
    const ct = headers["content-type"];
    const declared = headers["content-length"];
    const hasBody = declared !== undefined ? declared !== "0" : headers["transfer-encoding"] !== undefined;
    if (!hasBody) {
      if (route.body === "optional") return finish(route, undefined, res, cors);
      return fail(res, 400, "invalid_request", cors);
    }
    if (!ct || !/^application\/json\s*(;|$)/i.test(ct)) return fail(res, 415, "unsupported_media_type", cors);
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > L.max_body_bytes)) return tooLarge(res, req, cors);

    let size = 0, done = false;
    const chunks = [];
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > L.max_body_bytes) { done = true; chunks.length = 0; tooLarge(res, req, cors); return; }
      chunks.push(c);
    });
    req.on("error", () => { done = true; });
    req.on("end", () => {
      if (done) return;
      done = true;
      let parsed;
      try { parsed = JSON.parse(chunks.length === 1 ? chunks[0].toString("utf8") : Buffer.concat(chunks).toString("utf8")); } catch (e) {
        return fail(res, 400, "invalid_json", cors);
      }
      finish(route, parsed, res, cors);
    });
  }

  function tooLarge(res, req, cors) {
    send(res, 413, errorBody("payload_too_large"), Object.assign({ Connection: "close" }, cors));
    res.on("finish", () => req.socket.destroy());
  }

  function finish(route, parsed, res, cors) {
    let out;
    inflight++;
    try {
      const p = route.parse ? route.parse(parsed) : undefined;
      out = route.run(p);
    } catch (e) {
      inflight--;
      return sendError(res, e, cors);
    }
    if (out && typeof out.then === "function") {
      out.then((r) => { inflight--; send(res, r.status, r.body, cors); }, (e) => { inflight--; sendError(res, e, cors); });
    } else { inflight--; send(res, out.status, out.body, cors); }
  }

  function sendError(res, e, cors) {
    if (e instanceof HttpError) return send(res, e.status, errorBody(e.code, e.detail), cors);
    log.error("handler error", { name: e && e.name });   // name only: messages can contain URLs
    send(res, 500, errorBody("internal"), cors);
  }

  return {
    server,
    get inflight() { return inflight; },
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          const actual = server.address().port;
          allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
          resolve(actual);
        });
      });
    },
    // Stop accepting, let in-flight requests finish (up to graceMs), then close whatever is left.
    close(graceMs = L.shutdown_grace_ms) {
      closing = true;
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        const t = setTimeout(() => { server.closeAllConnections(); }, graceMs);
        if (t.unref) t.unref();
        server.once("close", () => clearTimeout(t));
        // Keep-alive sockets that go idle after the first sweep.
        const sweep = setInterval(() => server.closeIdleConnections(), 50);
        if (sweep.unref) sweep.unref();
        server.once("close", () => clearInterval(sweep));
      });
    },
  };
}

module.exports = { createHttpServer, HttpError, cleanSignals, parseUrlBody };
