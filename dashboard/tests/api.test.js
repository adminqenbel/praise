const test = require("node:test");
const assert = require("node:assert");

// api.js reads `location` when it loads and `fetch` when it is used.
globalThis.location = { hostname: "app.praise.qenbel.site" };
const Api = require("../js/api.js");

// A fake network: each step is a status code, "down" (no answer at all), or "hang" (never answers until aborted).
function network(steps) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === "down") return Promise.reject(new TypeError("Failed to fetch"));
    if (step === "hang") return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return Promise.resolve({ ok: step < 400, status: step, json: async () => (step < 400 ? { user: { id: 1 } } : { error: "nope" }) });
  };
  return calls;
}

// A fake clock the waits advance, so nothing really sleeps.
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test("a sleeping server is waited for: no answer, then the host's own 503, then the real answer", async () => {
  const calls = network(["down", "down", 503, 200]);
  const waits = [];
  const out = await Api.patient("/api/auth/me", { ...clock(), onWait: (ms) => waits.push(ms) });
  assert.deepStrictEqual(out, { user: { id: 1 } });
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(waits, [0, 2500, 5000]);              // told about each miss
  assert.ok(calls.every((c) => c.url === "https://api.praise.qenbel.site/api/auth/me" && c.opts.credentials === "include"));
});

test("any real answer ends the wait, even an error: 401 means signed out, 500 is a bug to show, neither is retried", async () => {
  for (const status of [401, 403, 404, 500]) {
    const calls = network([status, 200]);
    await assert.rejects(Api.patient("/x", clock()), (e) => e.status === status);
    assert.strictEqual(calls.length, 1, `status ${status}`);
  }
});

test("it gives up after the limit with a 'no answer' error the page can explain", async () => {
  const calls = network(["down"]);
  await assert.rejects(Api.patient("/x", { ...clock(), giveUp: 10000, every: 2500 }), (e) => e.status === 0 && /reach the server/.test(e.message));
  assert.strictEqual(calls.length, 5);                          // at 0, 2.5, 5, 7.5 and 10 seconds
  const still = network([503]);
  await assert.rejects(Api.patient("/x", { ...clock(), giveUp: 5000 }), (e) => e.status === 503);
  assert.ok(still.length >= 2);
});

test("a request that never answers is cut off and tried again", async () => {
  const calls = network(["hang", 200]);
  const out = await Api.patient("/x", { attempt: 20, every: 1, giveUp: 5000 });   // real timers, tiny numbers
  assert.deepStrictEqual(out, { user: { id: 1 } });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].opts.signal.aborted);
});

test("warm() pings /health without cookies, ignores the answer and never throws", async () => {
  const calls = network(["down"]);
  Api.warm();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://api.praise.qenbel.site/health");
  assert.deepStrictEqual([calls[0].opts.mode, calls[0].opts.credentials], ["no-cors", "omit"]);
  globalThis.fetch = () => { throw new Error("blocked"); };
  assert.doesNotThrow(() => Api.warm());
});

test("ordinary calls still fail at once on a dead network (only patient() waits)", async () => {
  const calls = network(["down", 200]);
  await assert.rejects(Api.post("/api/auth/login", {}), (e) => e.status === 0);
  assert.strictEqual(calls.length, 1);
});

// ---- the read cache ----------------------------------------------------------------------------------------------
// A fake server that answers each path with the next body it was given, and counts the calls.
function server(bodies) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    const list = bodies[url.replace("https://api.praise.qenbel.site", "")] || bodies["*"] || [{}];
    const n = calls.filter((c) => c.url === url).length - 1;
    const body = list[Math.min(n, list.length - 1)];
    if (body === "down") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  };
  return calls;
}
let now = 0;
Api._clock(() => now);
const fresh = () => { Api.clear(); Api.setSpace("family"); now = 0; };

test("a read carries no custom header, so the browser doesn't ask permission first; a write does carry its headers", async () => {
  fresh();
  const calls = server({ "*": [{ ok: 1 }] });
  await Api.get("/api/children");
  assert.deepStrictEqual(calls[0].opts.headers, {});
  await Api.post("/api/children", { name: "Mia" });
  assert.strictEqual(calls[1].opts.headers["Content-Type"], "application/json");
});

test("every call names the space the tab shows (but the sign-in routes don't)", async () => {
  fresh();
  const calls = server({ "*": [{}] });
  await Api.get("/api/stats?days=7");
  await Api.get("/api/children");
  await Api.get("/api/auth/me");
  await Api.post("/api/children", { name: "x" });
  assert.deepStrictEqual(calls.map((c) => c.url.replace("https://api.praise.qenbel.site", "")),
    ["/api/stats?days=7&space=family", "/api/children?space=family", "/api/auth/me", "/api/children?space=family"]);
  Api.setSpace("adult");
  await Api.get("/api/children", { fresh: true });
  assert.ok(calls[4].url.endsWith("/api/children?space=adult"));
  await Api.get("/api/children", { space: "family", fresh: true });
  assert.ok(calls[5].url.endsWith("/api/children?space=family"));
});

