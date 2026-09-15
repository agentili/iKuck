# iKuck — production readiness and provider smoke tests implementation plan

> **Status:** superseded operational roadmap; production/provider checks remain not verified until executed against an authenticated target. Current evidence is recorded in [production readiness](../../production-readiness.md) and the [remediation index](2026-09-14-remediation-index.md).

The current evidence boundary is intentionally split into local, disposable-stack and production sections in `docs/production-readiness.md`. Historical production/provider checkboxes below are not retroactively marked as verified.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the completed iKuck platform from the verified `v0.2.1-platform` baseline to a reproducible, monitored production deployment with HTTPS, tested PostgreSQL/Redis persistence, real Resend/USDA/OpenAI provider smoke tests, and a documented rollback and recovery procedure.

**Architecture:** Keep the current guest-first PWA and the existing Fastify API unchanged at the product boundary. Production runs the existing PostgreSQL, Redis, API and Caddy services from `deploy/docker-compose.production.yml`; Caddy terminates HTTPS and proxies the API, while PostgreSQL and Redis remain reachable only on the internal Compose network. Provider integrations are enabled through environment variables and verified with opt-in smoke tests that never run in the ordinary unit or integration suite.

**Tech Stack:** Docker Compose, Caddy, PostgreSQL 16, Redis 7, Node.js 24, Fastify, Drizzle, React/Vite, Playwright, Resend, USDA FoodData Central and the OpenAI Responses API.

**Spec:** The completed roadmap plans in `docs/superpowers/plans/`, especially `2026-09-12-remote-platform.md`, `2026-09-13-accounts-and-sync.md`, `2026-09-13-diet-allergens-nutrition.md`, and `2026-09-13-ai-recipes.md`. The standalone mini-PC procedure in `docs/standalone-mini-pc.md` is the deployment baseline; this plan adds the public-production controls that require a VPS, domain, real provider credentials and recovery procedures.

## Global Constraints

- Start from tag `v0.2.1-platform` and preserve the existing unrelated change in `.continue/rules/CONTINUE.md`.
- Never commit `.env`, provider API keys, database passwords, session secrets, backup archives or real user data.
- Keep PostgreSQL and Redis private to the Compose network; publish only ports 80 and 443 from Caddy and the administrative SSH port from the VPS firewall.
- Guests must continue to work locally and offline without an account, provider key or backend availability.
- Account synchronization and AI recipes remain restricted to verified accounts.
- Provider failures must degrade safely: email, USDA nutrition and AI errors must not expose secrets or corrupt pantry, shopping-list or activity data.
- Real-provider smoke tests are opt-in and use a dedicated test account, test address and disposable recipe data. They are not part of the default CI suite.
- Run the ordinary unit, integration, component and Playwright suites before every release candidate; run real-provider checks only after the staging deployment is healthy.
- Take and verify a PostgreSQL backup before migrations, provider changes or any destructive recovery operation.
- Source code, tests and code comments are English; visible product copy remains Italian.
- `E2E_VERIFICATION.md` remains unchanged and untracked as required by the repository workflow.

---

## Scope boundary and starting evidence

The following work is already complete and must be treated as the baseline rather than reimplemented:

- guest-first local PWA with catalog recipes and pantry presence matching;
- backend API, PostgreSQL/Drizzle migrations, Redis-backed sessions and AI quota boundary;
- accounts, mandatory e-mail verification, password reset and last-write-wins sync;
- pantry lots, quantities, units, expiry display, shopping list, activity, favorites and ratings;
- dietary profile, the 14 EU allergens, USDA enrichment boundary and incomplete-estimate messaging;
- private structured AI recipes with consent and five-generations-per-day enforcement;
- automatic local suggestions after the first explicit search;
- standalone Docker smoke verification and the mini-PC deployment guide.

Before starting the tasks below, verify the baseline with:

```powershell
git -c safe.directory=C:/Users/New/git/iRicetto/.worktrees/remote-platform status --short
git -c safe.directory=C:/Users/New/git/iRicetto/.worktrees/remote-platform describe --tags --exact-match HEAD
```

Expected result: only the known `.continue/rules/CONTINUE.md` deletion is reported, and the exact tag is `v0.2.1-platform`.

---

## Task 1: Freeze the release contract and production configuration

**Files:**

- Modify: `deploy/.env.example`
- Modify: `README.md`
- Create: `docs/production-readiness.md`
- Create: `scripts/validate-production-config.ps1`
- Create: `scripts/validate-production-config.test.ps1`
- Verify: `.gitignore`
- Verify: `deploy/docker-compose.production.yml`

