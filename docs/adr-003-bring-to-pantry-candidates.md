# ADR-003: Bring! → pantry candidates (post-shopping sync)

## Context

After a shopping trip, bought items should land in the iKuck pantry without manual re-entry. The signal is the check-off in Bring!: items the user ticks while shopping move into Bring!'s "recently purchased" state. iKuck must turn that signal into pantry entries while:

- keeping guest/offline-first semantics intact (no new `SyncEntityType`, candidates endpoint is read-only and outside the sync path);
- filtering conservatively so non-food items never reach the pantry;
- staying idempotent when the same Bring! state is read multiple times (retry, re-open, offline catch-up);
- not seeding the inbox with historical purchases on first activation.

Team inputs this ADR consolidates: `TEST_STRATEGY_BRING_TO_PANTRY.md` (@tester, incl. its 5 open questions), the shared-catalogue reconnaissance (@fdev), and the backend sequencing (@bdev).

## Decision

1. **Shared ingredient catalogue.** `INGREDIENTS`, `normalizeIngredientName`, `IngredientDefinition` and `ParsedIngredient` move from `frontend/src/domain/ingredients.ts` to `shared/src/ingredients.ts`, exported as `./ingredients` in `shared/package.json`. Same API, pure data + functions, no UI dependencies. This is Card 1 of the chain and the precondition for the server-side food filter.
2. **Conservative server-side food filter.** `backend/src/bring/foodFilter.ts` decides candidacy using only the shared catalogue: an item passes when its normalized label resolves to a known ingredient (exact match or catalogue alias). Unknown labels are never guessed as food — the user can still add them to the pantry manually. False negatives are preferred over false positives.
3. **Server-side watermark + snapshot diff (idempotent).** The backend stores, per household connection, a watermark (last-read cursor/timestamp of Bring! "recently purchased" state). Each sync computes the diff since the watermark and creates candidates plus advancing the watermark **in the same transaction**, so retries and re-opens are no-ops. Check-offs made offline, beyond the previous window, are still captured by the diff on the next sync — this case is a mandatory unit test.
4. **First sync is a baseline, not a backfill.** On activation the first read only sets the watermark; it does not create candidates from historical `recently` entries. Otherwise the inbox would open full of old purchases. Only changes after the baseline appear as candidates.
5. **Candidates are house-scoped.** Candidate records and the inbox live under the house scope (same semantics as the house-shared shopping list; `ai_consent` remains the personal exception). All household members see and resolve the same inbox.
6. **Read-only endpoint outside the sync path.** `GET /v1/pantry/candidates` (plus `POST /v1/pantry/candidates/accept` and `/ignore`) serves the inbox. No new `SyncEntityType` literals, no changes to `shared/src/contracts.ts` sync maps; sync is triggered automatically when the pantry page opens.
7. **Dedupe on normalized label.** Candidates are deduplicated at creation on the normalized label with a unique DB constraint; accepted items additionally dedupe against existing pantry lots on `(houseId, normalizedLabel)`. Ignored candidates are permanent: they never reappear.

### Operational rhythm (user-facing, documented in ADR so it does not drift)

1. **Before shopping (recommended, not required):** open iKuck once — this sets/refreshes the watermark and delimits candidates to "this shopping trip".
2. **During shopping:** tick the bought items in Bring!. The tick is the signal.
3. **After shopping:** open the pantry — sync runs automatically, new candidates appear under "Da confermare": accept or ignore each. Ignored items never return; non-food and duplicates never appear at all.

Because the diff is watermark-based, even a fully offline shopping trip (iKuck never opened) is recovered by the next sync; step 1 only narrows the window.

### Open questions from the test strategy — resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | Candidate TTL | 30 days, configurable via `BRING_CANDIDATE_TTL_DAYS` (default `30`). A cleanup job drops expired candidates; `ignore` is permanent and unaffected by TTL. |
| 2 | Batch accept/ignore | Yes: both endpoints accept an array of candidate ids (max 100 per request, invalid ids reported per-item, never partially silent). UI offers multi-select with "seleziona tutti". |
| 3 | Candidate metadata | Store: raw Bring! label, normalized label, Bring! list name, check-off timestamp (from the remote state), detection timestamp. Shown in the inbox row for traceability. |
| 4 | House vs account scope | **House**, confirmed (see Decision 5). |
| 5 | Notifications | None in v1. The pantry tab shows a badge with the pending-candidate count; push/email is deferred to a later ADR to keep v1 free of delivery/retry machinery. |

## Alternatives Considered

- **Frontend-driven sync (client reads Bring! and posts candidates)** — rejected: the browser must never talk to Bring! directly (existing boundary), and client-side watermarks break with multiple devices/offline. Server-side watermark is the only idempotency anchor that survives retries.
- **Fuzzy/LLM food classification** — rejected for v1: non-deterministic, needs an external dependency at request time, and false positives pollute the pantry. The conservative catalogue keeps behaviour testable; unknown labels fall back to manual add.
- **Backfilling historical `recently` on first sync** — rejected: inbox noise on activation destroys trust in the feature (Decision 4).
- **New `SyncEntityType` + generic sync channel** — rejected: candidates are a derived, read-only view, not device-synced state; adding a sync entity would expand scope allowlists and guest/account import surfaces for no benefit (Decision 6).
- **Auto-accept straight into the pantry** — rejected: without a confirmation inbox a Bring! mis-tick silently corrupts pantry stock; the inbox keeps the human in the loop (per-risk preference: unexpected results are the main failure mode here).

## Consequences

- **Backend:** new `foodFilter`, watermark columns/migration (Drizzle), candidate table + unique constraints (Drizzle migration, not only TS edits), three endpoints, TTL cleanup, transactional watermark update; integration tests need disposable PostgreSQL/Redis.
- **Frontend:** Card 1 is a pure import refactor across 10 files; later, the "Da confermare" inbox with optimistic accept/ignore and sync-on-pantry-open; badge with pending count.
- **Deploy:** `shared/` ships as `file:` dependency — no extra infra; new env `BRING_CANDIDATE_TTL_DAYS` optional (default safe); no changes to Caddy build args or `.env.standalone` required for v1.
- **Testing:** `TEST_STRATEGY_BRING_TO_PANTRY.md` is the gate; the offline-checkoff-beyond-watermark unit test added per @bdev is mandatory before review.
- **Security/privacy:** no new secrets; candidate labels are user's own shopping data, house-scoped authorisation on all three endpoints; no new outbound data flows to Bring! (reads only, via existing encrypted connection).
- **Performance:** candidate creation is O(changed items) per sync thanks to the watermark; DoD keeps sync + candidates < 2s p95 at 100 items.