test("a recent read comes from memory, and each caller gets its own copy", async () => {
  fresh();
  const calls = server({ "*": [{ list: [1, 2] }] });
  const a = await Api.get("/api/children");
  a.list.push(3);                                               // a page changing what it was given…
  now = 10000;
  const b = await Api.get("/api/children");
  assert.deepStrictEqual(b, { list: [1, 2] });                  // …doesn't change what the next page gets
  assert.strictEqual(calls.length, 1);
});

test("two pages asking for the same thing at once share one request", async () => {
  fresh();
  const calls = server({ "*": [{ n: 1 }] });
  const [a, b] = await Promise.all([Api.get("/api/stats"), Api.get("/api/stats")]);
  assert.deepStrictEqual([a, b], [{ n: 1 }, { n: 1 }]);
  assert.strictEqual(calls.length, 1);
});

test("an older read is shown at once and checked again; the page is told only if the answer changed", async () => {
  fresh();
  const calls = server({ "/api/children?space=family": [{ v: 1 }, { v: 1 }, { v: 2 }] });
  const heard = [];
  const off = Api.onChange((p) => heard.push(p));
  await Api.get("/api/children");
  now = 60000;                                                  // past the fresh window, inside the stale one
  assert.deepStrictEqual(await Api.get("/api/children"), { v: 1 });          // instant, from memory
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(calls.length, 2);                          // …and asked again in the background
  assert.deepStrictEqual(heard, []);                            // same answer: nothing to redraw
  now = 120000;
  assert.deepStrictEqual(await Api.get("/api/children"), { v: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(heard, ["/api/children"]);             // different answer: the page hears about it
  assert.deepStrictEqual(await Api.get("/api/children"), { v: 2 });
  off();
});

test("a read too old to trust waits for the network", async () => {
  fresh();
  const calls = server({ "*": [{ v: 1 }, { v: 2 }] });
  await Api.get("/api/children");
  now = 11 * 60 * 1000;
  assert.deepStrictEqual(await Api.get("/api/children"), { v: 2 });
  assert.strictEqual(calls.length, 2);
});

test("any change empties the cache, so what you just did is never hidden by an old copy", async () => {
  fresh();
  const calls = server({ "/api/children?space=family": [{ v: 1 }, { v: 2 }], "*": [{}] });
  assert.deepStrictEqual(await Api.get("/api/children"), { v: 1 });
  await Api.post("/api/children", { name: "Leo" });
  assert.deepStrictEqual(await Api.get("/api/children"), { v: 2 });
  assert.strictEqual(calls.filter((c) => c.url.includes("/api/children?space=family") && c.opts.method === "GET").length, 2);
});

test("the chat and the space switch don't empty it (neither changes what a page shows)", async () => {
  fresh();
  const calls = server({ "*": [{ v: 1 }] });
  await Api.get("/api/children");
  await Api.post("/api/auth/chat", { message: "hi" });
  await Api.post("/api/auth/space", { space: "adult" });
  await Api.get("/api/children");
  assert.strictEqual(calls.filter((c) => c.opts.method === "GET").length, 1);
});

test("the two spaces keep separate copies, and the other one can be fetched ahead of time", async () => {
  fresh();
  const calls = server({ "/api/children?space=family": [{ who: "Mia" }], "/api/children?space=adult": [{ who: "Me" }] });
  await Api.prefetch(["/api/children"], { space: "adult" });
  await Api.get("/api/children");
  assert.strictEqual(calls.length, 2);
  Api.setSpace("adult");
  assert.deepStrictEqual(await Api.get("/api/children"), { who: "Me" });    // from the prefetch: no third call
  assert.strictEqual(calls.length, 2);
  Api.setSpace("family");
  assert.deepStrictEqual(await Api.get("/api/children"), { who: "Mia" });
});

test("a failed read is not cached, and a failed prefetch is silent", async () => {
  fresh();
  const calls = server({ "*": ["down", { ok: 1 }] });
  await assert.rejects(Api.get("/api/children"), (e) => e.status === 0);
  assert.deepStrictEqual(await Api.get("/api/children"), { ok: 1 });
  fresh();
  server({ "*": ["down"] });
  await Api.prefetch(["/api/children", "/api/policies"]);       // doesn't throw
});

test("an answer that was asked for before a change is not stored after it", async () => {
  fresh();
  let release;
  globalThis.fetch = (url, opts) => new Promise((resolve) => {
    if (opts.method === "GET") release = () => resolve({ ok: true, status: 200, json: async () => ({ old: true }) });
    else resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  const slow = Api.get("/api/children");
  await Api.post("/api/children", { name: "Leo" });             // happens while the read is on its way
  release();
  await slow;
  const calls = server({ "*": [{ old: false }] });
  assert.deepStrictEqual(await Api.get("/api/children"), { old: false });    // the stale answer wasn't kept
  assert.strictEqual(calls.length, 1);
});
