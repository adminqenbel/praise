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
