# Code inventory — Bring! → pantry candidates (Cards 1+2+3)

Source of truth for decisions: `docs/adr-003-bring-to-pantry-candidates.md`.
Card numbering follows ADR-003 §Decision: Card 1 = shared ingredient catalogue, Card 2 = conservative server-side food filter, Card 3 = server-side watermark + snapshot diff (idempotent sync). Additional chain areas requested: initial sync/backfill behavior, watermark persistence, SyncEntityType usage, casa (= house) scope.

All paths are relative to the repository root (`/home/hermes/iKuck`).

## Card 1 — shared ingredient catalogue (precondition for the server-side food filter)

| Area | File | Lines | Notes |
|------|------|-------|-------|
| Ingredient catalogue + normalization | `shared/src/ingredients.ts` | 1–116 | `IngredientDefinition` (11–18), `ParsedIngredient` (20–24), `INGREDIENTS` (26–67), `normalizeIngredientName` (71–79), `parseIngredientInput` (93–116). Pure data + functions, no UI dependencies. Moved here from `frontend/src/domain/ingredients.ts` (per ADR-003 Card 1). Exported as `./ingredients` in `shared/package.json`. |
| Catalogue-backed food matching | `backend/src/bring/foodFilter.ts` | 1–17 | `matchFoodIngredient` (11–15): resolves a label via `ingredientsByAlias` (exact match or catalogue alias); returns `null` for unknown labels. `isFoodItem` (17): boolean wrapper. Conservative: false negatives preferred over false positives. |

## Card 2 — conservative server-side food filter

| Area | File | Lines | Notes |
|------|------|-------|-------|
| Filter entry point | `backend/src/bring/foodFilter.ts` | 11–17 | `matchFoodIngredient(label)` returns `ParsedIngredient \| null`; unknown/non-food labels (`Detersivo piatti`, `Ceci e detersivo`, whitespace) return `null` (see `foodFilter.test.ts` lines 12–14). |
| Filter applied at candidate creation (Drizzle) | `backend/src/pantry/candidatesRepository.ts` | 115–119 | In `syncRecently` non-baseline branch: `matchFoodIngredient(item.label) === null || normalizedLabel.length === 0 || pantryLabels.has(...) || seenLabels.has(...)` → `continue`. `seenLabels` dedupes within one sync (113–119); `pantryLabels` dedupes against existing pantry lots (104–112). |
| Filter applied at accept (Drizzle) | `backend/src/pantry/candidatesRepository.ts` | 190–191 | `matchFoodIngredient(candidate.label) === null` → `invalid_candidate`, not persisted. |
| Filter applied at candidate creation (memory repo) | `backend/src/pantry/candidatesRepository.ts` | 270–274 | Same conservative filter + `existingLots`/`seenLabels` dedupe in `createMemoryPantryCandidateRepository.syncRecently`. |
| Filter applied at accept (memory repo) | `backend/src/pantry/candidatesRepository.ts` | 315–316 | `ingredient === null` → `invalid_candidate`. |
| Consumer of filter | `backend/src/pantry/candidatesRepository.ts` | 9 | `import { matchFoodIngredient } from '../bring/foodFilter.js';` |

## Card 3 — initial sync / backfill behavior (baseline, no historical backfill)

| Area | File | Lines | Notes |
|------|------|-------|-------|
| Snapshot diff primitive | `backend/src/bring/recently.ts` | 17–32 | `diffRecentlySnapshot(previous, current)`: if `previous === null` returns `{ baseline: true, added: [] }` (line 21) — first sync establishes baseline and creates NO candidates from historical `recently` entries. Otherwise computes `added` items not in previous keys (22–31), `{ baseline: false, added }` (31). |
| Recently item shape | `backend/src/bring/recently.ts` | 1–8 | `RecentlySnapshotItem`: `listId`, `listName`, `name`, `label`, `specification`, `checkedOffAt`. Key (dedupe identity) at 10–15: `[listId, name, specification, checkedOffAt]`. |
| Fetching Bring! `recently` state | `backend/src/bring/service.ts` | 291–340 | `syncCandidates(userId, houseId)`: reads the connection record (294–296), enumerates allowed lists (299–301), fetches `gateway.items` per list and pushes `raw.recently` items into the snapshot (315–324, `checkedOffAt: item.updatedAt ?? null`), sorts the snapshot (326–329), then calls `candidateRepository.syncRecently(...)` (330–337). Returns `{ connected, baseline, created }` (338). |
| Baseline vs. delta (Drizzle repo) | `backend/src/pantry/candidatesRepository.ts` | 75–146 | `syncRecently`: `previous = connection.recentlySnapshot` (93); `delta = diffRecentlySnapshot(previous, input.snapshot)` (94). If `!delta.baseline` (98–138): creates candidates only for `delta.added`, expires old candidates (99–103), dedupes against pantry lots, then advances watermark+snapshot in the same transaction (134–137). If baseline (141–145): updates watermark+snapshot only, `created: 0`, no candidates. |
| Baseline vs. delta (memory repo) | `backend/src/pantry/candidatesRepository.ts` | 255–299 | Same semantics: `previous === null` → baseline, snapshot stored, `created: 0` (297–298); otherwise diff + create only new (259–295). |
| No backfill guard (tests) | `backend/src/pantry/candidatesRepository.test.ts` | 28–31 | First sync establishes baseline without importing historical items (`baseline: true, created: 0`). |
| Offline check-off beyond watermark (mandatory test) | `backend/src/bring/service.test.ts` | 1039–1081 | Sets a baseline, then catches offline check-offs older than the previous watermark. |

