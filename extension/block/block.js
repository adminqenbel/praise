"use strict";

// This page is the 'door' a child sees. Its address carries what to show (mode=blocked) or asks for a check (mode=checking); the real decision always comes from the background worker.
const q = new URLSearchParams(location.search);
const target = q.get("u") || "";
const $ = (id) => document.getElementById(id);

// Child-friendly names for each category.
const CATEGORY_NAMES = {
  adult: "Adult content", gambling: "Gambling", betting: "Betting", drugs: "Drug-related content",
  violence: "Violent content", weapons: "Weapons", self_harm: "Self-harm content",
  banking: "Banking", payment: "Payment", upi: "UPI payment", digital_wallet: "Digital wallet",
  trading: "Trading", cryptocurrency: "Cryptocurrency", forex: "Forex trading", loans: "Loan",
  bnpl: "Buy-now-pay-later", financial_phishing: "Fake bank or payment",
  malware: "Malware", phishing: "Phishing", suspicious_domain: "Suspicious",
  dangerous_download: "Dangerous download", social_media: "Social media", dating: "Dating",
  gaming: "Gaming", streaming: "Streaming", shopping: "Shopping", scam: "Scam",
};

// Protections that aren't about a site's content get their own sentence.
const SPECIAL = {
  browser_installer: ["That download is closed",
    "Other browsers can't be installed on this device."],
  external_browser: ["That link wanted to open another browser",
    "Pages stay in this browser, so the link was stopped."],
  tamper: ["That page is for parents",
    "Only a parent can change browser settings and extensions."],
};

// While waiting for a parent, ask again every 8 seconds (only while the tab is visible).
const POLL_MS = 8000;
const buddy = PraiseBuddy.mount($("buddy"), {
  who: "family", base: "../companion/", height: window.innerWidth < 640 ? 190 : 300, mood: "thinking",
  talk: false, wander: window.innerWidth < 640 ? 0 : 50,      // plays and paces about, but never talks over the explanation
});
const started = Date.now();
let lastLine = "";
let polling = null;
let current = null;      // the decision being shown

// Dori says something suitable for the moment, never repeating the line just said.
function speak(kind, ctx = {}) {
  const s = PraiseCompanion.say("family", kind, { ...ctx, avoid: lastLine });
  lastLine = s.text;
  buddy.say(s.text, s.mood, kind);
  return s;
}

function safeTarget(url) {
  // Only ever navigate to a real web address: never javascript:, data: or file: URLs.
  return self.PraiseLib.normalizeDomain(url) ? url : null;
}

// Set the headline and sentence under it.
function show(state, title, lede) {
  $("stage").dataset.state = state;
  $("title").textContent = title;
  $("lede").textContent = lede;
  document.title = title;
}

// The screen shuts when a site is closed and slides apart when it opens.
function shutScreen() { $("curtain").dataset.shut = "true"; }
function openScreen() { $("curtain").dataset.shut = "open"; }

function isWaiting(d) { return d.action === "REVIEW" || d.action === "ASK"; }

// Show why a site is closed in plain words, say it with Dori, show the risk bar, and start polling when a parent might still say yes.
function renderBlocked(d) {
  current = d;
  const label = CATEGORY_NAMES[d.category];
  const waiting = isWaiting(d);

  if (SPECIAL[d.category]) {
    show("blocked", SPECIAL[d.category][0], SPECIAL[d.category][1]);
  } else if (d.offline) {
    show("blocked", "This door's closed for now",
      "We couldn't check this site just now, so it stays closed until we're back online.");
  } else if (waiting) {
    show("blocked", "Waiting for a parent to say yes",
      "This one's new, and a parent hasn't opened it yet.");
  } else if (label) {
    show("blocked", "This door's closed",
      `${label} sites are closed by your family's rules.`);
  } else {
    show("blocked", "This door's closed", "Your family's rules don't include this site.");
  }

  if (d.offline) speak("offline");
  else if (waiting) speak("waiting", { phase: "fresh" });
  else speak("closed", { category: d.category });

  if (d.domain) { $("site").textContent = d.domain; $("site").hidden = false; }

  const risk = Number(d.risk);
  if (d.risk !== "" && d.risk !== null && Number.isFinite(risk)) {
    const pct = Math.max(0, Math.min(100, risk));
    $("riskFill").style.width = pct + "%";
    $("riskText").textContent = `Risk score ${pct} out of 100`;
    $("risk").hidden = false;
  }
  $("actions").hidden = false;
  // Offline doors and pending reviews can open on their own: keep an eye out for that.
  if (waiting || d.offline) startPolling();
}

