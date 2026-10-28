# Detection contract (v2)

Fixed interface between the four parallel work streams. Change it only by agreement; anything else may change freely.

| Stream | Owns | Branch |
|---|---|---|
| A. Server detection | `backend/ai/`, `backend/detection/` (new), `backend/policy/`, `backend/services/`, `backend/tests/` | `feat/detect-v2-backend` |
| B. Browser detection | `common/detect*.js` (+ its tests), `common/protections.js`, `common/sensitive.js`, `common/lib.js` | `feat/detect-v2-browser` |
| C. Extension build | `extension/` (except synced copies), `scripts/build_extension.js` (new), `scripts/e2e_*.js` | `feat/ext-optimized` |
| D. Local agent | `agent/` (new), `docs/LOCAL-AGENT.md` (new) | `feat/local-agent` |

Synced copies (`extension/lib.js`, `extension/protections.js`, ...) are generated: never hand-edit them, run `python scripts/sync_common.py`.

## Browser: `common/detect.js` (global `PraiseDetect`, or `module.exports` in Node)

Pure, no `chrome.*`, no network, no `fetch`, deterministic, synchronous. It must also run inside a Node process (the local agent loads it with `require`).

```
PraiseDetect.version                       // integer, bumped when scoring changes
PraiseDetect.scoreUrl(url, ctx?) -> Verdict
PraiseDetect.scorePage(signals, ctx?) -> Verdict
PraiseDetect.combine(verdicts[]) -> Verdict
```

`ctx` (all optional): `{ brands?: BrandList, official?: string[], now?: number }`. When absent, built-in lists are used.

`signals` for `scorePage` is the object `extractSignals` already produces (`title`, `description`, `text`, `has_password_field`, `form_count`) plus optional DOM-only extras: `form_actions: string[]` (absolute form action URLs), `external_script_hosts: string[]`, `hidden_iframes: number`, `inline_script_entropy: number`.

`Verdict`:

```
{
  score:   number,   // 0..1 probability-like phishing/scam risk
  level:   "none" | "low" | "medium" | "high",   // none <0.25, low <0.5, medium <0.75, high >=0.75
  reasons: string[], // short, human-readable, at most 6, no page text
  brand:   string | null,
  official:string | null,   // the real domain to suggest
  features: object   // numeric features, for tests and tuning; never sent anywhere
}
```

Rules: never raises on bad input (returns `score: 0, level: "none"`); official brand domains always score 0; a score only ever *adds* caution, it never overrides a parent rule or admin-verified site (the policy engine still decides).

## Server: `backend/detection/` (Python package)

```
detection.score_domain(domain, signals=None) -> dict   # same Verdict shape (snake_case keys identical)
detection.combine(verdicts) -> dict
```

`ai.heuristics.phishing_signals` stays as a thin wrapper over it so existing callers and tests keep working.

## Local agent: `agent/` (Node 20+, zero runtime dependencies)

Loopback only. Extension and tools talk to it over `http://127.0.0.1:<port>` with a per-install bearer token.

```
GET  /v1/health                       -> { ok, version, detect_version }
POST /v1/score   {url, signals?}      -> Verdict + { cached: bool }
POST /v1/decide  {url, signals?}      -> { action, reason, level, ...Verdict }   // offline policy + detect
POST /v1/sync                          -> { ok, policy_version }                 // pull /api/ext/policy-sync
```

It reuses `common/detect.js` and `common/lib.js` (no second implementation) and talks to the real API only through the existing device-token endpoints.

## Non-negotiables (from CLAUDE.md)

- The policy engine decides ALLOW/BLOCK; detection only supplies evidence.
- No secrets in git. No page text or browsing history in logs.
- Every new DB table enables row level security in its own migration.
- Tests pass before reporting done: `python -m pytest tests` in `backend/`, `node --test "tests/*.test.js"` in `common/`, `extension/`, `dashboard/`; `python scripts/sync_common.py --check` clean.
- Baseline at branch point: backend 260, common 101, extension 53, dashboard 23, all passing.
