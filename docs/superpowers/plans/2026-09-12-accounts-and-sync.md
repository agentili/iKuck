# Accounts and Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add verified email accounts, secure browser sessions, local-to-remote import and offline last-write-wins synchronization while keeping the guest PWA fully local and usable without an account.

**Architecture:** The API owns account identity, sessions, verification tokens and per-entity synchronization records in PostgreSQL. Redis remains an operational dependency but is not used as the source of account or pantry data. The browser stores guest state, pending mutations and the last sync cursor in IndexedDB; it sends queued mutations only after a verified session exists.

**Tech Stack:** Fastify 5, TypeScript, Zod, Drizzle ORM, PostgreSQL, Redis, Argon2id, Resend HTTP API, React, Zustand, IndexedDB through `idb`, Vitest, Testing Library and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-12-synchronized-ikuck-design.md`

## Global Constraints

- Guests remain offline-first and never send pantry data to the API.
- Registration, synchronization and account recovery require email verification before remote data access.
- Passwords use Argon2id; sessions use secure HttpOnly cookies and CSRF protection.
- Existing `ikuck-pantry-v1` and legacy `iricetto-pantry-v1` data is migrated into IndexedDB before synchronization starts.
- Conflict resolution is last-write-wins per entity using the client modification timestamp and a deterministic mutation id tie-breaker.
- Passwords, session tokens, verification tokens, reset tokens, pantry payloads and email addresses are never logged.
- Source code and comments remain in English; user-facing copy remains Italian.
- `E2E_VERIFICATION.md` is preserved and never staged.

---

### Task 1: Define shared sync contracts and account persistence

**Files:**
- Create: `shared/package.json`
- Create: `shared/src/contracts.ts`
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Modify: `backend/src/db/schema.ts`
- Create: `backend/src/db/migrations/0001_accounts_and_sync.sql`
- Test: `backend/src/contracts/contracts.test.ts`

**Interfaces:**
- Produces `SyncMutation`, `SyncChange`, `SyncChangeSet`, `SyncEntityType` and `AccountSummary` from `@ikuck/shared/contracts`.
- Produces PostgreSQL tables for users, sessions, verification tokens, password-reset tokens, sync items and processed mutation ids.
- Consumes the existing `service_metadata` migration without changing or deleting it.

- [ ] **Step 1: Write failing contract and migration tests**

```ts
it('keeps sync mutations entity-scoped and serializable', () => {
  const mutation: SyncMutation = {
    mutationId: 'mutation-1',
    deviceId: 'device-1',
    entityType: 'pantry_item',
    entityId: 'tomato',
    operation: 'upsert',
    payload: { id: 'tomato', label: 'Pomodoro', known: true },
    clientUpdatedAt: '2026-09-12T12:00:00.000Z',
  };

  expect(JSON.parse(JSON.stringify(mutation))).toEqual(mutation);
});

