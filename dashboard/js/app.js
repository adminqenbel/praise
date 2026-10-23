"use strict";

// Shared shell: DOM helpers, auth screen, navigation rail, toast, formatting.
const NS = "http://www.w3.org/2000/svg";

// h("div", {class: "x", onclick: fn}, child, "text", ...) — builds DOM without innerHTML,
// so server data can never be interpreted as markup.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Parse a fixed SVG string we wrote ourselves into a node (never used with server data).
function svg(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

// A child's door: porch lamp on top (lit when their browser is online), coloured leaf, round knob.
// Colours come from CSS (--door), so one drawing serves every child.
const DOOR_PATHS = `
  <circle class="lamp-halo" cx="80" cy="30" r="26"/>
  <path class="lamp-cap" d="M68 8h24l-3 12H71z"/>
  <circle class="lamp-glow" cx="80" cy="30" r="9"/>
  <path class="door-frame" d="M8 230V104C8 66 38 46 80 46s72 20 72 58v126z"/>
  <path class="door-leaf" d="M22 230V106C22 78 46 60 80 60s58 18 58 46v124z"/>
  <defs><linearGradient id="gloss" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
  <path class="door-gloss" d="M22 230V106C22 78 46 60 80 60s58 18 58 46v124z" fill="url(#gloss)"/>
  <path class="door-panel" d="M40 214V112c0-16 17-28 40-28s40 12 40 28v102z"/>
  <circle class="knob" cx="118" cy="160" r="7.5"/>
  <rect class="mat" x="26" y="226" width="108" height="7" rx="3.5"/>`;

const doorSvg = () => svg(`<svg viewBox="0 0 160 236" aria-hidden="true">${DOOR_PATHS}</svg>`);

// Each child keeps one colour everywhere (door, dots) so families can tell them apart at a glance.
const CHILD_HUES = ["#e8508a", "#2fbf9b", "#4a8fe7", "#8b5cf6", "#f08a24"];
const childHue = (id) => CHILD_HUES[Math.abs(Number(id) || 0) % CHILD_HUES.length];

// Time-of-day greeting for the home page.
function greeting(now = new Date()) {
  const hr = now.getHours();
  return hr < 5 ? "Still up?" : hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";
}

// Plain-language names for the category codes the server uses.
const CATEGORY_LABELS = {
  adult: "Adult content", gambling: "Gambling", betting: "Betting", drugs: "Drugs",
  violence: "Violence", weapons: "Weapons", self_harm: "Self-harm",
  banking: "Banking", payment: "Payments", upi: "UPI", digital_wallet: "Digital wallets",
  trading: "Trading", cryptocurrency: "Cryptocurrency", forex: "Forex", loans: "Loans", bnpl: "Buy now, pay later",
  financial_phishing: "Fake bank or payment sites", malware: "Malware", phishing: "Phishing",
  suspicious_domain: "Suspicious domains", scam: "Scams", dangerous_download: "Dangerous downloads",
  social_media: "Social media", dating: "Dating", gaming: "Gaming", streaming: "Streaming",
  shopping: "Shopping", education: "Education", research: "Research", general: "General", custom: "Custom",
};
const GROUP_LABELS = { content: "Content", financial: "Money and trading", security: "Security", general: "Everyday sites" };
const catLabel = (c) => CATEGORY_LABELS[c] || (c ? c.replace(/_/g, " ") : "Not classified yet");

// Plain-language names for a site's lifecycle status.
const STATUS_LABELS = {
  UNKNOWN: "Not checked", AI_CLASSIFIED: "AI suggestion", PENDING_REVIEW: "Waiting for review",
  ADMIN_VERIFIED: "Verified", DISPUTED: "Disputed", RECLASSIFIED: "Reclassified", REVIEW_REQUIRED: "Needs another look",
};
const statusLabel = (s) => STATUS_LABELS[s] || s;

// '1 minute' / '2 minutes' helper.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

// '3 hours ago' style time for lists.
function timeAgo(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return plural(Math.round(s / 60), "minute") + " ago";
  if (s < 86400) return plural(Math.round(s / 3600), "hour") + " ago";
  return plural(Math.round(s / 86400), "day") + " ago";
}

// A small bar for a 0-100 risk score; red from 70 up.
function riskBar(risk) {
  if (risk == null) return h("span", { class: "muted" }, "No score");
  return h("div", { class: "riskcell" },
    h("div", { class: "bar" + (risk >= 70 ? " hot" : "") }, h("span", { style: `width:${Math.min(100, risk)}%` })),
    h("span", { class: "num" }, risk));
}

let toastTimer;
// Short message at the bottom of the screen; errors stay longer.
function toast(message, bad = false) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast" + (bad ? " bad" : ""), role: "status" }, message);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 2800);
}