## Watermark persistence

| Area | File | Lines | Notes |
|------|------|-------|-------|
| Watermark columns (schema) | `backend/src/db/schema.ts` | 34–41 | `bringConnections` table: `recently_watermark_at` timestamptz (39), `recently_snapshot` jsonb `$type<RecentlySnapshotItem[]>` (40). |
| Watermark columns (migration) | `backend/src/db/migrations/0010_pantry_candidates.sql` | 1–4 | `ALTER TABLE bring_connections ADD COLUMN IF NOT EXISTS recently_watermark_at timestamptz;` (1–2) and `recently_snapshot` jsonb (3–4). |
| Base connection table (migration) | `backend/src/db/migrations/0008_bring_connections.sql` | 1–6 | `bring_connections` table (`user_id` PK, `connection_id`, `encrypted_session`, `connected_at`). |
| Candidate table (schema) | `backend/src/db/schema.ts` | 72–89 | `pantry_candidates`: `house_id` FK (74), `expires_at` NOT NULL (82), `status` check pending/accepted/ignored (88), unique index `(house_id, normalized_label)` (86), index `(house_id, status, expires_at)` (87). |
| Candidate table (migration) | `backend/src/db/migrations/0010_pantry_candidates.sql` | 6–25 | `CREATE TABLE pantry_candidates` (6–20), unique index (22–23), status/expiry index (24–25). |
| Watermark write (Drizzle) | `backend/src/pantry/candidatesRepository.ts` | 134–137 | `UPDATE bring_connections SET recently_watermarkAt = now, recentlySnapshot = [...input.snapshot]` inside the same transaction as candidate creation. Same statement repeated in baseline branch (141–144). |
| Watermark write (memory repo) | `backend/src/pantry/candidatesRepository.ts` | 294, 297 | `snapshots.set(key, structuredClone(input.snapshot))` on both delta and baseline paths. |
| TTL / expiry | `backend/src/config.ts` | 37, 179 | `bringCandidateTtlDays` (default 30 via `createBringService` default at `service.ts` line 138). `expiresAtFor(detectedAt, ttlDays)` in `candidatesRepository.ts` line 59. |
| Cleanup job | `backend/src/db/cleanupBringCandidates.ts` | 1–end | Uses `createDrizzlePantryCandidateRepository.cleanupExpiredCandidates`. |

## SyncEntityType usage

| Area | File | Lines | Notes |
|------|------|-------|-------|
| Canonical literals | `shared/src/contracts.ts` | 1–15 | `SYNC_ENTITY_TYPES` (1–13) includes `pantry_lot` (3) but NO candidates entity type. `SyncEntityType = typeof SYNC_ENTITY_TYPES[number]` (15). |
| House scope allowlist | `shared/src/contracts.ts` | 17–28 | `HOUSE_SYNC_ENTITY_TYPES` includes `pantry_lot`; `PERSONAL_SYNC_ENTITY_TYPES` (30–32) is `ai_consent` only. `SyncMutationScope = \`account:${string}\` | \`house:${string}\`` (36). |
| Contract decision | `docs/adr-003-bring-to-pantry-candidates.md` | 7, 21, 47 | No new `SyncEntityType` for candidates; candidates endpoint is read-only and outside the sync path; no changes to `shared/src/contracts.ts` sync maps. |
| Sync map validation (backend) | `backend/src/sync/validation.ts` | 1, 57 | Imports `SyncEntityType`; `payloadSchemas satisfies Record<SyncEntityType, z.ZodTypeAny>` (57). |
| `pantry_lot` written on accept | `backend/src/pantry/candidatesRepository.ts` | 107, 195, 217 | `syncItems` rows inserted with `entityType: 'pantry_lot'`, `scopeType: 'house'`, `scopeId: houseId` (213–218) when a candidate is accepted and not a duplicate of an existing lot. Pantry lot payload shape from `shared/src/contracts.ts` `PantryLot` (161–174). |

