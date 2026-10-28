// Benchmark: starts the agent in a separate process on an ephemeral port (so server and load generator do not share an event loop),
// drives it with a minimal keep-alive HTTP/1.1 client over raw sockets (so the client adds as little time as possible), and
// prints req/s and p50/p95/p99 latency per scenario. Usage: node bench/bench.js [--n 20000] [--conns 16] [--json] [--shared]
// By default every scenario gets a fresh server process: on some machines (seen on a hybrid-core Windows laptop) a process that has just
// run a burst gets scheduled slower afterwards, which would make later rows meaningless. `--shared` reuses one server instead.
"use strict";

const { fork } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// ---------------- server processes ----------------
if (process.argv[2] === "--server") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praise-bench-"));
  if (process.argv[3] === "baseline") {          // the floor: Node's own http server answering a constant
    const http = require("node:http");
    const s = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "application/json", "Content-Length": 2 }); r.end("{}"); });
    s.listen(0, "127.0.0.1", () => process.send({ port: s.address().port, token: "x" }));
    process.on("message", () => process.exit(0));
    return;
  }
  const { createAgent } = require("../src/server");
  const { silent } = require("../src/log");
  const agent = createAgent({
    dirs: { configDir: dir, stateDir: path.join(dir, "state") }, harden: false, port: 0, sync: false, liveConfig: false, log: silent,
    config: { limits: { conn_rps: 1e6, conn_burst: 1e6, global_rps: 1e6, global_burst: 1e6 }, cache: { max_entries: 100000 } },
  });
  const { normalizeSnapshot } = require("../src/policy");
  agent.engine.setPolicy(normalizeSnapshot({
    mode: "adult", unknown_action: "ALLOW", block_domains: ["badsite.com"], allow_domains: ["wikipedia.org"], blocked_tlds: [".xyz"],
    verified: { allow: ["khanacademy.org"], warn: ["reddit.com"], block: ["gambling.com"], allow_exact: [], warn_exact: [], block_exact: [] },
  }));
  agent.start().then((port) => process.send({ port, token: agent.token, detect_version: agent.engine.detectVersion }));
  process.on("message", () => agent.stop().then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }));
  return;
}

// ---------------- load generator ----------------
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i === -1 ? def : Number(process.argv[i + 1]); };
const N = arg("n", 20000), CONNS = arg("conns", 16), WARMUP = 2000;

class Conn {
  constructor(port) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.setNoDelay(true);
    this.chunks = []; this.have = 0; this.need = -1; this.resolve = null; this.status = 0;
    this.sock.on("data", (c) => this.onData(c));
  }
  ready() { return new Promise((r) => this.sock.once("connect", r)); }
  onData(c) {
    this.chunks.push(c); this.have += c.length;
    if (this.need < 0) {
      const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) { this.chunks = [buf]; return; }
      const head = buf.toString("latin1", 0, end);
      this.status = Number(head.slice(9, 12));
      const m = /content-length: (\d+)/i.exec(head);
      this.need = end + 4 + (m ? Number(m[1]) : 0);
      this.chunks = [buf]; this.have = buf.length;
    }
    if (this.have < this.need) return;
    const r = this.resolve; this.need = -1; this.chunks = []; this.have = 0; this.resolve = null;
    r(this.status);       // closed loop: one request in flight per connection
  }
  send(bytes) { return new Promise((r) => { this.resolve = r; this.sock.write(bytes); }); }
  close() { this.sock.destroy(); }
}

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; }

async function measure(name, port, mkRequest, { conns, n }) {
  const cs = await Promise.all(Array.from({ length: conns }, async () => { const c = new Conn(port); await c.ready(); return c; }));
  const per = Math.ceil(n / conns);
  const lat = new Float64Array(per * conns);
  let idx = 0, bad = 0;
  const run = async (c, ci, count, record) => {
    for (let i = 0; i < count; i++) {
      const t0 = process.hrtime.bigint();
      const st = await c.send(mkRequest(ci * per + i));
      const dt = Number(process.hrtime.bigint() - t0) / 1000;      // microseconds
      if (st !== 200) bad++;
      if (record) lat[idx++] = dt;
    }
  };
  await Promise.all(cs.map((c, ci) => run(c, ci, Math.max(1, Math.min(Math.floor(WARMUP / conns), per)), false)));
  const t0 = process.hrtime.bigint();
  await Promise.all(cs.map((c, ci) => run(c, ci, per, true)));
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  cs.forEach((c) => c.close());
  const sorted = Array.from(lat.subarray(0, idx)).sort((a, b) => a - b);
  return { name, conns, requests: idx, bad, rps: Math.round(idx / secs), p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99), max: sorted[sorted.length - 1] };
}

const shared = process.argv.includes("--shared");
let sharedServer = null;

