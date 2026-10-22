# Production roadmap

Ordered by dependency. Tick items as they land. "Why" notes point at the code that makes the item necessary; see `HANDOFF.md` section 4 for the details.

## A. Foundation (do first; everything else assumes it)

- [ ] **Fail closed on bad config.** Refuse to start when `SECRET_KEY` is the dev value, when `AI_MODE=mock` outside tests, or when `DATABASE_URL` still points at `postgres:postgres@localhost` (`backend/app.py`, `backend/config.py`). Add a `PRAISE_ENV=production` switch.
- [ ] **Configurable origins.** One `API_ORIGIN` for the dashboard (replace the hard-coded `http://localhost:5000` in `dashboard/js/api.js`) and generate the CSP `connect-src` from it at build or serve time instead of editing every HTML page. Same for the extension's `DEFAULT_BACKEND` (`extension/background.js:18`), and remove the free-text server field from the production popup.
- [ ] **WSGI + container.** gunicorn (or waitress) with a health check on `/health`, a `Dockerfile` for the API, and compose or equivalent for local parity with PostgreSQL and MongoDB. Run migrations as a release step, not on boot.
- [ ] **Serve the dashboard properly.** Static hosting or reverse proxy with real cache headers, TLS, and the security headers the CSP expects. Retire `dashboard/serve.py` for production.
- [ ] **Vendor Chart.js** and drop `https://cdnjs.cloudflare.com` from `script-src`.
- [ ] **One site for cookies.** Decide the domain layout (dashboard and API under one registrable domain or one proxy), set `SESSION_COOKIE_SECURE=1`, and update `DASHBOARD_ORIGIN`.
- [ ] **Shared state for limits.** Replace the in-process rate limiter and AI budget (`backend/services/ratelimit.py`, `services/ai_service.py`) with Redis or database counters so several workers behave as one.
- [ ] **Clean first-run path.** Documented bootstrap: `db upgrade`, `init-mongo`, `seed-sites`, `create-admin`. No demo seeds.

## B. Security and privacy

- [ ] Run the `secure-code-review` pass on auth, device tokens, CORS, SQL, and prompt-injection handling (the plan's M12; only partly done locally). Include Praise Shield's content script and the extension message boundaries.
- [ ] Session and password policy: lockout and alert behaviour, password-reset by email (does not exist yet), email verification, optional 2FA for parents and admins.
- [ ] Secret management: keys in the platform's secret store, rotation procedure, new Gemini key, per-environment `SECRET_KEY`.
- [ ] Child-data compliance: parental-consent flow, privacy policy, data-export and deletion endpoints, retention review (events are kept 90 days), data-processing terms with the model provider. Take legal advice for the target regions.
- [ ] Audit log for admin actions (review decisions already write `site_reviews`; extend to account and policy changes).
- [ ] Dependency pinning with a lock file and automated vulnerability scanning (`requirements.txt` currently uses open lower bounds).

## C. Reliability and operations

- [ ] Structured logging with request IDs; no page content or browsing history in logs.
- [ ] Metrics and alerts: request latency, `/api/ext/check` error rate, AI error and budget burn, queue depth of the review list, database health. See the `observability-design` skill.
- [ ] Backups and restore drill for PostgreSQL and MongoDB; document RPO/RTO.
- [ ] Load test `/api/ext/check` and `/api/ext/events` (the extension batches events; check batch limits and `MAX_CONTENT_LENGTH`).
- [ ] CI: backend pytest, the three Node test folders, `sync_common.py --check`, lint, dependency audit. Gate merges on it.
- [ ] Environments: dev, staging, production with separate databases and keys. Run `scripts/e2e_pair.js` against staging with a real (non-mock) classifier before each release.

## D. Product enhancements for production

- [ ] Email notifications and a weekly summary for parents and adults.
- [ ] Multi-parent households and admin roles beyond a single global admin.
- [ ] A safer classifier loop: caching and negative caching, retry/backoff review, per-family AI budget in shared storage, a reviewer workload view.
- [ ] Localisation of the dashboard, extension and buddy lines.
- [ ] Phone-width pass on the dashboards (the local checklist still lists this).
- [ ] Accessibility audit (keyboard paths, contrast in the family glass look, reduced motion already honoured).

## E. Extension distribution

- [ ] Chrome Web Store listing and review: justify each permission (`docs/PRAISE_SHIELD_PERMISSIONS.md`), privacy practices form, single-purpose statement. Consider whether the family and adult variants should be separate listings.
- [ ] Managed deployment for families: `ExtensionInstallForcelist` guide for Windows/ChromeOS/Mac, so a child cannot remove the extension.
- [ ] Update channel and versioning (`manifest.json` is 0.2.0), release notes, rollback plan. Backend must keep supporting older extension versions during a rollout.
- [ ] Optional: Edge and Firefox ports (MV3 differences in `declarativeNetRequest` and service-worker lifetime).

## F. Documentation to finish

- [ ] A production `README` (the current one is written for the local build).
- [ ] Runbook: deploy, roll back, rotate keys, restore from backup, handle an AI outage (unknown sites then take each rule set's default).
- [ ] Architecture diagram and data-flow diagram for the privacy notice.