// Wrap an async action: disable the button, toast success/failure.
async function act(button, fn, okMessage) {
  if (button) button.disabled = true;
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    return out;
  } catch (e) {
    toast(e.message || "Something went wrong.", true);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// Friendly placeholder when a list has nothing to show, with a hint on what to do.
function emptyState(title, text, action) {
  return h("div", { class: "empty" }, h("strong", null, title), text, action ? h("div", { style: "margin-top:.8rem" }, action) : null);
}

// The 'All children' drop-down used by the activity and cookie pages.
function childSelect(children, current, onChange, allLabel = "All children") {
  const sel = h("select", { "aria-label": "Child", onchange: (e) => onChange(e.target.value) },
    h("option", { value: "" }, allLabel),
    children.map((c) => h("option", { value: c.id, selected: String(c.id) === String(current) }, c.name)));
  return sel;
}

// A colour from the page's current theme (so charts follow the family look, or the personal one in light or dark).
const themeVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

// Draw a Chart.js chart. Chart.js loads on first use (it is a big script); if it can't, say so instead of leaving a hole.
let chartLoad = null;
function drawChart(canvas, config) {
  if (typeof Chart === "undefined") {
    chartLoad = chartLoad || loadScript(CHART_SRC);
    const sorry = () => canvas.replaceWith(h("p", { class: "muted" }, "The chart couldn't load. Check your connection and reload."));
    chartLoad.then(() => (typeof Chart === "undefined" ? sorry() : drawChart(canvas, config)), sorry);
    return;
  }
  Chart.defaults.font.family = themeVar("--body") || '"Segoe UI", system-ui, sans-serif';
  Chart.defaults.color = themeVar("--text2") || "#5d5470";
  Chart.defaults.borderColor = themeVar("--line") || "rgba(0,0,0,.1)";
  new Chart(canvas, config);
}

// ---- navigation ---------------------------------------------------------------------------
// Line icons for the navigation (24 px grid, drawn in the text colour).
const ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5.5H9V20H5a1 1 0 0 1-1-1z"/>',
  children: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9.5" r="2.4"/><path d="M17 14.2c2.4.2 4.5 2.1 4.5 5.1"/>',
  rules: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
  activity: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  sites: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  cookies: '<path d="M12 3a9 9 0 1 0 9 9 4 4 0 0 1-4-4 4 4 0 0 1-5-5z"/><circle cx="9" cy="10" r=".6"/><circle cx="12.5" cy="14.5" r=".6"/><circle cx="8.5" cy="14.5" r=".6"/>',
  browsers: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8 20h8M12 16.5V20"/>',
  review: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9.5 4V3h5v1M9 13l2 2 4-4"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
  out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h11"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};
const icon = (name) => svg(`<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);

// [page, label, icon] for the family dashboard and for the adult one.
const NAV = [
  ["home.html", "Home", "home"], ["children.html", "Children", "children"], ["policies.html", "Rules", "rules"],
  ["events.html", "Activity", "activity"], ["sites.html", "Sites", "sites"], ["cookies.html", "Cookies", "cookies"],
];

const NAV_ADULT = [
  ["home.html", "Home", "home"], ["policies.html", "My protection", "shield"], ["events.html", "Activity", "activity"],
  ["cookies.html", "Cookies", "cookies"], ["sites.html", "Sites", "sites"], ["children.html", "My browsers", "browsers"],
];

// The phone's tab bar has room for four pages and a More button; the rest wait behind it.
const TABS_PRIMARY = { family: ["home.html", "children.html", "policies.html", "events.html"],
                       adult: ["home.html", "policies.html", "events.html", "children.html"] };

// ---- light and dark (personal space only: red and white by day, red and black by night) ------------------------------
// js/theme.js applies a saved choice before the page paints; with none, the device's setting decides.
const MODE_KEY = "praise.mode";
const effectiveMode = () => document.documentElement.dataset.mode ||
  (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

// Colour of the phone's browser bar, from the page's own --chrome variable.
function syncThemeColor() {
  let meta = document.querySelector("meta[name=theme-color]");
  if (!meta) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.append(meta); }
  const c = getComputedStyle(document.body).getPropertyValue("--chrome").trim();
  if (c) meta.content = c;
}

function setMode(mode) {
  document.documentElement.dataset.mode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* private window: the choice lasts until the tab closes */ }
  syncThemeColor();
}

// A button that flips between the light and dark look; its icon and name always say what it will do next.
function modeButton() {
  const btn = h("button", { type: "button", class: "quiet mode" });
  btn.repaint = () => {
    const dark = effectiveMode() === "dark";
    btn.replaceChildren(icon(dark ? "sun" : "moon"), h("span", null, dark ? "Light theme" : "Dark theme"));
    btn.setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
  };
  btn.addEventListener("click", () => {
    setMode(effectiveMode() === "dark" ? "light" : "dark");
    document.querySelectorAll("button.mode").forEach((b) => b.repaint());
    setTimeout(() => Praise.refresh(), 60);                       // charts take their colours when drawn
  });
  btn.repaint();
  return btn;
}

// ---- spaces: one login, a family and a personal version ----------------------------------------------------------------
// The switch sits in every dashboard. A space the login doesn't have yet reads "+ Just me" / "+ Family" and asks before it
// adds anything, so a stray click never creates a profile.
const SPACE_LABEL = { family: "Family", adult: "Just me" };
const SPACE_ASK = {
  adult: ["Add Praise Shield for yourself?",
    "Same email, same password. Your family space stays exactly as it is. This adds a personal space with its own rules, its own browsers and its own activity.",
    "Add Praise Shield"],
  family: ["Add a family space?",
    "Same email, same password. Your personal space stays exactly as it is. This adds a place to set rules for your children's browsers and to say yes when they ask to open something.",
    "Add family space"],
};

// Small dialog that asks before a second space is created. Escape or 'Not now' cancels.
function confirmAddSpace(space) {
  const [title, text, yes] = SPACE_ASK[space];
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const done = (ok) => { document.removeEventListener("keydown", onKey, true); back.remove(); if (opener && opener.focus) opener.focus(); resolve(ok); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(false); } };
    const go = h("button", { type: "button", onclick: () => done(true) }, yes);
    const back = h("div", { class: "modal-back", onclick: (e) => { if (e.target === back) done(false); } },
      h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modalTitle" },
        h("h2", { id: "modalTitle" }, title), h("p", null, text),
        h("div", { class: "modal-actions" }, h("button", { type: "button", class: "ghost", onclick: () => done(false) }, "Not now"), go)));
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    go.focus();
  });
}

// Switch between the family and personal spaces. A space the login already has switches at once: the other look is built
// from what this tab already fetched, and the server hears about the choice in the background. Adding a space waits for
// the server, because it has to exist before anything can be read from it.
async function changeSpace(space, exists) {
  if (!exists && !(await confirmAddSpace(space))) return;
  const live = Praise.live;
  if (!live) return;
  try {
    if (exists) {
      const me = { user: { ...live.user, account_type: space }, google_enabled: live.google };
      Api.saveMe({ ...Api.savedMe(), user: me.user });
      Praise.swap(me, "home.html");
      Api.post("/api/auth/space", { space }).catch(() => toast("Couldn't save that choice. This tab keeps showing it.", true));
    } else {
      const out = await Api.post("/api/auth/space", { space, enable: true });
      const me = { user: out.user, csrf: out.csrf, google_enabled: live.google };
      Api.saveMe({ ...Api.savedMe(), ...me });
      Praise.swap(me, "home.html");
    }
  } catch (e) { toast(e.message || "Couldn't switch. Try again.", true); }
}

// The Family | Just me switch shown in the top bar.
function spaceSwitch(user) {
  const has = user.spaces || [user.account_type];
  const btn = (space) => {
    const exists = has.includes(space), current = space === user.account_type;
    return h("button", {
      type: "button", class: "space" + (current ? " current" : "") + (exists ? "" : " add"), "aria-pressed": current ? "true" : "false",
      title: exists ? "" : `Set up your ${space === "adult" ? "personal" : "family"} space`,
      onclick: () => { if (!current) changeSpace(space, exists); },
    }, (exists ? "" : "+ ") + SPACE_LABEL[space]);
  };
  return h("div", { class: "spaces", role: "group", "aria-label": "Switch between your family and personal spaces" }, btn("family"), btn("adult"));
}

// The pages for this account, in menu order. Admins also get the Review queue.
function navFor(user) {
  const links = (user.account_type === "adult" ? NAV_ADULT : NAV).slice();
  if (user.role === "admin") links.push(["reviews.html", "Review queue", "review"]);
  return links;
}

// Build the shell: the top bar (a sidebar in the personal space), the content area, the phone's tab bar and its More sheet.
// A login without Google gets "Connect Google" when the server has Google sign-in set up.
function buildShell(user, page, { logout, googleOn }) {
  const adult = user.account_type === "adult";
  const links = navFor(user);
  const primary = TABS_PRIMARY[adult ? "adult" : "family"];
  const link = ([href, label, ic]) => h("a", { href, "aria-current": href === page ? "page" : false }, icon(ic), h("span", null, label));

  // Sign out, connect Google and the theme switch appear in the top bar on a computer and in the More sheet on a phone.
  const actions = () => [
    adult ? modeButton() : null,
    googleOn && !user.google
      ? h("button", { type: "button", class: "quiet", onclick: () => { location.href = googleUrl({ link: 1, next: page }); } }, icon("link"), h("span", null, "Connect Google")) : null,
    h("button", { type: "button", class: "quiet signout", onclick: logout }, icon("out"), h("span", null, "Sign out")),
  ];

  const bar = h("header", { class: "topbar" },
    h("a", { class: "brand", href: "home.html" },
      adult
        ? svg(`<svg viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="26" stroke-linecap="round" aria-hidden="true"><path d="M 28 62 A 80 80 0 0 1 82 21"/><path d="M 135 21 A 80 80 0 0 1 179 62"/><path d="M 179 138 A 80 80 0 0 1 138 179"/><path d="M 62 179 A 80 80 0 0 1 21 138"/></svg>`)
        : svg(`<svg viewBox="0 0 24 30" aria-hidden="true"><path fill="#6d44e0" d="M2 30V12C2 5 7 1 12 1s10 4 10 11v18z"/><circle cx="16.5" cy="19" r="2.4" fill="#ffb627"/></svg>`),
      h("span", null, adult ? "Praise Shield" : "Praise")),
    spaceSwitch(user),
    h("nav", { "aria-label": "Main" }, links.map(link)),
    h("div", { class: "who" }, h("span", { class: "email" }, user.email), actions()));

  const main = h("main", { class: "main", id: "main" });

  // Phone: four tabs and More.
  const tabLinks = links.filter(([href]) => primary.includes(href));
  const rest = links.filter(([href]) => !primary.includes(href));
  const sheet = h("div", { class: "sheet-back", hidden: true, onclick: (e) => { if (e.target === sheet) closeSheet(); } },
    h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "More" },
      h("p", { class: "sheet-who" }, user.email),
      h("nav", { "aria-label": "More pages" }, rest.map(link)),
      h("div", { class: "sheet-actions" }, actions())));
  const more = h("button", { type: "button", class: "tab more", "aria-haspopup": "dialog", onclick: () => openSheet() }, icon("more"), h("span", null, "More"));
  const tabbar = h("nav", { class: "tabbar", "aria-label": "Main" },
    tabLinks.map(([href, label, ic]) => h("a", { class: "tab", href, "aria-current": href === page ? "page" : false }, icon(ic), h("span", null, label))), more);
  function openSheet() { sheet.hidden = false; sheet.querySelector("a, button").focus(); document.addEventListener("keydown", onKey, true); }
  function closeSheet() { sheet.hidden = true; document.removeEventListener("keydown", onKey, true); more.focus(); }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); closeSheet(); } }
  sheet.addEventListener("click", (e) => { if (e.target.closest("a")) { sheet.hidden = true; document.removeEventListener("keydown", onKey, true); } });

  return { el: h("div", { class: "shell" }, bar, main, tabbar, sheet), bar, main, more, sheet };
}

// The "Praise" mark with its two dots, linking back to the landing hub.
const wordmark = () => h("a", { class: "wordmark", href: "index.html", "aria-label": "Praise, all versions" },
  "Praise ", h("span", { class: "dots", "aria-hidden": "true" }, h("i"), h("i")));

// ---- waiting for the server ---------------------------------------------------------------------
// The API sleeps when idle and takes up to a minute to wake, so the first page of a visit can be slow. This fills the
// screen meanwhile, so nobody stares at a blank page. `stop()` ends its clock once something else takes the screen.
function waitScreen() {
  const started = Date.now();
  const title = h("h1", null, "Getting Praise ready");
  const note = h("p", { class: "wait-note", role: "status", "aria-live": "polite" }, "One moment.");
  const el = h("div", { class: "wait" }, wordmark(), title, note, h("div", { class: "wait-bar", "aria-hidden": "true" }, h("i")));
  const words = () => {
    const sec = Math.round((Date.now() - started) / 1000);
    note.textContent = sec < 6 ? "One moment."
      : "Praise's server was resting and is waking up. The first visit after a quiet spell can take up to a minute. You don't need to do anything.";
  };
  const clock = setInterval(words, 1000);
  words();
  return { el, stop: () => clearInterval(clock) };
}

// Shown when the server still hasn't answered after the wait.
function waitFailed() {
  return h("div", { class: "wait" }, wordmark(), h("h1", null, "Praise isn't answering"),
    h("p", { class: "wait-note" }, "Check your internet connection, then try again. If it keeps happening, the service may be down for a short while."),
    h("button", { type: "button", onclick: () => location.reload() }, "Try again"));
}

// ---- Google sign-in ----------------------------------------------------------------------------
// A full page visit to the API, which sends the browser to Google and back to `next` (a page of this dashboard).
// Anything that went wrong comes back as ?google_error=<reason>.
const googleUrl = (params) => Api.base + "/api/auth/google/start?" + new URLSearchParams(params);
const GOOGLE_ERRORS = {
  unavailable: "Google sign-in isn't set up on this server yet. Use your email and password.",
  cancelled: "Google sign-in was cancelled.",
  expired: "That Google sign-in took too long, or finished in a different browser. Try again.",
  failed: "Google couldn't confirm the sign-in. Try again.",
  unverified: "Google hasn't verified that email address, so it can't open an account.",
  email_exists: "That email already has an account. Sign in with its password, then use \"Connect Google\" at the top.",
  in_use: "That Google account is already connected to a different Praise login.",
  signed_out: "You were signed out. Sign in again, then connect Google.",
};

// Read and remove ?google_error from the address, so a reload doesn't show it again.
function takeGoogleError() {
  const params = new URLSearchParams(location.search);
  const code = params.get("google_error");
  if (!code) return null;
  params.delete("google_error");
  history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
  return GOOGLE_ERRORS[code] || "Google sign-in didn't work. Try again.";
}

// ---- auth screen -----------------------------------------------------------------------------
// Sign-in and create-account form. Creating an account also asks whether it is for a family or just for the person.
function authScreen(onDone) {
  let mode = "login";
  const email = h("input", { id: "email", type: "email", autocomplete: "email", required: true });
  const password = h("input", { id: "password", type: "password", required: true, autocomplete: "current-password", minlength: 8 });
  // Sign-up only: who is this account for? (We don't know before they choose.)
  const kind = h("fieldset", { class: "kind", hidden: true },
    h("legend", null, "This account is for"),
    h("label", { class: "switch" }, h("input", { type: "radio", name: "acct", value: "family", checked: true }), "My family: I set rules for my children"),
    h("label", { class: "switch" }, h("input", { type: "radio", name: "acct", value: "adult" }), "Just me: protect my own browsing"));
  const error = h("p", { class: "err", role: "alert", hidden: true });
  const submit = h("button", { type: "submit" }, "Sign in");
  const title = h("h1", null, "Sign in");
  const lede = h("p", { class: "lede-a" }, "Welcome back.");
  const toggle = h("button", { type: "button" }, "Create an account");
  const toggleText = h("p", { class: "switch-mode" }, "New here? ", toggle);

  const WORDS = {
    login: ["Sign in", "Welcome back."],
    family: ["Set up your family", "Make rules for your children, and say yes when they ask to open something."],
    adult: ["Protect your own browsing", "Get warned about scams and fake pages, keep trackers out, and stay in charge of every setting."],
  };
  const words = () => (mode === "login" ? WORDS.login : WORDS[kind.querySelector("input[name=acct]:checked").value]);
  const syncWords = () => { const [t, l] = words(); title.textContent = t; lede.textContent = l; document.title = t + " - Praise"; };

  toggle.addEventListener("click", () => {
    mode = mode === "login" ? "register" : "login";
    const reg = mode === "register";
    submit.textContent = reg ? "Create account" : "Sign in";
    password.autocomplete = reg ? "new-password" : "current-password";
    toggle.textContent = reg ? "Sign in instead" : "Create an account";
    toggleText.firstChild.textContent = reg ? "Already have an account? " : "New here? ";
    kind.hidden = !reg;
    error.hidden = true;
    syncWords();
  });
  kind.addEventListener("change", syncWords);

  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        await Api.post(mode === "login" ? "/api/auth/login" : "/api/auth/register",
          { email: email.value, password: password.value,
            ...(mode === "register" ? { account_type: form.querySelector("input[name=acct]:checked").value } : {}) });
        onDone();
      } catch (err) {
        error.textContent = err.status === 401 ? "That email and password don't match. If you signed up with Google, use Continue with Google."
          : err.status === 409 ? "That email already has an account. Sign in, then use the switch at the top to add the other kind."
          : err.message;
        error.hidden = false;
      } finally { submit.disabled = false; }
    },
  },
  h("div", { class: "field" }, h("label", { for: "email" }, "Email"), email),
  h("div", { class: "field" }, h("label", { for: "password" }, "Password"), password),
  kind, error, submit);

  // Google: signs in an existing Google login, or opens a new account of the kind chosen above.
  const google = h("button", { type: "button", class: "google", onclick: () => {
    const space = mode === "register" ? kind.querySelector("input[name=acct]:checked").value : "family";
    location.href = googleUrl({ space, next: pageFile(location.href) });
  } }, "Continue with Google");

  // Links from the landing pages open the form in sign-up mode, with the right choice selected.
  const params = new URLSearchParams(location.search);
  if (params.has("signup")) toggle.click();
  if (params.get("for") === "adult" || params.get("for") === "family") {
    kind.querySelector(`input[value=${params.get("for")}]`).checked = true;
    syncWords();
  }
  const googleError = takeGoogleError();
  if (googleError) { error.textContent = googleError; error.hidden = false; }

  return h("div", { class: "auth" }, h("div", { class: "auth-card" }, wordmark(), title, lede, form,
    h("p", { class: "or" }, "or"), google, toggleText));
}

// ---- entry point ---------------------------------------------------------------------------------
// Each page's script calls Praise.start("children.html", async (main, ctx) => { ... }). The first call puts the shell (top bar
// or sidebar) on screen. After that, moving between pages does not reload anything: the shell stays where it is and only the
// page's content is swapped, so the tabs feel instant and nothing flashes. A page that wants to clean up when it is left
// (stop a timer, remove a mascot) calls Praise.onLeave(fn) while it renders.
//
// Three things keep it quick even though the server is far away and may be asleep:
//   - reads are cached (api.js), and the pages' first reads are fetched in the background once the shell is up, for the
//     other space too, so a click shows its page from memory;
//   - a tab that has seen the account before paints the shell from the copy it kept and checks in the background;
//   - a page that has to wait shows a placeholder at once instead of a blank.

// Which script(s) draw each page, so a page can be brought in the first time it is opened. `chart` pages need Chart.js.
const PAGE_SPECS = {
  "home.html": { scripts: ["js/ring.js", "js/companion.js", "js/companion-ui.js", "js/chat-ui.js", "js/dashboard.js"], styles: ["css/companion.css"], chart: true },
  "children.html": { scripts: ["js/children.js"] },
  "policies.html": { scripts: ["js/policies.js"] },
  "events.html": { scripts: ["js/events.js"] },
  "sites.html": { scripts: ["js/sites.js"] },
  "cookies.html": { scripts: ["js/cookies.js"], chart: true },
  "reviews.html": { scripts: ["js/reviews.js"] },
};
const CHART_SRC = "vendor/chart.umd.js";   // Chart.js 4.4.1, vendored: the CSP allows scripts from this site only

// What each space's pages read first. These must be spelled exactly as the pages ask for them, or the copy isn't found.
const PREFETCH = {
  family: ["/api/children", "/api/policies", "/api/stats?days=7", "/api/events?kind=browser&type=access_request&limit=20",
    "/api/events?kind=browser&limit=100", "/api/events?kind=browser&limit=50", "/api/meta/categories", "/api/sites?limit=100"],
  adult: ["/api/children", "/api/policies", "/api/stats?days=7", "/api/events?kind=security&limit=100", "/api/meta/categories", "/api/sites?limit=100"],
};
const pageFile = (url) => new URL(url, location.href).pathname.split("/").pop();

// Load a stylesheet once; a missing file does not stop the page.
function loadStyle(href) {
  const have = [...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.getAttribute("href").split("?")[0] === href);
  if (have) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href + "?v=b4";
    l.onload = l.onerror = resolve;                               // a missing stylesheet must not stop the page
    document.head.append(l);
  });
}

// Load a page's script once (with a version in the URL so updates are picked up).
function loadScript(src) {
  const have = [...document.querySelectorAll("script[src]")].some((s) => s.getAttribute("src").split("?")[0] === src);
  if (have) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src.startsWith("http") ? src : src + "?v=b4";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load " + src));
    document.head.append(s);
  });
}

// Everything a page needs to draw, loaded (scripts register their page with Praise.start; that doesn't show it unless it is the target).
async function loadPage(file) {
  const spec = PAGE_SPECS[file];
  for (const css of spec.styles || []) await loadStyle(css);
  if (spec.chart && typeof Chart === "undefined") { try { await loadScript(CHART_SRC); } catch (e) { /* charts say so themselves */ } }
  for (const s of spec.scripts) await loadScript(s);
}

// Grey shapes that stand in for a page while its data is on the way. They appear only if the wait is noticeable (css).
function skeleton() {
  return h("div", { class: "skeleton", "aria-hidden": "true" },
    h("i", { class: "sk sk-title" }), h("i", { class: "sk sk-line" }),
    h("i", { class: "sk sk-block" }), h("i", { class: "sk sk-block" }), h("i", { class: "sk sk-block short" }));
}

// On a phone a table becomes a stack of cards, each value labelled by its column; the label comes from the header text.
function labelTables(root) {
  for (const t of root.querySelectorAll("table")) {
    const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    if (!heads.length) continue;
    for (const tr of t.querySelectorAll("tbody tr")) [...tr.children].forEach((td, i) => { if (!td.dataset.label && heads[i]) td.dataset.label = heads[i]; });
  }
}

// The dashboard's page manager: shows the shell, swaps page content without reloading, and runs each page's cleanup when it is left.
const Praise = {
  live: null,          // { user, google, shell, bar, main, page, leave: [], busy } while the shell is on screen
  pages: {},           // page -> { render, opts }, filled as each page's script runs
  target: null,        // the page being navigated to (a slow script load can't overrule a newer click)

  onLeave(fn) { if (this.live) this.live.leave.push(fn); },

  // Called by each page script. First call: find out who is signed in (or show the sign-in form) and build the shell. Later calls: just show the page.
  async start(page, render, opts = {}) {
    this.pages[page] = { render, opts };
    if (this.live) {                                              // shell already on screen: swap only the content
      if (!this.target || this.target === page) await this.show(page);
      return;
    }
    this.target = page;
    document.body.replaceChildren();
    document.documentElement.dataset.theme = "neutral";          // until we know which version this account is
    const saved = Api.savedMe();
    if (saved && saved.user) {                                    // this tab has seen the account: paint now, confirm in the background
      Api.useMe(saved);
      const shown = this.mount(saved, page);
      this.verify(saved);
      await shown;
      return;
    }
    let me;
    // A quick answer shows nothing extra; a slow one (a sleeping server) shows the waiting screen after a second.
    const wait = waitScreen();
    const late = setTimeout(() => document.body.replaceChildren(wait.el), 1000);
    try { me = await Api.whoAmI(); }
    catch (e) {
      if (e.status !== 401) {
        document.body.replaceChildren(e.status ? h("p", { class: "err", style: "padding:2rem" }, e.message) : waitFailed());
        return;
      }
    } finally { clearTimeout(late); wait.stop(); }
    document.body.replaceChildren();
    if (!me) { document.body.append(authScreen(() => Praise.start(page, render, opts))); return; }
    await this.mount(me, page);
  },

  // Build the shell for this account and show `page` in it.
  async mount(me, page) {
    const user = me.user;
    Api.setSpace(user.account_type);
    document.documentElement.dataset.theme = user.account_type === "adult" ? "adult" : "family";
    document.body.replaceChildren();
    const built = buildShell(user, page, {
      logout: async () => { try { await Api.post("/api/auth/logout"); } finally { Api.reset(); location.href = "index.html"; } },
      googleOn: me.google_enabled,
    });
    document.body.append(built.el);
    syncThemeColor();
    const googleError = takeGoogleError();                       // from "Connect Google"
    if (googleError) toast(googleError, true);
    this.live = { user, google: me.google_enabled, shell: built.el, bar: built.bar, main: built.main, page, leave: [], busy: false, refreshing: null, watcher: null };
    this.title(page);
    this.warm(user);
    if (!this.pages[page]) {                                      // its script isn't here yet: it shows itself when it arrives
      built.main.classList.add("is-loading");
      built.main.append(skeleton());
      loadPage(page).catch(() => { location.href = page; });
      return;
    }
    await this.run(page);
  },

  // Check in the background that the copy this tab kept is still right: still signed in, same spaces, same details.
  async verify(saved) {
    try {
      const me = await Api.whoAmI();
      const same = (a, b) => JSON.stringify([a.user, a.google_enabled]) === JSON.stringify([b.user, b.google_enabled]);
      // Which space this tab shows is its own business (a switch in another tab saved a different one).
      const mine = this.live && this.live.user.account_type;
      if (mine) Api.setSpace(mine);
      const fresh = mine ? { ...me, user: { ...me.user, account_type: mine } } : me;
      if (this.live && !same(fresh, { user: this.live.user, google_enabled: this.live.google })) this.swap(fresh, this.live.page);
      Api.saveMe({ ...me, user: fresh.user });
    } catch (e) { if (e.status === 401) this.signedOut(); }
  },

  // The session has ended: show the sign-in form, and come back to this page after it.
  signedOut() {
    const page = this.live ? this.live.page : this.target;
    if (this.live) for (const fn of this.live.leave.splice(0)) { try { fn(); } catch (e) { /* ignore */ } }
    this.live = null;
    Api.reset();
    const entry = this.pages[page];
    document.documentElement.dataset.theme = "neutral";
    document.body.replaceChildren(authScreen(() => entry ? Praise.start(page, entry.render, entry.opts) : location.reload()));
  },

  title(page) {
    const { user, bar } = this.live;
    const link = [...bar.querySelectorAll("nav a")].find((a) => pageFile(a.href) === page);
    const brand = user.account_type === "adult" ? "Praise Shield" : "Praise";
    document.title = (link ? link.textContent + " - " : "") + brand;
  },

  // Fetch in the background what the other pages will ask for, and the other space's too, once the browser is idle.
  warm(user) {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
    const mine = user.account_type, other = (user.spaces || []).find((s) => s !== mine);
    idle(async () => {
      await Api.prefetch(PREFETCH[mine], { space: mine });
      for (const file of Object.keys(PAGE_SPECS)) {
        if (this.pages[file] || (file === "reviews.html" && user.role !== "admin")) continue;
        try { await loadPage(file); } catch (e) { /* loaded when it is opened */ }
      }
      if (other) await Api.prefetch(PREFETCH[other], { space: other });
    }, { timeout: 3000 });
  },

  // Run a page's render function. The page draws into the content area while a placeholder stands in for it, then the
  // placeholder goes and the page appears all at once. Administrator-only pages are refused for everyone else, and errors are
  // shown instead of a blank screen.
  async run(page) {
    const live = this.live, main = live.main, { render, opts } = this.pages[page];
    if (opts.adminOnly && live.user.role !== "admin") {
      main.append(emptyState("This page is for administrators", "Ask the person who runs this system to review sites."));
      return;
    }
    const holder = skeleton();
    main.classList.add("is-loading");
    main.setAttribute("aria-busy", "true");
    main.prepend(holder);
    live.busy = true;
    this.watch(main);
    try { await render(main, { user: live.user }); }
    catch (e) {
      if (e.status === 401) { this.signedOut(); return; }
      main.append(h("p", { class: "err" }, e.message || "Something went wrong loading this page."));
    } finally {
      holder.remove();
      main.classList.remove("is-loading");
      main.removeAttribute("aria-busy");
      if (live.main === main) {
        live.busy = false; labelTables(main);
        if (live.dirty) { live.dirty = false; this.refresh(); }
      }
    }
  },

  // Keep an eye on a content area: note when the person starts typing (a redraw must not eat it), and label new tables.
  watch(main) {
    const live = this.live;
    if (live.watcher) live.watcher.disconnect();
    const note = () => { main.dataset.touched = "1"; };
    main.addEventListener("input", note, true);
    main.addEventListener("change", note, true);
    live.watcher = new MutationObserver(() => labelTables(main));
    live.watcher.observe(main, { childList: true, subtree: true });
  },

  // Swap the content area for another page: run the old page's cleanup, update the active link and title, then render.
  async show(page) {
    const live = this.live;
    this.cancelRefresh();
    for (const fn of live.leave.splice(0)) { try { fn(); } catch (e) { /* a page's cleanup must not stop navigation */ } }
    const main = h("main", { class: "main", id: "main" });
    live.main.replaceWith(main);                                  // a slow page still drawing into the old one can't spoil this one
    live.main = main;
    live.page = page;
    for (const a of live.shell.querySelectorAll("nav a")) {
      if (pageFile(a.href) === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    const inMore = live.shell.querySelector(".sheet a[aria-current=page]");
    live.shell.querySelector(".tab.more").classList.toggle("on", !!inMore);
    this.title(page);
    window.scrollTo(0, 0);
    await this.run(page);
  },

  // The data this page showed has changed on the server: draw it again off screen, then swap it in, unless the person is
  // in the middle of something (typing, a dialog open), in which case the page stays as it is until they move on.
  async refresh() {
    const live = this.live;
    if (live && live.busy) live.dirty = true;                     // asked mid-draw: redraw as soon as this one finishes
    if (!live || live.busy || live.refreshing || live.main.dataset.touched || document.querySelector(".modal-back, .sheet-back:not([hidden])")) return;
    const page = live.page, entry = this.pages[page];
    if (!entry || (entry.opts.adminOnly && live.user.role !== "admin")) return;
    const fresh = h("main", { class: "main", id: "main" });
    const stage = h("div", { class: "stage", "aria-hidden": "true", style: `width:${live.main.clientWidth}px` }, fresh);
    document.body.append(stage);
    const job = { stage, old: live.leave.splice(0), cancelled: false };
    live.refreshing = job;
    let failed = false;
    try { await entry.render(fresh, { user: live.user }); } catch (e) { failed = true; }
    if (job.cancelled) return;                                    // the person moved on; show() already cleaned up
    live.refreshing = null;
    stage.remove();
    if (failed) { live.leave.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }); live.leave.push(...job.old); return; }
    job.old.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    const scroll = window.scrollY;
    live.main.replaceWith(fresh);
    live.main = fresh;
    this.watch(fresh);
    labelTables(fresh);
    window.scrollTo(0, scroll);
  },

  // Called when a page is left while a refresh is drawing: its old content's cleanup still has to run, and the draft is dropped.
  cancelRefresh() {
    const job = this.live && this.live.refreshing;
    if (!job) return;
    job.cancelled = true;
    job.stage.remove();
    job.old.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    this.live.refreshing = null;
  },

  // Move to another page without reloading. Anything that isn't one of our pages loads normally.
  async go(href, push = true) {
    const file = pageFile(href);
    if (!this.live || !PAGE_SPECS[file]) { location.href = href; return; }
    this.target = file;
    if (push) history.pushState(null, "", new URL(href, location.href).pathname + new URL(href, location.href).search);
    if (this.pages[file]) { await this.show(file); return; }
    try { await loadPage(file); }                                 // the page's script calls Praise.start, which shows it
    catch (e) { location.href = href; }
  },

  // Show this account (the space switched, or the details changed) from the start: a new shell in the right look, with the
  // home page. The browser cross-fades the two looks where it can.
  swap(me, page) {
    const change = () => {
      this.cancelRefresh();
      if (this.live) for (const fn of this.live.leave.splice(0)) { try { fn(); } catch (e) { /* ignore */ } }
      this.live = null;
      history.replaceState(null, "", page);
      this.target = page;
      this.mount(me, page);                                       // the cross-fade needn't wait for the data
    };
    if (document.startViewTransition && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) document.startViewTransition(change);
    else change();
  },

};

// Links between dashboard pages swap the content instead of reloading (modifier clicks and new tabs still work normally).
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !Praise.live) return;
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || a.target || a.hasAttribute("download") || (a.getAttribute("href") || "").startsWith("#")) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !PAGE_SPECS[pageFile(a.href)]) return;
  e.preventDefault();
  Praise.go(a.href);
});
window.addEventListener("popstate", () => { if (Praise.live) Praise.go(location.href, false); });
// When a read is found to have changed behind the page's back, the page redraws itself.
Api.onChange(() => Praise.refresh());

// Plain-language wording for the events Praise Shield records. Returns null for events from the
// family extension, so a caller can skip them.
const DATA_WORDS = { card: "card details", card_cvc: "card details", id: "an ID number", otp: "a one-time code", password: "a password" };

function kindsText(kinds) {
  const words = [...new Set((kinds || []).map((k) => DATA_WORDS[k]).filter(Boolean))];
  if (!words.length) return "personal details";
  return words.length > 1 ? words.slice(0, -1).join(", ") + " and " + words[words.length - 1] : words[0];
}

// Turn one raw security event into a sentence, a coloured label and a detail for the activity table.
function describeSecurityEvent(e) {
  const d = e.domain || "a site";
  const cat = e.category ? catLabel(e.category) : "";
  switch (e.type) {
    case "warning_shown": return { text: `Warned you about ${d}`, chip: "warn", label: "Warned", detail: cat };
    case "site_blocked": return { text: `Blocked ${d}`, chip: "bad", label: "Blocked", detail: cat };
    case "warning_overridden": return { text: `You chose to open ${d}`, chip: "warn", label: "Continued", detail: "After a warning" };
    case "sensitive_shown": return { text: `Asked before sending ${kindsText(e.kinds)} to ${d}`, chip: "warn", label: "Asked", detail: "" };
    case "sensitive_cancelled": return { text: `You didn't send ${kindsText(e.kinds)} to ${d}`, chip: "ok", label: "Stopped", detail: "" };
    case "sensitive_sent_anyway": return { text: `You sent ${kindsText(e.kinds)} to ${d} anyway`, chip: "bad", label: "Sent", detail: "" };
    case "sensitive_breached": return { text: `A password you typed on ${d} was found in known data breaches`, chip: "bad", label: "Change it", detail: "" };
    case "sensitive_reused": return { text: `The password you used on ${d} is used on other sites too`, chip: "warn", label: "Reused", detail: "" };
    default: return null;
  }
}

// Heading block shared by every page.
function pageHead(title, text) {
  return h("div", { class: "page-head" }, h("h1", null, title), text ? h("p", null, text) : null);
}
