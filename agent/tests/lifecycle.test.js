"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { startAgent, tmpDir, rmDir, raw, ADULT, sleep, fakeDetect } = require("./helpers");
const { runCli } = require("../src/cli");
const { resolveDirs, filesIn } = require("../src/paths");
const { sanitize, DEFAULTS, normalizeApiOrigin } = require("../src/config");
const secrets = require("../src/secrets");

test("graceful shutdown: the port is released, the runtime marker removed, the cache written", async () => {
  const a = await startAgent({ policy: ADULT, keepDir: true });
  const files = a.agent.files;
  try {
    await a.call("/v1/decide", { body: { url: "https://sus-site.com/" } });
    assert.ok(fs.existsSync(files.runtime));
    await a.agent.stop();
    assert.equal(fs.existsSync(files.runtime), false);
    assert.ok(fs.existsSync(files.cache));
    await assert.rejects(raw(a.port, { path: "/v1/health" }), /ECONNREFUSED|ECONNRESET/);
    await a.agent.stop();                       // idempotent
  } finally { rmDir(a.dir); }
});

test("graceful shutdown lets an in-flight request finish before closing", async () => {
  const a = await startAgent({ policy: ADULT, agent: { detectVerdict: async () => { await sleep(150); return { score: 0 }; }, detectVersion: 1 } });
  try {
    const pending = a.call("/v1/decide", { body: { url: "https://slow.example/" } });
    await sleep(40);
    const stopping = a.agent.stop();
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.json.action, "ALLOW");
    await stopping;
  } finally { rmDir(a.dir); }
});

test("shutdown does not hang on an idle keep-alive connection or a stalled client", async () => {
  const a = await startAgent({ config: { limits: { shutdown_grace_ms: 300 } } });
  const idle = net.connect(a.port, "127.0.0.1");
  await new Promise((r) => idle.once("connect", r));
  idle.write("POST /v1/decide HTTP/1.1\r\nHost: 127.0.0.1:" + a.port + "\r\nContent-Length: 100\r\n");   // never finishes the headers
  idle.on("error", () => {});
  const t0 = Date.now();
  await a.agent.stop();
  assert.ok(Date.now() - t0 < 3000);
  idle.destroy();
  rmDir(a.dir);
});

test("a second agent on the same port fails with EADDRINUSE instead of hopping", async () => {
  const a = await startAgent();
  try {
    const { createAgent } = require("../src/server");
    const { silent, lib } = require("./helpers");
    const dir2 = tmpDir();
    const b = createAgent({ dirs: { configDir: dir2, stateDir: path.join(dir2, "s") }, harden: false, port: a.port, sync: false, detect: fakeDetect(), lib, log: silent });
    await assert.rejects(b.start(), (e) => e.code === "EADDRINUSE");
    rmDir(dir2);
  } finally { await a.stop(); }
});

