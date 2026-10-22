"use strict";

// Mirrors DEFAULTS in extension/protections.js: what applies when a setting hasn't been chosen.
const SETTING_DEFAULTS = {
  downloads: { enabled: true, archives: "ALLOW" },
  protections: { browser_installers: true, escape: true, tamper: true, storage_monitor: true },
  cookies: { monitor: true, third_party: "ALLOW", trackers: "BLOCK", unknown: "ASK", clear_on_close: false },
  // adult version (Praise Shield)
  safe_browsing: { warn_above_risk: 70, scam_checks: true },
  privacy: { block_trackers: true, strip_tracking_params: true, block_fingerprinting: true, privacy_report: true },
  sensitive_data: { warn: true, cards: true, ids: true, otp: true, passwords: true },
  passwords: { breach_check: true, reuse_check: false },
  companion: { chat: true },
};

// Settings as the page should show them: the stored choices on top of the defaults.
function merged(settings) {
  const out = {};
  for (const g of Object.keys(SETTING_DEFAULTS)) out[g] = { ...SETTING_DEFAULTS[g], ...((settings || {})[g] || {}) };
  return out;
}

// Segmented control: options = [[value, label, cssClass?]]
function seg(options, current, onPick, label) {
  const wrap = h("div", { class: "seg", role: "group", "aria-label": label });
  for (const [value, text, cls] of options) {
    wrap.append(h("button", { type: "button", class: cls || "", "aria-pressed": String(value === current),
      onclick: () => onPick(value) }, text));
  }
  return wrap;
}

// ---- adult version: the sections of "My protection" ---------------------------------------------------------
const THREAT_CATEGORIES = ["malware", "phishing", "financial_phishing", "scam", "suspicious_domain", "dangerous_download"];

