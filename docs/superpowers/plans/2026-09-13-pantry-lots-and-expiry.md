# iKuck — pantry lots, quantities and expiry

> **For agentic workers:** Execute this plan task-by-task. Keep each checkbox current, run the focused verification before moving on, and commit the plan and implementation as separate reviewable units.

**Goal:** Extend the guest-first pantry from ingredient presence to separate pantry lots with optional quantities, units and expiry dates, while keeping recipe matching presence-based and usable offline.

**Scope:** This plan covers the third product block: local and synchronized pantry lots, quantity aggregation, expiry presentation and soft quantity warnings. It does not implement shopping lists, activity, diet filters, AI recipes or automatic suggestions.

**Architecture:** A pantry ingredient remains the recipe-facing aggregate. Each physical purchase or portion is a `PantryLot` identified separately underneath it. A lot may have no quantity, unit or expiry, preserving the original “presente” workflow. Guests write lots to IndexedDB and queue mutations locally; verified accounts sync `pantry_lot` entities through the existing last-write-wins API. Expiry information is displayed only in the application and never produces an external notification.

**Compatibility decisions:** Existing `pantryItems` snapshots are migrated into one open lot per ingredient with `quantity: null`, `unit: null` and `expiresAt: null`. Existing recipe availability remains derived from ingredient ids, so quantities never exclude a recipe. The first lot keeps the ingredient id as its stable id where possible; additional lots receive independent ids. Removing an ingredient removes all of its lots, while removing one lot leaves the other lots available.

**Tech Stack:** React, Zustand, IndexedDB through `idb`, Fastify, Drizzle/PostgreSQL sync records, Zod, Vitest, Testing Library and Playwright.

## Invariants

- Guests can add an ingredient with only its name; quantity, unit and expiry are optional.
- Every lot has a stable id, ingredient id, label, known flag, nullable quantity, nullable unit, nullable expiry and ISO `createdAt`/`updatedAt` timestamps.
- Quantity must be finite and greater than zero when supplied; a unit is required when quantity is supplied.
- Expiry is a calendar date in `YYYY-MM-DD`, rendered in Italian and never sent to an external notification service.
- Recipe matching uses aggregated ingredient presence exactly as before; missing quantity creates only a soft warning.
- Lots are aggregated only when units are compatible. Unknown or mixed units are shown as separate quantities rather than guessed.
- A remote change is applied without creating a second local mutation.
- Legacy pantry data remains readable after migration and is never deleted before a successful IndexedDB write.
- Source code, tests and comments are English; visible UI copy and accessible labels are Italian.
- `E2E_VERIFICATION.md` and unrelated user changes remain unstaged.

## Task 1: Define shared lot contracts and quantity/expiry domain helpers

**Files:**

- Modify: `shared/src/contracts.ts`
- Create: `frontend/src/domain/pantryLots.ts`
- Create: `frontend/src/domain/__tests__/pantryLots.test.ts`
- Modify: `backend/src/routes/sync.ts`
- Modify: `backend/src/sync/repository.ts`
- Test: `backend/src/contracts/contracts.test.ts`

**Interfaces:**

- Add `PantryUnit`, `PantryLot` and `PantryLotPayload` to `@ikuck/shared/contracts`.
- Extend `SyncEntityType` with `pantry_lot` while retaining `pantry_item` and `staple_preference` for old synchronized accounts.
- Add `aggregatePantryLots`, `getExpiryStatus` and `getQuantityWarning` to the frontend domain boundary.

- [ ] **Step 1: Write failing contract and domain tests**

Cover:

