# iKuck — synchronized shopping list

> **For agentic workers:** Execute this plan task-by-task. Keep each checkbox current, run the focused verification before moving on, and commit the plan and implementation as separate reviewable units.

**Goal:** Add one offline-capable shopping list that guests can edit locally and verified accounts can synchronize, with manual entries, recipe-derived missing ingredients, optional quantities and units, and an explicit purchased state.

**Scope:** This plan covers the fourth product block: shared shopping-list contracts, local persistence, authenticated CRUD/sync, the shopping-list UI and recipe integration. It does not implement activity history, favorites, ratings, diet filters, nutrition, AI recipes or automatic suggestions.

**Architecture:** `ShoppingListItem` is an independently synchronized entity stored in the existing IndexedDB key-value store for guests and in the existing last-write-wins sync repository for verified accounts. The browser never sends guest data to the API. Import remains an explicit account action. A shopping item may refer to a catalog ingredient or a custom label, and a recipe source is retained as informational metadata only.

**Compatibility decisions:** Existing pantry matching and lot behavior are unchanged. Adding recipe ingredients never removes or consumes pantry lots. Manual and recipe-created entries share the same list. Quantity and unit are optional; an unparsed recipe amount is preserved as a private note instead of being guessed. Toggling purchased is reversible and does not delete the item. Removing an item is an explicit action.

**Tech Stack:** React, Zustand, IndexedDB through `idb`, Fastify, the existing Drizzle/PostgreSQL sync records, Zod, Vitest, Testing Library and Playwright.

## Invariants

- Guests can read and edit the shopping list offline after the app has loaded once.
- A list item has a stable id, ingredient id, label, nullable positive quantity, nullable unit, nullable note, purchased state, nullable source recipe id and ISO timestamps.
- A quantity requires a compatible explicit unit; an empty quantity means that only the ingredient or custom label is needed.
- Recipe-derived items include only non-optional ingredients that are not already available in the pantry or staples.
- Recipe-derived amounts are parsed only for recognized units; uncertain amounts are preserved in `note` and never converted by guesswork.
- A remote change updates local IndexedDB without creating another outgoing mutation.
- All authenticated API reads and writes are scoped to the current user; write routes require CSRF and same-origin checks.
- Account import remains explicit and imports both pantry and shopping-list data without silently overwriting the local guest state.
- Purchased items remain visible until the user removes them or clears purchased entries explicitly.
- Source code, tests and comments are English; visible UI copy and accessible labels are Italian.
- `E2E_VERIFICATION.md` and unrelated user changes remain unstaged.

## Task 1: Define contracts, validation and recipe-item mapping

**Files:**

- Modify: `shared/src/contracts.ts`
- Create: `frontend/src/domain/shoppingList.ts`
- Create: `frontend/src/domain/__tests__/shoppingList.test.ts`
- Create: `backend/src/shopping/validation.ts`
- Modify: `backend/src/contracts/contracts.test.ts`

**Interfaces:**

- Add `shopping_list_item` to `SyncEntityType`.
- Add `ShoppingListItemPayload` and `ShoppingListItem` using the existing `PantryUnit` union.
- Add pure helpers to validate item details, parse recognized recipe amounts and build a list payload from a recipe ingredient.

- [x] **Step 1: Write failing contract and domain tests**

Cover:

- valid manual items with and without quantity;
- invalid blank labels, non-positive quantities, missing units and unsupported units;
- custom labels and catalog ingredient ids;
- recognized `g`, `kg`, `ml`, `l` and bare piece amounts;
- uncertain amounts such as `q.b.` or `1 spicchio` preserved as notes;
- recipe mapping excludes optional ingredients only at the caller boundary and preserves the source recipe id.

