// Real-Chrome check of talking with the buddy. Launches a throwaway headless Chrome with the unpacked extension, fakes a
// pairing, opens a test page whose scripts try to read every keystroke, then uses the buddy's chat button like a person:
// hover, click, type, send, read the answer, press Escape. It checks that
//   * the chat button appears on hover and opens the panel,
//   * a typed question gets an answer (the buddy's own brain; no server needed),
//   * a worrying message gets the caring answer,
//   * the page's own keyboard listeners (registered first, on window, in the capture phase) see NOTHING typed to the buddy
//     but do see typing in the page's own field (so the check itself works),
//   * Escape closes the panel,
//   * with the parent's switch off there is no chat button at all.
//
//   node scripts/e2e_chat.js <extension folder> <screenshot folder>
//   MODE=adult node scripts/e2e_chat.js extension shots        (Ringo instead of Dori)
//   CHATOFF=1 node scripts/e2e_chat.js extension shots          (a parent switched the chat off)
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const [extArg, shots] = process.argv.slice(2);
if (!extArg || !shots) { console.log("usage: node scripts/e2e_chat.js <extension folder> <screenshot folder>"); process.exit(2); }
fs.mkdirSync(shots, { recursive: true });
const EXT = path.resolve(extArg);
const MODE = process.env.MODE === "adult" ? "adult" : "family";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 8792;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "praise-e2e-chat-"));

// A page that behaves like a hostile one: its listeners go on window, in the capture phase, before anything else runs.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test page</title>
<script>
  window.__keys = [];
  for (const t of ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "compositionupdate"]) {
    window.addEventListener(t, (e) => { window.__keys.push(t + ":" + (e.key || e.data || "")); }, true);
    document.addEventListener(t, (e) => { window.__keys.push("doc-" + t); }, true);
  }
