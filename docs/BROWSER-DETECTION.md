# Browser detection and browser protections (stream B)

Everything here lives in `common/` and is copied into `extension/` by `python scripts/sync_common.py`. Nothing in it
calls `chrome.*`, touches the network, or stores anything. It runs in the service worker, in a content script and in
plain Node (the local agent `require`s it). The contract it implements is `docs/DETECTION-CONTRACT.md`.

## 1. `PraiseDetect` (`common/detect.js`)

```
PraiseDetect.version                        // 2
PraiseDetect.scoreUrl(url, ctx?)   -> Verdict
PraiseDetect.scorePage(signals, ctx?) -> Verdict
PraiseDetect.combine(verdicts[])   -> Verdict
PraiseDetect.extractDomSignals(document, location) -> signals      // extra, for content scripts
```

`Verdict = { score 0..1, level, reasons[<=6], brand, official, features }`. Levels: none < 0.25, low < 0.5,
medium < 0.75, high >= 0.75. Bad input (null, numbers, `javascript:`, 200 KB strings, broken URLs) returns
`score: 0, level: "none"`; nothing throws. Official brand domains (and the built-in list of popular sites) return exactly
`score: 0`, `brand` and `official` filled in, `features: { official: 1 }`.

`ctx` (all optional):

| key | meaning |
|---|---|
| `brands` | replaces the built-in brand list. Map `{ "acmebank": ["acmebank.com", ...] }`, or array of `{ name, names?: [alias], domains: [] }`. Cached per object identity, so reuse the same object. |
| `official` | array of extra domains that always score 0 (a parent's allow list, admin-verified sites). Cached per array identity. |
| `url`, `host` | `scorePage` only: the page address, when `signals.url` is not set. |
| `now` | accepted and ignored (scoring is deterministic). |

`signals` for `scorePage` are the contract's: `title, description, text, has_password_field, form_count` plus the DOM
extras `form_actions[], external_script_hosts[], hidden_iframes, inline_script_entropy`. **One addition to the contract:
an optional `url` (or `host`).** Without it the host-dependent checks are skipped (form posts to another site, password on
http, brand in the title that does not match the site, and the "official host scores 0" rule). Always pass it.

### What `scoreUrl` looks at

* Public-suffix-aware host split (embedded subset: country registries plus free hosts such as `github.io`, `pages.dev`,
  `netlify.app`, which are treated like suffixes, as the real list does).
* Punycode (`xn--`) decoding, a confusable fold ("skeleton": Cyrillic/Greek look-alikes, `0 1 3 4 5 7` for letters,
  `rn -> m`, `vv -> w`, `cl -> d`, `i = l = 1`), and mixed-script detection (Latin + Cyrillic/Greek/Armenian in one label).
* Brand imitation against about 110 brands (global plus India: banks, UPI, IRCTC, Aadhaar, income tax, shops, telcos):
  exact name on an unofficial domain, homoglyph, typo (Damerau-Levenshtein <= 1 for names of 6 to 8 letters, <= 2 from
  9 letters; neighbouring-key and swapped-letter slips score a little higher), combosquatting (`paypal-support.com`,
  `paypalsecure.com`; short names such as `sbi`, `dhl` count only as a whole hyphen-separated word), brand in a
  sub-domain (`paypal.evil.xyz`, `paypal.com.evil.xyz`), brand before an `@`, brand in the path.
  Names under 5 letters never match fuzzily, and a brand inside an ordinary word (`applebees`, `purchasechase`) is ignored
  unless the rest of the word is a login/payment word.
* URL shape: raw IP host, `user@` section, odd port, many sub-domains, hyphens, digits, very long address/host,
  percent-encoding, `?url=http...` redirect parameter, http, suspicious/weak TLDs, free hosts, link shorteners, login words.
* Random-looking names (consonant runs, rare letter pairs, vowel and digit ratios, hex-like names, with a "is it made of
  real words" check that cancels the score for names such as `northwindtraders`).

### What `scorePage` looks at

Password field, where forms post (other site / http / raw IP / free host / `mailto:`), a brand named in the title or
description that is not the site (stronger with a password field), pressure wording from a fixed lexicon in five groups
(urgency, threats, asking for card/OTP/KYC/ID, prizes, fake tech support), hidden frames, number of foreign script
hosts, and the entropy of inline script. `reasons` are fixed sentences, never page text.

### Fusion and weights

`score = sigmoid(PRIOR + sum of weights)`, `PRIOR = -4.0` (a site with no evidence is 1.8%). Only the strongest brand-imitation
signal counts (they overlap); everything else adds. All weights are in `PraiseDetect.WEIGHTS`:

| evidence | log-odds | | evidence | log-odds |
|---|---|---|---|---|
| homoglyph / mixed script | +6.0 each | | IP-number host | +3.0 (+0.8 login word in path) |
| typo, 1 edit / 2 edits | +4.8 / +3.8 | | `user@` in address | +3.0 |
| exact brand name, gTLD / ccTLD | +4.4 / +2.2 | | suspicious TLD / weak TLD | +1.2 / +0.5 |
| brand + words (combo) | +4.4 (short name +2.6) | | login words in name: 1 / 2 / 3 / 4+ | +0.4 / 1.4 / 2.2 / 2.8 |
| brand embedded in a word | +3.6 | | 3+ hyphens / 2 hyphens | +1.4 / +0.5 |
| brand in sub-domain | +4.6 (+0.9 `.com.` trick) | | random-looking name | +1.0 .. +4.5 |
| brand in path | +1.4 (+0.8 with a login word) | | password sent to another site | +2.2 |
| brand + a login word | +0.6 | | brand in title + password field | +2.8 (+0.5 without password) |
| free host / shortener | +0.6 / +0.6 | | pressure wording | up to +3.5 |

`combine(verdicts)` adds the evidence of each verdict (`logit(score) - PRIOR`, never negative), strongest first, each next
one damped by 0.75. Verdicts that carry only a `score` (for example from the server) are accepted. If any verdict is an
official one, the result is official with score 0. The brand/official suggestion comes from the strongest verdict that has one.

### Accuracy on the test corpus

`common/tests/detect.test.js`: 133 legitimate URLs (33 official brand sites, 41 ordinary or tricky sites, 59 real sites that
were not used for tuning) and 69 invented phishing URLs. Results: at the 0.5 (medium) line precision 1.00 and recall 0.986; at 0.25
recall 1.00 with 0 false positives (highest legitimate score 0.063); 72% of the phishing set reaches `high`.
This is a corpus I wrote while tuning, so the numbers are optimistic. Known weak spots: keyword-only domains
(`upi-refund-status.icu` reaches only `low`), a brand legitimately used in a hyphenated name (`amazon-rainforest-tours.com`
would be flagged), brands missing from the list. `chasebank.com`, which exists, scores `low`.

### Benchmark

`node common/bench/detect.bench.js` (Node 22, Windows 11; every URL distinct; the figures include about 1-2 us of timer
overhead per call). Building the indexes takes about 2 ms, once.

| call | median | p95 |
|---|---|---|
| `scoreUrl`, mix of one third phishing | 13 us | 41 us |
| `scoreUrl`, ordinary sites only | 12 us | 41 us |
| `scoreUrl`, phishing only | 15 us | 50 us |
| `scorePage` | 7 - 24 us (varies run to run) | 28 us |
| `combine` (2 verdicts) | 0.4 - 0.9 us | 4 us |

### Wiring (for the extension, stream C)

Load order in the service worker: `importScripts("lib.js", "detect.js", "protections.js")`; add `detect.js` to the content
script list when the page check runs there. Exact calls:

```js
const D = self.PraiseDetect;

// 1. Address only, before the page loads (service worker, on navigation):
const urlVerdict = D.scoreUrl(url, { official: parentAllowList });       // ctx optional
if (urlVerdict.level !== "none") { /* show warning, report, ask the server */ }

// 2. Page evidence (content script, after load). Everything stays on the device:
const signals = D.extractDomSignals(document, location);                  // title, text, forms, hidden frames ...
const pageVerdict = D.scorePage(signals);                                  // signals.url is filled in for you

// 3. Together, then hand it to the policy engine / server as evidence:
const verdict = D.combine([urlVerdict, pageVerdict]);
// In the service worker, for HTML fetched by background.js's fetchSignals():
//   D.scorePage({ ...extractSignals(html), url })
```

A verdict is evidence, never a decision: do not turn `level` into ALLOW/BLOCK on the client. For the local agent use
the same three functions (`require("../common/detect.js")`).

## 2. Lookups: `common/lib.js`

`domainMatches(domain, rules)` used to build a `Set` from the rule array on every call. Now:

* `compileRules(list)` returns a `Set` once per array (cached by identity; rebuilt when the length changes). A `Set` passes through.
* `domainMatches(domain, rulesOrSet)` accepts either, and walks the sub-domain chain without allocating arrays.
* `offlineDecision(domain, snap)` uses sets cached per snapshot object (a `WeakMap`), built lazily list by list; a caller can
  supply `snap.compiled = compileSnapshot(snap)` to keep them across snapshot objects. Replaced or grown lists are noticed.
  Note: `background.js` reads a fresh snapshot from storage on every call, so it only profits if it keeps the object (or a
  `compileSnapshot` result) around.

## 3. Browser protections (`common/protections.js`, `scripts/build_rules.js`)

`PraiseRules.techniqueOptions(policySettings)` turns the settings into flat switches
(`TECHNIQUE_DEFAULTS`); the older `privacy.*` flags keep their meaning (`strip_tracking_params`; `block_fingerprinting` is the
master switch of page hardening), and the newer ones come from an optional `settings.techniques` group (not part of
`DEFAULTS`, so the server schema is untouched).

| technique | switch | default | how |
|---|---|---|---|
| Tracking-parameter stripping | `strip_params` | on | `queryTransform.removeParams`, 67 names (utm_*, fbclid, gclid, msclkid, mc_eid, igshid, _hsenc, _gl, mkt_tok ...) in small-regex rules, ids 1..9 |
| Global Privacy Control | `send_gpc` | on | `modifyHeaders` `Sec-GPC: 1` (id 100) + page-world `navigator.globalPrivacyControl` |
| Do Not Track | `send_dnt` | off | `modifyHeaders` `DNT: 1` (id 101); off because it is one more bit for fingerprinting |
| Referrer trimming | `trim_referrer` | on | `Referer` removed on third-party requests to tracking hosts (id 110) |
| Referrer trimming, links | `harden.referrer` | on | page-world: pages that set `unsafe-url`/`no-referrer-when-downgrade` via `<meta>` get `strict-origin-when-cross-origin` on outbound links; never overrides a page's own `referrerpolicy` |
| HTTPS upgrade | `https_upgrade` (+ `https_upgrade_exceptions[]`) | **off** | `upgradeScheme` for http main-frame navigations (id 200), `allow` rules at higher priority for IPs, IPv6, single-label hosts, local suffixes, explicit ports, captive-portal hosts and the caller's list (ids 201-211). Off because DNR has no fallback to http when a site has no https |
| Tracker and fingerprint-script blocking | existing `block_trackers`, `block_fingerprinting` | on | static rulesets `trackers` (97 domains) and `fingerprint` (25), third-party only, never `main_frame` |
| Canvas / WebGL / audio read noise | `harden.canvas`, `.webgl`, `.audio` | on | about 1 pixel in 64 flips its lowest bit (seeded per page load, stable within it); audio samples +-1e-7; canvases under 256 px are untouched |
| Core / memory / plug-in coarsening | `harden.hardware`, `.plugins` | on | cores 16/12 -> 8, 6 -> 4, 3 -> 2; memory capped at 4; plug-ins other than the standard PDF viewers hidden |
| WebRTC local-IP guard | `harden.webrtc` | **off** | drops `icecandidate` events that expose a raw private address (candidates with `.local` names pass); may affect same-LAN calls |

Rule ids are fixed (`PraiseRules.RULE_IDS`; 1-99 parameters, 100-119 headers, 200-219 upgrade) so the extension never has to
remember what it installed:

```js
const R = self.PraiseRules;
const opts = R.techniqueOptions(settings);                       // flat switches
const { rules, removeRuleIds } = R.buildDynamicRules(opts);      // always replace the whole reserved range
await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
```

`R.checkRules(rules, "dynamic"|"static")` returns a list of problems (duplicate ids, rule/regex counts against Chrome's limits of
30,000 dynamic and 1,000 regex rules, regexes over 512 characters, unknown types, domains, a `block` on `main_frame`); the
build script and the tests run it. Currently the whole set is about 20 rules.

Static alternatives: `node scripts/build_rules.js` also writes `extension/rules/{strip_params,gpc,dnt,referrer,https_upgrade}.json`
(same rules, same ids) so they can be switched with `updateEnabledRulesets`; they are not in the manifest yet (that is the
extension build's file). `extension/harden-main.js` is the generated page-world script with all default techniques; for other
switches use `R.hardeningSource({ canvas: true, webrtc: true, ... })`, write it to a file and register it:

```js
chrome.scripting.registerContentScripts([{ id: "praise-harden", js: ["harden-main.js"], matches: ["http://*/*", "https://*/*"],
  runAt: "document_start", world: "MAIN", allFrames: true, matchOriginAsFallback: true }]);
```

Changes to existing lists: tracker list grew from 46 to 97 hosts (ad verification, exchanges, session replay, product
analytics); fingerprint list is identity-graph vendors only. `iovation.com` and `online-metrix.net` (device-risk scripts
that banks load) moved out to `FRAUD_SCRIPT_DOMAINS` and are no longer blocked, because blocking them can fail sign-ins.

### Not verified

No real Chrome was used. The rule shapes follow the documented declarativeNetRequest schema and pass `checkRules`, but
whether Chrome accepts `modifyHeaders` for `Sec-GPC` and for removing `referer`, and the exact behaviour of `allow` versus
`upgradeScheme` priorities, should be confirmed with the e2e scripts. The page-world code is tested against stubs only.
