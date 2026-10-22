const test = require("node:test");
const assert = require("node:assert");
const S = require("../sensitive.js");
const P = require("../protections.js");

test("card numbers: Luhn plus shape, with separators", () => {
  for (const ok of ["4111111111111111", "4111 1111 1111 1111", "5500-0000-0000-0004", "378282246310005", "6011111111111117"]) {
    assert.ok(S.looksLikeCard(ok), ok);
  }
  for (const bad of ["4111111111111112", "1234567890123456", "0000000000000000", "1111111111111111", "411111111111", "abcd efgh ijkl mnop", ""]) {
    assert.ok(!S.looksLikeCard(bad), bad);
  }
});

test("Aadhaar: Verhoeff catches every single-digit error", () => {
  const make = (prefix) => { const c = [0,1,2,3,4,5,6,7,8,9].filter((d) => S.verhoeff(prefix + d)); assert.strictEqual(c.length, 1); return prefix + c[0]; };
  const valid = make("23412341234");
  assert.ok(S.looksLikeAadhaar(valid));
  assert.ok(S.looksLikeAadhaar(valid.slice(0, 4) + " " + valid.slice(4, 8) + " " + valid.slice(8)));   // spaced as printed
  for (let i = 0; i < 12; i++) {
    for (let d = 0; d < 10; d++) {
      if (String(d) === valid[i]) continue;
      assert.ok(!S.verhoeff(valid.slice(0, i) + d + valid.slice(i + 1)), `digit ${i}->${d}`);
    }
  }
  assert.ok(!S.looksLikeAadhaar("123456789012"));                 // starts with 1
  assert.ok(!S.looksLikeAadhaar("0" + valid.slice(1)));
});

test("US SSN, India PAN, IBAN", () => {
  assert.ok(S.looksLikeSSN("123-45-6789"));
  for (const bad of ["000-12-3456", "666-12-3456", "900-12-3456", "123-00-6789", "123-45-0000", "123456789", "12-345-6789"]) assert.ok(!S.looksLikeSSN(bad), bad);
  assert.ok(S.looksLikePAN("ABCDE1234F"));
  assert.ok(!S.looksLikePAN("abcde1234f") && !S.looksLikePAN("ABCD12345F"));
  assert.ok(S.looksLikeIBAN("GB82 WEST 1234 5698 7654 32"));
  assert.ok(!S.looksLikeIBAN("GB82 WEST 1234 5698 7654 33"));
});

test("classifyValue ignores ordinary text and numbers", () => {
  assert.strictEqual(S.classifyValue("4111 1111 1111 1111"), "card");
  assert.strictEqual(S.classifyValue("123-45-6789"), "id");
  for (const v of ["hello world", "2026-10-10", "9876543210", "+91 98765 43210", "my-username", "12345"]) assert.strictEqual(S.classifyValue(v), null, v);
});

test("classifyField reads what an input says it is", () => {
  const f = (a) => S.classifyField(a);
  assert.strictEqual(f({ autocomplete: "cc-number" }), "card");
  assert.strictEqual(f({ autocomplete: "cc-csc" }), "card_cvc");
  assert.strictEqual(f({ autocomplete: "one-time-code" }), "otp");
  assert.strictEqual(f({ type: "password" }), "password");
  assert.strictEqual(f({ name: "cardNumber" }), "card");
  assert.strictEqual(f({ id: "cvv" }), "card_cvc");
  assert.strictEqual(f({ placeholder: "Enter OTP" }), "otp");
  assert.strictEqual(f({ ariaLabel: "Aadhaar number" }), "id");
  assert.strictEqual(f({ name: "ssn" }), "id");
  for (const a of [{ name: "email" }, { name: "first_name" }, { type: "text", placeholder: "Search" }, { name: "discount_code" }]) assert.strictEqual(f(a), null, JSON.stringify(a));
});

test("assess: warns only when sensitive data meets an untrustworthy page", () => {
  const risky = { reason: "This looks like a fake bank page." };
  assert.strictEqual(S.assess({ kinds: ["password"], risky }).warn, true);
  assert.strictEqual(S.assess({ kinds: ["password"] }).warn, false);                       // ordinary login on a fine site
  assert.strictEqual(S.assess({ kinds: [], risky }).warn, false);                           // nothing sensitive typed
  assert.strictEqual(S.assess({ kinds: ["card"], insecure: true }).warn, true);
  assert.strictEqual(S.assess({ kinds: ["otp"], crossPost: { host: "evil.example" } }).warn, true);
  const a = S.assess({ kinds: ["card", "card_cvc", "password"], risky, insecure: true });
  assert.deepStrictEqual(a.kinds, ["card", "password"]);
  assert.strictEqual(a.reasons.length, 2);
});

test("assess respects the person's settings", () => {
  const risky = { reason: "r" };
  assert.strictEqual(S.assess({ kinds: ["password"], risky, settings: { passwords: false } }).warn, false);
  assert.strictEqual(S.assess({ kinds: ["card"], risky, settings: { cards: false } }).warn, false);
  assert.strictEqual(S.assess({ kinds: ["card", "password"], risky, settings: { cards: false } }).kinds[0], "password");
  assert.strictEqual(S.assess({ kinds: ["card"], risky, settings: { warn: false } }).warn, false);
});

test("describeKinds reads naturally", () => {
  assert.strictEqual(S.describeKinds(["card"]), "card details");
  assert.strictEqual(S.describeKinds(["card", "card_cvc"]), "card details");
  assert.strictEqual(S.describeKinds(["card", "password"]), "card details and a password");
  assert.strictEqual(S.describeKinds(["id", "otp", "password"]), "an ID number, a one-time code and a password");
});

test("crossSitePost: another site is suspicious, a payment processor or same site is not", () => {
  const reg = P.registrableDomain;
  assert.deepStrictEqual(S.crossSitePost("shop.example.com", "https://collect.evil.net/steal", reg), { host: "collect.evil.net" });
  assert.strictEqual(S.crossSitePost("shop.example.com", "https://api.example.com/pay", reg), null);       // same registrable domain
  assert.strictEqual(S.crossSitePost("shop.example.com", "https://checkout.stripe.com/pay", reg), null);   // known processor
  assert.strictEqual(S.crossSitePost("shop.example.com", "javascript:void(0)", reg), null);
  assert.strictEqual(S.crossSitePost("shop.example.co.uk", "https://pay.example.co.uk/x", reg), null);     // multi-part suffix
});

test("localhost is never 'insecure'", () => {
  for (const h of ["localhost", "127.0.0.1", "app.localhost"]) assert.ok(S.isLocalHost(h), h);
  assert.ok(!S.isLocalHost("example.com"));
});
