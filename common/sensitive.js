// Detection and decision rules for the sensitive-data guard (Praise Shield).
// Pure functions: no DOM, no chrome.*, nothing is stored or sent. The content script feeds them
// what's in a form; they answer "is this the kind of thing that must not go to a risky site?".
(function (root) {
  "use strict";

  // ---- value checks ------------------------------------------------------------------------
  const digitsOnly = (v) => String(v || "").replace(/[\s-]/g, "");

  // Luhn checksum: real card numbers pass it, random digit strings almost never do.
  function luhn(num) {
    let sum = 0, alt = false;
    for (let i = num.length - 1; i >= 0; i--) {
      let n = num.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function looksLikeCard(value) {
    const n = digitsOnly(value);
    if (!/^\d{13,19}$/.test(n)) return false;
    if (/^(\d)\1+$/.test(n)) return false;          // 0000…, 1111…: pass Luhn but are not cards
    return luhn(n);
  }

  // Verhoeff checksum, used by India's Aadhaar numbers.
  const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
    [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
    [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];

  function verhoeff(num) {
    let c = 0;
    const rev = num.split("").reverse();
    for (let i = 0; i < rev.length; i++) c = VD[c][VP[i % 8][rev[i].charCodeAt(0) - 48]];
    return c === 0;
  }

  function looksLikeAadhaar(value) {
    const n = digitsOnly(value);
    return /^[2-9]\d{11}$/.test(n) && verhoeff(n);   // never starts with 0 or 1
  }

  // US Social Security number format, excluding ranges that are never issued.
  function looksLikeSSN(value) {
    const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(String(value || "").trim());
    if (!m) return false;
    const [, area, group, serial] = m;
    return area !== "000" && area !== "666" && area[0] !== "9" && group !== "00" && serial !== "0000";
  }

  const looksLikePAN = (value) => /^[A-Z]{5}\d{4}[A-Z]$/.test(String(value || "").trim());

  // Bank account number (IBAN): its shape plus the mod-97 check.
  function looksLikeIBAN(value) {
    const s = String(value || "").replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
    const rearranged = s.slice(4) + s.slice(0, 4);
    let rem = 0;
    for (const ch of rearranged) {
      const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
      for (const d of code) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
    return rem === 1;
  }

  // What a typed value is, by its shape alone. Returns "card" | "id" | null.
  function classifyValue(value) {
    const v = String(value || "");
    if (v.length < 9 || v.length > 40) return null;
    if (looksLikeCard(v)) return "card";
    if (looksLikeAadhaar(v) || looksLikeSSN(v) || looksLikePAN(v) || looksLikeIBAN(v)) return "id";
    return null;
  }

  // ---- field checks (what the input says it is) -----------------------------------------------
  // attrs: { type, name, id, autocomplete, placeholder, ariaLabel, label, maxLength, inputMode }
  function classifyField(attrs) {
    const a = attrs || {};
    const ac = String(a.autocomplete || "").toLowerCase();
    if (/\bone-time-code\b/.test(ac)) return "otp";
    if (/\bcc-number\b/.test(ac)) return "card";
    if (/\bcc-csc\b/.test(ac)) return "card_cvc";
    if (/\bcc-(exp|name)/.test(ac)) return "card";
    if (String(a.type || "").toLowerCase() === "password" || /\b(current|new)-password\b/.test(ac)) return "password";

    const hint = [a.name, a.id, a.placeholder, a.ariaLabel, a.label].map((x) => String(x || "")).join(" ").toLowerCase();
    if (/otp|one[\s_-]?time|verification[\s_-]?code|passcode|2fa|authenticator|sms[\s_-]?code/.test(hint)) return "otp";
    if (/cvv|cvc|csc\b|card[\s_-]?(security|code|verification)/.test(hint)) return "card_cvc";
    if (/card[\s_-]?(number|no\b|num)|cc[\s_-]?num|ccnumber|cardnumber|credit[\s_-]?card|debit[\s_-]?card/.test(hint)) return "card";
    if (/aadhaar|aadhar|uidai|\bssn\b|social[\s_-]?security|\bpan[\s_-]?(no|number|card)|passport|national[\s_-]?id|tax[\s_-]?id/.test(hint)) return "id";
    return null;
  }

  // ---- the decision -----------------------------------------------------------------------------
  // Words used when telling the person what kind of data is about to be sent.
  const KIND_WORDS = { card: "card details", id: "an ID number", otp: "a one-time code", password: "a password" };

  function normalizeKind(k) { return k === "card_cvc" ? "card" : k; }

  function describeKinds(kinds) {
    const words = Array.from(new Set(kinds.map(normalizeKind))).map((k) => KIND_WORDS[k]).filter(Boolean);
    if (words.length <= 1) return words[0] || "personal details";
    return words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
  }

  const isLocalHost = (host) => host === "localhost" || /^127\./.test(host) || host === "[::1]" || host.endsWith(".localhost");

  // Common payment processors: a form that posts to one of these is normal on a shop.
  const PROCESSORS = new Set(["stripe.com", "paypal.com", "razorpay.com", "paytm.com", "adyen.com", "braintreegateway.com",
    "checkout.com", "squareup.com", "payu.in", "payu.com", "ccavenue.com", "billdesk.com", "cashfree.com", "worldpay.com"]);

  // Does this form send its data to a different site than the page? Returns { host } or null.
  function crossSitePost(pageHost, actionUrl, registrableDomain) {
    let target;
    try { target = new URL(actionUrl); } catch (e) { return null; }
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    const a = registrableDomain(pageHost), b = registrableDomain(target.hostname);
    if (!a || !b || a === b || PROCESSORS.has(b)) return null;
    return { host: target.hostname };
  }

  // kinds: Set/array of field kinds with a typed value. flags: what makes this page untrustworthy.
  // settings: policy.sensitive_data. Returns whether to interrupt, and why, in plain words.
  function assess({ kinds, insecure, crossPost, risky, settings }) {
    const s = Object.assign({ warn: true, cards: true, ids: true, otp: true, passwords: true }, settings || {});
    if (!s.warn) return { warn: false, reasons: [], kinds: [] };

    const keep = Array.from(kinds || []).filter((k) =>
      ((k === "card" || k === "card_cvc") && s.cards) || (k === "id" && s.ids) || (k === "otp" && s.otp) || (k === "password" && s.passwords));
    const reasons = [];
    if (risky && risky.reason) reasons.push(risky.reason);
    if (insecure) reasons.push("This page isn't encrypted, so anyone on the network could read what you send.");
    if (crossPost) reasons.push(`This form sends your details to a different site (${crossPost.host}).`);

    const unique = Array.from(new Set(keep.map(normalizeKind)));
    return { warn: unique.length > 0 && reasons.length > 0, reasons, kinds: unique };
  }

  const api = { luhn, looksLikeCard, verhoeff, looksLikeAadhaar, looksLikeSSN, looksLikePAN, looksLikeIBAN,
    classifyValue, classifyField, describeKinds, isLocalHost, crossSitePost, assess, PROCESSORS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseSensitive = api;
})(typeof self !== "undefined" ? self : this);
