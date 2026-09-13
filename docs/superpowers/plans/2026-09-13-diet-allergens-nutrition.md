# iKuck — diet, allergens and nutrition implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let guests and verified users restrict recipe suggestions by common diet, block all 14 EU allergens and filter by estimated nutritional values, while keeping incomplete estimates visibly labelled.

**Architecture:** Diet preferences are a local-first `DietProfile` with a stable `diet_profile` sync entity whose id is `profile`. The curated catalog receives a complete compatibility metadata registry for its 20 recipes, including conservative allergen declarations and catalog nutrition estimates. Suggestions apply diet and allergen constraints before the existing pantry-availability logic, while nutrition constraints apply only to recipes with complete enough data and explain when an estimate is incomplete. The backend exposes the same profile for verified accounts and provides a server-side USDA FoodData Central adapter plus an authenticated recipe nutrition enrichment endpoint; provider calls are mocked in ordinary tests.

**Tech Stack:** React, Zustand, IndexedDB through `idb`, Fastify, the existing Drizzle/PostgreSQL sync repository, Zod, Vitest, Testing Library, Playwright and the USDA FoodData Central API.

**Spec:** `iRicetto_plan.md` and the approved roadmap in `docs/superpowers/plans/2026-09-13-remote-platform.md`.

## Global Constraints

- Guests remain usable offline; no login is required to edit filters or see catalog estimates.
- A verified account may synchronize the diet profile, but local changes are never uploaded automatically before explicit account import or a later authenticated sync.
- Allergen exclusions are blocking: a recipe declaring an excluded allergen is never suggested.
- Use these exact 14 EU allergen codes: `gluten`, `crustaceans`, `eggs`, `fish`, `peanuts`, `soybeans`, `milk`, `nuts`, `celery`, `mustard`, `sesame`, `sulphites`, `lupin`, `molluscs`.
- The initial diet selector contains exactly `omnivore`, `vegetarian`, `pescatarian` and `vegan`; gluten and milk remain selectable through the allergen list.
- Nutrition values are estimates, never medical advice; incomplete values must show an explicit Italian label and never be presented as exact clinical data.
- Provider credentials stay on the backend and are never written to frontend storage, source control or logs.
- Standard tests use deterministic fake providers; real USDA smoke tests run only when an explicit `USDA_API_KEY` is supplied.
- Source code, tests and comments are English; visible UI copy and accessible labels are Italian.
- `E2E_VERIFICATION.md`, `.continue/rules/CONTINUE.md` and unrelated user changes remain unstaged.

---

### Task 1: Define profile, recipe metadata and compatibility contracts

**Files:**

- Modify: `shared/src/contracts.ts`
- Create: `frontend/src/domain/dietary.ts`
- Create: `frontend/src/domain/__tests__/dietary.test.ts`
- Create: `frontend/src/domain/recipeMetadata.ts`
- Create: `frontend/src/domain/__tests__/recipeMetadata.test.ts`
- Modify: `backend/src/providers/types.ts`
- Modify: `backend/src/contracts/contracts.test.ts`

**Interfaces:**

- Add `DietType`, `EuAllergen`, `NutritionFilter`, `DietProfilePayload`, `DietProfile` and `RecipeNutrition` to the shared contracts.
- Extend `SyncEntityType` with `diet_profile`.
- `validateDietProfileDetails(diet, excludedAllergens, nutrition)` returns stable validation errors for unsupported diets, duplicate/unsupported allergens and invalid non-negative numeric thresholds.
- `normalizeDietProfile(value: unknown): DietProfile` returns the safe default profile when persisted data is malformed.
- `getRecipeMetadata(recipeId: string)` returns the catalog metadata or `undefined`.
- `isRecipeCompatible(recipeId: string, profile: DietProfilePayload): boolean` returns `false` for unknown metadata, an incompatible diet or an allergen intersection.

- [x] **Step 1: Write the failing contract and compatibility tests**

Cover a default omnivore profile, each of the four diets, all 14 allergen codes, duplicate/unknown allergen rejection, negative/NaN nutrition threshold rejection, blocking of a fish recipe for a vegetarian profile, blocking of an egg recipe when `eggs` is excluded, allowance of a vegan legume recipe and rejection when recipe metadata is missing. Assert that nutrition JSON retains `source`, `isComplete` and `missingNutrients`.