- [x] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd frontend && npm test -- shoppingList.test.ts
cd ../backend && npm test -- contracts.test.ts
```

Expected: FAIL because the shared shopping-list contract and domain helpers do not exist.

- [x] **Step 3: Implement the smallest shared types and pure helpers**

Keep the item payload explicit and JSON-safe. Reuse `PantryUnit`, trim labels, retain nullable fields and use deterministic parsing. Do not make recipe matching or pantry quantities depend on the shopping list.

- [x] **Step 4: Verify Task 1**

Run the focused suites, frontend lint/typecheck and backend lint/build. Confirm the shared contract retains all existing sync entity types.

## Task 2: Persist and mutate the guest shopping list offline

**Files:**

- Create: `frontend/src/storage/shoppingListStorage.ts`
- Create: `frontend/src/storage/shoppingListStorage.test.ts`
- Create: `frontend/src/store/shoppingListStore.ts`
- Create: `frontend/src/store/__tests__/shoppingListStore.test.ts`
- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/sync/syncQueue.test.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**

- Add `readShoppingList`, `writeShoppingList` and normalization that tolerates an empty or malformed local value.
- Expose `useShoppingListStore` with hydration, add, recipe-add, edit, toggle-purchased, remove and clear-purchased actions.
- Register a shopping-list snapshot listener beside the existing pantry listener.

- [x] **Step 1: Write failing storage, store and queue tests**

Cover:

- empty guest state hydrates from IndexedDB;
- item details survive a reload round-trip;
- add/edit/toggle/remove/clear-purchased update the UI state immediately;
- a failed persistence write does not roll back the usable in-memory state;
- recipe-derived items include only missing non-optional ingredients and retain source metadata;
- local mutations are queued as `shopping_list_item` entities;
- server changes update the list without being re-enqueued;
- importing local data includes list items.

- [x] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd frontend && npm test -- shoppingListStorage.test.ts shoppingListStore.test.ts syncQueue.test.ts
```

Expected: FAIL because no shopping-list storage, store or queue handling exists.

- [x] **Step 3: Implement version-tolerant IndexedDB persistence**

Use the existing `ikuck-local-v2` database and a separate key-value entry. Normalize each item before reading, writing or applying a remote change. Preserve nullable fields and do not delete a legacy value before a successful replacement.

- [x] **Step 4: Implement immediate local actions and sync boundaries**

Keep actions responsive, enqueue idempotent mutations after each local transition and apply remote snapshots without enqueueing. Extend explicit account import while preserving the existing pantry import behavior and safe sync ordering.

- [x] **Step 5: Verify Task 2**

Run all frontend unit/component tests, lint, typecheck and build. Confirm the list still works when the API is unreachable and no guest mutation is sent automatically.

## Task 3: Add authenticated shopping-list CRUD

**Files:**

- Create: `backend/src/routes/shoppingList.ts`
- Create: `backend/src/routes/shoppingList.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/routes/sync.ts`
- Modify: `backend/src/routes/sync.test.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`

**Interfaces:**

- Add authenticated `GET /v1/shopping-list`, `POST /v1/shopping-list`, `PATCH /v1/shopping-list/:itemId` and `DELETE /v1/shopping-list/:itemId`.
- Reuse the sync repository as the durable source of truth and map resource mutations to `shopping_list_item` changes.

- [x] **Step 1: Write failing API and integration-contract tests**

Cover authenticated CRUD, validation errors, CSRF/origin rejection, account isolation, purchased toggling and a list item with no quantity. Extend the dedicated-service integration contract to create and read a shopping item.

