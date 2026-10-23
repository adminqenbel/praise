"use strict";

// Cookies page: what cookies and site storage were seen, with a chart by likely purpose. Only metadata is shown, never cookie contents.
Praise.start("cookies.html", async (main, { user }) => {
  main.append(pageHead("Cookies", "Which cookies and stored data sites left in each browser. Contents are never collected, and the purpose shown is a best guess."));
  const { children } = await Api.get("/api/children");
  let child = "";
  const toolbar = h("div", { class: "row", style: "margin-bottom:1rem" }, user.account_type === "adult" ? null : childSelect(children, child, (v) => { child = v; load(); }));
  const body = h("div");
  main.append(toolbar, body);

  // Adds the chosen child to every query so one person's data is shown at a time.
  const q = (extra) => (child ? `&child_id=${child}` : "") + (extra || "");
  const yesNo = (v) => (v ? "Third-party" : "First-party");
  const actionChip = (a) => h("span", { class: "chip " + (a === "BLOCKED" ? "bad" : a === "ASK" ? "warn" : "ok") },
    a === "BLOCKED" ? "Removed" : a === "ASK" ? "Kept, needs a look" : "Kept");

  // Fetch stats, recent cookies and storage counts in parallel and draw the chart and two tables.
  async function load() {
    const [stats, cookies, storage] = await Promise.all([
      Api.get(`/api/stats?days=30${q()}`), Api.get(`/api/events?kind=cookie&type=cookie&limit=50${q()}`),
      Api.get(`/api/events?kind=cookie&type=storage&limit=20${q()}`)]);
    body.replaceChildren();
    const t = stats.totals;
    const purposes = Object.entries(stats.cookies_by_purpose);

    const canvas = h("canvas", { role: "img", "aria-label": "Cookies by likely purpose" });
    body.append(h("section", { class: "block" },
      h("header", null, h("h2", null, "Last 30 days"), h("p", null, `${plural(t.cookies_blocked, "cookie")} removed, ${plural(t.trackers_blocked, "tracker")} of them. Change what's removed on the `, h("a", { href: "policies.html" }, "Rules"), " page.")),
      purposes.length ? h("div", { class: "chart-box" }, canvas) : emptyState("No cookies recorded", "Cookies appear once a connected browser visits sites with cookie watching turned on.")));
    if (purposes.length) drawChart(canvas, { type: "bar",
      data: { labels: purposes.map(([p]) => p), datasets: [{ data: purposes.map(([, n]) => n), backgroundColor: themeVar("--chart-1"), borderRadius: 4 }] },
      options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } } });

    const nameOf = (id) => (children.find((c) => c.id === id) || {}).name || "—";
    body.append(h("section", { class: "block" }, h("header", null, h("h2", null, "Recent cookies")),
      !cookies.events.length ? emptyState("Nothing recorded", "No cookies in this view yet.") :
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Site"), h("th", null, "Cookie"), h("th", null, "Kind"), h("th", null, "Lasts"), h("th", null, "Likely purpose"), h("th", null, "What happened"), h("th", null, "Child"))),
        h("tbody", null, cookies.events.map((e) => h("tr", null,
          h("td", null, e.domain), h("td", { class: "muted" }, e.name), h("td", null, yesNo(e.third_party)),
          h("td", null, e.persistent ? plural(e.lifetime_days, "day") : "This visit"),
          h("td", null, `${e.purpose} `, h("span", { class: "muted" }, `(${Math.round((e.confidence || 0) * 100)}% sure)`)),
          h("td", null, actionChip(e.action)), h("td", null, nameOf(e.child_id)))))))));

    body.append(h("section", { class: "block" }, h("header", null, h("h2", null, "What sites store in the browser"),
      h("p", null, "Counts of items kept by each site, checked about once an hour.")),
      !storage.events.length ? emptyState("Nothing recorded", "Storage counts appear after a connected browser visits a site.") :
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Site", "Local storage", "Session storage", "IndexedDB", "Cache", "Background workers"].map((x) => h("th", null, x)))),
        h("tbody", null, storage.events.map((e) => h("tr", null, h("td", null, e.domain),
          [e.local_storage, e.session_storage, e.indexed_db, e.cache_storage, e.service_workers].map((n) => h("td", { class: "num" }, n ?? 0)))))))));
  }
  await load();
});
