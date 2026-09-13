# iKuck — AI recipe generation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let verified users generate, save and reopen private recipes from their pantry with explicit consent, strict diet/allergen compatibility and a Redis-backed limit of five generations per UTC day.

**Architecture:** The browser sends only pantry labels and the current dietary profile to authenticated API routes. The backend owns the OpenAI credential, consent state, daily limiter and private generated-recipe records; the provider uses the Responses API with `store: false` and a strict JSON Schema. Generated recipes are validated again on the server, stored as private `generated_recipe` sync entities and never added to the curated catalog.

**Tech Stack:** React, Zustand, Fastify, Zod, Drizzle/PostgreSQL sync storage, Redis, Vitest, Testing Library, Playwright and the OpenAI Responses API.

**Spec:** The approved roadmap in `docs/superpowers/plans/2026-09-12-remote-platform.md` and the diet contract in `docs/superpowers/plans/2026-09-13-diet-allergens-nutrition.md`.

## Global Constraints

- Guests remain fully usable offline and never see an AI network action.
- AI generation is available only to an authenticated, e-mail-verified account with active consent.
- The limit is five accepted generation attempts per UTC calendar day per user, enforced server-side with Redis.
- OpenAI requests always use `store: false`, strict Structured Outputs JSON Schema and a server-only API key.
- Generated recipes are private to the owning account and are not inserted into `RECIPES` or the public catalog.
- A generated recipe must declare its diets and EU allergen codes and must satisfy the submitted profile; incompatible output is rejected.
- Provider credentials, pantry notes and generated content are never written to logs or frontend storage.
- Standard tests use fake providers and fake limiters; a real OpenAI smoke test runs only when `OPENAI_API_KEY` is explicitly present.
- Source code, tests and comments are English; visible UI copy and accessible labels are Italian.
- `E2E_VERIFICATION.md`, `.continue/rules/CONTINUE.md` and unrelated user changes remain unstaged.

---

### Task 1: Define generated recipe and AI consent contracts

**Files:**

- Modify: `shared/src/contracts.ts`
- Modify: `backend/src/providers/types.ts`
- Modify: `backend/src/config.ts`
- Modify: `backend/src/contracts/contracts.test.ts`
- Create: `backend/src/ai/validation.ts`
- Create: `backend/src/ai/validation.test.ts`

**Interfaces:**

- Extend `SyncEntityType` with `ai_consent` and `generated_recipe`.
- Add `AiConsent`, `GeneratedRecipeIngredient`, `GeneratedRecipe` and `GeneratedRecipeDraft` shapes with stable timestamps, `source: 'ai'`, `diets` and `allergens`.
- `RecipeGenerationRequest` accepts `ingredients`, `constraints` and a `DietProfilePayload`.
- `parseGeneratedRecipeDraft(value: unknown)` returns a validated draft or `null`; empty titles, steps, ingredients, unsupported diets/allergens and duplicate allergen codes are invalid.
- `isGeneratedRecipeCompatible(recipe, profile)` blocks a recipe when the selected diet is absent or an excluded allergen is declared.

- [x] **Step 1: Write failing contract and validation tests**

Cover the private recipe shape, all 14 allergen codes, malformed titles and steps, duplicate allergen rejection, compatible vegan output, incompatible fish output and preservation of `source: 'ai'`.

