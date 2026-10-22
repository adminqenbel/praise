# Praise Shield: the adult version (design plan)

Three versions will exist:

| | Child version | Family version | **Adult version (new)** |
|---|---|---|---|
| Who it protects | A child's browser | The family (parent's dashboard) | **One adult, themselves** |
| Who is in control | Parent | Parent | **The adult** |
| Extension | `extension/` (Praise), family mode | same dashboard | `extension/` (Praise), personal mode, called Praise Shield. It is one extension: the pairing code decides which |
| Unknown or risky site | Closed, child can ask | Parent's rule decides | **Warned, with a clear reason; adult can continue** |
| Focus | Content and money rules | Rules, review, approvals | **Scams, trackers, cookies, sensitive data, passwords** |

Same backend, same site database, same dashboard login. An account is either `family` or `adult`.

## What the adult gets

1. **Safe browsing:** malware, phishing and scam pages. A warning page says why, offers "Go back", and for look-alike pages offers the real site ("This imitates hdfcbank.com").
2. **Cookie protection:** trackers removed, optional third-party blocking, a per-site cookie panel in the popup, "clear this site's cookies", and an option to clear tracking cookies when a tab closes.
3. **Tracker and fingerprinting blocking:** network-level blocking of known trackers and fingerprinting scripts, tracking parameters removed from links (`utm_*`, `fbclid`, `gclid`…), and a per-site privacy report.
4. **Warn before sharing sensitive data:** card numbers, government IDs, one-time codes and passwords typed into a risky site, a look-alike, an unencrypted page, or a form that posts to a different domain. Detection runs on the device and field values never leave it.
5. **Password and breach safety:** checks a password against known breaches without sending it (k-anonymity), and warns when the same password is used on several sites (opt-in, stored only on the device).

## Architecture decisions

- **One person = one "self" profile.** Reuse `children`, `devices`, `policies`, events and stats by adding `children.kind` (`child` | `self`) and `users.account_type`. No parallel tables.
- **New action `WARN`** in the policy engine, between ALLOW and BLOCK. WARN carries a reason and `can_continue`. Hard threats (known malware) stay BLOCK. Continuing is logged as a security event and remembered per site for one hour.
- **New category `scam`**, plus deterministic scam heuristics (urgency and prize language, tech-support phrases, fee-for-delivery, look-alike brands). Heuristics feed the AI prompt and the score, as the phishing heuristics do today.
- **Reputation feeds** populate the existing `site_reputation` table through a `flask import-feed` command. Candidates: URLhaus and OpenPhish. Availability and terms must be confirmed before shipping.
- **Adult presets:** `shield_balanced`, `shield_strict`, `shield_minimal`. Unknown sites default to ALLOW (with a warning only on real risk signals) instead of the family version's BLOCK.
- **Settings schema** (validated server-side like the family one): `privacy` (tracker blocking, parameter stripping, fingerprinting), `sensitive_data` (cards, ids, otp, passwords, risky forms), `passwords` (breach check, reuse check), `cookies` (existing plus `clear_on_close`).
- **Shared code:** `common/` holds `lib.js` and `protections.js`. A `scripts/sync_common.py` copies them into `extension/`, because an extension can only load files inside its own folder. Tests run once on `common/`.
- **Sign-in:** pairing code from the dashboard ("My browsers"), same as the family version, for v1.

## Shield extension

> Update: the separate `shield/` folder described below was merged into `extension/`. It is now one extension that stays neutral until a pairing code is accepted and then becomes the family or the personal (Shield) version, depending on the account that issued the code. The behaviour described here is the personal mode. See the README, "One extension, two versions".

- Popup is the main surface: protection status, the current site (trust level, cookies, trackers stopped), quick toggles, **pause for 1 hour / until tomorrow**.
- `declarativeNetRequest` static ruleset for trackers and fingerprinting, plus a dynamic rule for stripping parameters.
- Content script for the sensitive-data guard (runs on all pages, so `<all_urls>` is requested and justified in the README).
- Warning page (`warn/warn.html`) in the glass style, with the plain-language reason.
- Password checks use WebCrypto SHA-1 and the Pwned Passwords range API with `Add-Padding`.

## Privacy rules (non-negotiable)

- Field values, passwords and cookie values never leave the device or enter logs.
- The password-reuse store is opt-in, salted and slow-hashed, on-device only, and clearable in one click.
- The only third-party call is the breach range query, and it is explained in the UI and can be turned off.
- Adult events follow the same 90-day expiry. The adult can delete their history from the dashboard.

## Milestones

| | Work | Done when |
|---|---|---|
| **A0** | `account_type`, profile `kind`, `WARN` action, `scam` category, shield presets and settings schema, `/check` returns WARN and `can_continue`, bypass logging | engine and API tests pass |
| **A1** | `shield/` skeleton: pairing, navigation check, warning page, popup with pause, scam heuristics | a risky test page shows the warning; "Continue" works and is logged |
| **A2** | Cookie panel, clear site cookies, clear on close; tracker ruleset, parameter stripping, per-site report | tracking parameters removed; trackers counted per site |
| **A3** | Sensitive-data guard (Luhn, Aadhaar/Verhoeff, SSN patterns, OTP fields, http and cross-domain forms) | detectors unit-tested; modal appears only on risky sites |
| **A4** | Breach check and reuse detection | known-breached password flagged without leaving the device |
| **A5** | Dashboard adult views (shield status, this week's protection, privacy report), landing page "For you" section, README | adult account sees no family concepts |
| **A6** | Security and privacy review, permissions justification, tests on PostgreSQL | review findings fixed |

## Status

- **A0 and A1 done:** account types, WARN, presets, look-alike warnings, warning page, popup, pause.
- **A2 done:** tracker and fingerprinting rulesets, tracking-link cleanup, cookie panel, clear-on-close.
  Limitation: Chrome only exposes per-page *counts* of blocked requests to a shipped extension, not
  which domains, so the popup reports counts, and the dashboard's weekly privacy totals will come
  from cookie events only.
- **A3 done:** sensitive-data guard (content script, closed-shadow dialog, early banner). Verified in real Chrome
  on test pages; not yet on real banking or shopping sites.
- **A4 done:** breach check (k-anonymity, 5-character prefix only) and opt-in reuse detection (salted PBKDF2
  fingerprints, on-device, capped at 500, erasable). Verified in real Chrome with a stubbed service; the live
  Pwned Passwords service has not been called yet.
- **A5 done:** adult dashboard (Home, My protection, Activity, sign-up choice, "For adults" section on the
  landing page). Checked in Chrome against demo data.
- **A6 done:** security and privacy review of Shield. Fixed: guard bypass by a hostile capture listener (now
  `document_start` + `window`), AI free text no longer shown in warnings, "continue anyway" can't override a
  block, content scripts can't send privileged messages. Permissions and data flows documented in
  `docs/PRAISE_SHIELD_PERMISSIONS.md`. All adult-version milestones (A0 to A6) are complete.

## Open questions for you

1. **Name:** "Praise Shield" for the adult extension, and keep "Praise" for the family version?
2. **Look:** keep the glass and door identity, or give Shield a calmer sibling look (cooler sea-green and sky with the same lamp)?
3. **Order:** start with A0 and A1 (safe browsing and the warning page), or begin with the privacy features (A2 to A4)?
4. **Reputation feeds:** OK to add optional URLhaus and OpenPhish imports, which need a network fetch and a terms check?
