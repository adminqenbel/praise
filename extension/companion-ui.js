// The buddy on screen: a small pet that lives on the page. It breathes, blinks, looks where your pointer goes,
// turns toward you, hops, hums, yawns, falls asleep when ignored, and reacts when you poke or pet it. It also talks
// in a bubble and celebrates. Plain DOM, no dependencies.
//
//   const buddy = PraiseBuddy.mount(el, { who: "family", height: 220 });
//   buddy.say("Hello!", "happy");      // text and mood together
//   buddy.setMood("thinking");
//   await buddy.enter();               // bounce in
//   buddy.destroy();
//
// The buddy is drawn as inline SVG (no picture files), so a page's content rules can't block it. Options: who, height, mood,
//   bubble (default true), side (compact popup layout),
//   life    (default true)  idle behaviour, pointer-following and play; always off under "reduce motion"
//   talk    (default true)  play reactions may put a line in the bubble; turn off where the bubble carries a message
//   sleeps  (default false) nods off after a while without attention, wakes when you come back
//   wander  (px, default 0) now and then walks a little way left and right
(function (root) {
  "use strict";

  // The faces the buddy can wear, drawn on its screen around the point (0, 0): each is a list of [tag, attributes] shapes.
  // Strokes and fills take the eyes' colour (css --b-eye), so one drawing serves both buddies.
  const LINE = { fill: "none", stroke: "currentColor", "stroke-width": 6, "stroke-linecap": "round", "stroke-linejoin": "round" };
  const BROW = { ...LINE, "stroke-width": 4 };
  const pill = (x, y, w, h) => ["rect", { x, y, width: w, height: h, rx: w / 2, fill: "currentColor" }];
  const arc = (d) => ["path", { d, ...LINE }];
  const HAPPY = [arc("M-27 5Q-17 -9-7 5"), arc("M7 5Q17 -9 27 5")];
  const FACES = {
    happy: HAPPY,
    look: [pill(-25, -11, 13, 23), pill(12, -11, 13, 23)],
    blink: [arc("M-26 2H-10"), arc("M10 2H26")],
    curious: [pill(-26, -14, 15, 28), pill(12, -6, 13, 18), ["path", { d: "M-27 -22Q-18 -28-9 -22", ...BROW }]],
    thinking: [pill(-22, -16, 12, 20), pill(14, -16, 12, 20)],
    sleepy: [arc("M-27 -1Q-17 10-7 -1"), arc("M7 -1Q17 10 27 -1")],
    alert: [pill(-26, -16, 14, 30), pill(12, -16, 14, 30), ["path", { d: "M-28 -24Q-19 -30-10 -24", ...BROW }], ["path", { d: "M10 -24Q19 -30 28 -24", ...BROW }]],
    sorry: [pill(-24, -6, 11, 17), pill(13, -6, 11, 17), ["path", { d: "M-28 -12L-10 -19", ...BROW }], ["path", { d: "M28 -12L10 -19", ...BROW }]],
    shy: [...HAPPY, ["ellipse", { cx: -36, cy: 15, rx: 7, ry: 4.5, fill: "#ff8fa3", opacity: ".55" }], ["ellipse", { cx: 36, cy: 15, rx: 7, ry: 4.5, fill: "#ff8fa3", opacity: ".55" }]],
  };
  // Which face shows for which mood; a happy buddy simply smiles.
  const FACE_FOR = { curious: "curious", thinking: "thinking", sleepy: "sleepy", alert: "alert", sorry: "sorry", shy: "shy" };
  // Small tables that decide which expressions blink, which moods allow wandering about, and which speech bubbles must not be replaced.
  const BLINKS = new Set(["curious", "alert", "thinking", "sorry", "look"]);
  const FX = { curious: "?", alert: "!", thinking: "...", sleepy: "z z z", sorry: "", shy: "", happy: "", nod: "", celebrate: "" };
  const CONFETTI = ["#ffb627", "#e8508a", "#2fbf9b", "#4a8fe7", "#7c4dde", "#ffffff"];
  const CALM = new Set(["happy", "nod", "thinking", "curious"]);   // moods in which it is fine to wander off and play
  const STICKY = new Set(["alert", "sorry"]);                       // moods whose bubble must not be talked over

  const reduceMotion = () => !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const SVGNS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs, ...kids) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };
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

  // The buddy itself, on a 160 x 200 grid: a rounded head with a dark screen for a face, a small body, ears and a lit antenna.
  // Dori (family) wears a little door on her chest, Ringo (adult) a ring. Colours come from css (--b-*), so the page decides them.
  function drawBot(who) {
    const eyes = svgEl("g", { class: "b-eyes" });
    const chest = who === "adult"
      ? svgEl("circle", { cx: 80, cy: 146, r: 9, fill: "none", "stroke-width": 4, "stroke-dasharray": "11.4 2.7", class: "b-ring" })
      : svgEl("g", null, svgEl("path", { d: "M71 162v-16a9 9 0 0 1 18 0v16z", class: "b-trim" }), svgEl("circle", { cx: 84, cy: 154, r: 1.9, class: "b-glow" }));
    const svg = svgEl("svg", { viewBox: "0 0 160 200", class: "buddy-base", "aria-hidden": "true", focusable: "false" },
      svgEl("rect", { x: 35, y: 120, width: 14, height: 36, rx: 7, class: "b-accent b-arm", transform: "rotate(10 42 126)" }),
      svgEl("rect", { x: 111, y: 120, width: 14, height: 36, rx: 7, class: "b-accent b-arm", transform: "rotate(-10 118 126)" }),
      svgEl("rect", { x: 55, y: 166, width: 21, height: 13, rx: 6.5, class: "b-accent" }),
      svgEl("rect", { x: 84, y: 166, width: 21, height: 13, rx: 6.5, class: "b-accent" }),
      svgEl("rect", { x: 49, y: 114, width: 62, height: 58, rx: 25, class: "b-shell" }),
      chest,
      svgEl("rect", { x: 9, y: 60, width: 15, height: 32, rx: 7.5, class: "b-accent" }),
      svgEl("rect", { x: 136, y: 60, width: 15, height: 32, rx: 7.5, class: "b-accent" }),
      svgEl("path", { d: "M80 24V13", class: "b-stem" }),
      svgEl("circle", { cx: 80, cy: 9, r: 6.5, class: "b-glow" }),
      svgEl("rect", { x: 22, y: 24, width: 116, height: 100, rx: 42, class: "b-shell" }),
      svgEl("rect", { x: 34, y: 39, width: 92, height: 70, rx: 29, class: "b-screen" }),
      svgEl("g", { transform: "translate(80 74)" }, eyes));
    return { svg, eyes };
  }

  // Create the buddy inside `container` and return its controls: say(), setMood(), enter(), poke(), destroy()...
  function mount(container, opts = {}) {
    const who = opts.who === "adult" ? "adult" : "family";
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
    const bot = drawBot(who);
    bot.svg.style.height = height + "px";
    bot.svg.style.width = (height * .8).toFixed(1) + "px";
    const fx = el("span", "buddy-fx"); fx.setAttribute("aria-hidden", "true");
    turn.append(bot.svg);
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
    // Draw the right face for the current mood, and slide the eyes to where the pointer is.
    let drawn = null;
    function paint() {
      const n = faceName() || "happy";
      if (drawn !== n) {
        bot.eyes.replaceChildren(...FACES[n].map(([tag, attrs]) => svgEl(tag, attrs)));
        drawn = n;
      }
      bot.eyes.style.transform = `translate(${(eye.x * 7).toFixed(1)}px, ${(eye.y * 6).toFixed(1)}px)`;   // the eyes move inside the glass
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
      ["hum", 2, () => { act("hum", 2400); particle("♪", who === "adult" ? "#d7263d" : "#7c4dde", 3); }],
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

  const api = { mount, FACES, FACE_FOR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseBuddy = api;
})(typeof self !== "undefined" ? self : this);
