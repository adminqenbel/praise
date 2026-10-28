const test = require("node:test");
const assert = require("node:assert");
const L = require("../lib.js");

test("normalizeDomain", () => {
  assert.strictEqual(L.normalizeDomain("https://WWW.Example.com:8080/a?b=1"), "example.com");
  assert.strictEqual(L.normalizeDomain("https://bücher.de/"), "xn--bcher-kva.de");
  for (const bad of ["chrome://extensions", "http://localhost/", "http://192.168.0.1/",
                     "http://[::1]/", "javascript:alert(1)", "data:text/html,hi", "file:///c:/x", "nope"]) {
    assert.strictEqual(L.normalizeDomain(bad), null, bad);
  }
});

test("domainMatches handles subdomains but not suffix collisions", () => {
  assert.strictEqual(L.domainMatches("a.b.school.edu", ["school.edu"]), "school.edu");
  assert.strictEqual(L.domainMatches("notschool.edu", ["school.edu"]), null);
});

test("offlineDecision order and fail-closed default", () => {
  const snap = { exceptions: ["bank.com"], block_domains: ["bank.com", "bad.com"],
                 allow_domains: ["ok.com"], blocked_tlds: [".xyz"], unknown_action: "REVIEW" };
  assert.strictEqual(L.offlineDecision("bank.com", snap).action, "ALLOW");   // exception wins
  assert.strictEqual(L.offlineDecision("bad.com", snap).action, "BLOCK");
  assert.strictEqual(L.offlineDecision("ok.com", snap).action, "ALLOW");
  assert.strictEqual(L.offlineDecision("x.xyz", snap).action, "BLOCK");
  assert.strictEqual(L.offlineDecision("new.com", snap).action, "BLOCK");     // REVIEW -> closed offline
  assert.strictEqual(L.offlineDecision("new.com", null).action, "BLOCK");
  assert.strictEqual(L.offlineDecision("new.com", { unknown_action: "ALLOW" }).action, "ALLOW");
});

test("extractSignals", () => {
  const html = `<html><head><title> Lucky &amp; Co </title>
    <meta name="description" content="Play slots now"></head>
    <body><script>var x="<b>no</b>"</script><form><input type="password"></form>
    <p>Big   jackpot</p></body></html>`;
  const s = L.extractSignals(html);
  assert.strictEqual(s.title, "Lucky & Co");
  assert.strictEqual(s.description, "Play slots now");
  assert.ok(s.text.includes("Big jackpot") && !s.text.includes("no"));
  assert.strictEqual(s.has_password_field, true);
  assert.strictEqual(s.form_count, 1);
});

test("extractSignals bounds output on hostile input", () => {
  const s = L.extractSignals("<title>" + "A".repeat(10000) + "</title>" + "x".repeat(900000));
  assert.ok(s.title.length <= 200 && s.text.length <= 1500);
  assert.deepStrictEqual(L.extractSignals(null).form_count, 0);
});

test("offlineDecision honours verified lists (seeded sites keep working offline)", () => {
  const snap = { unknown_action: "BLOCK", verified: {
    allow: ["google.com"], allow_exact: ["school-portal.org"], block: ["facebook.com"], block_exact: [] } };
  assert.strictEqual(L.offlineDecision("www.google.com", snap).action, "ALLOW");
  assert.strictEqual(L.offlineDecision("accounts.google.com", snap).action, "ALLOW");
  assert.strictEqual(L.offlineDecision("notgoogle.com", snap).action, "BLOCK");
  assert.strictEqual(L.offlineDecision("school-portal.org", snap).action, "ALLOW");
  assert.strictEqual(L.offlineDecision("a.school-portal.org", snap).action, "BLOCK");   // exact-only
  assert.strictEqual(L.offlineDecision("m.facebook.com", snap).action, "BLOCK");
  // a parent's allow/exception still outranks a verified block
  assert.strictEqual(L.offlineDecision("facebook.com", { ...snap, exceptions: ["facebook.com"] }).action, "ALLOW");
});

test("offlineDecision: WARN lists and adult unknown-site defaults", () => {
  const snap = { unknown_action: "ALLOW", verified: { warn: ["scam.example"], warn_exact: ["odd.org"], allow: [], block: [] } };
  assert.strictEqual(L.offlineDecision("a.scam.example", snap).action, "WARN");
  assert.strictEqual(L.offlineDecision("odd.org", snap).action, "WARN");
  assert.strictEqual(L.offlineDecision("x.odd.org", snap).action, "ALLOW");        // exact only
  assert.strictEqual(L.offlineDecision("new.com", snap).action, "ALLOW");          // adult default
  assert.strictEqual(L.offlineDecision("new.com", { unknown_action: "WARN" }).action, "WARN");
  assert.strictEqual(L.offlineDecision("new.com", { unknown_action: "REVIEW" }).action, "BLOCK");   // family stays closed
});

