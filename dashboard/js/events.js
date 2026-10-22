"use strict";

// Friendly names for the technical event types the extension reports.
const DOWNLOAD_KINDS = {
  executable: "Program", script: "Script", browser_installer: "Browser installer", suspicious: "Suspicious file",
  mime: "Program (by file type)", browser_flagged: "Flagged by the browser", archive: "Archive", ok: "Regular file",
};
const SECURITY_TYPES = {
  external_browser: "Tried to open another browser", tamper: "Tried to open browser settings",
  browser_installer: "Visited a browser download page", ip_address: "Tried to open a site by its number (IP address)",
};

// Tabs of the family activity page: which kind of event each shows and how it is filtered.
const TABS = {
  browsing: { label: "Sites", kind: "browser", filter: (e) => e.decision },
  downloads: { label: "Downloads", kind: "download" },
  security: { label: "Browser attempts", kind: "security" },
  requests: { label: "Requests", kind: "browser", type: "access_request" },
};

// Turn a policy decision into a plain-language label: opened, closed, or waiting for the parent.
function decisionChip(d) {
  if (d.action === "ALLOW") return h("span", { class: "chip ok" }, "Opened");
  if (d.action === "BLOCK") return h("span", { class: "chip bad" }, "Closed");
  return h("span", { class: "chip warn" }, "Waiting for you");
}

// Activity page for the adult space: warnings, blocks and sensitive-data prompts from Praise Shield.
async function adultActivity(main) {
  main.append(pageHead("Activity", "What Praise Shield warned you about, stopped or noticed, newest first."));
  const TABS_A = { warnings: ["Warnings", (t) => ["warning_shown", "site_blocked", "warning_overridden"].includes(t)],
                   data: ["Data and passwords", (t) => t.startsWith("sensitive_")] };
  let tab = "warnings", rows = [], done = false;
  const toolbar = h("div", { class: "row", style: "margin-bottom:1rem" });
  const body = h("section", { class: "block" });
  main.append(toolbar, body);

  async function fetchMore(reset) {
    if (reset) { rows = []; done = false; }
    const q = new URLSearchParams({ kind: "security", limit: "100" });
    if (rows.length) q.set("before", rows[rows.length - 1].timestamp);
    const { events } = await Api.get("/api/events?" + q);
    done = events.length < 100;
    rows = rows.concat(events);
    draw();
  }

  function draw() {
    const shown = rows.filter((e) => TABS_A[tab][1](e.type || "")).map((e) => ({ e, d: describeSecurityEvent(e) })).filter((x) => x.d);
    body.replaceChildren();
    if (!shown.length) body.append(emptyState("Nothing here yet", "Activity appears once Praise Shield is connected and steps in."));
    else body.append(h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "What happened"), h("th", null, "Result"), h("th", null, "Details"))),
      h("tbody", null, shown.map(({ e, d }) => h("tr", null,
        h("td", { class: "muted", title: new Date(e.timestamp).toLocaleString() }, timeAgo(e.timestamp)),
        h("td", null, d.text), h("td", null, h("span", { class: "chip " + d.chip }, d.label)), h("td", null, d.detail)))))));
    if (!done) body.append(h("div", { style: "margin-top:1rem" }, h("button", { class: "quiet", onclick: (ev) => act(ev.target, () => fetchMore(false)) }, "Show older")));
  }

  function drawToolbar() {
    toolbar.replaceChildren(h("div", { class: "seg", role: "tablist" }, Object.entries(TABS_A).map(([k, [label]]) =>
      h("button", { type: "button", "aria-pressed": String(k === tab), onclick: () => { tab = k; drawToolbar(); draw(); } }, label))));
  }
  drawToolbar();
  await fetchMore(true);
}

// Activity page (family): everything each child's browser tried to open, download or do, newest first, with 'Show older' paging.
Praise.start("events.html", async (main, { user }) => {
  if (user.account_type === "adult") return adultActivity(main);
  main.append(pageHead("Activity", "What each browser tried to open, download or do, newest first."));
  const { children } = await Api.get("/api/children");
  const nameOf = (id) => (children.find((c) => c.id === id) || {}).name || "—";

  let tab = "browsing", child = "", rows = [], done = false;
  const toolbar = h("div", { class: "row", style: "margin-bottom:1rem" });
  const body = h("section", { class: "block" });
  main.append(toolbar, body);

  async function fetchMore(reset) {
    if (reset) { rows = []; done = false; }
    const t = TABS[tab];
    const q = new URLSearchParams({ kind: t.kind, limit: "50" });
    if (t.type) q.set("type", t.type);
    if (child) q.set("child_id", child);
    if (rows.length) q.set("before", rows[rows.length - 1].timestamp);
    const { events } = await Api.get("/api/events?" + q);
    done = events.length < 50;
    rows = rows.concat(events);
    draw();
  }

  // The three columns that change per tab.
  function cells(e) {
    if (tab === "browsing") return [e.domain, e.decision ? decisionChip(e.decision) : "", e.decision && (e.decision.category ? catLabel(e.decision.category) : e.decision.reason)];
    if (tab === "downloads") return [e.filename || "(unnamed)", h("span", { class: "chip " + (e.action === "BLOCK" ? "bad" : "ok") }, e.action === "BLOCK" ? "Stopped" : "Allowed"), DOWNLOAD_KINDS[e.kind] || e.kind];
    if (tab === "security") return [SECURITY_TYPES[e.type] || e.type, h("span", { class: "chip bad" }, "Stopped"), e.url ? e.url.slice(0, 70) : e.scheme || ""];
    return [e.domain, h("span", { class: "chip warn" }, "Asked to open"), ""];
  }

  function draw() {
    const heads = { browsing: ["Site", "Result", "Reason"], downloads: ["File", "Result", "Type"], security: ["What happened", "Result", "Details"], requests: ["Site", "Request", ""] }[tab];
    let shown = rows;
    if (TABS[tab].filter) shown = rows.filter(TABS[tab].filter);
    body.replaceChildren();
    if (!shown.length) {
      body.append(emptyState("Nothing here yet", "Activity appears once a connected browser opens pages, downloads files or asks for access."));
      return;
    }
    body.append(h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Child"), heads.map((x) => h("th", null, x)))),
      h("tbody", null, shown.map((e) => h("tr", null,
        h("td", { class: "muted", title: new Date(e.timestamp).toLocaleString() }, timeAgo(e.timestamp)),
        h("td", null, nameOf(e.child_id)), cells(e).map((c) => h("td", null, c))))))));
    if (!done) body.append(h("div", { style: "margin-top:1rem" }, h("button", { class: "quiet", onclick: (ev) => act(ev.target, () => fetchMore(false)) }, "Show older")));
  }

  function drawToolbar() {
    toolbar.replaceChildren(
      h("div", { class: "seg", role: "tablist" }, Object.entries(TABS).map(([k, t]) =>
        h("button", { type: "button", "aria-pressed": String(k === tab), onclick: () => { tab = k; drawToolbar(); fetchMore(true); } }, t.label))),
      childSelect(children, child, (v) => { child = v; fetchMore(true); }));
  }
  drawToolbar();
  await fetchMore(true);
});
