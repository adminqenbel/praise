// A small chat panel to talk with the buddy (Dori or Ringo). Plain DOM, no dependencies, and it lives wherever it is
// mounted: in the page buddy's shadow root, in the extension popup, or on the dashboard.
//
//   const chat = PraiseChat.mount(el, { who: "family", remote: (text, history) => Promise<string | null>, onMood: (m) => ... });
//   chat.open(); chat.close(); chat.toggle(); chat.destroy();
//
// How an answer is made: the buddy's own brain (PraiseCompanion.reply) answers everyday questions straight away, with no
// network. Anything it doesn't recognise goes to `remote` (the server's optional local model); if that returns nothing,
// is slow, or fails the safety check (PraiseCompanion.safeReply), the buddy's written fallback line is shown instead. A
// message that needs a person's care, or carries personal details, is answered locally and never sent anywhere.
// Nothing is saved: the conversation lives in memory until the panel is destroyed.
(function (root) {
  "use strict";

  // Limits: message length, messages kept on screen, and how long to wait for the server's answer.
  const MAX_LEN = 300;
  const KEEP = 40;                     // messages kept on screen
  const REMOTE_MS = 25000;
  const NAMES = { family: "Dori", adult: "Ringo" };
  // The opening line and the one-tap question chips for each kind of reader.
  const INTRO = {
    family: "Hi! I'm Dori. Ask me anything, or tap one of these.",
    adult: "Ringo here. Ask me about scams, passwords or privacy, or tap one of these.",
  };
  const STARTERS = {
    family: ["Tell me a joke", "Why was a page closed?", "Give me a safe web tip"],
    parent: ["Tell me a joke", "Why do pages get closed?", "Is our chat private?"],
    adult: ["Give me a security tip", "How can I spot a scam?", "Is this chat private?"],
  };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  // Give up on a slow answer so the chat never hangs.
  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("slow")), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  // Build the chat panel inside `container`. Everyday questions are answered from the buddy's own written replies; only the rest go to the server, and nothing typed is stored.
  function mount(container, opts = {}) {
    const who = opts.who === "adult" ? "adult" : "family";
    const audience = opts.audience === "parent" ? "parent" : who === "adult" ? "adult" : "child";
    const name = NAMES[who];
    const C = root.PraiseCompanion || (typeof require === "function" ? require("./companion.js") : null);   // (the require is for Node tests)

    const panel = el("section", "chat" + (opts.inline ? " chat-inline" : ""));
    panel.dataset.who = who;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", `Chat with ${name}`);
    panel.hidden = true;

    const head = el("header", "chat-head");
    head.append(el("strong", "chat-title", `Talk to ${name}`));
    const x = el("button", "chat-x", "×");
    x.type = "button"; x.setAttribute("aria-label", "Close chat");
    head.append(x);

    const log = el("div", "chat-log");
    log.setAttribute("role", "log"); log.setAttribute("aria-live", "polite"); log.setAttribute("aria-label", "Conversation");
    const chips = el("div", "chat-chips");
    for (const s of STARTERS[audience === "parent" ? "parent" : who]) {
      const b = el("button", "chat-chip", s);
      b.type = "button";
      b.addEventListener("click", (e) => { if (e.isTrusted !== false) send(s); });
      chips.append(b);
    }

    const form = el("form", "chat-form");
    const input = el("input");
    input.type = "text"; input.maxLength = MAX_LEN; input.autocomplete = "off"; input.spellcheck = false;
    input.placeholder = `Say something to ${name}`; input.setAttribute("aria-label", `Message to ${name}`);
    const go = el("button", "chat-send", "Send");
    go.type = "submit";
    form.append(input, go);
    const note = el("p", "chat-note", "Chats aren't saved.");
    panel.append(head, log, chips, form, note);
    container.append(panel);

    const history = [];                // { role: "user" | "assistant", content }
    let busy = false, destroyed = false, lastReply = "", intro = false;

    const add = (kind, text) => {
      const m = el("div", "chat-msg " + kind, text);
      log.append(m);
      while (log.children.length > KEEP) log.firstChild.remove();
      log.scrollTop = log.scrollHeight;
      return m;
    };
    const mood = (m) => { if (opts.onMood) { try { opts.onMood(m); } catch (e) { /* the buddy must not break the chat */ } } };
    const setBusy = (b) => { busy = b; go.disabled = b; input.setAttribute("aria-busy", String(b)); };

    // The buddy's answer: its own brain first; the optional model only for things the brain doesn't know.
    async function answer(text) {
      const own = C.reply(who, text, { avoid: lastReply, audience: audience === "parent" ? "parent" : undefined });
      if (own.intent !== "unknown" || !opts.remote) return own;
      try {
        const got = await withTimeout(opts.remote(text, history.slice(0, -1).slice(-6)), opts.remoteMs || REMOTE_MS);
        const safe = C.safeReply(got, audience === "child" ? "family" : "adult");
        if (safe) return { text: safe, mood: "happy", intent: "model" };
      } catch (e) { /* model off, slow or broken: use the written line */ }
      return own;
    }

    // Show the message, wait for an answer (with a short typing pause so it does not feel jumpy), show the reply and set the buddy's mood.
    async function send(raw) {
      const text = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
      if (!text || busy || destroyed) return null;
      chips.hidden = true;
      add("me", text);
      history.push({ role: "user", content: text });
      input.value = "";
      setBusy(true); mood("thinking");
      const typing = add("bot chat-typing", "");
      typing.setAttribute("aria-label", `${name} is typing`);
      typing.append(el("i"), el("i"), el("i"));
      const started = Date.now();
      const out = await answer(text);
      const wait = Math.max(0, (opts.beat == null ? 450 : opts.beat) - (Date.now() - started));   // a beat, so a quick answer doesn't feel jumpy
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (destroyed) return null;
      typing.remove();
      add("bot", out.text);
      history.push({ role: "assistant", content: out.text });
      lastReply = out.text;
      mood(out.mood || "happy");
      setBusy(false);
      if (!panel.hidden) input.focus();
      return out;
    }

    form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
    x.addEventListener("click", () => close());
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });

    function open() {
      if (destroyed) return;
      panel.hidden = false;
      if (!intro) { intro = true; add("bot", INTRO[audience === "parent" ? "family" : who]); }
      mood("happy");
      input.focus();
      if (opts.onOpen) opts.onOpen();
    }
    function close() {
      if (panel.hidden) return;
      panel.hidden = true;
      if (opts.onClose) opts.onClose();
    }
    // Remove the panel and forget the conversation.
    function destroy() { destroyed = true; panel.remove(); history.length = 0; }

    return { el: panel, input, open, close, toggle() { if (panel.hidden) open(); else close(); }, send, destroy,
             get isOpen() { return !panel.hidden; }, get history() { return history.slice(); } };
  }

  const api = { mount, MAX_LEN, STARTERS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseChat = api;
})(typeof self !== "undefined" ? self : this);