// The sections of 'My protection' for the adult space: safe browsing, trackers and cookies, sensitive data, passwords. Every control saves straight away.
function adultSections(p, S, setSetting, sw, save) {
  const hint = (text) => h("p", { class: "muted", style: "margin:.2rem 0 .6rem 2rem;font-size:.9rem" }, text);
  // Save a change to the policy itself (not to its settings).
  const patch = (body, msg) => save(null, () => Api.patch(`/api/policies/${p.id}`, body), msg);

  // ---- safe browsing ----
  const risk = [[0, "Don't warn on risk score"], [50, "50 out of 100 or higher"], [70, "70 out of 100 or higher (recommended)"], [85, "85 out of 100 or higher"]];
  const threats = h("ul", { class: "list" }, THREAT_CATEGORIES.map((cat) => h("li", null, h("span", null, catLabel(cat)),
    seg([["", "Default"], ["ALLOW", "Allow", "is-allow"], ["WARN", "Warn me"], ["BLOCK", "Block", "is-block"]], p.rules[cat] || "", (v) => {
      const rules = { ...p.rules };
      if (v) rules[cat] = v; else delete rules[cat];
      save(null, () => Api.put(`/api/policies/${p.id}/rules`, { rules }));
    }, catLabel(cat)))));
  const safe = h("section", { class: "block" },
    h("header", null, h("h2", null, "Safe browsing"),
      h("p", null, "Praise Shield checks sites as you browse. It steps in only when something looks like a scam, a fake bank page or malware.")),
    h("h3", { style: "margin:.2rem 0 .3rem" }, "When a threat is found"), threats,
    h("div", { class: "field", style: "margin-top:1rem" }, h("label", { for: "warnrisk" }, "Also warn me when a site's risk score is"),
      h("select", { id: "warnrisk", onchange: (e) => setSetting("safe_browsing", "warn_above_risk", Number(e.target.value)) },
        risk.map(([v, t]) => h("option", { value: v, selected: S.safe_browsing.warn_above_risk === v }, t)))),
    h("div", { class: "field" }, h("label", null, "Sites nobody has checked before"),
      seg([["ALLOW", "Open normally", "is-allow"], ["WARN", "Warn me"]], p.unknown_action === "WARN" ? "WARN" : "ALLOW",
        (v) => patch({ unknown_action: v }), "Unknown site action")),
    h("label", { class: "switch" }, h("input", { type: "checkbox", checked: p.ai_enabled,
      onchange: (e) => patch({ ai_enabled: e.target.checked }) }), "Use AI to judge sites nobody has seen"),
    hint("Only the site's address is sent, never the page you're on or anything you typed."));

  // ---- trackers and cookies ----
  const sel = (group, key, options) => h("select", { "aria-label": key, onchange: (e) => setSetting(group, key, e.target.value) },
    options.map(([v, t]) => h("option", { value: v, selected: S[group][key] === v }, t)));
  const privacy = h("section", { class: "block" },
    h("header", null, h("h2", null, "Trackers and cookies"),
      h("p", null, "Stop sites from following you around the web. The extension's popup shows what was stopped on each page.")),
    sw("privacy", "block_trackers", "Block advertising and analytics trackers"),
    sw("privacy", "block_fingerprinting", "Block scripts that recognise you across sites"),
    sw("privacy", "strip_tracking_params", "Remove tracking codes from links (like fbclid and utm_source)"),
    h("hr", { class: "rule" }),
    sw("cookies", "monitor", "Watch cookies and show them on the Cookies page"),
    h("div", { class: "row", style: "margin:.6rem 0" },
      h("div", null, h("label", null, "Tracking cookies"), sel("cookies", "trackers", [["BLOCK", "Remove"], ["ALLOW", "Keep"]])),
      h("div", null, h("label", null, "Third-party cookies"), sel("cookies", "third_party", [["ALLOW", "Keep"], ["BLOCK", "Remove"]])),
      h("div", null, h("label", null, "Cookies we can't identify"), sel("cookies", "unknown", [["ALLOW", "Keep"], ["BLOCK", "Remove"], ["ASK", "Keep and show me"]]))),
    sw("cookies", "clear_on_close", "Clear tracking cookies shortly after I close a tab"),
    hint("Sign-in and preference cookies are never cleared automatically."));

  // ---- sensitive data ----
  const dataOff = !S.sensitive_data.warn;
  const data = h("section", { class: "block" },
    h("header", null, h("h2", null, "Before you send sensitive data"),
      h("p", null, "If a page looks risky, is unencrypted, or sends your form to another site, Praise Shield asks before card numbers, IDs, codes or passwords leave your browser.")),
    sw("sensitive_data", "warn", "Warn me before sending sensitive data to a risky page"),
    h("div", { style: `margin-left:1.8rem;${dataOff ? "opacity:.5" : ""}` },
      sw("sensitive_data", "cards", "Card numbers"),
      sw("sensitive_data", "ids", "ID numbers (Aadhaar, US SSN, PAN, IBAN)"),
      sw("sensitive_data", "otp", "One-time codes"),
      sw("sensitive_data", "passwords", "Passwords")),
    hint("This is checked inside the page, on your device. What you type is never sent anywhere."));

  // ---- passwords ----
  const pass = h("section", { class: "block" },
    h("header", null, h("h2", null, "Passwords"),
      h("p", null, "Find out when a password you use has been exposed.")),
    sw("passwords", "breach_check", "Check passwords against known data breaches"),
    hint("Your password is scrambled on your device and only the first 5 characters of that scramble are sent to Have I Been Pwned (haveibeenpwned.com). Your password never leaves the page."),
    sw("passwords", "reuse_check", "Warn me when I reuse a password on several sites"),
    hint("Remembers slow, scrambled fingerprints and the site names, on this device only. Passwords are never stored, and the extension popup can erase them. Works on secure (https) pages."));

  return [safe, privacy, data, pass];
}