```ts
expect(isRecipeCompatible('pasta-tonno-pomodoro', profile({ diet: 'vegetarian' }))).toBe(false);
expect(isRecipeCompatible('frittata-zucchine', profile({ excludedAllergens: ['eggs'] }))).toBe(false);
expect(isRecipeCompatible('lenticchie-in-umido', profile({ diet: 'vegan' }))).toBe(true);
```

- [x] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd frontend && npm test -- --run src/domain/__tests__/dietary.test.ts src/domain/__tests__/recipeMetadata.test.ts
cd ../backend && npm test -- --run src/contracts/contracts.test.ts
```

Expected: FAIL because the shared types, metadata registry and compatibility helpers do not exist.

- [x] **Step 3: Implement the typed contracts and deterministic metadata registry**

Use these shared shapes:

```ts
export type DietType = 'omnivore' | 'vegetarian' | 'pescatarian' | 'vegan';
export type EuAllergen =
  | 'gluten' | 'crustaceans' | 'eggs' | 'fish' | 'peanuts' | 'soybeans' | 'milk'
  | 'nuts' | 'celery' | 'mustard' | 'sesame' | 'sulphites' | 'lupin' | 'molluscs';

export interface NutritionFilter {
  maxCaloriesPerServing: number | null;
  minProteinGramsPerServing: number | null;
}

export interface DietProfilePayload {
  diet: DietType;
  excludedAllergens: EuAllergen[];
  nutrition: NutritionFilter;
}

export interface DietProfile extends DietProfilePayload {
  updatedAt: string;
}

export interface RecipeNutrition {
  caloriesPerServing: number | null;
  proteinGramsPerServing: number | null;
  carbohydrateGramsPerServing: number | null;
  fatGramsPerServing: number | null;
  source: 'catalog_estimate' | 'usda';
  isComplete: boolean;
  missingNutrients: string[];
}
```

Register all 20 curated ids with conservative data. Use the existing recipe categories and ingredients to assign diets and allergens: meat recipes are omnivore-only, fish recipes are omnivore/pescatarian, egg recipes are omnivore/vegetarian/pescatarian, legume recipes follow their actual egg/gluten ingredients, and vegetable recipes are vegetarian/vegan when their written ingredients permit it. Declare `gluten` for pasta, couscous and breadcrumbs, `eggs` for egg and burger/polpette recipes, `fish` for fish recipes, `milk` for milk/parmigiano recipes and `celery` for the two celery recipes. Every entry has four numeric catalog values and `source: 'catalog_estimate'`, `isComplete: false`, `missingNutrients: ['sodium']` until a USDA enrichment response replaces it. Do not infer that a missing metadata entry is safe.

- [x] **Step 4: Run Task 1 tests and static checks**

Run the focused suites again, then `cd frontend && npm run lint && npm exec tsc -- --noEmit` and `cd ../backend && npm run lint && npm run build`. Confirm the 20 registry entries match the 20 `RECIPES` ids exactly.

- [x] **Step 5: Commit the contract unit**

```bash
git add shared frontend/src/domain backend/src/providers/types.ts backend/src/contracts/contracts.test.ts
git commit -m "feat: define dietary recipe compatibility"
```

### Task 2: Persist and synchronize the local diet profile

**Files:**

- Create: `frontend/src/storage/dietProfileStorage.ts`
- Create: `frontend/src/storage/dietProfileStorage.test.ts`
- Create: `frontend/src/store/dietProfileStore.ts`
- Create: `frontend/src/store/__tests__/dietProfileStore.test.ts`
- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/sync/syncQueue.test.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**

- `readDietProfile(): Promise<DietProfile>` and `writeDietProfile(profile: DietProfile): Promise<void>` use the existing IndexedDB key-value database and localStorage fallback.
- `useDietProfileStore` exposes `hasHydrated`, `profile`, `setDietProfile(input: DietProfilePayload): boolean` and `resetDietProfile(): void`.
- Profile mutations use entity type `diet_profile`, entity id `profile` and the complete `DietProfile` payload.
- `registerDietProfileSnapshotListener` updates the store without creating an outgoing mutation.

- [ ] **Step 1: Write failing storage, store and sync tests**

Cover malformed persisted data falling back to the safe default, round-trip of all 14 allergen selections and nutrition thresholds, immediate validated updates, rejection without state changes, `diet_profile` queue payloads, remote application without re-enqueueing and explicit account import including the profile.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd frontend && npm test -- --run src/storage/dietProfileStorage.test.ts src/store/__tests__/dietProfileStore.test.ts src/sync/syncQueue.test.ts
```

