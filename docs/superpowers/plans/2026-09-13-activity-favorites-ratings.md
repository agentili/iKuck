# iKuck — activity history, favorites and ratings

> **Status:** superseded as the current roadmap by the [remediation index](2026-09-14-remediation-index.md); retained as historical implementation context.

> **For agentic workers:** Execute this plan task-by-task. Keep each checkbox current, run the focused verification before moving on, and commit the plan and implementation as separate reviewable units.

**Goal:** Record recipes cooked by the user, allow private favorites and 1–5 star ratings with a private note, and synchronize these personal signals for verified accounts without changing pantry lots automatically.

**Scope:** This plan covers the fifth product block: shared activity/preference contracts, offline storage, authenticated APIs and sync, the activity page, recipe detail controls and browser coverage. It does not implement diet filters, allergen constraints, nutrition, AI recipe generation or automatic suggestion ranking.

**Architecture:** A `CookEvent` is an append-like user activity record with a recipe snapshot and cooking timestamp. A `RecipePreference` is the current user-owned preference for one recipe and is synchronized by recipe id. Both use the existing IndexedDB key-value store for guests and the existing last-write-wins sync repository for verified accounts. Private notes are never sent to public recipe catalog data.

**Compatibility decisions:** Marking a recipe as cooked records the event only; it never subtracts, edits or deletes pantry lots. Favorite, rating and note changes are explicit user actions. A preference with no favorite, rating or note can be removed locally and represented as a delete mutation remotely. Curated recipe ids remain stable, and future private AI recipes can use the same string identifiers.

**Tech Stack:** React, Zustand, IndexedDB through `idb`, Fastify, the existing Drizzle/PostgreSQL sync records, Zod, Vitest, Testing Library and Playwright.

## Invariants

- Guests can record activity and preferences offline after the app has loaded once.
- A cook event contains a stable id, recipe id, recipe title snapshot, positive servings, ISO `cookedAt` and a nullable private note.
- A recipe preference contains a stable recipe id, favorite flag, nullable integer rating from 1 to 5, nullable private note and ISO timestamps.
- Activity is append-oriented and can be removed explicitly; it never changes pantry state.
- Preference writes are idempotent per recipe id and last-write-wins per entity.
- Remote changes update local storage without creating a second outgoing mutation.
- Authenticated API reads and writes are scoped to the current user; state-changing requests require CSRF and same-origin checks.
- Explicit account import includes local activity and preferences together with pantry and shopping-list data.
- Private notes are returned only to the authenticated account and are excluded from public recipe responses.
- Source code, tests and comments are English; visible UI copy and accessible labels are Italian.
- `E2E_VERIFICATION.md` and unrelated user changes remain unstaged.

## Task 1: Define shared contracts and pure validation helpers

**Files:**

- Modify: `shared/src/contracts.ts`
- Create: `frontend/src/domain/activity.ts`
- Create: `frontend/src/domain/__tests__/activity.test.ts`
- Create: `backend/src/activity/validation.ts`
- Modify: `backend/src/contracts/contracts.test.ts`

**Interfaces:**

- Add `cook_event` and `recipe_preference` to `SyncEntityType`.
- Add `CookEventPayload`, `CookEvent`, `RecipePreferencePayload` and `RecipePreference`.
- Add pure helpers for rating/note/servings validation and preference emptiness.

- [x] **Step 1: Write failing contract and domain tests**

Cover:

- valid cook events with a nullable note;
- rejection of blank recipe ids/titles, zero servings and invalid timestamps;
- valid ratings from 1 to 5 and nullable ratings;
- rejection of fractional/out-of-range ratings and overlong notes;
- detection of an empty preference that can be deleted;
- JSON serialization of private notes without exposing unrelated fields.

