"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { startAgent, raw, call, tmpDir, rmDir, FAMILY } = require("./helpers");
const secrets = require("../src/secrets");

const EXT = "chrome-extension://" + "a".repeat(32);

test("health requires a token: missing header is 401 and says nothing else", async () => {
  const a = await startAgent();
  try {
    const r = await raw(a.port, { path: "/v1/health", headers: {} });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: "unauthorized" });
    assert.equal(r.headers["www-authenticate"], "Bearer");
  } finally { await a.stop(); }
});

test("wrong token, wrong-length token, wrong scheme and empty bearer are all 401", async () => {
  const a = await startAgent();
  try {
    for (const auth of ["Bearer " + "x".repeat(43), "Bearer short", "Bearer ", "Basic " + a.token, a.token, "Bearer " + a.token + "x"]) {
      const r = await raw(a.port, { path: "/v1/health", headers: { Authorization: auth } });
      assert.equal(r.status, 401, auth.slice(0, 12));
    }
  } finally { await a.stop(); }
});

test("correct token is accepted and the response never echoes it", async () => {
  const a = await startAgent();
  try {
    const r = await call(a.port, a.token, "/v1/health", { method: "GET" });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(!r.text.includes(a.token));
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  } finally { await a.stop(); }
});

test("token comparison goes through crypto.timingSafeEqual on equal-length digests", () => {
  const real = crypto.timingSafeEqual;
  const lengths = [];
  crypto.timingSafeEqual = (x, y) => { lengths.push([x.length, y.length]); return real(x, y); };
  try {
    const d = secrets.digestOf("right-token");
    assert.equal(secrets.secretsEqual("right-token", d), true);
    assert.equal(secrets.secretsEqual("wrong-token-with-a-different-length", d), false);
    assert.equal(secrets.secretsEqual(undefined, d), false);
  } finally { crypto.timingSafeEqual = real; }
  assert.equal(lengths.length, 2);
  for (const [x, y] of lengths) assert.equal(x, y);    // a length mismatch would throw (and leak) instead
});

test("repeated bad tokens are throttled with 429 without draining the authenticated budget", async () => {
  const a = await startAgent({ config: { limits: { authfail_rps: 1, authfail_burst: 3 } } });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await raw(a.port, { path: "/v1/health", headers: { Authorization: "Bearer nope" } })).status);
    assert.deepEqual(codes.slice(0, 3), [401, 401, 401]);
    assert.ok(codes.slice(3).every((c) => c === 429));
    assert.equal((await a.call("/v1/health", { method: "GET" })).status, 200);
  } finally { await a.stop(); }
});

test("agent token: 43-char random base64url, stable across loads, owner-only on POSIX", () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, "agent-token");
    const t1 = secrets.loadOrCreateAgentToken(f, { harden: false });
    assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(secrets.loadOrCreateAgentToken(f, { harden: false }), t1);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(f).mode & 0o777, 0o600);
      fs.chmodSync(f, 0o644);
      secrets.loadOrCreateAgentToken(f, { harden: false });
      assert.equal(fs.statSync(f).mode & 0o077, 0);
    }
    assert.notEqual(secrets.rotateAgentToken(f, { harden: false }), t1);
  } finally { rmDir(dir); }
});

test("agent token and device token live in different files and the device token is never returned", async () => {
  const dir = tmpDir();
  const deviceToken = "device-token-" + "d".repeat(30);
  secrets.writeDeviceToken(path.join(dir, "device-token"), deviceToken, { harden: false });
  const a = await startAgent({ dir, keepDir: true });
  try {
    assert.notEqual(fs.readFileSync(path.join(dir, "agent-token"), "utf8").trim(), deviceToken);
    for (const r of [await a.call("/v1/health", { method: "GET" }), await a.call("/v1/decide", { body: { url: "https://example.com/" } })]) {
      assert.ok(!r.text.includes(deviceToken));
    }
    assert.equal((await a.call("/v1/health", { method: "GET" })).json.policy.paired, true);
  } finally { await a.stop(); rmDir(dir); }
});

test("device token format is validated (no spaces or control characters, bounded length)", () => {
  assert.equal(secrets.validDeviceToken("a".repeat(40)), true);
  for (const bad of ["short", "has space " + "a".repeat(30), "line\nbreak" + "a".repeat(30), "a".repeat(600), 123, null]) assert.equal(secrets.validDeviceToken(bad), false);
});

