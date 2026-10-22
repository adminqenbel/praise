// The buddy on screen: a small pet that lives on the page. It breathes, blinks, looks where your pointer goes,
// turns toward you, hops, hums, yawns, falls asleep when ignored, and reacts when you poke or pet it. It also talks
// in a bubble and celebrates. Plain DOM, no dependencies.
//
//   const buddy = PraiseBuddy.mount(el, { who: "family", base: "../companion/", height: 220 });
//   buddy.say("Hello!", "happy");      // text and mood together
//   buddy.setMood("thinking");
//   await buddy.enter();               // bounce in
//   buddy.destroy();
//
// Options: who, base, height, mood, bubble (default true), side (compact popup layout),
//   life    (default true)  idle behaviour, pointer-following and play; always off under "reduce motion"
//   talk    (default true)  play reactions may put a line in the bubble; turn off where the bubble carries a message
//   sleeps  (default false) nods off after a while without attention, wakes when you come back
//   wander  (px, default 0) now and then walks a little way left and right
(function (root) {
  "use strict";

  // Where each overlay face sits on its sprite (percent). Measured by scripts/make_faces.py.
  const FACE = {
    family: { band: [33, 26, 90, 55], ratio: [389, 520] },
    adult: { band: [19, 20, 78, 45], ratio: [418, 520] },
  };
  // Which face image shows for which mood; the original smiling face needs no overlay.
  const FACE_FOR = { curious: "curious", thinking: "thinking", sleepy: "sleepy", alert: "alert", sorry: "sorry", shy: "shy" };
  // Small tables that decide which expressions blink, which moods allow wandering about, and which speech bubbles must not be replaced.
  const BLINKS = new Set(["curious", "alert", "thinking", "sorry", "look"]);
  const FX = { curious: "?", alert: "!", thinking: "...", sleepy: "z z z", sorry: "", shy: "", happy: "", nod: "", celebrate: "" };
  const CONFETTI = ["#ffb627", "#e8508a", "#2fbf9b", "#4a8fe7", "#8b5cf6", "#ffffff"];
  const CALM = new Set(["happy", "nod", "thinking", "curious"]);   // moods in which it is fine to wander off and play
  const STICKY = new Set(["alert", "sorry"]);                       // moods whose bubble must not be talked over

  const reduceMotion = () => !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Ask the extension's background worker for a reworded line (not available in the dashboard).
  // Only chatty lines are ever reworded; lines explaining a block or warning always stay as written.
  const POLISH = new Set(["greet", "waiting", "asked", "approved", "allowed", "paired", "protected", "paused", "continued"]);
  async function polish(who, kind, line) {
    try {
      if (!POLISH.has(kind) || !root.chrome || !root.chrome.runtime || !root.chrome.runtime.id || !root.PraiseCompanion) return null;
      const res = await root.chrome.runtime.sendMessage({ type: "companion_line", who, kind, line });
      return res && res.line ? root.PraiseCompanion.safeLine(res.line) : null;
    } catch (e) { return null; }
  }

  // Create the buddy inside `container` and return its controls: say(), setMood(), enter(), poke(), destroy()...
  function mount(container, opts = {}) {
    const who = opts.who === "adult" ? "adult" : "family";
    const base = opts.base || "companion/";
    const face = FACE[who];
    const height = opts.height || 220;
    const showBubble = opts.bubble !== false;
    const life = opts.life !== false && !reduceMotion();
    let talk = opts.talk !== false;
    const wander = life && !opts.side ? Number(opts.wander) || 0 : 0;

    const wrap = el("div", `buddy buddy-${who}${opts.side ? " buddy-side" : ""}`);
    wrap.style.setProperty("--buddy-h", height + "px");
    const bubble = showBubble ? el("div", "buddy-bubble") : null;
    if (bubble) { bubble.setAttribute("role", "status"); bubble.setAttribute("aria-live", "polite"); bubble.hidden = true; wrap.append(bubble); }

    const walk = el("div", "buddy-walk");
    const body = el("div", "buddy-body");
    const turn = el("div", "buddy-turn");
    const img = el("img", "buddy-base");
    img.alt = ""; img.draggable = false; img.src = `${base}robot-${who}${height <= 260 ? "-sm" : ""}.png`;
    img.style.height = height + "px";
    const overlay = el("img", "buddy-face");
    overlay.alt = ""; overlay.draggable = false; overlay.hidden = true;
    overlay.style.left = face.band[0] + "%";
    overlay.style.top = face.band[1] + "%";
    overlay.style.width = face.band[2] - face.band[0] + "%";
    const fx = el("span", "buddy-fx"); fx.setAttribute("aria-hidden", "true");
    turn.append(img, overlay);
    body.append(turn, fx);
    walk.append(body, el("div", "buddy-shadow"));
    wrap.append(walk);
    container.replaceChildren(wrap);

    let mood = "happy", destroyed = false;
    let temp = null;                 // a face worn for a moment (blink, shy, yawn...)
    let asleep = false, busy = false, tracking = false, lookingAround = false;
    let eye = { x: 0, y: 0 };
    let sticky = false, lastTouch = Date.now(), lastPetLine = "";
    let saved = null;                // the bubble's text while a play line is covering it
    let pokes = [];
    const timers = new Set();
    const named = {};                // timers we may need to cancel by name

    const later = (fn, ms) => {
      const t = setTimeout(() => { timers.delete(t); if (!destroyed) fn(); }, ms);
      timers.add(t);
      return t;
    };
    const namedLater = (name, fn, ms) => { clearTimeout(named[name]); named[name] = later(fn, ms); };

    // ---- the face ---------------------------------------------------------------------------------
    function faceName() {
      if (temp) return temp;
      if (asleep) return "sleepy";
      if ((mood === "happy" || mood === "nod") && (tracking || lookingAround)) return "look";   // eyes open while it watches you
      return FACE_FOR[mood] || null;
    }
    // Show the right face picture for the current mood, and slide the eyes to where the pointer is.
    function paint() {
      const n = faceName();
      if (!n) { overlay.hidden = true; delete overlay.dataset.n; return; }
      if (overlay.dataset.n !== n) { overlay.src = `${base}face-${who}-${n}.png`; overlay.dataset.n = n; }
      overlay.hidden = false;
      overlay.style.transform = `translate(${(eye.x * 5).toFixed(1)}%, ${(eye.y * 12).toFixed(1)}%)`;   // the eyes move inside the glass
    }
    const wear = (name, ms) => { temp = name; paint(); namedLater("temp", () => { temp = null; paint(); }, ms); };

    function setMood(next) {
      mood = next in FX ? next : "happy";
      wrap.dataset.mood = mood;
      fx.textContent = asleep ? "z z z" : FX[mood];
      fx.hidden = !fx.textContent;
      if (mood === "celebrate") confetti();
      paint();
      scheduleBlink();
    }

    // Blink at random moments, now and then twice in a row.
    function scheduleBlink() {
      if (!life) return;
      namedLater("blink", () => {
        const n = faceName();
        if (!asleep && !temp && n && BLINKS.has(n)) {
          temp = "blink"; paint();
          later(() => { temp = null; paint(); }, 140);
          if (Math.random() < .25) later(() => { if (!temp && BLINKS.has(faceName())) { temp = "blink"; paint(); later(() => { temp = null; paint(); }, 120); } }, 360);   // a double blink
        }
        scheduleBlink();
      }, rnd(2200, 5200));
    }

    // ---- bits that float up: hearts, notes, sparkles, confetti ---------------------------------------
    function particle(ch, color, n = 1) {
      if (!life) return;
      for (let i = 0; i < n; i++) {
        const p = el("i", "buddy-p", ch);
        p.style.color = color;
        p.style.setProperty("--x", rnd(-46, 46).toFixed(0) + "px");
        p.style.setProperty("--d", (i * 0.18).toFixed(2) + "s");
        p.style.left = rnd(34, 66).toFixed(0) + "%";
        body.append(p);
        later(() => p.remove(), 2200);
      }
    }
    const hearts = (n) => particle("♥", "#e8508a", n);

    function confetti() {
      if (reduceMotion()) return;
      for (let i = 0; i < 16; i++) {
        const c = el("i", "buddy-confetti");
        c.style.setProperty("--x", (Math.random() * 160 - 80).toFixed(0) + "px");
        c.style.setProperty("--r", (Math.random() * 720 - 360).toFixed(0) + "deg");
        c.style.setProperty("--d", (Math.random() * 0.5).toFixed(2) + "s");
        c.style.background = CONFETTI[i % CONFETTI.length];
        body.append(c);
        later(() => c.remove(), 2200);
      }
    }

    // ---- the bubble --------------------------------------------------------------------------------
    function showText(text) {
      bubble.hidden = false;
      bubble.classList.remove("pop"); void bubble.offsetWidth; bubble.classList.add("pop");   // replay the pop
      bubble.textContent = text;
    }

    // say(text, mood, kind): `kind` (a PraiseCompanion line kind) lets a local model reword the line a moment later,
    // if the extension is connected to a server that has one. The template shows first and always stands on its own.
    function say(text, nextMood, kind) {
      wake(true);
      saved = null; clearTimeout(named.restore);
      lastTouch = Date.now();
      if (nextMood) { setMood(nextMood); sticky = STICKY.has(nextMood); }
      if (!bubble) return;
      if (!text) { bubble.hidden = true; return; }
      showText(text);
      if (kind) polish(who, kind, text).then((better) => {
        if (better && !destroyed && bubble.textContent === text) bubble.textContent = better;
      });
    }

    // A line from play ("Hehe, that tickles!") covers the bubble for a few seconds, then the real message comes back.
    function petLine(kind) {
      if (!talk || !bubble || sticky || !root.PraiseCompanion) return;
      const s = root.PraiseCompanion.say(who, kind, { avoid: lastPetLine, bedtimeNote: false });
      lastPetLine = s.text;
      if (!saved) saved = { text: bubble.textContent, hidden: bubble.hidden };
      showText(s.text);
      namedLater("restore", () => {
        if (saved) { bubble.textContent = saved.text; bubble.hidden = saved.hidden; saved = null; }
      }, kind === "snooze" ? 600000 : 5200);
    }

    // ---- doing things ------------------------------------------------------------------------------
    function act(name, ms, then) {
      wrap.classList.add("act-" + name);
      busy = true;
      later(() => { wrap.classList.remove("act-" + name); busy = false; if (then) then(); }, ms);
    }
    const free = () => life && !destroyed && !asleep && !busy && !wrap.classList.contains("entering") &&
      document.visibilityState !== "hidden" && CALM.has(mood);

    // Glance left, right and up, then back to the middle.
    function lookAround() {
      lookingAround = true;
      const stops = [[-.9, -.1], [.9, .2], [.3, -.6], [0, 0]];
      stops.forEach(([x, y], i) => later(() => { if (lookingAround) { eye = { x, y }; paint(); } }, 150 + i * 700));
      later(() => { lookingAround = false; eye = { x: 0, y: 0 }; paint(); }, 150 + stops.length * 700);
    }

    // Things it does by itself when nobody is touching it, with a weight for how often (hop, wiggle, stretch, look around, hum, yawn).
    const IDLE = [
      ["hop", 3, () => { act("hop", 800); particle("✦", "#ffb627", 2); }],
      ["wiggle", 3, () => act("wiggle", 800)],
      ["stretch", 2, () => act("stretch", 1500)],
      ["look", 4, lookAround],
      ["hum", 2, () => { act("hum", 2400); particle("♪", who === "adult" ? "#0e7c7b" : "#8b5cf6", 3); }],
      ["yawn", 1, () => { act("yawn", 1500); wear("sleepy", 1400); if (Math.random() < .5) petLine("yawn"); }],
    ];
    // Pick one idle action at random (weighted) when the buddy is free and was not touched recently.
    function idleTick() {
      if (free() && Date.now() - lastTouch > 2500) {
        const total = IDLE.reduce((n, a) => n + a[1], 0);
        let r = Math.random() * total;
        for (const [, w, run] of IDLE) { if ((r -= w) <= 0) { run(); break; } }
      }
      namedLater("idle", idleTick, rnd(4500, 9000));
    }

    // ---- sleeping ----------------------------------------------------------------------------------
    function sleepCheck() {
      const limit = root.PraiseCompanion && root.PraiseCompanion.timeOfDay() === "late" ? 30000 : 75000;
      if (free() && Date.now() - lastTouch > limit) {
        act("yawn", 1500, () => {
          asleep = true; wrap.classList.add("asleep"); setMood(mood); petLine("snooze");
        });
        wear("sleepy", 1400);
      }
      namedLater("sleep", sleepCheck, 5000);
    }
    function wake(quiet) {
      if (!asleep) return;
      asleep = false; wrap.classList.remove("asleep"); temp = null;
      setMood(mood);
      if (!quiet) { act("stretch", 1500); petLine("wake"); }
    }

    // ---- pointer: look at it, turn toward it ----------------------------------------------------------
    let pointer = null, raf = 0;
    // Turn toward the pointer: move the eyes and tilt the body, then relax after 2.6 seconds.
    function follow() {
      raf = 0;
      if (!pointer || asleep || destroyed) return;
      const r = body.getBoundingClientRect();
      if (!r.width) return;
      const dx = clamp((pointer.x - (r.left + r.width / 2)) / 280, -1, 1);
      const dy = clamp((pointer.y - (r.top + r.height * .3)) / 280, -1, 1);
      eye = { x: dx, y: dy };
      turn.style.setProperty("--lx", dx.toFixed(3));
      turn.style.setProperty("--ly", dy.toFixed(3));
      tracking = true; paint();
      namedLater("track", () => {
        tracking = false; eye = { x: 0, y: 0 };
        turn.style.setProperty("--lx", "0"); turn.style.setProperty("--ly", "0"); paint();
      }, 2600);
    }
    function onMove(e) {
      if (e.pointerType === "touch") return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!raf && !busy && !lookingAround) raf = requestAnimationFrame(follow);
    }

    // ---- play: poke, double-tap, pet --------------------------------------------------------------------
    // Reaction to a click. Five quick pokes in 3 seconds make it dizzy and it spins.
    function poke() {
      lastTouch = Date.now();
      if (asleep) { wake(); return; }
      if (!life) { petLine("poke"); return; }
      const now = Date.now();
      pokes = pokes.filter((t) => now - t < 3000); pokes.push(now);
      if (pokes.length >= 5) {                       // too much poking: spin
        pokes = [];
        act("spin", 1200); wear("thinking", 1400); particle("✦", "#ffb627", 3); petLine("dizzy");
        return;
      }
      act("poke", 480); wear("shy", 1000); hearts(2); petLine("poke");
    }
    function backflip() {
      if (!life || asleep) return;
      pokes = [];
      act("flip", 950); particle("✦", "#ffb627", 3);
    }

    let hoverTimer = 0;
    // Resting the pointer on it for a moment counts as petting: it purrs and shows hearts.
    function hoverStart() {
      lastTouch = Date.now();
      if (asleep) { namedLater("wakehover", () => wake(), 500); return; }
      if (!life) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {                  // stayed over it a while: that counts as petting
        if (destroyed || busy || asleep) return;
        act("purr", 2200); wear("shy", 2000); hearts(4); petLine("purr");
      }, 2300);
    }
    function hoverEnd() { clearTimeout(hoverTimer); clearTimeout(named.wakehover); }

    // ---- walking about ------------------------------------------------------------------------------
    let at = 0;
    // Pace left and right a little (only on pages that allow it, like the door page).
    function stroll() {
      if (free() && !tracking && Date.now() - lastTouch > 4000) {
        let to = rnd(-wander, wander);
        if (Math.abs(to - at) < 30) to = at < 0 ? wander * .7 : -wander * .7;
        const secs = Math.abs(to - at) / 48;
        const dir = to > at ? 1 : -1;
        wrap.classList.add("walking");
        busy = true;
        walk.style.transition = `transform ${secs.toFixed(2)}s linear`;
        walk.style.transform = `translateX(${to.toFixed(0)}px)`;
        turn.style.setProperty("--lx", String(dir * .55));
        at = to;
        later(() => {
          wrap.classList.remove("walking"); busy = false;
          turn.style.setProperty("--lx", "0");
        }, secs * 1000);
      }
      namedLater("stroll", stroll, rnd(9000, 16000));
    }

    // ---- entrance ------------------------------------------------------------------------------------
    function enter() {                       // bounce in from below
      wrap.classList.remove("entered"); void wrap.offsetWidth; wrap.classList.add("entering");
      return new Promise((resolve) => later(() => { wrap.classList.remove("entering"); wrap.classList.add("entered"); resolve(); }, reduceMotion() ? 0 : 700));
    }

    // Stop every timer and listener and remove the buddy from the page.
    function destroy() {
      destroyed = true;
      timers.forEach(clearTimeout); clearTimeout(hoverTimer);
      Object.values(named).forEach(clearTimeout);
      if (raf) cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onMove);
      wrap.remove();
    }

    body.addEventListener("click", poke);
    body.addEventListener("dblclick", backflip);
    body.addEventListener("pointerenter", hoverStart);
    body.addEventListener("pointerleave", hoverEnd);
    if (life) {
      root.addEventListener("pointermove", onMove, { passive: true });
      namedLater("idle", idleTick, rnd(3500, 6000));
      if (opts.sleeps) namedLater("sleep", sleepCheck, 5000);
      if (wander) namedLater("stroll", stroll, rnd(6000, 10000));
    }

    setMood(opts.mood || "happy");
    // setTalk(false) silences play lines ("Hehe, that tickles!") while something else, like a chat, is using the bubble's place.
    const setTalk = (on) => { talk = !!on; if (!talk && saved) { bubble.textContent = saved.text; bubble.hidden = saved.hidden; saved = null; } };
    return { el: wrap, setMood, say, enter, destroy, poke, setTalk, get mood() { return mood; }, get asleep() { return asleep; } };
  }

  const api = { mount, FACE, FACE_FOR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseBuddy = api;
})(typeof self !== "undefined" ? self : this);
