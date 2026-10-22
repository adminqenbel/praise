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

// Draw a Chart.js chart, or explain politely if the Chart.js script could not load (it comes from a CDN).
function drawChart(canvas, config) {
  if (typeof Chart === "undefined") {
    canvas.replaceWith(h("p", { class: "muted" }, "Charts need an internet connection to load."));
    return;
  }
  Chart.defaults.font.family = '"Segoe UI", system-ui, sans-serif';
  Chart.defaults.color = "#5d5470";
  new Chart(canvas, config);
}

// ---- navigation ---------------------------------------------------------------------------
// Navigation links for the family dashboard and for the adult one.
const NAV = [
  ["home.html", "Home"], ["children.html", "Children"], ["policies.html", "Rules"],
  ["events.html", "Activity"], ["sites.html", "Sites"], ["cookies.html", "Cookies"],
];

const NAV_ADULT = [
  ["home.html", "Home"], ["policies.html", "My protection"], ["events.html", "Activity"],
  ["cookies.html", "Cookies"], ["sites.html", "Sites"], ["children.html", "My browsers"],
];

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

// Switch between the family and personal spaces; the server records the choice and the whole shell is rebuilt in the other look.
async function changeSpace(space, exists) {
  if (!exists && !(await confirmAddSpace(space))) return;
  try {
    await Api.post("/api/auth/space", exists ? { space } : { space, enable: true });
    await Praise.reboot("home.html");               // rebuild the shell in the other look, without reloading the page
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

// Build the top bar (brand, space switch, links, sign out) and the empty content area. Admins also get the Review queue link.
// A login without Google gets "Connect Google" when the server has Google sign-in set up.
function buildShell(user, page, logout, googleOn) {
  const links = (user.account_type === "adult" ? NAV_ADULT : NAV).slice();
  if (user.role === "admin") links.push(["reviews.html", "Review queue"]);
  const bar = h("header", { class: "topbar" },
    h("a", { class: "brand", href: "home.html" },
      user.account_type === "adult"
        ? svg(`<svg viewBox="0 0 200 200" fill="none" stroke-width="26" stroke-linecap="round" aria-hidden="true"><path d="M 28 62 A 80 80 0 0 1 82 21" stroke="#0e7c7b"/><path d="M 135 21 A 80 80 0 0 1 179 62" stroke="#0e7c7b"/><path d="M 179 138 A 80 80 0 0 1 138 179" stroke="#0e7c7b"/><path d="M 62 179 A 80 80 0 0 1 21 138" stroke="#0e7c7b"/></svg>`)
        : svg(`<svg viewBox="0 0 24 30" aria-hidden="true"><path fill="#8b5cf6" d="M2 30V12C2 5 7 1 12 1s10 4 10 11v18z"/><circle cx="16.5" cy="19" r="2.4" fill="#ffb627"/></svg>`),
      user.account_type === "adult" ? "Praise Shield" : "Praise"),
    spaceSwitch(user),
    h("nav", { "aria-label": "Main" }, links.map(([href, label]) =>
      h("a", { href, "aria-current": href === page ? "page" : false }, label))),
    h("div", { class: "who" }, h("span", { class: "email" }, user.email),
      googleOn && !user.google
        ? h("button", { onclick: () => { location.href = googleUrl({ link: 1, next: page }); } }, "Connect Google") : null,
      h("button", { onclick: logout }, "Sign out")));
  const main = h("main", { class: "main", id: "main" });
  return { shell: h("div", { class: "shell" }, bar, main), main };
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

  const wordmark = h("a", { class: "wordmark", href: "index.html", "aria-label": "Praise, all versions" },
    "Praise ", h("span", { class: "dots", "aria-hidden": "true" }, h("i"), h("i")));
  return h("div", { class: "auth" }, h("div", { class: "auth-card" }, wordmark, title, lede, form,
    h("p", { class: "or" }, "or"), google, toggleText));
}

// ---- entry point ---------------------------------------------------------------------------------
// Each page's script calls Praise.start("children.html", async (main, ctx) => { ... }). The first call puts the shell (top bar
// or sidebar) on screen. After that, moving between pages does not reload anything: the shell stays where it is and only the
// page's content is swapped, so the tabs feel instant and nothing flashes. A page that wants to clean up when it is left
// (stop a timer, remove a mascot) calls Praise.onLeave(fn) while it renders.

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
const pageFile = (url) => new URL(url, location.href).pathname.split("/").pop();

// Load a stylesheet once; a missing file does not stop the page.
function loadStyle(href) {
  const have = [...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.getAttribute("href").split("?")[0] === href);
  if (have) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href + "?v=b2";
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
    s.src = src.startsWith("http") ? src : src + "?v=b2";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load " + src));
    document.head.append(s);
  });
}

