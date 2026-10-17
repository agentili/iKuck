# Test Strategy: Bring! Shopping List → Pantry Inbox Flow

## Overview

This document defines a comprehensive test strategy for the feature where items checked off in Bring! during shopping become "candidates" in the pantry "Da confermare" inbox, requiring user confirmation before becoming pantry items.

**Risk Level: HIGH** — Async sync timing, deduplication, food filtering, and idempotency across multiple sync cycles create significant potential for unexpected behavior.

---

## 1. Architecture Under Test

### Core Components

| Component | Responsibility | Test Focus |
|-----------|----------------|------------|
| **Bring! Service (backend)** | Snapshot + watermark, `recently` delta detection, food filter, dedupe | Unit + Integration |
| **Shared Ingredients Catalog** | `INGREDIENTS`, `normalizeIngredientName`, `parseIngredientInput` | Unit (shared) |
| **Pantry Candidates API** | GET candidates, POST accept, POST ignore | Unit + Integration |
| **Frontend Inbox Panel** | Fetch on pantry open, optimistic accept/ignore | Unit + E2E |
| **Sync Orchestration** | Trigger sync on pantry open, watermark persistence | Integration |

### Data Flow

```
Bring! Sync (watermark) → Detect items moved to `recently` since last watermark
    → Filter via shared ingredients catalog (food vs non-food)
    → Dedupe on normalized label vs pantry lots + existing candidates
    → Create candidate records (server-side, not sync entities)
    → GET /pantry/candidates → Frontend "Da confermare" inbox
    → User: Accept → Create pantry lot + remove candidate
    → User: Ignore → Remove candidate (never returns)
```

---

## 2. Test Layers

### 2.1 Unit Tests (Fast, Isolated, Deterministic)

#### Shared Ingredients Catalog (`shared/src/ingredients.ts`)

| Test Case | Description |
|-----------|-------------|
| `normalizeIngredientName` handles accents, apostrophes, case, extra spaces | `normalizeIngredientName('  Olìo   d’Oliva  ') === 'olio d oliva'` |
| `parseIngredientInput` maps known aliases to canonical ingredients | `'pomodori, uova; ceci\ntonno'` → 4 known ingredients |
| `parseIngredientInput` deduplicates aliases resolving to same ingredient | `'pomodoro, pomodori'` → single `tomato` |
| `parseIngredientInput` preserves unknown ingredients as custom | `'Tempeh'` → `{ id: 'custom:tempeh', label: 'Tempeh', known: false }` |
| `parseIngredientInput` drops blank tokens | `' , ; \n '` → `[]` |
| `getIngredient` returns `undefined` for unknown IDs | `getIngredient('not-real') === undefined` |
| Catalog contains expected staple IDs | `DEFAULT_STAPLE_IDS` all have `staple: true` |

#### Bring! Service: Watermark & Candidate Detection (`backend/src/bring/service.ts`)

| Test Case | Description |
|-----------|-------------|
| Watermark persisted per (user, connectionId, listId) | New field in BringRepository |
| First sync: no watermark → all `recently` items become candidates | Baseline established |
| Subsequent sync: only `recently` items **after** watermark become candidates | Delta detection |
| Watermark updated to latest `recently` timestamp after successful candidate creation | Idempotency |
| Items moved `purchase → recently → purchase` (restore) don't create duplicate candidates | State transition handling |
| Items already in pantry (by normalized label) excluded from candidates | Dedupe against pantry |
| Items already in candidates inbox excluded from new candidates | Dedupe against inbox |
| Non-food items (no match in ingredients catalog) excluded from candidates | Food filter conservative |
| Watermark not advanced on candidate creation failure | Atomicity |

#### Pantry Candidates Service (New: `backend/src/pantry/candidatesService.ts`)

| Test Case | Description |
|-----------|-------------|
| `getCandidates(userId)` returns pending candidates for user's house | Scope: house |
| `acceptCandidate(userId, candidateId)` creates pantry lot + removes candidate | Happy path |
| `acceptCandidate` fails if candidate already accepted/ignored | Idempotency |
| `acceptCandidate` fails if candidate not found | Not found |
| `acceptCandidate` dedupes against existing pantry lots (normalized label) | No duplicate lots |
| `ignoreCandidate(userId, candidateId)` removes candidate permanently | Ignore path |
| `ignoreCandidate` idempotent on already-ignored | Idempotency |
| Candidates have TTL (e.g., 30 days) with cleanup job | Hygiene |