async function startServer(mode) {
  const child = fork(__filename, mode ? ["--server", mode] : ["--server"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const info = await new Promise((r) => child.once("message", r));
  return { child, ...info, stop: () => new Promise((r) => { child.once("exit", r); child.send("stop"); }) };
}

const POOL = 500;
const hitUrl = (i) => `https://site-${i}.example.com/path/${i}?q=1`;

// Each scenario: how to build requests, optional priming so "hit" rows really measure hits.
const SCENARIOS = [
  { name: "bare node http (reference)", server: "baseline", conns: 1, req: (post) => { const r = Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"); return () => r; } },
  { name: "score  hit,  1 conn", conns: 1, prime: (post) => Array.from({ length: POOL }, (_, i) => post("/v1/score", { url: hitUrl(i) })), req: (post, pool) => (i) => pool[i % POOL] },
  { name: "decide hit,  1 conn", conns: 1, prime: (post) => Array.from({ length: POOL }, (_, i) => post("/v1/decide", { url: hitUrl(i) })), req: (post, pool) => (i) => pool[i % POOL] },
  { name: "decide parent-rule, 1 conn", conns: 1, prime: (post) => Array.from({ length: POOL }, (_, i) => post("/v1/decide", { url: i % 2 ? `https://sub${i}.wikipedia.org/` : `https://x${i}.badsite.com/` })), req: (post, pool) => (i) => pool[i % POOL] },
  { name: "decide MISS (unique URL), 1 conn", conns: 1, n: Math.min(N, 10000), req: (post) => { let u = 0; return () => post("/v1/decide", { url: `https://unique-${u++}.example.org/a/b?c=d` }); } },
  { name: "score  MISS (unique URL), 1 conn", conns: 1, n: Math.min(N, 10000), req: (post) => { let u = 0; return () => post("/v1/score", { url: `https://unique-${u++}.example.org/a/b?c=d` }); } },
  { name: "score-batch 100 URLs (hits), 1 conn", conns: 1, n: Math.min(N, 5000), batch: true, prime: (post) => [post("/v1/score-batch", { urls: Array.from({ length: 100 }, (_, i) => hitUrl(i)) })], req: (post, pool) => () => pool[0] },
  { name: "score  hit, CONNS conns", conns: CONNS, n: N * 2, prime: (post) => Array.from({ length: POOL }, (_, i) => post("/v1/score", { url: hitUrl(i) })), req: (post, pool) => (i) => pool[i % POOL] },
  { name: "decide hit, CONNS conns", conns: CONNS, n: N * 2, prime: (post) => Array.from({ length: POOL }, (_, i) => post("/v1/decide", { url: hitUrl(i) })), req: (post, pool) => (i) => pool[i % POOL] },
];

// Default: one fresh load-generator process per scenario (see the note at the top); `--only <index>` is that worker, `--shared` runs in-process.
const only = process.argv.indexOf("--only") === -1 ? null : Number(process.argv[process.argv.indexOf("--only") + 1]);
if (only === null && !shared) {
  const { spawnSync } = require("node:child_process");
  const rows = [];
  const pass = process.argv.slice(2).filter((a) => a !== "--json");
  for (let i = 0; i < SCENARIOS.length; i++) {
    const p = spawnSync(process.execPath, [__filename, ...pass, "--only", String(i), "--json"], { encoding: "utf8" });
    rows.push(JSON.parse(p.stdout));
  }
  const first = rows[1] || rows[0];
  const merged = { node: first.node, platform: first.platform, cpu: first.cpu, detect_version: first.detect_version, results: rows.map((r) => r.results[0]) };
  print(merged, "a fresh process pair per scenario");
  process.exit(0);
}

function print(out, how) {
  if (process.argv.includes("--json")) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`node ${out.node}  ${out.platform}  ${out.cpu}  (detect v${out.detect_version}; ${how})`);
  console.log("scenario".padEnd(40) + "req/s".padStart(9) + "p50 us".padStart(9) + "p95 us".padStart(9) + "p99 us".padStart(9) + "max us".padStart(9) + "  non-200");
  for (const r of out.results) console.log(r.name.padEnd(40) + String(r.rps).padStart(9) + r.p50.toFixed(0).padStart(9) + r.p95.toFixed(0).padStart(9) + r.p99.toFixed(0).padStart(9) + r.max.toFixed(0).padStart(9) + "  " + r.bad);
  const b = out.results.find((r) => r.urls_per_sec);
  if (b) console.log(`batch endpoint: ${b.urls_per_sec.toLocaleString("en-US")} URLs/s`);
}

(async () => {
  const results = [];
  let detectVersion = null;
  for (const [si, sc] of SCENARIOS.entries()) {
    if (only !== null && si !== only) continue;
    const server = sc.server ? await startServer(sc.server) : shared ? (sharedServer ||= await startServer()) : await startServer();
    detectVersion = server.detect_version ?? detectVersion;
    const post = (p, body) => {
      const b = JSON.stringify(body);
      return Buffer.from(`POST ${p} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${server.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);
    };
    const pool = sc.prime ? sc.prime(post) : null;
    if (pool) { const p = new Conn(server.port); await p.ready(); for (const r of pool) await p.send(r); p.close(); }
    const r = await measure(sc.name.replace("CONNS", CONNS), server.port, sc.req(post, pool), { conns: sc.conns, n: sc.n || N });
    if (sc.batch) r.urls_per_sec = r.rps * 100;
    results.push(r);
    if (!shared || sc.server) await server.stop();
  }
  if (sharedServer) await sharedServer.stop();

  print({ node: process.version, platform: `${process.platform} ${os.arch()}`, cpu: os.cpus()[0].model.trim(), detect_version: detectVersion, results },
    shared ? "one shared server process" : "fresh server per scenario");
  process.exit(0);
})();
