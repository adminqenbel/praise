# Deploying the beta

| Part | Where | Address |
|---|---|---|
| Dashboard (static) | Vercel, project root `dashboard/` | https://app.praise.qenbel.site |
| API (Flask + gunicorn) | Render, blueprint `render.yaml` | https://api.praise.qenbel.site |
| Database | Supabase PostgreSQL | pooler connection strings, region next to Render (Singapore) |
| Extension | Chrome Web Store (unlisted for the beta) | talks to the API above; only an unpacked developer copy can be pointed elsewhere |

The dashboard and the API share the registrable domain `qenbel.site`, so the `SameSite=Lax` session cookie is sent on
the dashboard's API calls. Do not serve either from `*.vercel.app` / `*.onrender.com` for real use: login would fail
silently (different sites).

## 1. Supabase

1. Create the project in the same region as Render (`singapore` in `render.yaml`). Keep the database password in a
   password manager; it is never committed.
2. **Connect** gives two pooler strings. Add `?sslmode=require` to both (the API refuses to start in production
   without it):
   - **Session pooler** (port 5432): for migrations and admin commands from a developer machine.
   - **Transaction pooler** (port 6543): for the running API (`DATABASE_URL` on Render).
   The direct `db.<ref>.supabase.co` address is IPv6-only; Render needs the pooler.
3. Put the session-pooler string in `backend/.env` as `DATABASE_URL` (never commit that file), then from `backend/`:
   ```
   .venv\Scripts\flask --app app db upgrade      # schema, including row level security on every table
   .venv\Scripts\flask --app app seed-sites      # well-known sites (safe to repeat)
   .venv\Scripts\flask --app app create-admin    # first admin, interactive
   ```
   Never run `scripts/seed_demo.py` or `scripts/seed_adult.py` against this database.
4. Event retention (90 days). Database > Extensions: enable `pg_cron`, then in the SQL editor:
   ```sql
   select cron.schedule('praise-purge-events', '30 21 * * *',
     $$delete from public.events where "timestamp" < now() - interval '90 days'$$);
   ```
   (`flask --app app purge-events` does the same by hand.)
5. Optional belt and braces: Settings > API, remove `public` from the exposed schemas. RLS already blocks the API roles.

Free-tier projects pause after about a week without activity; move to a paid plan before real families depend on it.

## 2. Render (API)

1. New > Web Service, pick the GitHub repository, and copy the settings from `render.yaml`: region Singapore, root
   directory `backend`, runtime Python, the build and start commands, instance type Free, health check path `/health`.
   (New > Blueprint reads `render.yaml` directly, where the account allows it.)
2. Environment > Add from .env: every `envVars` key in `render.yaml`. Secrets: `DATABASE_URL` (transaction pooler,
   `?sslmode=require`, `@` in the password written `%40`), `GEMINI_API_KEY` (a new key, not the one used in local
   development) and `SECRET_KEY` (a fresh `python -c "import secrets; print(secrets.token_urlsafe(48))"`). Keep the
   file you paste from out of git (`render.env` is ignored). Google sign-in adds `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET` and `API_ORIGIN=https://api.praise.qenbel.site` (section 2a).
3. Settings > Custom Domains: `api.praise.qenbel.site`; add the CNAME it shows at your DNS provider.
4. Check: `https://api.praise.qenbel.site/health` answers `{"status":"ok"}`. If the deploy log says
   "Refusing to start in production", it names the setting to fix.
5. Check the client address once: sign in with a wrong password on the dashboard, then find `failed login ip=` in the
   Render log. It must be your own public address. If it is a private or Render address, set `TRUSTED_PROXY_HOPS` to `2`
   and redeploy. Wrong here means every user shares one rate limit.

**Free plan:** the service sleeps after about 15 idle minutes and takes tens of seconds to wake. A child's browser gives
up after 8 s and applies its offline rules (unknown sites stay closed) until it answers. Three layers deal with it:

1. **Keep it awake (do this).** An outside monitor requests the API every 5 minutes; any request counts as activity. On
   cron-job.org (free, no card): Create cronjob, URL `https://api.praise.qenbel.site/health/ready`, schedule every 5
   minutes, request method GET, and turn on "notify me on failure". UptimeRobot (5-minute checks) works too. Use
   `/health/ready`, not `/health`: it also runs one trivial query, which keeps the free Supabase project from pausing
   after a quiet week and tells the monitor when the database is down (answers 503). GitHub Actions schedules are too
   late and too irregular for a 15-minute window. Always-on is about 744 of the workspace's 750 free hours a month, so
   keep this the only free web service in the Render workspace. The extension and the dashboard don't depend on it, it
   only avoids the wait below.
2. **Warm it up early.** The three landing pages call `Api.warm()` (a cookie-less ping to `/health`), so a visitor who
   reads the page for a few seconds usually finds it awake when they reach sign-up.
3. **Say so while it wakes.** The dashboard shows "Getting Praise ready" (after one second, so fast loads don't flash
   it) and retries its first request for up to two minutes, then offers "Try again". See `Api.patient` in
   `dashboard/js/api.js`.

Move to a paid instance (Render Starter, about 7 USD a month) before families depend on it: it never sleeps.

One gunicorn worker with 8 threads on purpose: the rate limiter and the AI budget live in that process. Before adding
workers or instances, move them to shared storage (roadmap A).

## 2a. Google sign-in

1. Google Cloud Console > APIs & Services > OAuth consent screen: app name Praise, home page
   `https://app.praise.qenbel.site`, authorized domain `qenbel.site`, scopes `openid`, `email`, `profile` only. While it is
   in "Testing", only the listed test users can sign in; publishing needs a privacy-policy URL.
2. Credentials > Create OAuth client ID > Web application. Authorized redirect URIs:
   `https://api.praise.qenbel.site/api/auth/google/callback` and, for development,
   `http://localhost:5000/api/auth/google/callback`.
3. Render: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `API_ORIGIN=https://api.praise.qenbel.site`. With a client id set,
   the API refuses to start without the secret or with a non-https `API_ORIGIN`.

Rules the code keeps: a login is found by Google's `sub`, never by email; a new Google login whose email already has an
account is refused (that owner signs in with the password and uses "Connect Google"), so nobody can pre-register an
address and wait for its owner; an unverified Google email cannot open an account. A child's browser leaves its account
with a one-time code from the Children page, which works for parents without a password.

## 3. Vercel (dashboard)

1. New project from the same repository, **Root Directory** `dashboard`, framework "Other", no build command, output
   directory `.`.
2. Domains: `app.praise.qenbel.site`; add the CNAME Vercel shows.
3. `dashboard/vercel.json` sets HSTS, framing and referrer headers; each page's CSP allows scripts from itself only and
   API calls to `https://api.praise.qenbel.site` (and `http://localhost:5000` for local development).

## 4. Extension

`extension/background.js` has `DEFAULT_BACKEND = "https://api.praise.qenbel.site"`. A copy installed from the Chrome
Web Store always uses it; the "Server address" field appears only in an unpacked developer copy. Families need the
store copy: forced installation by policy only works for store extensions on PCs that aren't joined to a domain.

## 5. After every deploy

- `/health` and `/health/ready` answer (the keep-awake monitor from section 2 is green); dashboard sign-in works; a pairing code pairs a store (or packed) copy of the extension.
- `node scripts/e2e_pair.js` against staging with a real classifier before releases (see README).
- New tables: enable row level security in the same migration (`tests/test_models.py` fails otherwise).
