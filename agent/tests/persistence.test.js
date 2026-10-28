"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startAgent, tmpDir, rmDir, FAMILY, ADULT, norm, fakeDetect } = require("./helpers");
const store = require("../src/store");
const { filesIn } = require("../src/paths");

const files = (dir) => filesIn({ configDir: dir, stateDir: path.join(dir, "state") });

test("policy snapshot round trip: a restarted agent enforces the saved policy before any sync", async () => {
  const dir = tmpDir();
  try {
    const a = await startAgent({ dir, keepDir: true, policy: FAMILY });
    store.saveSnapshot(files(dir).snapshot, { snapshot: norm(FAMILY), etag: "W/\"1\"", fetchedAt: 1234 });
    await a.stop();
    const b = await startAgent({ dir, keepDir: true });
    try {
      const d = (await b.call("/v1/decide", { body: { url: "https://badsite.com/" } })).json;
      assert.equal(d.reason, "offline-parent-block");
      assert.equal(b.agent.sync.state.etag, "W/\"1\"");
      assert.equal((await b.call("/v1/health", { method: "GET" })).json.policy.loaded, true);
    } finally { await b.stop(); }
  } finally { rmDir(dir); }
});

test("cache round trip: decisions survive a restart and are served as hits without calling the detector", async () => {
  const dir = tmpDir();
  try {
    const d1 = fakeDetect();
    const a = await startAgent({ dir, keepDir: true, policy: ADULT, detect: d1 });
    const first = (await a.call("/v1/decide", { body: { url: "https://sus-site.com/page?x=1" } })).json;
    await a.call("/v1/score", { body: { url: "https://sus-site.com/page?x=1" } });
    assert.equal(first.cached, false);
    // cached entries have a long TTL (WARN 600s, score 3600s): both qualify for persisting
    await a.stop();
    assert.ok(fs.existsSync(files(dir).cache));

    // The restarted agent needs the same policy: write it as the sync would have.
    store.saveSnapshot(files(dir).snapshot, { snapshot: norm(ADULT), etag: null, fetchedAt: Date.now() });
    const d2 = fakeDetect();
    const b = await startAgent({ dir, keepDir: true, detect: d2 });
    try {
      await b.agent.cacheLoaded;
      const again = (await b.call("/v1/decide", { body: { url: "https://sus-site.com/page?x=1" } })).json;
      assert.equal(again.cached, true);
      assert.equal(again.action, "WARN");
      assert.equal(d2.calls.url, 0);
      assert.equal((await b.call("/v1/score", { body: { url: "https://sus-site.com/page?x=1" } })).json.cached, true);
    } finally { await b.stop(); }
  } finally { rmDir(dir); }
});

test("the cache file holds no URLs, domains or tokens (keys are HMACs)", async () => {
  const dir = tmpDir();
  try {
    const a = await startAgent({ dir, keepDir: true, policy: ADULT });
    await a.call("/v1/decide", { body: { url: "https://very-private-site.example/secret/path?q=1" } });
    await a.call("/v1/score", { body: { url: "https://very-private-site.example/secret/path?q=1" } });
    await a.stop();
    const text = fs.readFileSync(files(dir).cache, "utf8");
    assert.ok(text.length > 50);
    for (const needle of ["very-private", "secret", "q=1", a.token]) assert.ok(!text.includes(needle), needle);
  } finally { rmDir(dir); }
});

