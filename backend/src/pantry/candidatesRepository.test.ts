import { describe, expect, it } from 'vitest';
import type { RecentlySnapshotItem } from '../bring/recently.js';
import type { ApplicationDatabase } from '../db/client.js';
import { bringConnections } from '../db/schema.js';
import { createMemoryPantryCandidateRepository, createDrizzlePantryCandidateRepository, type PantryCandidateStatus, type PantryCandidateSyncInput } from './candidatesRepository.js';

const item = (overrides: Partial<RecentlySnapshotItem> = {}): RecentlySnapshotItem => ({
  listId: 'list-1',
  listName: 'Spesa',
  name: 'Milch',
  label: 'Latte',
  specification: '1 l',
  checkedOffAt: '2026-10-15T09:00:00.000Z',
  ...overrides,
});

const request = (snapshot: RecentlySnapshotItem[], overrides: Partial<PantryCandidateSyncInput> = {}): PantryCandidateSyncInput => ({
  userId: 'user-1',
  houseId: 'house-1',
  connectionId: 'connection-1',
  snapshot,
  detectedAt: '2026-10-15T12:00:00.000Z',
  ttlDays: 30,
  ...overrides,
});

describe('pantry candidate repository', () => {
  it('establishes a first-sync baseline without importing historical recently items', async () => {
    const repository = createMemoryPantryCandidateRepository();

    await expect(repository.syncRecently(request([item()]))).resolves.toEqual({ baseline: true, created: 0 });
    await expect(repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z')).resolves.toEqual([]);
  });

  it('creates a food candidate for an offline check-off older than the previous watermark', async () => {
    const repository = createMemoryPantryCandidateRepository();
    const baseline = item({ name: 'Pane', label: 'Pane', checkedOffAt: '2026-10-15T10:30:00.000Z' });
    const offlineCheckoff = item({ checkedOffAt: '2026-10-15T09:00:00.000Z' });
    await repository.syncRecently(request([baseline], { detectedAt: '2026-10-15T11:00:00.000Z' }));

    await expect(repository.syncRecently(request([baseline, offlineCheckoff])))
      .resolves.toEqual({ baseline: false, created: 1 });
    await expect(repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z'))
      .resolves.toMatchObject([{ rawLabel: 'Milch', label: 'Latte', normalizedLabel: 'latte', listName: 'Spesa', checkedOffAt: '2026-10-15T09:00:00.000Z' }]);
  });

  it('makes a repeated sync idempotent and deduplicates the normalized candidate label', async () => {
    const repository = createMemoryPantryCandidateRepository();
    const baseline = item({ name: 'Pane', label: 'Pane' });
    await repository.syncRecently(request([baseline]));
    const current = [baseline, item()];

    await expect(repository.syncRecently(request(current))).resolves.toEqual({ baseline: false, created: 1 });
    await expect(repository.syncRecently(request(current))).resolves.toEqual({ baseline: false, created: 0 });
    await expect(repository.syncRecently(request([...current, item({ name: 'LATTE', label: 'LATTE', checkedOffAt: '2026-10-15T11:00:00.000Z' })])))
      .resolves.toEqual({ baseline: false, created: 0 });
    await expect(repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z')).resolves.toHaveLength(1);
  });

  it('deduplicates against an existing pantry lot by normalized house label', async () => {
    const repository = createMemoryPantryCandidateRepository();
    repository.seedPantryLot('house-1', ' LATTE ');
    const baseline = item({ name: 'Pane', label: 'Pane' });
    await repository.syncRecently(request([baseline]));

    await expect(repository.syncRecently(request([baseline, item()]))).resolves.toEqual({ baseline: false, created: 0 });
  });

  it('accepts a candidate into the house pantry and permanently resolves it', async () => {
    const repository = createMemoryPantryCandidateRepository();
    const baseline = item({ name: 'Pane', label: 'Pane' });
    await repository.syncRecently(request([baseline]));
    await repository.syncRecently(request([baseline, item()]));
    const [candidate] = await repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z');
    if (candidate === undefined) throw new Error('Expected a candidate');

    await expect(repository.resolveMany('user-1', 'house-1', [candidate.id], 'accept', '2026-10-15T12:05:00.000Z'))
      .resolves.toEqual([{ id: candidate.id, ok: true, code: 'accepted' }]);
    expect(repository.listPantryLots('house-1')).toEqual(['Latte']);
    await expect(repository.listPending('user-1', 'house-1', '2026-10-15T12:06:00.000Z')).resolves.toEqual([]);
    await expect(repository.resolveMany('user-1', 'house-1', [candidate.id], 'accept', '2026-10-15T12:06:00.000Z'))
      .resolves.toEqual([{ id: candidate.id, ok: false, code: 'already_resolved' }]);
  });

  it('deduplicates acceptance against a lot added after candidate creation', async () => {
    const repository = createMemoryPantryCandidateRepository();
    const baseline = item({ name: 'Pane', label: 'Pane' });
    await repository.syncRecently(request([baseline]));
    await repository.syncRecently(request([baseline, item()]));
    const [candidate] = await repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z');
    if (candidate === undefined) throw new Error('Expected a candidate');
    repository.seedPantryLot('house-1', ' LATTE ');

    await expect(repository.resolveMany('user-1', 'house-1', [candidate.id], 'accept', '2026-10-15T12:05:00.000Z'))
      .resolves.toEqual([{ id: candidate.id, ok: true, code: 'duplicate_in_pantry' }]);
    expect(repository.listPantryLots('house-1')).toEqual([' LATTE ']);
  });

  it('cleans up expired candidates but preserves ignored records permanently', async () => {
    const repository = createMemoryPantryCandidateRepository();
    const baseline = item({ name: 'Pane', label: 'Pane' });
    await repository.syncRecently(request([baseline]));
    await repository.syncRecently(request([
      baseline,
      item({ checkedOffAt: '2026-10-15T10:00:00.000Z' }),
      item({ name: 'Ceci', label: 'Ceci', checkedOffAt: '2026-10-15T10:01:00.000Z' }),
    ]));
    const candidates = await repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z');
    const ignored = candidates.find((candidate) => candidate.label === 'Latte');
    const expired = candidates.find((candidate) => candidate.label === 'Ceci');
    if (ignored === undefined || expired === undefined) throw new Error('Expected two candidates');
    await repository.resolveMany('user-1', 'house-1', [ignored.id], 'ignore', '2026-10-15T12:05:00.000Z');

    await expect(repository.cleanupExpiredCandidates(new Date('2026-11-15T12:00:00.000Z'))).resolves.toBe(1);
    await expect(repository.resolveMany('user-1', 'house-1', [ignored.id, expired.id], 'accept', '2026-11-15T12:00:00.000Z'))
      .resolves.toEqual([
        { id: ignored.id, ok: false, code: 'already_resolved' },
        { id: expired.id, ok: false, code: 'not_found' },
      ]);
    });

  it('expires pending candidates from a previous snapshot on the next sync', async () => {
    const repository = createMemoryPantryCandidateRepository();
    const firstSync = '2026-10-15T12:00:00.000Z';
    const afterTtl = '2026-11-25T12:00:00.000Z';
    await repository.syncRecently(request([item({ name: 'Pane', label: 'Pane' })], { detectedAt: firstSync }));
    await repository.syncRecently(request([
      item({ name: 'Pane', label: 'Pane'}),
      item({ name: 'Latte', label: 'Latte', checkedOffAt: '2026-10-15T10:00:00.000Z' }),
    ], { detectedAt: firstSync }));
    await repository.syncRecently(request([
      item({ name: 'Pane', label: 'Pane' }),
      item({ name: 'Latte', label: 'Latte', checkedOffAt: '2026-10-15T10:00:00.000Z' }),
    ], { detectedAt: afterTtl }));
    await expect(repository.listPending('user-1', 'house-1', afterTtl)).resolves.toEqual([]);
  });

  it('risolve un batch accettazione misto in un’unica passata con codici per-item ordinati', async () => {
    const repository = createMemoryPantryCandidateRepository();
    await repository.syncRecently(request([item({ name: 'Pane', label: 'Pane' })]));
    await repository.syncRecently(request([
      item({ name: 'Pane', label: 'Pane' }),
      item({ name: 'Latte', label: 'Latte' }),
      item({ name: 'Ceci', label: 'Ceci' }),
    ]));
    const pending = await repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z');
    const latte = pending.find((candidate) => candidate.label === 'Latte');
    const ceci = pending.find((candidate) => candidate.label === 'Ceci');
    if (latte === undefined || ceci === undefined) throw new Error('Expected two candidates');

    repository.seedPantryLot('house-1', 'Latte');

    const results = await repository.resolveMany('user-1', 'house-1', [
      'not-a-uuid',
      '00000000-0000-4000-8000-000000000099',
      ceci.id,
      latte.id,
    ], 'accept', '2026-10-15T12:06:00.000Z');

    expect(results).toEqual([
      { id: 'not-a-uuid', ok: false, code: 'not_found' },
      { id: '00000000-0000-4000-8000-000000000099', ok: false, code: 'not_found' },
      { id: ceci.id, ok: true, code: 'accepted' },
      { id: latte.id, ok: true, code: 'duplicate_in_pantry' },
    ]);
    expect(repository.listPantryLots('house-1')).toEqual(['Latte', 'Ceci']);
  });

  it('risolve un batch ignore misto in un’unica passata e lo permane', async () => {
    const repository = createMemoryPantryCandidateRepository();
    await repository.syncRecently(request([item({ name: 'Pane', label: 'Pane' })]));
    await repository.syncRecently(request([
      item({ name: 'Pane', label: 'Pane' }),
      item({ name: 'Latte', label: 'Latte' }),
      item({ name: 'Ceci', label: 'Ceci' }),
    ]));
    const pending = await repository.listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z');
    const ids = pending.map((candidate) => candidate.id);
    if (ids.length !== 2) throw new Error('Expected two candidates');

    await expect(repository.resolveMany('user-1', 'house-1', [...ids, 'not-a-uuid', '00000000-0000-4000-8000-000000000099'], 'ignore', '2026-10-15T12:06:00.000Z'))
      .resolves.toEqual([
        { id: ids[0], ok: true, code: 'ignored' },
        { id: ids[1], ok: true, code: 'ignored' },
        { id: 'not-a-uuid', ok: false, code: 'not_found' },
        { id: '00000000-0000-4000-8000-000000000099', ok: false, code: 'not_found' },
      ]);
    await expect(repository.listPending('user-1', 'house-1', '2026-10-15T12:07:00.000Z')).resolves.toEqual([]);
    await expect(repository.resolveMany('user-1', 'house-1', ids, 'accept', '2026-10-15T12:08:00.000Z'))
      .resolves.toEqual([
        { id: ids[0], ok: false, code: 'already_resolved' },
        { id: ids[1], ok: false, code: 'already_resolved' },
      ]);
  });
});

describe('pantry candidate repository (Drizzle)', () => {
  class QueryRows implements PromiseLike<unknown[]> {
    constructor(readonly rows: unknown[]) {}
    from() { return this; }
    where() { return this; }
    limit() { return this; }
    for() { return this; }
    orderBy() { return this; }
    values() { return this; }
    onConflictDoNothing() { return this; }
    returning() { return this; }
    set() { return this; }
    then<TResult1 = unknown[], TResult2 = never>(
      onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    ): PromiseLike<TResult1 | TResult2> {
      const fulfill = onFulfilled ?? ((value: unknown[]) => value as unknown as TResult1);
      return Promise.resolve(fulfill(this.rows));
    }
  }

  type InsertCall = { values: unknown };

  function mockDatabase(options: {
    selectQueue: unknown[][];
    insertReturning?: unknown[];
    cleanupReturning?: unknown[];
  }) {
    const insertCalls: InsertCall[] = [];
    const queue = [...options.selectQueue];
    const connectionStore = { row: connectionRow(null) };
    let transactionCalls = 0;
    const insertChain = {
      values: (values: unknown) => { insertCalls.push({ values }); return insertChain; },
      onConflictDoNothing: () => insertChain,
      returning: () => new QueryRows(options.insertReturning ?? []),
    };
    const applyConnectionUpdate = (values: unknown) => {
      if (values !== null && typeof values === 'object' && 'recentlySnapshot' in values) {
        connectionStore.row.recentlySnapshot = [...(values as { recentlySnapshot: readonly RecentlySnapshotItem[] }).recentlySnapshot];
      }
    };
    const tx = {
      execute: async () => undefined,
      select: () => {
        const programmed = queue.shift();
        return new QueryRows(programmed !== undefined ? programmed : [connectionStore.row]);
      },
      insert: () => insertChain,
      update: (table: unknown) => {
        let values: unknown;
        const chain = {
          set: (next: unknown) => { values = next; return chain; },
          where: () => {
            if (table === bringConnections) applyConnectionUpdate(values);
            return new QueryRows([]);
          },
        };
        return chain;
      },
      delete: () => new QueryRows([]),
    };
    const db = {
      transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        return run(tx);
      },
      delete: () => new QueryRows(options.cleanupReturning ?? []),
    };
    return { db, insertCalls, transactionCalls: () => transactionCalls };
  }

  const candidateId = '00000000-0000-4000-8000-000000000001';
const baselineSnapshot = [
    item({ name: 'Pane', label: 'Pane', checkedOffAt: '2026-10-15T09:00:00.000Z' }),
  ];
  interface BringConnectionRow {
    connectionId: string;
    userId: string;
    recentlySnapshot: readonly RecentlySnapshotItem[] | null;
    recentlyWatermarkAt: null;
  }
  const connectionRow = (recentlySnapshot: readonly RecentlySnapshotItem[] | null): BringConnectionRow =>
    ({ connectionId: 'connection-1', userId: 'user-1', recentlySnapshot, recentlyWatermarkAt: null });

  const candidateRow = (overrides: Partial<{
    id: string;
    status: PantryCandidateStatus;
    expiresAt: Date;
    label: string;
    normalizedLabel: string;
  }> = {}) => ({
    id: candidateId,
    houseId: 'house-1',
    rawLabel: 'Latte',
    label: 'Latte',
    normalizedLabel: 'latte',
    specification: '1 l',
    listName: 'Spesa',
    checkedOffAt: new Date('2026-10-15T10:00:00.000Z'),
    detectedAt: new Date('2026-10-15T12:00:00.000Z'),
    expiresAt: new Date('2026-11-15T12:00:00.000Z'),
    status: 'pending' as const,
    resolvedAt: null,
    ...overrides,
  }) as unknown;

  const repositoryOf = (db: unknown) =>
    createDrizzlePantryCandidateRepository(db as unknown as ApplicationDatabase['db']);

  const latteAfterWatermark = item({ name: 'Latte', label: 'Latte', checkedOffAt: '2026-10-15T10:00:00.000Z' });

  it('advances the watermark and returns the baseline without candidates when there is no previous snapshot', async () => {
    const { db, insertCalls } = mockDatabase({
      selectQueue: [[{ id: 'membership-1' }], [connectionRow(null)]],
    });

    await expect(repositoryOf(db).syncRecently(request(baselineSnapshot))).resolves.toEqual({
      baseline: true,
      created: 0,
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('creates one candidate for a food item that moved into recently after the watermark', async () => {
    const { db, insertCalls } = mockDatabase({
      selectQueue: [[{ id: 'membership-1' }], [connectionRow(baselineSnapshot)], []],
      insertReturning: [{ id: candidateId }],
    });

    await expect(repositoryOf(db).syncRecently(request([...baselineSnapshot, latteAfterWatermark]))).resolves.toEqual({
      baseline: false,
      created: 1,
    });
    expect((insertCalls[0]?.values as { normalizedLabel?: string })?.normalizedLabel).toBe('latte');
  });

  it('creates no candidate when the normalized label already exists in the database', async () => {
    const { db, insertCalls } = mockDatabase({
      selectQueue: [[{ id: 'membership-1' }], [connectionRow(baselineSnapshot)], []],
      insertReturning: [],
    });

    await expect(repositoryOf(db).syncRecently(request([...baselineSnapshot, latteAfterWatermark]))).resolves.toEqual({
      baseline: false,
      created: 0,
    });
    expect(insertCalls).toHaveLength(1);
  });

  it('skips non-food labels', async () => {
    const { db, insertCalls } = mockDatabase({
      selectQueue: [[{ id: 'membership-1' }], [connectionRow(baselineSnapshot)], []],
      insertReturning: [{ id: candidateId }],
    });

    await expect(repositoryOf(db).syncRecently(request([...baselineSnapshot, item({ name: 'Dentifricio', label: 'Dentifricio' })]))).resolves.toEqual({
      baseline: false,
      created: 0,
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('skips labels already present in the house pantry lots', async () => {
    const existingLot = {
      id: 'lot-1', ingredientId: 'custom:latte', label: ' LATTE ', known: true, quantity: null,
      unit: null, expiresAt: null, createdAt: '2026-10-15T09:00:00.000Z', updatedAt: '2026-10-15T09:00:00.000Z',
    };
    const { db, insertCalls } = mockDatabase({
      selectQueue: [[{ id: 'membership-1' }], [connectionRow(baselineSnapshot)], [{ payload: existingLot }]],
      insertReturning: [{ id: candidateId }],
    });

    await expect(repositoryOf(db).syncRecently(request([...baselineSnapshot, latteAfterWatermark]))).resolves.toEqual({
      baseline: false,
      created: 0,
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('skips labels with an empty normalized label', async () => {
    const { db, insertCalls } = mockDatabase({
      selectQueue: [[{ id: 'membership-1' }], [connectionRow(baselineSnapshot)], []],
      insertReturning: [{ id: candidateId }],
    });

    await expect(repositoryOf(db).syncRecently(request([...baselineSnapshot, item({ name: '   ', label: '   ' })]))).resolves.toEqual({
      baseline: false,
      created: 0,
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('is idempotent: repeating the same snapshot creates no additional candidates', async () => {
    const { db, insertCalls } = mockDatabase({
      selectQueue: [
        [{ id: 'membership-1' }], [connectionRow(baselineSnapshot)], [],
        [{ id: 'membership-1' }],
      ],
      insertReturning: [{ id: candidateId }],
    });
    const current = [...baselineSnapshot, latteAfterWatermark];

    await expect(repositoryOf(db).syncRecently(request(current))).resolves.toEqual({ baseline: false, created: 1 });
    await expect(repositoryOf(db).syncRecently(request(current))).resolves.toEqual({ baseline: false, created: 0 });
    expect(insertCalls).toHaveLength(1);
  });

  it('requires a house membership', async () => {
    const { db } = mockDatabase({ selectQueue: [[]] });

    await expect(repositoryOf(db).syncRecently(request(baselineSnapshot))).rejects.toMatchObject({
      code: 'house_membership_required',
      status: 403,
    });
  });

  it('requires a known Bring connection', async () => {
    const { db } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], []] });

    await expect(repositoryOf(db).syncRecently(request([...baselineSnapshot, latteAfterWatermark]))).rejects.toMatchObject({
      code: 'bring_stale_connection',
      status: 409,
    });
  });

  it('refuses to advance the watermark with an invalid detection timestamp', async () => {
    const { db } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], [connectionRow(baselineSnapshot)]] });

    await expect(repositoryOf(db).syncRecently(request([...baselineSnapshot, latteAfterWatermark], { detectedAt: 'not-a-timestamp' }))).rejects.toMatchObject({
      message: 'Candidate detection timestamp is invalid',
    });
  });

  describe('listPending (Drizzle)', () => {
    it('returns pending non-expired candidates mapped to the contract shape', async () => {
      const { db } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], [candidateRow()]] });

      await expect(repositoryOf(db).listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z')).resolves.toEqual([
        {
          id: candidateId, houseId: 'house-1', rawLabel: 'Latte', label: 'Latte', normalizedLabel: 'latte',
          specification: '1 l', listName: 'Spesa', checkedOffAt: '2026-10-15T10:00:00.000Z',
          detectedAt: '2026-10-15T12:00:00.000Z', expiresAt: '2026-11-15T12:00:00.000Z', status: 'pending',
        },
      ]);
    });

    it('requires a house membership', async () => {
      const { db } = mockDatabase({ selectQueue: [[]] });

      await expect(repositoryOf(db).listPending('user-1', 'house-1', '2026-10-15T12:00:00.000Z')).rejects.toMatchObject({
        code: 'house_membership_required',
        status: 403,
      });
    });
  });

  describe('resolveMany (Drizzle)', () => {
    it('accepts a candidate and records the pantry lot once', async () => {
      const { db, insertCalls } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], [candidateRow()], []] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [candidateId], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: candidateId, ok: true, code: 'accepted' },
      ]);
      const inserted = insertCalls[0]?.values;
      const lots = Array.isArray(inserted) ? inserted : [inserted];
      expect(lots.some((lot) => (lot as { entityType?: string })?.entityType === 'pantry_lot')).toBe(true);
    });

    it('reports duplicate_in_pantry without creating a second lot', async () => {
      const existingLot = {
        id: 'lot-1', ingredientId: 'custom:latte', label: 'Latte', known: true, quantity: null,
        unit: null, expiresAt: null, createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z',
      };
      const { db, insertCalls } = mockDatabase({
        selectQueue: [[{ id: 'membership-1' }], [candidateRow()], [{ payload: existingLot }]],
      });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [candidateId], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: candidateId, ok: true, code: 'duplicate_in_pantry' },
      ]);
      expect(insertCalls.some((call) => (call.values as { entityType?: string })?.entityType === 'pantry_lot')).toBe(false);
    });

    it('ignores a candidate permanently without creating a lot', async () => {
      const { db, insertCalls } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], [candidateRow()]] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [candidateId], 'ignore', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: candidateId, ok: true, code: 'ignored' },
      ]);
      expect(insertCalls).toHaveLength(0);
    });

    it('returns not_found for an invalid candidate id', async () => {
      const { db } = mockDatabase({ selectQueue: [] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', ['not-a-uuid'], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: 'not-a-uuid', ok: false, code: 'not_found' },
      ]);
    });

    it('returns not_found when the candidate does not exist', async () => {
      const { db } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], []] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [candidateId], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: candidateId, ok: false, code: 'not_found' },
      ]);
    });

    it('returns already_resolved for an accepted candidate', async () => {
      const { db } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], [candidateRow({ status: 'accepted' })]] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [candidateId], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: candidateId, ok: false, code: 'already_resolved' },
      ]);
    });

    it('returns not_found for an expired pending candidate', async () => {
      const { db } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], [candidateRow({ expiresAt: new Date('2026-10-15T10:00:00.000Z') })]] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [candidateId], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: candidateId, ok: false, code: 'not_found' },
      ]);
    });

    it('returns invalid_candidate when the label is not food', async () => {
      const { db } = mockDatabase({ selectQueue: [[{ id: 'membership-1' }], [candidateRow({ label: 'Dentifricio', normalizedLabel: 'dentifricio' })]] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [candidateId], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: candidateId, ok: false, code: 'invalid_candidate' },
      ]);
    });

    it('resolveMany collassa l’intero batch accettazione in una sola transazione (no N+1) con codici per-item ordinati', async () => {
      const invalidId = 'not-a-uuid';
      const missingId = '00000000-0000-4000-8000-000000000099';
      const resolvedRow = candidateRow({ id: '00000000-0000-4000-8000-000000000003', status: 'accepted' }) as unknown as { id: string };
      const expiredRow = candidateRow({ id: '00000000-0000-4000-8000-000000000004', expiresAt: new Date('2026-10-15T10:00:00.000Z') }) as unknown as { id: string };
      const duplicateRow = candidateRow({ id: '00000000-0000-4000-8000-000000000002', label: 'Latte', normalizedLabel: 'latte' }) as unknown as { id: string };
      const validRow = candidateRow({ id: '00000000-0000-4000-8000-000000000005', label: 'Ceci', normalizedLabel: 'ceci' }) as unknown as { id: string };

      const existingLot = {
        id: 'lot-1', ingredientId: 'custom:latte', label: 'Latte', known: true, quantity: null,
        unit: null, expiresAt: null, createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z',
      };

      const { db, insertCalls, transactionCalls } = mockDatabase({
        selectQueue: [
          [{ id: 'membership-1' }],
          [resolvedRow, expiredRow, duplicateRow, validRow],
          [{ payload: existingLot }],
        ],
        insertReturning: [{ id: 'lot-new' }],
      });

      const ids = [invalidId, missingId, resolvedRow.id, expiredRow.id, duplicateRow.id, validRow.id];

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', ids, 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: invalidId, ok: false, code: 'not_found' },
        { id: missingId, ok: false, code: 'not_found' },
        { id: resolvedRow.id, ok: false, code: 'already_resolved' },
        { id: expiredRow.id, ok: false, code: 'not_found' },
        { id: duplicateRow.id, ok: true, code: 'duplicate_in_pantry' },
        { id: validRow.id, ok: true, code: 'accepted' },
      ]);
      expect(transactionCalls()).toBe(1);
      expect(insertCalls).toHaveLength(1);
      const inserted = insertCalls[0]?.values;
      const lots = Array.isArray(inserted) ? inserted : [inserted];
      expect(lots).toHaveLength(1);
      expect((lots[0] as { entityType?: string })?.entityType).toBe('pantry_lot');
    });

    it('resolveMany collassa l’intero batch ignore in una sola transazione senza creare lotti', async () => {
      const leftRow = candidateRow({ id: '00000000-0000-4000-8000-000000000006' }) as unknown as { id: string };
      const rightRow = candidateRow({ id: '00000000-0000-4000-8000-000000000007' }) as unknown as { id: string };

      const { db, insertCalls, transactionCalls } = mockDatabase({
        selectQueue: [[{ id: 'membership-1' }], [leftRow, rightRow]],
      });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', [leftRow.id, rightRow.id], 'ignore', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: leftRow.id, ok: true, code: 'ignored' },
        { id: rightRow.id, ok: true, code: 'ignored' },
      ]);
      expect(transactionCalls()).toBe(1);
      expect(insertCalls).toHaveLength(0);
    });

    it('resolveMany non tocca il database quando ogni id è un uuid non valido', async () => {
      const { db, transactionCalls } = mockDatabase({ selectQueue: [] });

      await expect(repositoryOf(db).resolveMany('user-1', 'house-1', ['not-a-uuid', 'anche-non-valido'], 'accept', '2026-10-15T12:05:00.000Z')).resolves.toEqual([
        { id: 'not-a-uuid', ok: false, code: 'not_found' },
        { id: 'anche-non-valido', ok: false, code: 'not_found' },
      ]);
      expect(transactionCalls()).toBe(0);
    });
  });

  describe('cleanupExpiredCandidates (Drizzle)', () => {
    it('returns the number of deleted expired candidates', async () => {
      const { db } = mockDatabase({ selectQueue: [], cleanupReturning: [{ id: 'a' }, { id: 'b' }] });

      await expect(repositoryOf(db).cleanupExpiredCandidates(new Date('2026-11-15T12:00:00.000Z'))).resolves.toBe(2);
    });
  });
});
