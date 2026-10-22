// Real-Chrome check of the page buddy. Launches a throwaway headless Chrome, loads the unpacked extension through the
// DevTools pipe, switches the buddy on from the extension's own service worker (what the popup switch does), opens a
// page and reports whether the buddy appeared. Also saves a screenshot.
//
//   node scripts/e2e_pet.js <extension folder> <page url> <screenshot.png>
//   MODE=adult node scripts/e2e_pet.js extension http://127.0.0.2:8791/index.html shot.png
//
// There is one extension. MODE=family (default) or MODE=adult fakes a pairing code from that kind of account;
// FRESH=1 fakes only the pairing; UNPAIRED=1 fakes nothing and expects the extension to stay neutral.
//
// Use an address that is not localhost or 127.0.0.1 (the buddy skips those): 127.0.0.2 works with any local server.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const [extArg, pageUrl, out] = process.argv.slice(2);
if (!extArg || !pageUrl || !out) { console.log("usage: node scripts/e2e_pet.js <extension folder> <page url> <screenshot.png>"); process.exit(2); }
const EXT = path.resolve(extArg);
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "praise-e2e-"));

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1100,720", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const [, , , toChrome, fromChrome] = chrome.stdio;

let id = 0, buf = "";
const pending = new Map();
fromChrome.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const m = { id: ++id, method, params }; if (sessionId) m.sessionId = sessionId;
  pending.set(m.id, res); toChrome.write(JSON.stringify(m) + "\0");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => { chrome.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* still locked: harmless */ } process.exit(code); };

(async () => {
  const load = await send("Extensions.loadUnpacked", { path: EXT });
  if (!load.result) { console.log("could not load the extension:", JSON.stringify(load.error)); return finish(1); }
  const extId = load.result.id;
  await send("Target.setDiscoverTargets", { discover: true });
  await sleep(1500);
  const targets = (await send("Target.getTargets")).result.targetInfos;
  const sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
  if (!sw) { console.log("the extension's service worker did not start"); return finish(1); }
  const swSession = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
  // The buddy belongs to a paired browser. By default this fakes a pairing (stores a token, the way a pairing code would) and
  // switches the buddy on from the popup's setting. FRESH=1 only fakes the pairing, to prove it appears on its own.
  // UNPAIRED=1 changes nothing, to prove an unpaired extension stays neutral (expects no buddy at all).
  const MODE = process.env.MODE === "adult" ? "adult" : "family";
  if (!process.env.UNPAIRED) {
    const o = process.env.FRESH ? { token: "e2e-token", mode: MODE } : { token: "e2e-token", mode: MODE, pet: { on: true, quiet: false } };
    await send("Runtime.evaluate", { expression: "chrome.storage.local.set(" + JSON.stringify(o) + ")", awaitPromise: true }, swSession);
  }
  await sleep(1500);

  const page = await send("Target.createTarget", { url: pageUrl });
  const ps = (await send("Target.attachToTarget", { targetId: page.result.targetId, flatten: true })).result.sessionId;
  await send("Page.enable", {}, ps);
  await send("DOM.enable", {}, ps);
  await sleep(4000);

  const doc = await send("DOM.getDocument", { depth: -1, pierce: true }, ps);
  const sprites = [];                 // one entry per buddy drawing found on the page: the class of the buddy that holds it
  const walk = (n, owner) => {
    const a = n.attributes || [], cls = a.includes("class") ? a[a.indexOf("class") + 1] : "";
    if (/\bbuddy-(family|adult)\b/.test(cls)) owner = cls;
    if (n.nodeName === "IMG" && /\bbuddy-base\b/.test(cls)) sprites.push(owner || "");
    (n.children || []).concat(n.shadowRoots || []).forEach((c) => walk(c, owner));
  };
  walk(doc.result.root);
  const shot = await send("Page.captureScreenshot", { format: "png" }, ps);
  if (shot.result) fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  const reg = await send("Runtime.evaluate", { expression: "chrome.scripting.getRegisteredContentScripts().then((l) => l.map((x) => x.id).sort().join())", awaitPromise: true, returnByValue: true }, swSession);
  const registered = reg.result && reg.result.result ? reg.result.result.value : "?";
  console.log("registered content scripts:", registered || "(none)");
  if (process.env.UNPAIRED) {
    console.log(sprites.length || registered ? "FAIL: an unpaired extension showed a buddy or registered a script" : "OK: unpaired, so no buddy and no scripts (neutral)");
    return finish(sprites.length || registered ? 1 : 0);
  }
  const wantGuard = MODE === "adult";
  if (registered.includes("praise-guard") !== wantGuard) { console.log(`FAIL: the guard should be ${wantGuard ? "registered" : "absent"} in ${MODE} mode`); return finish(1); }
  if (sprites.length === 1 && !sprites[0].includes(`buddy-${MODE}`)) { console.log(`FAIL: wrong buddy for ${MODE} mode:`, sprites[0]); return finish(1); }
  if (sprites.length === 1) { console.log(`OK (${MODE}): the buddy is on the page:`, sprites[0]); return finish(0); }
  console.log(sprites.length ? "FAIL: more than one buddy on the page" : "FAIL: no buddy on the page");
  finish(1);
})().catch((e) => { console.log("FAILED", e); finish(1); });
setTimeout(() => { console.log("TIMEOUT"); finish(2); }, 60000);