Expected: FAIL because the profile storage, store and sync entity handling do not exist.

- [ ] **Step 3: Implement defaulted IndexedDB persistence and the Zustand store**

Use this safe default and preserve the existing user decision that amounts are optional:

```ts
const DEFAULT_DIET_PROFILE: DietProfilePayload = {
  diet: 'omnivore',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};
```

Normalize and sort allergen codes, trim no user-facing recipe names, timestamp successful writes with `new Date().toISOString()` and serialize consecutive writes. Keep the in-memory profile updated even if a local write fails, matching the existing pantry/shopping behavior.

- [ ] **Step 4: Extend sync and import**

Add profile listeners, include the current profile in `importLocalData`, apply `diet_profile` upserts/deletes to local storage and validate that remote payloads use entity id `profile`. Notify the profile store only after the persisted snapshot is written.

- [ ] **Step 5: Verify and commit the local profile unit**

Run all frontend tests, lint, typecheck and build. Assert that applying a remote profile leaves pantry, shopping and activity storage untouched. Commit:

```bash
git add frontend/src/App.tsx frontend/src/storage frontend/src/store frontend/src/sync
git commit -m "feat: persist synchronized diet profiles"
```

### Task 3: Add authenticated diet profile and USDA provider boundaries

**Files:**

- Create: `backend/src/diet/validation.ts`
- Create: `backend/src/routes/dietProfile.ts`
- Create: `backend/src/routes/dietProfile.test.ts`
- Create: `backend/src/providers/usda.ts`
- Modify: `backend/src/providers/factory.ts`
- Modify: `backend/src/providers/factory.test.ts`
- Modify: `backend/src/providers/types.ts`
- Modify: `backend/src/routes/sync.ts`
- Modify: `backend/src/routes/sync.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`

**Interfaces:**

- Add authenticated `GET /v1/profile/preferences` and CSRF-protected `PUT /v1/profile/preferences`.
- `DietProfileRouteDependencies` consumes `SyncRepository`, `AuthService` and `appOrigin` and stores the resource as `diet_profile/profile`.
- `createUsdaNutritionProvider({ apiKey, fetch })` implements `NutritionProvider.lookup({ query, quantityGrams })` without logging request data or credentials.
- The provider returns numeric calories, protein, carbohydrate and fat values, a matched food name, `source: 'usda'`, `isComplete` and `missingNutrients`; no result or malformed USDA data is a provider failure.

- [ ] **Step 1: Write failing route, provider and sync tests**

Cover profile validation, account scoping, CSRF/origin rejection, last-write-wins-compatible replacement, no provider call when no USDA key is configured, a fake successful USDA response, a missing nutrient marked incomplete and invalid `diet_profile` sync payload rejection. The fake USDA response must include one food and nutrient ids `1008`, `1003`, `1005` and `1004` so the parser contract is deterministic.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd backend && npm test -- --run src/routes/dietProfile.test.ts src/providers/factory.test.ts src/routes/sync.test.ts
```

Expected: FAIL because the route, USDA adapter and sync validation do not exist.

- [ ] **Step 3: Implement validated profile routes**

Parse the shared profile shape with Zod, read only the authenticated session user id and map a successful update to a `diet_profile/profile` upsert with a fresh `updatedAt`. All writes require same-origin and CSRF checks; reads return only the current account profile or the shared default when no profile exists. Never return provider credentials.

- [ ] **Step 4: Implement the USDA adapter and factory selection**

Call the official FoodData Central search endpoint server-side with `api_key`, `query` and `pageSize=1`. Convert nutrient values to the requested quantity in grams when supplied, retain a matched description, mark absent required nutrients in `missingNutrients` and throw a typed provider error for non-2xx or invalid responses. `createProviders` selects this adapter only when `USDA_API_KEY` exists and keeps the unavailable provider otherwise.

- [ ] **Step 5: Verify Task 3**

Run the complete backend suite, lint and build. Run the dedicated PostgreSQL/Redis integration test when both URLs exist; otherwise record the exact skip. If `USDA_API_KEY` is explicitly present, run the opt-in provider smoke test against a single harmless query and do not include its output in standard tests.

- [ ] **Step 6: Commit the backend boundary**

```bash
git add backend shared/src/contracts.ts
git commit -m "feat: add dietary profile and USDA nutrition boundaries"
```

### Task 4: Filter suggestions and build the dietary controls

**Files:**

- Create: `frontend/src/components/diet/DietFiltersPanel.tsx`
- Create: `frontend/src/components/diet/DietFiltersPanel.test.tsx`
- Modify: `frontend/src/domain/suggestions.ts`
- Modify: `frontend/src/domain/__tests__/suggestions.test.ts`
- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/components/suggestions/LocalRecipeCard.tsx`
- Modify: `frontend/src/pages/RecipeDetailPage.tsx`
- Modify: `frontend/src/pages/RecipeDetailPage.test.tsx`

