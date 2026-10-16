import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, lte, ne, inArray, sql } from 'drizzle-orm';
import { normalizeIngredientName } from '@ikuck/shared/ingredients';
import type { PantryLot } from '@ikuck/shared/contracts';
import { AuthServiceError } from '../auth/service.js';
import type { ApplicationDatabase } from '../db/client.js';
import { bringConnections, houseMemberships, houses, pantryCandidates, syncItems, users } from '../db/schema.js';
import { isPantryLot } from './validation.js';
import { matchFoodIngredient } from '../bring/foodFilter.js';
import { diffRecentlySnapshot, type RecentlySnapshotItem } from '../bring/recently.js';
import { BringError } from '../bring/errors.js';

export type PantryCandidateStatus = 'pending' | 'accepted' | 'ignored';
export interface PantryCandidate {
  id: string;
  houseId: string;
  rawLabel: string;
  label: string;
  normalizedLabel: string;
  specification: string;
  listName: string;
  checkedOffAt: string | null;
  detectedAt: string;
  expiresAt: string;
  status: PantryCandidateStatus;
}

export interface PantryCandidateSyncInput {
  userId: string;
  houseId: string;
  connectionId: string;
  snapshot: readonly RecentlySnapshotItem[];
  detectedAt: string;
  ttlDays: number;
}

export type PantryCandidateActionCode = 'accepted' | 'ignored' | 'duplicate_in_pantry' | 'already_resolved' | 'not_found' | 'invalid_candidate';
export interface PantryCandidateActionResult {
  id: string;
  ok: boolean;
  code: PantryCandidateActionCode;
}

