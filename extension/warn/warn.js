"use strict";

// This page can be opened by any website, so nothing in the address is trusted. The address
// carries only a one-time token; the details come from the background worker, which knows
// only about warnings it issued itself.
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("n") || "";

// One-sentence reasons, keyed by category.
const LEDE = {
  scam: "It looks like a scam page.",
  phishing: "It may be pretending to be another site to steal your details.",
  financial_phishing: "It looks like a fake bank or payment page.",
  malware: "It's known to spread harmful software.",
  suspicious_domain: "Something about this address looks off.",
  dangerous_download: "It pushes dangerous downloads.",
};

// Ringo, the adult version's buddy.
const buddy = PraiseBuddy.mount($("buddy"), {
  who: "adult", base: "../companion/", height: window.innerWidth < 760 ? 150 : 250, mood: "thinking",
  talk: false, wander: window.innerWidth < 760 ? 0 : 36,
});
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
function speak(kind, ctx = {}) {
  const s = PraiseCompanion.say("adult", kind, ctx);
  buddy.say(s.text, s.mood, kind);
}

// The warning token is gone (too old or never issued): say so instead of showing anything made up.
function expired() {
  speak("error");
  $("title").textContent = "That warning has expired";
  document.title = $("title").textContent;
  $("lede").textContent = "Go back, and Praise Shield will check the page again if you return to it.";
}

// Fill the warning page from the details the background worker returned: title, reason, the site, up to four checks that were made, the real site when this looks like a copy, and Continue only when it is allowed.
function render(w) {
  const d = w.decision;
  const mode = d.action === "BLOCK" ? "blocked" : "warn";
  $("stage").dataset.mode = mode;
  $("title").textContent = mode === "blocked" ? "This page is blocked" : "This page looks risky";
  document.title = $("title").textContent;

  let lede = LEDE[d.category];
  if (!lede) lede = Number.isFinite(Number(d.risk)) && d.risk !== null ? `Our check scored it ${d.risk} out of 100 for risk.` : "Our check found signs of risk.";
  if (d.offline) lede = "We couldn't reach the server, so this is based on what was saved earlier. " + lede;
  $("lede").textContent = lede;

  if (d.domain) { $("site").textContent = d.domain; $("site").hidden = false; }

  const evidence = Array.isArray(d.evidence) ? d.evidence.slice(0, 4) : [];
  if (evidence.length) {
    $("why").replaceChildren(...evidence.map((t) => Object.assign(document.createElement("li"), { textContent: String(t) })));
    $("whyBox").hidden = false;
  }

  // A look-alike: offer the real site (a plain domain from the server's own brand list).
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d.suggest || "")) {
    $("real").textContent = `Go to ${d.suggest}`;
    $("real").href = "https://" + d.suggest + "/";
    $("real").hidden = false;
  }

  const can = !!d.can_continue && mode === "warn";
  speak(d.offline ? "offline" : mode === "blocked" ? "blocked" : "warn");
  $("go").hidden = !can;
  $("fine").hidden = !can;
}

$("back").addEventListener("click", () => {
  if (history.length > 1) history.back(); else window.close();
});

// 'Continue anyway' (warnings only, never blocks): the worker remembers the choice for an hour, then the page opens.
$("go").addEventListener("click", async () => {
  $("go").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "continue", n: token });
  if (res && res.ok && res.url) {
    speak("continued");
    $("shutter").dataset.shut = "down";            // the screen comes down as the page opens
    setTimeout(() => location.replace(res.url), reduced ? 200 : 1100);
  } else $("go").disabled = false;
});

// Start-up: bring Ringo in and ask the worker for this warning's details using the one-time token.
(async () => {
  await buddy.enter();
  const w = await chrome.runtime.sendMessage({ type: "warning", n: token });
  if (w && w.decision) render(w); else expired();
})();
