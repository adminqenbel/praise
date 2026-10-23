const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Pet = require("../pet.js");
const Control = require("../pet-control.js");

const at = (h, day = 11) => new Date(2026, 9, day, h, 30).getTime();

test("greeting: once a day, never when quiet", () => {
  assert.strictEqual(Pet.greetingDue({}, at(9), false), "day");
  assert.strictEqual(Pet.greetingDue({ greetDay: new Date(at(9)).toDateString() }, at(15), false), null);
  assert.strictEqual(Pet.greetingDue({ greetDay: new Date(at(9, 10)).toDateString() }, at(9, 11), false), "day");
  assert.strictEqual(Pet.greetingDue({}, at(9), true), null);
});

test("greeting late at night: a bedtime word at most once an hour", () => {
  assert.strictEqual(Pet.greetingDue({ greetDay: new Date(at(23)).toDateString() }, at(23), false), "late");
  assert.strictEqual(Pet.greetingDue({ lateAt: at(23) }, at(23) + 30 * 60000, false), null);
  assert.strictEqual(Pet.greetingDue({ lateAt: at(23) }, at(23) + 61 * 60000, false), "late");
  assert.strictEqual(Pet.greetingDue({}, at(23), true), null);
  assert.strictEqual(Pet.isLateHour(new Date(at(3))), true);
  assert.strictEqual(Pet.isLateHour(new Date(at(5))), false);
});

test("the pet always stays fully on screen", () => {
  assert.strictEqual(Pet.clampLift(24, 150, 800), 24);
  assert.strictEqual(Pet.clampLift(-50, 150, 800), 12);
  assert.strictEqual(Pet.clampLift(5000, 150, 800), 638);
  assert.strictEqual(Pet.clampLift(undefined, 150, 800), 24);
  assert.strictEqual(Pet.clampLift("abc", 150, 800), 24);
});

// ---- who gets a buddy: paired browsers only -------------------------------------------------------------------
function fakeChrome({ pet = null, token = null, mode = null, tabs = [] } = {}) {
  const store = { pet, token, mode };
  const registered = new Map();
  const injected = [];
  const listeners = { changed: [], installed: [], startup: [] };
  return {
    store, registered, injected, listeners,
    storage: { local: { get: async (d) => ({ ...d, ...Object.fromEntries(Object.entries(store).filter(([, v]) => v !== null && v !== undefined)) }), set: async (o) => Object.assign(store, o) },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) } },
    runtime: { onInstalled: { addListener: (fn) => listeners.installed.push(fn) }, onStartup: { addListener: (fn) => listeners.startup.push(fn) } },
    tabs: { query: async () => tabs },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.filter((i) => registered.has(i)).map((id) => registered.get(id)),
      registerContentScripts: async (list) => list.forEach((s) => registered.set(s.id, s)),
      unregisterContentScripts: async ({ ids }) => ids.forEach((i) => registered.delete(i)),
      executeScript: async (o) => { if (o.target.tabId === 99) throw new Error("cannot access"); injected.push(o.target.tabId); },
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test("an unpaired browser is neutral: nothing is registered or injected, and the page script is told to stay away", async () => {
  const api = fakeChrome({ tabs: [{ id: 1 }] });
  assert.strictEqual(await Control.apply(api), false);
  assert.strictEqual(api.registered.size, 0);
  assert.deepStrictEqual(api.injected, []);
  assert.strictEqual(api.store.petActive, undefined);              // already off: nothing to write
  const stillOff = fakeChrome({ pet: { on: true, quiet: false }, tabs: [{ id: 1 }] });   // a leftover setting is not enough
  assert.strictEqual(await Control.apply(stillOff), false);
  assert.strictEqual(stillOff.registered.size, 0);
});

