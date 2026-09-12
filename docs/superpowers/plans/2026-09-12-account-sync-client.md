# iKuck — client account e sincronizzazione offline

> **For agentic workers:** Execute this plan task-by-task. Keep each checkbox current and do not start the next task before the focused verification of the previous task passes.

**Goal:** Add a browser client for verified iKuck accounts, a durable offline mutation queue and explicit local-data import while preserving the guest-first, local-only pantry experience.

**Scope:** This plan covers the frontend client for the API already implemented in `backend/src/routes/auth.ts`, `backend/src/routes/profile.ts` and `backend/src/routes/sync.ts`. It does not add server endpoints, remote recipe data or external providers.

**Architecture:** Session metadata and the CSRF token live only in the in-memory Zustand auth store. The server session remains an HttpOnly cookie. Pantry and staple changes remain in IndexedDB for guests; account synchronization is opt-in and runs only when the session contains a verified account. Mutations and the sync cursor are stored in the existing `ikuck-local-v2` database, so a reload or temporary network failure cannot discard local work.

**Tech Stack:** React, React Router, Zustand, `idb`, TypeScript, Vitest, Testing Library and Playwright.

## Invariants

- A guest never calls `/v1/sync`, `/v1/profile` or any account endpoint merely by using the pantry.
- A password, session cookie and raw token are never written to localStorage or IndexedDB.
- A successful registration explains that verification is required; registration does not create a local authenticated session.
- Login and session restore keep only the account summary, CSRF token and expiry in memory.
- A network failure changes connection status and leaves the pantry, queue and cursor untouched.
- A mutation is identified by a unique `mutationId`, includes the current `deviceId`, and carries an ISO timestamp.
- Sync sends only mutations for the current device and verified session. Server changes are applied without generating new local mutations.
- Local data is imported only after the user explicitly presses the import action.
- Logout clears in-memory session state and queues remain local but are not sent until a new verified login.
- All source code and comments are English; all visible copy and accessible labels are Italian.

## Task 1: Define the browser API boundary and tests

**Files:**

- Create: `frontend/src/api/apiClient.ts`
- Test: `frontend/src/api/apiClient.test.ts`

### Step 1: Write failing tests

Cover the public request contract before implementation:

```ts
it('uses same-origin credentials and JSON for a request body', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  await apiRequest('/v1/profile', {
    method: 'PATCH',
    body: { displayName: 'Ale' },
    fetch,
  });

  expect(fetch).toHaveBeenCalledWith('/v1/profile', expect.objectContaining({
    credentials: 'include',
    headers: expect.objectContaining({ 'content-type': 'application/json' }),
    body: JSON.stringify({ displayName: 'Ale' }),
  }));
});

it('adds the CSRF header only when a token is supplied', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

  await apiRequest('/v1/profile', { method: 'PATCH', body: {}, csrfToken: 'csrf-1', fetch });
  expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'x-csrf-token': 'csrf-1' });
});

it('returns structured API errors and preserves network errors as offline errors', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ error: 'csrf_failed', message: 'CSRF token is invalid' }),
    { status: 403 },
  ));

  await expect(apiRequest('/v1/profile', { fetch })).rejects.toMatchObject({
    status: 403,
    code: 'csrf_failed',
  });
});
```

### Step 2: Run the focused test and verify it fails

Run:

```bash
cd frontend && npm test -- apiClient.test.ts
```

Expected: FAIL because the API client does not exist.

### Step 3: Implement the minimal client

Export:

```ts
export interface ApiRequestOptions<TBody = unknown> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: TBody;
  csrfToken?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export class ApiClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string);
}

export async function apiRequest<T>(path: string, options?: ApiRequestOptions): Promise<T>;
```

Use relative same-origin paths, `credentials: 'include'`, JSON only when a body exists, and `x-csrf-token` only when supplied. Parse JSON when present, return `undefined` for a successful 204, convert structured server errors into `ApiClientError`, and expose fetch failures with a stable `network_error` code. Never include request bodies or credentials in thrown messages or logs.

### Step 4: Verify Task 1

Run the focused test, lint and TypeScript build. Do not commit if the client can send credentials to an absolute or cross-origin URL.

## Task 2: Add in-memory authentication state

**Files:**

- Create: `frontend/src/auth/authStore.ts`
- Test: `frontend/src/auth/authStore.test.ts`

### Step 1: Write failing state tests

Cover:

- initial state is unauthenticated and contains no token;
- successful `restoreSession` populates `user`, `csrfToken`, `expiresAt`;
- an unauthenticated session response clears prior state;
- network failure sets `connection: 'offline'` without modifying pantry state;
- logout clears all session metadata;
- raw tokens are not present in `localStorage` or IndexedDB after store actions.

Use an injected `apiRequest` mock so normal tests never need a server.

### Step 2: Run the focused test and verify it fails

Run:

```bash
cd frontend && npm test -- authStore.test.ts
```

Expected: FAIL because the auth store does not exist.

### Step 3: Implement the session model