**Interfaces:**

- Extend `SuggestionOptions` with `dietProfile?: DietProfilePayload`.
- `findRecipeSuggestions` filters by `isRecipeCompatible` before calculating missing pantry ingredients and then applies `maxCaloriesPerServing` and `minProteinGramsPerServing` to catalog estimates.
- `DietFiltersPanel` consumes `profile`, `onChange` and `onReset`; changes are explicit and do not run a recipe search until the existing `Trova ricette` action is pressed.

- [ ] **Step 1: Write failing suggestion and component tests**

Cover vegetarian/pescatarian/vegan filtering, every excluded allergen blocking at least one declared recipe, nutrition threshold filtering, incomplete nutrition copy, explicit reset, accessible labels for the diet select and allergen checkboxes, and a recipe detail nutrition summary that says `Stima indicativa` rather than implying precision.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd frontend && npm test -- --run src/domain/__tests__/suggestions.test.ts src/components/diet/DietFiltersPanel.test.tsx src/pages/RecipeDetailPage.test.tsx
```

Expected: FAIL because suggestions do not consume a diet profile and no controls exist.

- [ ] **Step 3: Implement blocking compatibility and nutrition filtering**

Keep the current recipe availability behavior unchanged after compatibility filtering: optional ingredients remain optional, one easy missing ingredient remains opt-in, and quantity warnings remain warnings. A profile with no nutrition thresholds must not alter results. A profile with a threshold must exclude recipes whose catalog estimate violates it; show incomplete status only on the recipe card/detail and do not silently treat missing nutrition as zero.

- [ ] **Step 4: Implement the Italian accessible filter panel**

Place it below the ingredient input and ingredient suggestions, before the recipe search controls. Use a native `select` for `Dieta`, one checkbox per the 14 named allergens, numeric inputs for `Calorie massime per porzione` and `Proteine minime per porzione`, and a `Ripristina filtri` button. Use `aria-describedby` to explain that allergen exclusions are blocking and nutrition values are estimates. Keep the existing Home keyboard order intact by leaving the ingredient field as the first focusable control.

- [ ] **Step 5: Display metadata without changing pantry semantics**

Add a compact nutrition line to cards and recipe detail with calories, protein and the `Stima indicativa` label. Display declared allergen labels on the detail page. Do not remove ingredients, change lots or mark food as consumed when filters or detail pages are used.

- [ ] **Step 6: Verify Task 4**

Run all frontend unit/component tests, lint, typecheck and build. Confirm the existing 320px keyboard flow still reaches `Trova ricette` and no horizontal overflow is introduced by the 14 checkboxes.

### Task 5: Add authenticated USDA recipe enrichment

**Files:**

- Create: `backend/src/nutrition/recipeNutrition.ts`
- Create: `backend/src/nutrition/recipeNutrition.test.ts`
- Create: `backend/src/routes/recipeNutrition.ts`
- Create: `backend/src/routes/recipeNutrition.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`
- Modify: `frontend/src/pages/RecipeDetailPage.tsx`
- Modify: `frontend/src/pages/RecipeDetailPage.test.tsx`

**Interfaces:**

- Add authenticated `POST /v1/recipes/nutrition` with `{ ingredients: Array<{ query: string; grams: number | null }> }` and a `RecipeNutrition` response.
- `estimateRecipeNutrition(lookups, provider)` calls the provider once per ingredient, sums available nutrients, preserves the union of missing nutrient names and marks the result incomplete when any required field is missing.
- The recipe detail page offers `Aggiorna stima USDA` only when a verified session exists; guests continue to see the offline catalog estimate.

- [ ] **Step 1: Write failing aggregation, API and UI tests**

Cover sum/scaling of two fake ingredient responses, incomplete aggregation, provider failure mapped to a stable 503 response, authenticated/CSRF route behavior, and replacing the displayed catalog estimate only after a successful response. Assert that the frontend never sends an API key and that the offline guest path never calls the network.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd backend && npm test -- --run src/nutrition/recipeNutrition.test.ts src/routes/recipeNutrition.test.ts
cd ../frontend && npm test -- --run src/pages/RecipeDetailPage.test.tsx
```