it('contains the account and sync tables in the first feature migration', () => {
  expect(readMigration('0001_accounts_and_sync.sql')).toContain('CREATE TABLE "users"');
  expect(readMigration('0001_accounts_and_sync.sql')).toContain('CREATE TABLE "sync_items"');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd backend && npm test -- contracts.test.ts`

Expected: FAIL because the shared package, contracts and migration do not exist.

- [ ] **Step 3: Add the shared package and exact contracts**

Define the entities used by the API and browser:

```ts
export type SyncEntityType = 'pantry_item' | 'staple_preference';
export type SyncOperation = 'upsert' | 'delete';

export interface SyncMutation {
  mutationId: string;
  deviceId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: unknown | null;
  clientUpdatedAt: string;
}

export interface SyncChange extends SyncMutation {
  serverSequence: number;
}

export interface SyncChangeSet {
  changes: SyncChange[];
  nextCursor: number;
}

export interface AccountSummary {
  id: string;
  email: string;
  emailVerifiedAt: string;
}
```

Use a local `file:../shared` dependency in backend and frontend so both TypeScript projects consume the same type declarations without bundling server code into the PWA.

- [ ] **Step 4: Add the PostgreSQL schema and migration**

Create UUID users with unique normalized email, Argon2id password hash and verification timestamp. Store only SHA-256 hashes of opaque session, verification and reset tokens. Store sync items by `(user_id, entity_type, entity_id)` with JSONB payload, tombstone flag, client timestamp, mutation id and monotonically increasing server sequence. Store processed mutation ids with a unique `(user_id, mutation_id)` constraint for idempotent retries. Add cascading foreign keys, indexes on user/session expiry and `(user_id, server_sequence)`.

- [ ] **Step 5: Run migration-independent checks and commit**

Run: `cd backend && npm test -- contracts.test.ts && npm run lint && npm run build`

Expected: focused tests, lint and TypeScript build pass.

```bash
git add shared backend/package.json frontend/package.json backend/src/db/schema.ts backend/src/db/migrations/0001_accounts_and_sync.sql backend/src/contracts/contracts.test.ts
git commit -m "feat: add account and sync persistence contracts"
```

### Task 2: Implement password, token and email provider services

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/providers/types.ts`
- Modify: `backend/src/providers/factory.ts`
- Create: `backend/src/providers/resend.ts`
- Create: `backend/src/auth/crypto.ts`
- Create: `backend/src/auth/crypto.test.ts`
- Create: `backend/src/auth/tokens.ts`
- Create: `backend/src/auth/tokens.test.ts`

**Interfaces:**
- Produces `hashPassword`, `verifyPassword`, `hashOpaqueToken` and `createOpaqueToken`.
- Produces `createResendEmailProvider({ apiKey, from, fetch })` without performing network I/O during construction.
- Consumes the existing `EmailProvider` port and returns `ProviderUnavailableError` when Resend configuration is absent.

- [ ] **Step 1: Write failing crypto and provider tests**

```ts
it('verifies an Argon2id password hash and rejects a different password', async () => {
  const hash = await hashPassword('Correct horse battery staple!');
  await expect(verifyPassword(hash, 'Correct horse battery staple!')).resolves.toBe(true);
  await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
});

it('sends verification mail through the Resend HTTP boundary', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
  const provider = createResendEmailProvider({ apiKey: 'test-key', from: 'no-reply@ikuck.example', fetch });

  await expect(provider.send({ to: 'user@example.com', subject: 'Verify', html: '<p>Verify</p>' }))
    .resolves.toEqual({ messageId: 'email-1' });
  expect(fetch).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({ method: 'POST' }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npm test -- crypto.test.ts tokens.test.ts`

Expected: FAIL because Argon2id helpers, token helpers and the Resend adapter do not exist.

- [ ] **Step 3: Add Argon2id and opaque-token helpers**

Use `argon2` with `argon2id`, memory cost 19456 KiB, time cost 2 and parallelism 1. Generate at least 32 random bytes for every opaque token, return the raw token only to the caller and persist only its SHA-256 digest. Use constant-time comparison for token digests and reject expired or already-consumed tokens in the service layer.

- [ ] **Step 4: Add the Resend adapter and provider selection**

POST `{ from, to: [message.to], subject, html }` to `https://api.resend.com/emails` with `Authorization: Bearer <key>`. Treat non-2xx responses as a typed provider error without including response bodies in logs. Update `createProviders` to select this adapter only when both `RESEND_API_KEY` and `RESEND_FROM` are configured.

- [ ] **Step 5: Run focused tests and commit**

Run: `cd backend && npm test -- crypto.test.ts tokens.test.ts factory.test.ts && npm run lint && npm run build`

Expected: all focused tests, lint and build pass; no request is sent by provider construction.

```bash
git add backend/package.json backend/package-lock.json backend/src/providers backend/src/auth
git commit -m "feat: add password and verification email services"
```

### Task 3: Add verified account lifecycle, cookies and CSRF-protected auth routes

**Files:**
- Create: `backend/src/auth/repository.ts`
- Create: `backend/src/auth/service.ts`
- Create: `backend/src/auth/service.test.ts`
- Create: `backend/src/routes/auth.ts`
- Create: `backend/src/routes/auth.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/config.ts`

**Interfaces:**
- Produces `POST /v1/auth/register`, `GET /v1/auth/verify-email`, `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/auth/session`, `POST /v1/auth/request-password-reset` and `POST /v1/auth/reset-password`.
- Produces `AuthSession` request decoration with `userId`, `email` and `csrfToken` for protected routes.
- Consumes `EmailProvider`, token helpers and the account tables through an injectable `AuthRepository`.

- [ ] **Step 1: Write failing service and route tests**

```ts
it('does not permit login before email verification', async () => {
  const service = createAuthService({ repository: unverifiedUserRepository(), email: fakeEmailProvider() });
  await expect(service.login({ email: 'user@example.com', password: 'password' }))
    .rejects.toMatchObject({ code: 'email_not_verified' });
});

it('sets an HttpOnly session cookie only after a verified login', async () => {
  const app = createTestApp({ user: verifiedUser(), password: 'password' });
  const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
    email: 'user@example.com', password: 'password',
  }, headers: { origin: 'http://127.0.0.1:5173' } });

  expect(response.statusCode).toBe(200);
  expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
    expect.stringContaining('HttpOnly'),
  ]));
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `cd backend && npm test -- service.test.ts auth.test.ts`

Expected: FAIL because the auth service, repository and routes do not exist.

- [ ] **Step 3: Implement the repository and lifecycle service**

Normalize emails with trim and lowercase. Registration rejects passwords shorter than 12 characters, creates the user, creates a 24-hour verification token and sends a link to `${APP_ORIGIN}/verify-email?token=<raw-token>`. Verification consumes the token atomically and sets `email_verified_at`. Login verifies Argon2id, rejects unverified users, creates a 30-day session and a separate CSRF token. Password reset requests always return the same generic response; existing users receive a one-hour reset link. Resetting a password consumes the token and revokes all sessions.

- [ ] **Step 4: Implement cookie and CSRF boundaries**

Use cookie name `ikuck_session`, `HttpOnly`, `SameSite=Lax`, `Path=/` and `Secure` only in production. Validate the `Origin` header against `APP_ORIGIN` on every state-changing request. Require `x-csrf-token` to match the session token digest on authenticated state-changing requests. Never accept a session token from query strings, JSON bodies or localStorage. Return stable error codes such as `invalid_credentials`, `email_not_verified`, `email_already_registered`, `invalid_token` and `csrf_failed` without account enumeration details.

- [ ] **Step 5: Wire routes and server dependencies**

Extend `PlatformDependencies` with injectable auth services and pass the real Drizzle repository plus selected email provider from `server.ts`. Keep `createApp` usable with only health probes so existing health tests remain isolated. Add Zod request schemas with bounded email, password and token lengths.

- [ ] **Step 6: Run focused tests and commit**

Run: `cd backend && npm test -- service.test.ts auth.test.ts health.test.ts && npm run lint && npm run build`

Expected: lifecycle, cookie, CSRF and health tests pass.

```bash
git add backend/src/auth backend/src/routes/auth.ts backend/src/routes/auth.test.ts backend/src/app.ts backend/src/server.ts backend/src/config.ts
git commit -m "feat: add verified account authentication"
```

### Task 4: Add profile, export, deletion and server-side sync API

**Files:**
- Create: `backend/src/profile/repository.ts`
- Create: `backend/src/routes/profile.ts`
- Create: `backend/src/routes/profile.test.ts`
- Create: `backend/src/sync/repository.ts`
- Create: `backend/src/sync/repository.test.ts`
- Create: `backend/src/routes/sync.ts`
- Create: `backend/src/routes/sync.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Produces `GET /v1/profile`, `PATCH /v1/profile`, `GET /v1/profile/export` and `DELETE /v1/profile`.
- Produces `POST /v1/sync` with body `{ deviceId, cursor, mutations }` and `SyncChangeSet` response.
- Consumes the authenticated session from Task 3 and the shared sync contracts from Task 1.

- [ ] **Step 1: Write failing repository and route tests**

```ts
it('keeps the newer mutation and ignores an older mutation for the same entity', async () => {
  const repository = createMemorySyncRepository();
  await repository.applyMutation(newerMutation('tomato', '2026-09-12T12:00:00.000Z'));
  const result = await repository.applyMutation(olderMutation('tomato', '2026-09-12T11:00:00.000Z'));

  expect(result.applied).toBe(false);
  expect(await repository.readEntity('pantry_item', 'tomato')).toMatchObject({ label: 'Pomodoro' });
});

it('exports and deletes only the authenticated account data', async () => {
  const app = createAuthenticatedTestApp();
  const exportResponse = await app.inject({ method: 'GET', url: '/v1/profile/export', headers: authHeaders() });
  expect(exportResponse.statusCode).toBe(200);
  expect(exportResponse.json()).toMatchObject({ account: expect.any(Object), sync: expect.any(Array) });

  const deleteResponse = await app.inject({ method: 'DELETE', url: '/v1/profile', headers: authHeaders({ csrf: true }) });
  expect(deleteResponse.statusCode).toBe(204);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- repository.test.ts profile.test.ts sync.test.ts`

Expected: FAIL because profile and sync repositories/routes do not exist.

- [ ] **Step 3: Implement per-user profile and account lifecycle operations**

Keep profile fields minimal (`displayName` and `updatedAt`) so later diet preferences can extend the same boundary. Export a JSON document containing account summary, profile and sync entities, never password hashes, token digests or sessions. Delete the user in one transaction with cascading data and return `204` after revoking all sessions.

- [ ] **Step 4: Implement transactional LWW sync**

Validate at most 100 mutations per request and 100 KB per payload. For each mutation, insert its idempotency key; if it already exists, do not apply it again. Lock the entity row, compare `clientUpdatedAt`, then `mutationId` on ties, and update only when the incoming mutation wins. Assign a server sequence to every accepted state change, including tombstones. Return all changes after the requested cursor plus changes accepted from the current request, capped at 200 and with `nextCursor` equal to the highest returned sequence.

- [ ] **Step 5: Register versioned routes and run focused checks**

Run: `cd backend && npm test -- repository.test.ts profile.test.ts sync.test.ts auth.test.ts && npm run lint && npm run build`

Expected: isolation, export/delete, idempotency, LWW and route authentication tests pass.

```bash
git add backend/src/profile backend/src/sync backend/src/routes/profile.ts backend/src/routes/profile.test.ts backend/src/routes/sync.ts backend/src/routes/sync.test.ts backend/src/app.ts backend/src/server.ts
git commit -m "feat: add profile and last-write-wins sync API"
```

### Task 5: Migrate guest persistence from localStorage to IndexedDB

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/src/storage/indexedDb.ts`
- Create: `frontend/src/storage/indexedDb.test.ts`
- Create: `frontend/src/storage/pantryStorage.ts`
- Create: `frontend/src/storage/pantryStorage.test.ts`
- Modify: `frontend/src/store/localPantryStore.ts`
- Modify: `frontend/src/store/__tests__/pantryStore.test.ts`
- Modify: `frontend/src/test/setup.ts`

**Interfaces:**
- Produces an async `KeyValueStore` backed by IndexedDB with a localStorage fallback for browsers that disable IndexedDB.
- Produces `migrateLegacyPantry()` that imports `ikuck-pantry-v1` or `iricetto-pantry-v1` once before normal IndexedDB reads.
- Preserves the existing `usePantryStore` action names and recipe behavior.

- [x] **Step 1: Write failing storage tests**

```ts
it('imports the iKuck localStorage snapshot into IndexedDB once', async () => {
  window.localStorage.setItem('ikuck-pantry-v1', JSON.stringify({
    state: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'] },
    version: 1,
  }));

  await migrateLegacyPantry();

  await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'pasta' }] });
  expect(window.localStorage.getItem('ikuck-pantry-v1')).toBeNull();
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- indexedDb.test.ts pantryStorage.test.ts`

Expected: FAIL because the IndexedDB adapter and migration do not exist.

- [x] **Step 3: Add IndexedDB stores and test polyfill**

Use database name `ikuck-local-v2` with stores `keyValue`, `syncQueue` and `syncMeta`. Store JSON snapshots under `pantry`. Use `fake-indexeddb` in the Vitest setup. Keep the localStorage fallback scoped to the same keys and delete a legacy snapshot only after the IndexedDB write succeeds.

- [x] **Step 4: Replace Zustand persistence without changing the public store API**

Use an asynchronous Zustand storage adapter, expose `hasHydrated` through the store, and render a short Italian loading state until rehydration finishes. Existing add/remove/toggle/reset behavior and default staples must remain unchanged. A failed IndexedDB write must leave the in-memory state usable and must not erase the last valid snapshot.

- [x] **Step 5: Update unit and browser regression tests and commit**

Run: `cd frontend && npm test -- indexedDb.test.ts pantryStorage.test.ts pantryStore.test.ts && npm run lint && npm run build`

Expected: migration, fallback, persistence and existing pantry tests pass.

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/storage frontend/src/store/localPantryStore.ts frontend/src/store/__tests__/pantryStore.test.ts frontend/src/test/setup.ts
git commit -m "feat: migrate guest pantry storage to IndexedDB"
```

