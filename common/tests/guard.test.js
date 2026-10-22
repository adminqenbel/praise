const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Guard = require("../guard-control.js");

function fakeChrome({ token = null, mode = null } = {}) {
  const store = { token, mode };
  const registered = new Map();
  const listeners = { changed: [], installed: [], startup: [] };
  return {
    store, registered, listeners,
    storage: { local: { get: async (d) => ({ ...d, ...Object.fromEntries(Object.entries(store).filter(([, v]) => v !== null && v !== undefined)) }) },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) } },
    runtime: { onInstalled: { addListener: (fn) => listeners.installed.push(fn) }, onStartup: { addListener: (fn) => listeners.startup.push(fn) } },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.filter((i) => registered.has(i)).map((id) => registered.get(id)),
      registerContentScripts: async (list) => list.forEach((s) => registered.set(s.id, s)),
      unregisterContentScripts: async ({ ids }) => ids.forEach((i) => registered.delete(i)),
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test("the guard exists only for a browser paired to an adult's own account", async () => {
  for (const [token, mode] of [[null, null], [null, "adult"], ["t", "family"], ["t", null]]) {
    const api = fakeChrome({ token, mode });
    assert.strictEqual(await Guard.apply(api), false, `${token}/${mode}`);
    assert.strictEqual(api.registered.size, 0);
  }
  const api = fakeChrome({ token: "t", mode: "adult" });
  assert.strictEqual(await Guard.apply(api), true);
  const s = api.registered.get("praise-guard");
  assert.deepStrictEqual(s.matches, ["http://*/*", "https://*/*"]);
  assert.strictEqual(s.runAt, "document_start");                    // in place before the page's own scripts
  assert.strictEqual(s.allFrames, false);
  assert.deepStrictEqual(s.js, ["protections.js", "sensitive.js", "passwords.js", "content.js"]);
  await Guard.apply(api);                                           // not registered twice
  assert.strictEqual(api.registered.size, 1);
});

test("the guard arrives when an adult's code is accepted and leaves on disconnect", async () => {
  const api = fakeChrome();
  Guard.install(api);
  api.store.token = "t"; api.store.mode = "adult";
  api.listeners.changed[0]({ token: {}, mode: {} }, "local");
  await settle();
  assert.strictEqual(api.registered.size, 1);
  api.listeners.changed[0]({ other: {} }, "local");                 // unrelated keys are ignored
  delete api.store.token; delete api.store.mode;
  api.listeners.changed[0]({ token: {} }, "local");
  await settle();
  assert.strictEqual(api.registered.size, 0);
});

test("every file the guard injects exists, and the manifest has no always-on content script", () => {
  const root = path.resolve(__dirname, "..", "..", "extension");
  for (const f of Guard.FILES) assert.ok(fs.existsSync(path.join(root, f)), f);
  const m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(!m.content_scripts, "content scripts are registered only after pairing, never declared up front");
});