test("once paired the buddy is on by default: one content script for web pages only, joined to open tabs", async () => {
  const api = fakeChrome({ token: "t", tabs: [{ id: 1 }, { id: 99 }, { id: 2 }] });
  assert.strictEqual(await Control.apply(api), true);
  const s = api.registered.get("praise-pet");
  assert.deepStrictEqual(s.matches, ["http://*/*", "https://*/*"]);
  assert.ok(s.excludeMatches.includes("http://localhost/*"));
  assert.strictEqual(s.allFrames, false);
  assert.strictEqual(s.runAt, "document_start");                // in place before the page's own scripts, so what is typed to the buddy can be kept from them
  assert.deepStrictEqual(api.injected, [1, 2]);                 // a tab it can't enter is skipped, not fatal
  assert.strictEqual(api.store.petActive, true);
  await Control.apply(api);                                     // already registered: not registered or injected again
  assert.strictEqual(api.registered.size, 1);
  assert.deepStrictEqual(api.injected, [1, 2]);
});

test("a paired browser whose person switched the buddy off stays without one", async () => {
  const api = fakeChrome({ token: "t", pet: { on: false, quiet: false }, tabs: [{ id: 1 }] });
  assert.strictEqual(await Control.apply(api), false);
  assert.strictEqual(api.registered.size, 0);
  assert.deepStrictEqual(api.injected, []);
});

test("the buddy appears when pairing completes, can be switched off, and goes when the browser disconnects", async () => {
  const api = fakeChrome();
  Control.install(api);
  assert.strictEqual(api.listeners.installed.length + api.listeners.startup.length, 2);
  await api.listeners.installed[0]();                           // install: unpaired, nothing happens
  assert.strictEqual(api.registered.size, 0);

  api.store.token = "t";                                        // pairing code accepted
  api.listeners.changed[0]({ token: {} }, "local");
  await settle();
  assert.strictEqual(api.registered.size, 1);
  assert.strictEqual(api.store.petActive, true);

  api.store.pet = { on: false, quiet: false };                  // popup switch
  api.listeners.changed[0]({ pet: {} }, "sync");                // other areas are ignored
  api.listeners.changed[0]({ other: {} }, "local");             // other keys are ignored
  await settle();
  assert.strictEqual(api.registered.size, 1);
  api.listeners.changed[0]({ pet: {} }, "local");
  await settle();
  assert.strictEqual(api.registered.size, 0);
  assert.strictEqual(api.store.petActive, false);

  api.store.pet = { on: true, quiet: false };
  api.listeners.changed[0]({ pet: {} }, "local");
  await settle();
  assert.strictEqual(api.registered.size, 1);
  delete api.store.token;                                       // disconnect
  api.listeners.changed[0]({ token: {} }, "local");
  await settle();
  assert.strictEqual(api.registered.size, 0);
  assert.strictEqual(api.store.petActive, false);
});

test("which buddy it is follows the account that issued the pairing code: Dori for a family, Ringo for an adult's own", async () => {
  const fam = fakeChrome({ token: "t", mode: "family" });
  await Control.apply(fam);
  assert.strictEqual(fam.store.petWho, "family");
  const adult = fakeChrome({ token: "t", mode: "adult" });
  await Control.apply(adult);
  assert.strictEqual(adult.store.petWho, "adult");
  const unknown = fakeChrome({ token: "t" });                       // mode missing: the stricter, family side
  await Control.apply(unknown);
  assert.strictEqual(unknown.store.petWho, "family");
  const neutral = fakeChrome({ mode: "adult" });                    // a leftover mode is not enough without a token
  await Control.apply(neutral);
  assert.strictEqual(neutral.store.petWho, undefined);
  await Control.apply(adult);                                       // unchanged: nothing more is written
  const writes = [];
  const set = adult.storage.local.set;
  adult.storage.local.set = async (o) => { writes.push(o); return set(o); };
  await Control.apply(adult);
  assert.deepStrictEqual(writes, []);
});

test("the buddy follows the mode when it changes", async () => {
  const api = fakeChrome({ token: "t", mode: "family" });
  Control.install(api);
  await Control.apply(api);
  api.store.mode = "adult";
  api.listeners.changed[0]({ mode: {} }, "local");
  await settle();
  assert.strictEqual(api.store.petWho, "adult");
});

