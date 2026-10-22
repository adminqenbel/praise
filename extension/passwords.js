// Password helpers for Praise Shield. Pure: no DOM, no chrome.*, no network.
//
// Breach check (k-anonymity): the page hashes the password with SHA-1 locally, and only the FIRST
// FIVE hex characters of that hash are ever sent to the Pwned Passwords range API. The API returns
// every known breached hash with the same prefix, and the match is made here, on the device. The
// password, and its full hash, never leave the page.
//
// SHA-1 is implemented here (not crypto.subtle) because content scripts on plain-http pages are not
// a secure context and have no crypto.subtle. SHA-1 is used only because the breach list is keyed
// by it; it is not used to protect anything.
(function (root) {
  "use strict";

  function utf8(str) {
    const out = [];
    for (const ch of String(str)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

  function sha1Hex(str) {
    const bytes = utf8(str);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Array(80);
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = ((bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3]) >>> 0;
      for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("").toUpperCase();
  }

  // { prefix, suffix } of the SHA-1: the prefix may be sent; the suffix never leaves the device.
  function rangeParts(password) {
    const h = sha1Hex(password);
    return { prefix: h.slice(0, 5), suffix: h.slice(5) };
  }

  const isPrefix = (p) => /^[0-9A-F]{5}$/.test(String(p));

  // Parses the API's "SUFFIX:COUNT" lines. With Add-Padding the reply includes fake entries with a
  // count of 0; those are dropped so they can't produce a false "breached" result.
  function parseRange(text) {
    const map = new Map();
    if (typeof text !== "string" || text.length > 2_000_000) return map;
    for (const line of text.split(/\r?\n/)) {
      const m = /^([0-9A-F]{35}):(\d{1,12})$/i.exec(line.trim());
      if (m && Number(m[2]) > 0) map.set(m[1].toUpperCase(), Number(m[2]));
    }
    return map;
  }

  // How many times this password appears in known breaches (0 = not found), given the range reply.
  function breachCount(password, rangeText) {
    return parseRange(rangeText).get(rangeParts(password).suffix) || 0;
  }

  // '1.2 million' or '3,400', for the number of breaches.
  function formatCount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + " million";
    return n.toLocaleString("en-US");
  }

  const api = { sha1Hex, rangeParts, isPrefix, parseRange, breachCount, formatCount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraisePasswords = api;
})(typeof self !== "undefined" ? self : this);