test("a cache written under a different policy or detector version is ignored", async () => {
  const dir = tmpDir();
  try {
    const a = await startAgent({ dir, keepDir: true, policy: ADULT });
    await a.call("/v1/decide", { body: { url: "https://sus-site.com/" } });
    await a.stop();
    store.saveSnapshot(files(dir).snapshot, { snapshot: norm({ ...ADULT, block_domains: ["other.com"] }), fetchedAt: 1 });   // policy changed
    const b = await startAgent({ dir, keepDir: true });
    try {
      await b.agent.cacheLoaded;
      assert.equal((await b.call("/v1/decide", { body: { url: "https://sus-site.com/" } })).json.cached, false);
    } finally { await b.stop(); }
    store.saveSnapshot(files(dir).snapshot, { snapshot: norm(ADULT), fetchedAt: 1 });
    const c = await startAgent({ dir, keepDir: true, detect: fakeDetect(99) });          // detector changed
    try {
      await c.agent.cacheLoaded;
      assert.equal((await c.call("/v1/decide", { body: { url: "https://sus-site.com/" } })).json.cached, false);
    } finally { await c.stop(); }
  } finally { rmDir(dir); }
});

test("corrupt, truncated, wrong-schema and empty snapshot files are ignored: the agent starts and fails closed", async () => {
  for (const content of ["{not json", '{"schema":1,"snapshot":', '{"schema":99,"snapshot":{}}', "", "[]", '{"schema":1,"snapshot":"x"}', '{"schema":1,"snapshot":{"nonsense":true}}']) {
    const dir = tmpDir();
    try {
      fs.mkdirSync(path.join(dir, "state"), { recursive: true });
      fs.writeFileSync(files(dir).snapshot, content);
      const a = await startAgent({ dir, keepDir: true });
      try {
        const d = (await a.call("/v1/decide", { body: { url: "https://example.com/" } })).json;
        assert.equal(d.action, "BLOCK", content);
        assert.equal(d.reason, "offline-no-policy");
        assert.equal((await a.call("/v1/health", { method: "GET" })).json.policy.loaded, false);
      } finally { await a.stop(); }
    } finally { rmDir(dir); }
  }
});

test("corrupt cache files and tampered rows are ignored without affecting the snapshot", async () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, "state"), { recursive: true });
    store.saveSnapshot(files(dir).snapshot, { snapshot: norm(ADULT), fetchedAt: 1 });
    const a0 = await startAgent({ dir, keepDir: true });
    const version = a0.agent.engine.policy.version;
    await a0.stop();
    for (const content of ["{{{", '{"schema":1,"policy_version":"' + version + '","detect_version":7,"score":"nope","decide":[[1,2]]}']) {
      fs.writeFileSync(files(dir).cache, content);
      const a = await startAgent({ dir, keepDir: true });
      try {
        await a.agent.cacheLoaded;
        assert.equal((await a.call("/v1/decide", { body: { url: "https://example.com/" } })).json.action, "ALLOW");
      } finally { await a.stop(); }
    }
    // A row whose body is not valid JSON is dropped by the loader.
    const future = Date.now() + 3600_000;
    fs.writeFileSync(files(dir).cache, JSON.stringify({ schema: 1, policy_version: version, detect_version: 7, score: [], decide: [["k", 200, "<script>", future], ["k2", 200, '{"action":"ALLOW","cached":', future]] }));
    const r = store.loadCache(files(dir).cache, { policyVersion: version, detectVersion: 7 });
    assert.equal(r.rows.length, 1);
  } finally { rmDir(dir); }
});

test("writes are atomic: no temp files are left behind and an old file survives a failed write", () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, "state", "x.json");
    store.writeJsonAtomic(f, { a: 1 }, { harden: false });
    store.writeJsonAtomic(f, { a: 2 }, { harden: false });
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).a, 2);
    assert.deepEqual(fs.readdirSync(path.join(dir, "state")).filter((n) => n.endsWith(".tmp")), []);
    // Writing into a directory that cannot be created leaves the existing file alone.
    assert.throws(() => store.writeJsonAtomic(path.join(f, "child", "y.json"), { a: 3 }, { harden: false }));
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).a, 2);
  } finally { rmDir(dir); }
});

test("state files are owner-only on POSIX", { skip: process.platform === "win32" }, () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, "state", "x.json");
    store.writeJsonAtomic(f, { a: 1 }, { harden: false });
    assert.equal(fs.statSync(f).mode & 0o077, 0);
  } finally { rmDir(dir); }
});
