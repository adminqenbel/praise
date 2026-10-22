const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const W = require("../passwords.js");

test("SHA-1 matches the published test vectors", () => {
  assert.strictEqual(W.sha1Hex(""), "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709");
  assert.strictEqual(W.sha1Hex("abc"), "A9993E364706816ABA3E25717850C26C9CD0D89D");
  assert.strictEqual(W.sha1Hex("password"), "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
  assert.strictEqual(W.sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "84983E441C3BD26EBAAE4AA1F95129E5E54670F1");
  assert.strictEqual(W.sha1Hex("a".repeat(1_000_000)), "34AA973CD4C4DAA4F61EEB2BDBAD27316534016F");   // many blocks
});

test("SHA-1 agrees with Node's crypto on awkward inputs (unicode, padding boundaries)", () => {
  const cases = ["pässword", "密码🔒✓", "é".repeat(31), "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(119), "\u0000\u0001", "a b\tc\n"];
  for (let n = 0; n < 60; n++) cases.push(crypto.randomBytes(n).toString("latin1"));
  for (const c of cases) {
    assert.strictEqual(W.sha1Hex(c), crypto.createHash("sha1").update(Buffer.from(c, "utf8")).digest("hex").toUpperCase(), JSON.stringify(c).slice(0, 30));
  }
});

test("only a five-character prefix is ever exposed, and it is a valid prefix", () => {
  const { prefix, suffix } = W.rangeParts("password");
  assert.strictEqual(prefix, "5BAA6");
  assert.strictEqual(suffix, "1E4C9B93F3F0682250B6CF8331B7EE68FD8");
  assert.ok(W.isPrefix(prefix));
  for (const bad of ["5baa6", "5BAA", "5BAA66", "ZZZZZ", "", null, undefined, "5BAA6/../x"]) assert.ok(!W.isPrefix(bad), String(bad));
});

const RANGE = [
  "0018A45C4D1DEF81644B54AB7F969B88D65:1",
  "1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824",       // "password"
  "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0",             // padding entry
  "011053FD0102E94D6AE2F8B83D76FAF94F6:42",
].join("\r\n");

test("breachCount finds the match locally and ignores padding entries", () => {
  assert.strictEqual(W.breachCount("password", RANGE), 9545824);
  assert.strictEqual(W.breachCount("a-long-random-passphrase-9f3k", RANGE), 0);
  // a padded (count 0) entry must never read as "breached"
  const padded = "1E4C9B93F3F0682250B6CF8331B7EE68FD8:0";
  assert.strictEqual(W.breachCount("password", padded), 0);
});

test("parseRange tolerates junk and oversized replies", () => {
  assert.strictEqual(W.parseRange("not a range\n\n:::\nZZ:1").size, 0);
  assert.strictEqual(W.parseRange(null).size, 0);
  assert.strictEqual(W.parseRange("x".repeat(2_000_001)).size, 0);
  assert.strictEqual(W.parseRange("1e4c9b93f3f0682250b6cf8331b7ee68fd8:7").get("1E4C9B93F3F0682250B6CF8331B7EE68FD8"), 7);   // case-insensitive
});

test("formatCount is short and readable", () => {
  assert.strictEqual(W.formatCount(42), "42");
  assert.strictEqual(W.formatCount(9545824), "9.5 million");
  assert.strictEqual(W.formatCount(1200000), "1.2 million");
  assert.strictEqual(W.formatCount(12345678), "12 million");
  assert.strictEqual(W.formatCount(48210), "48,210");
});
