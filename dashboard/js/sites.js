"use strict";

// Sites page: search the shared site database and open one to see how it was scored and reviewed.
Praise.start("sites.html", async (main, { user }) => {
  main.append(pageHead("Sites", "Everything the AI or a reviewer has classified. This list is shared and never contains a child's browsing history."));
  let query = "", status = "";
  const toolbar = h("div", { class: "row", style: "margin-bottom:1rem" });
  const list = h("section", { class: "block" });
  const detail = h("section", { class: "block", hidden: true });
  main.append(toolbar, list, detail);

  const search = h("input", { type: "search", "aria-label": "Search sites", placeholder: "Search by site address", value: "" });
  let timer;
  // Wait 250 ms after typing stops before searching, so each keystroke does not hit the server.
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim(); load(); }, 250); });
  const statusSel = h("select", { "aria-label": "Filter by status", onchange: (e) => { status = e.target.value; load(); } },
    h("option", { value: "" }, "Any status"),
    Object.entries(STATUS_LABELS).filter(([k]) => k !== "UNKNOWN").map(([k, v]) => h("option", { value: k }, v)));
  toolbar.append(search, statusSel);

  async function load() {
    const q = new URLSearchParams({ limit: "100" });
    if (query) q.set("q", query);
    if (status) q.set("status", status);
    const { sites } = await Api.get("/api/sites?" + q);
    list.replaceChildren();
    if (!sites.length) { list.append(emptyState("No sites found", query || status ? "Try a different search or status." : "Sites appear here after a child opens one the system hasn't seen before.")); return; }
    list.append(h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Site"), h("th", null, "Kind"), h("th", null, "Risk"), h("th", null, "Status"))),
      h("tbody", null, sites.map((s) => h("tr", { class: "click", tabindex: "0", onclick: () => open(s.domain),
        onkeydown: (e) => { if (e.key === "Enter") open(s.domain); } },
        h("td", null, h("strong", null, s.domain)), h("td", null, catLabel(s.category)), h("td", { style: "min-width:140px" }, riskBar(s.risk)),
        h("td", null, h("span", { class: "chip " + (s.status === "ADMIN_VERIFIED" ? "ok" : s.status === "DISPUTED" || s.status === "REVIEW_REQUIRED" ? "warn" : "") }, statusLabel(s.status)))))))));
  }

  // Show one site's AI scores and review history, with a form to dispute it.
  async function open(domain) {
    const s = await act(null, () => Api.get("/api/sites/" + encodeURIComponent(domain)));
    if (!s) return;
    detail.hidden = false;
    detail.replaceChildren(
      h("header", null, h("h2", null, s.domain), h("button", { class: "quiet small", onclick: () => { detail.hidden = true; } }, "Close")),
      h("p", null, `${catLabel(s.category)} · ${statusLabel(s.status)}`,
        s.confidence != null ? ` · AI confidence ${Math.round(s.confidence * 100)}%` : ""),
      Object.keys(s.scores).length ? h("div", null, h("h3", { style: "margin:.8rem 0 .4rem" }, "How the AI scored it"),
        Object.entries(s.scores).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, v]) =>
          h("div", { class: "row", style: "margin:.25rem 0" }, h("span", { style: "width:11rem" }, catLabel(c)),
            h("div", { class: "bar", style: "width:160px" }, h("span", { style: `width:${Math.round(v * 100)}%` })), h("span", { class: "num muted" }, Math.round(v * 100) + "%")))) : null,
      s.reviews.length ? h("div", null, h("h3", { style: "margin:1rem 0 .4rem" }, "History"),
        h("ul", { class: "list" }, s.reviews.map((r) => h("li", null, h("span", null, `${r.action.replace(/_/g, " ").toLowerCase()}${r.new_category ? " → " + catLabel(r.new_category) : ""}`, r.note ? h("span", { class: "muted" }, ` “${r.note}”`) : null), h("span", { class: "muted" }, timeAgo(r.at)))))) : null,
      disputeForm(s));
    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Let a parent say a classification is wrong; this puts it in the admin review queue.
  function disputeForm(s) {
    if (s.status === "UNKNOWN") return null;
    const note = h("input", { type: "text", maxlength: 500, placeholder: "Why is this wrong? (optional)", "aria-label": "Why is this wrong" });
    return h("form", { class: "row", style: "margin-top:1.2rem", onsubmit: async (e) => {
      e.preventDefault();
      const out = await act(e.submitter, () => Api.post(`/api/sites/${encodeURIComponent(s.domain)}/dispute`, { note: note.value }), "Sent to a reviewer");
      if (out) { load(); open(s.domain); }
    } }, note, h("button", { type: "submit", class: "quiet" }, "This looks wrong: ask for a review"));
  }

  await load();
});