Export:

```ts
export type ConnectionState = 'unknown' | 'online' | 'offline';

export interface AuthUser {
  id: string;
  email: string;
  emailVerifiedAt: string;
}

export interface AuthState {
  user: AuthUser | null;
  csrfToken: string | null;
  expiresAt: string | null;
  connection: ConnectionState;
  isLoading: boolean;
  restoreSession: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  clearSession: () => void;
}
```

Do not wrap this store in Zustand `persist`. `restoreSession` calls `GET /v1/auth/session` on app startup, treats `authenticated: false` as a normal guest state, and maps network failures to `offline`. Login must accept only a response with a non-empty verified timestamp. Server errors are rethrown as `ApiClientError` for forms to render stable Italian feedback.

### Step 4: Verify Task 2

Run `authStore.test.ts`, lint and build. Inspect the generated browser storage in tests to confirm that only pantry/queue data is persisted.

## Task 3: Add durable queue and sync cursor storage

**Files:**

- Modify: `frontend/src/storage/indexedDb.ts`
- Create: `frontend/src/sync/syncQueue.ts`
- Test: `frontend/src/sync/syncQueue.test.ts`

### Step 1: Write failing queue tests

Cover:

```ts
it('creates a device id once without storing an account secret', async () => {
  const first = await getDeviceId();
  const second = await getDeviceId();
  expect(second).toBe(first);
  expect(await readMeta('deviceId')).toBe(first);
});

it('queues mutations in timestamp order and removes them only after sync succeeds', async () => {
  await enqueueMutation(sampleMutation('m-2', '2026-09-12T12:02:00.000Z'));
  await enqueueMutation(sampleMutation('m-1', '2026-09-12T12:01:00.000Z'));
  expect((await readQueuedMutations()).map(({ mutationId }) => mutationId)).toEqual(['m-1', 'm-2']);
});

it('keeps the queue when the sync request fails', async () => {
  await enqueueMutation(sampleMutation());
  await expect(syncNow({ fetch: rejectingFetch, session: verifiedSession() })).rejects.toMatchObject({ code: 'network_error' });
  await expect(readQueuedMutations()).resolves.toHaveLength(1);
});

it('applies server changes without re-enqueuing them and advances the cursor', async () => {
  await syncNow({ fetch: successfulSyncFetch, session: verifiedSession() });
  await expect(readQueuedMutations()).resolves.toEqual([]);
  await expect(readSyncCursor()).resolves.toBe(4);
});
```

### Step 2: Run the focused test and verify it fails

Run:

```bash
cd frontend && npm test -- syncQueue.test.ts
```

Expected: FAIL because queue helpers do not exist.

### Step 3: Extend the IndexedDB adapter

Add typed helpers for the existing `syncQueue` and `syncMeta` stores. Keep the key-value store used by the pantry unchanged. Queue records must use `mutationId` as key path and include `createdAt` for deterministic ordering. Store the cursor under `syncMeta/cursor` and a random UUID under `syncMeta/deviceId`; generate a UUID with `crypto.randomUUID()` and use a secure random fallback only when that API is unavailable. Do not put the authenticated email, CSRF token or session cookie in either store.

### Step 4: Implement the queue and sync workflow

Export:

```ts
export interface SyncSession {
  userId: string;
  emailVerifiedAt: string;
  csrfToken: string;
}

export function createPantryMutation(entityType: SyncEntityType, entityId: string, operation: SyncOperation, payload: unknown | null): Promise<SyncMutation>;
export function enqueueMutation(mutation: SyncMutation): Promise<void>;
export function readQueuedMutations(): Promise<SyncMutation[]>;
export function readSyncCursor(): Promise<number>;
export function syncNow(input: { fetch?: typeof globalThis.fetch; session: SyncSession }): Promise<SyncChangeSet>;
export function syncOnReconnect(getSession: () => SyncSession | null): () => void;
```

`syncNow` must reject before calling the API if `emailVerifiedAt` or CSRF token is missing. Send the current device id, cursor and at most 100 queued mutations to `/v1/sync`. Remove only the mutation ids accepted by a successful response, apply `upsert` and `delete` changes to the local pantry snapshot, and advance the cursor monotonically. A response containing a newer server version wins; a failed request leaves queue and cursor intact. Serialize concurrent sync calls so reconnect and a button press cannot duplicate destructive work. `syncOnReconnect` attaches a single `online` listener and returns an unsubscribe function.

### Step 5: Verify Task 3

Run queue, API and auth tests together. Add a regression that a guest mutation is present in IndexedDB but the injected fetch is never called. Run lint and build.

## Task 4: Wire pantry mutations to the queue safely

**Files:**

- Modify: `frontend/src/store/localPantryStore.ts`
- Test: `frontend/src/store/__tests__/pantryStore.test.ts`
- Modify: `frontend/src/test/setup.ts` if needed for deterministic UUID and IndexedDB cleanup

### Step 1: Write failing store integration tests

