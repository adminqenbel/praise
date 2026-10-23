"use strict";

// Wake the API now, so sign-up is quick if the visitor goes there next (it sleeps when idle).
if (typeof Api !== "undefined") Api.warm();

// The two buddies on the landing hub. Each says hello for the time of day, answers when you hover
// its card, and reacts when you tap it. Nothing here talks to the server.
(() => {
  // The two characters on the landing page: who they are and what they say when you hover their card.
  const BUDDIES = [
    { who: "family", host: "buddyFamily", intro: "I'm Dori. I look after a child's browsing, and you stay in charge.", mood: "curious" },
    { who: "adult", host: "buddyAdult", intro: "I'm Ringo. I speak up before anything risky, and stay quiet the rest of the time.", mood: "alert" },
  ];
  const TAPS = ["happy", "celebrate", "shy", "curious", "nod"];

  BUDDIES.forEach(({ who, host, intro, mood }, i) => {
    const slot = document.getElementById(host);
    if (!slot || !self.PraiseBuddy) return;
    const buddy = PraiseBuddy.mount(slot, { who, height: 104, side: true, sleeps: true });
    const card = slot.closest(".path");
    let taps = 0;

    setTimeout(async () => {                                            // a staggered hello, one per buddy
      await buddy.enter();
      const s = PraiseCompanion.say(who, "greet");
      buddy.say(s.text, s.mood);
    }, 250 + i * 350);

    const hover = () => buddy.say(intro, mood);
    const rest = () => { const s = PraiseCompanion.say(who, "greet"); buddy.say(s.text, s.mood); };
    card.addEventListener("mouseenter", hover);
    card.addEventListener("focusin", hover);
    card.addEventListener("mouseleave", rest);

    slot.addEventListener("click", () => {
      const m = TAPS[taps++ % TAPS.length];
      if (m === "celebrate") buddy.say("Yay!", m);
      else if (m === "shy") buddy.say("Hehe, hello!", m);
      else { const s = PraiseCompanion.say(who, "greet"); buddy.say(s.text, m); }
    });
  });
})();
