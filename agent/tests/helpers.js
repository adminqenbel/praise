// Shared test helpers: temp dirs, a fake detector (so tests never depend on the real detection work), fixture snapshots,
// a raw HTTP client that can set any header, a fake Praise API, and an agent factory.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createAgent } = require("../src/server");
const policyLib = require("../src/policy");
const { silent } = require("../src/log");
const lib = require("../../common/lib.js");

function tmpDir(prefix = "praise-agent-test-") { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

// Deterministic detector: URL text decides the score. Counts calls so tests can prove caching and coalescing.
function fakeDetect(version = 7) {
  const calls = { url: 0, page: 0 };
  const verdict = (score, reasons = []) => ({ score, level: score >= 0.75 ? "high" : score >= 0.5 ? "medium" : score >= 0.25 ? "low" : "none", reasons, brand: null, official: null, features: { f: score } });
  return {
    version, calls,
    scoreUrl(url) {
      calls.url++;
      if (/phish/.test(url)) return verdict(0.9, ["looks like a login page for a known brand"]);
      if (/sus/.test(url)) return verdict(0.6, ["suspicious address"]);
      if (/meh/.test(url)) return verdict(0.3, ["slightly odd"]);
      return verdict(0);
    },
    scorePage(signals) {
      calls.page++;
      return signals && signals.has_password_field ? verdict(0.8, ["asks for a password"]) : verdict(0);
    },
    combine(vs) { return vs.reduce((a, b) => (b.score > a.score ? b : a)); },
  };
}

const FAMILY = {
  mode: "family", child: "Kid", category_actions: {},
  allow_domains: ["wikipedia.org", "school.edu"], block_domains: ["badsite.com"], exceptions: ["ok.badsite.com"],
  allowed_tlds: [], blocked_tlds: [".xyz", "zip"], unknown_action: "REVIEW", settings: {},
  verified: { allow: ["khanacademy.org"], allow_exact: ["exact.example.org"], warn: ["reddit.com"], warn_exact: [], block: ["gambling.com"], block_exact: ["only-this.net"] },
};
const ADULT = { ...FAMILY, mode: "adult", child: "Me", unknown_action: "ALLOW", settings: { safe_browsing: { warn_above_risk: 0 } } };

const norm = (raw) => policyLib.normalizeSnapshot(raw);

async function startAgent(over = {}) {
  const dir = over.dir || tmpDir();
  const detect = over.detect || fakeDetect();
  const agent = createAgent({
    dirs: { configDir: dir, stateDir: path.join(dir, "state") }, harden: false, port: 0, sync: false, liveConfig: false,
    detect, lib, log: silent, ...over.agent, config: over.config,
  });
  if (over.policy) agent.engine.setPolicy(norm(over.policy));
  await agent.start();
  const stop = async () => { await agent.stop(); if (!over.keepDir) rmDir(dir); };
  return { agent, detect, dir, stop, port: agent.port, token: agent.token, call: (p, o) => call(agent.port, agent.token, p, o) };
}

// Raw request. `headers` replaces defaults; pass setHost:false to omit the Host header entirely.
function raw(port, { method = "GET", path: p = "/", headers = {}, body, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined && h["Content-Length"] === undefined && h["Transfer-Encoding"] === undefined) h["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h, setHost, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Authenticated JSON call to the agent.
function call(port, token, p, { method = "POST", body, headers = {} } = {}) {
  const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return raw(port, {
    method, path: p, body: data,
    headers: { Authorization: "Bearer " + token, ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
  });
}

// A stand-in for the Praise API: serves /api/ext/policy-sync and /api/ext/events, records what it saw, and can be told to misbehave.
async function fakeApi(handler) {
  const seen = [];
  const state = { status: 200, body: FAMILY, etag: null, delay: 0, redirectTo: null, raw: null, ...handler };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec = { method: req.method, url: req.url, auth: req.headers.authorization, inm: req.headers["if-none-match"], body: Buffer.concat(chunks).toString("utf8"), at: Date.now() };
      seen.push(rec);
      const respond = () => {
        if (state.redirectTo) { res.writeHead(302, { Location: state.redirectTo }); return res.end(); }
        if (req.url === "/api/ext/events") { res.writeHead(state.eventsStatus || 200, { "Content-Type": "application/json" }); return res.end('{"accepted":1,"rejected":0}'); }
        if (state.etag && req.headers["if-none-match"] === state.etag) { res.writeHead(304); return res.end(); }
        const h = { "Content-Type": "application/json" };
        if (state.etag) h.ETag = state.etag;
        if (state.retryAfter) h["Retry-After"] = String(state.retryAfter);
        res.writeHead(state.status, h);
        res.end(state.raw !== null ? state.raw : JSON.stringify(state.body));
      };
      state.delay ? setTimeout(respond, state.delay) : respond();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, seen, state, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { tmpDir, rmDir, fakeDetect, FAMILY, ADULT, norm, startAgent, raw, call, fakeApi, sleep, lib, silent };
