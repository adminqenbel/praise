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
