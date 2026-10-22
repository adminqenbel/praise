"use strict";

// Review queue (admin only): sites waiting for a person to confirm, correct or re-check the AI's guess.
Praise.start("reviews.html", async (main) => {
  main.append(pageHead("Review queue", "AI suggestions waiting for a person. Confirming makes a classification final for every family, so check the evidence."));
  const meta = await Api.get("/api/meta/categories");
  const allCats = Object.values(meta.groups).flat();
  const overview = h("p", { class: "muted" });
  const body = h("div");
  main.append(overview, body);

  async function load() {
    const [{ sites }, ov] = await Promise.all([Api.get("/api/admin/reviews"), Api.get("/api/admin/overview")]);
    const by = ov.sites_by_status;
    overview.textContent = `${plural(by.ADMIN_VERIFIED || 0, "site")} verified so far.`;
    body.replaceChildren();
    if (!sites.length) { body.append(h("section", { class: "block" }, emptyState("The queue is empty", "New AI classifications and disputes from parents will appear here, highest risk first."))); return; }
    for (const s of sites) body.append(card(s));
  }

  // One site to decide on: what the AI said, its risk and confidence, any parent dispute, and the buttons for each decision.
  function card(s) {
    const note = h("input", { type: "text", maxlength: 500, placeholder: "Note (optional)", "aria-label": "Note" });
    const catSel = h("select", { "aria-label": "Category" }, allCats.map((c) => h("option", { value: c, selected: c === s.category }, catLabel(c))));
    // Send the admin's decision, then reload the queue.
    const decide = (action, extra = {}) => async (e) => {
      const out = await act(e.target, () => Api.post(`/api/admin/reviews/${s.id}`, { action, note: note.value, ...extra }),
        { CONFIRM_BLOCK: "Confirmed", ALLOW: "Marked safe", CHANGE_CATEGORY: "Category changed", REANALYZE: "Queued for another AI pass" }[action]);
      if (out) load();
    };
    const evidence = Object.entries(s.scores).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const history = s.reviews.find((r) => r.action === "DISPUTE");

    return h("section", { class: "block" },
      h("header", null, h("h2", null, s.domain),
        h("span", { class: "chip " + (s.status === "AI_CLASSIFIED" ? "" : "warn") }, statusLabel(s.status))),
      h("div", { class: "row", style: "gap:2rem" },
        h("div", null, h("div", { class: "muted" }, "AI says"), h("strong", null, catLabel(s.category))),
        h("div", { style: "min-width:150px" }, h("div", { class: "muted" }, "Risk"), riskBar(s.risk)),
        h("div", null, h("div", { class: "muted" }, "Confidence"), h("strong", { class: "num" }, s.confidence != null ? Math.round(s.confidence * 100) + "%" : "—"))),
      evidence.length ? h("p", { class: "muted", style: "margin-top:.8rem" }, "Scores: " + evidence.map(([c, v]) => `${catLabel(c)} ${Math.round(v * 100)}%`).join(", ")) : null,
      history ? h("p", { style: "margin-top:.4rem" }, h("strong", null, "A parent disputed this"), history.note ? `: “${history.note}”` : ".") : null,
      h("hr", { class: "rule" }),
      h("div", { class: "row" }, note),
      h("div", { class: "row", style: "margin-top:.7rem" },
        // a "general" or "education" suggestion has nothing to confirm as closed: the choice is safe or re-categorise
        ["general", "education", null].includes(s.category) ? null
          : h("button", { onclick: decide("CONFIRM_BLOCK") }, "Confirm this category"),
        h("button", { class: s.category && !["general", "education"].includes(s.category) ? "quiet" : "", onclick: decide("ALLOW", { category: s.category === "education" ? "education" : "general" }) }, "Mark as safe"),
        h("button", { class: "quiet", onclick: decide("REANALYZE") }, "Ask AI again"),
        h("span", { class: "row" }, catSel, h("button", { class: "quiet", onclick: (e) => decide("CHANGE_CATEGORY", { category: catSel.value })(e) }, "Change category"))));
  }
  await load();
}, { adminOnly: true });
