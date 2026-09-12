# Remote Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Docker-ready Fastify platform with PostgreSQL, Redis, a versioned health endpoint and provider boundaries, without changing current guest PWA behavior.

**Architecture:** Create an isolated `backend/` Node 24 TypeScript service. Fastify receives injected database and cache probes so its health behavior is tested without network access. Docker Compose runs the API with private PostgreSQL and Redis services; Caddy serves static PWA assets and proxies only `/v1/*`.

**Tech Stack:** Node.js 24, TypeScript, Fastify, Zod, Pino, Drizzle ORM, postgres.js, Redis, Vitest, Docker Compose, Caddy.

**Spec:** `docs/superpowers/specs/2026-09-12-synchronized-ikuck-design.md`

## Global Constraints

- Keep `frontend/` behavior and its local-only guest storage unchanged in this stage.
- Use Italian user-facing copy; source code, tests, comments and configuration keys remain English.
- Keep provider secrets out of the repository. Commit only `.env.example` files.
- PostgreSQL is the durable source of truth; Redis is disposable operational state.
- Return `503` without connection strings, stack traces or provider details whenever an infrastructure probe fails.
- Preserve and never stage `E2E_VERIFICATION.md` in the primary checkout.

---

### Task 1: Create the backend package and typed runtime configuration

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/src/config.ts`
- Create: `backend/src/config.test.ts`
- Create: `backend/.env.example`

**Interfaces:**
- Produces `loadConfig(environment: NodeJS.ProcessEnv): AppConfig`.
- `AppConfig` exposes `host`, `port`, `databaseUrl`, `redisUrl`, `sessionSecret`, `appOrigin`, `logLevel` and optional provider settings.

- [x] **Step 1: Write the failing configuration tests**

```ts
it('rejects a production configuration without a session secret', () => {
  expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://cache', APP_ORIGIN: 'https://ikuck.example' }))
    .toThrow('SESSION_SECRET is required');
});

it('uses safe local defaults only in development', () => {
  expect(loadConfig({ NODE_ENV: 'development' }).port).toBe(3000);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- config.test.ts`

Expected: FAIL because `loadConfig` does not exist.

- [x] **Step 3: Add the minimal package and configuration implementation**

```ts
export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  appOrigin: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const loadConfig = (environment: NodeJS.ProcessEnv): AppConfig => {
  // Parse with Zod and reject incomplete production configuration.
};
```

Add scripts `dev`, `build`, `test`, `test:coverage`, `lint`, `db:generate` and `db:migrate`. Document every environment variable in `backend/.env.example` without a real secret.

- [x] **Step 4: Run the focused and complete backend checks**

Run: `npm test -- config.test.ts && npm run lint && npm run build`

Expected: all commands exit with status 0.

- [x] **Step 5: Commit the task**

```bash
git add backend/package.json backend/package-lock.json backend/tsconfig.json backend/vitest.config.ts backend/src/config.ts backend/src/config.test.ts backend/.env.example
git commit -m "feat: add backend runtime configuration"
```

### Task 2: Build the injectable Fastify application and health contract

**Files:**
- Create: `backend/src/app.ts`
- Create: `backend/src/routes/health.ts`
- Create: `backend/src/routes/health.test.ts`

**Interfaces:**
- Consumes `AppConfig` from Task 1.
- Produces `createApp(dependencies: PlatformDependencies): FastifyInstance`.
- `PlatformDependencies` contains `database.ping(): Promise<void>` and `cache.ping(): Promise<void>`.

- [x] **Step 1: Write failing health route tests**

```ts
it('returns ok only when PostgreSQL and Redis are reachable', async () => {
  const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined } });
  expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
});

