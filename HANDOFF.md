# Praise: hand-off to the production track

Prepared 2026-10-22. Source: `D:\PRAISE` at commit `e7fba07` plus an uncommitted comment-only pass over about 75 files. This copy contains no git history; initialise or clone a repository for it deliberately (see section 7).

## 1. What this is

An AI-assisted web-protection platform.

| Part | Where | Tech |
|---|---|---|
| Backend API | `backend/` | Flask 3, SQLAlchemy 2 + Flask-Migrate (PostgreSQL; MongoDB was removed on the production track, events and AI evidence are now the `events` and `ai_analyses` tables), Gemini via `google-genai` |
| Policy engine | `backend/policy/` | Pure Python, no I/O. Makes every ALLOW/BLOCK decision |
| Dashboard | `dashboard/` | Static HTML/CSS/vanilla JS, Chart.js from a CDN. Landing hub, family dashboard, adult "Shield" dashboard, admin review queue |
| Extension | `extension/` | One Chrome Manifest V3 extension. Neutral until a one-time pairing code is accepted; the code decides family mode (buddy Dori) or adult Praise Shield mode (buddy Ringo) |
| Shared browser code | `common/` | Copied into `extension/` and `dashboard/js/` by `scripts/sync_common.py` |

Decision order (first match wins): parent rule, admin-verified site, trusted reputation, category policy, TLD policy, AI classification (if confident enough), unknown-site default. AI results are stored, so a site is classified once. Admins verify results, which makes them final for everyone.

One email can hold a family space and a personal space (`users.has_family`, `users.has_adult`, `users.account_type`; profiles by `children.kind`; rule sets by `policies.space`). See `backend/services/space_service.py`.

## 2. State at hand-off