**Interfaces:**

- `deploy/.env.example` documents all required deployment variables and optional provider variables without containing usable secrets.
- `scripts/validate-production-config.ps1` accepts an env-file path and returns a non-zero exit code for missing values, example placeholders, weak session secrets, invalid domains or exposed database/Redis URLs.
- `docs/production-readiness.md` becomes the single operator runbook for staging, production deploy, backup, restore, rollback and smoke checks.

- [x] **Step 1: Write failing configuration-validation tests**

  Cover a valid HTTPS domain, a missing `SESSION_SECRET`, an unchanged example password, a session secret shorter than 32 characters, a provider key accidentally placed in a committed sample file, and a database URL that points outside the private Compose network.

- [x] **Step 2: Run the focused validation tests and confirm they fail**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-production-config.test.ps1
```

  Expected: failures because the validator and the complete production configuration contract do not yet exist.

- [x] **Step 3: Implement the validator and document the environment contract**

  Include `APP_DOMAIN`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` and `SESSION_SECRET` as required values. Document optional `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `USDA_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL` and the provider enablement rules. Keep provider variables absent or empty by default so a local deployment remains usable without external services.

- [x] **Step 4: Re-run the validator and Compose rendering**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-production-config.ps1 -EnvFile deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml config
```

  Expected: validation passes, the Compose render succeeds, and a host-local `.env` passes the deployability checks. The repository verification used disposable valid fixtures because the real `deploy/.env` is intentionally absent and must only exist on the operator host.

- [x] **Step 5: Commit the configuration contract**

```powershell
git add deploy/.env.example README.md docs/production-readiness.md scripts/validate-production-config.ps1 scripts/validate-production-config.test.ps1 .gitignore
git commit -m "docs: define production configuration contract"
```

**Verification record:** The validator test covers valid HTTPS domains, missing and weak session secrets, unchanged placeholders, provider keys in committed samples and external database URLs. Backend verification passed with 26 test files and 79 tests; 2 integration tests remain intentionally skipped without dedicated PostgreSQL/Redis URLs. Frontend verification passed with 34 test files and 170 tests, lint, typecheck and build. Compose production rendering passed with `deploy/.env.example`; Docker runtime and real provider smoke tests require the operator environment and are not claimed here.

---

## Task 2: Prepare the EU VPS, DNS and network boundary

**Files:**

- Update outside the repository: VPS firewall and DNS records
- Modify: `docs/production-readiness.md`
- Verify: `deploy/docker-compose.production.yml`
- Verify: `deploy/Caddyfile`

- [ ] **Step 1: Provision the host prerequisites**

  Use an EU-hosted VPS with Docker Engine and the Compose plugin, a non-root deployment user, automatic security updates, time synchronization and enough persistent storage for PostgreSQL, Redis, Caddy certificates and backups. Record the OS version, Docker version and disk allocation in the runbook.

- [ ] **Step 2: Configure DNS and firewall rules**

  Point the chosen domain and `www` policy to the VPS public address. Allow SSH only from the operator network, and allow TCP 80 and 443 from the internet. Do not allow PostgreSQL 5432 or Redis 6379 from the internet. Verify the public DNS answers from a second network before starting Caddy.

- [ ] **Step 3: Verify the Caddy certificate prerequisites**

  Confirm that `APP_DOMAIN` is a real DNS name, that ports 80 and 443 reach the host, and that the Caddy volume is persistent. Use a staging hostname or a controlled first issuance if the domain has previously hit ACME rate limits.

- [ ] **Step 4: Record the external prerequisites and stop if any are missing**

  The release cannot proceed to public HTTPS without the domain, VPS access and firewall control. Provider keys are not needed for the initial infrastructure health check, but they are required for the provider smoke task.

---

## Task 3: Deploy the production Compose stack and migrations

**Files:**

- Verify: `deploy/docker-compose.production.yml`
- Verify: `deploy/Caddy.Dockerfile`
- Verify: `backend/Dockerfile`
- Modify if required by the verified deployment: `docs/production-readiness.md`

- [ ] **Step 1: Create the untracked production env file on the VPS**

  Copy `deploy/.env.example` to a host-local `.env`, replace every placeholder, generate a unique session secret of at least 32 characters, and use a database password that is safe in a URL. Do not place provider keys in shell history or repository files.

