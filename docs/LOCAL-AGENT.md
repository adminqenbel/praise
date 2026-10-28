# Praise local agent

A small on-device service (`agent/`, Node 20+, no runtime dependencies) that answers "is this URL risky, and what should happen to it?" in well under a millisecond, using the same policy rules and the same detector the extension uses, so the extension and other local tools can ask it instead of making a network call. It keeps working offline from the last policy it synced.

It is a companion, not a replacement: the Praise server (`/api/ext/check`) remains the only place that can run the AI classifier and learn about brand-new sites. The agent decides what the policy snapshot and the shared heuristics can decide, and fails closed otherwise (family) or follows the account's default (adult).

Contract: `docs/DETECTION-CONTRACT.md` (section "Local agent"). Code: `agent/src/`. Tests: `node --test "agent/tests/*.test.js"` (91). Benchmark: `node agent/bench/bench.js`.

## Architecture

```
extension / local tool ──HTTP, 127.0.0.1, Bearer──▶ http.js ──▶ engine.js ──▶ cache (LRU+TTL, coalescing)
                                                       │            ├─▶ policy.js   compiled Set indexes (rebuilt only on sync)
                                                       │            └─▶ common/detect.js   (the one shared detector)
                                                       ├─▶ sync.js    GET /api/ext/policy-sync  (device token, ETag, backoff)  ──▶ Praise API
                                                       └─▶ events.js  POST /api/ext/events (optional, off by default)
state on disk: policy.json, cache.json (atomic writes, versioned schema)    config dir: config.json, agent-token, device-token
```

| File | Job |
|---|---|
| `src/server.js` | Entry point, wiring, graceful shutdown. `createAgent()` takes injected parts (detector, fetch, clock) for tests and the benchmark |
| `src/http.js` | Every request check (Host, Origin, token, rate limits, content type, size, validation) and routing |
| `src/engine.js` | `score`, `decide`, `scoreBatch`; caches; the rule "detection may only add caution" |
| `src/policy.js` | Validates and normalises the synced snapshot, compiles suffix-walk Set indexes, computes a content version |
| `src/cache.js` | `TtlLruCache` (count and byte bounded, TTL per entry, pre-serialised bodies) and `Coalescer` |
| `src/sync.js` | Pull, ETag, 401 handling, exponential backoff with jitter, persisted snapshot |
| `src/events.js` | Bounded, validated event queue uploaded in batches |
| `src/secrets.js`, `src/store.js` | Owner-only files, atomic writes, tolerant readers |
| `src/cli.js` | `configure`, `status`, `token`, `rotate-token`, `unpair`, `run` |

### Decision order (`/v1/decide`)

Mirrors `PraiseLib.offlineDecision` (tests compare the compiled index with it on a randomised corpus):

1. exception (ALLOW), 2. parent block, 3. parent allow, 4. verified block / allow / warn, 5. blocked TLD, 6. unknown-site default.