- a lot with no quantity is valid and preserves presence-only behavior;
- invalid quantity/unit combinations are rejected;
- grams and kilograms aggregate after conversion, while grams and pieces remain separate;
- the earliest expiry is exposed by an aggregate;
- dates are classified as expired, expiring soon and okay using an injected current date;
- a recipe amount larger than the known aggregate quantity produces a warning but never makes the ingredient unavailable.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd frontend && npm test -- pantryLots.test.ts
cd ../backend && npm test -- contracts.test.ts
```

Expected: FAIL because the shared lot contract and domain helpers do not exist.

- [ ] **Step 3: Implement the smallest typed contracts and pure helpers**

Use explicit units (`g`, `kg`, `ml`, `l`, `piece`, `pack`) and nullable fields. Keep the domain conversion table small and deterministic. Parse only the leading numeric value and recognized unit from existing recipe amount strings; if parsing is uncertain, return no warning rather than inventing a conversion.

- [ ] **Step 4: Verify Task 1**

Run the focused tests, backend lint/build and frontend lint/typecheck. Confirm the sync schema accepts `pantry_lot` but does not remove support for legacy entity types.

## Task 2: Migrate and persist lot-based guest state

**Files:**

- Modify: `frontend/src/storage/pantryStorage.ts`
- Modify: `frontend/src/storage/pantryStorage.test.ts`
- Modify: `frontend/src/storage/indexedDb.test.ts`
- Modify: `frontend/src/store/localPantryStore.ts`
- Modify: `frontend/src/store/__tests__/pantryStore.test.ts`
- Create: `frontend/src/store/pantryLotActions.ts` if a separate action boundary improves testability

**Interfaces:**

- `PantrySnapshot` gains `pantryLots` while retaining a normalized `pantryItems` aggregate for the current recipe UI.
- `usePantryStore` exposes `pantryLots`, `addPantryLot`, `updatePantryLot`, `removePantryLot`, `getLotsForIngredient` and `getPantryQuantitySummary` without removing existing actions.

- [ ] **Step 1: Add failing migration and store tests**

Cover:

- an old snapshot with pasta and staples becomes one presence-only pasta lot;
- a snapshot with multiple lots round-trips without losing nullable fields;
- adding an ingredient with no details creates one lot and immediately updates the aggregate;
- adding a second lot for the same ingredient keeps both lots but only one recipe-facing item;
- editing quantity/unit/expiry updates `updatedAt` and local state immediately;
- removing one lot leaves sibling lots; removing the ingredient removes all lots;
- a failed IndexedDB write leaves the current in-memory lot state usable.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cd frontend && npm test -- pantryStorage.test.ts pantryStore.test.ts
```

Expected: FAIL because the store has no lot state or lot actions.

- [ ] **Step 3: Implement version-tolerant snapshot normalization**

Normalize on read and before persistence. Preserve the current storage key and IndexedDB database. Generate a stable first-lot id from the ingredient id and independent ids for later lots. Do not migrate or remove legacy data until the normalized snapshot is successfully written.

- [ ] **Step 4: Implement lot actions with immediate local updates**

Keep recipe-facing `pantryItems` derived from lots. Queueing is introduced in Task 3, so this task may expose an injectable mutation callback or a no-op boundary to keep storage tests independent. Make aggregate order deterministic and deduplicate only at the ingredient aggregate level.

- [ ] **Step 5: Verify Task 2**

Run all frontend unit/component tests, lint and build. Check that the original no-quantity add flow still works with keyboard and screen-reader labels.

## Task 3: Add remote pantry-lot API and offline synchronization

**Files:**

- Create: `backend/src/routes/pantryLots.ts`
- Create: `backend/src/routes/pantryLots.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`
- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/sync/syncQueue.test.ts`
- Modify: `frontend/src/store/localPantryStore.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`

**Interfaces:**

- Add authenticated `GET /v1/pantry-lots`, `POST /v1/pantry-lots`, `PATCH /v1/pantry-lots/:lotId` and `DELETE /v1/pantry-lots/:lotId`.
- Reuse the existing per-entity sync repository as the durable source of truth; resource routes validate `PantryLot` payloads and map them to `pantry_lot` mutations.
- The browser queue sends `pantry_lot` mutations, applies remote lot changes, and keeps legacy `pantry_item` changes compatible.

- [ ] **Step 1: Write failing API and queue tests**

Cover authenticated CRUD with CSRF and origin checks, invalid quantities and dates, account isolation, offline lot mutations, server changes without re-enqueueing and a retry after a failed request. Include a regression that a lot with a missing quantity is accepted.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd backend && npm test -- pantryLots.test.ts
cd ../frontend && npm test -- syncQueue.test.ts pantryStore.test.ts
```

Expected: FAIL because the route and `pantry_lot` queue handling do not exist.

- [ ] **Step 3: Implement validated resource routes**

Use the authenticated user id only; never accept ownership fields from the client. Require CSRF for POST/PATCH/DELETE and same-origin checks for state-changing requests. Return stable validation errors without leaking database details. Keep `GET` data scoped to the current account.

- [ ] **Step 4: Extend the queue and store integration**

Queue lot upserts/deletes after the local transition. Apply remote lots through the existing snapshot listener. Preserve the safer sync ordering: apply server changes and cursor first, then delete acknowledged queue records. Keep mutations idempotent and do not silently import local data after login.

- [ ] **Step 5: Extend the real-service integration contract**

When `INTEGRATION_DATABASE_URL` and `INTEGRATION_REDIS_URL` are present, create, update and delete a lot through sync/resource boundaries and verify it is isolated to the authenticated account. Keep ordinary runs skipped without those dedicated services.

- [ ] **Step 6: Verify Task 3**

Run backend/frontend focused suites, full unit suites, lint and builds. Run the parametrized integration suite if services are available; otherwise record the exact skip. Confirm no provider or notification call is introduced.