test("compileRules: Sets pass through, arrays are compiled once and rebuilt only when they change", () => {
  const list = ["a.com", "b.com"];
  const set = L.compileRules(list);
  assert.ok(set instanceof Set && set.has("a.com"));
  assert.strictEqual(L.compileRules(list), set);                     // same list: no rebuild
  assert.strictEqual(L.compileRules(set), set);                      // already a Set
  list.push("c.com");
  assert.ok(L.compileRules(list).has("c.com"));                      // the list grew: rebuilt
  assert.strictEqual(L.compileRules(null).size, 0);
  assert.strictEqual(L.compileRules("nope").size, 0);
  assert.strictEqual(L.compileRules([]).size, 0);
});

test("domainMatches accepts a compiled Set and keeps the array form working", () => {
  const rules = ["school.edu", "x.co.uk", "com"];
  const set = L.compileRules(rules);
  for (const r of [rules, set]) {
    assert.strictEqual(L.domainMatches("a.b.school.edu", r), "school.edu");
    assert.strictEqual(L.domainMatches("school.edu", r), "school.edu");
    assert.strictEqual(L.domainMatches("notschool.edu", r), null);
    assert.strictEqual(L.domainMatches("shop.x.co.uk", r), "x.co.uk");
    assert.strictEqual(L.domainMatches("anything.com", r), "com");   // a bare-TLD rule still matches, as before
  }
  assert.strictEqual(L.domainMatches("a.com", null), null);
  assert.strictEqual(L.domainMatches("a.com", undefined), null);
  assert.strictEqual(L.domainMatches("a.com", []), null);
  assert.strictEqual(L.domainMatches(null, rules), null);
  assert.strictEqual(L.domainMatches("", [""]), "");
});

test("domainMatches on a large rule list does not rebuild the list per call", () => {
  const rules = Array.from({ length: 50000 }, (_, i) => `site${i}.example`);
  const set = L.compileRules(rules);
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) assert.strictEqual(L.domainMatches(`www.site${i}.example`, set), `site${i}.example`);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1000);      // generous: 20k lookups, far below a second
  assert.strictEqual(L.compileRules(rules), set);
});

test("offlineDecision uses compiled lists, per snapshot, and follows changes to the snapshot", () => {
  const snap = { block_domains: ["bad.com"], allow_domains: ["ok.com"], blocked_tlds: [".xyz"], verified: { warn_exact: ["odd.org"] }, unknown_action: "ALLOW" };
  assert.strictEqual(L.offlineDecision("a.bad.com", snap).action, "BLOCK");
  assert.strictEqual(L.offlineDecision("a.bad.com", snap).action, "BLOCK");          // second call: cached
  assert.strictEqual(L.offlineDecision("odd.org", snap).action, "WARN");
  snap.block_domains.push("new-bad.com");                                            // grown in place
  assert.strictEqual(L.offlineDecision("new-bad.com", snap).action, "BLOCK");
  snap.allow_domains = ["fresh.com"];                                                // replaced
  assert.strictEqual(L.offlineDecision("fresh.com", snap).reason, "offline-parent-allow");
  assert.strictEqual(L.offlineDecision("ok.com", snap).reason, "offline-unknown-default");
  assert.strictEqual(L.offlineDecision("q.xyz", snap).reason, "offline-tld");
  assert.strictEqual(L.offlineDecision("a.com", "weird").reason, "offline-unknown-default");
});

test("offlineDecision takes a caller-supplied compiled snapshot (snap.compiled)", () => {
  const snap = { block_domains: ["bad.com"], unknown_action: "ALLOW" };
  const real = L.compileSnapshot({ block_domains: ["other.com"], unknown_action: "ALLOW" });
  assert.strictEqual(L.offlineDecision("bad.com", snap).action, "BLOCK");
  assert.strictEqual(L.offlineDecision("bad.com", { ...snap, compiled: real }).action, "ALLOW");   // the supplied sets win
  assert.strictEqual(L.offlineDecision("other.com", { ...snap, compiled: real }).action, "BLOCK");
});
