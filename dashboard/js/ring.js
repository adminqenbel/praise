"use strict";

// The protection ring: four arcs, one per layer of Praise Shield, lit when that layer is on and the
// browser is connected. The picture IS the status, so it also says which layers are off.
const PostureRing = (() => {
  // The four layers of protection the ring shows.
  const LAYERS = [
    { key: "safe", label: "Safe browsing", detail: "Warns about scams, fake bank pages and malware" },
    { key: "trackers", label: "Trackers and cookies", detail: "Blocks trackers, cleans links, removes tracking cookies" },
    { key: "data", label: "Data guard", detail: "Asks before sensitive data goes to a risky page" },
    { key: "passwords", label: "Password safety", detail: "Checks passwords against known breaches" },
  ];

  // settings: the policy's settings object (any groups may be missing); connected: a browser is paired.
  function layersFor(settings, connected) {
    const s = settings || {};
    const privacy = s.privacy || {}, data = s.sensitive_data || {}, pw = s.passwords || {};
    const flags = {
      safe: true,                                                     // checking sites is the core: always part of it
      trackers: privacy.block_trackers !== false || privacy.block_fingerprinting !== false || privacy.strip_tracking_params !== false,
      data: data.warn !== false,
      passwords: pw.breach_check !== false || pw.reuse_check === true,
    };
    return LAYERS.map((l) => ({ ...l, on: !!connected && flags[l.key], enabled: flags[l.key] }));
  }

  // One word for the overall state: fully protected, partly, off or not connected.
  function posture(layers, connected) {
    const on = layers.filter((l) => l.on).length;
    if (!connected) return { on, total: layers.length, label: "Not connected", level: "off" };
    if (on === layers.length) return { on, total: layers.length, label: "Fully protected", level: "full" };
    if (on === 0) return { on, total: layers.length, label: "Protection is off", level: "off" };
    return { on, total: layers.length, label: "Partly protected", level: "partial" };
  }

  const NS = "http://www.w3.org/2000/svg";
  // Maths helper: a point on a circle, given an angle in degrees.
  const polar = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];

  // SVG path for one arc of the ring.
  function arcPath(cx, cy, r, a0, a1) {
    const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  // Draws the ring into `container`. `onToggle(key)` (optional) makes the arcs clickable (landing demo).
  function render(container, layers, { animate = true, onToggle = null, size = 220 } = {}) {
    const on = layers.filter((l) => l.on).length;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 200 200");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Protection: ${on} of ${layers.length} layers on`);
    svg.classList.add("ring");
    if (animate) svg.classList.add("animate");

    const gap = 12, span = (360 - gap * layers.length) / layers.length;
    layers.forEach((l, i) => {
      const a0 = -90 + gap / 2 + i * (span + gap);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", arcPath(100, 100, 80, a0, a0 + span));
      path.setAttribute("pathLength", "100");
      path.setAttribute("class", "arc " + (l.on ? "on" : "off"));
      path.style.setProperty("--i", i);
      const title = document.createElementNS(NS, "title");
      title.textContent = `${l.label}: ${l.on ? "on" : "off"}`;
      path.append(title);
      if (onToggle) {
        path.setAttribute("tabindex", "0");
        path.setAttribute("role", "button");
        path.setAttribute("aria-pressed", String(l.on));
        path.setAttribute("aria-label", `${l.label}: ${l.on ? "on" : "off"}. Press to switch.`);
        path.addEventListener("click", () => onToggle(l.key));
        path.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(l.key); } });
      }
      svg.append(path);
    });

    const num = document.createElementNS(NS, "text");
    num.setAttribute("x", "100"); num.setAttribute("y", "104"); num.setAttribute("text-anchor", "middle");
    num.setAttribute("class", "ring-num");
    num.textContent = `${on}/${layers.length}`;
    const cap = document.createElementNS(NS, "text");
    cap.setAttribute("x", "100"); cap.setAttribute("y", "126"); cap.setAttribute("text-anchor", "middle");
    cap.setAttribute("class", "ring-cap");
    cap.textContent = "layers on";
    svg.append(num, cap);
    container.replaceChildren(svg);
    return posture(layers, layers.some((l) => l.enabled));
  }

  return { LAYERS, layersFor, posture, render, arcPath };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PostureRing;
