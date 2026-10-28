"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startAgent, FAMILY, ADULT, norm, fakeDetect, lib } = require("./helpers");
const policyLib = require("../src/policy");
const { createEngine } = require("../src/engine");

const decide = (a, url, signals) => a.call("/v1/decide", { body: signals ? { url, signals } : { url } }).then((r) => r.json);

test("precedence: exception > parent block > parent allow > verified block > verified allow > verified warn > TLD > default", async () => {
  const a = await startAgent({ policy: FAMILY });
  try {
    const want = [
      ["https://ok.badsite.com/", "ALLOW", "offline-exception"],
      ["https://www.badsite.com/x", "BLOCK", "offline-parent-block"],
      ["https://sub.wikipedia.org/", "ALLOW", "offline-parent-allow"],
      ["https://gambling.com/", "BLOCK", "offline-verified-block"],
      ["https://api.khanacademy.org/", "ALLOW", "offline-verified-allow"],
      ["https://exact.example.org/", "ALLOW", "offline-verified-allow"],
      ["https://sub.exact.example.org/", "BLOCK", "offline-unknown-default"],        // *_exact lists do not cover subdomains
      ["https://old.reddit.com/", "WARN", "offline-verified-warn"],
      ["https://anything.xyz/", "BLOCK", "offline-tld"],
      ["https://anything.zip/", "BLOCK", "offline-tld"],                              // TLD given without the dot is normalised
      ["https://never-seen.com/", "BLOCK", "offline-unknown-default"],
    ];
    for (const [url, action, reason] of want) {
      const d = await decide(a, url);
      assert.equal(d.action, action, url);
      assert.equal(d.reason, reason, url);
    }
  } finally { await a.stop(); }
});

test("parent allow outranks a verified block, and a verified site outranks a TLD block", async () => {
  const snap = { ...FAMILY, allow_domains: ["gambling.com"], blocked_tlds: [".org"], verified: { ...FAMILY.verified, allow: ["khanacademy.org"] } };
  const a = await startAgent({ policy: snap });
  try {
    assert.equal((await decide(a, "https://gambling.com/")).reason, "offline-parent-allow");
    assert.equal((await decide(a, "https://khanacademy.org/")).reason, "offline-verified-allow");
  } finally { await a.stop(); }
});

test("family mode: unclear stays closed even if the snapshot's unknown_action says ALLOW; the detector is not even asked", async () => {
  const a = await startAgent({ policy: { ...FAMILY, unknown_action: "ALLOW" } });
  try {
    const d = await decide(a, "https://fresh-site.com/");
    assert.equal(d.action, "BLOCK");
    assert.equal(a.detect.calls.url, 0);
  } finally { await a.stop(); }
});

test("adult mode: unknown follows the snapshot (ALLOW or WARN)", async () => {
  for (const [unknown, expected] of [["ALLOW", "ALLOW"], ["WARN", "WARN"], ["BLOCK", "BLOCK"], ["REVIEW", "BLOCK"]]) {
    const a = await startAgent({ policy: { ...ADULT, unknown_action: unknown } });
    try {
      const d = await decide(a, "https://new-place.com/");
      assert.equal(d.action, expected, unknown);
      assert.equal(d.can_continue, expected === "WARN");
    } finally { await a.stop(); }
  }
});

test("detection adds caution to an unknown adult site: medium -> WARN, high -> BLOCK, low -> unchanged", async () => {
  const a = await startAgent({ policy: ADULT });
  try {
    const low = await decide(a, "https://meh-site.com/");
    assert.equal(low.action, "ALLOW");
    const med = await decide(a, "https://sus-site.com/");
    assert.equal(med.action, "WARN"); assert.equal(med.reason, "detect-warn"); assert.equal(med.source, "detection"); assert.equal(med.can_continue, true);
    const high = await decide(a, "https://phish-site.com/");
    assert.equal(high.action, "BLOCK"); assert.equal(high.reason, "detect-block");
    assert.equal(high.level, "high"); assert.equal(high.score, 0.9);
    assert.deepEqual(high.reasons, ["looks like a login page for a known brand"]);
  } finally { await a.stop(); }
});

test("detection can never override parent rules, verified sites or TLD blocks", async () => {
  const a = await startAgent({ policy: ADULT });
  try {
    for (const [url, action] of [
      ["https://phish.wikipedia.org/", "ALLOW"],          // parent allow
      ["https://phish.khanacademy.org/", "ALLOW"],        // verified allow
      ["https://phish.ok.badsite.com/", "ALLOW"],         // exception
      ["https://phish-login.xyz/", "BLOCK"],              // TLD
    ]) assert.equal((await decide(a, url)).action, action, url);
    assert.equal(a.detect.calls.url, 0, "detector is skipped when policy already decided");
  } finally { await a.stop(); }
});

test("an adult unknown-WARN site is raised to BLOCK by high risk but never lowered", async () => {
  const a = await startAgent({ policy: { ...ADULT, unknown_action: "WARN" } });
  try {
    assert.equal((await decide(a, "https://phish-me.com/")).action, "BLOCK");
    assert.equal((await decide(a, "https://calm.com/")).action, "WARN");
  } finally { await a.stop(); }
});