### Task 6: Add offline mutation queue, session client and account UI

**Files:**
- Create: `frontend/src/api/apiClient.ts`
- Create: `frontend/src/api/apiClient.test.ts`
- Create: `frontend/src/auth/authStore.ts`
- Create: `frontend/src/auth/authStore.test.ts`
- Create: `frontend/src/sync/syncQueue.ts`
- Create: `frontend/src/sync/syncQueue.test.ts`
- Create: `frontend/src/components/account/AccountPanel.tsx`
- Create: `frontend/src/pages/ProfilePage.tsx`
- Create: `frontend/src/pages/VerifyEmailPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/store/localPantryStore.ts`
- Modify: `frontend/src/test/HomePage.test.tsx`

**Interfaces:**
- Produces `apiRequest`, `useAuthStore`, `enqueueMutation`, `syncNow` and `syncOnReconnect`.
- Produces routes `/profile` and `/verify-email` with Italian account forms.
- Consumes the API endpoints from Tasks 3-4 and the IndexedDB stores from Task 5.

- [ ] **Step 1: Write failing client and queue tests**

```ts
it('adds the CSRF header only when a session token is available', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  await apiRequest('/v1/profile', { method: 'PATCH', body: { displayName: 'Ale' }, csrfToken: 'csrf-1', fetch });
  expect(fetch.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }) });
});

it('keeps mutations queued while offline and drains them after connectivity returns', async () => {
  await enqueueMutation(sampleMutation());
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ changes: [], nextCursor: 1 }), { status: 200 }));
  await syncNow({ fetch, session: verifiedSession() });
  await expect(readQueuedMutations()).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `cd frontend && npm test -- apiClient.test.ts authStore.test.ts syncQueue.test.ts`

Expected: FAIL because the client, auth store and sync queue do not exist.

- [ ] **Step 3: Implement the API client and in-memory session state**

Use `credentials: 'include'`, same-origin relative URLs and JSON content types. `GET /v1/auth/session` restores the current account and CSRF token; logout clears only in-memory session state and server cookie. Network errors are represented as offline state, not as destructive local resets.

- [ ] **Step 4: Queue local pantry mutations and synchronize on demand/reconnect**

Add a unique mutation id and ISO timestamp for every pantry/staple change. Guest changes are queued locally but never sent without `emailVerifiedAt`. On explicit account import, enqueue the complete current local snapshot, call `/v1/sync`, apply remote changes without re-enqueuing them, advance the cursor and retry later when `navigator.onLine` changes to true. On conflict, use the server change returned by LWW and keep the queue idempotent.

- [ ] **Step 5: Build account/profile screens**

Add login, registration, verification resend, password-reset request, reset form, logout, import-local-data, export-download and delete-account controls. Explain in Italian that guests remain local and that verification is required for synchronization. Do not display or persist passwords, session cookies or raw tokens. Keep the main pantry flow usable when the API is offline.

- [ ] **Step 6: Run component tests and commit**

Run: `cd frontend && npm test -- apiClient.test.ts authStore.test.ts syncQueue.test.ts HomePage.test.tsx && npm run lint && npm run build`

Expected: queue, CSRF, account state and existing recipe-flow tests pass.

```bash
git add frontend/src/api frontend/src/auth frontend/src/sync frontend/src/components/account frontend/src/pages/ProfilePage.tsx frontend/src/pages/VerifyEmailPage.tsx frontend/src/App.tsx frontend/src/pages/HomePage.tsx frontend/src/store frontend/src/test/HomePage.test.tsx
git commit -m "feat: add offline account sync client"
```

### Task 7: Integration, browser verification and plan handoff

**Files:**
- Create: `backend/src/integration/auth-sync.integration.test.ts`
- Create: `frontend/e2e/account-sync.spec.ts`
- Modify: `frontend/playwright.config.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-12-accounts-and-sync.md`

**Interfaces:**
- Verifies the real API against PostgreSQL and Redis services when the Docker engine is available.
- Verifies guest persistence, registration UI, verification gating, import and offline queue behavior in Chromium desktop and mobile.

- [ ] **Step 1: Add container-backed API integration tests**

Run the API with test-only PostgreSQL/Redis URLs and a fake email provider. Cover register, verify, login, CSRF rejection, sync retry/idempotency, LWW conflict, export and delete. Provider calls stay fake and no real email is sent.

- [ ] **Step 2: Add browser tests**

Cover a guest adding ingredients while offline, reloading and retaining them; a verified user importing the local pantry; a rejected unverified login; and a queued mutation draining after a mocked successful `/v1/sync` response. Run both existing core-flow projects and the new account-sync spec.

- [ ] **Step 3: Run the complete verification set**

Run:

```bash
cd backend && npm test && npm run lint && npm run build
cd ../frontend && npm test && npm run lint && npm run build && npm run test:e2e
```

When Docker is available, also run the integration suite and the standalone Compose smoke test. Expected: all tests pass, guest behavior is unchanged, and no auth secret is present in browser storage or logs.

- [ ] **Step 4: Document operations and commit the completed plan**

Document account environment variables, Resend setup, migration behavior, sync troubleshooting and the fact that guests never synchronize. Verify `git diff --check`, preserve `E2E_VERIFICATION.md`, leave unrelated user changes unstaged and commit:

```bash
git add backend frontend shared README.md docs/superpowers/plans/2026-09-12-accounts-and-sync.md
git commit -m "docs: record verified accounts and sync implementation"
```

## Plan self-review

- Spec coverage: verified email, Argon2id, secure cookies, CSRF, password reset, export/delete, IndexedDB migration, offline queue and per-entity LWW are covered by Tasks 1-7.
- Provider boundary: Resend is HTTP-injected and fakeable; no real provider key is required by ordinary tests.
- Guest safety: the client can persist and use the pantry without an account or API availability, and the sync queue drains only after verified authentication.
- Data safety: remote deletion is explicit, exports omit secrets, token material is hashed, and no raw credential is put in localStorage.
- Type consistency: the shared package owns sync payload shapes; API, repository and browser queue use the same mutation fields and cursor semantics.