## Task 4: Build the accessible lot editor and expiry presentation

**Files:**

- Create: `frontend/src/components/pantry/PantryLotsPanel.tsx`
- Create: `frontend/src/components/pantry/PantryLotEditor.tsx`
- Create: `frontend/src/components/pantry/PantryLotsPanel.test.tsx`
- Create: `frontend/src/components/pantry/PantryLotEditor.test.tsx`
- Modify: `frontend/src/components/pantry/IngredientChip.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/test/HomePage.test.tsx`

**Interfaces:**

- Guests can add a lot from an existing ingredient, edit its optional details and remove one lot without navigating away.
- The panel shows total quantity only for compatible units, the number of lots and the earliest expiry.
- Expiry labels are Italian (`Scaduto`, `Scade presto`, `Disponibile`) with accessible text and no color-only meaning.

- [ ] **Step 1: Write failing component tests**

Cover the simple name-only flow, quantity/unit validation, date editing, multiple lots for one ingredient, removing a single lot, keyboard operation and the visible expiry warning text. Ensure the original ingredient input remains the first useful keyboard target on Home.

- [ ] **Step 2: Run focused component tests and verify they fail**

Run:

```bash
cd frontend && npm test -- PantryLotsPanel.test.tsx PantryLotEditor.test.tsx HomePage.test.tsx
```

- [ ] **Step 3: Implement the compact progressive-disclosure UI**

Keep the base pantry card visually simple. Use a native number input, a native unit select and a native date input. Make quantity and expiry details optional, explain that an empty quantity means only “presente”, and avoid exposing raw ISO dates in the UI.

- [ ] **Step 4: Verify Task 4**

Run component tests and the desktop/mobile Playwright flow. Confirm the layout remains usable at 320px and the lot editor does not interfere with recipe search.

## Task 5: Add non-blocking quantity warnings to recipe suggestions

**Files:**

- Modify: `frontend/src/domain/suggestions.ts`
- Modify: `frontend/src/domain/types.ts`
- Modify: `frontend/src/components/suggestions/LocalRecipeCard.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`
- Create: `frontend/src/domain/__tests__/quantityWarnings.test.ts`

**Interfaces:**

- A `RecipeSuggestion` may include `quantityWarnings` in addition to missing ingredient ids.
- Ingredient presence and the “one missing ingredient” rule remain unchanged.
- A warning such as “La quantità potrebbe non bastare” is advisory and never filters a recipe.

- [ ] **Step 1: Write failing suggestion tests**

Cover enough quantity, insufficient compatible quantity, unknown quantity, mixed units and recipes whose amount string cannot be parsed. All cases must still return the recipe when the ingredient is present.

- [ ] **Step 2: Implement warning-only suggestion metadata**

Pass the store’s aggregate summaries into the suggestion calculation. Keep the existing catalog deterministic and do not add automatic ingredient consumption.

- [ ] **Step 3: Verify Task 5**

Run all domain, component and browser tests. Inspect that cards distinguish “ingredient missing” from “quantity may be insufficient”.

## Task 6: Full verification, documentation and dedicated commit

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-13-pantry-lots-and-expiry.md`
- Modify: `docs/superpowers/plans/2026-09-12-accounts-and-sync.md` only if a shared contract change needs a cross-reference

- [ ] **Step 1: Run the complete verification set**

Run:

```bash
cd backend && npm test && npm run lint && npm run build
cd ../frontend && npm test && npm run lint && npm run build && npm run test:e2e
```

Run the PostgreSQL/Redis integration suite and standalone Compose smoke test only when dedicated services and Docker are available. Otherwise preserve the explicit pending status from the platform plan.

- [ ] **Step 2: Review data and security boundaries**

Run `git diff --check` and inspect that expiry dates stay in the app data model, no notification provider is called, quantities are validated on both client and server, and account sync never accepts a foreign `userId`.

- [ ] **Step 3: Update user documentation and checklist**

Document presence-only use, optional lot details, aggregation rules, expiry labels, soft quantity warnings, legacy migration and the fact that no external expiry notification is sent.

- [ ] **Step 4: Commit the completed feature block**

```bash
git add shared backend frontend README.md docs/superpowers/plans/2026-09-13-pantry-lots-and-expiry.md
git commit -m "feat: add pantry lots quantities and expiry"
```

## Plan self-review

- The original no-login experience remains the default and needs no quantity input to add an ingredient.
- Lots are the durable unit, aggregates are derived, and recipe matching remains presence-based.
- Expiry is useful in the UI without creating notification or privacy scope.
- The same LWW and offline queue semantics are reused instead of creating a second sync system.
- Unit conversion is deliberately conservative: uncertain quantities produce no warning rather than a false claim.