- [x] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd backend && npm test -- --run src/ai/validation.test.ts src/contracts/contracts.test.ts
```

Expected: FAIL because the AI contracts and parser do not exist.

- [x] **Step 3: Implement shared types and Zod validation**

Keep the provider draft free of database ids, then convert it to a `GeneratedRecipe` only after the route has authenticated the user and assigned timestamps. Reject unknown fields in the API schema and preserve the submitted diet/allergen profile as server-side compatibility context rather than trusting model prose.

- [x] **Step 4: Verify and commit the contract unit**

Run backend focused tests, lint and build, then commit:

```bash
git add shared/src/contracts.ts backend/src/providers/types.ts backend/src/config.ts backend/src/contracts/contracts.test.ts backend/src/ai
git commit -m "feat: define private AI recipe contracts"
```

### Task 2: Add Redis limiting and the OpenAI Responses adapter

**Files:**

- Modify: `backend/src/cache/client.ts`
- Create: `backend/src/ai/rateLimit.ts`
- Create: `backend/src/ai/rateLimit.test.ts`
- Create: `backend/src/providers/openaiRecipes.ts`
- Create: `backend/src/providers/openaiRecipes.test.ts`
- Modify: `backend/src/providers/factory.ts`
- Modify: `backend/src/providers/factory.test.ts`

**Interfaces:**

- `GenerationRateLimiter.consume(userId: string): Promise<{ allowed: boolean; used: number; remaining: number }>` uses a UTC date key and a one-day Redis expiry.
- `createRedisGenerationRateLimiter({ incrementWithExpiry, clock })` never includes recipe text or credentials in the key.
- `createOpenAiRecipeProvider({ apiKey, model, fetch })` implements `RecipeGenerationProvider.generate(request)`.
- The OpenAI body contains `store: false`, `text.format.type: 'json_schema'`, a strict recipe schema, a system instruction for diet/allergen compatibility and a user JSON payload; API keys are sent only in the Authorization header.

- [ ] **Step 1: Write failing limiter and provider tests**

Cover counts 1–5, rejection at 6, UTC key rollover, an OpenAI request with `store: false`, strict schema fields, extraction of structured output, non-2xx errors and malformed output. Assert that test request bodies do not contain the API key.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd backend && npm test -- --run src/ai/rateLimit.test.ts src/providers/openaiRecipes.test.ts src/providers/factory.test.ts
```

Expected: FAIL because the Redis counter and Responses adapter do not exist.

- [ ] **Step 3: Implement the bounded Redis counter**

Expose only an atomic increment-with-expiry operation from the cache adapter. Use `ikuck:ai-generations:<userId>:<YYYY-MM-DD>` and expire the key after the seconds remaining until the next UTC day plus a small safety margin. Treat Redis or provider errors as unavailable; never silently grant extra attempts.

- [ ] **Step 4: Implement Structured Outputs with `store: false`**

Use the Responses endpoint and parse `output_text` or the first `output_text` message content. Throw a typed provider error for non-success responses, invalid JSON and missing structured output. The adapter must not log request or response data.

- [ ] **Step 5: Verify and commit the provider unit**

Run backend focused tests, lint and build, then commit:

```bash
git add backend/src/cache backend/src/ai backend/src/providers
git commit -m "feat: add bounded OpenAI recipe provider"
```

### Task 3: Persist consent and private generated recipes behind authenticated routes

**Files:**

- Create: `backend/src/routes/aiRecipes.ts`
- Create: `backend/src/routes/aiRecipes.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/routes/sync.ts`
- Modify: `backend/src/routes/sync.test.ts`

**Interfaces:**

- `GET /v1/ai-recipes/consent` returns the current account consent or disabled default.
- `PUT /v1/ai-recipes/consent` requires same-origin and CSRF and stores `ai_consent/profile`.
- `GET /v1/ai-recipes` returns only non-deleted `generated_recipe` entities for the authenticated account.
- `POST /v1/ai-recipes` requires verified session, active consent, same-origin and CSRF; it validates pantry/profile input, consumes one Redis attempt, calls only the injected provider, validates compatibility and stores one private recipe.
- Provider unavailable, invalid model output and exhausted quota map to stable 503/429 errors without exposing provider details.

- [ ] **Step 1: Write failing route and sync tests**