</script></head><body style="font:16px sans-serif;padding:2rem">
<h1>An ordinary page</h1><p>Some text so the page isn't empty.</p><input id="own" aria-label="the page's own field" style="font-size:20px">
</body></html>`;
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(PAGE); });

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1100,760",
  "--host-resolver-rules=MAP praise-e2e.example 127.0.0.1", "about:blank"],
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
    if (process.env.DEBUG && msg.method === "Runtime.exceptionThrown") console.log("page error:", JSON.stringify(msg.params.exceptionDetails).slice(0, 600));
    if (process.env.DEBUG && msg.method === "Runtime.consoleAPICalled") console.log("page console:", msg.params.type, JSON.stringify(msg.params.args.map((a) => a.value || a.description)).slice(0, 300));
  }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const m = { id: ++id, method, params }; if (sessionId) m.sessionId = sessionId;
  pending.set(m.id, res); toChrome.write(JSON.stringify(m) + "\0");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => { chrome.kill(); server.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* harmless */ } process.exit(code); };
let fails = 0;
const check = (ok, what) => { console.log((ok ? "  ok   " : "  FAIL ") + what); if (!ok) fails++; };

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const load = await send("Extensions.loadUnpacked", { path: EXT });
  if (!load.result) { console.log("could not load the extension:", JSON.stringify(load.error)); return finish(1); }
  const extId = load.result.id;
  await send("Target.setDiscoverTargets", { discover: true });
  await sleep(1500);
  const targets = (await send("Target.getTargets")).result.targetInfos;
  const sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
  if (!sw) { console.log("the extension's service worker did not start"); return finish(1); }
  const swSession = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
  const settings = process.env.CHATOFF ? { companion: { chat: false } } : {};
  await send("Runtime.evaluate", { expression: "chrome.storage.local.set(" + JSON.stringify({
    token: "e2e-token", mode: MODE, pet: { on: true, quiet: false }, backendUrl: "http://localhost:1", snapshot: { settings, unknown_action: "ALLOW", allow_domains: ["praise-e2e.example"] },
    cache: { "praise-e2e.example": { decision: { action: "ALLOW", domain: "praise-e2e.example" }, exp: Date.now() + 3600e3 } } }) + ")", awaitPromise: true }, swSession);
  await sleep(1800);

  const page = await send("Target.createTarget", { url: `http://praise-e2e.example:${PORT}/` });
  const ps = (await send("Target.attachToTarget", { targetId: page.result.targetId, flatten: true })).result.sessionId;
  await send("Page.enable", {}, ps);
  await send("DOM.enable", {}, ps);
  await send("Runtime.enable", {}, ps);
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false }, ps);
  await sleep(3500);

  const tree = async () => (await send("DOM.getDocument", { depth: -1, pierce: true }, ps)).result.root;
  const find = (n, pred, acc = []) => { if (pred(n)) acc.push(n); (n.children || []).concat(n.shadowRoots || []).forEach((c) => find(c, pred, acc)); return acc; };
  const attr = (n, k) => { const a = n.attributes || []; const i = a.indexOf(k); return i < 0 ? null : a[i + 1]; };
  const hasClass = (n, c) => (attr(n, "class") || "").split(" ").includes(c);
  const text = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(text).join(""));
  const center = async (nodeId) => { const q = (await send("DOM.getBoxModel", { nodeId }, ps)).result.model.content; return [(q[0] + q[4]) / 2, (q[1] + q[5]) / 2]; };
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra }, ps);
  const typeText = async (s) => { for (const ch of s) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }, ps); await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, ps); } };
  const press = async (key, code, vk, text) => { await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, text }, ps); await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }, ps); };
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true }, ps)).result.result.value;
  const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }, ps); fs.writeFileSync(path.join(shots, name), Buffer.from(r.result.data, "base64")); };

  const root = await tree();
  const body = find(root, (n) => hasClass(n, "buddy-body"))[0];
  if (!body) { console.log("FAIL: no buddy on the page"); return finish(1); }
  if (process.env.DEBUG) console.log("classes:", find(root, (n) => !!attr(n, "class")).map((n) => attr(n, "class")).join(" | "));
  let btn = find(root, (n) => hasClass(n, "talk-btn"))[0];
  if (process.env.CHATOFF) {
    check(!btn, "a parent switched the chat off: no chat button, no panel");
    check(!find(root, (n) => hasClass(n, "chat"))[0], "no chat panel exists");
    return finish(fails ? 1 : 0);
  }
  check(!!btn, "the buddy has a chat button");

  // hover the buddy, then its button, and click
  const [bx, by] = await center(body.nodeId);
  await mouse("mouseMoved", bx, by);
  await sleep(500);
  const [tx, ty] = await center(btn.nodeId);
  await mouse("mouseMoved", tx, ty);
  await sleep(300);
  await mouse("mousePressed", tx, ty); await mouse("mouseReleased", tx, ty);
  await sleep(600);
  let t = await tree();
  const panel = () => find(t, (n) => hasClass(n, "chat"))[0];
  check(panel() && attr(panel(), "hidden") === null, "clicking it opens the chat panel");
  const name = MODE === "adult" ? "Ringo" : "Dori";
  check(find(t, (n) => hasClass(n, "chat-msg")).some((m) => text(m).includes(name)), `${name} introduces itself`);
  await shot(`chat-${MODE}-open.png`);

  // type a question like a person
  const input = find(t, (n) => n.nodeName === "INPUT" && attr(n, "aria-label") && attr(n, "aria-label").startsWith("Message"))[0];
  await send("DOM.focus", { nodeId: input.nodeId }, ps);
  await typeText("tell me a joke");
  await press("Enter", "Enter", 13, "\r");
  await sleep(1500);
  t = await tree();
  const msgs = () => find(t, (n) => hasClass(n, "chat-msg")).map((m) => text(m));
  check(msgs().includes("tell me a joke"), "the question shows in the chat");
  check(msgs().length >= 3 && !hasClass(find(t, (n) => hasClass(n, "chat-msg")).pop(), "chat-typing"), "the buddy answered: " + JSON.stringify(msgs().pop()));
  await typeText("i feel so sad");
  await press("Enter", "Enter", 13, "\r");
  await sleep(1500);
  t = await tree();
  check(/grown-up|helpline|emergency/.test(msgs().pop() || ""), "a worrying message gets the caring answer");
  await shot(`chat-${MODE}-talk.png`);

  // the page's listeners saw nothing of it
  const seen = await ev("window.__keys.length");
  check(seen === 0, `the page's capture-phase key listeners saw nothing typed to the buddy (saw ${seen}${seen ? ": " + (await ev("window.__keys.slice(0, 8).join(' ')")) : ""})`);
  // control: its own field is visible to it, so the listeners do work
  await ev("document.getElementById('own').focus()");
  await sleep(100);
  await typeText("abc");
  const after = await ev("window.__keys.filter((k) => k.startsWith('keydown:')).join()");
  check(after.includes("keydown:a") && after.includes("keydown:c"), "control: typing in the page's own field is seen by the page's listeners");
  check((await ev("document.getElementById('own').value")) === "abc", "control: and still lands in the page's field");

  // Escape closes it
  t = await tree();
  const input2 = find(t, (n) => n.nodeName === "INPUT" && attr(n, "aria-label") && attr(n, "aria-label").startsWith("Message"))[0];
  await send("DOM.focus", { nodeId: input2.nodeId }, ps);
  await press("Escape", "Escape", 27);
  await sleep(500);
  t = await tree();
  check(attr(panel(), "hidden") !== null, "Escape closes the panel");
  await shot(`chat-${MODE}-closed.png`);
  finish(fails ? 1 : 0);
})().catch((e) => { console.log("FAILED", e); finish(1); });
setTimeout(() => { console.log("TIMEOUT"); finish(2); }, 90000);