- [ ] **Step 2: Validate the exact release artifact before startup**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-production-config.ps1 -EnvFile deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml config
```

  Expected: validation passes, the API build context includes `shared`, Caddy has the expected proxy configuration, and no service publishes PostgreSQL or Redis ports.

- [ ] **Step 3: Build and start the stack**

```powershell
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml build --pull
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml up -d
```

- [ ] **Step 4: Verify service health and migration completion**

```powershell
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml logs --tail=200 api caddy
curl.exe --fail-with-body https://$env:APP_DOMAIN/healthz
curl.exe --fail-with-body https://$env:APP_DOMAIN/
```

  Expected: PostgreSQL and Redis are healthy, the API health check returns JSON status `ok`, Caddy serves the PWA over HTTPS, and the API startup migration exits successfully before the server stays running.

- [ ] **Step 5: Verify restart persistence**

  Restart only the API and Caddy containers, then confirm the health endpoint and a previously created non-sensitive test record remain available. Restart PostgreSQL and Redis one at a time only after the first backup exists.

- [ ] **Step 6: Commit only documentation or code changes made during deployment validation**

  Never commit the host-local `.env` or runtime data. Create a focused commit if the deployment exposed a reproducible repository defect; otherwise record the verified commands and artifact digest in the runbook.

---

## Task 4: Establish backup, restore and rollback evidence

**Files:**

- Verify: `deploy/backup-postgres.sh`
- Verify: `deploy/restore-postgres.sh`
- Modify: `docs/production-readiness.md`
- Create if required: `docs/backup-restore-rehearsal.md`

- [ ] **Step 1: Take a pre-release PostgreSQL backup**

  Use the existing backup script with an output directory outside the repository. Store the archive with a timestamp, release tag and checksum. Do not print `DATABASE_URL` or passwords in logs.

- [ ] **Step 2: Inspect the backup without changing production data**

  List the archive contents with PostgreSQL tooling, verify the checksum, and confirm that the expected application tables and migration metadata are present.

- [ ] **Step 3: Restore into a disposable PostgreSQL instance**

  Start an isolated restore target using a separate Compose project and volume. Restore the archive, run the application health check against the restored database, and verify representative account, pantry-lot, shopping-list, activity, preference and private-AI-recipe rows without exposing their values in the runbook.

- [ ] **Step 4: Test rollback to the previous image/tag**

  Record the current image digests, deploy the previous known-good artifact in the isolated environment, and verify that the stack starts and serves `/healthz`. Document the exact production rollback command, including the requirement to take a backup before any schema downgrade decision.

- [ ] **Step 5: Configure retention and recovery ownership**

  Define daily backups, a retention window, an off-host copy and an owner responsible for checking backup freshness. The acceptance criterion is a dated restore rehearsal, not merely a successful backup command.

---

## Task 5: Add opt-in real-provider smoke tests

**Files:**

- Create: `backend/src/smoke/providerSmoke.ts`
- Create: `backend/src/smoke/providerSmoke.test.ts`
- Modify: `backend/package.json`
- Modify: `backend/README.md` or the provider section of `README.md`
- Modify: `docs/production-readiness.md`
- Verify: `backend/src/providers/factory.ts`
- Verify: `backend/src/providers/resend.ts`
- Verify: `backend/src/providers/usda.ts`
- Verify: `backend/src/providers/openaiRecipes.ts`
- Verify: `backend/src/routes/auth.ts`
- Verify: `backend/src/routes/recipeNutrition.ts`
- Verify: `backend/src/routes/aiRecipes.ts`

**Interfaces:**

- `providerSmoke.ts` runs only when `RUN_PROVIDER_SMOKE=true` and requires explicit provider-specific environment variables.
- The smoke runner returns a non-zero exit code on a provider failure and prints only redacted operation names and request identifiers.
- The ordinary `npm test` and `npm run test:integration` commands never invoke the smoke runner.

- [ ] **Step 1: Write unit tests for smoke gating and redaction**

  Test that the runner refuses to start without the explicit flag, refuses incomplete credentials, redacts e-mail addresses and keys, and maps provider errors to a non-zero result without leaking response bodies.

- [ ] **Step 2: Implement the smoke runner around the existing adapters**

  Keep provider calls behind the current factory and route contracts. Do not duplicate authentication, USDA mapping or OpenAI schema validation in the smoke runner. Use a dedicated test identity and a known recipe fixture.

- [ ] **Step 3: Add the command and document the required variables**

  Add a package command such as:

```powershell
npm run smoke:providers
```

  Require `RUN_PROVIDER_SMOKE=true`, a disposable test e-mail, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `USDA_API_KEY`, `OPENAI_API_KEY` and the selected `OPENAI_MODEL`. Keep the values in the operator environment only.

- [ ] **Step 4: Run the Resend smoke flow**

  Register the dedicated test identity, confirm receipt of the verification message, verify the account through the real link or controlled token flow, request a password reset, and confirm that no token or secret is present in API or worker logs. Delete or disable the test identity according to the provider account policy.

- [ ] **Step 5: Run the USDA smoke flow**

  Request nutrition enrichment for a catalog recipe with a stable USDA food mapping, verify nutrient units and the explicit incomplete-estimate state, then repeat with an unavailable mapping and confirm the safe fallback response.

- [ ] **Step 6: Run the OpenAI smoke flow**

  With a verified test account and recorded consent, generate one private recipe and validate the structured JSON response, diet/allergen compatibility, ingredient mapping and private persistence. Consume the remaining quota with controlled requests, verify the sixth request is rejected, revoke consent, and verify subsequent generation is blocked. Confirm the request uses `store: false` and that prompts, API keys and generated private recipe contents are absent from logs.

- [ ] **Step 7: Record provider evidence without storing secrets**

  Save provider name, UTC timestamp, release tag, result, redacted request identifier and failure category. Do not save message bodies, reset links, access tokens, prompts, generated private recipe content or API credentials.

---

## Task 6: Run PostgreSQL/Redis integration tests against real containers

**Files:**

- Verify: `backend/src/integration/auth-sync.integration.test.ts`
- Create: `deploy/docker-compose.integration.yml`
- Modify if needed: `backend/src/integration/auth-sync.integration.test.ts`
- Modify if needed: `backend/package.json`
- Modify: `docs/production-readiness.md`

- [x] **Step 1: Provision isolated integration services**

  Add a disposable Compose definition with a separate project, loopback-only ports and credentials that cannot reach production. Start it only on the operator host, then set `INTEGRATION_DATABASE_URL` and `INTEGRATION_REDIS_URL` only for the test process.

- [x] **Step 2: Run the existing integration suite**

```powershell
$env:INTEGRATION_DATABASE_URL = 'postgres://integration:integration@127.0.0.1:55432/ikuck_integration'
$env:INTEGRATION_REDIS_URL = 'redis://127.0.0.1:56379'
npm --prefix backend run test:integration
```

  Expected: all container-backed integration tests execute and pass; the default backend test command remains provider-free.

- [x] **Step 3: Extend coverage for production-sensitive boundaries**

  Add integration assertions for session cookie flags, verification gating, sync last-write-wins behavior, Redis quota reset behavior, migration idempotence and transaction rollback. Tests must seed and clean their own records and must never use production URLs.

**Implementation record:** Added the isolated Compose definition and extended the integration suite with all listed boundary assertions. The test process cleans its account records; Redis keys live only in the disposable integration instance.

**Verification record:** Vitest discovered 3 integration tests, but skipped them because `INTEGRATION_DATABASE_URL` and `INTEGRATION_REDIS_URL` were not set. Docker Engine is installed but the local daemon is unavailable (`permission denied ... docker_engine`), so container execution and cleanup remain pending on a host with Docker running.

- [x] **Step 4: Destroy only the disposable integration resources**

  Record the Compose project name before cleanup, verify it targets the integration project, then remove its containers and volumes. Confirm the production project and volumes were not touched.

**Verification record:** `docker compose -p ikuck-integration -f deploy/docker-compose.integration.yml up -d` started healthy PostgreSQL 16 and Redis 7 containers on `127.0.0.1:55432` and `127.0.0.1:56379`. With the disposable URLs set, `npm --prefix backend run test:integration` passed 3/3 tests. The exact project was inspected with `docker compose ... ps` and removed with `down -v`; no production project was targeted.

---

## Task 7: Add a production-target Playwright smoke profile

**Files:**

- Modify: `frontend/playwright.config.ts`
- Create: `frontend/playwright.config.test.ts`
- Create: `frontend/e2e/production-smoke.spec.ts`
- Modify: `frontend/e2e/core-flow.spec.ts`
- Modify: `frontend/package.json`
- Modify: `docs/production-readiness.md`
- Verify: `frontend/e2e/account-sync.spec.ts`
- Verify: `frontend/e2e/core-flow.spec.ts`

- [x] **Step 1: Write failing configuration and smoke assertions**

  Cover an HTTPS base URL supplied through `E2E_BASE_URL`, reject an HTTP production URL when production mode is enabled, and verify the guest flow, pantry search, shopping-list navigation, activity navigation and profile navigation.

- [x] **Step 2: Implement an explicit production mode**

  Keep the current local preview default. Add `E2E_BASE_URL` and `E2E_PRODUCTION=true` handling without enabling a local `webServer` when a remote base URL is supplied. Never put test credentials in Playwright config or source control.

- [x] **Step 3: Add safe account and provider checks**

  Use only a disposable verified test account supplied through the environment. Cover login, one sync round-trip, diet/allergen state loading and the AI consent boundary. Do not run destructive account deletion or quota-exhaustion flows in the browser suite; those remain in the provider smoke runner.

- [x] **Step 4: Run local and production-target profiles separately**

```powershell
npm --prefix frontend run test:e2e
$env:E2E_BASE_URL = 'https://example.test'
$env:E2E_PRODUCTION = 'true'
npm --prefix frontend run test:e2e:production
```

  Expected: local desktop/mobile tests pass as before; the production profile runs only against the supplied HTTPS target and is skipped with a clear message when its required environment is absent.

**Verification record:** Playwright profile tests passed (3/3). The full local browser suite passed with 30 tests and 6 expected production-target skips; the dedicated production profile passed with 2 expected skips when no target was configured. A real remote HTTPS target and disposable verified account were not available in this workspace, so the remote account flow was not claimed.

---

## Task 8: Final release gate, monitoring and handoff

**Files:**

- Modify: `README.md`
- Modify: `docs/production-readiness.md`
- Create: `docs/release-checklist.md`
- Verify: `docs/standalone-mini-pc.md`
- Verify: `E2E_VERIFICATION.md`

- [ ] **Step 1: Run the complete local verification gate**

```powershell
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend exec tsc -- --noEmit
npm --prefix frontend run build
npm --prefix frontend run test:e2e
npm --prefix backend test
npm --prefix backend run lint
npm --prefix backend run build
npm --prefix backend run test:integration
git -c safe.directory=C:/Users/New/git/iRicetto/.worktrees/remote-platform diff --check
```

  Record exact pass/skip reasons. A provider smoke failure is not silently converted into a pass; a missing opt-in provider key is reported as “not run”.

- [ ] **Step 2: Verify production observability and resource limits**

  Confirm structured API logs, container restart policies, health-check visibility, disk usage alerts, backup freshness checks and a documented way to inspect Caddy certificate status. Ensure logs do not contain cookies, passwords, provider keys, reset tokens, prompts or private generated recipes.

- [ ] **Step 3: Exercise the operator runbook**

  Have a second person follow the deploy, health, backup, restore and rollback sections from a clean checkout. Resolve every ambiguity found during that rehearsal before release.

- [ ] **Step 4: Create the release record**

  Record the source commit/tag, image digests, migration result, backup checksum, integration result, provider smoke result, browser smoke result, known limitations and recovery owner. Do not include secrets or real user data.

- [ ] **Step 5: Decide release status using explicit acceptance criteria**

  The release is ready only when HTTPS health and PWA loading succeed, PostgreSQL/Redis survive restart, a restore rehearsal is successful, all default tests pass, integration tests pass against disposable containers, each explicitly enabled provider smoke passes, and the rollback procedure is executable. If a provider is intentionally disabled, document that state and confirm the corresponding fallback behavior.

- [ ] **Step 6: Commit the completed operational documentation and tag the next release**

  Inspect the staged file list to ensure `.env`, backups, `E2E_VERIFICATION.md` and `.continue/rules/CONTINUE.md` are absent. Create a focused documentation or release commit, then add a new annotated tag only after the final verification evidence is recorded.

---

## Final acceptance checklist

- [ ] The VPS is in the EU, DNS resolves correctly and only SSH/80/443 are externally reachable.
- [ ] Production Compose renders from a host-local env file and starts with healthy PostgreSQL, Redis, API and Caddy services.
- [ ] The public HTTPS endpoint serves the PWA and `/healthz` without exposing internal service details.
- [ ] Database migrations are repeatable, backups are checksum-verified and a restore rehearsal has succeeded.
- [ ] Guest mode remains local/offline and verified accounts can authenticate and synchronize.
- [ ] Resend verification/reset, USDA enrichment/fallback and OpenAI consent/quota/privacy flows have passed their opt-in smoke checks when enabled.
- [ ] Disposable-container integration tests execute instead of being skipped.
- [ ] Desktop and mobile production-target browser smoke checks pass with a disposable test identity.
- [ ] Logs, retention, monitoring, rollback and ownership are documented and rehearsed.
- [ ] The release record contains no secrets, tokens, prompts or private recipe contents.