test("every file the page buddy injects exists in the extension", () => {
  const root = path.resolve(__dirname, "..", "..");
  for (const dir of ["extension"]) for (const f of Control.FILES) assert.ok(fs.existsSync(path.join(root, dir, f)), `${dir}/${f}`);
});

test("the injected scripts never touch the page's content or send anything", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "pet.js"), "utf8");
  for (const bad of ["fetch(", "XMLHttpRequest", "document.body.innerText", "document.title", "location.href", "innerHTML"]) {
    assert.ok(!src.includes(bad), `pet.js must not use ${bad}`);
  }
  // The one thing it may send is what the person types to the buddy, and only after they open the chat and press send.
  const sends = src.match(/sendMessage\([^)]*\)/g) || [];
  assert.deepStrictEqual(sends, ['sendMessage({ type: "chat", message, history })']);
});

test("what is typed to the buddy is hidden from the page's own listeners", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "pet.js"), "utf8");
  for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "compositionupdate"]) assert.ok(src.includes(`"${type}"`), type);
  assert.ok(src.includes("stopImmediatePropagation()") && /root\.addEventListener\(type, [\s\S]*?\}, true\);/.test(src), "listeners are in the capture phase");
  assert.ok(/for \(const type of TYPED\)/.test(src.split("function start")[1].split("async function show")[0]), "installed when the script starts, before the page can");
});

test("a parent can switch the chat off for a child's browser; adults always have it", async () => {
  const off = { settings: { companion: { chat: false } } };
  const family = fakeChrome({ token: "t", mode: "family" });
  family.store.snapshot = off;
  await Control.apply(family);
  assert.strictEqual(family.store.petChat, false);
  family.store.snapshot = { settings: { companion: { chat: true } } };
  await Control.apply(family);
  assert.strictEqual(family.store.petChat, true);

  const adult = fakeChrome({ token: "t", mode: "adult" });
  adult.store.snapshot = off;                                  // the setting belongs to a child's rules; it never reaches a personal browser's chat
  await Control.apply(adult);
  assert.strictEqual(adult.store.petChat, undefined);          // true is the default, nothing to write

  const fresh = fakeChrome({ token: "t", mode: "family" });    // paired a moment ago, no rules downloaded yet
  await Control.apply(fresh);
  assert.strictEqual(fresh.store.petChat, undefined);
  Control.install(fresh);                                      // a rules download (snapshot change) re-checks the setting
  fresh.store.snapshot = off;
  fresh.listeners.changed[0]({ snapshot: {} }, "local");
  await settle();
  assert.strictEqual(fresh.store.petChat, false);
});

test("the buddy needs no web-accessible pictures (it is drawn inline), and the manifest doesn't use dynamic URLs", () => {
  const root = path.resolve(__dirname, "..", "..");
  for (const dir of ["extension"]) {
    const m = JSON.parse(fs.readFileSync(path.join(root, dir, "manifest.json"), "utf8"));
    assert.ok(!m.web_accessible_resources.some((w) => w.resources.some((r) => r.endsWith(".png"))), `${dir}: no pictures are exposed to web pages`);
    assert.ok(!m.web_accessible_resources.some((w) => "use_dynamic_url" in w), `${dir}: use_dynamic_url breaks the warning page's address`);
    assert.ok(m.permissions.includes("scripting"), `${dir}: needs scripting to register the buddy`);
  }
});

test("a registration left by an older version is replaced, not kept", async () => {
  const api = fakeChrome({ token: "t", tabs: [{ id: 1 }] });
  api.registered.set("praise-pet", { id: "praise-pet", js: ["companion.js", "pet.js", "pet-boot.js"], runAt: "document_idle" });
  assert.strictEqual(await Control.apply(api), true);
  const s = api.registered.get("praise-pet");
  assert.deepStrictEqual(s.js, Control.FILES);
  assert.strictEqual(s.runAt, "document_start");
  assert.deepStrictEqual(api.injected, [1]);
  await Control.apply(api);                                     // now current: left alone
  assert.deepStrictEqual(api.injected, [1]);
});