// Rules (family) / My protection (adult): choose a rule set, then change what it allows, blocks and cleans up.
Praise.start("policies.html", async (main, { user }) => {
  const adult = user.account_type === "adult";
  main.append(adult
    ? pageHead("My protection", "Choose what Praise Shield warns you about, blocks and cleans up. Changes reach your browser within a few minutes, or straight away from its popup.")
    : pageHead("Rules", "A rule set says what each kind of site, download and cookie should do. Assign one to each child on the Children page."));
  const meta = await Api.get("/api/meta/categories");
  let { policies } = await Api.get("/api/policies");
  let selectedId = policies[0] ? policies[0].id : null;

  const picker = h("div");
  const editor = h("div");
  main.append(picker, editor);

  const current = () => policies.find((p) => p.id === selectedId);
  const replace = (p) => { policies = policies.map((x) => (x.id === p.id ? p : x)); render(); };

  // every control saves immediately; the server's answer is the new truth
  const save = async (button, call, msg = "Saved") => {
    const p = await act(button, call, msg);
    if (p) replace(p);
  };

  // The 'Editing' drop-down plus the forms to create or delete a rule set.
  function renderPicker() {
    const sel = h("select", { id: "policy", "aria-label": "Rule set", onchange: (e) => { selectedId = Number(e.target.value); render(); } },
      policies.map((p) => h("option", { value: p.id, selected: p.id === selectedId }, p.name)));
    const name = h("input", { type: "text", id: "newname", maxlength: 100, placeholder: "e.g. Weekday rules", required: true });
    const preset = h("select", { id: "preset", "aria-label": "Start from" },
      (adult ? [["shield_balanced", "Balanced"], ["shield_strict", "Strict"], ["shield_minimal", "Light touch"], ["custom", "Empty"]]
        : [["child_safe", "Child safe"], ["teen", "Teen"], ["education", "Education"], ["custom", "Empty"]])
        .map(([v, t]) => h("option", { value: v }, t)));
    picker.replaceChildren(h("section", { class: "block" },
      h("header", null, h("h2", null, "Rule sets")),
      policies.length ? h("div", { class: "row" }, h("div", null, h("label", { for: "policy" }, "Editing"), sel),
        h("button", { class: "danger small", style: "align-self:end", onclick: deleteArm }, "Delete this rule set")) : null,
      h("hr", { class: "rule" }),
      h("form", { class: "row", onsubmit: async (e) => {
        e.preventDefault();
        const p = await act(e.submitter, () => Api.post("/api/policies", { name: name.value, preset: preset.value }), "Rule set created");
        if (p) { policies.push(p); selectedId = p.id; render(); }
      } },
      h("div", null, h("label", { for: "newname" }, "New rule set"), name),
      h("div", null, h("label", { for: "preset" }, "Start from"), preset),
      h("button", { type: "submit", class: "quiet", style: "align-self:end" }, "Create"))));
  }

  let armed = false;
  // Delete needs two clicks within 4 seconds, so nothing is lost to a stray click (no pop-up dialog).
  async function deleteArm(e) {
    if (!armed) { armed = true; e.target.textContent = "Click again to delete"; setTimeout(() => { armed = false; e.target.textContent = "Delete this rule set"; }, 4000); return; }
    armed = false;
    const p = current();
    const ok = await act(e.target, () => Api.del(`/api/policies/${p.id}`), `${p.name} deleted`);
    if (ok) { policies = policies.filter((x) => x.id !== p.id); selectedId = policies[0] ? policies[0].id : null; render(); }
  }

  // Draw every section of the selected rule set. Adults get their own sections and the family-only ones below are skipped.
  function renderEditor() {
    const p = current();
    if (!p) { editor.replaceChildren(emptyState("No rule sets yet", "Create one above. Starting from “Child safe” closes adult, gambling, money and unknown sites.")); return; }
    const S = merged(p.settings);
    // Change one protection setting; the whole settings object is sent and the server validates it.
    const setSetting = (group, key, value) => save(null, () => Api.patch(`/api/policies/${p.id}`, { settings: { ...S, [group]: { ...S[group], [key]: value } } }));
    const sw = (group, key, text) => h("label", { class: "switch" },
      h("input", { type: "checkbox", checked: S[group][key], onchange: (e) => setSetting(group, key, e.target.checked) }), text);

    // ---- unknown sites ----
    const unknown = h("section", { class: "block" },
      h("header", null, h("h2", null, "Sites we haven't seen before"),
        h("p", null, "New sites are checked by AI first. Your choice below applies when the AI can't decide.")),
      h("div", { class: "field" }, h("label", null, "When a site is unknown or unclear"),
        seg([["BLOCK", "Keep closed", "is-block"], ["REVIEW", "Wait for me"], ["ALLOW", "Let through", "is-allow"]], p.unknown_action,
          (v) => save(null, () => Api.patch(`/api/policies/${p.id}`, { unknown_action: v })), "Unknown site action")),
      h("label", { class: "switch" }, h("input", { type: "checkbox", checked: p.ai_enabled,
        onchange: (e) => save(null, () => Api.patch(`/api/policies/${p.id}`, { ai_enabled: e.target.checked })) }), "Use AI to classify new sites"),
      h("div", { class: "field", style: "margin-top:.8rem" }, h("label", { for: "conf" }, "How sure the AI must be before its answer is used"),
        h("select", { id: "conf", onchange: (e) => save(e.target, () => Api.patch(`/api/policies/${p.id}`, { ai_min_confidence: Number(e.target.value) })) },
          [[0.5, "50%"], [0.6, "60% (recommended)"], [0.75, "75%"], [0.9, "90%"]].map(([v, t]) =>
            h("option", { value: v, selected: Math.abs(p.ai_min_confidence - v) < 0.001 }, t)))));

    // ---- categories ----
    const catBlock = h("section", { class: "block" },
      h("header", null, h("h2", null, "Kinds of sites"), h("p", null, "“Default” follows safe built-in behaviour: security threats are always closed.")));
    for (const [group, cats] of Object.entries(meta.groups)) {
      catBlock.append(h("h3", { style: "margin:1rem 0 .3rem" }, GROUP_LABELS[group] || group));
      const ul = h("ul", { class: "list" });
      for (const cat of cats) {
        const cur = p.rules[cat] || "";
        ul.append(h("li", null, h("span", null, catLabel(cat)),
          seg([["", "Default"], ["ALLOW", "Allow", "is-allow"], ["REVIEW", "Wait for me"], ["BLOCK", "Block", "is-block"]], cur, (v) => {
            const rules = { ...p.rules };
            if (v) rules[cat] = v; else delete rules[cat];
            save(null, () => Api.put(`/api/policies/${p.id}/rules`, { rules }));
          }, catLabel(cat))));
      }
      catBlock.append(ul);
    }

    // ---- list sections (domains / exceptions / tlds) ----
    const listBlock = (title, hint, items, render, form) => h("section", { class: "block" },
      h("header", null, h("h2", null, title), h("p", null, hint)),
      items.length ? h("ul", { class: "list" }, items.map(render)) : h("p", { class: "muted" }, "Nothing here yet."),
      h("hr", { class: "rule" }), form);

    const addForm = (fields, onSubmit, cta) => h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); onSubmit(e); } },
      fields, h("button", { type: "submit", class: "quiet", style: "align-self:end" }, cta));

    const dom = h("input", { type: "text", "aria-label": "Site address", placeholder: "school.edu", required: true });
    const domAct = h("select", { "aria-label": "Action" }, h("option", { value: "BLOCK" }, "Always block"), h("option", { value: "ALLOW" }, "Always allow"));
    const domains = listBlock("Always allow or block", "Your own list. It wins over everything the AI says.", p.domains,
      (d) => h("li", null, h("span", null, h("strong", null, d.domain), " ", h("span", { class: "chip " + (d.action === "BLOCK" ? "bad" : "ok") }, d.action === "BLOCK" ? "Blocked" : "Allowed")),
        h("button", { class: "danger small", onclick: (e) => save(e.target, () => Api.del(`/api/policies/${p.id}/domains/${d.id}`), "Removed") }, "Remove")),
      addForm([dom, domAct], (e) => save(e.submitter, () => Api.post(`/api/policies/${p.id}/domains`, { domain: dom.value, action: domAct.value }), "Added"), "Add site"));

    const ex = h("input", { type: "text", "aria-label": "Approved site", placeholder: "example.com", required: true });
    const exceptions = listBlock("Approved sites", "Always open, even if a rule would close them. Requests you approve land here.", p.exceptions,
      (x) => h("li", null, h("span", null, h("strong", null, x.domain), x.note ? h("span", { class: "muted" }, ` ${x.note}`) : null),
        h("button", { class: "danger small", onclick: (e) => save(e.target, () => Api.del(`/api/policies/${p.id}/exceptions/${x.id}`), "Removed") }, "Remove")),
      addForm([ex], (e) => save(e.submitter, () => Api.post(`/api/policies/${p.id}/exceptions`, { domain: ex.value }), "Approved"), "Approve site"));

    if (adult) { editor.replaceChildren(...adultSections(p, S, setSetting, sw, save), domains, exceptions); return; }

    const tld = h("input", { type: "text", "aria-label": "Domain ending", placeholder: ".xyz", required: true });
    const tldAct = h("select", { "aria-label": "Action" }, h("option", { value: "BLOCK" }, "Block"), h("option", { value: "ALLOW" }, "Allow only these"));
    const tlds = listBlock("Domain endings", "A signal, not proof: many safe sites end in .xyz and some unsafe ones end in .com. Used when nothing stronger applies.", p.tlds,
      (t) => h("li", null, h("span", null, h("strong", null, t.tld), " ", h("span", { class: "chip " + (t.action === "BLOCK" ? "bad" : "ok") }, t.action === "BLOCK" ? "Blocked" : "Allowed")),
        h("button", { class: "danger small", onclick: (e) => save(e.target, () => Api.del(`/api/policies/${p.id}/tlds/${t.id}`), "Removed") }, "Remove")),
      addForm([tld, tldAct], (e) => save(e.submitter, () => Api.post(`/api/policies/${p.id}/tlds`, { tld: tld.value, action: tldAct.value }), "Added"), "Add ending"));

    // ---- downloads & browser ----
    const protect = h("section", { class: "block" },
      h("header", null, h("h2", null, "Downloads and the browser"),
        h("p", null, "These stop at the browser. They can't control other apps on the computer.")),
      sw("downloads", "enabled", "Block programs, scripts and installers"),
      h("div", { class: "field", style: "margin:.6rem 0 .8rem" }, h("label", { for: "arch" }, "Zip and other archive files"),
        h("select", { id: "arch", onchange: (e) => setSetting("downloads", "archives", e.target.value) },
          h("option", { value: "ALLOW", selected: S.downloads.archives === "ALLOW" }, "Allow"),
          h("option", { value: "BLOCK", selected: S.downloads.archives === "BLOCK" }, "Block"))),
      sw("protections", "browser_installers", "Block pages for downloading other browsers"),
      sw("protections", "escape", "Stop links that open another browser"),
      sw("protections", "tamper", "Block the browser's extensions and settings pages"));

    // ---- cookies ----
    const sel3 = (group, key, options) => h("select", { onchange: (e) => setSetting(group, key, e.target.value), "aria-label": key },
      options.map(([v, t]) => h("option", { value: v, selected: S[group][key] === v }, t)));
    const cookies = h("section", { class: "block" },
      h("header", null, h("h2", null, "Cookies and site storage"),
        h("p", null, "We record each cookie's name, site and lifetime, never its contents. Purposes shown are best guesses.")),
      sw("cookies", "monitor", "Watch cookies and see them on the Cookies page"),
      sw("protections", "storage_monitor", "Count what each site stores in the browser"),
      h("div", { class: "row", style: "margin-top:.8rem" },
        h("div", null, h("label", null, "Tracking cookies"), sel3("cookies", "trackers", [["BLOCK", "Remove"], ["ALLOW", "Keep"]])),
        h("div", null, h("label", null, "Third-party cookies"), sel3("cookies", "third_party", [["ALLOW", "Keep"], ["BLOCK", "Remove"]])),
        h("div", null, h("label", null, "Cookies we can't identify"), sel3("cookies", "unknown", [["ASK", "Keep and show me"], ["ALLOW", "Keep"], ["BLOCK", "Remove"]]))));

    const buddy = h("section", { class: "block" },
      h("header", null, h("h2", null, "Dori, the browsing buddy"),
        h("p", null, "Dori waits in the corner of your child's pages. Children can chat with Dori. Messages are used to make one answer and are never saved, and anything about feeling sad or unsafe is answered with a nudge to talk to a grown-up.")),
      sw("companion", "chat", "Let your child chat with Dori"));

    editor.replaceChildren(unknown, catBlock, domains, exceptions, tlds, protect, cookies, buddy);
  }

  function render() {
    // keep scroll position and focus context stable across saves
    const y = window.scrollY;
    renderPicker();
    renderEditor();
    window.scrollTo(0, y);
  }
  render();
});
