# iKuck — automatic recipe suggestions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recalculate local recipe suggestions automatically after relevant pantry or preference changes, while keeping the first search explicitly user-triggered and adding light personalization and controlled variety.

**Architecture:** The existing catalog matcher remains the eligibility boundary: it still filters by pantry presence, one easy missing ingredient, quantity warnings, diet and allergen constraints. A pure ranking function will apply favorite, rating and recently-cooked signals without excluding any otherwise compatible recipe. `HomePage` will remember that the user has searched, then recalculate the same local results when pantry, lot, staple, diet, history or preference state changes; an explicit “Altre idee” action advances a deterministic variety seed.

**Tech Stack:** React, Zustand, TypeScript, Vitest, Testing Library and Playwright.

**Spec:** `docs/superpowers/plans/2026-09-12-remote-platform.md`, especially the automatic-suggestions requirement: “proposte ricalcolate dopo modifiche a dispensa o profilo, personalizzazione leggera tramite storico/preferiti/valutazioni, varietà e pulsante per aggiornare le idee.” The existing Home behavior “la ricerca viene eseguita su richiesta” remains authoritative for the initial search.

## Global Constraints

- Guests remain fully local and offline; no network request is added by automatic suggestions.
- The first suggestion calculation happens only after the user activates “Trova ricette”.
- Once results are visible, changes to pantry, lots, staples, diet profile, cooking history or recipe preferences recalculate them locally.
- Ranking never bypasses the existing diet/allergen compatibility or pantry matching rules.
- Quantity warnings remain warnings and do not exclude a recipe.
- “Altre idee” changes ordering through a deterministic seed and does not mutate `RECIPES`.
- Source code, tests and comments are English; visible UI copy and accessible labels are Italian.
- `E2E_VERIFICATION.md`, `.continue/rules/CONTINUE.md` and unrelated user changes remain unstaged.

---

### Task 1: Add pure personalization and variety ranking

**Files:**

- Modify: `frontend/src/domain/suggestions.ts`
- Modify: `frontend/src/domain/__tests__/suggestions.test.ts`

**Interfaces:**

- Add `SuggestionPersonalization`:

```ts
export interface SuggestionPersonalization {
  events?: readonly CookEvent[];
  preferences?: readonly RecipePreference[];
  random?: () => number;
}
```

- Add `createSeededRandom(seed: number): () => number` for a stable pseudo-random sequence used only for local ordering.
- Add `rankRecipeSuggestions(suggestions: readonly RecipeSuggestion[], personalization?: SuggestionPersonalization): RecipeSuggestion[]`.
- Extend `SuggestionOptions` with `events?: readonly CookEvent[]` and `preferences?: readonly RecipePreference[]`; `findRecipeSuggestions` will pass eligible results through `rankRecipeSuggestions` after the existing complete-before-extended limit.
- A favorite receives the strongest positive score, a rating of 4 or 5 a smaller positive score, and a recipe present in cooking history a small negative score to encourage variety. Ties use the supplied random value and then the recipe id for deterministic ordering.

- [ ] **Step 1: Write failing ranking and variety tests**

Cover these exact cases in `suggestions.test.ts`:

```ts
const personalization = {
  preferences: [{ recipeId: 'favorite', favorite: true, rating: null, note: null, createdAt: now, updatedAt: now }],
  events: [{ id: 'event-1', recipeId: 'cooked', recipeTitle: 'cooked', servings: 2, cookedAt: now, note: null, createdAt: now, updatedAt: now }],
};
```

- a favorite ranks before a neutral eligible recipe;
- a highly rated recipe ranks before a neutral eligible recipe;
- a recently cooked recipe is moved behind an otherwise equal neutral recipe;
- `createSeededRandom(1)` produces the same order on repeated calls and a different seed can produce a different tie order;
- all recipes remain present and the original suggestion array/catalog are not mutated.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
cd frontend && npm test -- --run src/domain/__tests__/suggestions.test.ts
```

Expected: FAIL because the personalization interfaces and functions do not exist.

- [ ] **Step 3: Implement the pure ranking boundary**

Keep `findRecipeSuggestions` responsible for eligibility and its existing six-item cap. After the cap, call:

```ts
return rankRecipeSuggestions([...complete, ...extended].slice(0, Math.max(0, limit)), {
  events,
  preferences,
  random,
});
```

The ranking score must not inspect recipe prose or invent nutrition data. It may only use `RecipePreference.recipeId`, `favorite`, `rating` and `CookEvent.recipeId`; all unmatched signals have score zero. Use a local seeded generator for the Home refresh action instead of mutating or shuffling `RECIPES`.

- [ ] **Step 4: Run focused and full domain tests**

Run:

```bash
cd frontend && npm test -- --run src/domain/__tests__/suggestions.test.ts
cd frontend && npm test -- --run src/domain
```

Expected: all suggestion and domain tests pass, including existing complete-before-extended and diet/nutrition assertions.

- [ ] **Step 5: Commit the ranking unit**

```bash
git add frontend/src/domain/suggestions.ts frontend/src/domain/__tests__/suggestions.test.ts
git commit -m "feat: personalize local recipe suggestions"
```

### Task 2: Recalculate suggestions reactively in Home

**Files:**

- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/test/HomePage.test.tsx`
- Modify: `frontend/src/store/activityStore.ts` only if a stable selector/helper is required by the tests; do not alter activity persistence semantics.

