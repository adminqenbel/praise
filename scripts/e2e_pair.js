// Real-Chrome, real-backend check of the ONE extension adapting to its pairing code.
//
// For each kind of account (a family parent, an adult) it signs up through the running backend, makes a pairing code, then in
// a throwaway headless Chrome loads the unpacked extension, types the code into the popup and checks what the extension
// became: the popup's look and buddy, the page buddy, the guard, and how a new site is treated. Then it disconnects and checks
// the extension is neutral again. Screenshots of each popup state go in the folder given.
//
//   node scripts/e2e_pair.js <screenshots folder> [page url]
//
// Needs the backend on http://localhost:5000 (praise.bat mock nobrowser) and a test page served locally, e.g.
//   python -m http.server 8791 --bind 127.0.0.2
// Chrome is told to map the made-up site name praise-e2e.example to that server: the extension judges website names (not bare IP
// addresses), and the buddy skips localhost.
// The accounts it creates end in @demo.test, so `flask purge-demo` removes them.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const outDir = path.resolve(process.argv[2] || ".");
const PAGE = process.argv[3] || "http://praise-e2e.example/index.html";
const SERVER = process.env.SERVER || "127.0.0.2:8791";
const API = process.env.API || "http://localhost:5000";
const EXT = path.resolve(__dirname, "..", "extension");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PASSWORD = "e2e-password-123";
fs.mkdirSync(outDir, { recursive: true });

// ---- the backend: sign up, make a code ------------------------------------------------------------------
async function account(type) {
  const jar = {};
  const call = async (method, url, body, csrf) => {
    const res = await fetch(API + url, { method, headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const email = `e2e-${type}-${Date.now()}@demo.test`;
  const reg = await call("POST", "/api/auth/register", { email, password: PASSWORD, account_type: type });
  if (reg.status !== 201) throw new Error("register failed: " + JSON.stringify(reg));
  const csrf = reg.body.csrf;
  let childId;
  const kids = await call("GET", "/api/children");
  if (kids.body && kids.body.children && kids.body.children.length) childId = kids.body.children[0].id;
  else childId = (await call("POST", "/api/children", { name: "Mia" }, csrf)).body.id;
  const code = (await call("POST", `/api/children/${childId}/devices`, { label: "E2E browser" }, csrf)).body.pairing_code;
  // What a parent does on the Children page to let a child's browser leave: a one-time disconnect code for it.
  const leaveCode = async () => {
    const kid = (await call("GET", "/api/children")).body.children.find((c) => c.id === childId);
    return (await call("POST", `/api/devices/${kid.devices[0].id}/disconnect-code`, null, csrf)).body.code;
  };
  return { email, code, leaveCode };
}

// ---- Chrome over the DevTools pipe ------------------------------------------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "praise-e2e-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1100,720", `--host-resolver-rules=MAP praise-e2e.example ${SERVER}`, "about:blank"],
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
const finish = (code) => { chrome.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* locked: harmless */ } process.exit(code); };

let failures = 0;
const check = (ok, what) => { console.log((ok ? "  ok   " : "  FAIL ") + what); if (!ok) failures++; };

async function open(url) {
  const t = await send("Target.createTarget", { url });
  const session = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
  await send("Page.enable", {}, session);
  return { targetId: t.result.targetId, session };
}
async function ev(session, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function shot(session, name) {
  const s = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 380, height: 760, scale: 1 } }, session);
  if (s.result) fs.writeFileSync(path.join(outDir, name), Buffer.from(s.result.data, "base64"));
}
const urlOf = async (targetId) => (await send("Target.getTargets")).result.targetInfos.find((t) => t.targetId === targetId).url;
const hasBuddy = (session) => ev(session, "(() => { const d = [...document.documentElement.children].find((e) => e.style && e.style.zIndex === '2147483646'); return !!d; })()");

