"use strict";

// Children page (family) / My browsers page (adult): list profiles, choose each one's rules, connect or remove browsers.
Praise.start("children.html", async (main, { user }) => {
  const adult = user.account_type === "adult";
  main.append(adult
    ? pageHead("My browsers", "Connect Praise Shield on each browser you use. Each code works once and expires after 15 minutes.")
    : pageHead("Children", "Each child gets a pairing code to connect their browser. Pick the rule set that applies to them."));
  const list = h("div");
  main.append(list);

  // Fetch profiles and rule sets together, then redraw the list.
  async function load() {
    const [{ children }, { policies }] = await Promise.all([Api.get("/api/children"), Api.get("/api/policies")]);
    list.replaceChildren();

    for (const c of children) list.append(childSection(c, policies));

    if (adult) return;   // one profile: you
    const name = h("input", { type: "text", id: "newchild", maxlength: 100, placeholder: "Child's first name", required: true });
    list.append(h("section", { class: "block" },
      h("header", null, h("h2", null, "Add a child")),
      h("form", { class: "row", onsubmit: async (e) => {
        e.preventDefault();
        const ok = await act(e.submitter, () => Api.post("/api/children", { name: name.value }), `${name.value} added`);
        if (ok) load();
      } }, h("div", null, h("label", { for: "newchild" }, "Name"), name), h("button", { type: "submit", style: "align-self:end" }, "Add child"))));
  }

  // One card per profile: its rule set, its connected browsers and a form to get a pairing code.
  function childSection(c, policies) {
    const policySel = h("select", { id: `pol-${c.id}`, onchange: async (e) => {
      const v = e.target.value;
      await act(e.target, () => Api.put(`/api/children/${c.id}/policy`, { policy_id: v ? Number(v) : null }), "Rules updated");
    } },
      h("option", { value: "" }, "Strict default (Child safe)"),
      policies.map((p) => h("option", { value: p.id, selected: p.id === c.policy_id }, p.name)));

    const codeBox = h("div", { hidden: true });
    const devices = h("ul", { class: "list" });
    if (!c.devices.length) devices.append(h("li", { class: "muted" }, "No browsers connected yet."));
    for (const d of c.devices) {
      const status = d.revoked ? h("span", { class: "chip bad" }, "Removed")
        : !d.paired ? h("span", { class: "chip warn" }, "Waiting for code")
        : h("span", { class: "chip ok" }, "Connected");
      // A child's browser can only leave with a parent's one-time code, typed into that browser's popup.
      const leaveCode = adult || !d.paired || d.revoked ? null : h("button", { class: "quiet small", onclick: async (e) => {
        const out = await act(e.target, () => Api.post(`/api/devices/${d.id}/disconnect-code`));
        if (!out) return;
        codeBox.hidden = false;
        codeBox.replaceChildren(
          h("p", null, `To disconnect ${d.label || "this browser"}, open the Praise popup on it and enter:`),
          h("div", { class: "code", "aria-label": "Disconnect code" }, out.code),
          h("p", { class: "muted", style: "margin-top:.6rem" }, "The code works once, only on that browser, and expires in 15 minutes."),
          h("button", { class: "quiet small", type: "button", onclick: load }, "Done"));
      } }, "Disconnect code");
      devices.append(h("li", null,
        h("span", null, h("strong", null, d.label || `Browser ${d.id}`), " ", status,
          d.paired && !d.revoked ? h("span", { class: "muted" }, ` last seen ${timeAgo(d.last_seen)}`) : null),
        h("span", { style: "display:flex;gap:.5rem;flex-wrap:wrap" }, leaveCode,
          d.revoked ? null : h("button", { class: "danger small", onclick: async (e) => {
            const btn = e.target;
            if (btn.dataset.armed !== "1") {      // two-step confirm without a pop-up dialog
              btn.dataset.armed = "1"; btn.textContent = "Click again to remove";
              setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Remove browser"; }, 4000);
              return;
            }
            const ok = await act(btn, () => Api.post(`/api/devices/${d.id}/revoke`), "Browser removed");
            if (ok) load();
          } }, "Remove browser"))));
    }

    const label = h("input", { type: "text", maxlength: 100, placeholder: "e.g. School laptop", "aria-label": "Browser name" });
    // Ask the server for a one-time pairing code and show it to be typed into the extension popup.
    const addDevice = h("form", { class: "row", onsubmit: async (e) => {
      e.preventDefault();
      const out = await act(e.submitter, () => Api.post(`/api/children/${c.id}/devices`, { label: label.value }));
      if (!out) return;
      codeBox.hidden = false;
      codeBox.replaceChildren(
        h("p", null, "In the extension popup on this browser, enter:"),
        h("div", { class: "code", "aria-label": "Pairing code" }, out.pairing_code),
        h("p", { class: "muted", style: "margin-top:.6rem" }, "The code works once and expires in 15 minutes."),
        h("button", { class: "quiet small", type: "button", onclick: load }, "Done"));
    } }, label, h("button", { type: "submit", class: "quiet" }, "Get a pairing code"));

    return h("section", { class: "block" },
      h("header", null, h("h2", null, h("span", { class: "dot", style: `--door:${childHue(c.id)}` }), c.name)),
      h("div", { class: "field" }, h("label", { for: `pol-${c.id}` }, "Rules that apply"), policySel,
        h("p", { class: "muted", style: "margin:.4rem 0 0" }, "Manage rule sets on the ", h("a", { href: "policies.html" }, "Rules"), " page.")),
      h("hr", { class: "rule" }),
      h("h3", { style: "margin-bottom:.4rem" }, "Browsers"), devices,
      h("div", { style: "margin-top:1rem" }, addDevice), codeBox);
  }

  await load();
});
