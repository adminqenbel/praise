"use strict";

// One popup for every account. Before a pairing code it is neutral: a pairing form and nothing else. The code decides
// what it becomes (the service worker reports the mode), and then the popup takes that account's look, its buddy
// (Dori for a family, Ringo for an adult's own) and its controls.

const $ = (id) => document.getElementById(id);
// Everything the popup does goes through the background worker with a message.
const send = (msg) => chrome.runtime.sendMessage(msg);

const BUDDY_NAME = { family: "Dori", adult: "Ringo" };
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function ago(ts) {
  if (!ts) return "Rules haven't been checked yet.";
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "Rules checked just now." : `Rules checked ${m} minute${m === 1 ? "" : "s"} ago.`;
}

// ---- the buddy: mounted only once there is an account to belong to ------------------------------------------
let mounted = null;                                         // { who, buddy }
// Show the right buddy for the account type; replace it if the account type changed.
function ensureBuddy(who) {
  if (mounted && mounted.who === who) return mounted.buddy;
  if (mounted) mounted.buddy.destroy();
  $("buddy").textContent = "";
  mounted = { who, buddy: PraiseBuddy.mount($("buddy"), { who, base: "../companion/", height: 96, side: true, mood: "happy" }) };
  return mounted.buddy;
}
function dropBuddy() {
  if (mounted) mounted.buddy.destroy();
  mounted = null;
  $("buddy").textContent = "";
}
function say(text, mood) { if (mounted) mounted.buddy.say(text, mood); }

// ---- talking with the buddy: a chat panel under it, only when this account allows chatting --------------------------
let chatOf = null;                                          // { who, chat }
function dropChat() {
  if (chatOf) chatOf.chat.destroy();
  chatOf = null;
  $("chatBox").textContent = "";
  $("chatBox").hidden = true;
  $("talkBtn").hidden = true;
}
// Add the chat panel only when this account allows chatting.
function ensureChat(who, allowed) {
  if (!allowed) { dropChat(); return; }
  if (chatOf && chatOf.who === who) { $("talkBtn").hidden = chatOf.chat.isOpen; return; }
  dropChat();
  const chat = PraiseChat.mount($("chatBox"), {
    who, inline: true,
    remote: async (message, history) => { const r = await send({ type: "chat", message, history }); return r && typeof r.reply === "string" ? r.reply : null; },
    onMood: (m) => { if (mounted) mounted.buddy.setMood(m); },
    onOpen: () => { $("chatBox").hidden = false; $("talkBtn").hidden = true; },
    onClose: () => { $("chatBox").hidden = true; $("talkBtn").hidden = false; if (mounted) mounted.buddy.setMood("happy"); },
  });
  chatOf = { who, chat };
  $("talkBtn").hidden = false;
}
$("talkBtn").addEventListener("click", () => { if (chatOf) chatOf.chat.open(); });
function speak(kind, ctx) {
  if (!mounted) return;
  const s = PraiseCompanion.say(mounted.who, kind, ctx);
  mounted.buddy.say(s.text, s.mood, kind);
}

// ---- drawing the state ---------------------------------------------------------------------------------------------
// The four screens of the popup; exactly one is shown at a time.
const VIEWS = ["family", "adult", "revoked", "pairForm"];
let current = { mode: "neutral" };

// Redraw everything from the worker's status: neutral (pairing form), family view, adult view, or 'disconnected'.
async function render(keepVoice) {
  const st = await send({ type: "status" });
  const mode = st.paired ? (st.mode === "adult" ? "adult" : "family") : "neutral";
  current = { mode };
  document.body.dataset.mode = mode;
  const active = st.paired && !st.revoked;
  for (const id of VIEWS) $(id).hidden = true;

  // neutral until a pairing code has been accepted: no buddy, no switch
  $("buddy").hidden = !st.paired;
  $("petBox").hidden = !st.paired;
  if (st.paired) {
    ensureBuddy(mode);
    ensureChat(mode, active && st.chat !== false);
    for (const el of document.querySelectorAll(".buddy-name")) el.textContent = BUDDY_NAME[mode];
  } else {
    dropBuddy();
    dropChat();
  }
  $("sub").hidden = true;

  if (active && mode === "adult") return renderAdult(st, keepVoice);
  if (active) return renderFamily(st, keepVoice);

  // not connected (or removed by the account): the pairing form
  $("pairForm").hidden = false;
  $("connect").disabled = false;
  $("connect").textContent = "Connect this browser";
  $("code").value = "";
  $("serverBox").hidden = !st.devBuild;        // only an unpacked developer copy can use another server
  $("server").value = $("server").value || st.backendUrl;
  if (st.revoked) {
    $("revoked").hidden = false;
    $("heading").textContent = "Disconnected";
    $("revokedLine").textContent = mode === "adult"
      ? "This browser was removed from your account. The last rules stay in place until you connect it again with a new code."
      : "A parent removed this browser. The last rules stay in place until it's connected again with a new code.";
    speak("revoked");
  } else {
    $("heading").textContent = "Connect this browser";
  }
}