Expected: FAIL because the aggregation, route and enrichment control do not exist.

- [ ] **Step 3: Implement the server-side aggregation and route**

Validate at most 30 ingredient lookups, require a positive gram value when provided, require a verified session and CSRF for the state-free but provider-consuming request, call only the injected provider, and return a stable error when USDA is unavailable. Do not persist raw provider responses or user recipe notes in logs.

- [ ] **Step 4: Implement the guarded UI refresh**

Derive deterministic ingredient lookup quantities from the curated recipe amount strings and the existing ingredient definitions. Keep the catalog estimate visible while loading, show `Valori USDA aggiornati` only after success, and fall back to `Stima indicativa` with an actionable offline/provider-unavailable message on failure.

- [ ] **Step 5: Verify Task 5**

Run backend and frontend full suites, lint, typecheck and builds. Run Playwright with a mocked `/v1/recipes/nutrition` response for the verified flow and with network disabled for the guest flow.

- [ ] **Step 6: Commit the USDA enrichment unit**

```bash
git add backend frontend shared
git commit -m "feat: add USDA recipe nutrition estimates"
```

### Task 6: End-to-end verification, documentation and release commit

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-13-diet-allergens-nutrition.md`
- Modify: `frontend/e2e/core-flow.spec.ts`

- [ ] **Step 1: Add desktop/mobile browser coverage**

Add scenarios that set vegetarian and exclude fish, verify fish recipes are absent after an explicit search, select a nutrition threshold and see only matching recipes, open detail to see the estimate disclaimer, reload, and confirm the filters persist. Run one filter panel scenario at 320px and assert no horizontal overflow.

- [ ] **Step 2: Run the complete verification set**

Run:

```bash
cd backend && npm test && npm run lint && npm run build
cd ../frontend && npm test && npm run lint && npm exec tsc -- --noEmit && npm run build && npm run test:e2e
```

Run PostgreSQL/Redis integration only when dedicated URLs are configured. Run the real USDA smoke test only when `USDA_API_KEY` is explicitly available. Run `docker compose -f deploy/docker-compose.standalone.yml config` and the deployment contract tests; run container smoke only when the Docker Linux engine is available.

- [ ] **Step 3: Review safety and data boundaries**

Run `git diff --check` and inspect that allergen filtering is blocking, unknown metadata is not considered safe, nutrition disclaimers remain visible, guest requests do not expose credentials, profile writes use CSRF/same-origin checks and remote profile changes do not mutate pantry/activity/shopping data.

- [ ] **Step 4: Update README and plan evidence**

Document the four diets, the 14 allergen exclusions, the two nutrition thresholds, the estimate/incomplete labels, the optional USDA enrichment and the fact that filters never consume pantry lots. Mark each completed checkbox and record exact test counts plus any intentionally skipped external/container checks.

- [ ] **Step 5: Commit the completed feature block**

```bash
git add README.md frontend/e2e docs/superpowers/plans/2026-09-13-diet-allergens-nutrition.md
git commit -m "feat: add diet allergen and nutrition filters"
```

## Plan self-review

- The plan covers guest-local behavior, verified-account synchronization, all 14 allergen codes, four common diets, nutrition thresholds, visible incompleteness, USDA provider isolation, API security and browser verification.
- The curated registry is conservative: missing metadata blocks compatibility instead of silently permitting a recipe.
- Nutrition filtering is deterministic offline; USDA enrichment is optional and server-only, so the PWA remains useful without credentials or network access.
- The plan deliberately does not introduce medical claims, automatic pantry consumption or external notifications.
