const test = require("node:test");
const assert = require("node:assert");
const P = require("../protections.js");

const dl = (filename, extra = {}) => P.evaluateDownload({ filename, url: "https://x.com/f", ...extra });

test("downloads: executables, scripts and macros are blocked", () => {
  for (const f of ["setup.exe", "app.APK", "x.msi", "run.bat", "s.ps1", "t.sh", "m.docm", "disk.iso", "a.jar"]) {
    assert.strictEqual(dl(f).action, "BLOCK", f);
  }
});

test("downloads: double extension and trailing-dot tricks use the real last extension", () => {
  assert.strictEqual(dl("invoice.pdf.exe").action, "BLOCK");
  assert.strictEqual(dl("report.pdf.").action, "ALLOW");
  assert.strictEqual(dl("C:\\Users\\k\\Downloads\\notes.exe ").action, "BLOCK");
});

test("downloads: documents and images allowed", () => {
  for (const f of ["essay.pdf", "photo.jpg", "slides.pptx", "notes.txt", "data.csv"]) {
    assert.strictEqual(dl(f).action, "ALLOW", f);
  }
});

test("downloads: archives follow the setting", () => {
  assert.strictEqual(dl("a.zip").action, "ALLOW");
  assert.strictEqual(P.evaluateDownload({ filename: "a.zip" }, { downloads: { archives: "BLOCK" } }).action, "BLOCK");
});

test("downloads: browser installers by name and by source URL", () => {
  assert.strictEqual(dl("ChromeSetup.exe").kind, "browser_installer");
  assert.strictEqual(dl("Firefox Setup 120.0.exe").kind, "browser_installer");
  assert.strictEqual(dl("BraveBrowserSetup.exe").kind, "browser_installer");
  assert.strictEqual(P.evaluateDownload({ filename: "download", url: "https://download.mozilla.org/?product=firefox" }).kind,
    "browser_installer");
});

test("downloads: bad mime and browser danger flag", () => {
  assert.strictEqual(dl("blob", { mime: "application/x-msdownload" }).action, "BLOCK");
  assert.strictEqual(dl("file.pdf", { danger: "uncommon" }).kind, "browser_flagged");
  assert.strictEqual(dl("file.pdf", { danger: "safe" }).action, "ALLOW");
});

test("downloads: can be disabled by policy", () => {
  assert.strictEqual(P.evaluateDownload({ filename: "a.exe" }, { downloads: { enabled: false } }).action, "ALLOW");
});

test("browser installer pages", () => {
  for (const u of ["https://www.google.com/chrome/", "https://www.mozilla.org/en-US/firefox/new/",
    "https://www.microsoft.com/en-us/edge/download", "https://brave.com/download/",
    "https://www.opera.com/download", "https://download.mozilla.org/?product=firefox-latest"]) {
    assert.ok(P.isBrowserInstallerUrl(u), u);
  }
  for (const u of ["https://www.google.com/search?q=chrome", "https://www.mozilla.org/en-US/about/",
    "https://en.wikipedia.org/wiki/Firefox", "https://developer.chrome.com/docs"]) {
    assert.ok(!P.isBrowserInstallerUrl(u), u);
  }
});

test("escape and tamper URLs", () => {
  assert.strictEqual(P.isEscapeUrl("microsoft-edge:https://example.com").scheme, "microsoft-edge");
  assert.strictEqual(P.isEscapeUrl("googlechrome://x").scheme, "googlechrome");
  assert.strictEqual(P.isEscapeUrl("firefox:https://x").scheme, "firefox");
  assert.strictEqual(P.isEscapeUrl("https://example.com"), null);
  assert.strictEqual(P.isEscapeUrl("mailto:a@b.com"), null);
  assert.ok(P.isTamperUrl("chrome://extensions/?id=abc"));
  assert.ok(P.isTamperUrl("edge://extensions"));
  assert.ok(P.isTamperUrl("chrome://flags/#x"));
  assert.ok(!P.isTamperUrl("chrome://newtab/"));
  assert.ok(!P.isTamperUrl("https://example.com/chrome://extensions"));
});

test("registrableDomain", () => {
  assert.strictEqual(P.registrableDomain("a.b.example.com"), "example.com");
  assert.strictEqual(P.registrableDomain(".example.co.uk"), "example.co.uk");
  assert.strictEqual(P.registrableDomain("x.y.example.co.uk"), "example.co.uk");
  assert.strictEqual(P.registrableDomain("example.com"), "example.com");
});

const NOW = Date.UTC(2026, 9, 6);
const ctx = { topDomains: new Set(["school.edu"]), now: NOW };
const day = 86400;

test("cookies: first-party session vs third-party tracker", () => {
  const first = P.classifyCookie({ name: "PHPSESSID", domain: "portal.school.edu", session: true }, ctx);
  assert.strictEqual(first.thirdParty, false);
  assert.match(first.purpose, /session/i);

  const tr = P.classifyCookie({ name: "IDE", domain: ".doubleclick.net", session: false,
    expirationDate: NOW / 1000 + 90 * day }, ctx);
  assert.deepStrictEqual([tr.thirdParty, tr.tracker, tr.persistent, tr.lifetimeDays], [true, true, true, 90]);
  assert.ok(tr.confidence >= 0.9);
});