export interface PantryCandidateRepository {
  syncRecently: (input: PantryCandidateSyncInput) => Promise<{ baseline: boolean; created: number }>;
  listPending: (userId: string, houseId: string, now: string) => Promise<PantryCandidate[]>;
  resolveMany: (
    userId: string,
    houseId: string,
    ids: readonly string[],
    action: 'accept' | 'ignore',
    now: string,
  ) => Promise<PantryCandidateActionResult[]>;
  cleanupExpiredCandidates: (now: Date) => Promise<number>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const candidateAccessError = () => new AuthServiceError('house_membership_required', 403, 'House membership required');
const expiresAtFor = (detectedAt: string, ttlDays: number): Date => new Date(Date.parse(detectedAt) + ttlDays * 24 * 60 * 60 * 1000);
const toCandidate = (row: typeof pantryCandidates.$inferSelect): PantryCandidate => ({
  id: row.id,
  houseId: row.houseId,
  rawLabel: row.rawLabel,
  label: row.label,
  normalizedLabel: row.normalizedLabel,
  specification: row.specification,
  listName: row.listName,
  checkedOffAt: row.checkedOffAt?.toISOString() ?? null,
  detectedAt: row.detectedAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  status: row.status as PantryCandidateStatus,
});

export const createDrizzlePantryCandidateRepository = (database: ApplicationDatabase['db']): PantryCandidateRepository => ({
  syncRecently: async (input) => database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${input.userId} FOR SHARE`);
    await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${input.houseId} FOR UPDATE`);
    const membership = await transaction.select({ id: houseMemberships.id }).from(houseMemberships).where(and(
      eq(houseMemberships.userId, input.userId),
      eq(houseMemberships.houseId, input.houseId),
    )).limit(1).for('key share');
    if (membership.length === 0) throw candidateAccessError();
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ikuck:pantry:house:' + input.houseId}, 0))`);

    const connectionRows = await transaction.select().from(bringConnections).where(and(
      eq(bringConnections.userId, input.userId),
      eq(bringConnections.connectionId, input.connectionId),
    )).limit(1).for('update');
    const connection = connectionRows[0];
    if (connection === undefined) throw new BringError('bring_stale_connection', 409);

    const previous = connection.recentlySnapshot;
    const delta = diffRecentlySnapshot(previous, input.snapshot);
    const now = new Date(input.detectedAt);
    if (!Number.isFinite(now.getTime())) throw new Error('Candidate detection timestamp is invalid');

    if (!delta.baseline) {
      await transaction.delete(pantryCandidates).where(and(
        eq(pantryCandidates.houseId, input.houseId),
        ne(pantryCandidates.status, 'ignored'),
        lte(pantryCandidates.expiresAt, now),
      ));
      const existingLots = await transaction.select({ payload: syncItems.payload }).from(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, input.houseId),
        eq(syncItems.entityType, 'pantry_lot'),
        eq(syncItems.deleted, false),
      ));
      const pantryLabels = new Set(existingLots.flatMap(({ payload }) => isPantryLot(payload)
        ? [normalizeIngredientName(payload.label)]
        : []));
      const seenLabels = new Set<string>();
      let created = 0;
      for (const item of delta.added) {
        const ingredient = matchFoodIngredient(item.label);
        const normalizedLabel = normalizeIngredientName(item.label);
        if (ingredient === null || normalizedLabel.length === 0 || pantryLabels.has(normalizedLabel) || seenLabels.has(normalizedLabel)) continue;
        seenLabels.add(normalizedLabel);
        const inserted = await transaction.insert(pantryCandidates).values({
          houseId: input.houseId,
          rawLabel: item.name,
          label: item.label,
          normalizedLabel,
          specification: item.specification,
          listName: item.listName,
          checkedOffAt: item.checkedOffAt === null ? null : new Date(item.checkedOffAt),
          detectedAt: now,
          expiresAt: expiresAtFor(input.detectedAt, input.ttlDays),
          status: 'pending',
        }).onConflictDoNothing({ target: [pantryCandidates.houseId, pantryCandidates.normalizedLabel] }).returning({ id: pantryCandidates.id });
        created += inserted.length;
      }
      await transaction.update(bringConnections).set({
        recentlyWatermarkAt: now,
        recentlySnapshot: [...input.snapshot],
      }).where(eq(bringConnections.userId, input.userId));
      return { baseline: false, created };
    }

    await transaction.update(bringConnections).set({
      recentlyWatermarkAt: now,
      recentlySnapshot: [...input.snapshot],
    }).where(eq(bringConnections.userId, input.userId));
    return { baseline: true, created: 0 };
  }),

  listPending: async (userId, houseId, now) => database.transaction(async (transaction) => {
    const membership = await transaction.select({ id: houseMemberships.id }).from(houseMemberships).where(and(
      eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, houseId),
    )).limit(1);
    if (membership.length === 0) throw candidateAccessError();
    const rows = await transaction.select().from(pantryCandidates).where(and(
      eq(pantryCandidates.houseId, houseId),
      eq(pantryCandidates.status, 'pending'),
      gt(pantryCandidates.expiresAt, new Date(now)),
    )).orderBy(desc(pantryCandidates.detectedAt));
    return rows.map(toCandidate);
  }),

  resolveMany: async (userId, houseId, ids, action, now) => {
    const results: PantryCandidateActionResult[] = new Array(ids.length);
    const validEntries: { index: number; id: string }[] = [];
    ids.forEach((id, index) => {
      if (!uuidPattern.test(id)) {
        results[index] = { id, ok: false, code: 'not_found' };
      } else {
        validEntries.push({ index, id });
      }
    });

    if (validEntries.length === 0) return results;

    return database.transaction(async (transaction): Promise<PantryCandidateActionResult[]> => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR SHARE`);
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${houseId} FOR UPDATE`);
      const membership = await transaction.select({ id: houseMemberships.id }).from(houseMemberships).where(and(
        eq(houseMemberships.userId, userId),
        eq(houseMemberships.houseId, houseId),
      )).limit(1).for('key share');
      if (membership.length === 0) throw candidateAccessError();
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ikuck:pantry:house:' + houseId}, 0))`);

      const rows = await transaction.select().from(pantryCandidates).where(and(
        eq(pantryCandidates.houseId, houseId),
        inArray(pantryCandidates.id, validEntries.map(({ id }) => id)),
      )).for('update');
      const byId = new Map(rows.map((row) => [row.id, row]));
      const nowMs = Date.parse(now);

      const existingLotLabels = new Set<string>();
      if (action === 'accept') {
        const lotRows = await transaction.select({ payload: syncItems.payload }).from(syncItems).where(and(
          eq(syncItems.scopeType, 'house'),
          eq(syncItems.scopeId, houseId),
          eq(syncItems.entityType, 'pantry_lot'),
          eq(syncItems.deleted, false),
        ));
        for (const { payload } of lotRows) {
          if (isPantryLot(payload)) existingLotLabels.add(normalizeIngredientName(payload.label));
        }
      }

      const acceptedIds: string[] = [];
      const ignoredIds: string[] = [];
      const lotsToInsert: Array<{ candidate: typeof pantryCandidates.$inferSelect; ingredient: NonNullable<ReturnType<typeof matchFoodIngredient>> }> = [];
      const seenLotLabels = new Set<string>();

      for (const { index, id } of validEntries) {
        const candidate = byId.get(id);
        if (candidate === undefined || (candidate.status === 'pending' && candidate.expiresAt.getTime() <= nowMs)) {
          results[index] = { id, ok: false, code: 'not_found' };
          continue;
        }
        if (candidate.status !== 'pending') {
          results[index] = { id, ok: false, code: 'already_resolved' };
          continue;
        }
        if (action === 'ignore') {
          ignoredIds.push(id);
          results[index] = { id, ok: true, code: 'ignored' };
          continue;
        }

        const ingredient = matchFoodIngredient(candidate.label);
        if (ingredient === null) {
          results[index] = { id, ok: false, code: 'invalid_candidate' };
          continue;
        }

        const normalized = candidate.normalizedLabel;
        const duplicate = existingLotLabels.has(normalized) || seenLotLabels.has(normalized);
        if (!duplicate) {
          seenLotLabels.add(normalized);
          lotsToInsert.push({ candidate, ingredient });
        }
        acceptedIds.push(id);
        results[index] = { id, ok: true, code: duplicate ? 'duplicate_in_pantry' : 'accepted' };
      }

      const timestamp = new Date(now).toISOString();
      if (lotsToInsert.length > 0) {
        await transaction.insert(syncItems).values(
          lotsToInsert.map(({ candidate, ingredient }) => {
            const lot: PantryLot = {
              id: randomUUID(),
              ingredientId: ingredient.id,
              label: candidate.label,
              known: true,
              quantity: null,
              unit: null,
              expiresAt: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            return {
              userId,
              scopeType: 'house',
              scopeId: houseId,
              entityType: 'pantry_lot',
              entityId: lot.id,
              deviceId: 'api-resource',
              payload: lot,
              deleted: false,
              clientUpdatedAt: new Date(now),
              mutationId: randomUUID(),
            };
          }),
        );
      }
      if (acceptedIds.length > 0) {
        await transaction.update(pantryCandidates).set({ status: 'accepted', resolvedAt: new Date(now) }).where(inArray(pantryCandidates.id, acceptedIds));
      }
      if (ignoredIds.length > 0) {
        await transaction.update(pantryCandidates).set({ status: 'ignored', resolvedAt: new Date(now) }).where(inArray(pantryCandidates.id, ignoredIds));
      }

      return results;
    });
  },

  cleanupExpiredCandidates: async (now) => {
    const deleted = await database.delete(pantryCandidates).where(and(
      ne(pantryCandidates.status, 'ignored'),
      lte(pantryCandidates.expiresAt, now),
    )).returning({ id: pantryCandidates.id });
    return deleted.length;
  },
});