test("Host header other than loopback:port is refused (DNS rebinding)", async () => {
  const a = await startAgent();
  try {
    for (const host of ["evil.example", `evil.example:${a.port}`, `127.0.0.1.evil.example:${a.port}`, "127.0.0.1", `127.0.0.1:${a.port + 1}`, `[::1]:${a.port}`]) {
      const r = await call(a.port, a.token, "/v1/health", { method: "GET", headers: { Host: host } });
      assert.equal(r.status, 403, host);
      assert.deepEqual(r.json, { error: "forbidden_host" });
    }
    assert.equal((await call(a.port, a.token, "/v1/health", { method: "GET", headers: { Host: `localhost:${a.port}` } })).status, 200);
    assert.equal((await call(a.port, a.token, "/v1/health", { method: "GET", headers: { Host: `LOCALHOST:${a.port}` } })).status, 200);
  } finally { await a.stop(); }
});

test("a request with no Host header at all is refused", async () => {
  const a = await startAgent();
  try {
    const r = await raw(a.port, { path: "/v1/health", setHost: false, headers: { Authorization: "Bearer " + a.token } });
    assert.ok(r.status === 403 || r.status === 400);
  } finally { await a.stop(); }
});

test("cross-origin browser requests are refused unless the origin is configured", async () => {
  const a = await startAgent();
  try {
    for (const origin of ["https://evil.example", "http://127.0.0.1", "null", EXT, "chrome-extension://" + "b".repeat(32)]) {
      const r = await call(a.port, a.token, "/v1/health", { method: "GET", headers: { Origin: origin } });
      assert.equal(r.status, 403, origin);
      assert.deepEqual(r.json, { error: "forbidden_origin" });
      assert.equal(r.headers["access-control-allow-origin"], undefined);
    }
    const r = await call(a.port, a.token, "/v1/health", { method: "GET", headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(r.status, 403);
  } finally { await a.stop(); }
});

test("a configured chrome-extension origin works and gets CORS headers; preflight is answered", async () => {
  const a = await startAgent({ config: { allowed_origins: [EXT, "https://evil.example", "not-an-origin"] } });
  try {
    assert.deepEqual(a.agent.config.allowed_origins, [EXT]);        // only chrome-extension://<id> survives config validation
    const r = await call(a.port, a.token, "/v1/health", { method: "GET", headers: { Origin: EXT } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], EXT);
    const pre = await raw(a.port, { method: "OPTIONS", path: "/v1/decide", headers: { Origin: EXT, "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers["access-control-allow-headers"], /authorization/);
    const evil = await raw(a.port, { method: "OPTIONS", path: "/v1/decide", headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
  } finally { await a.stop(); }
});

test("the listener is bound to 127.0.0.1 only", async () => {
  const a = await startAgent();
  try {
    const addr = a.agent.httpd.server.address();
    assert.equal(addr.address, "127.0.0.1");
    assert.equal(addr.family, "IPv4");
  } finally { await a.stop(); }
});

test("body over 64 KB is rejected with 413, by Content-Length and by streaming", async () => {
  const a = await startAgent();
  try {
    const big = JSON.stringify({ url: "https://example.com/", signals: { text: "x".repeat(70000) } });
    const r = await a.call("/v1/decide", { body: big });
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { error: "payload_too_large" });
    // Chunked upload without Content-Length: must be cut off while streaming.
    const chunked = await raw(a.port, {
      method: "POST", path: "/v1/decide", body: big,
      headers: { Authorization: "Bearer " + a.token, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    }).catch((e) => ({ status: e.code }));
    assert.ok(chunked.status === 413 || chunked.status === "ECONNRESET" || chunked.status === "EPIPE");
    assert.equal((await a.call("/v1/health", { method: "GET" })).status, 200);   // server still healthy
  } finally { await a.stop(); }
});

test("only application/json is accepted for bodies", async () => {
  const a = await startAgent();
  try {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "text/json"]) {
      const r = await raw(a.port, { method: "POST", path: "/v1/decide", body: '{"url":"https://example.com/"}', headers: { Authorization: "Bearer " + a.token, "Content-Type": ct } });
      assert.equal(r.status, 415, ct);
    }
    const none = await raw(a.port, { method: "POST", path: "/v1/decide", body: '{"url":"https://example.com/"}', headers: { Authorization: "Bearer " + a.token } });
    assert.equal(none.status, 415);
    const ok = await raw(a.port, { method: "POST", path: "/v1/decide", body: '{"url":"https://example.com/"}', headers: { Authorization: "Bearer " + a.token, "Content-Type": "application/json; charset=utf-8" } });
    assert.equal(ok.status, 200);
  } finally { await a.stop(); }
});

test("strict validation: bad JSON, wrong types, unknown fields, oversize url, control characters", async () => {
  const a = await startAgent({ policy: FAMILY });
  try {
    const cases = [
      ["{not json", 400, "invalid_json"], ["[]", 400, "invalid_request"], ["null", 400, "invalid_request"], ["{}", 400, "invalid_request"],
      [{ url: 5 }, 400], [{ url: "" }, 400], [{ url: "https://a.com/" + "x".repeat(2100) }, 400], [{ url: "https://a.com/\u0000" }, 400],
      [{ url: "https://a.com/", extra: 1 }, 400], [{ url: "https://a.com/", signals: [] }, 400], [{ url: "https://a.com/", signals: { text: 5 } }, 400],
      [{ url: "https://a.com/", signals: { bogus: 1 } }, 400], [{ url: "https://a.com/", signals: { form_count: -1 } }, 400],
      [{ url: "https://a.com/", signals: { form_actions: new Array(51).fill("https://x.com/") } }, 400],
      [{ url: "https://a.com/", signals: { inline_script_entropy: 99 } }, 400],
    ];
    for (const [body, status, code] of cases) {
      const r = await a.call("/v1/decide", { body });
      assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
      if (code) assert.equal(r.json.error, code);
      assert.ok(!/at .*\.js/.test(r.text), "no stack traces");
    }
    const ok = await a.call("/v1/decide", { body: { url: "https://a.com/", signals: { title: "t", has_password_field: true, form_count: 2 } } });
    assert.equal(ok.status, 200);
  } finally { await a.stop(); }
});

test("an unparseable URL is a 400, an unknown route 404, a wrong method 405", async () => {
  const a = await startAgent({ policy: FAMILY });
  try {
    assert.equal((await a.call("/v1/decide", { body: { url: "not a url" } })).json.error, "invalid_url");
    assert.equal((await a.call("/v1/score", { body: { url: "::::" } })).status, 400);
    assert.equal((await a.call("/v1/nope", { method: "GET" })).status, 404);
    assert.equal((await a.call("/v1/decide", { method: "GET" })).status, 405);
    assert.equal((await a.call("/v1/health", { body: {} })).status, 405);
    assert.equal((await a.call("/v1/health?x=1", { method: "GET" })).status, 404);
  } finally { await a.stop(); }
});

test("internal errors return a fixed body: no stack, no message, no request data", async () => {
  const a = await startAgent({ policy: FAMILY });
  try {
    a.agent.engine.decide = () => { throw new Error("secret https://private.example/path leaked"); };
    const r = await a.call("/v1/decide", { body: { url: "https://private.example/path" } });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: "internal" });
    assert.ok(!r.text.includes("private"));
  } finally { await a.stop(); }
});

test("per-connection rate limit returns 429 with Retry-After", async () => {
  const a = await startAgent({ policy: FAMILY, config: { limits: { conn_rps: 1, conn_burst: 3, global_rps: 1000, global_burst: 1000 } } });
  try {
    const http = require("node:http");
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const hit = () => new Promise((res, rej) => {
      http.get({ host: "127.0.0.1", port: a.port, path: "/v1/health", agent, headers: { Authorization: "Bearer " + a.token } }, (r) => { r.resume(); r.on("end", () => res(r)); }).on("error", rej);
    });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await hit()).statusCode);
    agent.destroy();
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.ok(codes.slice(3).every((c) => c === 429), codes.join());
  } finally { await a.stop(); }
});

test("global rate limit applies across connections", async () => {
  const a = await startAgent({ config: { limits: { conn_rps: 1000, conn_burst: 1000, global_rps: 1, global_burst: 4 } } });
  try {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await a.call("/v1/health", { method: "GET" })).status);   // new connection each time
    assert.equal(codes.filter((c) => c === 200).length, 4, codes.join());
    assert.ok(codes.includes(429));
  } finally { await a.stop(); }
});

