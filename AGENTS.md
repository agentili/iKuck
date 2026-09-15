# iKuck agent guidance

## Current architecture

- The frontend is a React/Vite guest-first PWA.
- Guest pantry, shopping list, activity, preferences and diet data stay in IndexedDB and work offline.
- The backend is a Fastify API backed by PostgreSQL and Redis.
- Account synchronization is available only to verified sessions and local-to-account import is always explicit.
- Session cookies are HttpOnly; state-changing API requests require same-origin and CSRF protections.
- Caddy serves the frontend and proxies only `/v1/*` to the API.
- The shared TypeScript package lives in `shared/` and is consumed by both `frontend/` and `backend/`.

Do not reintroduce Supabase, TanStack Query, a public recipe API, automatic guest import, or the structure described by the obsolete `iRicetto_plan.md` unless a new approved plan explicitly requires it.

## Repository layout

- `frontend/`: React pages, components, Zustand stores, IndexedDB adapters and Playwright tests.
- `backend/`: Fastify routes, repositories, migrations, provider adapters and Vitest tests.
- `shared/`: contracts shared by the browser and API.
- `deploy/`: Docker Compose files, Caddy configuration, backup/restore scripts and deployment validators.
- `scripts/`: repository and deployment verification scripts.
- `docs/`: operational documentation and remediation plans.

## Setup and verification

Install dependencies from the repository root:

```powershell
npm ci --prefix frontend
npm ci --prefix backend
```

Run the standard gate:

```powershell
npm run verify
```

The root verifier runs frontend lint, unit tests and build, then backend lint, unit tests and build. Add explicit switches when needed:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-repository.ps1 -Coverage
powershell -ExecutionPolicy Bypass -File scripts/verify-repository.ps1 -E2E
powershell -ExecutionPolicy Bypass -File scripts/verify-repository.ps1 -Integration
```

Integration verification requires disposable `INTEGRATION_DATABASE_URL` and `INTEGRATION_REDIS_URL` values. Production browser tests require an HTTPS `E2E_BASE_URL` and `E2E_PRODUCTION=true`. Resend, USDA and OpenAI provider smoke tests are opt-in and must use disposable credentials and data.

Useful focused commands:

```powershell
npm --prefix frontend test -- --run src/path/to/test.tsx
npm --prefix frontend run test:e2e:a11y
npm --prefix backend test -- --run src/path/to/test.ts
npm --prefix backend run test:integration
```

Run Docker integration and standalone environments with dedicated Compose project names. Never remove production volumes as a debugging step. Record skipped production/provider/recovery checks as not verified.

## Change conventions

- Work in the requested isolated branch/worktree; preserve unrelated edits and untracked user files.
- Complete one task at a time with a focused test, then run the relevant full gate.
- Code, identifiers and comments are English; user-visible copy is Italian.
- Prefer same-origin relative API paths and keep secrets out of source, logs, tests and reports.
- Do not merge or push automatically. Create a commit and tag only when the current plan's workflow requests it.
- Before claiming completion, run the verification command and inspect `git diff --check` and `git status --short`.
