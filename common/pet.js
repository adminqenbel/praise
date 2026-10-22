// The buddy as a browser pet: a small Dori or Ringo that lives in the corner of web pages while the person has
// switched it on. It animates, can be dragged to another spot or side, says a hello once a day (and a gentle
// bedtime word late at night), and can be set to "quiet" so it never speaks. It never reads the page: it does not look
// at the address, the title or the content, and sends nothing anywhere.
//
// Right-click the pet for: Talk to it, Quiet mode, Move to the other side, Hide. Hover over it and a small chat button
// appears too. Chatting opens a panel (common/chat-ui.js) above the pet; what is typed there is hidden from the page.
(function (root) {
  "use strict";

  // Keys in chrome.storage.local that the popup and service worker write and this script reads (the script never sees the pairing token).
  const CFG = "pet";              // { on, quiet }  written by the popup
  const ACTIVE = "petActive";     // whether to show the buddy at all (paired and not switched off)  written by the service worker
  const WHO = "petWho";           // "family" (Dori) or "adult" (Ringo): the kind of account the browser was paired to  written by the service worker
  const CHAT = "petChat";         // whether talking to the buddy is allowed (a parent can switch it off for a child's browser)  written by the service worker
  const MEM = "petMemory";        // { side, lift, greetDay, lateAt }  written here
  // Sizes and spacing of the buddy in the page corner.
  const HEIGHT = 120;
  const CHAT_HEIGHT = 340;       // room the chat panel needs above the pet
  // Events the page must not see while the person types to the buddy. The pet's script runs at document_start so these
  // listeners go in before any of the page's own, and a stopped event still does its normal job in the text box.
  const TYPED = ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "cut", "copy", "compositionstart", "compositionupdate", "compositionend"];
  const MARGIN = 12;
  const HOUR = 3600 * 1000;

  // ---- pure helpers (tested in Node) ----------------------------------------------------------------
  const isLateHour = (date) => { const h = date.getHours(); return h >= 22 || h < 5; };

  // Should the pet speak up on this page load? Once a day, and once an hour at most late at night. Never when quiet.
  function greetingDue(memory, now, quiet) {
    if (quiet) return null;
    const m = memory || {};
    const date = new Date(now);
    if (isLateHour(date)) return now - (m.lateAt || 0) > HOUR ? "late" : null;
    return m.greetDay !== date.toDateString() ? "day" : null;
  }

  // Keep the pet fully on screen: how far up from the bottom it may sit.
  const clampLift = (lift, petHeight, viewportHeight) =>
    Math.round(Math.max(MARGIN, Math.min(Number(lift) || 24, viewportHeight - petHeight - MARGIN)));

  // ---- the pet on the page --------------------------------------------------------------------------
  const EXTRA_CSS = `
    :host { all: initial; }
    @media print { :host { display: none !important; } }
    .pet-box { display: flex; flex-direction: column; pointer-events: none; }
    .pet-right { align-items: flex-end; }
    .pet-left { align-items: flex-start; }
    .buddy { align-items: inherit; }
    .buddy-body, .buddy-bubble { pointer-events: auto; }
    .buddy-body { touch-action: none; }
    .pet-right .buddy-bubble { align-self: flex-end; margin-right: 4px; max-width: 240px; }
    .pet-left .buddy-bubble { align-self: flex-start; margin-left: 4px; max-width: 240px; }
    .pet-right .buddy-bubble::after { left: auto; right: 46px; transform: rotate(45deg); }
    .pet-left .buddy-bubble::after { left: 46px; transform: rotate(45deg); }
    .pet-right .buddy-walk, .pet-left .buddy-walk { align-items: center; }
    .pet-box { position: relative; }
    .talk-btn { position: absolute; bottom: 14px; width: 34px; height: 34px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 50%;
      background: #fff; color: #7c4dde; box-shadow: 0 4px 12px rgba(43, 33, 64, .28); cursor: pointer; opacity: 0; transform: scale(.8); pointer-events: none;
      transition: opacity .15s, transform .15s; }
    .pet-right .talk-btn { right: 80px; }
    .pet-left .talk-btn { left: 80px; }
    .pet-box:hover .talk-btn, .talk-btn:focus-visible { opacity: 1; transform: none; pointer-events: auto; }
    .talk-btn:focus-visible { outline: 2px solid #7c4dde; outline-offset: 2px; }
    .talk-btn svg { width: 18px; height: 18px; }
    .adult .talk-btn { color: #0e7c7b; border-radius: 8px; box-shadow: 0 3px 10px rgba(15, 42, 43, .25); }
    .adult .talk-btn:focus-visible { outline-color: #0e7c7b; }
    .chatting .talk-btn { display: none; }
    .pet-right .chat { align-self: flex-end; }
    .pet-left .chat { align-self: flex-start; }
    .menu { position: absolute; pointer-events: auto; min-width: 190px; background: #fff; color: #2b2140; border: 1px solid #d9d2ea; border-radius: 12px;
      padding: 6px; box-shadow: 0 10px 28px rgba(43, 33, 64, .25); font: 14px/1.3 "Segoe UI", system-ui, sans-serif; }
    .menu button { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
    .menu button:hover, .menu button:focus-visible { background: #f1ecfb; outline: none; }
    .adult .menu { color: #0f2a2b; border-color: #d5e0df; border-radius: 8px; }
    .adult .menu button:hover, .adult .menu button:focus-visible { background: #f2f5f4; }
  `;

  // Start the page buddy. It refuses to run inside frames, on non-HTML documents, on localhost (the dashboard has its own buddy) and if it was already injected.
  function start(who) {                                                      // `who` is only the default until petWho is read
    if (!root.chrome || !root.chrome.storage || !root.PraiseBuddy || !root.PraiseBuddyCSS) return;
    if (root.top !== root) return;                                           // never inside frames
    if (document.contentType && document.contentType !== "text/html") return;
    if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
    if (root.__praisePetStarted) return;                                     // injected twice (registered + open tab)
    root.__praisePetStarted = true;

    const store = chrome.storage.local;
    let ui = null;                                                           // { host, buddy, shadow, cleanup }
    let cfg = { on: false, quiet: false, chat: true };
    const shield = { host: null, onEscape: null };                           // while the chat is open: the pet's host element
    // While the chat is open, keystrokes typed into it are stopped from reaching the page's own listeners.
    for (const type of TYPED) {
      root.addEventListener(type, (e) => {
        if (!shield.host || e.target !== shield.host) return;
        e.stopImmediatePropagation();
        if (type === "keydown" && e.key === "Escape" && e.isTrusted && shield.onEscape) shield.onEscape();
      }, true);
    }
    let mem = { side: "right", lift: 24 };

    const saveMem = (patch) => { Object.assign(mem, patch); store.set({ [MEM]: mem }).catch(() => {}); };

    function hide() {
      if (!ui) return;
      ui.cleanup();
      ui = null;
    }

    // Build the buddy in a closed shadow root: its body, menu, chat button and chat panel.
    async function show() {
      hide();
      const host = document.createElement("div");
      host.setAttribute("aria-hidden", "true");
      const shadow = host.attachShadow({ mode: "closed" });
      const sheet = new CSSStyleSheet();                                     // constructed sheet: not subject to the page's CSP
      sheet.replaceSync(root.PraiseBuddyCSS + EXTRA_CSS);
      shadow.adoptedStyleSheets = [sheet];

      const box = document.createElement("div");
      box.className = "pet-box " + (who === "adult" ? "adult " : "") + (mem.side === "left" ? "pet-left" : "pet-right");
      shadow.append(box);

      let chat = null, talkBtn = null;
      const place = () => {
        const room = HEIGHT + 30 + (chat && chat.isOpen ? CHAT_HEIGHT : 0);
        const lift = clampLift(mem.lift, room, root.innerHeight);
        if (!(chat && chat.isOpen)) mem.lift = lift;                         // an open chat may lift the pet for now, but not for good
        host.style.cssText = `all: initial; position: fixed; z-index: 2147483646; pointer-events: none; bottom: ${lift}px; ` +
          (mem.side === "left" ? `left: ${MARGIN}px;` : `right: ${MARGIN}px;`);
      };
      place();

      const buddy = root.PraiseBuddy.mount(box, {
        who, base: chrome.runtime.getURL("companion/"), height: HEIGHT, talk: !cfg.quiet, sleeps: true,
      });
      document.documentElement.append(host);
      const cleanups = [];
      const mine = { host, buddy, cleanup: () => { cleanups.forEach((fn) => fn()); if (shield.host === host) { shield.host = null; shield.onEscape = null; } buddy.destroy(); host.remove(); } };
      ui = mine;

      // ---- talk to it ----
      if (cfg.chat && root.PraiseChat && root.PraiseCompanion) {
        const remote = async (message, history) => {
          const res = await chrome.runtime.sendMessage({ type: "chat", message, history });
          return res && typeof res.reply === "string" ? res.reply : null;
        };
        chat = root.PraiseChat.mount(box, {
          who, remote,
          onMood: (m) => buddy.setMood(m),
          onOpen: () => {
            box.classList.add("chatting");
            host.removeAttribute("aria-hidden");                             // the chat is for people using assistive tech too
            buddy.setTalk(false); buddy.say("", "happy");
            shield.host = host; shield.onEscape = () => chat.close();
            place();
          },
          onClose: () => {
            box.classList.remove("chatting");
            host.setAttribute("aria-hidden", "true");
            buddy.setTalk(!cfg.quiet); buddy.setMood("happy");
            if (shield.host === host) { shield.host = null; shield.onEscape = null; }
            place();
          },
        });
        box.prepend(chat.el);                                                // above the pet
        talkBtn = document.createElement("button");
        talkBtn.type = "button"; talkBtn.className = "talk-btn";
        talkBtn.setAttribute("aria-label", `Talk to ${who === "adult" ? "Ringo" : "Dori"}`);
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "currentColor"); svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z");
        svg.append(path); talkBtn.append(svg);
        talkBtn.addEventListener("click", (ev) => { if (ev.isTrusted) chat.open(); });
        box.append(talkBtn);
      }

      // If this page's rules won't let the sprite load, go without rather than show a broken picture.
      const sprite = box.querySelector(".buddy-base");
      sprite.addEventListener("error", () => {
        console.warn("Praise buddy: its picture could not be loaded on this page, so it stays hidden here.");
        hide();
      }, { once: true });

      const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); cleanups.push(() => target.removeEventListener(type, fn, opt)); };

      // ---- drag it somewhere else; it snaps to the nearest side ----
      let drag = null, justDragged = false;
      on(box, "pointerdown", (e) => {
        if (e.button !== 0 || !e.composedPath().some((n) => n.classList && n.classList.contains("buddy-body"))) return;
        const r = host.getBoundingClientRect();
        drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
      }, true);
      on(root, "pointermove", (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        host.style.right = "auto"; host.style.bottom = "auto";
        host.style.left = Math.max(0, Math.min(drag.left + dx, root.innerWidth - 80)) + "px";
        host.style.top = Math.max(0, Math.min(drag.top + dy, root.innerHeight - 80)) + "px";
      }, true);
      on(root, "pointerup", () => {
        if (!drag) return;
        const d = drag; drag = null;
        if (!d.moved) return;
        justDragged = true;
        const r = host.getBoundingClientRect();
        saveMem({ side: r.left + r.width / 2 < root.innerWidth / 2 ? "left" : "right", lift: root.innerHeight - r.bottom });
        show();                                                              // re-seat it on its edge
      }, true);
      on(box, "click", (e) => { if (justDragged) { e.stopPropagation(); e.preventDefault(); justDragged = false; } }, true);

      // ---- right-click menu ----
      let menu = null;
      const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
      on(box, "contextmenu", (e) => {
        if (!e.composedPath().some((n) => n.classList && n.classList.contains("buddy-body"))) return;
        e.preventDefault(); closeMenu();
        menu = document.createElement("div");
        menu.className = "menu"; menu.setAttribute("role", "menu");
        const item = (label, fn) => {
          const b = document.createElement("button");
          b.type = "button"; b.setAttribute("role", "menuitem"); b.textContent = label;
          b.addEventListener("click", (ev) => { if (ev.isTrusted) { closeMenu(); fn(); } });
          menu.append(b);
        };
        if (chat) item(`Talk to ${who === "adult" ? "Ringo" : "Dori"}`, () => chat.open());
        item(cfg.quiet ? "Let it talk again" : "Quiet mode (no speech)", () => store.set({ [CFG]: { on: true, quiet: !cfg.quiet } }));
        item(mem.side === "left" ? "Move to the right" : "Move to the left", () => { saveMem({ side: mem.side === "left" ? "right" : "left" }); show(); });
        item("Hide the buddy", () => store.set({ [CFG]: { on: false, quiet: cfg.quiet } }));
        menu.style.cssText = `bottom: 6px; ${mem.side === "left" ? "left" : "right"}: ${Math.round(HEIGHT * .78)}px;`;
        box.append(menu);
        menu.querySelector("button").focus();
      });
      on(root, "pointerdown", (e) => { if (menu && !e.composedPath().includes(host)) closeMenu(); }, true);
      on(root, "keydown", (e) => { if (menu && e.key === "Escape") closeMenu(); }, true);

      // ---- fullscreen video, window size ----
      on(document, "fullscreenchange", () => { host.style.display = document.fullscreenElement ? "none" : ""; });
      on(root, "resize", () => { if (!drag) place(); });

      // ---- the adult buddy sleeps while protection is paused ----
      if (who === "adult") {
        const pausedNow = async () => { const { pausedUntil } = await store.get({ pausedUntil: 0 }); return pausedUntil > Date.now(); };
        const onPause = async (changes, area) => {
          if (area !== "local" || !changes.pausedUntil) return;
          buddy.setMood((await pausedNow()) ? "sleepy" : "happy");
        };
        chrome.storage.onChanged.addListener(onPause);
        cleanups.push(() => chrome.storage.onChanged.removeListener(onPause));
        if (await pausedNow() && ui === mine) buddy.setMood("sleepy");
      }

      // ---- hello, once a day; a bedtime word late at night ----
      await buddy.enter();
      if (ui !== mine) return;                                               // switched off or re-seated while it came in
      const due = greetingDue(mem, Date.now(), cfg.quiet);
      if (due && root.PraiseCompanion && !(who === "adult" && buddy.mood === "sleepy")) {
        const s = root.PraiseCompanion.say(who, "greet");
        buddy.say(s.text, s.mood);
        const now = Date.now();
        saveMem(due === "late" ? { lateAt: now } : { greetDay: new Date(now).toDateString() });
        const t = setTimeout(() => buddy.say("", "happy"), 7000);
        cleanups.push(() => clearTimeout(t));
      }
    }

    // Read the saved settings and show the buddy if it should be on.
    async function init() {
      const got = await store.get({ [CFG]: {}, [MEM]: {}, [ACTIVE]: false, [WHO]: null, [CHAT]: true });
      if (got[WHO]) who = got[WHO] === "adult" ? "adult" : "family";
      cfg = { on: !!got[ACTIVE], quiet: !!(got[CFG] && got[CFG].quiet), chat: got[CHAT] !== false };
      mem = { side: "right", lift: 24, ...got[MEM] };
      if (cfg.on) show();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(changes[CFG] || changes[ACTIVE] || changes[WHO] || changes[CHAT])) return;
      const wasQuiet = cfg.quiet, hadChat = cfg.chat;
      let swapped = false;
      if (changes[WHO] && changes[WHO].newValue) {
        const next = changes[WHO].newValue === "adult" ? "adult" : "family";
        swapped = next !== who;
        who = next;
      }
      if (changes[CFG]) cfg.quiet = !!(changes[CFG].newValue && changes[CFG].newValue.quiet);
      if (changes[ACTIVE]) cfg.on = !!changes[ACTIVE].newValue;
      if (changes[CHAT]) cfg.chat = changes[CHAT].newValue !== false;
      if (!cfg.on) hide();
      else if (!ui || swapped || wasQuiet !== cfg.quiet || hadChat !== cfg.chat) show();
    });

    init();
  }

  const api = { start, greetingDue, clampLift, isLateHour };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraisePet = api;
})(typeof self !== "undefined" ? self : this);