// The dashboard's page manager: shows the shell, swaps page content without reloading, and runs each page's cleanup when it is left.
const Praise = {
  live: null,          // { user, bar, main, page, leave: [] } while the shell is on screen
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
    let me;
    try { me = await Api.get("/api/auth/me"); }
    catch (e) {
      if (e.status && e.status !== 401) { document.body.append(h("p", { class: "err", style: "padding:2rem" }, e.message)); return; }
      if (!e.status) { document.body.append(h("p", { class: "err", style: "padding:2rem" }, e.message)); return; }
    }
    if (!me) { document.body.append(authScreen(() => Praise.start(page, render, opts))); return; }

    const user = me.user;
    document.documentElement.dataset.theme = user.account_type === "adult" ? "adult" : "family";
    const { shell, main } = buildShell(user, page, async () => {
      await Api.post("/api/auth/logout"); location.href = "index.html";
    }, me.google_enabled);
    document.body.append(shell);
    const googleError = takeGoogleError();                       // from "Connect Google"
    if (googleError) toast(googleError, true);
    this.live = { user, bar: shell.querySelector(".topbar"), main, page, leave: [] };
    this.title(page);
    await this.run(page);
  },

  title(page) {
    const { user, bar } = this.live;
    const link = [...bar.querySelectorAll("nav a")].find((a) => pageFile(a.href) === page);
    const brand = user.account_type === "adult" ? "Praise Shield" : "Praise";
    document.title = (link ? link.textContent + " - " : "") + brand;
  },

  // Run a page's render function; administrator-only pages are refused for everyone else, and errors are shown instead of a blank screen.
  async run(page) {
    const live = this.live, main = live.main, { render, opts } = this.pages[page];
    if (opts.adminOnly && live.user.role !== "admin") {
      main.append(emptyState("This page is for administrators", "Ask the person who runs this system to review sites."));
      return;
    }
    try { await render(main, { user: live.user }); }
    catch (e) { main.append(h("p", { class: "err" }, e.message || "Something went wrong loading this page.")); }
  },

  // Swap the content area for another page: run the old page's cleanup, update the active link and title, then render.
  async show(page) {
    const live = this.live;
    for (const fn of live.leave.splice(0)) { try { fn(); } catch (e) { /* a page's cleanup must not stop navigation */ } }
    const main = h("main", { class: "main", id: "main" });
    live.main.replaceWith(main);                                  // a slow page still drawing into the old one can't spoil this one
    live.main = main;
    live.page = page;
    for (const a of live.bar.querySelectorAll("nav a")) {
      if (pageFile(a.href) === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    this.title(page);
    window.scrollTo(0, 0);
    await this.run(page);
  },

  // Move to another page without reloading. Anything that isn't one of our pages loads normally.
  async go(href, push = true) {
    const file = pageFile(href), spec = PAGE_SPECS[file];
    if (!this.live || !spec) { location.href = href; return; }
    this.target = file;
    if (push) history.pushState(null, "", new URL(href, location.href).pathname + new URL(href, location.href).search);
    if (this.pages[file]) { await this.show(file); return; }
    try {
      for (const css of spec.styles || []) await loadStyle(css);
      if (spec.chart && typeof Chart === "undefined") { try { await loadScript(CHART_SRC); } catch (e) { /* charts say so themselves */ } }
      for (const s of spec.scripts) await loadScript(s);          // the page's script calls Praise.start, which shows it
    } catch (e) { location.href = href; }
  },

  // Rebuild everything from the sign-in on (the account switched space, so the whole shell changes look).
  async reboot(page) {
    if (this.live) for (const fn of this.live.leave.splice(0)) { try { fn(); } catch (e) { /* ignore */ } }
    this.live = null;
    history.replaceState(null, "", page);
    this.target = page;
    const known = this.pages[page];
    if (known) return this.start(page, known.render, known.opts);
    const spec = PAGE_SPECS[page];
    for (const css of spec.styles || []) await loadStyle(css);
    if (spec.chart && typeof Chart === "undefined") { try { await loadScript(CHART_SRC); } catch (e) { /* ignore */ } }
    for (const s of spec.scripts) await loadScript(s);
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