#### Food Filter Logic (New: `backend/src/bring/foodFilter.ts`)

| Test Case | Description |
|-----------|-------------|
| `isFoodItem(label: string): boolean` uses shared `parseIngredientInput` | Single source of truth |
| Known ingredient → `true` | `'Latte'` → `true` |
| Unknown ingredient → `false` (conservative) | `'Detergente'` → `false` |
| Empty/whitespace label → `false` | `''` → `false` |
| Normalization matches frontend behavior exactly | Shared function |

### 2.2 Integration Tests (Real Dependencies)

#### Bring! Sync → Candidates Pipeline

| Test Case | Description |
|-----------|-------------|
| Full sync: Bring! list with mixed `purchase`/`recently` → correct candidates created | End-to-end |
| Sync with app closed during shopping: items checked off → next sync creates candidates | Async timing |
| Multiple syncs during shopping: no duplicate candidates | Idempotency across syncs |
| Sync after restore (`recently → purchase`): no candidate for restored item | State machine |
| Network failure mid-sync: watermark not advanced, retry safe | Resilience |
| Concurrent syncs (two devices): no duplicate candidates | Concurrency |

#### Pantry Candidates API + Database

| Test Case | Description |
|-----------|-------------|
| `GET /pantry/candidates` returns house-scoped candidates | AuthZ |
| `POST /pantry/candidates/:id/accept` creates `pantry_lot` with correct fields | Persistence |
| `POST /pantry/candidates/:id/ignore` soft-deletes candidate | Ignore flow |
| Accept + immediate second accept returns 409 | Idempotency |
| Accept dedupes against existing lot (case/accent insensitive) | Dedupe |
| Candidates cleaned up after TTL | Job |

### 2.3 Frontend Tests

#### Inbox Panel (`frontend/src/components/pantry/CandidatesInbox.tsx`)

| Test Case | Description |
|-----------|-------------|
| Panel fetches candidates on mount (pantry open) | Trigger |
| Optimistic UI: accept immediately removes from list, rolls back on error | UX |
| Optimistic UI: ignore immediately removes from list, rolls back on error | UX |
| Empty state: "Nessun articolo da confermare" | UX |
| Loading skeleton while fetching | UX |
| Error toast on fetch/accept/ignore failure | Error handling |
| Candidate shows: label, specification, source (Bring!), timestamp | Display |

#### Integration with Pantry Page

| Test Case | Description |
|-----------|-------------|
| Opening pantry triggers Bring! sync → then fetches candidates | Sync chain |
| Accepted item appears in pantry lots list immediately | Cross-panel sync |
| Ignored item never reappears | Permanence |

### 2.4 E2E Tests (Playwright)

| Test Case | Description |
|-----------|-------------|
| **Happy Path**: Connect Bring! → Sync → Check off items in Bring! app → Open iKuck pantry → See candidates → Accept → Item in pantry | Full user journey |
| **Async Shopping**: Sync → Close app → Shop (check off in Bring! app) → Open iKuck → Sync runs → Candidates appear | Real-world timing |
| **Non-food Filter**: Add "Detergente" to Bring! → Check off → Sync → Not in candidates | Food filter |
| **Dedupe**: Item already in pantry → Check off in Bring! → Sync → Not in candidates | Dedupe |
| **Ignore**: Candidate ignored → Re-sync → Never returns | Ignore permanence |
| **Multi-device**: Device A accepts, Device B opens pantry → Candidate gone | Cross-device |

---

## 3. Test Data & Fixtures

### Bring! List Fixtures

```typescript
// Minimal list for unit tests
const minimalList: RawItems = {
  uuid: LIST_ID,
  status: 'REGISTERED',
  purchase: [{ name: 'Latte', specification: '1 l' }],
  recently: [],
};

// Mixed state for delta testing
const mixedList: RawItems = {
  uuid: LIST_ID,
  status: 'REGISTERED',
  purchase: [{ name: 'Pane', specification: '500g' }],
  recently: [
    { name: 'Latte', specification: '1 l', updatedAt: '2025-01-15T10:00:00Z' },
    { name: 'Yogurt', specification: '4x125g', updatedAt: '2025-01-15T10:05:00Z' },
  ],
};

// Non-food items
const nonFoodList: RawItems = {
  uuid: LIST_ID,
  status: 'REGISTERED',
  purchase: [],
  recently: [
    { name: 'Detersivo piatti', specification: '1 l' },
    { name: 'Carta igienica', specification: '4 rotoli' },
  ],
};
```