test("config paths per OS", () => {
  const w = resolveDirs({ APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u");
  assert.equal(w.configDir, "C:\\Users\\u\\AppData\\Roaming\\Praise\\agent");
  assert.equal(w.stateDir, "C:\\Users\\u\\AppData\\Local\\Praise\\agent");
  const m = resolveDirs({}, "darwin", "/Users/u");
  assert.equal(m.configDir, "/Users/u/Library/Application Support/Praise/agent");
  const l = resolveDirs({}, "linux", "/home/u");
  assert.equal(l.configDir, "/home/u/.config/praise-agent"); assert.equal(l.stateDir, "/home/u/.local/state/praise-agent");
  const x = resolveDirs({ XDG_CONFIG_HOME: "/x/cfg", XDG_STATE_HOME: "/x/st" }, "linux", "/home/u");
  assert.equal(x.configDir, "/x/cfg/praise-agent"); assert.equal(x.stateDir, "/x/st/praise-agent");
  assert.equal(resolveDirs({ PRAISE_AGENT_HOME: "/tmp/pa" }, "linux", "/home/u").configDir, path.resolve("/tmp/pa"));
});

test("config: defaults are safe, invalid values fall back, API origin must be https (or loopback http)", () => {
  const d = sanitize(null);
  assert.equal(d.api, "https://api.praise.qenbel.site");
  assert.deepEqual(d.allowed_origins, []);
  assert.equal(d.forward_events, false);
  assert.equal(d.limits.max_body_bytes, 65536);
  const s = sanitize({ port: "x", api: "http://evil.example", limits: { max_body_bytes: 1e12, max_batch: 5000 }, log_level: "trace", cache: { ttl_s: { ALLOW: -5 } } });
  assert.equal(s.port, DEFAULTS.port); assert.equal(s.api, DEFAULTS.api);
  assert.equal(s.limits.max_body_bytes, 1024 * 1024); assert.equal(s.limits.max_batch, 100);
  assert.equal(s.log_level, "info"); assert.equal(s.cache.ttl_s.ALLOW, 0);
  assert.equal(normalizeApiOrigin("http://localhost:5000/path"), "http://localhost:5000");
  assert.equal(normalizeApiOrigin("https://u:p@api.example.com"), null);
  assert.equal(normalizeApiOrigin("ftp://x.com"), null);
});

// ---- CLI ----
function cli(args, dir, extra = {}) {
  const out = [], err = [];
  return runCli(args, { dirs: { configDir: dir, stateDir: path.join(dir, "state") }, harden: false, stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...extra })
    .then((code) => ({ code, out: out.join(""), err: err.join("") }));
}

test("cli configure: stores the device token from a file, never prints it, writes config", async () => {
  const dir = tmpDir();
  try {
    const tokenFile = path.join(dir, "incoming.txt");
    const deviceToken = "pairing-token-" + "q".repeat(30);
    fs.writeFileSync(tokenFile, deviceToken + "\n");
    const r = await cli(["configure", "--api", "https://api.example.com/ignored/path", "--token-file", tokenFile, "--allow-origin", "chrome-extension://" + "c".repeat(32)], dir);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes(deviceToken) && !r.err.includes(deviceToken));
    assert.equal(fs.readFileSync(path.join(dir, "device-token"), "utf8").trim(), deviceToken);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(cfg.api, "https://api.example.com");
    assert.deepEqual(cfg.allowed_origins, ["chrome-extension://" + "c".repeat(32)]);
    assert.ok(!JSON.stringify(cfg).includes(deviceToken));
    const st = await cli(["status"], dir);
    assert.match(st.out, /paired\s+yes/);
    assert.ok(!st.out.includes(deviceToken));
  } finally { rmDir(dir); }
});

test("cli configure: token from stdin; a --token value on the command line is refused", async () => {
  const dir = tmpDir();
  try {
    const deviceToken = "stdin-token-" + "s".repeat(30);
    const ok = await cli(["configure", "--api", "https://api.example.com", "--token-stdin"], dir, { readStdin: () => deviceToken + "\r\n" });
    assert.equal(ok.code, 0, ok.err);
    assert.equal(secrets.readDeviceToken(path.join(dir, "device-token")), deviceToken);
    for (const argv of [["configure", "--token", "abc" + "x".repeat(30)], ["configure", "--token=abc" + "x".repeat(30)]]) {
      const bad = await cli(argv, dir);
      assert.equal(bad.code, 1); assert.match(bad.err, /not accepted on the command line/);
      assert.ok(!bad.err.includes("xxxx"));
    }
  } finally { rmDir(dir); }
});

test("cli configure: rejects plain-http remote APIs, bad origins, bad ports and malformed token files", async () => {
  const dir = tmpDir();
  try {
    const tf = path.join(dir, "t.txt");
    fs.writeFileSync(tf, "short");
    assert.equal((await cli(["configure", "--api", "http://api.example.com"], dir)).code, 1);
    assert.equal((await cli(["configure", "--allow-origin", "https://evil.example"], dir)).code, 1);
    assert.equal((await cli(["configure", "--port", "99999"], dir)).code, 1);
    assert.equal((await cli(["configure", "--api", "https://a.example.com", "--token-file", tf], dir)).code, 1);
    assert.equal((await cli(["configure", "--api", "http://localhost:5000"], dir)).code, 0);
    assert.equal((await cli(["bogus"], dir)).code, 2);
  } finally { rmDir(dir); }
});

test("cli token: prints a stable token; rotate-token replaces it; unpair removes the device token", async () => {
  const dir = tmpDir();
  try {
    const t1 = (await cli(["token"], dir)).out.trim();
    assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await cli(["token"], dir)).out.trim(), t1);
    assert.equal((await cli(["rotate-token"], dir)).code, 0);
    assert.notEqual((await cli(["token"], dir)).out.trim(), t1);
    secrets.writeDeviceToken(path.join(dir, "device-token"), "d".repeat(40), { harden: false });
    await cli(["unpair"], dir);
    assert.equal(fs.existsSync(path.join(dir, "device-token")), false);
  } finally { rmDir(dir); }
});

test("cli status reports a running agent without printing any token", async () => {
  const a = await startAgent({ policy: ADULT, keepDir: true });
  try {
    const r = await cli(["status"], a.dir);
    assert.match(r.out, /running\s+yes/);
    assert.match(r.out, /live policy/);
    assert.ok(!r.out.includes(a.token));
  } finally { await a.stop(); rmDir(a.dir); }
});

test("on Windows the secret files and directory are restricted to the current user", { skip: process.platform !== "win32" }, () => {
  const { execFileSync } = require("node:child_process");
  const dir = tmpDir();
  try {
    const dirs = { configDir: path.join(dir, "cfg"), stateDir: path.join(dir, "st") };
    const f = filesIn(dirs).agentToken;
    secrets.loadOrCreateAgentToken(f, { harden: true });
    const acl = execFileSync(path.join(process.env.SystemRoot, "System32", "icacls.exe"), [f], { encoding: "utf8" });
    assert.ok(!/Everyone|BUILTIN\\Users|Authenticated Users/i.test(acl), acl);
    assert.ok(acl.includes(process.env.USERNAME), acl);
  } finally { rmDir(dir); }
});