## Casa (= house) scope

| Area | File | Lines | Notes |
|------|------|-------|-------|
| House membership resolution | `backend/src/pantry/candidatesService.ts` | 14–18 | `houseForUser(userId)`: `houseRepository.getMembershipForUser`; throws `house_membership_required` 403 when null. |
| All inbox endpoints scoped by house | `backend/src/pantry/candidatesService.ts` | 23–36 | `list`, `accept`, `ignore` all resolve `houseId` first, then delegate to repository with `(userId, houseId, ...)`. |
| House-scoped locking (Drizzle) | `backend/src/pantry/candidatesRepository.ts` | 74–84 | `syncRecently`: `users FOR SHARE` (77), `houses FOR UPDATE` (78), membership `FOR KEY SHARE` (79–82, throws if empty), `pg_advisory_xact_lock('ikuck:pantry:house:' + houseId)` (84). Same lock pattern in `resolveMany` (169–176). |
| Connection row locked per house connection | `backend/src/pantry/candidatesRepository.ts` | 86–91 | `bringConnections` by `userId` + `connectionId` `FOR UPDATE`; missing → `bring_stale_connection` 409. |
| Candidate rows keyed by house | `backend/src/db/schema.ts` | 72–89 | `pantry_candidates.house_id` FK to `houses` (74) with `ON DELETE CASCADE`; unique index `(house_id, normalized_label)` (86). Queries filter `eq(pantryCandidates.houseId, houseId)` (100, 154, 178). |
| Sync items house-scoped | `backend/src/pantry/candidatesRepository.ts` | 213–218, 104–108 | `syncItems` inserts/reads use `scopeType: 'house'` and `scopeId: houseId`; entity type `pantry_lot`. |
| Memory repo house scoping | `backend/src/pantry/candidatesRepository.ts` | 257, 267, 300–302 | Snapshots keyed by `userId:connectionId`; lots keyed by `houseId`; `listPending` filters `candidate.houseId === houseId`. |
| HTTP route house scoping | `backend/src/routes/pantryCandidates.ts` | 29–52 | `GET /v1/pantry/candidates` (29), `POST /v1/pantry/candidates/accept` (36), `POST /v1/pantry/candidates/ignore` (45): all derive `userId` from `requireVerifiedSession` and pass it to `service.list/accept/ignore`; CSRF + same-origin on mutating endpoints (37–39, 46–48); `cache-control: no-store` hook (26). |
| Wiring | `backend/src/app.ts` | 23, 46, 102 | Imports `registerPantryCandidateRoutes`, declares `pantryCandidates?: PantryCandidateRouteDependencies`, registers when defined. |
| Wiring | `backend/src/server.ts` | 7–8, 76, 118 | Creates `createDrizzlePantryCandidateRepository` (7), `createPantryCandidateService` (8, 76), passes to route dependencies (118). |

## Tests covering the chain

| File | Lines | Covers |
|------|-------|--------|
| `backend/src/bring/foodFilter.test.ts` | 1–14 | Conservative filter: known ingredients resolve, non-food/whitespace → null. |
| `backend/src/bring/recently.test.ts` | 15–30 | First sync = baseline, no backfill; offline check-off older than watermark still captured; identical snapshot → no additions. |
| `backend/src/pantry/candidatesRepository.test.ts` | 28–104 | Baseline behavior, candidate creation post-watermark, idempotent re-sync (created: 0), dedupe on normalized label, expiry cleanup. |
| `backend/src/pantry/candidatesService.test.ts` | 22 | `syncCandidates` stub returning `connected: true, baseline: false, created: 1`. |
| `backend/src/bring/service.test.ts` | 1039–1081 | Baseline then offline check-off catch-up (mandatory test per ADR-003 §Consequences). |
| `backend/src/integration/bring.integration.test.ts` | 650–715 | End-to-end: baseline historical items, then create + accept a house-scoped food candidate; repeated GET is idempotent. |
| `backend/src/db/candidates-schema.test.ts` | 11–26 | `recently_watermark_at` column and additive migration for candidate tables + watermarks. |

## Notes

- `casa` in this codebase = `house` (`house_memberships`, `houses`, `houseId`, scope `house:${string}`); there is no separate "casa" concept — the term maps to the house scope used for pantry/lists/shared entities per the scope matrix (`pantry_item`, `pantry_lot`, `staple_preference` are house-shared).
- No new `SyncEntityType` literal was introduced for candidates; `pantry_lot` is the only sync entity touched by this chain (written on accept).
- Schema changes went through Drizzle migrations (`0008_bring_connections`, `0010_pantry_candidates`), not TypeScript edits only.
