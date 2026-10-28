# Server detection (`backend/detection/`)

Implements the server half of `docs/DETECTION-CONTRACT.md`: `score_domain(domain, signals=None)` and `combine(verdicts)`.
Pure Python standard library, no network, deterministic. `ai.heuristics.phishing_signals` is a thin wrapper over it.
Detection only supplies evidence. The policy engine still decides, and parent rules and admin-verified sites still outrank it.

## How a domain is scored

1. **Names** (`names.py`): the host is split with an embedded subset of the public-suffix list (`sbi.co.in` has the label `sbi`,
   not `co`), punycode (`xn--`) is decoded, and a "skeleton" fold maps Unicode and digit look-alikes to the Latin letter they
   imitate (Cyrillic `а`, `0`/`o`, `1`/`l`/`i`, `rn`/`m`, `vv`/`w`, accents, full-width forms).
2. **Official domains** (`data.OFFICIAL`) return score 0 before anything else. Free hosts and user-content domains
   (`github.io`, `amazonaws.com`, ...) are deliberately never official. `google.*` style entries accept ordinary country suffixes only.
3. **Brand evidence** on the registrable label (`score.py`), strongest wins:
   look-alike skeleton equals a brand; the real brand domain used as a subdomain (`paypal.com.evil.xyz`); brand plus login/payment
   words (combosquat, found by segmenting the label into brand and term pieces, hyphens or not); brand split by hyphens;
   brand inside a longer word (long, distinctive names only); the brand's label on a suffix it does not own; and
   misspellings (`typo.py`): bounded Damerau-Levenshtein (insert, delete, substitute, swap) found through a SymSpell-style
   deletion index, with the kind of slip (swap, doubled letter, neighbouring key, ...) setting the weight. Short brands
   (under five letters) are never fuzzy-matched; five-letter brands only for swaps, doubled letters and neighbouring keys.
   Ordinary words near a brand (`phase`, `venom`, `kodak`) are exempt.
4. **Other evidence**: login/payment words, abuse-heavy TLDs, hyphens, deep subdomain chains, mixed alphabets, plain IDN,
   and `dga.py`: a randomness score from character-bigram likelihood (model trained at import from an embedded word list),
   longest consonant run, digit share and letter/digit alternation. Labels under seven characters are never scored.
5. **Fusion** in log-odds: `P = sigmoid(PRIOR + sum of weights)` with `PRIOR = -3.9`. The weights are in `score.W`, each with
   a comment. No evidence at all is exactly 0.
6. **Page signals** (optional) only add: password field next to other suspicion, a brand named in the title on an unrelated
   domain, urgent account wording, a login form posting to another site, hidden frames, obfuscated inline script.

Reasons are short strings built from our own data (brand names and term words), never page text.

## Where it is used

* `site_service.to_site_info` sets `SiteInfo.lookalike` from `score_domain(domain)`; engine step 3b (`LOOKALIKE_WARN = 0.75`) is unchanged.
* `routes/child.py` raises that value with the page-aware score once the extension has sent signals.
* `ai/classifier.py` sends the compact verdict (`score, level, reasons, brand, official`) in the model prompt and stores it with the analysis.
* `ai_service.threat_context` uses the verdict's reasons and `official` for the warning page.

## Operations notes added with it

* `POLICY_CACHE_TTL` (seconds, default 10): flattened policies are cached per process and dropped at once on any commit in that
  process. Another worker can serve an older copy for at most this long.
* `RATELIMIT_SHARED=1`: the login, register, pairing, Google and disconnect limits, the per-family AI limit and the AI daily
  budget count in the `rate_counters` table (migration `a7c9e1b3d5f8`, row level security on) instead of per process. The hot
  per-device limits (`check`, `events`, `chat`) stay in process on purpose: a database write per page load is not worth it.
  Fixed windows: a burst can straddle two windows. If the database is unreachable the limiter falls back to the process count.
* `last_seen` on a device is written at most once a minute.

## Measuring

`python scripts/bench_detection.py` (from `backend/`) prints microseconds per call and precision/recall of the old heuristic and the
new scorer on `tests/detection_corpus.py`. All phishing-style names in that corpus were invented for the test.