Only at step 6 does detection act, and only upward: score >= `block_at` (0.75, level high) turns the answer into BLOCK; score >= `warn_at` (0.5, level medium, or lower if the snapshot's `settings.safe_browsing.warn_above_risk` is set) turns ALLOW into WARN. Parent rules, verified sites and TLD blocks are final and the detector is not even called for them.

Mode comes from the snapshot's `mode`. Family (and any snapshot whose mode is not exactly `adult`): unclear stays closed, so step 6 is always BLOCK and the detector is skipped. Adult: step 6 is the snapshot's `unknown_action` (ALLOW or WARN; anything else is BLOCK). No snapshot at all: `BLOCK` with reason `offline-no-policy`, never cached, so the first successful sync takes effect immediately. Non-websites (other schemes, IP literals, single-label hosts) are `ALLOW` / `not-a-website`, exactly as `extension/background.js` treats them.

## API

All endpoints require `Authorization: Bearer <agent token>`, bodies are `application/json` only (max 64 KB), unknown fields are rejected. Errors are `{"error": "<code>"}` (plus a short `detail` naming the invalid field, never its value).

| Endpoint | Request | Response |
|---|---|---|
| `GET /v1/health` | | `{ok, version, detect_version, policy:{loaded, version, mode, last_sync, revoked, offline, paired}, cache:{...}}` |
| `POST /v1/score` | `{url, signals?}` | Verdict `{score, level, reasons, brand, official, features}` + `cached` |
| `POST /v1/decide` | `{url, signals?}` | `{action, reason, source, can_continue, cache_ttl, ...Verdict, cached}`, plus `degraded:true` if the detector failed and only policy answered |
| `POST /v1/score-batch` | `{urls:[...]}` (1..100) | `{results:[Verdict+cached or {error}, ...]}` |
| `POST /v1/sync` | `{}` or empty | `{ok, policy_version, changed}`; 409 `not_configured` when unpaired; 502 with `error` (`network`, `timeout`, `revoked`, `http_5xx`, `bad_payload`) |
| `POST /v1/events` | `{events:[{kind, data}]}` (1..100) | 202 `{accepted, rejected}`; 409 `events_disabled` unless `forward_events` is on |

Notes:

- `signals` is the object `extractSignals` produces, with the optional DOM extras from the contract; every field is type- and size-checked and rebuilt field by field before it reaches the detector.
- The contract writes the decide response as `{action, reason, level, ...Verdict}`, and `Verdict` also has `level`. The agent follows the spread: `level` is the Verdict level (`none|low|medium|high`). The policy tier that decided is reported separately as `source`: `parent | verified | tld | default | detection | none`.
- `features` is filtered to at most 64 numeric entries. Page text never appears in a response or in the cache.
- Status codes: 400 invalid, 401 bad token, 403 bad Host/Origin, 404/405 route, 413 too large, 415 wrong content type, 429 rate limited (with `Retry-After`), 500 `{"error":"internal"}`, 503 `detect_failed` (score only).

## Security model

Assume any process on the machine, and any web page in any browser, can send bytes to `127.0.0.1:<port>`.

| Threat | Defence |
|---|---|
| Another machine reaches the port | Binds `127.0.0.1` only (IPv4 loopback); tested |
| Web page in the user's browser calls the agent (CSRF) | Any `Origin` header not in the allowlist is rejected (default allowlist is empty; entries must match `chrome-extension://<32 letters a-p>`); JSON-only content type forces a preflight for cross-origin callers; `Sec-Fetch-Site: cross-site` without Origin is rejected; the bearer token cannot be attached by a page without a CORS preflight, which is refused |
| DNS rebinding (evil.example resolves to 127.0.0.1) | `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` |
| Token guessing / timing | 256-bit random token (`crypto.randomBytes`), compared as SHA-256 digests with `crypto.timingSafeEqual`; failed attempts draw from a small separate rate budget (429) so guessing is throttled and cannot starve real callers |
| Flooding | Per-connection and global token buckets, max 64 connections, header timeout 5 s, request timeout 10 s, 8 KB headers, 64 KB bodies (checked up front and while streaming), batch cap 100, bounded caches |
| Malformed or hostile input | Strict schema validation, unknown fields rejected, control characters rejected, detector output re-validated and truncated to a fixed shape |
| Information leaks | Fixed error bodies (no stack traces or messages), no URLs, page text or tokens in logs, domains only at `debug` level (off), `Cache-Control: no-store`, the cache file holds HMAC'd keys and verdicts only (no URLs) |
| Token theft from disk | Token files `0600` in a `0700` directory (POSIX); on Windows the directory and files get an ACL reset to the current user via `icacls` (verified on the build machine). The agent token and the Praise API device token are separate files; the device token is never logged, echoed, put on argv, or sent anywhere except the configured API origin |
| Token sent to the wrong server | API origin must be `https` (plain `http` only for localhost development); redirects are refused; response size capped at 8 MB |
| Bad sync data | Payload must look like a policy; lists are cleaned, bounded (50k each) and normalised before use; a failed or malformed pull never replaces a good snapshot |
| Corrupt or stale state | Versioned schema; unreadable, truncated or wrong-version files are ignored (family fails closed until the next sync); a cache from another policy or detector version is dropped |

Deliberately not done: TLS on the loopback listener (a certificate the extension would have to trust adds more risk than it removes for same-machine traffic); per-process authentication (the OS offers no portable way; the token is the boundary); an unauthenticated `/health` (everything needs the token, so a web page cannot even probe that the agent exists).

## Persistence

`policy.json` stores the normalised snapshot, its ETag and fetch time; `cache.json` stores up to 2000 recent positive results. Both are written to a temp file in the same directory (exclusive create, mode 0600, fsync) and renamed over the target, with a `schema` field. The snapshot is loaded at start; the cache is loaded right after the listener is up and consulted lazily on misses. The cache is written at shutdown and every 10 minutes. Cache keys are HMAC-SHA256 of the URL under a key derived from the agent token, so the file contains no URLs and rotating the token invalidates it.

## Sync

`GET {api}/api/ext/policy-sync` with `Authorization: Bearer <device token>`, `If-None-Match` when an ETag is known (the current backend sends none, so the agent also compares a content hash and keeps its decision cache when nothing changed). First pull at start, then every 10 minutes +-20%. Failures back off with equal-jitter exponential delay (5 s base, 15 min cap), honouring `Retry-After`. A 401/403 marks the device token revoked, keeps enforcing the last snapshot and retries hourly. Not paired: polls the config every 30 s so `configure` takes effect without a restart. `POST /v1/sync` forces a pull; concurrent calls share one request and calls closer than 2 s reuse the last result. A new policy version clears the decision cache.

## Configuration and paths

| | Config dir (`config.json`, `agent-token`, `device-token`) | State dir (`policy.json`, `cache.json`, `runtime.json`) |
|---|---|---|
| Windows | `%APPDATA%\Praise\agent` | `%LOCALAPPDATA%\Praise\agent` |
| macOS | `~/Library/Application Support/Praise/agent` | `.../agent/state` |
| Linux | `$XDG_CONFIG_HOME/praise-agent` (default `~/.config/praise-agent`) | `$XDG_STATE_HOME/praise-agent` (default `~/.local/state/praise-agent`) |

`PRAISE_AGENT_HOME=<dir>` puts everything under one directory (portable installs, tests).

`config.json` keys (all optional; invalid values fall back to defaults): `port` (47615), `api` (`https://api.praise.qenbel.site`), `allowed_origins` ([]), `log_level` (`info`), `forward_events` (false), and tuning groups `sync`, `events`, `limits`, `cache` (`ttl_s` defaults ALLOW 3600, BLOCK 3600, WARN 600, the server's values), `detect` (`warn_at` 0.5, `block_at` 0.75). See `agent/src/config.js`.

CLI (run from `agent/`):

```
node src/cli.js configure --api https://api.praise.qenbel.site --token-file ./device-token.txt [--allow-origin chrome-extension://<id>] [--port N]
node src/cli.js configure --api ... --token-stdin          # token piped in; "--token <value>" is refused on purpose
node src/cli.js token            # print the agent bearer token (for the extension / tools)
node src/cli.js rotate-token     # new agent token; restart the agent afterwards
node src/cli.js status           # paths, paired?, saved policy, running agent and live policy version; prints no secrets
node src/cli.js unpair           # forget the device token
node src/server.js               # run (npm start)
```

Where the device token comes from: the pairing flow (`/api/devices/pair`) returns it once. Today only the extension performs pairing; until a pairing helper exists, a developer has to put the token in a file by hand (see "Required changes elsewhere").

## Calling the agent from the extension

```js
const AGENT = "http://127.0.0.1:47615";        // port is configurable; keep it in one constant
async function agentDecide(url, signals) {     // returns null on any failure: the caller falls back to /api/ext/check
  const { agentToken } = await chrome.storage.local.get("agentToken");
  if (!agentToken) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 150);      // local call: fail fast
  try {
    const res = await fetch(AGENT + "/v1/decide", {
      method: "POST",
      headers: { Authorization: "Bearer " + agentToken, "Content-Type": "application/json" },
      body: JSON.stringify(signals ? { url, signals } : { url }),
      signal: ctl.signal, credentials: "omit",
    });
    return res.ok ? await res.json() : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
```

Suggested use in `resolve()`: ask the agent first; if it answers with `reason !== "offline-no-policy"`, use it (map `cache_ttl` to the extension cache); otherwise continue with the existing `/api/ext/check` call. Keep the adult-mode rule of sending only the origin (`new URL(url).origin + "/"`) to the agent too. Paste the token printed by `node src/cli.js token` into the extension once.

## Required changes elsewhere (not applied; owned by other streams)

1. **Extension manifest / permissions.** The current `host_permissions` (`http://*/*`) already match `http://127.0.0.1:<any port>/`, so no manifest change is needed while that stays. If the extension build narrows host permissions, add `"http://127.0.0.1/*"` (match patterns ignore ports). No `connect-src` change: MV3 service workers have no page CSP for this.
2. **Extension origin allowlist.** The agent rejects any request carrying an `Origin` header that is not configured, and Chrome sends `chrome-extension://<id>` from the service worker. Run `node src/cli.js configure --allow-origin chrome-extension://<id>` once. A stable id needs a `key` in the manifest (otherwise unpacked builds get a different id per machine).
3. **Extension: store the agent token and call the agent** (snippet above; popup field or paste step, `storage.local` key `agentToken`; never sync it to `storage.sync`).
4. **Pairing the agent.** There is no way to obtain a second device token without a pairing code. Needed: a dashboard action "Pair local agent" that creates a device and shows its token once (or a `/api/devices/pair` option), or an extension popup action that exports its own token for `configure --token-file`. Until then the agent can be given the extension's device token by hand (it is the same kind of token), which means the server sees agent and extension as one device.
5. **Backend: ETag / version on `/api/ext/policy-sync`.** Cheap and lets 304 skip the payload. The agent already sends `If-None-Match` and handles 304; without it, it compares a content hash.
6. **Offline semantics in `common/lib.js`.** `offlineDecision` lets a family snapshot's `unknown_action: ALLOW` through. The agent forces BLOCK for any non-adult snapshot (per the task statement). Consider the same rule in `offlineDecision` (or a `mode` argument) so extension and agent cannot disagree.
7. **Contract wording.** `decide` returns `{action, reason, level, ...Verdict}` with two meanings of `level`; the agent chose the Verdict level and added `source` (see API notes). Worth one line in `docs/DETECTION-CONTRACT.md`.
8. **Detector path.** The agent `require`s `../../common/detect.js` and `../../common/lib.js` relative to the repo. Packaging the agent outside the repo needs those two files copied alongside (or `scripts/sync_common.py` extended to copy them into `agent/vendor/`).

## Start at login (no admin rights)

Prerequisite: Node 20+ on the user's PATH, and `node src/cli.js configure ...` already done. Replace `<REPO>` with the checkout path. These are untested on this build machine except where noted.

**Windows.** Startup folder, per-user, no elevation: press Win+R, `shell:startup`, and create `praise-agent.vbs` there:

```
CreateObject("Wscript.Shell").Run """C:\Program Files\nodejs\node.exe"" ""<REPO>\agent\src\server.js""", 0, False
```

(window style 0 = hidden). Task Scheduler alternative: `schtasks /Create /TN PraiseAgent /SC ONLOGON /TR "\"C:\Program Files\nodejs\node.exe\" \"<REPO>\agent\src\server.js\""`; some Windows configurations require elevation for logon triggers, which is why the Startup folder is the default recommendation. Stop it with `Stop-Process -Name node` (or Task Manager); the agent handles Ctrl+C / SIGBREAK gracefully.

**macOS.** `~/Library/LaunchAgents/site.qenbel.praise.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>site.qenbel.praise.agent</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string><REPO>/agent/src/server.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

Then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/site.qenbel.praise.agent.plist`. Remove with `launchctl bootout gui/$(id -u)/site.qenbel.praise.agent`.

**Linux.** `~/.config/systemd/user/praise-agent.service`:

```
[Unit]
Description=Praise local agent
[Service]
ExecStart=/usr/bin/node <REPO>/agent/src/server.js
Restart=on-failure
[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now praise-agent`. It starts at login; running without a login session needs `loginctl enable-linger`, which may need admin rights.

## Performance

Measured with `node agent/bench/bench.js` (Node 22.23.4, Windows 11, i7-12650H, detector = the repo stub, so miss rows exclude real detection cost; each row ran in a fresh server and client process; raw-socket keep-alive client, 16 connections for the concurrent rows; the bare-Node row is a constant-reply `http` server as the floor on the same machine):

| Scenario | req/s | p50 | p95 | p99 |
|---|---|---|---|---|
| bare Node `http` (reference) | 20,200 | 43 us | 78 us | 136 us |
| `/v1/score` cache hit, 1 connection | 14,550 | 59 us | 117 us | 185 us |
| `/v1/decide` cache hit, 1 connection | 15,350 | 57 us | 100 us | 182 us |
| `/v1/decide` parent-rule domain, 1 connection | 15,100 | 58 us | 104 us | 175 us |
| `/v1/decide` miss (unique URL, stub detector) | 12,200 | 69 us | 142 us | 232 us |
| `/v1/score-batch` 100 hits | 7,400 req/s (741k URLs/s) | 120 us | 228 us | 311 us |
| `/v1/score` hit, 16 connections | 29,000 | 516 us | 789 us | 1.0 ms |
| `/v1/decide` hit, 16 connections | 29,000 | 515 us | 778 us | 1.0 ms |

The hot path for a hit is: header checks, one SHA-256 + `timingSafeEqual`, `JSON.parse` of a small body, one `Map` lookup, one string concatenation. Concurrent rows are closed-loop, so their latency is queueing delay on one core. A hybrid-core Windows laptop was seen to slow a process after a burst (a plain Node server in the same test slowed ~4x too), which is why the benchmark uses fresh processes; absolute numbers will differ on other machines.

## Honest limitations

- The agent protects only what asks it. A browser without the extension, a different profile, another app, or a child who stops the process is not covered. A user with admin rights on their own machine can stop or replace it; for families, managed installation is still the enforcement story (see `HANDOFF.md`).
- Same-user trust boundary: any process running as the same OS user can read the token files and call the agent. The defences above are against the network, web pages and other users, not against malware running as you.
- Port squatting: a hostile process that binds the port before the agent starts would see (and could answer) requests carrying the bearer token. Clients should not send the token to anything but a loopback address they trust; there is no mutual authentication.
- Detection quality is whatever `common/detect.js` provides; at branch point that file is a stub that scores everything 0, so today `decide` is the policy snapshot alone. The agent cannot run the AI classifier or consult the shared site database beyond the verified lists in the snapshot.
- In family mode an unknown site is blocked until the parent's server-side flow (or a verified list) says otherwise; the agent has no "ask a parent" path. With no snapshot, everything that looks like a website is blocked, adult accounts included, until the first successful sync.
- IP literals, `localhost` and single-label hosts are allowed (`not-a-website`), matching the extension's behaviour today.
- The event queue is in memory only; events not yet uploaded are lost if the process is killed without a graceful shutdown.
- Not verified on macOS or Linux: file-mode behaviour, the launchd and systemd snippets and the XDG paths are implemented and unit-tested for path resolution only.