- [x] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd frontend && npm test -- activity.test.ts
cd ../backend && npm test -- contracts.test.ts
```

Expected: FAIL because the new contracts and domain helpers do not exist.

- [x] **Step 3: Implement the smallest typed contracts and helpers**

Use nullable fields rather than sentinel strings, enforce a 1–5 integer rating and keep event/preference validation independent from pantry quantity logic. Keep recipe title snapshots for resilient history display.

- [x] **Step 4: Verify Task 1**

Run the focused suites, frontend lint/typecheck and backend lint/build. Confirm all existing entity types remain supported.

## Task 2: Persist activity and preferences locally and extend explicit import

**Files:**

- Create: `frontend/src/storage/activityStorage.ts`
- Create: `frontend/src/storage/activityStorage.test.ts`
- Create: `frontend/src/store/activityStore.ts`
- Create: `frontend/src/store/__tests__/activityStore.test.ts`
- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/sync/syncQueue.test.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**

- Add local readers/writers for activity events and recipe preferences in separate IndexedDB keys.
- Expose `useActivityStore` with hydration, `recordCookEvent`, event removal/clear, preference read/write and preference removal actions.
- Register activity/preference snapshot listeners beside pantry and shopping-list listeners.

- [x] **Step 1: Write failing storage, store and queue tests**

Cover:

- empty and malformed local state normalizes safely;
- events and preferences round-trip without losing private notes;
- recording a recipe is immediate and does not change pantry lots;
- setting a favorite/rating/note is immediate and replacing it is idempotent;
- invalid ratings are rejected;
- activity and preference mutations are queued with the correct entity types;
- remote changes update local state without re-enqueueing;
- explicit import includes both collections.

- [x] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd frontend && npm test -- activityStorage.test.ts activityStore.test.ts syncQueue.test.ts
```

Expected: FAIL because no local activity store or sync handling exists.

- [x] **Step 3: Implement version-tolerant local persistence**

Use the existing local database and separate key-value entries. Normalize and deduplicate by stable id or recipe id. Keep write failures non-destructive to in-memory state and serialize writes in order.

- [x] **Step 4: Extend sync and explicit import**

Apply event/preference changes to their local snapshots, notify the store and never enqueue while applying server changes. Queue activity and preferences during explicit account import only.

- [x] **Step 5: Verify Task 2**

Run all frontend unit tests, lint, typecheck and build. Confirm a cook action leaves the pantry lot snapshot byte-for-byte unchanged.

## Task 3: Add authenticated activity and preference APIs

**Files:**

- Create: `backend/src/routes/activity.ts`
- Create: `backend/src/routes/activity.test.ts`
- Create: `backend/src/routes/recipePreferences.ts`
- Create: `backend/src/routes/recipePreferences.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/routes/sync.ts`
- Modify: `backend/src/routes/sync.test.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`

**Interfaces:**

- Add authenticated `GET /v1/activity`, `POST /v1/activity`, `DELETE /v1/activity/:eventId` and `DELETE /v1/activity`.
- Add authenticated `GET /v1/recipes/preferences`, `PUT /v1/recipes/preferences/:recipeId` and `DELETE /v1/recipes/preferences/:recipeId`.
- Reuse the sync repository as the durable source of truth, with resource mutations mapped to `cook_event` and `recipe_preference`.

- [x] **Step 1: Write failing API and integration-contract tests**

Cover authenticated event CRUD, preference replacement and deletion, invalid ratings, CSRF/origin rejection, account isolation and private-note response behavior. Extend the dedicated-service integration contract to create/read an event and preference.

