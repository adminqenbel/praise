"use strict";

// A browser counts as 'online' if it checked in during the last 15 minutes.
const ONLINE_MS = 15 * 60 * 1000;

// The buddy at the top of the home page: says one useful thing, then reacts to what you do.
function buddyBar(who) {
  const host = h("div", { class: "buddy-bar" });
  const buddy = PraiseBuddy.mount(host, { who, height: 88, side: true, sleeps: true });
  const line = (kind, ctx) => { const s = PraiseCompanion.say(who, kind, ctx); buddy.say(s.text, s.mood); };
  Praise.onLeave(() => buddy.destroy());            // its timers must stop when another tab is opened

  // A button to talk with it, and the chat panel under it. Dori talks to a parent here, Ringo to an adult.
  if (window.PraiseChat) {
    const name = who === "adult" ? "Ringo" : "Dori";
    const panel = h("div", { class: "buddy-chat" });
    const talk = h("button", { class: "quiet small buddy-talk", type: "button", onclick: () => chat.open() }, `Talk to ${name}`);
    const chat = PraiseChat.mount(panel, {
      who, audience: who === "adult" ? "adult" : "parent",
      remote: async (message, history) => {
        const r = await Api.post("/api/auth/chat", { message, history });
        return r && typeof r.reply === "string" ? r.reply : null;
      },
      onMood: (m) => buddy.setMood(m),
      onOpen: () => { talk.hidden = true; buddy.setTalk(false); buddy.say("", "happy"); },
      onClose: () => { talk.hidden = false; buddy.setTalk(true); buddy.setMood("happy"); },
    });
    host.append(talk, panel);
    Praise.onLeave(() => chat.destroy());
  }
  return { host, buddy, line };
}

// One door per child on the family home page: lit when their browser is online, with a count of sites closed this week.
function childDoor(child, count) {
  const online = child.devices.some((d) => d.last_seen && Date.now() - new Date(d.last_seen).getTime() < ONLINE_MS);
  const paired = child.devices.some((d) => d.paired && !d.revoked);
  const state = !paired ? "No browser connected" : online ? "Online now" : "Offline";
  const door = h("a", { class: "door-item" + (online ? "" : " offline"), href: "children.html",
    style: `--door:${childHue(child.id)}`, "aria-label": `${child.name}: ${state}` },
    doorSvg(), h("strong", null, child.name), h("span", null, state),
    h("span", null, paired ? `${plural(count, "site")} closed this week` : "Connect a browser"));
  return door;
}

// "Mia is online." / "Mia and Leo are online." / "" when nobody is.
function onlineLine(children) {
  const on = children.filter((c) => c.devices.some((d) => d.last_seen && Date.now() - new Date(d.last_seen).getTime() < ONLINE_MS))
    .map((c) => c.name);
  if (!on.length) return "";
  const names = on.length === 1 ? on[0] : on.slice(0, -1).join(", ") + " and " + on[on.length - 1];
  return `${names} ${on.length === 1 ? "is" : "are"} online. `;
}

// Approving a request needs a rule set to add the exception to; if the child still uses the default, make them their own Child safe set first.
async function ensurePolicy(child, policies) {
  let policy = policies.find((p) => p.id === child.policy_id);
  if (policy) return policy;
  policy = await Api.post("/api/policies", { name: `${child.name}'s rules`, preset: "child_safe" });
  await Api.put(`/api/children/${child.id}/policy`, { policy_id: policy.id });
  child.policy_id = policy.id;
  policies.push(policy);
  return policy;
}

// Security events the person should look at: exposed or reused passwords, data sent anyway, warnings they ignored.
const ATTENTION = new Set(["sensitive_breached", "sensitive_reused", "sensitive_sent_anyway", "warning_overridden"]);
const events_needing_attention = (events) => events.map((e) => describeSecurityEvent(e) && e).filter((e) => e && ATTENTION.has(e.type)).length;