function renderFamily(st, keepVoice) {
  $("family").hidden = false;
  $("heading").textContent = "You are all set";
  $("famLine").textContent = st.profile ? `This browser follows ${st.profile}'s rules.` : "This browser is connected to your family.";
  $("famSync").textContent = ago(st.lastSync);
  if (!keepVoice) speak("greet");
}

// Adult view: protected/paused state, this page's tracker report, password-check info and the pause buttons.
function renderAdult(st, keepVoice) {
  $("adult").hidden = false;
  const paused = st.pausedUntil > Date.now();
  $("heading").textContent = paused ? "Paused" : "You're protected";
  $("sub").hidden = !st.profile;
  $("sub").textContent = st.profile ? `${st.profile}'s browser` : "";
  $("adState").textContent = paused
    ? `Praise Shield is off until ${timeOf(st.pausedUntil)}. Sites aren't being checked.`
    : "Sites are checked as you browse, and you'll be warned before anything risky.";
  $("pauseRow").hidden = paused;
  $("report").hidden = paused;
  $("pwSection").hidden = paused || !(st.breachCheck || st.reuseCheck);
  $("pwBreach").hidden = !st.breachCheck;
  $("pwReuse").hidden = !st.reuseCheck;
  $("forgetPw").hidden = !st.reuseCheck || !st.reuseCount;
  $("pwReuse").textContent = st.reuseCheck
    ? `To spot reuse, ${st.reuseCount} password${st.reuseCount === 1 ? " is" : "s are"} remembered on this device as slow, scrambled fingerprints. The passwords themselves are never stored.` : "";
  if (!paused) loadReport();
  $("resume").hidden = !paused;
  $("adSync").textContent = ago(st.lastSync);
  if (!keepVoice) speak(paused ? "paused" : "protected");
}

// ---- pairing ---------------------------------------------------------------------------------------------------------------
// Pair this browser: send the code and server address to the worker; success makes the popup take that account's look.
$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("connect");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  $("error").hidden = true;
  const res = await send({ type: "pair", code: $("code").value, backendUrl: $("server").value });
  if (res && res.ok) { await render(true); speak("paired"); return; }
  $("error").textContent = (res && res.error) || "Couldn't connect. Try again.";
  $("error").hidden = false;
  speak("error");
  btn.disabled = false;
  btn.textContent = "Connect this browser";
});

// ---- family: sync, and disconnecting with a parent's password ------------------------------------------------------
// Ask the worker to fetch the latest rules now.
$("famSyncBtn").addEventListener("click", async () => {
  $("famSyncBtn").disabled = true;
  speak("checking");
  await send({ type: "sync" });
  await render(true);
  say("All up to date!", "happy");
  $("famSyncBtn").disabled = false;
});

// Disconnecting asks for a parent's password, so a child can't switch the protection off from here.
function leaveOpen(open) {
  $("famLeaveForm").hidden = !open;
  $("famLeaveBtn").hidden = open;
  $("famLeaveError").hidden = true;
  $("famLeavePw").value = "";
  if (open) { $("famLeavePw").focus(); say("I'll need a parent for this one.", "shy"); }
}
$("famLeaveBtn").addEventListener("click", () => leaveOpen(true));
$("famLeaveCancel").addEventListener("click", () => { leaveOpen(false); speak("greet"); });
$("famLeaveForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const go = $("famLeaveGo");
  go.disabled = true;
  $("famLeaveError").hidden = true;
  const res = await send({ type: "disconnect", password: $("famLeavePw").value });
  go.disabled = false;
  if (res && res.ok) { leaveOpen(false); await render(true); return; }
  $("famLeaveError").textContent = (res && res.error) || "Couldn't disconnect. Try again.";
  $("famLeaveError").hidden = false;
  $("famLeavePw").select();
  speak("error");
});