it('returns a generic 503 when a probe fails', async () => {
  const app = createApp({ database: { ping: async () => { throw new Error('private host'); } }, cache: { ping: async () => undefined } });
  const response = await app.inject('/healthz');
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'degraded' });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- health.test.ts`

Expected: FAIL because `createApp` and `/healthz` do not exist.

- [x] **Step 3: Implement the minimal Fastify application**

```ts
export const createApp = (dependencies: PlatformDependencies) => {
  const app = Fastify({ logger: true });
  app.get('/healthz', async (_request, reply) => {
    try {
      await Promise.all([dependencies.database.ping(), dependencies.cache.ping()]);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded' });
    }
  });
  return app;
};
```

- [x] **Step 4: Run focused tests and build**

Run: `npm test -- health.test.ts && npm run build`

Expected: all commands exit with status 0.

- [x] **Step 5: Commit the task**

```bash
git add backend/src/app.ts backend/src/server.ts backend/src/routes/health.ts backend/src/routes/health.test.ts
git commit -m "feat: expose platform health endpoint"
```

### Task 3: Add PostgreSQL, Drizzle and Redis adapters

**Files:**
- Create: `backend/drizzle.config.ts`
- Create: `backend/src/db/client.ts`
- Create: `backend/src/db/schema.ts`
- Create: `backend/src/db/migrations/0000_service_metadata.sql`
- Create: `backend/src/cache/client.ts`
- Create: `backend/src/server.ts`
- Create: `backend/src/platform-adapters.test.ts`

**Interfaces:**
- Produces `createDatabase(url: string): DatabaseProbe` and `createCache(url: string): CacheProbe`.
- Both adapters implement `ping(): Promise<void>` and `close(): Promise<void>`.
- The first migration creates `service_metadata(key text primary key, value text not null, updated_at timestamptz not null default now())`.

- [x] **Step 1: Write failing adapter tests**

```ts
it('uses SELECT 1 as the PostgreSQL readiness probe', async () => {
  const query = vi.fn().mockResolvedValue([]);
  await createDatabaseWithQuery(query).ping();
  expect(query).toHaveBeenCalledWith('SELECT 1');
});

