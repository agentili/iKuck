# ADR-003 audit report — Bring! → pantry candidates

- **Audited ADR:** `docs/adr-003-bring-to-pantry-candidates.md` (57 lines; 7 decisions D1–D7, 5 open questions resolved D8–D12)
- **Source of truth:** `docs/adr-003-compliance-matrix.md` (compliance matrix from task 2, cross-checked against `docs/bring-to-pantry-code-inventory.md` and the live implementation in `shared/` and `backend/`)
- **Auditor:** reviewer (independent review run)
- **Verdict scale:** PASS = decision implemented as decided, with code evidence; FAIL = deviation from ADR-003 requiring a defect record

## Result summary

| Metric | Count |
|--------|-------|
| Requirements/decisions checked | 5 |
| PASS | 5 |
| FAIL | 0 |
| Defect records raised | 0 |
| Fix tasks required | 0 |

Overall: **5/5 PASS — ADR-003 fully compliant. Audit complete.**

## Decision-by-decision audit (all checked off)

| # | ADR-003 decision | ADR ref | Code evidence (file:line) | Verdict |
|---|------------------|---------|---------------------------|---------|
| 1 | Conservative server-side food filter: candidacy decided only via the shared catalogue; unknown labels never guessed as food (`null`), false negatives preferred over false positives; manual add still allowed. | Decision 2 line 17; Context bullet 2 line 8; Alternative rejected line 45 | `shared/src/ingredients.ts:1–116` (catalogue, `normalizeIngredientName` 71–79)<br>`backend/src/bring/foodFilter.ts:11–15` (`matchFoodIngredient` returns `null` for unknown labels; `isFoodItem` line 17)<br>`backend/src/pantry/candidatesRepository.ts:115–118` (filter at candidate creation, Drizzle)<br>`backend/src/pantry/candidatesRepository.ts:190–191` (filter at accept → `invalid_candidate`)<br>`backend/src/pantry/candidatesRepository.ts:270–274` (same filter, memory repo)<br>`backend/src/pantry/candidatesRepository.ts:315–316` (same filter, memory repo accept)<br>`backend/src/bring/foodFilter.test.ts:12–14` (non-food/whitespace → `null`) | PASS |
| 2 | First sync is a baseline, not a backfill: first read only sets the watermark; no candidates from historical `recently` entries; only post-baseline changes become candidates. | Decision 4 line 19; Context bullet 4 line 10; Alternative rejected line 46 | `backend/src/bring/recently.ts:21` (`previous === null` → `{ baseline: true, added: [] }`)<br>`backend/src/pantry/candidatesRepository.ts:141–145` (baseline branch: watermark+snapshot updated, `created: 0`, no candidates)<br>`backend/src/pantry/candidatesRepository.ts:297–298` (memory repo: same baseline semantics)<br>`backend/src/bring/service.ts:291–340` (`syncCandidates` builds snapshot and delegates to `syncRecently`; returns `{ connected, baseline, created }` at line 338)<br>`backend/src/pantry/candidatesRepository.test.ts:28–31` (first sync baseline without importing historical items)<br>`backend/src/bring/service.test.ts:1039–1081` (baseline then offline check-off catch-up — mandatory test) | PASS |
| 3 | Atomic watermark write: watermark advanced in the same transaction as candidate creation, so retries/re-opens are no-ops. | Decision 3 line 18 | `backend/src/pantry/candidatesRepository.ts:75` (`database.transaction` wraps everything)<br>`backend/src/pantry/candidatesRepository.ts:120–133` (candidate creation inside the transaction)<br>`backend/src/pantry/candidatesRepository.ts:134–137` (`UPDATE bring_connections SET recentlyWatermarkAt, recentlySnapshot` inside the same transaction)<br>`backend/src/pantry/candidatesRepository.ts:141–144` (baseline branch also updates watermark inside the transaction)<br>`backend/src/pantry/candidatesRepository.ts:294, 297` (memory repo: snapshot stored on both delta and baseline paths)<br>`backend/src/db/schema.ts:39–40` (`recently_watermark_at`, `recently_snapshot` columns)<br>`backend/src/db/migrations/0010_pantry_candidates.sql:1–4` (watermark columns added additively) | PASS |
| 4 | No new `SyncEntityType`: candidates are a derived read-only view outside the sync path; no changes to `shared/src/contracts.ts` sync maps. | Decision 6 line 21; Context bullet 1 line 7; Alternative rejected line 47 | `shared/src/contracts.ts:1–15` (`SYNC_ENTITY_TYPES` includes `pantry_lot` line 3, NO candidates entity type; `SyncEntityType` type alias line 15)<br>`shared/src/contracts.ts:17–32` (`HOUSE_SYNC_ENTITY_TYPES` / `PERSONAL_SYNC_ENTITY_TYPES` allowlists untouched — `ai_consent` only personal)<br>`backend/src/routes/pantryCandidates.ts:29–52` (`GET /v1/pantry/candidates`, `POST .../accept`, `POST .../ignore` — inbox endpoints, no sync-entity writes)<br>`backend/src/sync/validation.ts:1, 57` (imports `SyncEntityType`; payload schemas keyed by existing types only)<br>`docs/adr-003-bring-to-pantry-candidates.md:7, 21, 47` (contract decision restated) | PASS |
| 5 | Casa (= house) scope: candidates and inbox live under house scope; all household members see/resolve the same inbox. `ai_consent` remains the personal exception. | Decision 5 line 20; Open question 4 line 39 | `backend/src/pantry/candidatesService.ts:14–18` (`houseForUser`; 403 `house_membership_required` when null)<br>`backend/src/pantry/candidatesService.ts:23–36` (`list`, `accept`, `ignore` all resolve `houseId` first)<br>`backend/src/pantry/candidatesRepository.ts:74–84` (house-level advisory lock `pg_advisory_xact_lock('ikuck:pantry:house:...')` line 84; membership `FOR KEY SHARE` lines 79–82)<br>`backend/src/pantry/candidatesRepository.ts:86–91` (connection row locked per user+connection `FOR UPDATE`)<br>`backend/src/db/schema.ts:72–89` (`pantry_candidates.house_id` FK to `houses` ON DELETE CASCADE line 74; unique index `(house_id, normalized_label)` line 86; queries filter `eq(pantryCandidates.houseId, houseId)` lines 100, 154, 178)<br>`backend/src/pantry/candidatesRepository.ts:213–218` (accepted candidates write `syncItems` with `scopeType: 'house'`, `scopeId: houseId`, `entityType: 'pantry_lot'`)<br>`backend/src/routes/pantryCandidates.ts:29–52` (`userId` from `requireVerifiedSession` passed to service; CSRF + same-origin on mutating endpoints lines 37–39, 46–48)<br>`backend/src/pantry/candidatesRepository.ts:257, 267, 300–302` (memory repo house scoping: snapshots keyed by `userId:connectionId`, lots by `houseId`, `listPending` filters `candidate.houseId === houseId`) | PASS |

