# Praise (production track)

This folder is the **deployment / production copy** of Praise. `D:\PRAISE` is the frozen local and demonstration build; do not edit it from here and do not expect changes made here to flow back.

Read `HANDOFF.md` first (what exists, what differs from local, what is known to be unready), then `docs/PRODUCTION-ROADMAP.md` (the ordered enhancement list). Product behaviour is described in `README.md`, which was written for the local build, so where it says "localhost", "dev server" or "praise.bat" it describes local mode only.

## Working rules

- Never commit or print secrets. `backend/.env` is not in this copy and must stay out of git; `backend/.env.example` is the template.
- Shared browser code lives in `common/` and is copied into `extension/` and `dashboard/js/` by `python scripts/sync_common.py`. Edit `common/`, then run it. `python scripts/sync_common.py --check` must be clean before a commit.
- Tracker rule sets (`extension/rules/*.json`) are generated: edit `common/protections.js`, then `node scripts/build_rules.js`.
- PostgreSQL only (MongoDB was removed). Every new table enables row level security in its own migration; `tests/test_models.py` enforces it. Deployment is described in `docs/DEPLOY.md`.
- `backend/requirements.txt` is pinned: change `requirements.in`, reinstall into a clean virtualenv, write `pip freeze` back. Tests use `requirements-dev.txt`.
- The policy engine (`backend/policy/`) is pure and decides every ALLOW/BLOCK. The AI only classifies; never let a model output decide directly.
- Match the surrounding code's comment density and naming. Keep the three visual identities separate (neutral landing, family, adult Shield).

## Checks to run before saying something works

- Backend: `cd backend; python -m pytest tests` (SQLite by default; set `TEST_DATABASE_URL` for a throwaway PostgreSQL).
- Browser code: `node --test tests/*.test.js` inside `common/`, `extension/` and `dashboard/` (100, 51 and 6 tests at hand-off, all passing).
- Extension end to end: `scripts/e2e_pair.js`, `scripts/e2e_chat.js`, `scripts/e2e_pet.js` (see README, headless Chrome).