it('delegates Redis readiness to PING', async () => {
  const redis = { ping: vi.fn().mockResolvedValue('PONG') };
  await createCacheWithClient(redis).ping();
  expect(redis.ping).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- platform-adapters.test.ts`

Expected: FAIL because the factories do not exist.

- [x] **Step 3: Implement adapters and migration configuration**

Use `postgres.js` behind Drizzle. Keep the raw probe wrapper injectable for tests. Use the Redis client only after `connect()` succeeds and ensure `close()` is idempotent. Add `drizzle-kit` configuration and the initial migration.

- [x] **Step 4: Verify adapter behavior before Compose packaging**

Run: `npm test -- platform-adapters.test.ts && npm run lint && npm run build`

Expected: adapter tests, lint and build pass. The real PostgreSQL/Redis smoke test runs after Compose exists in Task 5.

- [x] **Step 5: Commit the task**

```bash
git add backend/drizzle.config.ts backend/src/db backend/src/cache backend/src/platform-adapters.test.ts backend/package.json backend/package-lock.json
git commit -m "feat: connect platform storage adapters"
```

### Task 4: Establish provider ports and safe provider configuration

**Files:**
- Create: `backend/src/providers/types.ts`
- Create: `backend/src/providers/unavailable.ts`
- Create: `backend/src/providers/factory.ts`
- Create: `backend/src/providers/factory.test.ts`

**Interfaces:**
- Produces `EmailProvider`, `NutritionProvider` and `RecipeGenerationProvider` ports.
- Produces `createProviders(config: AppConfig): ProviderBundle`.
- A missing provider key returns a typed `ProviderUnavailableError`; no provider performs network I/O during construction.

- [x] **Step 1: Write failing provider factory tests**

```ts
it('does not expose missing provider credentials', async () => {
  const providers = createProviders(baseConfigWithoutProviderKeys);
  await expect(providers.nutrition.lookup('tomato')).rejects.toMatchObject({ code: 'provider_unavailable' });
});

it('keeps provider ports independent from Fastify routes', () => {
  expect(createProviders(baseConfigWithoutProviderKeys).email).toHaveProperty('send');
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- factory.test.ts`

Expected: FAIL because provider ports and factory do not exist.

- [x] **Step 3: Implement provider ports and unavailable implementations**

Define request and response types without provider SDK types. The future Resend, USDA and OpenAI adapters must satisfy these ports. Log only the provider name and error class; never log a request payload, secret or account identifier.

- [x] **Step 4: Run the backend suite**

Run: `npm test && npm run lint && npm run build`

Expected: all commands exit with status 0.

- [x] **Step 5: Commit the task**

```bash
git add backend/src/providers backend/src/providers/factory.test.ts backend/src/config.ts backend/src/config.test.ts backend/.env.example
git commit -m "feat: define external provider boundaries"
```

### Task 5: Package the service for local and VPS deployment

**Files:**
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`
- Create: `.dockerignore`
- Create: `compose.dev.yml`
- Create: `deploy/Caddy.Dockerfile`
- Create: `deploy/docker-compose.production.yml`
- Create: `deploy/Caddyfile`
- Create: `deploy/.env.example`
- Create: `deploy/backup-postgres.sh`
- Create: `deploy/restore-postgres.sh`
- Modify: `README.md`
- Test: `backend/src/deployment-contract.test.ts`

**Interfaces:**
- `compose.dev.yml` exposes API port `3000` and private `postgres`/`redis` services.
- Production Caddy serves frontend assets and proxies `/v1/*` only to `api:3000`.
- Backup scripts require `COMPOSE_FILE`, `POSTGRES_DB`, `POSTGRES_USER` and `BACKUP_DIR`; they refuse an empty backup directory.

- [x] **Step 1: Write failing deployment contract tests**

```ts
it('keeps PostgreSQL and Redis off the public network in development', () => {
  const compose = readComposeConfig('compose.dev.yml');
  expect(compose.services.postgres.ports).toBeUndefined();
  expect(compose.services.redis.ports).toBeUndefined();
  expect(compose.services.api.ports).toEqual([
    expect.objectContaining({ target: 3000, published: '3000' }),
  ]);
});

it('exposes only HTTP and HTTPS from the production composition', () => {
  const compose = readComposeConfig('deploy/docker-compose.production.yml');
  expect(compose.services.postgres.ports).toBeUndefined();
  expect(compose.services.redis.ports).toBeUndefined();
  expect(compose.services.caddy.ports).toEqual([
    expect.objectContaining({ target: 80, published: '80' }),
    expect.objectContaining({ target: 443, published: '443' }),
  ]);
});
```

`readComposeConfig` executes `docker compose config --format json` with test-only environment values. The test verifies the rendered configuration instead of matching source text.

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- deployment-contract.test.ts`

Expected: FAIL because Compose and Caddy files do not exist.

- [x] **Step 3: Implement container and operational files**

Use multi-stage Dockerfiles. Give Postgres and Redis persistent named volumes and health checks. Caddy must apply security headers, serve the built `frontend/dist` directory and use `try_files` SPA fallback. The backup script creates timestamped compressed `pg_dump` files; the restore script requires an explicit archive path and uses `pg_restore --clean --if-exists`.

- [ ] **Step 4: Verify container configuration**

Run: `npm test -- deployment-contract.test.ts && docker compose -f compose.dev.yml config && docker compose -f deploy/docker-compose.production.yml config && docker run --rm --mount type=bind,source="$PWD/deploy/Caddyfile",target=/etc/caddy/Caddyfile,readonly caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`

Expected: tests pass and both Compose files render without validation errors.

- [x] **Step 5: Document local and VPS operations**

Document frontend and backend start commands, health URL, required secret provisioning, migration command, backup/restore command, and the rule that no provider key belongs in the frontend or repository.

- [ ] **Step 6: Commit the completed platform**

```bash
git add .dockerignore backend compose.dev.yml deploy README.md
git commit -m "feat: package remote platform for deployment"
```

### Task 6: Final platform verification and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-09-12-remote-platform.md`

- [x] **Step 1: Run all backend and frontend checks**

Run: `cd backend && npm test && npm run lint && npm run build && cd ../frontend && npm test && npm run lint && npm run build && npm run test:e2e`

Expected: all checks pass.

- [ ] **Step 2: Perform the real local platform smoke test**

Run: `docker compose -f compose.dev.yml up --build --wait && curl --fail http://127.0.0.1:3000/healthz && docker compose -f compose.dev.yml down --volumes`

Expected: health returns `{"status":"ok"}` and no container remains running after cleanup.

- [x] **Step 3: Review repository scope**

Run: `git diff --check && git status --short`

Expected: only platform files and this plan are staged; no `.env`, provider secret, build output or `E2E_VERIFICATION.md` is included.

The scope review found one pre-existing unstaged deletion, `.continue/rules/CONTINUE.md`; it was preserved and excluded from every platform commit.

The container smoke test remains pending because Docker Desktop cannot open its stopped `com.docker.service` on this host. No container or volume was created.

- [ ] **Step 4: Commit the plan checklist update**

```bash
git add docs/superpowers/plans/2026-09-12-remote-platform.md
git commit -m "docs: record remote platform verification"
```

## Plan self-review

- Spec coverage: Tasks 1-5 cover the remote runtime, PostgreSQL, Redis, Docker Compose, Caddy, health checks, secret boundaries, provider ports and backups. Later product features are intentionally excluded from this platform plan.
- No placeholders: every task identifies files, interfaces, tests, commands and expected outcomes.
- Type consistency: `AppConfig`, `PlatformDependencies`, `DatabaseProbe`, `CacheProbe` and `ProviderBundle` are introduced before consumers use them.