- [x] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd backend && npm test -- shoppingList.test.ts sync.test.ts
```

Expected: FAIL because the routes and sync entity validation do not exist.

- [x] **Step 3: Implement validated resource routes**

Use the authenticated session user id only. Never accept ownership fields from the client. Require same-origin and CSRF validation for POST/PATCH/DELETE, return stable validation errors and filter deleted or malformed sync records from GET responses.

- [x] **Step 4: Verify Task 3**

Run backend focused/full unit tests, lint and build. Run the PostgreSQL/Redis integration test when dedicated URLs are available; otherwise record the exact skip without claiming a live integration pass.

## Task 4: Build the shopping-list page and accessible controls

**Files:**

- Create: `frontend/src/components/shopping/ShoppingListPanel.tsx`
- Create: `frontend/src/components/shopping/ShoppingListPanel.test.tsx`
- Create: `frontend/src/pages/ShoppingListPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`

**Interfaces:**

- Add a reachable `Spesa` entry from Home and a dedicated page that works with the existing browser router.
- Provide a compact form for a label, optional quantity/unit and optional note.
- Render pending and purchased items with explicit Italian text, keyboard-accessible toggle and remove controls.

- [x] **Step 1: Write failing component tests**

Cover manual insertion, quantity/unit validation, empty-list guidance, purchased toggling, removal, clearing purchased entries, source-recipe metadata and usable layout at 320px.

- [x] **Step 2: Run focused component tests and verify they fail**

Run:

```bash
cd frontend && npm test -- ShoppingListPanel.test.tsx HomePage.test.tsx
```

- [x] **Step 3: Implement the simple progressive-disclosure UI**

Keep the list readable at a glance. Make purchased state clear without relying on color alone, expose labels for every form control and keep optional detail fields collapsed or secondary.

- [x] **Step 4: Verify Task 4**

Run component tests and add desktop/mobile Playwright coverage for manual add, reload persistence and purchased toggling. Confirm the Home-to-Spesa navigation works at 320px.

## Task 5: Add missing recipe ingredients to the shopping list

**Files:**

- Modify: `frontend/src/pages/RecipeDetailPage.tsx`
- Modify: `frontend/src/components/suggestions/LocalRecipeCard.tsx` only if a direct action improves discoverability
- Create or modify: `frontend/src/pages/RecipeDetailPage.test.tsx`
- Modify: `frontend/e2e/core-flow.spec.ts`

**Interfaces:**

- Offer an explicit action on a recipe detail to add non-optional ingredients absent from the current pantry to the shopping list.
- Show a concise confirmation and link to the list; never consume pantry lots or add already-present ingredients.

- [x] **Step 1: Write failing recipe-integration tests**

Cover missing-only selection, optional ingredient exclusion, parsed and unparsed amounts, repeat action behavior and navigation to the list.

- [x] **Step 2: Implement the explicit recipe action**

Use current pantry presence and staple ids as the only availability source. Keep adding to the list user-triggered and preserve source recipe metadata.

- [x] **Step 3: Verify Task 5**

Run recipe detail tests, full frontend tests and the browser suite on desktop/mobile.

## Task 6: Full verification, documentation and dedicated commit

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-13-shopping-list.md`
- Modify: `docs/superpowers/plans/2026-09-12-accounts-and-sync.md` only if the explicit import cross-reference needs updating

- [x] **Step 1: Run the complete verification set**

Run:

```bash
cd backend && npm test && npm run lint && npm run build
cd ../frontend && npm test && npm run lint && npx tsc --noEmit && npm run build && npm run test:e2e
```

Run the dedicated PostgreSQL/Redis integration suite only when the service URLs are available. Run container smoke only when Docker is available.

- [x] **Step 2: Review data and security boundaries**

Run `git diff --check` and inspect that guest list data stays local, all writes use CSRF and same-origin checks, resource routes scope by session user, recipe actions do not consume pantry lots and sync changes do not re-enqueue.

- [x] **Step 3: Update user documentation and checklist**

Document the offline guest list, explicit account import, manual and recipe-derived entries, optional quantity/unit, purchased state and the absence of automatic pantry consumption.

- [x] **Step 4: Commit the completed feature block**

```bash
git add shared backend frontend README.md docs/superpowers/plans/2026-09-13-shopping-list.md
git commit -m "feat: add synchronized shopping list"
```

## Plan self-review

- The list is an independent collection and does not distort pantry availability.
- Offline-first behavior is preserved for guests, while synchronization remains an explicit verified-account capability.
- Recipe-derived quantities are conservative and transparent when parsing is uncertain.
- Purchased state is reversible and visible until the user explicitly removes it.

## Verification record

- Frontend: 23 Vitest files and 114 tests passed; lint, TypeScript checking and production build passed.
- Backend: 15 Vitest files and 32 tests passed; the 2-service integration tests were skipped because `INTEGRATION_DATABASE_URL` and `INTEGRATION_REDIS_URL` were not configured; lint and production build passed.
- Browser: 20 Playwright tests passed on desktop and mobile Chromium, including manual list entry, reload persistence, purchased state, recipe-derived items and the existing pantry/account/offline flows.
- Docker Compose validation remains static; runtime PostgreSQL/Redis and standalone-container smoke tests remain pending because Docker Desktop was unavailable on the workstation.
