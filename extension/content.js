// Praise Shield: sensitive-data guard (content script, top frame of every page).
//
// Stops a form from sending card details, ID numbers, one-time codes or passwords to a page that
// looks untrustworthy: a flagged or look-alike site, an unencrypted page, or a form that posts to a
// different site. All detection happens here on the device. Typed values are never sent anywhere;
// the background worker is only told WHICH KINDS of data were involved, never their contents.
//
// Ordering matters: this runs at document_start and listens on `window` in the capture phase, so our
// listener is registered BEFORE any page script can add its own. A page listener registered earlier
// could call stopImmediatePropagation() and the guard would never see the submit.
//
// Known limits: a page that submits with form.submit() or fetch() never fires a submit event, so
// those can't be intercepted; forms inside iframes aren't watched (top frame only); and a card number
// split across several inputs isn't recognised. A page can remove our dialog, but the submission
// stays held.
(() => {
  "use strict";
  if (window.top !== window) return;                       // top frame only
  const S = self.PraiseSensitive, R = self.PraiseRules;
  if (!S || !R || !document.documentElement) return;

  // Field types that can never hold sensitive text. `getAttr` is saved up front so a form with a field named 'getAttribute' or 'action' cannot trick our checks.
  const SKIP_TYPES = new Set(["hidden", "checkbox", "radio", "submit", "button", "image", "reset", "file", "range", "color"]);
  const getAttr = Element.prototype.getAttribute;           // forms with a field named "getAttribute"/"action" can't shadow these
  const passed = new WeakSet();                             // forms the person already chose to send
  let modalOpen = false, guardCache = null;
  const bannerKeys = new Set();                             // one banner per kind of warning per page

  // ---- what does the background worker think of this page? ----------------------------------------
  // Ask the background worker about this page (is it risky? which checks are on?), cached for 30 seconds. If the worker is asleep the guard simply stays quiet.
  async function getGuard() {
    if (guardCache && Date.now() - guardCache.at < 30000) return guardCache.value;
    let value = null;
    try { value = await chrome.runtime.sendMessage({ type: "guard" }); } catch (e) { /* worker asleep or extension reloading */ }
    if (!value || !value.settings) value = { settings: { warn: false } };
    guardCache = { at: Date.now(), value };
    return value;
  }
  const freshGuard = () => (guardCache && Date.now() - guardCache.at < 30000 ? guardCache.value : null);

  // ---- reading a form (locally) ------------------------------------------------------------------------
  function labelOf(el) {
    try { return el.labels && el.labels[0] ? el.labels[0].textContent.slice(0, 80) : ""; } catch (e) { return ""; }
  }

  // What kind of data is in this field, if any: judged by the value first (card, ID number), then by the field's name and label (one-time code, CVC, password).
  function kindOf(el) {
    const value = el.value;
    if (!value || SKIP_TYPES.has(el.type)) return null;
    const byValue = S.classifyValue(value);                  // card / id, whatever the field is called
    if (byValue) return byValue;
    const byField = S.classifyField({
      type: el.type, name: el.name, id: el.id, autocomplete: getAttr.call(el, "autocomplete"),
      placeholder: el.placeholder, ariaLabel: getAttr.call(el, "aria-label"), label: labelOf(el),
    });
    if (byField === "otp") return /^\d{4,8}$/.test(String(value).trim()) ? "otp" : null;
    if (byField === "card_cvc") return /^\d{3,4}$/.test(String(value).trim()) ? "card_cvc" : null;
    return byField;                                         // card, id, password
  }

  // Every kind of sensitive data currently typed in a form.
  function kindsIn(root) {
    const kinds = new Set();
    for (const el of root.querySelectorAll("input, textarea")) { const k = kindOf(el); if (k) kinds.add(k); }
    return kinds;
  }

  // Combine what is in the form with how trustworthy the page is: unencrypted, posting to a different site, or flagged as risky.
  function assessForm(form, kinds, guard) {
    const insecure = location.protocol === "http:" && !S.isLocalHost(location.hostname);
    let crossPost = null;
    try {
      const raw = getAttr.call(form, "action");
      crossPost = raw ? S.crossSitePost(location.hostname, new URL(raw, location.href).href, R.registrableDomain) : null;
    } catch (e) { /* unparsable action: treat as same-page */ }
    const a = S.assess({ kinds, insecure, crossPost, risky: guard.risky, settings: guard.settings });
    a.suggest = guard.suggest || null;
    a.destination = crossPost ? crossPost.host : location.hostname;   // where the data would really go
    return a;
  }

  // ---- the submit gate ------------------------------------------------------------------------------------
  function stop(e) { e.preventDefault(); e.stopImmediatePropagation(); }

  // After the person chose 'Send anyway' (or nothing was wrong), send the form again, once, without asking a second time.
  function resubmit(form, submitter) {
    passed.add(form);
    setTimeout(() => passed.delete(form), 1500);            // the next submit is judged afresh
    try { form.requestSubmit(submitter && submitter.form === form ? submitter : undefined); }
    catch (e) { try { form.requestSubmit(); } catch (e2) { HTMLFormElement.prototype.submit.call(form); } }
  }

  // The gate: a form with sensitive data is held while the page is judged. If it is risky the dialog appears; otherwise the form goes through untouched.
  window.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || passed.has(form) || modalOpen) return;
    const kinds = kindsIn(form);
    if (!kinds.size) return;                                // nothing sensitive in it: never touch the form
    const submitter = e.submitter || null;

    const decide = (guard) => {
      const a = assessForm(form, kinds, guard);
      if (!a.warn) return resubmit(form, submitter);
      note("shown", a.kinds);
      confirmSend(a).then((choice) => {
        note(choice === "send" ? "sent_anyway" : "cancelled", a.kinds);
        if (choice === "send") resubmit(form, submitter);
      });
    };

    const cached = freshGuard();
    stop(e);                                                // hold the submit while we check
    if (cached) decide(cached); else getGuard().then(decide);
  }, true);

  // Tell the worker what happened (only the kinds of data, never values) so it shows on the dashboard.
  function note(outcome, kinds) {
    try { chrome.runtime.sendMessage({ type: "guardEvent", outcome, kinds }); } catch (e) { /* ignore */ }
  }

  // ---- early heads-up: when a sensitive value is typed or pasted ------------------------------------------
  // Early warning: when a sensitive value is typed or pasted into a field on a risky page, show a banner before the form is even submitted.
  function earlyCheck(el) {
    if (bannerKeys.has("data") || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    const k = kindOf(el);
    if (!k) return;
    getGuard().then((guard) => {
      const form = el.form || document.documentElement;
      const a = assessForm(form, new Set([k]), guard);
      if (a.warn && !bannerKeys.has("data")) {
        showBanner("data", `this page looks risky, so don't enter ${S.describeKinds(a.kinds)} here. ${a.reasons[0] || ""}`);
        note("shown", a.kinds);
      }
    });
  }
  window.addEventListener("change", (e) => earlyCheck(e.target), true);
  window.addEventListener("paste", (e) => { const t = e.target; setTimeout(() => earlyCheck(t), 0); }, true);

  // ---- our UI, in a closed shadow root so the page can't read or restyle it --------------------------------
  // Dialog and banner styles. They live inside a closed shadow root, so the page can neither read nor restyle them.
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop { position: fixed; inset: 0; background: rgba(15, 42, 43, .5);
      display: grid; place-items: center; padding: 16px; font: 16px/1.5 "Segoe UI", system-ui, sans-serif; color: #0f2a2b; }
    .dialog { width: min(480px, 100%); background: #fff; border: 1px solid #d5e0df; border-left: 6px solid #e0a100; border-radius: 12px;
      padding: 22px 24px; box-shadow: 0 18px 48px rgba(15, 42, 43, .3); }
    h1 { margin: 0 0 8px; font: 650 1.35rem/1.15 "Segoe UI", system-ui, sans-serif; letter-spacing: -.01em; }
    p { margin: 0 0 12px; }
    ul { margin: 0 0 14px; padding-left: 20px; color: #4b6162; }
    li { margin: 4px 0; }
    .site { display: inline-block; padding: 1px 9px; border-radius: 6px; background: #f2f5f4; border: 1px solid #d5e0df; font-weight: 650; }
    .head { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
    .head h1 { margin: 0; }
    .avatar { width: 44px; height: 44px; flex: none; object-fit: contain; }
    .banner .avatar { width: 28px; height: 28px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; align-items: center; }
    button, a.btn { font: 650 .98rem "Segoe UI", system-ui, sans-serif; cursor: pointer; border-radius: 8px; padding: 9px 18px; border: 1.5px solid #0f2a2b;
      background: #0f2a2b; color: #fff; text-decoration: none; display: inline-block; }
    button:hover, a.btn:hover { background: #095b5a; border-color: #095b5a; }
    button.quiet { background: transparent; color: #0f2a2b; border-color: #b4c5c3; }
    button.quiet:hover { background: #f2f5f4; border-color: #0f2a2b; }
    a.btn.good { background: #0e7c7b; border-color: #0e7c7b; }
    :focus-visible { outline: 3px solid #0e7c7b; outline-offset: 2px; }
    .fine { margin: 14px 0 0; font-size: .86rem; color: #4b6162; }
    .banner { position: fixed; top: calc(12px + var(--slot, 0) * 100px); right: 12px; max-width: min(380px, calc(100vw - 24px)); background: #fff;
      border: 1px solid #d5e0df; border-left: 6px solid #e0a100; border-radius: 10px; padding: 12px 14px;
      box-shadow: 0 8px 24px rgba(15, 42, 43, .2); font: 14.5px/1.45 "Segoe UI", system-ui, sans-serif; color: #0f2a2b; display: flex; gap: 10px; align-items: flex-start; }
    .banner button { padding: 2px 10px; font-size: .85rem; }
  `;

  // Ringo's small avatar. If a page's CSP won't load it, the dialog simply goes without.
  const avatar = (el) => el("img", { className: "avatar", alt: "", src: chrome.runtime.getURL("companion/orb-adult-sm.png") });

  // Create a full-screen host with a closed shadow root and a constructed stylesheet (which a page's Content-Security-Policy cannot block).
  function mount(build) {
    const host = document.createElement("div");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();                      // constructed sheet: not subject to the page's CSP
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    const el = (tag, props = {}, ...kids) => {
      const n = Object.assign(document.createElement(tag), props);
      for (const k of kids.flat()) if (k != null) n.append(k);
      return n;
    };
    const ui = build(shadow, el);
    document.documentElement.append(host);
    return { host, shadow, ui };
  }

  // The 'Hold on before you send this' dialog. 'Don't send' has the focus, Escape cancels, Tab stays inside the dialog, and only real clicks count (a page script cannot click for the person).
  function confirmSend(a) {
    modalOpen = true;
    const previouslyFocused = document.activeElement;
    return new Promise((resolve) => {
      let m;
      const finish = (choice) => { m.host.remove(); modalOpen = false; try { previouslyFocused && previouslyFocused.focus(); } catch (e) { /* gone */ } resolve(choice); };
      m = mount((shadow, el) => {
        const trusted = (fn) => (ev) => { if (ev.isTrusted) fn(); };        // a page script can't click for you
        const cancel = el("button", { type: "button", textContent: "Don't send" });
        const send = el("button", { type: "button", className: "quiet", textContent: "Send anyway" });
        cancel.addEventListener("click", trusted(() => finish("cancel")));
        send.addEventListener("click", trusted(() => finish("send")));
        const real = a.suggest && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(a.suggest)
          ? el("a", { className: "btn good", href: "https://" + a.suggest + "/", textContent: `Go to ${a.suggest}`, rel: "noopener noreferrer" }) : null;
        const dialog = el("div", { className: "dialog", role: "alertdialog" },
          el("div", { className: "head" }, avatar(el), el("h1", { id: "t", textContent: "Hold on before you send this" })),
          el("p", {}, `You're about to send ${S.describeKinds(a.kinds)} to `, el("span", { className: "site", textContent: a.destination || location.hostname }), "."),
          el("p", { textContent: "Why this looks unsafe:" }),
          el("ul", {}, a.reasons.slice(0, 3).map((r) => el("li", { textContent: r }))),
          el("div", { className: "actions" }, real, cancel, send),
          el("p", { className: "fine", textContent: "Praise Shield checks this on your device. It never sees what you typed." }));
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-labelledby", "t");
        const backdrop = el("div", { className: "backdrop" }, dialog);
        backdrop.style.pointerEvents = "auto";
        backdrop.addEventListener("keydown", (ev) => {
          if (ev.key === "Escape") { ev.stopPropagation(); finish("cancel"); return; }
          if (ev.key === "Tab") {                                              // keep focus inside the dialog
            const stops = [real, cancel, send].filter(Boolean);
            const i = stops.indexOf(shadow.activeElement);
            ev.preventDefault();
            stops[(i + (ev.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
          }
        });
        shadow.append(backdrop);
        return { cancel };
      });
      m.ui.cancel.focus();                                                    // the safe choice has focus
    });
  }

  // A dismissible notice in the corner, one per kind of warning; banners stack instead of covering each other.
  function showBanner(key, text) {
    if (bannerKeys.has(key)) return;
    bannerKeys.add(key);
    const slot = bannerKeys.size - 1;                       // stack banners instead of covering each other
    const m = mount((shadow, el) => {
      const close = el("button", { type: "button", className: "quiet", textContent: "Dismiss" });
      const box = el("div", { className: "banner", role: "alert" },
        avatar(el), el("div", {}, el("strong", { textContent: "Praise Shield: " }), text), close);
      box.style.pointerEvents = "auto";
      box.style.setProperty("--slot", String(slot));
      close.addEventListener("click", (ev) => { if (ev.isTrusted) m.host.remove(); });
      shadow.append(box);
      return {};
    });
    setTimeout(() => m.host.isConnected && m.host.remove(), 20000);
  }

  // ---- password safety --------------------------------------------------------------------------------------
  // The password is hashed here. Only the first 5 characters of that hash go out (breach check), or a
  // slow salted fingerprint (reuse check, opt-in). The password itself is never sent or stored.
  const PW = self.PraisePasswords;
  const handledPw = new Set();                              // fingerprints already handled on this page, never the password

  // A field is probably choosing a password (rather than signing in) if it says new-password or the form has two password boxes.
  const isNewPasswordField = (el) => /new-password/i.test(getAttr.call(el, "autocomplete") || "")
    || (el.form && el.form.querySelectorAll('input[type="password"]').length >= 2);

  // A slow, salted fingerprint of the password (PBKDF2, 150,000 rounds), used only to notice reuse across sites. It cannot be turned back into the password.
  async function fingerprint(password, saltHex) {
    const salt = Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, key, 256);
    return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // After a password is entered: check whether it appears in known breaches (only a 5-character hash prefix leaves the device) and, if the person opted in, whether it is reused on other sites.
  async function passwordCheck(el) {
    const value = el.value;
    if (!PW || !value || value.length < 6 || value.length > 256) return;
    const guard = await getGuard();
    const cfg = guard.passwords;
    if (!cfg || (!cfg.breach_check && !cfg.reuse_check)) return;

    const { prefix, suffix } = PW.rangeParts(value);
    if (handledPw.has(prefix + suffix)) return;
    handledPw.add(prefix + suffix);
    const fresh = isNewPasswordField(el);

    if (cfg.breach_check) {
      let reply = null;
      try { reply = await chrome.runtime.sendMessage({ type: "breachRange", prefix }); } catch (e) { /* offline */ }
      const n = reply && reply.text ? PW.breachCount(value, reply.text) : 0;
      if (n > 0) {
        showBanner("breach", fresh
          ? `this password has appeared in ${PW.formatCount(n)} known data breaches. Pick a different one.`
          : `the password you just typed has appeared in ${PW.formatCount(n)} known data breaches. Consider changing it wherever you use it.`);
        note("breached", ["password"]);
      }
    }

    // Reuse needs crypto.subtle, which only secure (https or localhost) pages have.
    if (cfg.reuse_check && window.isSecureContext && crypto.subtle) {
      try {
        const salt = await chrome.runtime.sendMessage({ type: "reuseSalt" });
        if (!salt || !salt.salt) return;
        const reply = await chrome.runtime.sendMessage({ type: "reuseCheck", hash: await fingerprint(value, salt.salt), record: true });
        if (reply && reply.others && reply.others.length) {
          showBanner("reuse", `you've used this password on ${reply.others.join(", ")}. If one of those sites is breached, all of those accounts are at risk.`);
          note("reused", ["password"]);
        }
      } catch (e) { /* worker asleep: skip this time */ }
    }
  }

  window.addEventListener("change", (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.type === "password") passwordCheck(el);
  }, true);
})();