- Tests, run against this copy on 2026-10-22: backend pytest 220 passed (12 files in `backend/tests/`, run with the original folder's virtualenv because this copy has none); browser-side 157 passed (100 `common`, 51 `extension`, 6 `dashboard`); `sync_common.py --check` is clean.
- Migrations: 4 Alembic revisions in `backend/migrations/versions/`, applied by `flask db upgrade`.
- Everything has only been run **locally** on Windows: Flask dev server on :5000, `dashboard/serve.py` on :5500, local PostgreSQL and MongoDB, `AI_MODE=mock` for most testing. Nothing has been deployed anywhere.
- The front-end report (`frontend-report/`, `.docx`/`.pdf`) and the screenshot PNGs were deliberately **not** copied. They stay in `D:\PRAISE`.

## 3. What was copied, and what was not

Copied: `backend/` (source, tests, migrations, `.env.example`, `requirements.txt`), `extension/`, `dashboard/`, `common/`, `scripts/`, `assets/`, `docs/`, `README.md`, `praise.bat`, `.gitignore`.

Left out on purpose: `.git`, `backend/.venv`, every `__pycache__`, `.pytest_cache`, `extension/_metadata` (Chrome generates it), **`backend/.env`** (contains real secrets; create a new one per environment), Word/PDF reports and screenshots.

`praise.bat` and `dashboard/serve.py` are local-only conveniences. Keep them for developers; do not ship them.

## 4. Local assumptions that will break in production

These are the concrete places the code assumes a single Windows machine. Each is also a line in `docs/PRODUCTION-ROADMAP.md`.

1. **API address is hard-coded.** `dashboard/js/api.js` defaults to `http://localhost:5000` (overridable only through `localStorage.praiseApi`), and `connect-src http://localhost:5000` is repeated in the CSP `<meta>` tag of seven dashboard pages (`home`, `children`, `policies`, `sites`, `events`, `cookies`, `reviews`); `index.html`, `family.html` and `shield.html` do not contain it. Needs one configurable origin, or serve dashboard and API from the same site.
2. **Extension default backend** is `DEFAULT_BACKEND = "http://localhost:5000"` in `extension/background.js:18`. The popup lets a person type a server address when pairing, which is fine for development but should not be a free-text field in a production build. Set it at build time.
3. **Extension permissions are broad.** `host_permissions` is `http://*/*` and `https://*/*`, plus `webNavigation`, `tabs`, `downloads`, `cookies`, `declarativeNetRequest(+Feedback)`, `scripting`. A Chrome Web Store review will ask for justification; `docs/PRAISE_SHIELD_PERMISSIONS.md` is the starting text. The family variant is meant to be force-installed by managed policy (`ExtensionInstallForcelist`); otherwise a child can disable it.
4. **Cross-origin cookies.** The session cookie is `HttpOnly; SameSite=Lax`, with `Secure` only when `SESSION_COOKIE_SECURE=1`. This works on `localhost` because ports on the same host count as same-site. If the dashboard and API end up on different registrable domains, login will silently fail. Put them under one parent domain (for example `app.example.com` and `api.example.com`) or behind one reverse proxy. `CORS` allows exactly one origin (`DASHBOARD_ORIGIN`).
5. **In-process state.** The rate limiter (`backend/services/ratelimit.py`) keeps hits in a per-process dictionary, and the AI daily budget is per process. More than one worker means the limits multiply and per-IP/per-account protection is weakened. Move both to Redis (or the database) before running several workers.
6. **Dev server.** The README starts the backend with `flask run`. Production needs a WSGI server (gunicorn or waitress) behind a TLS-terminating proxy. No `Dockerfile`, process manager config, or CI exists yet.
7. **Secrets and defaults.** `SECRET_KEY` falls back to `dev-only-change-me` (the app logs a warning, but still starts). `DATABASE_URL` falls back to `postgres:postgres@localhost`. Production should refuse to start on those defaults. `backend/.env.example` ships a placeholder `SECRET_KEY`; generate a real one per environment.
8. **Chart.js from a CDN** (`cdnjs.cloudflare.com`, allowed in the CSP). Vendor it locally for production so the CSP can drop the third-party origin and the dashboard works without it.
9. **Demo data.** `seed_demo.py` and `seed_adult.py` create `@demo.test` accounts with the password `demo-password-123`. Production must never run them. `flask --app app purge-demo` removes those accounts. The local database also holds test/demo rows; do not migrate it to production, start from an empty database with `flask db upgrade`, `flask seed-sites`, `flask create-admin`.
10. **Gemini.** The key in the local `.env` has been used in development; regenerate a new one for production and keep it out of source control. The model name (`GEMINI_MODEL`, default `gemini-3.8-flash`) is a setting because models are retired over time. `AI_MODE=mock` must be unset in production.
11. **Data retention.** Events are kept 90 days: run `flask --app app purge-events` daily (or schedule the same delete with pg_cron). Cookie values are never collected. Confirm this against the privacy policy you publish; a children's-data deployment likely needs a documented legal basis, parental-consent flow and deletion/export endpoints (none exist yet).

## 5. Environment variables (see `backend/config.py`)

| Variable | Purpose | Production note |
|---|---|---|
| `SECRET_KEY` | Signs sessions | Required, random, at least 32 bytes |
| `DATABASE_URL` | PostgreSQL (SQLAlchemy URL) | Managed instance, TLS, least-privilege role |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `AI_DAILY_BUDGET` | Classifier | Budget is per process today |
| `AI_MODE` | `mock` = offline classifier | Must be empty |
| `DASHBOARD_ORIGIN` | The only CORS origin | The real dashboard URL |
| `SESSION_COOKIE_SECURE` | `1` behind HTTPS | Must be `1` |
| `COMPANION_LLM`, `OLLAMA_URL`, `COMPANION_MODEL` | Optional local model for buddy chat | Off by default; needs a host that can run Ollama, or leave off (the buddy's written answers always work) |

## 6. Commands

Backend (from `backend/`, with a virtualenv and `pip install -r requirements.txt`):

```
flask --app app db upgrade        # schema
flask --app app purge-events      # delete events past 90 days (run daily)
flask --app app seed-sites        # well-known sites (idempotent)
flask --app app create-admin      # first admin (interactive)
flask --app app purge-demo        # remove @demo.test accounts
python -m pytest tests
```

Front end: `python scripts/sync_common.py` (copy shared code), `node scripts/build_rules.js` (regenerate tracker rules after editing `common/protections.js`).

## 7. Suggested first steps in this folder

1. Create a git repository for this folder (new repo or a branch of the original; your choice) with the existing `.gitignore`, and make the first commit before changing anything so every production change is a diff.
2. Do the "Foundation" group in `docs/PRODUCTION-ROADMAP.md`: config hardening, WSGI + container, configurable origins.
3. Stand up a staging environment (PostgreSQL, API, static dashboard) and run `scripts/e2e_pair.js` against it with a non-mock classifier.
4. Then security review, observability, store submission and the managed-install path for families.

## 8. Where to look

| Question | File |
|---|---|
| How does a decision get made? | `backend/policy/engine.py`, `decision.py`; `backend/routes/child.py` (`/api/ext/check`) |
| How is a site judged by AI? | `backend/ai/classifier.py`, `gemini.py`, `heuristics.py`, `services/ai_service.py` |
| Accounts, spaces, pairing | `backend/routes/auth.py`, `services/auth_service.py`, `services/space_service.py` |
| What the extension does | `extension/background.js` (about 850 lines, all family and adult behaviour) |
| Permissions and what leaves the device | `docs/PRAISE_SHIELD_PERMISSIONS.md` |
| Adult product plan | `docs/ADULT_VERSION_PLAN.md` |
| Original module plan | M0 to M12 (foundation, data model, auth, policy engine, site lifecycle, AI gateway, extension API, extension, protections, events, review, dashboard, hardening). Hardening (M12) was only partly done |

## 9. Known gaps carried over from local

- Remaining from the local checklist: regenerate the Gemini key, run `purge-demo` before any exposure, check phone-width layouts of the dashboard, finish M12 hardening and docs, deployment and CI.
- The extension protects one browser only; it cannot control other browsers or apps.
- Cookie "purpose" is a heuristic and labelled so.
- Official expansion of the name PRAISE is not defined anywhere in the code; the report uses "AI-Assisted Web Protection Platform for Families and Adults".