test("cookies: dual-use domains only count as trackers when third-party", () => {
  const onFb = P.classifyCookie({ name: "x", domain: ".facebook.com", session: true },
    { topDomains: new Set(["facebook.com"]), now: NOW });
  assert.strictEqual(onFb.tracker, false);
  const embedded = P.classifyCookie({ name: "x", domain: ".facebook.com", session: true }, ctx);
  assert.strictEqual(embedded.tracker, true);
});

test("cookies: purpose is only 'likely', unknown stays unknown", () => {
  const u = P.classifyCookie({ name: "zzq", domain: "school.edu", session: true }, ctx);
  assert.strictEqual(u.purpose, "Unknown");
  assert.ok(u.confidence <= 0.5);
  const noCtx = P.classifyCookie({ name: "zzq", domain: "other.com", session: true }, { topDomains: new Set() });
  assert.strictEqual(noCtx.thirdParty, false);   // no tab context => don't guess "third-party"
});

test("cookieAction follows settings", () => {
  const tracker = { tracker: true, thirdParty: true, unknown: false };
  assert.strictEqual(P.cookieAction(tracker, undefined).remove, true);               // default blocks trackers
  assert.strictEqual(P.cookieAction(tracker, { cookies: { trackers: "ALLOW" } }).remove, false);
  const tp = { tracker: false, thirdParty: true, unknown: false };
  assert.strictEqual(P.cookieAction(tp, undefined).remove, false);                   // default allows third-party
  assert.strictEqual(P.cookieAction(tp, { cookies: { third_party: "BLOCK" } }).remove, true);
  const unk = { tracker: false, thirdParty: false, unknown: true };
  assert.deepStrictEqual(P.cookieAction(unk, undefined), { remove: false, rule: "ask" });
});

test("withDefaults ignores junk", () => {
  assert.strictEqual(P.withDefaults("junk").cookies.trackers, "BLOCK");
  assert.strictEqual(P.withDefaults({ cookies: 5 }).cookies.trackers, "BLOCK");
});

// ---- Praise Shield: network rules ------------------------------------------------------------
const fs = require("node:fs");
const path = require("node:path");

test("tracker rules block third-party subresources, never navigation", () => {
  const sets = P.buildRulesets();
  for (const [name, rules] of Object.entries(sets)) {
    assert.strictEqual(rules.length, 1, name);
    const r = rules[0];
    assert.strictEqual(r.action.type, "block");
    assert.strictEqual(r.condition.domainType, "thirdParty");          // first-party use stays working
    assert.ok(!r.condition.resourceTypes.includes("main_frame"));      // visiting a site is never blocked
    assert.ok(r.condition.requestDomains.every((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)), name); // bare hosts only
    assert.strictEqual(new Set(r.condition.requestDomains).size, r.condition.requestDomains.length);
  }
});

test("dual-use sites are not blocked wholesale, only their tracking hosts", () => {
  const d = P.trackerBlockDomains();
  for (const wholesale of ["facebook.com", "bing.com", "linkedin.com", "yahoo.com", "tiktok.com", "snapchat.com"]) {
    assert.ok(!d.includes(wholesale), wholesale);
  }
  for (const host of ["doubleclick.net", "google-analytics.com", "connect.facebook.net", "bat.bing.com"]) {
    assert.ok(d.includes(host), host);
  }
});

test("tracking-parameter rules only match URLs that carry a tracking parameter, and together cover every parameter", () => {
  const rules = P.paramStripRules(7);
  const matches = (u) => rules.some((r) => new RegExp(r.condition.regexFilter).test(u));
  for (const u of ["https://a.com/?utm_source=x", "https://a.com/p?id=1&fbclid=abc", "https://a.com/?gclid=1", "https://a.com/?a=1&s_cid=2"]) assert.ok(matches(u), u);
  for (const u of ["https://a.com/", "https://a.com/?q=utm_source", "https://a.com/?id=1", "https://a.com/utm_source=x", "https://a.com/?xutm_source=1"]) {
    assert.ok(!matches(u), u);
  }
  for (const p of P.TRACKING_PARAMS) assert.ok(matches("https://a.com/?" + p + "=1"), p);
  assert.deepStrictEqual(rules.map((r) => r.id), rules.map((_, i) => 7 + i));
  for (const r of rules) {
    assert.deepStrictEqual(r.action.redirect.transform.queryTransform.removeParams, P.TRACKING_PARAMS);
    assert.deepStrictEqual(r.condition.resourceTypes, ["main_frame", "sub_frame"]);
  }
});

test("each tracking-parameter pattern stays small enough for Chrome (one pattern for the whole list is rejected as too big)", () => {
  const rules = P.paramStripRules(1);
  assert.ok(rules.length > 1);
  for (const r of rules) assert.ok(r.condition.regexFilter.length < 200, r.condition.regexFilter.length);
});

test("stripTrackingParams keeps functional parameters", () => {
  assert.strictEqual(P.stripTrackingParams("https://shop.com/item?id=9&color=red&utm_medium=email&fbclid=zz"),
    "https://shop.com/item?id=9&color=red");
  assert.strictEqual(P.stripTrackingParams("https://a.com/?q=cats"), "https://a.com/?q=cats");
  assert.strictEqual(P.stripTrackingParams("not a url"), "not a url");
});

test("extension/rules/*.json match what the code generates (run node scripts/build_rules.js)", () => {
  const sets = P.buildRulesets();
  for (const [name, rules] of Object.entries(sets)) {
    const file = path.join(__dirname, "..", "..", "extension", "rules", `${name}.json`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), rules, name);
  }
});