(async () => {
  const load = await send("Extensions.loadUnpacked", { path: EXT });
  if (!load.result) { console.log("could not load the extension:", JSON.stringify(load.error)); return finish(1); }
  const extId = load.result.id;
  await send("Target.setDiscoverTargets", { discover: true });
  await sleep(1500);
  const sw = (await send("Target.getTargets")).result.targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
  const swSession = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
  const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
  const scripts = () => ev(swSession, "chrome.scripting.getRegisteredContentScripts().then((l) => l.map((x) => x.id).sort().join())");
  const popup = async () => {
    const p = await open(popupUrl);
    await sleep(800);
    return p;
  };

  // ---- brand new: neutral ----
  console.log("before any pairing code");
  let p = await popup();
  check(await ev(p.session, "document.body.dataset.mode") === "neutral", "the popup is neutral");
  check(await ev(p.session, "document.getElementById('buddy').hidden && document.getElementById('petBox').hidden"), "no buddy and no buddy switch in the popup");
  check(await ev(p.session, "!document.getElementById('pairForm').hidden"), "it offers the pairing form");
  check(!(await scripts()), "no content scripts are registered");
  await shot(p.session, "1-neutral.png");
  await send("Target.closeTarget", { targetId: p.targetId });

  for (const type of ["family", "adult"]) {
    const mode = type;
    const acct = await account(type);
    console.log(`\npairing with a ${type} account's code`);
    p = await popup();
    await ev(p.session, `document.getElementById('code').value = ${JSON.stringify(acct.code)}; document.getElementById('server').value = ${JSON.stringify(API)}; document.getElementById('pairForm').requestSubmit();`);
    await sleep(3500);
    check(await ev(p.session, "document.body.dataset.mode") === mode, `the popup becomes the ${mode} version`);
    check(await ev(p.session, "!document.getElementById('buddy').hidden && !document.getElementById('petBox').hidden"), "the buddy and its switch appear");
    check((await ev(p.session, "(document.querySelector('#buddy .buddy') || {}).className || ''")).includes(`buddy-${mode}`) && await ev(p.session, "!!document.querySelector('#buddy svg.buddy-base')"), `the popup buddy is the ${mode} one`);
    check(await ev(p.session, mode === "adult" ? "!document.getElementById('adult').hidden && document.getElementById('family').hidden" : "!document.getElementById('family').hidden && document.getElementById('adult').hidden"), `only the ${mode} controls show`);
    check((await ev(p.session, "document.querySelector('.buddy-name').textContent")) === (mode === "adult" ? "Ringo" : "Dori"), "the switch names the right buddy");
    await shot(p.session, `2-${mode}-paired.png`);

    // talking to the buddy from the popup
    check(await ev(p.session, "!document.getElementById('talkBtn').hidden"), "the popup offers to talk to the buddy");
    await ev(p.session, "document.getElementById('talkBtn').click(); 1");
    await sleep(400);
    await ev(p.session, "(() => { const i = document.querySelector('#chatBox .chat-form input'); i.value = 'tell me a joke'; document.querySelector('#chatBox .chat-form').requestSubmit(); return 1; })()");
    await sleep(1500);
    const answer = await ev(p.session, "[...document.querySelectorAll('#chatBox .chat-msg')].pop().textContent");
    check(typeof answer === "string" && answer.length > 10 && !answer.startsWith("tell me"), "the buddy answers in the popup: " + String(answer).slice(0, 60));
    await shot(p.session, `2b-${mode}-chat.png`);
    await ev(p.session, "document.querySelector('#chatBox .chat-x').click(); 1");
    const reg = await scripts();
    check(reg.includes("praise-pet"), "the page buddy is registered");
    check(reg.includes("praise-guard") === (mode === "adult"), mode === "adult" ? "the sensitive-data guard is registered" : "no guard in a child's browser");

    // a new site, and what each version does with it
    const page = await open(PAGE);
    await sleep(7000);
    const where = await urlOf(page.targetId);
    if (mode === "family") check(where.startsWith(`chrome-extension://${extId}/block/block.html`), "an unknown site is held at the door page (" + where.slice(0, 70) + ")");
    else {
      check(!where.startsWith("chrome-extension://"), "the page loads normally (" + where.slice(0, 60) + ")");
      check(await hasBuddy(page.session), "Ringo waits in the corner of the page");
    }
    await send("Target.closeTarget", { targetId: page.targetId });

    // disconnect
    await ev(p.session, "location.reload()");
    await sleep(1000);
    if (mode === "family") {
      await ev(p.session, "document.getElementById('famLeaveBtn').click(); 1");
      await ev(p.session, "document.getElementById('famLeavePw').value = 'WRONG234'; document.getElementById('famLeaveForm').requestSubmit(); 1");
      await sleep(1500);
      check(await ev(p.session, "document.body.dataset.mode") === "family", "a wrong disconnect code does not disconnect it");
      await shot(p.session, "3-family-wrong-code.png");
      await ev(p.session, `document.getElementById('famLeavePw').value = ${JSON.stringify(await acct.leaveCode())}; document.getElementById('famLeaveForm').requestSubmit(); 1`);
    } else {
      await ev(p.session, "document.getElementById('adLeaveBtn').click(); document.getElementById('adLeaveBtn').click(); 1");
    }
    await sleep(2500);
    check(await ev(p.session, "document.body.dataset.mode") === "neutral", "after disconnecting it is neutral again");
    check(await ev(p.session, "document.getElementById('buddy').hidden && document.getElementById('petBox').hidden"), "the buddy is gone from the popup");
    check(!(await scripts()), "no content scripts are left registered");
    await shot(p.session, `4-${mode}-disconnected.png`);
    await send("Target.closeTarget", { targetId: p.targetId });
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  finish(failures ? 1 : 0);
})().catch((e) => { console.log("FAILED", e); finish(1); });
setTimeout(() => { console.log("TIMEOUT"); finish(2); }, 150000);
