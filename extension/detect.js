// Phishing / scam scoring shared by the extension, the local agent and Node tests (see docs/DETECTION-CONTRACT.md).
// Stub: returns "no evidence" until the browser-detection stream replaces the internals. The shape is the contract.
// Pure helpers only: no chrome.* calls, no network.
(function (root) {
  "use strict";

  const VERSION = 1;

  function none() {
    return { score: 0, level: "none", reasons: [], brand: null, official: null, features: {} };
  }

  function levelOf(score) {
    return score >= 0.75 ? "high" : score >= 0.5 ? "medium" : score >= 0.25 ? "low" : "none";
  }

  function scoreUrl(url, ctx) { return none(); }

  function scorePage(signals, ctx) { return none(); }

  // The strongest verdict wins; reasons are merged (at most 6).
  function combine(verdicts) {
    const list = (verdicts || []).filter(Boolean);
    if (!list.length) return none();
    const top = list.reduce((a, b) => (b.score > a.score ? b : a));
    const reasons = [...new Set(list.flatMap((v) => v.reasons || []))].slice(0, 6);
    return { ...top, reasons, level: levelOf(top.score) };
  }

  const api = { version: VERSION, scoreUrl, scorePage, combine };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseDetect = api;
})(typeof self !== "undefined" ? self : this);