**Interfaces:**

- `HomePage` keeps `hasSearched: boolean` false until the existing search button is activated.
- Use `useActivityStore((state) => state.events)` and `useActivityStore((state) => state.preferences)` as local personalization inputs.
- Derive signatures from the current ingredient ids, lot summaries, staple ids, diet profile, activity events and preferences so a `useEffect` can observe value changes without calling state setters during render.
- The refresh action increments `varietySeed`; it must call the same local calculation with `createSeededRandom(varietySeed)` and retain `hasSearched`.

- [ ] **Step 1: Write failing Home integration tests**

Extend `HomePage.test.tsx` with these cases:

- before the first search, adding an ingredient does not render “Ricette per te”;
- after a first search, adding a compatible ingredient automatically recalculates the result list without clicking “Trova ricette” again;
- changing the diet profile after results are visible automatically removes incompatible recipes;
- adding a favorite/high rating in `useActivityStore` changes the visible order without a second search;
- clicking “Altre idee” keeps the results visible and invokes a new order without changing the pantry list.

Reset `useActivityStore` in the test setup for deterministic cases and keep the existing pantry/storage cleanup intact.

- [ ] **Step 2: Run the focused Home tests and confirm they fail**

Run:

```bash
cd frontend && npm test -- --run src/test/HomePage.test.tsx
```

Expected: the new post-search mutation tests fail because current handlers clear results and no reactive recalculation exists.

- [ ] **Step 3: Implement reactive local recalculation**

Extract one calculation path in `HomePage` that calls `findRecipeSuggestions` with:

```ts
{
  availableIds,
  allowOneMissing,
  quantitySummaries,
  dietProfile,
  events,
  preferences,
  random: createSeededRandom(varietySeed),
}
```

Keep the initial `search()` action explicit. Replace result-clearing behavior in ingredient, lot, staple and diet handlers with state changes; the effect recalculates only when `hasSearched` is true. Do not reset `hasSearched` when a user edits the pantry or profile: an empty eligible result is the correct automatic state after a searched pantry becomes incompatible. Ensure the extended one-missing flow still sets `allowOneMissing` and immediately calculates its result. Keep “Altre idee” as a visible button that increments `varietySeed` and recalculates locally.

- [ ] **Step 4: Run focused and full frontend tests**

Run:

```bash
cd frontend && npm test -- --run src/test/HomePage.test.tsx src/domain/__tests__/suggestions.test.ts
cd frontend && npm test
cd frontend && npm run lint
cd frontend && npm run build
```

Expected: all frontend tests, lint and production build pass; guests still use no network for suggestion refreshes.

- [ ] **Step 5: Commit the reactive Home unit**

```bash
git add frontend/src/pages/HomePage.tsx frontend/src/test/HomePage.test.tsx frontend/src/store/activityStore.ts
git commit -m "feat: refresh suggestions after local changes"
```

### Task 3: Verify browser behavior and document the final boundary

**Files:**

- Modify: `frontend/e2e/core-flow.spec.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-13-automatic-suggestions.md`

**Interfaces:**

- Browser coverage runs in the existing desktop and mobile Playwright projects.
- The e2e test uses the real built/previewed page and only local catalog/state; it must not add a network API dependency.

- [ ] **Step 1: Add desktop/mobile browser coverage**

Add a Playwright scenario that adds ingredients, requests recipes once, changes the pantry, verifies updated suggestions without a second search click, presses “Altre idee”, reloads and confirms the pantry still persists. Include a diet filter change that removes an incompatible recipe from the already-visible results.

- [ ] **Step 2: Run the complete verification set**

Run:

```bash
cd frontend && npm run test:e2e
cd backend && npm test
cd backend && npm run lint && npm run build
```

Expected: Playwright passes in desktop and mobile projects; the backend remains green with PostgreSQL/Redis integration skipped only when its URLs are absent.

- [ ] **Step 3: Review the no-network and mutation boundaries**

Run `git diff --check` and inspect that automatic suggestions call only local domain functions, do not mutate `RECIPES`, do not alter pantry lots, and do not introduce any AI/provider request.

- [ ] **Step 4: Update README and mark evidence**

Document that the first search is explicit, then visible suggestions refresh locally after pantry/profile/activity changes; explain that “Altre idee” changes variety and that no account or network is needed for this behavior.

- [ ] **Step 5: Commit and finish the automatic-suggestions plan**

```bash
git add frontend/e2e/core-flow.spec.ts README.md docs/superpowers/plans/2026-09-13-automatic-suggestions.md
git commit -m "feat: complete automatic recipe suggestions"
```

## Self-review checklist

- The initial-request constraint is preserved by `hasSearched`.
- Eligibility remains centralized in `findRecipeSuggestions`; personalization cannot bypass dietary or pantry rules.
- History, favorites and ratings affect order only, so users never lose a valid recipe solely because of a preference signal.
- Variety is explicit and testable through a seed, not dependent on uncontrolled global randomness.
- Browser verification covers both viewport projects and confirms local persistence.