## Defect records

No FAIL verdicts were recorded, therefore **no defect records exist**. The defect list is empty.

| Defect id | ADR-003 decision | Expected behavior | Actual behavior | Location | Status |
|-----------|------------------|-------------------|-----------------|----------|--------|
| — | — | — | — | — | — |

*(Table intentionally empty: zero deviations found.)*

## Evidence verification notes

Spot-checked against the live implementation (not re-derived from the matrix):

- `backend/src/bring/foodFilter.ts:11–15` — `matchFoodIngredient` returns `null` for unknown/empty labels; `isFoodItem` at line 17. Confirmed conservative (false negatives preferred).
- `backend/src/bring/recently.ts:21` — `previous === null` returns `{ baseline: true, added: [] }`. Confirmed first sync is a baseline, not a backfill.
- `backend/src/pantry/candidatesRepository.ts:75–146` — `syncRecently` runs inside `database.transaction`; both delta and baseline branches update `recentlyWatermarkAt`/`recentlySnapshot` in the same transaction; candidate creation (lines 120–133) precedes the watermark update within the same transaction. Confirmed atomic watermark write.
- `shared/src/contracts.ts:1–15, 17–32` — `SYNC_ENTITY_TYPES` has no candidates entity type; `HOUSE_SYNC_ENTITY_TYPES`/`PERSONAL_SYNC_ENTITY_TYPES` allowlists untouched (`ai_consent` only personal). Confirmed no new `SyncEntityType`.
- `backend/src/db/schema.ts:39–40, 72–89` — watermark columns and house-scoped `pantry_candidates` table with FK to `houses` and unique index on `(house_id, normalized_label)`. Confirmed.

## Check-off (audit completeness gate)

- [x] Compliance matrix taken as the audit basis (task 2 output)
- [x] Every FAIL examined for a defect record → none found (0 FAIL / 0 defects)
- [x] Final audit report compiled with PASS/FAIL counts
- [x] All file/line references listed per decision
- [x] Defect list included (empty)
- [x] Live-code spot checks performed for each decision
- [x] Every ADR-003 requirement checked off

**Audit status: COMPLETE** — ADR-003 is fully compliant; no fix tasks required; no further action needed from Backend-Dev or Frontend-Dev for this audit.