test("settings.safe_browsing.warn_above_risk lowers the warn threshold", async () => {
  const snap = { ...ADULT, settings: { safe_browsing: { warn_above_risk: 25 } } };
  const a = await startAgent({ policy: snap });
  try {
    assert.equal((await decide(a, "https://meh-site.com/")).action, "WARN");     // 0.3 >= 0.25
  } finally { await a.stop(); }
});

test("page signals feed scorePage: a password form on an unknown site is raised", async () => {
  const a = await startAgent({ policy: ADULT });
  try {
    assert.equal((await decide(a, "https://plain.com/")).action, "ALLOW");
    const d = await decide(a, "https://plain.com/", { has_password_field: true, form_count: 1 });
    assert.equal(d.action, "BLOCK");              // 0.8 >= 0.75
    assert.equal(a.detect.calls.page, 1);
  } finally { await a.stop(); }
});

test("no snapshot: BLOCK offline-no-policy, not cached, and it flips as soon as a policy arrives", async () => {
  const a = await startAgent();
  try {
    const d = await decide(a, "https://example.com/");
    assert.equal(d.action, "BLOCK"); assert.equal(d.reason, "offline-no-policy"); assert.equal(d.cache_ttl, 0);
    a.agent.engine.setPolicy(norm(ADULT));
    assert.equal((await decide(a, "https://example.com/")).action, "ALLOW");
  } finally { await a.stop(); }
});

test("things that are not websites are allowed as 'not-a-website' (same as the extension), even with no policy", async () => {
  const a = await startAgent();
  try {
    for (const url of ["chrome://settings/", "http://localhost:3000/", "http://192.168.1.5/", "ftp://files.example.com/"]) {
      const d = await decide(a, url);
      assert.equal(d.action, "ALLOW", url); assert.equal(d.reason, "not-a-website");
    }
  } finally { await a.stop(); }
});

test("decide response carries the Verdict fields plus cached", async () => {
  const a = await startAgent({ policy: ADULT });
  try {
    const d = await decide(a, "https://sus-site.com/");
    for (const k of ["action", "reason", "level", "score", "reasons", "brand", "official", "features", "cached"]) assert.ok(k in d, k);
    assert.equal(d.cached, false);
    assert.equal((await decide(a, "https://sus-site.com/")).cached, true);
  } finally { await a.stop(); }
});

test("compiled index agrees with PraiseLib.offlineDecision on a randomised corpus (adult snapshots)", () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const labels = ["a", "b", "shop", "news", "evil", "kids", "wiki"], tlds = ["com", "org", "xyz", "net", "edu"];
  const dom = () => { const n = 1 + rnd(3); return Array.from({ length: n }, () => labels[rnd(labels.length)]).concat(tlds[rnd(tlds.length)]).join("."); };
  const list = () => Array.from({ length: rnd(4) }, dom);
  for (let round = 0; round < 60; round++) {
    const raw = {
      mode: "adult", unknown_action: ["ALLOW", "WARN", "BLOCK", "REVIEW"][rnd(4)], exceptions: list(), block_domains: list(), allow_domains: list(),
      blocked_tlds: rnd(2) ? ["." + tlds[rnd(tlds.length)]] : [],
      verified: { allow: list(), allow_exact: list(), warn: list(), warn_exact: list(), block: list(), block_exact: list() },
    };
    const n = norm(raw);
    const idx = policyLib.compile(n);
    for (let i = 0; i < 80; i++) {
      const d = dom();
      const want = lib.offlineDecision(d, n);
      const got = idx.decide(d);
      assert.equal(got.action, want.action, `${d} ${JSON.stringify(n)}`);
      assert.equal(got.reason, want.reason, d);
    }
  }
});

test("normalizeSnapshot rejects non-policies and bounds/cleans what it keeps", () => {
  for (const bad of [null, [], "x", 5, {}, { foo: 1 }]) assert.equal(norm(bad), null);
  const n = norm({ unknown_action: "weird", block_domains: ["EVIL.com", "*.also-evil.com.", 5, "bad domain", "x".repeat(300)], blocked_tlds: ["xyz", ".com", "BAD TLD"], mode: "ADULT" });
  assert.deepEqual(n.block_domains, ["also-evil.com", "evil.com"]);
  assert.deepEqual(n.blocked_tlds, [".com", ".xyz"]);
  assert.equal(n.unknown_action, "BLOCK");
  assert.equal(n.mode, "family");                 // only the exact string "adult" opens the default
  const same = policyLib.versionOf(norm({ ...FAMILY, child: "A" })) === policyLib.versionOf(norm({ ...FAMILY, child: "B" }));
  assert.ok(same);
  assert.notEqual(policyLib.versionOf(norm(FAMILY)), policyLib.versionOf(norm(ADULT)));
});

test("engine works with the repo's real common/detect.js (stub or real) and never throws on odd input", () => {
  const detect = require("../../common/detect.js");
  const engine = createEngine({ detect, lib });
  engine.setPolicy(norm(ADULT));
  for (const url of ["https://example.com/", "https://paypa1-secure-login.xyz/verify?account=1", "http://[::1]/", "javascript:alert(1)"]) {
    const r = engine.decide(url);
    const body = JSON.parse(r.body);
    assert.ok(["ALLOW", "WARN", "BLOCK"].includes(body.action), url);
    assert.equal(typeof body.score, "number");
  }
  assert.equal(engine.detectVersion, detect.version);
});