Cover consent default/update/revocation, origin and CSRF rejection, unauthenticated and unverified access, five successful generations with the sixth rejected, private account scoping, incompatible model output rejection, generated-recipe deletion sync validation and provider-unavailable handling.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd backend && npm test -- --run src/routes/aiRecipes.test.ts src/routes/sync.test.ts
```

Expected: FAIL because the routes and entity validation do not exist.

- [ ] **Step 3: Implement consent and private resource routes**

Store consent and recipes through the existing last-write-wins sync repository with ids `profile` and generated recipe UUIDs. Filter every read by `session.userId`; do not reuse catalog ids or return the provider request. Require active consent immediately before the provider call.

- [ ] **Step 4: Wire production dependencies**

Select the OpenAI provider only when `OPENAI_API_KEY` exists, pass `OPENAI_MODEL` with a stable development default, construct the Redis limiter from the cache adapter and register the routes in `createApp` and `server.ts`.

- [ ] **Step 5: Verify and commit the authenticated backend unit**

Run the complete backend suite, lint and build; run the PostgreSQL/Redis integration suite only when its URLs are configured. Commit:

```bash
git add backend shared/src/contracts.ts
git commit -m "feat: add private AI recipe routes"
```

### Task 4: Add the consent and generation experience to the PWA

**Files:**

- Create: `frontend/src/ai/aiRecipeApi.ts`
- Create: `frontend/src/ai/aiRecipeApi.test.ts`
- Create: `frontend/src/components/ai/AiRecipePanel.tsx`
- Create: `frontend/src/components/ai/AiRecipePanel.test.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/domain/types.ts`

**Interfaces:**

- The panel consumes pantry labels, the local `DietProfilePayload` and verified auth state.
- Guests see explanatory copy but no generation control and make no AI request.
- Verified users can enable/revoke consent, generate from current pantry contents, see quota/provider errors in Italian, and view saved private recipes without adding them to `RECIPES`.
- `fetchAiRecipes` and `generateAiRecipe` use `apiRequest` and never accept or store a provider key.

- [ ] **Step 1: Write failing API and component tests**

Cover guest no-network behavior, consent checkbox accessibility, revocation, generation request payload, five-attempt exhaustion message, private recipe rendering and no mutation of pantry lots.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
cd frontend && npm test -- --run src/ai/aiRecipeApi.test.ts src/components/ai/AiRecipePanel.test.tsx
```

Expected: FAIL because the API wrapper and panel do not exist.

- [ ] **Step 3: Implement the explicit consent flow**

Keep consent server-side and show the current state after reload. Do not enable generation merely because a checkbox is clicked locally: save consent first and surface server errors. Revocation hides generation and leaves already saved private recipes readable until the user removes them.

- [ ] **Step 4: Implement generation and private rendering**

Send stable ingredient labels and the current profile, show a bounded loading state, render title/ingredients/steps/allergen metadata and keep pantry state unchanged. Add a detail link only if the private recipe has a route-safe id; do not route it through the curated `getRecipeById` lookup.

- [ ] **Step 5: Verify and commit the PWA unit**

Run all frontend tests, lint, typecheck and build, then commit:

```bash
git add frontend
git commit -m "feat: add private AI recipe experience"
```

### Task 5: AI smoke boundaries, browser verification and documentation

**Files:**

- Modify: `frontend/e2e/core-flow.spec.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-13-ai-recipes.md`

- [ ] **Step 1: Add mocked desktop/mobile browser coverage**

Mock the AI API and verify a verified user can consent, generate, reload and see the saved private recipe; revoke consent and confirm the generate control disappears. Assert the pantry list and lot data are unchanged.

- [ ] **Step 2: Run the complete verification set**

Run backend and frontend suites, lint, typecheck, builds and Playwright. Run the real OpenAI smoke only when `OPENAI_API_KEY` is explicitly supplied; otherwise record the exact skip. Run PostgreSQL/Redis integration only with configured URLs and record the skip otherwise.

- [ ] **Step 3: Review privacy and quota boundaries**

Run `git diff --check` and inspect that `store: false`, the provider key boundary, consent gate, Redis limit, private account filtering, compatible allergen metadata and no-pantry-mutation behavior are all covered by tests.

- [ ] **Step 4: Update README and plan evidence**

Document that AI is optional, verified-account-only, consent-based, limited to five generations per UTC day, private, compatible with the active diet/allergen filters and unavailable without a configured provider key.

- [ ] **Step 5: Commit the completed AI feature**

```bash
git add README.md frontend/e2e backend/src/integration docs/superpowers/plans/2026-09-13-ai-recipes.md
git commit -m "feat: add private AI recipe generation"
```

## Plan self-review

- The plan separates consent, quota, provider, private storage and UI so each boundary is independently testable.
- The server revalidates generated compatibility rather than trusting model instructions or client state.
- The provider key and raw recipe data remain server-side, while `store: false` avoids retaining OpenAI response objects for later retrieval.
- Guests retain the local-first experience and never need a provider credential or network request.
