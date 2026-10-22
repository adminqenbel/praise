"use strict";

// The hero door: tap to open (a parent saying yes), tap again to close.
(() => {
  const door = document.getElementById("heroDoor");
  const caption = document.getElementById("doorCaption");
  if (!door || !caption) return;
  door.addEventListener("click", () => {
    const open = door.getAttribute("aria-pressed") !== "true";
    door.setAttribute("aria-pressed", String(open));
    caption.textContent = open ? "A parent said yes." : "Tap the door.";
  });
})();