export const createMemoryPantryCandidateRepository = (): PantryCandidateRepository & {
  seedPantryLot: (houseId: string, label: string) => void;
  listPantryLots: (houseId: string) => string[];
} => {
  const snapshots = new Map<string, readonly RecentlySnapshotItem[]>();
  const candidates = new Map<string, PantryCandidate>();
  const uniqueCandidates = new Map<string, string>();
  const lots = new Map<string, string[]>();

  return {
    seedPantryLot: (houseId, label) => lots.set(houseId, [...(lots.get(houseId) ?? []), label]),
    listPantryLots: (houseId) => [...(lots.get(houseId) ?? [])],
    syncRecently: async (input) => {
      const key = `${input.userId}:${input.connectionId}`;
      const previous = snapshots.get(key) ?? null;
      const delta = diffRecentlySnapshot(previous, input.snapshot);
      if (previous !== null) {
        const currentTime = Date.parse(input.detectedAt);
        for (const [candidateId, candidate] of candidates) {
          if (candidate.houseId === input.houseId && candidate.status !== 'ignored' && Date.parse(candidate.expiresAt) <= currentTime) {
            candidates.delete(candidateId);
            uniqueCandidates.delete(`${candidate.houseId}:${candidate.normalizedLabel}`);
          }
        }
        const existingLots = new Set((lots.get(input.houseId) ?? []).map(normalizeIngredientName));
        const seenLabels = new Set<string>();
        let created = 0;
        for (const item of delta.added) {
          const normalizedLabel = normalizeIngredientName(item.label);
          if (matchFoodIngredient(item.label) === null || normalizedLabel.length === 0
            || existingLots.has(normalizedLabel) || seenLabels.has(normalizedLabel)) continue;
          seenLabels.add(normalizedLabel);
          const uniqueKey = `${input.houseId}:${normalizedLabel}`;
          if (uniqueCandidates.has(uniqueKey)) continue;
          const candidate: PantryCandidate = {
            id: randomUUID(),
            houseId: input.houseId,
            rawLabel: item.name,
            label: item.label,
            normalizedLabel,
            specification: item.specification,
            listName: item.listName,
            checkedOffAt: item.checkedOffAt,
            detectedAt: input.detectedAt,
            expiresAt: expiresAtFor(input.detectedAt, input.ttlDays).toISOString(),
            status: 'pending',
          };
          candidates.set(candidate.id, candidate);
          uniqueCandidates.set(uniqueKey, candidate.id);
          created += 1;
        }
        snapshots.set(key, structuredClone(input.snapshot));
        return { baseline: false, created };
      }
      snapshots.set(key, structuredClone(input.snapshot));
      return { baseline: true, created: 0 };
    },
    listPending: async (_userId, houseId, now) => [...candidates.values()]
      .filter((candidate) => candidate.houseId === houseId && candidate.status === 'pending' && Date.parse(candidate.expiresAt) > Date.parse(now))
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt))
      .map((candidate) => ({ ...candidate })),
    resolveMany: async (_userId, houseId, ids, action, now) => ids.map((id): PantryCandidateActionResult => {
      const candidate = candidates.get(id);
      if (candidate === undefined || candidate.houseId !== houseId
        || (candidate.status === 'pending' && Date.parse(candidate.expiresAt) <= Date.parse(now))) {
        return { id, ok: false, code: 'not_found' };
      }
      if (candidate.status !== 'pending') return { id, ok: false, code: 'already_resolved' };
      if (action === 'ignore') {
        candidate.status = 'ignored';
        return { id, ok: true, code: 'ignored' };
      }
      const ingredient = matchFoodIngredient(candidate.label);
      if (ingredient === null) return { id, ok: false, code: 'invalid_candidate' };
      const existingLots = lots.get(houseId) ?? [];
      const duplicate = existingLots.some((label) => normalizeIngredientName(label) === candidate.normalizedLabel);
      if (!duplicate) lots.set(houseId, [...existingLots, candidate.label]);
      candidate.status = 'accepted';
      return { id, ok: true, code: duplicate ? 'duplicate_in_pantry' : 'accepted' };
    }),
    cleanupExpiredCandidates: async (now) => {
      let deleted = 0;
      for (const [candidateId, candidate] of candidates) {
        if (candidate.status !== 'ignored' && Date.parse(candidate.expiresAt) <= now.getTime()) {
          candidates.delete(candidateId);
          uniqueCandidates.delete(`${candidate.houseId}:${candidate.normalizedLabel}`);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
};