test("logs carry no URLs, page text or tokens (debug off), and domains only at debug level", async () => {
  const lines = [];
  const mk = (level) => require("../src/log").createLogger({ level, stream: { write: (s) => lines.push(s) } });
  const a = await startAgent({ policy: { ...FAMILY, mode: "adult", unknown_action: "ALLOW" }, agent: { log: mk("info") } });
  try {
    await a.call("/v1/decide", { body: { url: "https://secret-site.example/private/path?token=abc", signals: { text: "PAGE TEXT HERE" } } });
  } finally { await a.stop(); }
  const info = lines.join("");
  for (const needle of ["secret-site", "private", "PAGE TEXT", "abc", a.token]) assert.ok(!info.includes(needle), needle);

  lines.length = 0;
  const b = await startAgent({ policy: { ...FAMILY, mode: "adult", unknown_action: "ALLOW" }, agent: { log: mk("debug") } });
  try {
    await b.call("/v1/decide", { body: { url: "https://secret-site.example/private/path?token=abc", signals: { text: "PAGE TEXT HERE" } } });
  } finally { await b.stop(); }
  const dbg = lines.join("");
  assert.ok(dbg.includes("secret-site.example"));                // domain at debug level
  for (const needle of ["/private/path", "token=abc", "PAGE TEXT", b.token]) assert.ok(!dbg.includes(needle), needle);
});