- [x] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd backend && npm test -- activity.test.ts recipePreferences.test.ts sync.test.ts
```

Expected: FAIL because the routes and sync entity validation do not exist.

- [x] **Step 3: Implement scoped resource routes**

Use only the authenticated session user id. Require same-origin and CSRF validation for all writes, reject malformed payloads with stable errors and exclude deleted/malformed records from reads. Never expose private notes through a public route.

- [x] **Step 4: Verify Task 3**

Run backend focused/full tests, lint and build. Run the PostgreSQL/Redis integration suite when dedicated URLs are available; otherwise record the exact skip.

## Task 4: Build the activity page and recipe preference controls

**Files:**

- Create: `frontend/src/pages/ActivityPage.tsx`
- Create: `frontend/src/components/activity/ActivityPanel.tsx`
- Create: `frontend/src/components/activity/ActivityPanel.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/pages/RecipeDetailPage.tsx`
- Modify: `frontend/src/pages/RecipeDetailPage.test.tsx`

**Interfaces:**

- Add a reachable `Attività` entry and a dedicated page for recent cooked recipes.
- Add explicit “Segna come cucinata”, favorite, 1–5 star rating and private note controls to recipe detail.
- Show activity items with recipe title, date and optional note, with explicit removal/clear actions.

- [x] **Step 1: Write failing component tests**

Cover:

- cooking confirmation and repeat behavior;
- favorite toggle and accessible star rating;
- private note editing and persistence;
- activity rendering, empty state, removal and clear;
- confirmation that cooking leaves the pantry store unchanged;
- usable layout and controls at 320px.

- [x] **Step 2: Run focused component tests and verify they fail**

Run:

```bash
cd frontend && npm test -- ActivityPanel.test.tsx RecipeDetailPage.test.tsx
```

- [x] **Step 3: Implement the accessible UI**

Use buttons with explicit labels rather than color-only state. Make the note visibly private, keep the star controls keyboard-operable, and keep activity actions separate from pantry actions.

- [x] **Step 4: Verify Task 4**

Run component tests and add desktop/mobile Playwright coverage for cooking, preference editing, reload persistence and activity navigation. Confirm the main pantry keyboard flow remains intact.

## Task 5: Full verification, documentation and dedicated commit

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-13-activity-favorites-ratings.md`
- Modify: `docs/superpowers/plans/2026-09-12-accounts-and-sync.md` only if the explicit import cross-reference needs updating

- [x] **Step 1: Run the complete verification set**

Run:

```bash
cd backend && npm test && npm run lint && npm run build
cd ../frontend && npm test && npm run lint && npx tsc --noEmit && npm run build && npm run test:e2e
```

Run dedicated PostgreSQL/Redis integration only when the service URLs are available, and container smoke only when Docker is available.

- [x] **Step 2: Review data and security boundaries**

Run `git diff --check` and inspect that cooking never mutates pantry lots, notes remain account-scoped, all writes use CSRF and same-origin checks, and server changes do not re-enqueue.

- [x] **Step 3: Update user documentation and checklist**

Document activity, favorites, 1–5 ratings, private notes, explicit cooking semantics and the fact that the pantry is not consumed automatically.

- [x] **Step 4: Commit the completed feature block**

```bash
git add shared backend frontend README.md docs/superpowers/plans/2026-09-13-activity-favorites-ratings.md
git commit -m "feat: add activity favorites and ratings"
```

## Plan self-review

- Activity is a personal record, not an inventory transaction.
- Preference data is private and replaceable per recipe.
- Guests retain offline functionality, while account sync remains explicit and verified.
- Future private AI recipe ids can reuse the same preference and activity boundaries.

## Verification record

- Frontend focused activity tests: 19 tests passed.
- Frontend full Vitest suite: 27 files and 133 tests passed.
- Frontend lint and production build: passed.
- Backend focused activity/sync tests: 10 tests passed.
- Backend full Vitest suite: 17 files and 40 tests passed; 2 PostgreSQL/Redis integration tests skipped because dedicated service URLs were not configured.
- Backend lint and TypeScript build: passed.
- Playwright desktop/mobile suite: 22 tests passed, including activity persistence and the 320px keyboard flow.
- Docker runtime smoke test: not executed because the local Docker Linux engine was unavailable; deployment contract tests remain covered by the backend suite.
