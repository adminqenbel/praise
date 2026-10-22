"use strict";

// The landing page's demonstration ring: switch a layer and the ring answers.
(() => {
  const host = document.getElementById("ringHost");
  const list = document.getElementById("layerList");
  if (!host || !list) return;

  // Which protection layers are switched on in the demo; the ring redraws whenever one changes.
  const enabled = { safe: true, trackers: true, data: true, passwords: true };
  const layersNow = () => PostureRing.LAYERS.map((l) => ({ ...l, on: enabled[l.key], enabled: enabled[l.key] }));
  let first = true;

  function draw() {
    const layers = layersNow();
    PostureRing.render(host, layers, { animate: first, size: 200,
      onToggle: (key) => { enabled[key] = !enabled[key]; draw(); } });
    host.firstChild.setAttribute("data-interactive", "");
    first = false;

    list.replaceChildren(...layers.map((l) => {
      const li = document.createElement("li");
      li.className = l.on ? "" : "off";
      const pip = Object.assign(document.createElement("span"), { className: "pip" });
      const name = Object.assign(document.createElement("strong"), { textContent: l.label });
      const btn = Object.assign(document.createElement("button"), {
        type: "button", className: "quiet small", textContent: l.on ? "Turn off" : "Turn on" });
      btn.setAttribute("aria-label", `${l.on ? "Turn off" : "Turn on"} ${l.label}`);
      btn.addEventListener("click", () => { enabled[l.key] = !enabled[l.key]; draw(); });
      li.append(pip, name, btn);
      return li;
    }));
  }
  draw();
})();