// ---- adult: this page's report, cookies, passwords, pause -----------------------------------------------------------
// What Praise Shield did on the page you are looking at: trackers blocked, tracking cookies and so on.
async function loadReport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || "")) { $("report").hidden = true; return; }   // nothing to report on this page
  const r = await send({ type: "report", tabId: tab.id, url: tab.url });
  if (!r || !r.blocked) return;
  $("reportSite").textContent = r.domain || "";
  $("nTrackers").textContent = r.blocked.trackers;
  $("nFingerprint").textContent = r.blocked.fingerprint;
  $("nLinks").textContent = r.blocked.links;
  const s = r.site;
  $("cookieLine").textContent = `${s.total === 1 ? "1 cookie" : s.total + " cookies"} from this site, ${s.tracking} of them tracking. ` +
    `Your browser holds ${r.trackingInBrowser} tracking cookie${r.trackingInBrowser === 1 ? "" : "s"} in total.`;
  $("clearSite").dataset.url = tab.url;
}

// Clearing a site's cookies signs you out of it, so that one asks twice (no pop-up dialog).
function armed(btn, label, armedLabel, run) {
  btn.addEventListener("click", async () => {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = armedLabel;
      setTimeout(() => { btn.dataset.armed = ""; btn.textContent = label; }, 4000);
      return;
    }
    btn.dataset.armed = ""; btn.textContent = label; btn.disabled = true;
    const res = await run();
    btn.disabled = false;
    $("cleared").hidden = false;
    $("cleared").textContent = res && res.removed ? `Removed ${res.removed} cookie${res.removed === 1 ? "" : "s"}.` : "Nothing to remove.";
    loadReport();
  });
}
armed($("clearSite"), "Clear this site's cookies", "Click again (signs you out)", () => send({ type: "clearSite", url: $("clearSite").dataset.url }));
armed($("clearTrack"), "Remove tracking cookies", "Click again to remove", () => send({ type: "clearTrackers" }));
armed($("forgetPw"), "Forget remembered passwords", "Click again to forget", async () => {
  await send({ type: "forgetPasswords" });
  await render();
  return { removed: 0 };
});

$("pause1").addEventListener("click", async () => { await send({ type: "pause", minutes: 60 }); render(); });
$("pauseDay").addEventListener("click", async () => { await send({ type: "pause", minutes: "tomorrow" }); render(); });
$("resume").addEventListener("click", async () => { await send({ type: "pause", minutes: 0 }); render(); });
$("adSyncBtn").addEventListener("click", async () => {
  $("adSyncBtn").disabled = true;
  speak("checking");
  await send({ type: "sync" });
  await render(true);
  speak("protected");
  $("adSyncBtn").disabled = false;
});

// Two clicks to disconnect: the first asks, the second does it. Nobody else uses a personal browser, so no password.
(function leave() {
  const btn = $("adLeaveBtn");
  let timer = null;
  btn.addEventListener("click", async () => {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = "Click again to disconnect";
      say("This stops protection in this browser. Sure?", "alert");
      timer = setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Disconnect this browser"; }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.dataset.armed = ""; btn.textContent = "Disconnect this browser"; btn.disabled = true;
    const res = await send({ type: "disconnect" });
    btn.disabled = false;
    if (res && res.ok) { await render(true); return; }
    $("adLeaveNote").textContent = (res && res.error) || "Couldn't disconnect. Try again.";
    $("adLeaveNote").hidden = false;
  });
})();

render();

// ---- the page buddy's switch (only visible once paired). It starts out on; turning it off removes its script from pages.
(async function petSwitch() {
  const { pet } = await chrome.storage.local.get({ pet: {} });
  const state = { on: true, quiet: false, ...pet };
  const on = $("petOn"), quiet = $("petQuiet");
  const paint = () => { on.checked = state.on; quiet.checked = state.quiet; quiet.disabled = !state.on; $("petQuietRow").classList.toggle("off", !state.on); };
  const save = async () => { await chrome.storage.local.set({ pet: { ...state } }); paint(); };
  on.addEventListener("change", () => {
    state.on = on.checked; save();
    if (state.on) {
      if (current.mode === "adult") say("Yay! I'll keep watch from the corner of your pages.", "happy");
      else say("Yay! I'll be in the corner of your pages.", "celebrate");
    }
  });
  quiet.addEventListener("change", () => { state.quiet = quiet.checked; save(); });
  paint();
})();