### Watermark Fixtures

```typescript
// No watermark (first sync)
const noWatermark = null;

// Watermark at specific timestamp
const watermarkAt = '2025-01-15T09:00:00Z'; // Before Latte/Yogurt
const watermarkAfter = '2025-01-15T10:10:00Z'; // After all recently
```

---

## 4. Test Execution Strategy

### CI Pipeline

```yaml
# .github/workflows/test.yml
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci --prefix shared && npm test --prefix shared
      - run: npm ci --prefix backend && npm test --prefix backend
      - run: npm ci --prefix frontend && npm test --prefix frontend

  integration:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: test } }
      redis: { image: redis:7 }
    env:
      INTEGRATION_DATABASE_URL: postgresql://postgres:test@localhost:5432/test
      INTEGRATION_REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - run: npm ci --prefix backend && npm run test:integration --prefix backend

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci --prefix frontend && npx playwright install --with-deps chromium
      - run: npm run test:e2e --prefix frontend
```

### Local Development

```bash
# Unit tests (fast feedback)
npm test --prefix shared
npm test --prefix backend
npm test --prefix frontend

# Integration (requires DB/Redis)
INTEGRATION_DATABASE_URL=... INTEGRATION_REDIS_URL=... npm run test:integration --prefix backend

# E2E (requires built frontend)
npm run build --prefix frontend && npm run test:e2e --prefix frontend
```

---

## 5. Acceptance Criteria (Definition of Done)

| Criterion | Verification |
|-----------|--------------|
| All unit tests pass | `npm test` green in all packages |
| All integration tests pass | `npm run test:integration` green with real DB/Redis |
| All E2E tests pass | `npm run test:e2e` green on Chromium |
| Coverage ≥ 80% on new code | `npm run coverage` |
| No flaky tests | 3 consecutive CI runs green |
| ADR-003 documented | Architecture decision recorded |
| Performance: sync + candidates < 2s p95 | Load test with 100 items |

---

## 6. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Async sync loses items | Watermark persisted server-side, idempotent delta detection |
| Food filter false negatives | Conservative: only known ingredients pass; unknown → manual add |
| Food filter false positives | Catalog curated; aliases reviewed |
| Duplicate candidates | Dedupe on normalized label at creation + unique DB constraint |
| Duplicate pantry lots | Dedupe on accept + unique DB constraint on (houseId, normalizedLabel) |
| Race condition: concurrent syncs | Watermark update in same transaction as candidate creation |
| Stale candidates | TTL + cleanup job; ignore is permanent |
| Frontend/backend catalog drift | Single source in `shared/`; CI verifies exports |

---

## 7. Implementation Order (Test-First)

1. **Shared Ingredients** → Move to `shared/src/ingredients.ts`, add tests, update exports
2. **Food Filter** → `backend/src/bring/foodFilter.ts` using shared catalog, unit tests
3. **Watermark Repository** → Extend `BringRepository` with watermark CRUD, unit tests
4. **Candidate Detection** → Extend `BringService` with `detectCandidates`, unit tests
5. **Candidates Service** → New `backend/src/pantry/candidatesService.ts`, unit + integration tests
6. **API Routes** → `GET /pantry/candidates`, `POST /accept`, `POST /ignore`, integration tests
7. **Frontend Inbox** → `CandidatesInbox.tsx`, unit + E2E tests
8. **Sync Orchestration** → Trigger sync on pantry open, integration tests
9. **E2E Scenarios** → Full user journeys in Playwright

---

## 8. Test Maintenance Rules

- **RED-GREEN-REFACTOR**: Every test written before implementation, fails first
- **One behavior per test**: No horizontal slices
- **Real code over mocks**: Mock only Bring! gateway, DB, Redis
- **Test names = behavior descriptions**: `creates_candidate_when_item_moves_to_recently_after_watermark`
- **Generated tests must pass in clean CI**: No manual setup
- **Flaky test = blocker**: Fix or delete immediately

---

## 9. Open Questions for Team

1. **Candidate TTL**: 30 days? Configurable?
2. **Batch accept/ignore**: Multi-select in UI?
3. **Candidate metadata**: Store Bring! list name, check-off timestamp?
4. **House vs Account scope**: Candidates are house-scoped (per ADR), confirmed?
5. **Notification**: Push/email when new candidates arrive?

---

*Generated by @tester for ADR-003 implementation. Review with @architect, @bdev, @fdev before implementation starts.*