Cover add ingredient, remove ingredient and staple toggle. Each action should queue the resulting entity mutation with a new timestamp. Verify duplicate UI additions remain idempotent, local state updates immediately, and applying a remote change does not queue a second mutation. Keep existing recipe availability tests unchanged.

### Step 2: Implement mutation hooks

Generate mutations after the in-memory state transition so a queue failure does not roll back the usable guest UI. Use `pantry_item/<id>` and `staple_preference/<id>` entity ids consistently. The local snapshot remains the source for guest behavior. Add a private `applyRemoteChanges` action used by `syncQueue.ts`; this action updates local state with persistence suppressed and never calls `enqueueMutation`.

### Step 3: Connect account login and reconnect

After a verified login, do not silently upload local data. Expose an explicit `importLocalData` action that enqueues the current pantry and staple snapshot, calls `syncNow`, and reports completion. Start reconnect synchronization only while a verified session exists. On logout, remove the listener but leave guest data and unsent queue records intact.

### Step 4: Verify Task 4

Run all store, queue, auth and API tests, then lint/build. Confirm that the existing no-login recipe path still performs no network request.

## Task 5: Build account and verification screens

**Files:**

- Create: `frontend/src/components/account/AccountPanel.tsx`
- Create: `frontend/src/pages/ProfilePage.tsx`
- Create: `frontend/src/pages/VerifyEmailPage.tsx`
- Create: `frontend/src/pages/ResetPasswordPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`
- Test: `frontend/src/components/account/AccountPanel.test.tsx`
- Test: `frontend/src/pages/ProfilePage.test.tsx`
- Test: `frontend/src/pages/VerifyEmailPage.test.tsx`
- Test: `frontend/src/pages/ResetPasswordPage.test.tsx`
- Modify: `frontend/src/test/HomePage.test.tsx`

### Step 1: Write failing component tests

Cover:

- guest Home shows a compact account entry point and states that pantry data stays on the device;
- registration validates the 12-character minimum, submits once and explains verification;
- login renders `email_not_verified` without pretending the user is logged in;
- resend verification and password-reset request show generic success copy;
- verified profile offers explicit “Importa la dispensa”, “Esporta i miei dati”, logout and delete controls;
- delete requires a second confirmation and clears the session after success;
- `/verify-email?token=...` calls verification once, never displays the raw token, and links back to login/profile.

### Step 2: Run focused component tests and verify they fail

Run:

```bash
cd frontend && npm test -- AccountPanel.test.tsx ProfilePage.test.tsx VerifyEmailPage.test.tsx HomePage.test.tsx
```

Expected: FAIL because the account components and routes do not exist.

### Step 3: Implement the UI

Use accessible native forms and existing Tailwind visual language. Keep Home useful for guests even when session restore fails. Add routes:

- `/profile` → `ProfilePage`;
- `/verify-email` → `VerifyEmailPage`;
- `/reset-password` → password reset form handled by the account panel/page.

The profile page must load and save display name only for an authenticated session, use the CSRF token in PATCH/DELETE/logout calls, and use a Blob download for the export response without persisting the returned data. Import controls must show a clear local-to-account confirmation and a result state for queued, synchronized or offline work. Use generic Italian feedback for account recovery to avoid email enumeration.

### Step 4: Verify Task 5

Run all frontend unit/component tests, lint and build. Manually inspect the desktop page through the local dev server after the route additions if the browser harness is available.

## Task 6: Complete client verification and commit

### Step 1: Run the complete frontend check

Run:

```bash
cd frontend && npm test && npm run lint && npm run build && npm run test:e2e
```

If Playwright cannot start because the browser binary or service is unavailable, record the exact external blocker in the plan and do not replace it with an unverified claim.

### Step 2: Review safety and diff

Run `git diff --check`. Inspect changed files for raw token persistence, absolute API URLs, accidental automatic import, queue deletion before a successful response, and user-facing English copy. Preserve `E2E_VERIFICATION.md` and leave unrelated changes unstaged.

### Step 3: Commit the completed client block

```bash
git add frontend/src/api frontend/src/auth frontend/src/sync frontend/src/storage frontend/src/components/account frontend/src/pages/ProfilePage.tsx frontend/src/pages/VerifyEmailPage.tsx frontend/src/App.tsx frontend/src/pages/HomePage.tsx frontend/src/store frontend/src/test frontend/package.json frontend/package-lock.json docs/superpowers/plans/2026-09-12-account-sync-client.md docs/superpowers/plans/2026-09-12-accounts-and-sync.md
git commit -m "feat: add offline account sync client"
```

## Plan self-review

- Guest safety is tested at API, queue, store and UI boundaries.
- Verification gating is represented in both server response handling and visible form states.
- The server remains the owner of cookies and account identity; the browser stores only ephemeral session metadata.
- Queue idempotency, cursor advancement and server-side last-write-wins are covered without requiring external services.
- Import is an explicit user action, so a verified login cannot unexpectedly upload a guest pantry.
- The existing IndexedDB adapter and `E2E_VERIFICATION.md` are preserved.