// ---- waiting for a yes -----------------------------------------------------------------------
function startPolling() {
  if (polling) return;
  polling = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
}

function stopPolling() { clearInterval(polling); polling = null; }

let checking = false;
// Ask the background worker again. If the site is now allowed, open it; if we are still offline, wait; after ten minutes of waiting, stop.
async function poll() {
  if (checking || document.visibilityState !== "visible") return;
  const url = safeTarget(target);
  if (!url) return stopPolling();
  const seconds = Math.round((Date.now() - started) / 1000);
  checking = true;
  try {
    const d = await chrome.runtime.sendMessage({ type: "recheck", url });
    if (d && d.action === "ALLOW") return approved(url);
    if (d && d.offline) return;       // still can't reach home: stay put
    if ($("stage").dataset.asked === "true") {
      speak("waiting", { seconds });
      if (PraiseCompanion.waitPhase(seconds) === "giveup") stopPolling();
    }
  } finally { checking = false; }
}

// A parent said yes: celebrate, slide the screen apart and open the site.
async function approved(url) {
  stopPolling();
  $("stage").dataset.state = "open";
  $("actions").hidden = true;
  show("open", "It's open!", "A parent said yes. Opening it for you.");
  speak("approved");
  await new Promise((r) => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 400 : 1700));
  openScreen();
  setTimeout(() => location.replace(url), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650);
}

$("back").addEventListener("click", () => {
  if (history.length > 1) history.back(); else window.close();
});

// 'Ask a parent': send an access request that shows up on the parent's dashboard.
$("ask").addEventListener("click", async () => {
  const btn = $("ask");
  btn.disabled = true;
  const domain = q.get("d") || "";
  const res = await chrome.runtime.sendMessage({ type: "access_request", domain });
  $("confirm").hidden = false;
  if (res && res.ok) {
    $("confirm").textContent = "Asked! Your parent will see it on their dashboard.";
    $("stage").dataset.asked = "true";
    speak("asked");
    startPolling();
  } else {
    $("confirm").textContent = "That didn't send. Check your connection and try again.";
    speak("error");
    btn.disabled = false;
  }
});

// Start-up: close the screen and bring Dori in. A 'checking' page asks the worker for a verdict, then opens the site or shows why it is closed.
async function main() {
  shutScreen();
  await buddy.enter();
  if (q.get("mode") === "blocked") {
    renderBlocked({
      action: q.get("a"), category: q.get("c"), risk: q.get("r"), domain: q.get("d"),
      offline: q.get("off") === "1",
    });
    return;
  }

  // mode=checking: ask the background worker, then either continue or show the block view.
  speak("checking");
  const url = safeTarget(target);
  if (!url) { show("blocked", "That address won't open", "It isn't a normal website address."); speak("error"); return; }
  const d = await chrome.runtime.sendMessage({ type: "resolve", url });
  if (d && d.action === "ALLOW") {
    speak("allowed");
    openScreen();
    setTimeout(() => location.replace(url), 450);
    return;
  }
  renderBlocked({
    action: (d && d.action) || "BLOCK", category: d && d.category,
    risk: d && d.risk != null ? d.risk : "", domain: d && d.domain, offline: !!(d && d.offline),
  });
}

main();