// Home page for the adult space: the protection ring, a one-sentence summary of the week, what needs attention, a chart and recent warnings.
async function adultHome(main) {
  const bar = buddyBar("adult");
  main.append(bar.host);
  const [{ children }, stats, rec, { policies }] = await Promise.all([
    Api.get("/api/children"), Api.get("/api/stats?days=7"), Api.get("/api/events?kind=security&limit=100"), Api.get("/api/policies")]);
  const me = children[0];
  const policy = policies.find((p) => me && p.id === me.policy_id) || policies[0];
  const paired = !!me && me.devices.some((d) => d.paired && !d.revoked);
  const online = !!me && me.devices.some((d) => d.last_seen && Date.now() - new Date(d.last_seen).getTime() < ONLINE_MS);
  const by = stats.security_by_type, t = stats.totals;
  const n = (k) => by[k] || 0;
  const lastSeen = me ? me.devices.map((d) => d.last_seen).filter(Boolean).sort().pop() : null;

  // ---- the ring and what it means ----
  // Which of the four layers are on, according to the person's settings and whether a browser is connected.
  const layers = PostureRing.layersFor(policy && policy.settings, paired);
  const post = PostureRing.posture(layers, paired);
  const warned = n("warning_shown") + n("site_blocked");
  // Per-layer counts for the last 7 days, shown next to each layer.
  const week = { safe: warned, trackers: t.trackers_blocked, data: n("sensitive_shown"), passwords: n("sensitive_breached") + n("sensitive_reused") };
  const countText = {
    safe: (v) => `${plural(v, "warning")}`, trackers: (v) => `${plural(v, "tracking cookie")} removed`,
    data: (v) => `${plural(v, "form")} held`, passwords: (v) => `${plural(v, "password")} flagged`,
  };

  const needsYou = events_needing_attention(rec.events);
  if (!paired) bar.buddy.say("Connect a browser and I'll start watching.", "curious");
  else if (needsYou) bar.buddy.say(`${plural(needsYou, "thing")} could use your attention. It's listed below.`, "alert");
  else bar.line("greet");

  const parts = [];
  if (warned) parts.push(`warned you about ${plural(warned, "risky page")}`);
  if (n("sensitive_shown")) parts.push(`held ${plural(n("sensitive_shown"), "form")} to ask first`);
  if (t.trackers_blocked) parts.push(`removed ${plural(t.trackers_blocked, "tracking cookie")}`);
  // One plain sentence that sums up the week.
  let sentence;
  if (!paired) sentence = "Connect a browser to start protecting your browsing.";
  else if (!parts.length) sentence = "A quiet week so far: nothing risky has turned up.";
  else sentence = `This week, Praise Shield ${parts.slice(0, -1).join(", ")}${parts.length > 1 ? " and " : ""}${parts[parts.length - 1]}.`;

  const ringHost = h("div", { class: "posture-ring" });
  const layerList = h("ul", { class: "layers" }, layers.map((l) => h("li", { class: l.on ? "" : "off" },
    h("span", { class: "pip", "aria-hidden": "true" }), h("strong", null, l.label), h("span", { class: "detail" }, l.detail),
    h("span", { class: "count num" }, !l.enabled ? "Off in settings" : !paired ? "Not connected" : countText[l.key](week[l.key])))));

  main.append(h("div", { class: "posture" }, ringHost,
    h("div", { class: "posture-text" },
      h("h1", null, post.label),
      h("p", { class: "status " + post.level }, !paired ? "No browser connected" : online ? "Your browser is online" : `Protection stays on. Your browser last checked in ${timeAgo(lastSeen)}.`),
      h("p", { class: "sum" }, sentence),
      h("div", { class: "row" },
        h("a", { class: "btn small", href: paired ? "policies.html" : "children.html" }, paired ? "Change what's protected" : "Connect a browser")))));
  PostureRing.render(ringHost, layers, { animate: true, size: 220 });
  main.append(h("section", { class: "block" }, h("header", null, h("h2", null, "Your four layers"), h("p", null, "Switch them in My protection.")), layerList));

  const events = rec.events.map((e) => ({ e, d: describeSecurityEvent(e) })).filter((x) => x.d);

  // ---- needs attention ----
  const attention = events.filter((x) => ATTENTION.has(x.e.type)).slice(0, 6);
  const attn = h("section", { class: "block" }, h("header", null, h("h2", null, "Needs your attention")));
  if (!attention.length) attn.append(emptyState("Nothing needs you right now", "Exposed passwords, reused passwords and warnings you chose to ignore will show up here."));
  else attn.append(h("ul", { class: "list" }, attention.map(({ e, d }) => h("li", null,
    h("span", null, d.text), h("span", null, h("span", { class: "chip " + d.chip }, d.label), " ", h("span", { class: "muted" }, timeAgo(e.timestamp)))))));
  main.append(attn);

  // ---- warnings per day ----
  const days = stats.security_per_day;
  const canvas = h("canvas", { role: "img", "aria-label": "Warnings and checks per day" });
  main.append(h("section", { class: "block" }, h("header", null, h("h2", null, "Warnings per day"), h("p", null, "Last 7 days")),
    days.length ? h("div", { class: "chart-box" }, canvas) : emptyState("No warnings yet", "Days appear here when Praise Shield steps in.")));
  if (days.length) drawChart(canvas, { type: "bar",
    data: { labels: days.map((d) => d.day.slice(5)), datasets: [{ data: days.map((d) => d.count), backgroundColor: themeVar("--chart-1"), borderRadius: 4, maxBarThickness: 48 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });

  // ---- recent warnings ----
  const warns = events.filter((x) => ["warning_shown", "site_blocked"].includes(x.e.type)).slice(0, 8);
  const recent = h("section", { class: "block" }, h("header", null, h("h2", null, "Recent warnings"), h("a", { href: "events.html" }, "See all activity")));
  if (!warns.length) recent.append(emptyState("No warnings yet", "When a page looks like a scam or a fake bank, it will be listed here with the reason."));
  else recent.append(h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Site"), h("th", null, "What happened"), h("th", null, "Why"), h("th", null, "When"))),
    h("tbody", null, warns.map(({ e, d }) => h("tr", null, h("td", null, e.domain || "—"),
      h("td", null, h("span", { class: "chip " + d.chip }, d.label)), h("td", null, d.detail), h("td", { class: "muted" }, timeAgo(e.timestamp))))))));
  main.append(recent);
}

// Home page. Adults get their own version above; families get a door per child, access requests to approve, two charts and recently closed sites.
Praise.start("home.html", async (main, { user }) => {
  if (user.account_type === "adult") return adultHome(main);
  // One round of reads, all at once: the children, this week's numbers, the rules, the requests and the recent closed sites.
  const [{ children }, stats, { policies }, req, recent] = await Promise.all([
    Api.get("/api/children"), Api.get("/api/stats?days=7"), Api.get("/api/policies"),
    Api.get("/api/events?kind=browser&type=access_request&limit=20"), Api.get("/api/events?kind=browser&limit=100"),
  ]);
  // Sites closed per child come with the numbers; a server that doesn't send them yet is asked once per child.
  const closedBy = stats.blocked_by_child || Object.fromEntries(await Promise.all(children.map(async (c) =>
    [c.id, (await Api.get(`/api/stats?child_id=${c.id}&days=7`)).totals.blocked])));
  const t = stats.totals;
  const bar = buddyBar("family");
  main.append(bar.host);

  // ---- hero: one door per child + one plain sentence ----
  // One plain sentence for the hero: how many sites stayed closed, and downloads and trackers stopped.
  let sentence;
  if (!children.length) sentence = "Add your first child to start protecting their browser.";
  else if (!t.checks) sentence = "Nothing has been checked yet this week.";
  else {
    sentence = `This week, ${plural(t.blocked, "site")} stayed closed`;
    const extra = [];
    if (t.downloads_blocked) extra.push(`${plural(t.downloads_blocked, "download")} stopped`);
    if (t.trackers_blocked) extra.push(`${plural(t.trackers_blocked, "tracker")} removed`);
    sentence += extra.length ? `, ${extra.join(" and ")}.` : ".";
  }
  main.append(h("div", { class: "hero" },
    h("h1", null, greeting()),
    h("p", { class: "lede" }, onlineLine(children) + sentence),
    h("div", { class: "doors" },
      children.map((c) => childDoor(c, closedBy[c.id] || 0)),
      h("a", { class: "door-item add", href: "children.html", "aria-label": "Add a child" },
        doorSvg(), h("strong", null, "Add a child"), h("span", null, "Get a pairing code")))));

  // ---- access requests ----
  // Access requests still waiting: drop ones for children that no longer exist or sites already approved, then de-duplicate.
  const pending = req.events.filter((e) => {
    const child = children.find((c) => c.id === e.child_id);
    const policy = child && policies.find((p) => p.id === child.policy_id);
    return child && e.domain && !(policy && policy.exceptions.some((x) => x.domain === e.domain));
  });
  const seen = new Set();
  const unique = pending.filter((e) => { const k = e.child_id + e.domain; if (seen.has(k)) return false; seen.add(k); return true; });

  const reqBlock = h("section", { class: "block" },
    h("header", null, h("h2", null, "Asking to open a site"), h("p", null, "Approving adds the site to that child's approved list.")));
  if (!unique.length) reqBlock.append(emptyState("No requests right now", "When a child taps “Ask a parent for access” on a closed page, it shows up here."));
  else {
    const list = h("ul", { class: "list" });
    for (const e of unique) {
      const child = children.find((c) => c.id === e.child_id);
      const li = h("li", null,
        h("span", null, h("strong", null, child.name), ` asked for ${e.domain} `, h("span", { class: "muted" }, timeAgo(e.timestamp))),
        h("button", { class: "small", onclick: async (ev) => {
          const ok = await act(ev.target, async () => {
            const policy = await ensurePolicy(child, policies);
            const updated = await Api.post(`/api/policies/${policy.id}/exceptions`, { domain: e.domain, note: "Approved from a request" });
            policies.splice(policies.findIndex((p) => p.id === policy.id), 1, updated);
            return true;
          }, `${e.domain} approved for ${child.name}`);
          if (ok) { li.remove(); bar.buddy.say(`Done! ${child.name} can open ${e.domain} now.`, "celebrate"); }
        } }, `Approve for ${child.name}`));
      list.append(li);
    }
    reqBlock.append(list);
  }
  main.append(reqBlock);
  if (unique.length) {
    const first = children.find((c) => c.id === unique[0].child_id);
    bar.buddy.say(unique.length === 1 ? `${first.name} is asking to open ${unique[0].domain}.` : `${plural(unique.length, "request")} are waiting for you.`, "alert");
  } else bar.line("greet");

  // ---- charts ----
  const days = stats.blocked_per_day;
  const cats = Object.entries(stats.blocked_by_category);
  const c1 = h("canvas", { "aria-label": "Sites closed per day", role: "img" });
  const c2 = h("canvas", { "aria-label": "Sites closed by category", role: "img" });
  main.append(h("div", { class: "grid2" },
    h("section", { class: "block" }, h("header", null, h("h2", null, "Closed per day")),
      days.length ? h("div", { class: "chart-box" }, c1) : emptyState("No closed sites yet", "Days appear here once a site has been closed.")),
    h("section", { class: "block" }, h("header", null, h("h2", null, "What was closed")),
      cats.length ? h("div", { class: "chart-box" }, c2) : emptyState("Nothing closed yet", "Categories appear here as sites are closed."))));

  if (days.length) drawChart(c1, { type: "bar",
    data: { labels: days.map((d) => d.day.slice(5)), datasets: [{ data: days.map((d) => d.count), backgroundColor: themeVar("--chart-1"), borderRadius: 8, maxBarThickness: 56 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
  if (cats.length) drawChart(c2, { type: "bar",
    data: { labels: cats.map(([c]) => catLabel(c)), datasets: [{ data: cats.map(([, n]) => n), backgroundColor: themeVar("--chart-2"), borderRadius: 8, maxBarThickness: 28 }] },
    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } } });

  // ---- recent closed sites ----
  const closed = recent.events.filter((e) => e.decision && e.decision.action !== "ALLOW").slice(0, 8);
  const recentBlock = h("section", { class: "block" }, h("header", null, h("h2", null, "Recently closed"), h("a", { href: "events.html" }, "See all activity")));
  if (!closed.length) recentBlock.append(emptyState("Nothing closed yet", "Closed sites will be listed here with the reason."));
  else recentBlock.append(h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Site"), h("th", null, "Child"), h("th", null, "Reason"), h("th", null, "When"))),
    h("tbody", null, closed.map((e) => {
      const child = children.find((c) => c.id === e.child_id);
      return h("tr", null, h("td", null, e.domain), h("td", null, child ? child.name : "—"),
        h("td", null, e.decision.category ? catLabel(e.decision.category) : e.decision.reason), h("td", { class: "muted" }, timeAgo(e.timestamp)));
    })))));
  main.append(recentBlock);
});
