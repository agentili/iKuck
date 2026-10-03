import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import { createDrizzleAuthRepository } from '../auth/repository.js';
import { createCache } from '../cache/client.js';
import { createDatabase } from '../db/client.js';
import { houseMemberships, houses, processedSyncMutations, syncItems, users } from '../db/schema.js';
import * as schema from '../db/schema.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';
import { createDrizzleProfileRepository } from '../profile/repository.js';
import { createDrizzleSyncRepository, DEFAULT_AI_CONSENT_REVISION } from '../sync/repository.js';
import type { PantryLot, SyncMutation } from '@ikuck/shared/contracts';
import { hashOpaqueToken, createOpaqueToken } from '../auth/tokens.js';
import { createRedisGenerationRateLimiter, type GenerationRateLimiter } from '../ai/rateLimit.js';
import type { RecipeGenerationProvider } from '../providers/types.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
const runIntegration = databaseUrl !== undefined && redisUrl !== undefined ? describe : describe.skip;
const appOrigin = 'http://127.0.0.1:4173';
const waitWithin = <T>(promise: Promise<T>, label: string, timeoutMs = 1_500): Promise<T> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`${label} did not resolve within ${timeoutMs}ms`)), timeoutMs);
  void promise.then((value) => {
    clearTimeout(timeout);
    resolve(value);
  }, (error: unknown) => {
    clearTimeout(timeout);
    reject(error);
  });
});

runIntegration('PostgreSQL and Redis auth/sync integration', () => {
  const database = databaseUrl === undefined ? null : createDatabase(databaseUrl);
  const cache = redisUrl === undefined ? null : createCache(redisUrl);
  let app: ReturnType<typeof createApp>;
  const sentEmails: Array<{ to: string; subject: string; html: string }> = [];
  let tokenNumber = 0;
  const tokenRun = Date.now();

  beforeAll(async () => {
    if (database === null || cache === null) throw new Error('Integration services are not configured');
    await migrate(database.db, {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'),
    });
    await migrate(database.db, {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'),
    });
    await database.ping();
    await cache.ping();

    const auth = createAuthService({
      repository: createDrizzleAuthRepository(database.db),
      email: {
        send: async (message) => {
          sentEmails.push(message);
          return { messageId: `integration-message-${sentEmails.length}` };
        },
      },
      appOrigin,
      tokenFactory: () => {
        const raw = `integration-token-${tokenRun}-${tokenNumber += 1}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
        return { raw, hash: hashOpaqueToken(raw) };
      },
    });
    const houseRepository = createDrizzleHouseRepository(database.db);
    const sync = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const profile = createDrizzleProfileRepository(database.db, sync);
    const recipeProvider: RecipeGenerationProvider = {
      generate: async () => ({
        title: 'Ricetta AI di integrazione',
        description: 'Ricetta generata dal provider finto.',
        ingredients: [{ name: 'Ceci', amount: '240 g' }],
        steps: ['Scola i ceci.'],
        diets: ['vegan'],
        allergens: [],
      }),
    };
    app = createApp({
      database,
      cache,
      auth: { service: auth, appOrigin, secureCookies: false },
      profile: { repository: profile, authService: auth, appOrigin, secureCookies: false },
      sync: { repository: sync, authService: auth, appOrigin },
      dinnerDiary: { repository: sync, authService: auth, appOrigin },
      pantryLots: { repository: sync, authService: auth, appOrigin },
      shoppingList: { repository: sync, authService: auth, appOrigin },
      activity: { repository: sync, authService: auth, appOrigin },
      recipePreferences: { repository: sync, authService: auth, appOrigin },
      dietProfile: { repository: sync, authService: auth, appOrigin },
      aiRecipes: {
        provider: recipeProvider,
        dinnerReconstructionProvider: { reconstruct: async () => [] },
        limiter: createRedisGenerationRateLimiter(cache),
        repository: sync,
        authService: auth,
        appOrigin,
        recipeProvider: 'openai',
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cache?.close();
    await database?.close();
  });

  it('shares migrated diary history and permits cross-member edits in PostgreSQL', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const adminId = randomUUID();
    const outsiderId = randomUUID();
    const houseId = randomUUID();
    const now = new Date();
    await database.db.insert(users).values([ownerId, memberId, adminId, outsiderId].map((id) => ({
      id,
      email: `diary-${id}@example.com`,
      emailVerifiedAt: now,
    })));
    await database.db.insert(houses).values({ id: houseId, name: 'Diary integration house', createdByUserId: adminId });
    const privateEntryId = `pre-house-entry-${ownerId}`;
    const timestamp = new Date().toISOString();
    const entry = {
      id: 'shared-entry', date: timestamp.slice(0, 10), text: 'Pasta con zucchine', servings: 2, note: null, recipes: [],
      authorId: 'forged-author', createdAt: timestamp, updatedAt: timestamp,
    };
    await createDrizzleSyncRepository(database.db).applyMutation(ownerId, {
      mutationId: randomUUID(), deviceId: `diary-device-${ownerId}`, entityType: 'dinner_entry',
      entityId: privateEntryId, operation: 'upsert',
      payload: { ...entry, id: privateEntryId, text: 'Diario prima della casa', authorId: null },
      clientUpdatedAt: timestamp, syncScope: `account:${ownerId}`,
    });
    await database.db.insert(houseMemberships).values([
      { houseId, userId: ownerId, role: 'member' },
      { houseId, userId: memberId, role: 'member' },
      { houseId, userId: adminId, role: 'admin' },
    ]);

    const houseRepository = createDrizzleHouseRepository(database.db);
    const repository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    let clockStep = 0;
    const mutation = (
      userId: string,
      entityType: 'dinner_entry' | 'saved_recipe',
      entityId: string,
      payload: unknown | null,
      operation: 'upsert' | 'delete' = 'upsert',
      syncScope: NonNullable<SyncMutation['syncScope']> = `house:${houseId}`,
    ): SyncMutation => ({
      mutationId: randomUUID(),
      deviceId: `diary-device-${userId}`,
      entityType,
      entityId,
      operation,
      payload,
      clientUpdatedAt: new Date(Date.now() + clockStep++).toISOString(),
      syncScope,
    });
    const createEntry = mutation(ownerId, 'dinner_entry', entry.id, entry);
    const created = await repository.applyMutation(ownerId, createEntry);
    expect(created.change?.payload).toMatchObject({ id: entry.id, authorId: ownerId });
    await expect(repository.readEntity(memberId, 'dinner_entry', entry.id)).resolves.toMatchObject({ payload: { text: entry.text, authorId: ownerId } });
    await expect(repository.readEntity(outsiderId, 'dinner_entry', entry.id)).resolves.toBeNull();
    const memberUpdate = await repository.applyMutation(memberId, mutation(memberId, 'dinner_entry', entry.id, { ...entry, text: 'Cena condivisa', authorId: memberId }));
    expect(memberUpdate.change?.payload).toMatchObject({ text: 'Cena condivisa', authorId: ownerId });

    const ownUpdate = await repository.applyMutation(ownerId, mutation(ownerId, 'dinner_entry', entry.id, { ...entry, text: 'Cena aggiornata', authorId: 'forged-again' }));
    expect(ownUpdate.change?.payload).toMatchObject({ text: 'Cena aggiornata', authorId: ownerId });

    const staleRecipeLinkA = { recipeId: 'stale-recipe-link-a', title: 'Link A', source: 'diary' as const };
    const staleRecipeLinkB = { recipeId: 'stale-recipe-link-b', title: 'Link B', source: 'diary' as const };
    await repository.applyMutation(ownerId, mutation(ownerId, 'dinner_entry', entry.id, { ...entry, recipes: [staleRecipeLinkA] }));
    await repository.applyMutation(ownerId, mutation(ownerId, 'dinner_entry', entry.id, { ...entry, recipes: [staleRecipeLinkB] }));
    await expect(repository.readEntity(ownerId, 'dinner_entry', entry.id)).resolves.toMatchObject({
      payload: { recipes: expect.arrayContaining([staleRecipeLinkA, staleRecipeLinkB]) },
    });

    const recipe = {
      id: 'shared-recipe', title: 'Zucchine e pasta', description: '',
      ingredients: [{ name: 'Pasta', amount: '160 g', ingredientId: 'pasta', optional: false, provenance: 'provided' }],
      steps: ['Cuoci la pasta.'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [],
      source: 'diary', authorId: 'spoofed', createdAt: timestamp, updatedAt: timestamp,
    };
    await repository.applyMutation(ownerId, mutation(ownerId, 'saved_recipe', recipe.id, recipe));
    const adminUpdate = await repository.applyMutation(adminId, mutation(adminId, 'saved_recipe', recipe.id, { ...recipe, title: 'Ricetta aggiornata', authorId: adminId }));
    expect(adminUpdate.change?.payload).toMatchObject({ title: 'Ricetta aggiornata', authorId: ownerId });
    await expect(repository.readEntity(memberId, 'saved_recipe', recipe.id)).resolves.toMatchObject({ payload: { title: 'Ricetta aggiornata' } });

    await repository.migrateUserSharedDataToHouse(ownerId, houseId);
    await expect(repository.readEntity(ownerId, 'dinner_entry', privateEntryId)).resolves.toMatchObject({
      syncScope: `house:${houseId}`, payload: { text: 'Diario prima della casa', authorId: ownerId },
    });
    await expect(repository.readEntity(memberId, 'dinner_entry', privateEntryId)).resolves.toMatchObject({
      syncScope: `house:${houseId}`, payload: { text: 'Diario prima della casa', authorId: ownerId },
    });
    const personalRows = await database.db.select().from(syncItems).where(and(
      eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, ownerId), eq(syncItems.entityType, 'dinner_entry'),
      eq(syncItems.entityId, privateEntryId),
    ));
    expect(personalRows).toHaveLength(0);

    const memberDelete = await repository.applyMutation(memberId, mutation(memberId, 'dinner_entry', entry.id, null, 'delete'));
    expect(memberDelete.change).toMatchObject({ operation: 'delete', payload: null });
    await expect(repository.readEntity(ownerId, 'dinner_entry', entry.id)).resolves.toMatchObject({
      deleted: true, syncScope: `house:${houseId}`,
    });
  });

  it('serializes stale personal dinner writes before merging concurrent recipe links in PostgreSQL', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const ownerId = randomUUID();
    await database.db.insert(users).values({
      id: ownerId, email: `concurrent-diary-${ownerId}@example.com`, emailVerifiedAt: new Date(),
    });
    const repository = createDrizzleSyncRepository(database.db);
    const entryId = `concurrent-dinner-${randomUUID()}`;
    const createdAt = new Date(Date.now() - 2_000).toISOString();
    const entry = {
      id: entryId, date: createdAt.slice(0, 10), text: 'Cena concorrente', servings: null,
      note: null, recipes: [], authorId: ownerId, createdAt, updatedAt: createdAt,
    };
    await repository.applyMutation(ownerId, {
      mutationId: randomUUID(), deviceId: 'integration-concurrent-diary', entityType: 'dinner_entry',
      entityId: entryId, operation: 'upsert', payload: entry, clientUpdatedAt: createdAt,
      syncScope: `account:${ownerId}`,
    });

    let releaseRowLock!: () => void;
    const rowLockReleased = new Promise<void>((resolve) => { releaseRowLock = resolve; });
    let signalRowLocked!: () => void;
    const rowLocked = new Promise<void>((resolve) => { signalRowLocked = resolve; });
    const lockTransaction = database.db.transaction(async (transaction) => {
      const rows = await transaction.execute(sql`SELECT id FROM ${syncItems} WHERE ${syncItems.scopeType} = 'user'
        AND ${syncItems.scopeId} = ${ownerId} AND ${syncItems.entityType} = 'dinner_entry'
        AND ${syncItems.entityId} = ${entryId} FOR UPDATE`);
      expect(rows.length).toBe(1);
      signalRowLocked();
      await rowLockReleased;
    });
    await rowLocked;

    const linkA = { recipeId: 'concurrent-link-a', title: 'Link A', source: 'diary' as const };
    const linkB = { recipeId: 'concurrent-link-b', title: 'Link B', source: 'diary' as const };
    const writeA = repository.applyMutation(ownerId, {
      mutationId: randomUUID(), deviceId: 'integration-concurrent-a', entityType: 'dinner_entry',
      entityId: entryId, operation: 'upsert', payload: { ...entry, recipes: [linkA], updatedAt: new Date().toISOString() },
      clientUpdatedAt: new Date(Date.now() + 1_000).toISOString(), syncScope: `account:${ownerId}`,
    });
    const writeB = repository.applyMutation(ownerId, {
      mutationId: randomUUID(), deviceId: 'integration-concurrent-b', entityType: 'dinner_entry',
      entityId: entryId, operation: 'upsert', payload: { ...entry, recipes: [linkB], updatedAt: new Date().toISOString() },
      clientUpdatedAt: new Date(Date.now() + 1_001).toISOString(), syncScope: `account:${ownerId}`,
    });
    try {
      let blockedWriters = 0;
      for (let attempt = 0; attempt < 100 && blockedWriters < 2; attempt += 1) {
        const waiting = await database.db.execute(sql`SELECT pid FROM pg_stat_activity
          WHERE state = 'active' AND wait_event_type = 'Lock'
          AND query LIKE '%sync_items%' AND query LIKE '%FOR UPDATE%'`);
        blockedWriters = waiting.length;
        if (blockedWriters < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedWriters).toBe(2);
      releaseRowLock();
      const outcomes = await Promise.all([writeA, writeB]);
      expect(outcomes.every((result) => result.applied)).toBe(true);
      const stored = await repository.readEntity(ownerId, 'dinner_entry', entryId);
      expect(stored?.payload).toMatchObject({ recipes: expect.arrayContaining([linkA, linkB]) });
    } finally {
      releaseRowLock();
      await lockTransaction;
    }
  });

  it('compares AI consent revisions atomically across separate PostgreSQL repository instances', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const userId = randomUUID();
    await database.db.insert(users).values({
      id: userId,
      email: `consent-lock-${userId}@example.com`,
      emailVerifiedAt: new Date(),
    });
    const firstRepository = createDrizzleSyncRepository(database.db);
    const secondRepository = createDrizzleSyncRepository(database.db);
    const expectedRevision = '1970-01-01T00:00:00.000Z';
    const outcomes = await Promise.allSettled([
      firstRepository.updateAiConsent(userId, { enabled: true, homeProvider: 'openai', expectedRevision }),
      secondRepository.updateAiConsent(userId, { enabled: true, homeProvider: 'openai', expectedRevision }),
    ]);

    expect(outcomes.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toMatchObject({ code: 'ai_consent_revision_conflict' });
    }
    const winner = outcomes.find((outcome) => outcome.status === 'fulfilled');
    expect(winner?.status).toBe('fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('A consent CAS winner is required');

    const stored = await secondRepository.readEntity(userId, 'ai_consent', 'profile');
    expect(stored?.payload).toMatchObject({ enabled: true });
    expect(stored?.payload).not.toHaveProperty('dinnerProvider');
    expect((stored?.payload as { updatedAt: string }).updatedAt).not.toBe(expectedRevision);
    await expect(secondRepository.updateAiConsent(userId, {
      dinnerProvider: 'openai', expectedRevision,
    })).rejects.toMatchObject({ code: 'ai_consent_revision_conflict' });
  });

  it('serializes two consent writers on a max-two pool without reserving a second connection per writer', async () => {
    if (database === null || databaseUrl === undefined) throw new Error('Integration database is not configured');
    const userId = randomUUID();
    await database.db.insert(users).values({
      id: userId, email: `consent-pool-two-${userId}@example.com`, emailVerifiedAt: new Date(),
    });

    const client = postgres(databaseUrl, { max: 2, idle_timeout: 1 });
    const poolDb = drizzle(client, { schema });
    let signalFirstTransaction!: () => void;
    let releaseFirstTransaction!: () => void;
    const firstTransactionReached = new Promise<void>((resolve) => { signalFirstTransaction = resolve; });
    const firstTransactionGate = new Promise<void>((resolve) => { releaseFirstTransaction = resolve; });
    let transactionCalls = 0;
    const actualTransaction = poolDb.transaction.bind(poolDb);
    const gatedDb = new Proxy(poolDb, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          transactionCalls += 1;
          if (transactionCalls === 1) {
            signalFirstTransaction();
            await firstTransactionGate;
          }
          return Reflect.apply(actualTransaction, target, args);
        };
      },
    }) as typeof poolDb;
    const repository = createDrizzleSyncRepository(gatedDb);
    const update = () => repository.updateAiConsent(userId, {
      enabled: true,
      homeProvider: 'openai',
      expectedRevision: '1970-01-01T00:00:00.000Z',
    });
    const firstWriter = update();
    await firstTransactionReached;
    const secondWriter = update();
    let blockedPid: number | null = null;

    try {
      for (let attempt = 0; attempt < 50 && blockedPid === null; attempt += 1) {
        const waiting = await database.db.execute(sql`SELECT pid FROM pg_stat_activity
          WHERE state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_%'`);
        blockedPid = (waiting[0] as { pid: number } | undefined)?.pid ?? null;
        if (blockedPid === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedPid).toBeNull();
      releaseFirstTransaction();
      const outcomes = await Promise.allSettled([firstWriter, secondWriter]);
      expect(outcomes.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
      const conflict = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(conflict).toMatchObject({ status: 'rejected', reason: { code: 'ai_consent_revision_conflict' } });
      await expect(poolDb.execute(sql`SELECT 1 AS pool_available`)).resolves.toBeDefined();
    } finally {
      releaseFirstTransaction();
      if (blockedPid !== null) await database.db.execute(sql`SELECT pg_cancel_backend(${blockedPid})`);
      await Promise.allSettled([firstWriter, secondWriter]);
      await client.end({ timeout: 5 });
    }
  }, 10_000);

  it('runs one AI dispatch at a time on a max-two pool in FIFO order while ordinary queries continue', async () => {
    if (database === null || databaseUrl === undefined) throw new Error('Integration database is not configured');
    const userId = randomUUID();
    await database.db.insert(users).values({
      id: userId, email: `dispatch-pool-two-${userId}@example.com`, emailVerifiedAt: new Date(),
    });
    const client = postgres(databaseUrl, { max: 2, idle_timeout: 1 });
    const poolDb = drizzle(client, { schema });
    const repository = createDrizzleSyncRepository(poolDb);
    const enabled = await repository.updateAiConsent(userId, {
      enabled: true,
      homeProvider: 'openai',
      expectedRevision: DEFAULT_AI_CONSENT_REVISION,
    });
    const ids = ['first', 'second', 'third'];
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const startSignals = new Map<string, () => void>();
    const startWaiters = new Map(ids.map((id) => [id, new Promise<void>((resolve) => { startSignals.set(id, resolve); })]));
    const releaseSignals = new Map<string, () => void>();
    const releaseWaiters = new Map(ids.map((id) => [id, new Promise<void>((resolve) => { releaseSignals.set(id, resolve); })]));
    const requests = ids.map((id) => repository.withAiConsentDispatch(userId, { kind: 'home', provider: 'openai' }, async () => {
      started.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      startSignals.get(id)?.();
      await releaseWaiters.get(id);
      active -= 1;
      return id;
    }));

    try {
      await waitWithin(startWaiters.get('first')!, 'first dispatch');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started).toEqual(['first']);
      await expect(waitWithin(poolDb.execute(sql`SELECT 1 AS available_during_dispatch`), 'ordinary pool query', 250)).resolves.toBeDefined();

      releaseSignals.get('first')?.();
      await waitWithin(startWaiters.get('second')!, 'second dispatch');
      expect(started).toEqual(['first', 'second']);
      releaseSignals.get('second')?.();
      await waitWithin(startWaiters.get('third')!, 'third dispatch');
      expect(started).toEqual(['first', 'second', 'third']);
      releaseSignals.get('third')?.();

      await expect(Promise.all(requests)).resolves.toEqual(ids);
      expect(maximumActive).toBe(1);
      expect(enabled.enabled).toBe(true);
    } finally {
      for (const release of releaseSignals.values()) release();
      await Promise.allSettled(requests);
      await client.end({ timeout: 5 });
    }
  }, 10_000);

  it('caps a max-ten pool at two dispatches while preserving FIFO and ordinary queries', async () => {
    if (database === null || databaseUrl === undefined) throw new Error('Integration database is not configured');
    const userIds = Array.from({ length: 10 }, () => randomUUID());
    await database.db.insert(users).values(userIds.map((id) => ({
      id,
      email: `dispatch-pool-ten-${id}@example.com`,
      emailVerifiedAt: new Date(),
    })));
    const client = postgres(databaseUrl, { max: 10, idle_timeout: 1 });
    const poolDb = drizzle(client, { schema });
    const repository = createDrizzleSyncRepository(poolDb);
    for (const userId of userIds) {
      await repository.updateAiConsent(userId, {
        enabled: true, homeProvider: 'openai', expectedRevision: DEFAULT_AI_CONSENT_REVISION,
      });
    }
    const ids = Array.from({ length: 10 }, (_, index) => `dispatch-${index}`);
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const startSignals = new Map<string, () => void>();
    const startWaiters = new Map(ids.map((id) => [id, new Promise<void>((resolve) => { startSignals.set(id, resolve); })]));
    const releaseSignals = new Map<string, () => void>();
    const releaseWaiters = new Map(ids.map((id) => [id, new Promise<void>((resolve) => { releaseSignals.set(id, resolve); })]));
    const requests = ids.map((id, index) => repository.withAiConsentDispatch(userIds[index]!, { kind: 'home', provider: 'openai' }, async () => {
      started.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      startSignals.get(id)?.();
      await releaseWaiters.get(id);
      active -= 1;
      return id;
    }));

    try {
      await waitWithin(Promise.all([startWaiters.get(ids[0])!, startWaiters.get(ids[1])!]), 'first two dispatches');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started).toEqual(ids.slice(0, 2));
      await expect(waitWithin(poolDb.execute(sql`SELECT 1 AS available_during_dispatch`), 'ordinary max-ten pool query', 250)).resolves.toBeDefined();

      releaseSignals.get(ids[0]!)?.();
      await waitWithin(startWaiters.get(ids[2])!, 'third FIFO dispatch');
      expect(started).toEqual(ids.slice(0, 3));
      for (const release of releaseSignals.values()) release();
      await expect(Promise.all(requests)).resolves.toEqual(ids);
      expect(maximumActive).toBe(2);
    } finally {
      for (const release of releaseSignals.values()) release();
      await Promise.allSettled(requests);
      await client.end({ timeout: 5 });
    }
  }, 10_000);

  it('serializes an in-flight AI dispatch with consent revocation across PostgreSQL repositories', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const userId = randomUUID();
    await database.db.insert(users).values({
      id: userId,
      email: `consent-dispatch-${userId}@example.com`,
      emailVerifiedAt: new Date(),
    });
    const firstRepository = createDrizzleSyncRepository(database.db);
    const secondRepository = createDrizzleSyncRepository(database.db);
    await firstRepository.updateAiConsent(userId, {
      enabled: true,
      homeProvider: 'openai',
      expectedRevision: '1970-01-01T00:00:00.000Z',
    });

    let markDispatchStarted!: () => void;
    let resumeDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { markDispatchStarted = resolve; });
    const dispatchGate = new Promise<void>((resolve) => { resumeDispatch = resolve; });
    const inFlightDispatch = firstRepository.withAiConsentDispatch(userId, { kind: 'home', provider: 'openai' }, async () => {
      markDispatchStarted();
      await dispatchGate;
      return 'provider completed';
    });
    await dispatchStarted;

    let revokeAcknowledged = false;
    const revoke = secondRepository.updateAiConsent(userId, { enabled: false }).then((consent) => {
      revokeAcknowledged = true;
      return consent;
    });
    let consentLockWaiters = 0;
    for (let attempt = 0; attempt < 100 && consentLockWaiters === 0; attempt += 1) {
      const waiting = await database.db.execute(sql`SELECT pid FROM pg_stat_activity
        WHERE state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_%'`);
      consentLockWaiters = waiting.length;
      if (consentLockWaiters === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(consentLockWaiters).toBeGreaterThan(0);
    expect(revokeAcknowledged).toBe(false);

    resumeDispatch();
    await expect(inFlightDispatch).resolves.toBe('provider completed');
    await expect(revoke).resolves.toMatchObject({ enabled: false });
    await expect(secondRepository.withAiConsentDispatch(userId, { kind: 'home', provider: 'openai' }, async () => 'must not dispatch'))
      .rejects.toMatchObject({ code: 'ai_consent_required' });
  });

  it('orders provider dispatch, API revocation, and generic sync across two independent PostgreSQL pools', async () => {
    if (database === null || databaseUrl === undefined || cache === null) throw new Error('Integration services are not configured');
    const integrationDatabase = database;
    const integrationDatabaseUrl = databaseUrl;
    const integrationCache = cache;
    const firstDatabase = createDatabase(integrationDatabaseUrl);
    const secondDatabase = createDatabase(integrationDatabaseUrl);
    const firstRepository = createDrizzleSyncRepository(firstDatabase.db);
    const secondRepository = createDrizzleSyncRepository(secondDatabase.db);
    const authRepository = createDrizzleAuthRepository(secondDatabase.db);
    const user = await authRepository.createUser({
      email: `cross-pool-consent-${randomUUID()}@example.com`, passwordHash: null, emailVerifiedAt: new Date(),
    });
    const sessionToken = createOpaqueToken();
    const csrfToken = `cross-pool-csrf-${randomUUID()}`;
    await authRepository.createSession({
      userId: user.id, tokenHash: sessionToken.hash, csrfTokenHash: hashOpaqueToken(csrfToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const authService = createAuthService({
      repository: authRepository,
      email: { send: async () => ({ messageId: 'cross-pool-test' }) },
      appOrigin,
      tokenFactory: () => ({ raw: `cross-pool-${randomUUID()}`, hash: randomUUID() }),
    });
    const headers = {
      cookie: `ikuck_session=${sessionToken.raw}`,
      origin: appOrigin,
      'x-csrf-token': csrfToken,
    };
    await firstRepository.updateAiConsent(user.id, {
      enabled: true,
      homeProvider: 'openai',
      expectedRevision: DEFAULT_AI_CONSENT_REVISION,
    });

    let signalProvider!: () => void;
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => { signalProvider = resolve; });
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerCalls = 0;
    const provider: RecipeGenerationProvider = {
      generate: async () => {
        providerCalls += 1;
        signalProvider();
        await providerGate;
        return {
          title: 'Bozza cross-pool', description: 'Prova sintetica.', ingredients: [{ name: 'Ceci', amount: '200 g' }],
          steps: ['Cuoci i ceci.'], diets: ['vegan'], allergens: [],
        };
      },
    };
    const limiter: GenerationRateLimiter = {
      consume: async () => ({ allowed: true, used: 1, remaining: 9999 }),
      reserve: async () => ({
        quota: { allowed: true, used: 1, remaining: 9999 },
        commit: async () => undefined,
        release: async () => undefined,
      }),
    };
    const dependencies = (databaseForApp: ReturnType<typeof createDatabase>, repository: ReturnType<typeof createDrizzleSyncRepository>, selectedProvider: RecipeGenerationProvider) => ({
      database: databaseForApp,
      cache: integrationCache,
      aiRecipes: {
        provider: selectedProvider,
        dinnerReconstructionProvider: { reconstruct: async () => [] },
        limiter,
        repository,
        authService,
        appOrigin,
        recipeProvider: 'openai' as const,
      },
    });
    const dispatchApp = createApp(dependencies(firstDatabase, firstRepository, provider));
    const revokeApp = createApp({
      ...dependencies(secondDatabase, secondRepository, { generate: async () => ({
        title: 'unused', description: 'unused', ingredients: [{ name: 'Ceci', amount: '1' }],
        steps: ['unused'], diets: ['vegan'], allergens: [],
      }) }),
      sync: { repository: secondRepository, authService, appOrigin },
    });

    const generationPayload = {
      ingredients: ['Ceci'], constraints: [],
      dietProfile: { diet: 'vegan', excludedAllergens: [], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null } },
    };
    const generation = dispatchApp.inject({ method: 'POST', url: '/v1/ai-recipes', headers, payload: generationPayload });
    const pendingOperations: Promise<unknown>[] = [generation];
    let apiRevocationAcknowledged = false;
    let syncRevocationAcknowledged = false;

    try {
      await waitWithin(providerStarted, 'fake provider dispatch');
      const apiRevocation = revokeApp.inject({
        method: 'PUT', url: '/v1/ai-recipes/consent', headers, payload: { enabled: false },
      }).then((response) => { apiRevocationAcknowledged = true; return response; });
      const syncRevocation = revokeApp.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: {
          deviceId: 'cross-pool-sync-device', cursor: 0,
          mutations: [{
            mutationId: `cross-pool-revoke-${randomUUID()}`, deviceId: 'cross-pool-sync-device', entityType: 'ai_consent',
            entityId: 'profile', operation: 'upsert', payload: { enabled: false, updatedAt: new Date().toISOString() },
            clientUpdatedAt: new Date().toISOString(), syncScope: `account:${user.id}`,
          }],
        },
      }).then((response) => { syncRevocationAcknowledged = true; return response; });
      pendingOperations.push(apiRevocation, syncRevocation);
      let lockWaiters = 0;
      for (let attempt = 0; attempt < 100 && lockWaiters < 2; attempt += 1) {
        const waiting = await integrationDatabase.db.execute(sql`SELECT pid FROM pg_stat_activity
          WHERE state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_%'`);
        lockWaiters = waiting.length;
        if (lockWaiters < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lockWaiters).toBeGreaterThanOrEqual(2);
      expect(apiRevocationAcknowledged).toBe(false);
      expect(syncRevocationAcknowledged).toBe(false);

      releaseProvider();
      const [generated, revoked, synced] = await Promise.all([generation, apiRevocation, syncRevocation]);
      expect(generated.statusCode).toBe(201);
      expect(revoked.statusCode).toBe(200);
      expect(synced.statusCode).toBe(200);

      const nextProviderCall = await dispatchApp.inject({ method: 'POST', url: '/v1/ai-recipes', headers, payload: generationPayload });
      expect(nextProviderCall.statusCode).toBe(403);
      expect(nextProviderCall.json()).toMatchObject({ code: 'ai_consent_required' });
      expect(providerCalls).toBe(1);

      await firstDatabase.db.update(syncItems).set({
        payload: { enabled: true, updatedAt: new Date().toISOString() },
        clientUpdatedAt: new Date(), updatedAt: new Date(),
        serverSequence: sql`nextval('sync_server_sequence')`,
      }).where(and(
        eq(syncItems.userId, user.id),
        eq(syncItems.scopeType, 'user'),
        eq(syncItems.scopeId, user.id),
        eq(syncItems.entityType, 'ai_consent'),
        eq(syncItems.entityId, 'profile'),
      ));
      const legacyProviderCall = await dispatchApp.inject({ method: 'POST', url: '/v1/ai-recipes', headers, payload: generationPayload });
      expect(legacyProviderCall.statusCode).toBe(403);
      expect(legacyProviderCall.json()).toMatchObject({ code: 'ai_consent_required' });
      expect(providerCalls).toBe(1);
    } finally {
      releaseProvider();
      await Promise.allSettled(pendingOperations);
      await dispatchApp.close();
      await revokeApp.close();
      await firstDatabase.close();
      await secondDatabase.close();
    }
  }, 15_000);

  it('confirms and reuses a diary recipe through the PostgreSQL-backed route', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const user = await authRepository.createUser({
      email: `dinner-route-${randomUUID()}@example.com`,
      passwordHash: null,
      emailVerifiedAt: new Date(),
    });
    const sessionToken = createOpaqueToken();
    const csrfToken = `integration-csrf-${randomUUID()}`;
    await authRepository.createSession({
      userId: user.id,
      tokenHash: sessionToken.hash,
      csrfTokenHash: hashOpaqueToken(csrfToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const requestHeaders = {
      cookie: `ikuck_session=${sessionToken.raw}`,
      origin: appOrigin,
      'x-csrf-token': csrfToken,
    };
    const repository = createDrizzleSyncRepository(database.db);
    const now = new Date(Date.now() - 2_000).toISOString();
    const entryId = `integration-dinner-${randomUUID()}`;
    const dinner = {
      id: entryId,
      date: now.slice(0, 10),
      text: 'Pasta con zucchine',
      servings: 2,
      note: null,
      recipes: [],
      authorId: user.id,
      createdAt: now,
      updatedAt: now,
    };
    await repository.applyMutation(user.id, {
      mutationId: randomUUID(),
      deviceId: 'integration-dinner-route',
      entityType: 'dinner_entry',
      entityId: entryId,
      operation: 'upsert',
      payload: dinner,
      clientUpdatedAt: now,
      syncScope: `account:${user.id}`,
    });
    const recipeDraft = {
      draftId: 'integration-draft-1',
      title: 'Pasta con zucchine',
      description: 'Pasta con zucchine e ricotta.',
      ingredients: [{ name: 'Pasta', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' }],
      steps: ['Cuoci la pasta.', 'Condisci con zucchine.'],
      servings: 2,
      durationMinutes: null,
      diets: null,
      allergens: null,
      suggestedFields: [],
    };

    const confirmed = await app.inject({
      method: 'POST',
      url: `/v1/dinner-entries/${entryId}/confirm-recipe`,
      headers: requestHeaders,
      payload: { draft: recipeDraft },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ entry: { id: entryId, recipes: [{ source: 'diary', title: recipeDraft.title }] }, recipe: { title: recipeDraft.title, authorId: user.id } });
    const firstRecipeId = confirmed.json().recipe.id as string;

    const retried = await app.inject({
      method: 'POST',
      url: `/v1/dinner-entries/${entryId}/confirm-recipe`,
      headers: requestHeaders,
      payload: { draft: recipeDraft },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().recipe.id).toBe(firstRecipeId);
    expect(retried.json().entry.recipes).toHaveLength(1);

    const secondEntryId = `integration-dinner-link-${randomUUID()}`;
    const secondDinner = { ...dinner, id: secondEntryId, recipes: [] };
    await repository.applyMutation(user.id, {
      mutationId: randomUUID(),
      deviceId: 'integration-dinner-route',
      entityType: 'dinner_entry',
      entityId: secondEntryId,
      operation: 'upsert',
      payload: secondDinner,
      clientUpdatedAt: now,
      syncScope: `account:${user.id}`,
    });
    const linked = await app.inject({
      method: 'POST',
      url: `/v1/dinner-entries/${secondEntryId}/link-recipe`,
      headers: requestHeaders,
      payload: { recipeId: firstRecipeId, source: 'diary' },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().entry.recipes).toEqual([{ recipeId: firstRecipeId, title: recipeDraft.title, source: 'diary' }]);
  });

  it('keeps confirmed recipes in the right PostgreSQL House or personal scope', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const repository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const createSession = async (label: string) => {
      const user = await authRepository.createUser({
        email: `dinner-house-route-${label}-${randomUUID()}@example.com`,
        passwordHash: null,
        emailVerifiedAt: new Date(),
      });
      const token = createOpaqueToken();
      const csrfToken = `integration-csrf-${randomUUID()}`;
      await authRepository.createSession({
        userId: user.id,
        tokenHash: token.hash,
        csrfTokenHash: hashOpaqueToken(csrfToken),
        expiresAt: new Date(Date.now() + 60_000),
      });
      return {
        user,
        headers: { cookie: `ikuck_session=${token.raw}`, origin: appOrigin, 'x-csrf-token': csrfToken },
      };
    };
    const owner = await createSession('owner');
    const member = await createSession('member');
    const outsider = await createSession('outsider');
    const houseId = randomUUID();
    await database.db.insert(houses).values({ id: houseId, name: 'Dinner route integration house', createdByUserId: owner.user.id });
    await database.db.insert(houseMemberships).values([
      { houseId, userId: owner.user.id, role: 'admin' },
      { houseId, userId: member.user.id, role: 'member' },
    ]);

    const houseEntryId = `house-dinner-${randomUUID()}`;
    const now = new Date(Date.now() - 2_000).toISOString();
    const dinner = (id: string, text: string) => ({
      id, date: now.slice(0, 10), text, servings: 2, note: null, recipes: [],
      authorId: null, createdAt: now, updatedAt: now,
    });
    await repository.applyMutation(owner.user.id, {
      mutationId: randomUUID(), deviceId: 'integration-house-dinner', entityType: 'dinner_entry',
      entityId: houseEntryId, operation: 'upsert', payload: dinner(houseEntryId, 'Pasta con zucchine'),
      clientUpdatedAt: now,
    });
    const recipeDraft = {
      draftId: 'house-route-draft-owner', title: 'Pasta con zucchine', description: 'Pasta con zucchine.',
      ingredients: [{ name: 'Pasta', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' }],
      steps: ['Cuoci la pasta.'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [],
    };
    const confirmed = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${houseEntryId}/confirm-recipe`, headers: owner.headers,
      payload: { draft: recipeDraft },
    });
    expect(confirmed.statusCode).toBe(200);
    const recipeId = confirmed.json().recipe.id as string;
    await expect(repository.readEntity(member.user.id, 'saved_recipe', recipeId)).resolves.toMatchObject({
      syncScope: `house:${houseId}`, payload: { title: recipeDraft.title, authorId: owner.user.id },
    });

    const memberConfirmation = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${houseEntryId}/confirm-recipe`, headers: member.headers,
      payload: { draft: { ...recipeDraft, draftId: 'house-route-draft-member', title: 'Ricetta condivisa' } },
    });
    expect(memberConfirmation.statusCode).toBe(200);
    await expect(repository.readEntity(owner.user.id, 'saved_recipe', memberConfirmation.json().recipe.id as string))
      .resolves.toMatchObject({ syncScope: `house:${houseId}`, payload: { authorId: member.user.id } });
    const notFound = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${houseEntryId}/confirm-recipe`, headers: outsider.headers,
      payload: { draft: { ...recipeDraft, draftId: 'house-route-draft-outsider' } },
    });
    expect(notFound.statusCode).toBe(404);

    const privateEntryId = `private-dinner-${randomUUID()}`;
    await repository.applyMutation(outsider.user.id, {
      mutationId: randomUUID(), deviceId: 'integration-private-dinner', entityType: 'dinner_entry',
      entityId: privateEntryId, operation: 'upsert', payload: dinner(privateEntryId, 'Cena personale senza casa'),
      clientUpdatedAt: now, syncScope: `account:${outsider.user.id}`,
    });
    const privateConfirmed = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${privateEntryId}/confirm-recipe`, headers: outsider.headers,
      payload: { draft: { ...recipeDraft, draftId: 'private-route-draft-outsider' } },
    });
    expect(privateConfirmed.statusCode).toBe(200);
    const privateRecipeId = privateConfirmed.json().recipe.id as string;
    await expect(repository.readEntity(member.user.id, 'dinner_entry', privateEntryId)).resolves.toBeNull();
    await expect(repository.readEntity(member.user.id, 'saved_recipe', privateRecipeId)).resolves.toBeNull();
    const privateAccess = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${privateEntryId}/confirm-recipe`, headers: owner.headers,
      payload: { draft: { ...recipeDraft, draftId: 'private-route-draft-owner' } },
    });
    expect(privateAccess.statusCode).toBe(404);
  });

  it('separates house records from a member’s personal consent in account export', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const admin = await authRepository.createUser({ email: `export-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const member = await authRepository.createUser({ email: `export-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const houseId = (await service.createHouse(admin.id, 'Casa esportata')).state.house!.id;
    await service.addMember(admin.id, member.email);
    await syncRepository.updateAiConsent(member.id, {
      enabled: true,
      homeProvider: 'openai',
      expectedRevision: DEFAULT_AI_CONSENT_REVISION,
    });
    const itemId = `export-item-${suffix}`;
    await syncRepository.applyMutation(admin.id, {
      mutationId: randomUUID(), deviceId: `export-${suffix}`, entityType: 'pantry_item', entityId: itemId,
      operation: 'upsert', payload: { id: itemId, label: 'Lenticchie', known: true },
      clientUpdatedAt: new Date().toISOString(), syncScope: `house:${houseId}`,
    });

    const exported = await createDrizzleProfileRepository(database.db, syncRepository).exportAccount(member.id);

    expect(exported.personalData).toContainEqual(expect.objectContaining({ entityType: 'ai_consent', syncScope: `account:${member.id}` }));
    expect(exported.houseData).toContainEqual(expect.objectContaining({ entityId: itemId, syncScope: `house:${houseId}` }));
    expect(exported.personalData).not.toContainEqual(expect.objectContaining({ entityId: itemId }));
    expect(exported.houseData).not.toContainEqual(expect.objectContaining({ entityType: 'ai_consent' }));
  });

  it('preserves shared records when an active member deletes their account', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const admin = await authRepository.createUser({ email: `delete-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const member = await authRepository.createUser({ email: `delete-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const houseId = (await service.createHouse(admin.id, 'Casa conservata')).state.house!.id;
    await service.addMember(admin.id, member.email);
    const itemId = `saved-after-delete-${suffix}`;
    await syncRepository.applyMutation(member.id, {
      mutationId: randomUUID(), deviceId: `delete-member-${suffix}`,
      entityType: 'pantry_item', entityId: itemId, operation: 'upsert',
      payload: { id: itemId, label: 'Fagioli', known: true },
      clientUpdatedAt: new Date().toISOString(), syncScope: `house:${houseId}`,
    });

    await syncRepository.applyMutation(member.id, {
      mutationId: randomUUID(), deviceId: `delete-member-${suffix}`, entityType: 'ai_consent',
      entityId: 'profile', operation: 'upsert',
      payload: { enabled: true, updatedAt: new Date().toISOString() },
      clientUpdatedAt: new Date().toISOString(), syncScope: `account:${member.id}`,
    });

    await createDrizzleProfileRepository(database.db, syncRepository).deleteAccount(member.id);

    await expect(syncRepository.readEntity(admin.id, 'pantry_item', itemId)).resolves.toMatchObject({
      syncScope: `house:${houseId}`, payload: { label: 'Fagioli' },
    });
    await expect(houseRepository.getStateForUser(admin.id)).resolves.toMatchObject({ members: [expect.objectContaining({ userId: admin.id })] });
  });

  it('serializes account deletion behind a concurrent user-to-house migration without a PostgreSQL deadlock', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db);
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const admin = await authRepository.createUser({ email: `migration-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const member = await authRepository.createUser({ email: `migration-deleted-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const houseId = (await service.createHouse(admin.id, 'Casa concorrente')).state.house!.id;
    const lotId = `pending-delete-${suffix}`;
    const now = new Date().toISOString();
    await syncRepository.applyMutation(member.id, {
      mutationId: randomUUID(), deviceId: `migration-delete-${suffix}`, entityType: 'pantry_lot', entityId: lotId,
      operation: 'upsert', payload: { id: lotId, ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 200, unit: 'g', expiresAt: null, createdAt: now, updatedAt: now },
      clientUpdatedAt: now, syncScope: `account:${member.id}`,
    });
    // Membership has committed, but its retryable automatic migration has not yet run.
    await houseRepository.addExistingMember({ adminUserId: admin.id, email: member.email, now: new Date() });
    let releaseHouse: (() => void) | undefined;
    let signalHouseLocked: (() => void) | undefined;
    const houseLocked = new Promise<void>((resolve) => { signalHouseLocked = resolve; });
    const heldHouse = new Promise<void>((resolve) => { releaseHouse = resolve; });
    const holder = database.db.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${houseId} FOR UPDATE`);
      signalHouseLocked?.();
      await heldHouse;
    });
    await houseLocked;
    try {
      const migration = syncRepository.migrateUserSharedDataToHouse(member.id, houseId);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const deletion = createDrizzleProfileRepository(database.db, syncRepository).deleteAccount(member.id);
      await new Promise((resolve) => setTimeout(resolve, 80));
      releaseHouse?.();
      await expect(Promise.all([migration, deletion])).resolves.toEqual([undefined, undefined]);
      await expect(syncRepository.readEntity(admin.id, 'pantry_lot', lotId)).resolves.toMatchObject({ syncScope: `house:${houseId}` });
    } finally {
      releaseHouse?.();
      await holder;
    }
  }, 15_000);

  it('preserves house history after its creator leaves and deletes their account', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const creator = await authRepository.createUser({ email: `delete-creator-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const survivor = await authRepository.createUser({ email: `delete-survivor-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const houseId = (await service.createHouse(creator.id, 'Casa storica')).state.house!.id;
    await service.addMember(creator.id, survivor.email);
    await service.changeRole(creator.id, survivor.id, 'admin');
    const itemId = `creator-history-${suffix}`;
    await syncRepository.applyMutation(creator.id, {
      mutationId: randomUUID(), deviceId: `delete-creator-${suffix}`,
      entityType: 'pantry_item', entityId: itemId, operation: 'upsert',
      payload: { id: itemId, label: 'Riso', known: true },
      clientUpdatedAt: new Date().toISOString(), syncScope: `house:${houseId}`,
    });
    await service.leaveHouse(creator.id);

    await createDrizzleProfileRepository(database.db, syncRepository).deleteAccount(creator.id);

    await expect(syncRepository.readEntity(survivor.id, 'pantry_item', itemId)).resolves.toMatchObject({
      syncScope: `house:${houseId}`, payload: { label: 'Riso' },
    });
    await expect(houseRepository.getStateForUser(survivor.id)).resolves.toMatchObject({ house: { id: houseId } });
  });

  it('requires a successor admin before deleting the last admin account', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db);
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const admin = await authRepository.createUser({ email: `delete-last-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const member = await authRepository.createUser({ email: `delete-last-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    await service.createHouse(admin.id, 'Casa amministrata');
    await service.addMember(admin.id, member.email);

    await expect(createDrizzleProfileRepository(database.db, syncRepository).deleteAccount(admin.id))
      .rejects.toMatchObject({ code: 'house_last_admin_required', status: 409 });
    await expect(houseRepository.getStateForUser(admin.id)).resolves.toMatchObject({
      membership: { role: 'admin' }, members: expect.arrayContaining([expect.objectContaining({ userId: member.id })]),
    });
  });

  it('removes the empty house when its last member deletes their account', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db);
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const admin = await authRepository.createUser({ email: `delete-sole-member-${randomUUID()}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const houseId = (await service.createHouse(admin.id, 'Casa vuota')).state.house!.id;
    const itemId = `sole-item-${randomUUID()}`;
    await syncRepository.applyMutation(admin.id, {
      mutationId: randomUUID(), deviceId: 'sole-account-delete', entityType: 'pantry_item',
      entityId: itemId, operation: 'upsert', payload: { id: itemId, label: 'Riso', known: true },
      clientUpdatedAt: new Date().toISOString(), syncScope: `house:${houseId}`,
    });

    await createDrizzleProfileRepository(database.db, syncRepository).deleteAccount(admin.id);

    await expect(database.db.select().from(houses).where(eq(houses.id, houseId))).resolves.toHaveLength(0);
    await expect(database.db.select().from(syncItems).where(and(eq(syncItems.scopeType, 'house'), eq(syncItems.scopeId, houseId))))
      .resolves.toHaveLength(0);
  });

  it('rolls back the user when profile creation fails', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const email = `integration-atomic-${Date.now()}@example.com`;
    const repository = createDrizzleAuthRepository(database.db);
    await database.db.execute(sql`DROP TRIGGER IF EXISTS auth_repository_test_profile_failure ON user_profiles`);
    await database.db.execute(sql`DROP FUNCTION IF EXISTS auth_repository_test_profile_failure()`);
    await database.db.execute(sql`
      CREATE FUNCTION auth_repository_test_profile_failure()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'profile insert failed'; END; $$
    `);
    await database.db.execute(sql`
      CREATE TRIGGER auth_repository_test_profile_failure
      BEFORE INSERT ON user_profiles
      FOR EACH ROW EXECUTE FUNCTION auth_repository_test_profile_failure()
    `);

    try {
      await expect(repository.createUser({ email, passwordHash: 'password-hash' }))
        .rejects.toThrow();
      await expect(repository.findUserByEmail(email)).resolves.toBeNull();
    } finally {
      await database.db.execute(sql`DROP TRIGGER IF EXISTS auth_repository_test_profile_failure ON user_profiles`);
      await database.db.execute(sql`DROP FUNCTION IF EXISTS auth_repository_test_profile_failure()`);
    }
  });

  it('rolls back a Google user when identity creation fails', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const email = `integration-google-atomic-${Date.now()}@example.com`;
    const repository = createDrizzleAuthRepository(database.db);
    await database.db.execute(sql`DROP TRIGGER IF EXISTS auth_repository_test_google_identity_failure ON account_identities`);
    await database.db.execute(sql`DROP FUNCTION IF EXISTS auth_repository_test_google_identity_failure()`);
    await database.db.execute(sql`
      CREATE FUNCTION auth_repository_test_google_identity_failure()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'identity insert failed'; END; $$
    `);
    await database.db.execute(sql`
      CREATE TRIGGER auth_repository_test_google_identity_failure
      BEFORE INSERT ON account_identities
      FOR EACH ROW EXECUTE FUNCTION auth_repository_test_google_identity_failure()
    `);

    try {
      await expect(repository.createGoogleUser({
        email,
        providerSubject: `google-subject-${Date.now()}`,
        providerEmail: email,
        emailVerifiedAt: new Date('2026-09-13T12:00:00.000Z'),
      })).rejects.toThrow();
      await expect(repository.findUserByEmail(email)).resolves.toBeNull();
    } finally {
      await database.db.execute(sql`DROP TRIGGER IF EXISTS auth_repository_test_google_identity_failure ON account_identities`);
      await database.db.execute(sql`DROP FUNCTION IF EXISTS auth_repository_test_google_identity_failure()`);
    }
  });

  it('consumes one password reset token only once under concurrent requests', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const email = `integration-reset-race-${Date.now()}@example.com`;
    const now = new Date('2026-09-13T12:00:00.000Z');
    const tokenHash = `integration-reset-hash-${Date.now()}`;
    const repository = createDrizzleAuthRepository(database.db);
    const user = await repository.createUser({ email, passwordHash: 'old-password-hash', emailVerifiedAt: now });
    await repository.createPasswordResetToken({
      userId: user.id,
      tokenHash,
      expiresAt: new Date('2026-10-13T12:00:00.000Z'),
    });

    const results = await Promise.all([
      repository.resetPassword(tokenHash, 'new-password-hash-a', now),
      repository.resetPassword(tokenHash, 'new-password-hash-b', now),
    ]);

    expect(results.sort()).toEqual([false, true]);
    await expect(repository.findUserByEmail(email)).resolves.toMatchObject({ passwordHash: expect.stringMatching(/^new-password-hash-[ab]$/) });
  });

  it('registers, verifies, logs in, synchronizes idempotently and exports without secrets', async () => {
    const email = `integration-${Date.now()}@example.com`;
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: appOrigin },
      payload: { email, password: 'integration password 123' },
    });
    expect(register.statusCode).toBe(202);
    expect(sentEmails).toHaveLength(1);

    const tokenMatch = sentEmails[0].html.match(/token=([^"&]+)/);
    expect(tokenMatch).not.toBeNull();
    const verification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { origin: appOrigin },
      payload: { token: decodeURIComponent(tokenMatch![1]) },
    });
    expect(verification.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: appOrigin },
      payload: { email, password: 'integration password 123' },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json<{ csrfToken: string; user: { id: string } }>();
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : cookieHeader!.split(';')[0];
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).not.toContain('Secure');

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { origin: appOrigin, cookie },
      payload: { deviceId: 'device-1', cursor: 0, mutations: [] },
    });
    expect(rejected.statusCode).toBe(403);

    const mutation = {
      mutationId: 'integration-mutation-1',
      deviceId: 'device-1',
      entityType: 'pantry_item' as const,
      entityId: 'pasta',
      operation: 'upsert' as const,
      payload: { id: 'pasta', label: 'Pasta', known: true },
      clientUpdatedAt: '2026-09-12T12:00:00.000Z',
      syncScope: `account:${loginBody.user.id}` as const,
    };
    const sync = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: { deviceId: 'device-1', cursor: 0, mutations: [mutation] },
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json<{ changes: unknown[] }>().changes).toHaveLength(1);

    const retry = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: { deviceId: 'device-1', cursor: 0, mutations: [mutation] },
    });
    expect(retry.statusCode).toBe(200);

    const older = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: {
        deviceId: 'device-1',
        cursor: 1,
        mutations: [{ ...mutation, mutationId: 'integration-mutation-older', clientUpdatedAt: '2026-09-12T11:00:00.000Z', payload: { id: 'pasta', label: 'Old', known: true } }],
      },
    });
    expect(older.statusCode).toBe(200);
    expect(await createDrizzleSyncRepository(database!.db).readEntity(loginBody.user.id, 'pantry_item', 'pasta'))
      .toMatchObject({ payload: { id: 'pasta', label: 'Pasta' } });

    const lot = {
      id: 'integration-lot-pasta',
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: 500,
      unit: 'g' as const,
      expiresAt: '2026-10-01',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    const lotSync = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: {
        deviceId: 'device-1',
        cursor: 1,
        mutations: [{
          mutationId: 'integration-lot-mutation',
          deviceId: 'device-1',
          entityType: 'pantry_lot',
          entityId: lot.id,
          operation: 'upsert',
          payload: lot,
          clientUpdatedAt: lot.updatedAt,
          syncScope: `account:${loginBody.user.id}` as const,
        }],
      },
    });
    expect(lotSync.statusCode).toBe(200);

    const lots = await app.inject({
      method: 'GET',
      url: '/v1/pantry-lots',
      headers: { cookie },
    });
    expect(lots.statusCode).toBe(200);
    expect(lots.json<{ lots: Array<{ id: string; quantity: number }> }>().lots).toContainEqual(expect.objectContaining({ id: lot.id, quantity: 500 }));

    const shoppingItem = {
      id: 'integration-shopping-pasta',
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: 500,
      unit: 'g' as const,
      note: null,
      purchased: false,
      sourceRecipeId: 'pasta-tonno-pomodoro',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    const shoppingSync = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: {
        deviceId: 'device-1',
        cursor: 2,
        mutations: [{
          mutationId: 'integration-shopping-mutation',
          deviceId: 'device-1',
          entityType: 'shopping_list_item',
          entityId: shoppingItem.id,
          operation: 'upsert',
          payload: shoppingItem,
          clientUpdatedAt: shoppingItem.updatedAt,
          syncScope: `account:${loginBody.user.id}`,
        }],
      },
    });
    expect(shoppingSync.statusCode).toBe(200);

    const shoppingList = await app.inject({ method: 'GET', url: '/v1/shopping-list', headers: { cookie } });
    expect(shoppingList.statusCode).toBe(200);
    expect(shoppingList.json<{ items: Array<{ id: string; quantity: number }> }>().items).toContainEqual(expect.objectContaining({ id: shoppingItem.id, quantity: 500 }));

    const cookedEvent = {
      id: 'integration-event-pasta',
      recipeId: 'pasta-tonno-pomodoro',
      recipeTitle: 'Pasta al tonno e pomodoro',
      servings: 2,
      cookedAt: '2026-09-13T13:00:00.000Z',
      note: 'Con basilico',
      createdAt: '2026-09-13T13:00:00.000Z',
      updatedAt: '2026-09-13T13:00:00.000Z',
    };
    const preference = {
      recipeId: cookedEvent.recipeId,
      favorite: true,
      rating: 5,
      note: 'Da rifare',
      createdAt: cookedEvent.createdAt,
      updatedAt: cookedEvent.updatedAt,
    };
    const activitySync = await app.inject({
      method: 'POST',
      url: '/v1/sync',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: {
        deviceId: 'device-1',
        cursor: 3,
        mutations: [
          {
            mutationId: 'integration-event-mutation', deviceId: 'device-1', entityType: 'cook_event',
            entityId: cookedEvent.id, operation: 'upsert', payload: cookedEvent, clientUpdatedAt: cookedEvent.updatedAt,
            syncScope: `account:${loginBody.user.id}`,
          },
          {
            mutationId: 'integration-preference-mutation', deviceId: 'device-1', entityType: 'recipe_preference',
            entityId: preference.recipeId, operation: 'upsert', payload: preference, clientUpdatedAt: preference.updatedAt,
            syncScope: `account:${loginBody.user.id}`,
          },
        ],
      },
    });
    expect(activitySync.statusCode).toBe(200);

    const activity = await app.inject({ method: 'GET', url: '/v1/activity', headers: { cookie } });
    expect(activity.statusCode).toBe(200);
    expect(activity.json<{ events: Array<{ id: string }> }>().events).toContainEqual(expect.objectContaining({ id: cookedEvent.id }));
    const preferences = await app.inject({ method: 'GET', url: '/v1/recipes/preferences', headers: { cookie } });
    expect(preferences.statusCode).toBe(200);
    expect(preferences.json<{ preferences: Array<{ recipeId: string; note: string }> }>().preferences)
      .toContainEqual(expect.objectContaining({ recipeId: preference.recipeId, note: 'Da rifare' }));

    const dietProfile = await app.inject({
      method: 'PUT',
      url: '/v1/profile/preferences',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: {
        diet: 'vegetarian',
        excludedAllergens: ['fish'],
        nutrition: { maxCaloriesPerServing: 800, minProteinGramsPerServing: null },
      },
    });
    expect(dietProfile.statusCode).toBe(200);
    expect(dietProfile.json<{ profile: { diet: string; excludedAllergens: string[] } }>().profile)
      .toMatchObject({ diet: 'vegetarian', excludedAllergens: ['fish'] });

    const dietProfileRead = await app.inject({ method: 'GET', url: '/v1/profile/preferences', headers: { cookie } });
    expect(dietProfileRead.statusCode).toBe(200);
    expect(dietProfileRead.json<{ profile: { diet: string } }>().profile.diet).toBe('vegetarian');

    const currentAiConsent = await app.inject({
      method: 'GET',
      url: '/v1/ai-recipes/consent',
      headers: { cookie },
    });
    expect(currentAiConsent.statusCode).toBe(200);
    const aiConsent = await app.inject({
      method: 'PUT',
      url: '/v1/ai-recipes/consent',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: { enabled: true, homeProvider: 'openai', expectedRevision: currentAiConsent.json<{ consent: { updatedAt: string } }>().consent.updatedAt },
    });
    expect(aiConsent.statusCode).toBe(200);
    const aiRecipe = await app.inject({
      method: 'POST',
      url: '/v1/ai-recipes',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: {
        ingredients: ['Ceci'],
        constraints: [],
        dietProfile: { diet: 'vegan', excludedAllergens: [], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null } },
      },
    });
    expect(aiRecipe.statusCode).toBe(201);
    expect(aiRecipe.json<{ recipe: { source: string; title: string } }>().recipe).toMatchObject({ source: 'ai', title: 'Ricetta AI di integrazione' });

    const previewList = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers: { cookie } });
    expect(previewList.statusCode).toBe(200);
    expect(previewList.json<{ recipes: Array<{ title: string }> }>().recipes)
      .not.toContainEqual(expect.objectContaining({ title: 'Ricetta AI di integrazione' }));

    const savedAiRecipe = await app.inject({
      method: 'POST',
      url: '/v1/ai-recipes/save',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: { recipe: aiRecipe.json<{ recipe: unknown }>().recipe },
    });
    expect(savedAiRecipe.statusCode).toBe(200);

    const aiRecipes = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers: { cookie } });
    expect(aiRecipes.statusCode).toBe(200);
    expect(aiRecipes.json<{ recipes: Array<{ title: string }> }>().recipes).toContainEqual(expect.objectContaining({ title: 'Ricetta AI di integrazione' }));

    const exported = await app.inject({ method: 'GET', url: '/v1/profile/export', headers: { cookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain('integration password 123');
    expect(exported.body).not.toContain(loginBody.csrfToken);
    expect(exported.json<{ account: { id: string } }>().account.id).toBe(loginBody.user.id);

    const rollbackRepository = createDrizzleSyncRepository(database!.db);
    const rollbackMutationId = `integration-rollback-${Date.now()}`;
    await expect(rollbackRepository.applyMutation(loginBody.user.id, {
      mutationId: rollbackMutationId,
      deviceId: 'device-rollback',
      entityType: 'pantry_item',
      entityId: 'rollback-item',
      operation: 'upsert',
      payload: { id: 'rollback-item', label: 'Rollback', known: true },
      clientUpdatedAt: 'not-a-date',
    })).rejects.toThrow();
    await expect(rollbackRepository.applyMutation(loginBody.user.id, {
      mutationId: rollbackMutationId,
      deviceId: 'device-rollback',
      entityType: 'pantry_item',
      entityId: 'rollback-item',
      operation: 'upsert',
      payload: { id: 'rollback-item', label: 'Recovered', known: true },
      clientUpdatedAt: '2026-09-13T14:00:00.000Z',
    })).resolves.toMatchObject({ applied: true });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/v1/profile',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('blocks an unverified account before verification and supports migration and quota boundaries', async () => {
    if (database === null || cache === null) throw new Error('Integration services are not configured');

    const email = `integration-unverified-${Date.now()}@example.com`;
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: appOrigin },
      payload: { email, password: 'integration password 123' },
    });
    expect(register.statusCode).toBe(202);

    const blockedLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: appOrigin },
      payload: { email, password: 'integration password 123' },
    });
    expect(blockedLogin.statusCode).toBe(403);
    expect(blockedLogin.json()).toMatchObject({ code: 'email_not_verified' });

    const emailMessage = sentEmails.at(-1);
    expect(emailMessage).toBeDefined();
    const tokenMatch = emailMessage!.html.match(/token=([^"&]+)/);
    expect(tokenMatch).not.toBeNull();
    const verification = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { origin: appOrigin },
      payload: { token: decodeURIComponent(tokenMatch![1]) },
    });
    expect(verification.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: appOrigin },
      payload: { email, password: 'integration password 123' },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json<{ csrfToken: string }>();
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : cookieHeader!.split(';')[0];
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/v1/profile',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
    });
    expect(deleted.statusCode).toBe(204);

    const quotaUser = `quota-boundary-${Date.now()}`;
    const limiter = createRedisGenerationRateLimiter({
      incrementWithExpiry: cache.incrementWithExpiry,
      clock: () => new Date('2026-09-13T23:59:00.000Z'),
    });
    const beforeMidnight = await limiter.consume(quotaUser);
    expect(beforeMidnight).toMatchObject({ used: 1, remaining: 9999, allowed: true });
    const nextDayLimiter = createRedisGenerationRateLimiter({
      incrementWithExpiry: cache.incrementWithExpiry,
      clock: () => new Date('2026-09-14T00:01:00.000Z'),
    });
    const afterMidnight = await nextDayLimiter.consume(quotaUser);
    expect(afterMidnight).toMatchObject({ used: 1, remaining: 9999, allowed: true });

    await migrate(database.db, {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'),
    });
  });

  it('merges two verified accounts and a guest device into one house pantry idempotently', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const now = new Date('2026-09-24T12:00:00.000Z');
    const suffix = Date.now();
    const admin = await authRepository.createUser({ email: `integration-house-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `integration-house-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const lot = (id: string, quantity: number, updatedAt: string): PantryLot => ({
      id,
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity,
      unit: 'g',
      expiresAt: '2026-10-01',
      createdAt: updatedAt,
      updatedAt,
    });

    await syncRepository.applyMutation(admin.id, {
      mutationId: `integration-house-admin-lot-${suffix}`,
      deviceId: 'admin-device',
      entityType: 'pantry_lot',
      entityId: 'admin-pasta',
      operation: 'upsert',
      payload: lot('admin-pasta', 1000, '2026-09-24T10:00:00.000Z'),
      clientUpdatedAt: '2026-09-24T10:00:00.000Z',
    });
    await syncRepository.applyMutation(member.id, {
      mutationId: `integration-house-member-lot-${suffix}`,
      deviceId: 'member-device',
      entityType: 'pantry_lot',
      entityId: 'member-pasta',
      operation: 'upsert',
      payload: lot('member-pasta', 500, '2026-09-24T10:01:00.000Z'),
      clientUpdatedAt: '2026-09-24T10:01:00.000Z',
    });

    const created = await service.createHouse(admin.id, `Casa integrazione ${suffix}`);
    await service.addMember(admin.id, member.email);
    const firstGuestMerge = await service.mergeGuestPantry(member.id, {
      deviceId: 'member-device',
      lots: [lot('guest-pasta', 250, '2026-09-24T10:02:00.000Z')],
      stapleIds: ['salt'],
    });
    const retryGuestMerge = await service.mergeGuestPantry(member.id, {
      deviceId: 'member-device',
      lots: [lot('guest-pasta', 250, '2026-09-24T10:02:00.000Z')],
      stapleIds: ['salt'],
    });

    expect(created.state.house?.id).toBeDefined();
    expect(firstGuestMerge).toMatchObject({ mergedLots: 1, mergedGroups: 1, importedStaples: 1 });
    expect(retryGuestMerge).toMatchObject({ addedLots: 0, mergedLots: 0, importedStaples: 0 });
    const houseRows = await syncRepository.readAll(admin.id);
    expect(houseRows).toContainEqual(expect.objectContaining({
      entityType: 'pantry_lot',
      payload: expect.objectContaining({ quantity: 1750, unit: 'g' }),
    }));
    expect(houseRows).toContainEqual(expect.objectContaining({
      entityType: 'staple_preference',
      entityId: 'salt',
      payload: { enabled: true },
    }));
  });

  it('rolls back staged account mutations when semantic House import fails and retries idempotently', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const now = new Date();
    const admin = await authRepository.createUser({ email: `atomic-import-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `atomic-import-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const houseId = (await service.createHouse(admin.id, `Casa import atomico ${suffix}`)).state.house!.id;
    const lot: PantryLot = {
      id: `atomic-lot-${suffix}`, ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 200, unit: 'g', expiresAt: '2026-10-20',
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    await syncRepository.applyMutation(member.id, {
      mutationId: randomUUID(), deviceId: 'atomic-original-device', entityType: 'pantry_lot', entityId: lot.id,
      operation: 'upsert', payload: lot, clientUpdatedAt: now.toISOString(), syncScope: `account:${member.id}`,
    });
    // Commit membership without running the automatic migration, so the test can
    // exercise the retry endpoint with an existing account source row.
    await houseRepository.addExistingMember({ adminUserId: admin.id, email: member.email, now });
    const pendingMutation: SyncMutation = {
      mutationId: randomUUID(), deviceId: 'atomic-revision-device', entityType: 'pantry_lot', entityId: lot.id,
      operation: 'upsert', payload: { ...lot, quantity: 450, updatedAt: new Date(now.getTime() + 2000).toISOString() },
      clientUpdatedAt: new Date(now.getTime() + 2000).toISOString(), syncScope: `account:${member.id}`,
    };

    await database.db.execute(sql`DROP TRIGGER IF EXISTS house_account_queue_test_failure ON sync_items`);
    await database.db.execute(sql`DROP FUNCTION IF EXISTS house_account_queue_test_failure()`);
    await database.db.execute(sql`
      CREATE FUNCTION house_account_queue_test_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.scope_type = 'house' AND NEW.entity_type = 'pantry_lot' THEN
          RAISE EXCEPTION 'injected House import failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.db.execute(sql`
      CREATE TRIGGER house_account_queue_test_failure
      BEFORE INSERT ON sync_items FOR EACH ROW EXECUTE FUNCTION house_account_queue_test_failure()
    `);
    try {
      await expect(service.importPendingAccountQueue(member.id, [pendingMutation])).rejects.toThrow('Failed query: insert into "sync_items"');
      const sourceAfterFailure = await database.db.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, member.id),
        eq(syncItems.entityType, 'pantry_lot'), eq(syncItems.entityId, lot.id),
      ));
      expect(sourceAfterFailure).toHaveLength(1);
      expect(sourceAfterFailure[0]?.payload).toMatchObject({ quantity: 200 });
      await expect(database.db.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'house'), eq(syncItems.scopeId, houseId),
        eq(syncItems.entityType, 'pantry_lot'), eq(syncItems.entityId, lot.id),
      ))).resolves.toHaveLength(0);
      await expect(database.db.select().from(processedSyncMutations).where(and(
        eq(processedSyncMutations.scopeType, 'user'), eq(processedSyncMutations.scopeId, member.id),
        eq(processedSyncMutations.mutationId, pendingMutation.mutationId),
      ))).resolves.toHaveLength(0);
    } finally {
      await database.db.execute(sql`DROP TRIGGER IF EXISTS house_account_queue_test_failure ON sync_items`);
      await database.db.execute(sql`DROP FUNCTION IF EXISTS house_account_queue_test_failure()`);
    }

    await service.importPendingAccountQueue(member.id, [pendingMutation]);
    await service.importPendingAccountQueue(member.id, [pendingMutation]);
    await expect(syncRepository.readEntity(admin.id, 'pantry_lot', lot.id)).resolves.toMatchObject({
      syncScope: `house:${houseId}`, payload: expect.objectContaining({ quantity: 450 }),
    });
    await expect(database.db.select().from(syncItems).where(and(
      eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, member.id),
      eq(syncItems.entityType, 'pantry_lot'), eq(syncItems.entityId, lot.id),
    ))).resolves.toHaveLength(0);
  });

  it('imports pending account diet and colliding lot transactionally without losing House restrictions or quantity', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const now = new Date();
    const admin = await authRepository.createUser({ email: `pending-import-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `pending-import-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const created = await service.createHouse(admin.id, `Casa pending import ${suffix}`);
    await service.addMember(admin.id, member.email);
    const houseScope = `house:${created.state.house!.id}` as const;
    const timestamp = now.toISOString();
    const lot: PantryLot = {
      id: 'colliding-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 200, unit: 'g', expiresAt: '2026-10-20',
      createdAt: timestamp, updatedAt: timestamp,
    };
    await syncRepository.applyMutation(admin.id, { mutationId: randomUUID(), deviceId: 'house-device', entityType: 'pantry_lot', entityId: lot.id, operation: 'upsert', payload: lot, clientUpdatedAt: timestamp, syncScope: houseScope });
    await syncRepository.applyMutation(admin.id, {
      mutationId: randomUUID(), deviceId: 'house-device', entityType: 'diet_profile', entityId: 'profile', operation: 'upsert',
      payload: { diet: 'vegetarian', excludedAllergens: ['gluten'], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: timestamp },
      clientUpdatedAt: timestamp, syncScope: houseScope,
    });
    const pending = [
      { mutationId: randomUUID(), deviceId: 'member-device', entityType: 'pantry_lot' as const, entityId: lot.id, operation: 'upsert' as const,
        payload: { ...lot, quantity: 500, updatedAt: new Date(now.getTime() + 1000).toISOString() }, clientUpdatedAt: timestamp, syncScope: `account:${member.id}` as const },
      { mutationId: randomUUID(), deviceId: 'member-device', entityType: 'diet_profile' as const, entityId: 'profile', operation: 'upsert' as const,
        payload: { diet: 'vegan', excludedAllergens: ['milk'], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: timestamp },
        clientUpdatedAt: timestamp, syncScope: `account:${member.id}` as const },
    ];
    await service.importPendingAccountQueue(member.id, pending);
    await service.importPendingAccountQueue(member.id, pending);
    const houseRows = await syncRepository.readAll(admin.id);
    expect(houseRows.filter((row) => row.entityType === 'pantry_lot' && row.operation === 'upsert'))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 700, unit: 'g' }) })]);
    expect(houseRows).toContainEqual(expect.objectContaining({ entityType: 'diet_profile', payload: expect.objectContaining({
      diet: 'vegan', excludedAllergens: expect.arrayContaining(['gluten', 'milk']),
    }) }));
    await expect(syncRepository.readChanges(member.id, 0, 100, `account:${member.id}`))
      .resolves.not.toContainEqual(expect.objectContaining({ entityType: 'diet_profile' }));

    const other = await authRepository.createUser({ email: `pending-import-other-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    await service.addMember(admin.id, other.email);
    await service.importPendingAccountQueue(other.id, [{
      ...pending[0]!, mutationId: randomUUID(), syncScope: `account:${other.id}`,
    }]);
    const bothMembersLots = (await syncRepository.readAll(admin.id)).filter((row) => row.entityType === 'pantry_lot' && row.operation === 'upsert');
    expect(bothMembersLots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 1200, unit: 'g' }) })]);

    const revision = { ...pending[0]!, mutationId: randomUUID(), deviceId: 'member-revision-device',
      payload: { ...lot, quantity: 600, updatedAt: new Date(now.getTime() + 2000).toISOString() },
      clientUpdatedAt: new Date(now.getTime() + 2000).toISOString() };
    await service.importPendingAccountQueue(member.id, [revision]);
    const revisedLots = (await syncRepository.readAll(admin.id)).filter((row) => row.entityType === 'pantry_lot' && row.operation === 'upsert');
    expect(revisedLots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 1300, unit: 'g' }) })]);
    const deletion = { ...revision, mutationId: randomUUID(), deviceId: 'member-delete-device', operation: 'delete' as const, payload: null,
      clientUpdatedAt: new Date(now.getTime() + 3000).toISOString() };
    await service.importPendingAccountQueue(member.id, [deletion]);
    const remainingLots = (await syncRepository.readAll(admin.id)).filter((row) => row.entityType === 'pantry_lot' && row.operation === 'upsert');
    expect(remainingLots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 700, unit: 'g' }) })]);
  });

  it('does not migrate a pending account diet tombstone over an existing House profile in PostgreSQL', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const timestamp = '2026-09-24T12:00:00.000Z';
    const admin = await authRepository.createUser({ email: `diet-delete-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const member = await authRepository.createUser({ email: `diet-delete-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const state = await service.createHouse(admin.id, 'Casa con allergeni');
    await service.addMember(admin.id, member.email);
    const houseId = state.state.house!.id;
    const houseProfile = {
      diet: 'vegan' as const,
      excludedAllergens: ['milk', 'gluten'] as const,
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      updatedAt: timestamp,
    };
    await syncRepository.applyMutation(admin.id, {
      mutationId: randomUUID(), deviceId: `diet-delete-house-${suffix}`, entityType: 'diet_profile', entityId: 'profile',
      operation: 'upsert', payload: houseProfile, clientUpdatedAt: timestamp, syncScope: `house:${houseId}`,
    });
    const pendingDelete: SyncMutation = {
      mutationId: `pending-account-diet-delete-${suffix}`,
      deviceId: `diet-delete-member-${suffix}`,
      entityType: 'diet_profile', entityId: 'profile', operation: 'delete', payload: null,
      clientUpdatedAt: '2026-09-24T13:00:00.000Z', syncScope: `account:${member.id}`,
    };

    await service.importPendingAccountQueue(member.id, [pendingDelete]);
    await service.importPendingAccountQueue(member.id, [pendingDelete]);

    await expect(syncRepository.readEntity(admin.id, 'diet_profile', 'profile')).resolves.toMatchObject({
      deleted: false,
      payload: { diet: 'vegan', excludedAllergens: expect.arrayContaining(['gluten', 'milk']) },
    });
    await expect(syncRepository.readChanges(member.id, 0, 100, `account:${member.id}`))
      .resolves.not.toContainEqual(expect.objectContaining({ entityType: 'diet_profile', entityId: 'profile' }));
  });

  it('merges guest diet imports conservatively and deduplicates only the submitted revision in PostgreSQL', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const timestamp = new Date().toISOString();
    const revisedTimestamp = new Date(Date.parse(timestamp) + 1000).toISOString();
    const admin = await authRepository.createUser({ email: `guest-diet-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const member = await authRepository.createUser({ email: `guest-diet-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const state = await service.createHouse(admin.id, 'Casa con allergeni');
    await service.addMember(admin.id, member.email);
    const houseId = state.state.house!.id;
    await syncRepository.applyMutation(admin.id, {
      mutationId: randomUUID(), deviceId: `house-diet-${suffix}`, entityType: 'diet_profile', entityId: 'profile',
      operation: 'upsert', payload: {
        diet: 'vegan', excludedAllergens: ['milk', 'gluten'],
        nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 25 }, updatedAt: timestamp,
      }, clientUpdatedAt: timestamp, syncScope: `house:${houseId}`,
    });
    const guestImport: SyncMutation = {
      mutationId: `guest-diet-revision-1-${suffix}`, deviceId: `guest-device-${suffix}`,
      entityType: 'diet_profile', entityId: 'profile', operation: 'upsert', syncScope: undefined,
      payload: {
        diet: 'omnivore', excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: timestamp,
      }, clientUpdatedAt: timestamp,
    };

    await expect(syncRepository.mergeGuestDietProfileToHouse(member.id, houseId, guestImport)).resolves.toBe(true);
    await expect(syncRepository.mergeGuestDietProfileToHouse(member.id, houseId, guestImport)).resolves.toBe(false);
    await expect(syncRepository.readEntity(admin.id, 'diet_profile', 'profile')).resolves.toMatchObject({
      payload: {
        diet: 'vegan', excludedAllergens: expect.arrayContaining(['milk', 'gluten']),
        nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 25 },
      },
    });

    const revisedImport: SyncMutation = {
      ...guestImport, mutationId: `guest-diet-revision-2-${suffix}`, clientUpdatedAt: revisedTimestamp,
      payload: {
        diet: 'omnivore', excludedAllergens: ['peanuts'],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: revisedTimestamp,
      },
    };
    await expect(syncRepository.mergeGuestDietProfileToHouse(member.id, houseId, revisedImport)).resolves.toBe(true);
    await expect(syncRepository.readEntity(admin.id, 'diet_profile', 'profile')).resolves.toMatchObject({
      payload: { diet: 'vegan', excludedAllergens: expect.arrayContaining(['milk', 'gluten', 'peanuts']) },
    });
  });

  it('applies a revised guest shopping import after the processed mutation receipt in PostgreSQL', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db);
    const suffix = randomUUID();
    const user = await authRepository.createUser({ email: `guest-shopping-revision-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date() });
    const firstTimestamp = new Date().toISOString();
    const revisedTimestamp = new Date(Date.parse(firstTimestamp) + 1000).toISOString();
    const firstMutation: SyncMutation = {
      mutationId: `import:${randomUUID()}`, deviceId: `guest-device-${suffix}`, entityType: 'shopping_list_item',
      entityId: `guest-item-${suffix}`, operation: 'upsert', syncScope: `account:${user.id}`,
      payload: {
        id: `guest-item-${suffix}`, ingredientId: 'pasta', label: 'Pasta', quantity: 1000, unit: 'g',
        note: null, purchased: false, sourceRecipeId: null, createdAt: firstTimestamp, updatedAt: firstTimestamp,
      },
      clientUpdatedAt: firstTimestamp,
    };
    await syncRepository.applyMutation(user.id, firstMutation);
    const retryWithSameReceipt = await syncRepository.applyMutation(user.id, {
      ...firstMutation,
      clientUpdatedAt: revisedTimestamp,
      payload: { ...firstMutation.payload as object, quantity: 2000, updatedAt: revisedTimestamp },
    });
    expect(retryWithSameReceipt.applied).toBe(false);
    const revisedMutation = {
      ...firstMutation,
      mutationId: `import:${randomUUID()}`,
      clientUpdatedAt: revisedTimestamp,
      payload: { ...firstMutation.payload as object, quantity: 2000, updatedAt: revisedTimestamp },
    };
    const appliedRevision = await syncRepository.applyMutation(user.id, revisedMutation);

    expect(appliedRevision.applied).toBe(true);
    await expect(syncRepository.readEntity(user.id, 'shopping_list_item', firstMutation.entityId))
      .resolves.toMatchObject({ payload: { quantity: 2000 } });
  });

  it('deduplicates guest lot revisions and keeps the newer account revision in PostgreSQL', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const now = new Date('2026-09-24T12:00:00.000Z');
    const suffix = Date.now();
    const admin = await authRepository.createUser({ email: `integration-revision-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `integration-revision-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const created = await service.createHouse(admin.id, `Casa revision ${suffix}`);
    const lot = (id: string, quantity: number, updatedAt: string): PantryLot => ({
      id,
      ingredientId: 'revision-pasta',
      label: 'Revision pasta',
      known: true,
      quantity,
      unit: 'g',
      expiresAt: '2026-10-01',
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt,
    });

    await syncRepository.applyMutation(member.id, {
      mutationId: `integration-revision-account-${suffix}`,
      deviceId: `revision-device-${suffix}`,
      entityType: 'pantry_lot',
      entityId: `revision-lot-${suffix}`,
      operation: 'upsert',
      payload: lot(`revision-lot-${suffix}`, 200, '2026-09-24T10:02:00.000Z'),
      clientUpdatedAt: '2026-09-24T10:02:00.000Z',
      syncScope: `account:${member.id}`,
    });
    await service.addMember(admin.id, member.email);
    await syncRepository.mergeUserPantryToHouse(member.id, created.state.house!.id);
    await syncRepository.mergeGuestPantryToHouse(member.id, created.state.house!.id, {
      deviceId: `revision-device-${suffix}`,
      lots: [lot(`revision-lot-${suffix}`, 100, '2026-09-24T10:01:00.000Z')],
      stapleIds: [],
    });

    const duplicateLotId = `duplicate-lot-${suffix}`;
    const duplicateLot = (quantity: number, updatedAt: string): PantryLot => ({
      ...lot(duplicateLotId, quantity, updatedAt),
      ingredientId: 'duplicate-pasta',
      label: 'Duplicate pasta',
    });
    await syncRepository.mergeGuestPantryToHouse(member.id, created.state.house!.id, {
      deviceId: `duplicate-device-${suffix}`,
      lots: [duplicateLot(100, '2026-09-24T10:00:00+02:00'), duplicateLot(250, '2026-09-24T09:30:00Z')],
      stapleIds: [],
    });

    const guestFirstId = `guest-first-lot-${suffix}`;
    const guestFirstLot = (quantity: number, updatedAt: string): PantryLot => ({
      id: guestFirstId,
      ingredientId: 'guest-first-pasta',
      label: 'Guest first pasta',
      known: true,
      quantity,
      unit: 'g',
      expiresAt: '2026-10-02',
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt,
    });
    await syncRepository.mergeGuestPantryToHouse(member.id, created.state.house!.id, {
      deviceId: `guest-first-device-${suffix}`,
      lots: [guestFirstLot(100, '2026-09-24T10:05:00.000Z')],
      stapleIds: [],
    });
    await service.removeMember(admin.id, member.id);
    await syncRepository.applyMutation(member.id, {
      mutationId: `integration-guest-first-account-${suffix}`,
      deviceId: `guest-first-device-${suffix}`,
      entityType: 'pantry_lot',
      entityId: guestFirstId,
      operation: 'upsert',
      payload: guestFirstLot(200, '2026-09-24T10:06:00.000Z'),
      clientUpdatedAt: '2026-09-24T10:06:00.000Z',
      syncScope: `account:${member.id}`,
    });
    await service.addMember(admin.id, member.email);
    await syncRepository.mergeUserPantryToHouse(member.id, created.state.house!.id);

    const rekeyLotId = `rekey-lot-${suffix}`;
    const rekeyLot = (quantity: number, updatedAt: string): PantryLot => ({
      id: rekeyLotId,
      ingredientId: 'rekey-pasta',
      label: 'Rekey pasta',
      known: true,
      quantity,
      unit: 'g',
      expiresAt: '2026-10-03',
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt,
    });
    await service.removeMember(admin.id, member.id);
    await syncRepository.applyMutation(member.id, {
      mutationId: `integration-rekey-account-${suffix}`,
      deviceId: `rekey-account-device-${suffix}`,
      entityType: 'pantry_lot',
      entityId: rekeyLotId,
      operation: 'upsert',
      payload: rekeyLot(100, '2026-09-24T10:07:00.000Z'),
      clientUpdatedAt: '2026-09-24T10:07:00.000Z',
      syncScope: `account:${member.id}`,
    });
    await service.addMember(admin.id, member.email);
    await syncRepository.mergeUserPantryToHouse(member.id, created.state.house!.id);
    await syncRepository.mergeGuestPantryToHouse(member.id, created.state.house!.id, {
      deviceId: `rekey-guest-device-${suffix}`,
      lots: [rekeyLot(50, '2026-09-24T10:08:00.000Z')],
      stapleIds: [],
    });
    await syncRepository.mergeGuestPantryToHouse(member.id, created.state.house!.id, {
      deviceId: `rekey-guest-device-${suffix}`,
      lots: [rekeyLot(60, '2026-09-24T10:09:00.000Z')],
      stapleIds: [],
    });

    const rows = await syncRepository.readAll(admin.id);
    expect(rows.filter((row) => row.entityType === 'pantry_lot' && row.payload !== null)).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ id: `revision-lot-${suffix}`, quantity: 200 }) }),
      expect.objectContaining({ payload: expect.objectContaining({ id: duplicateLotId, quantity: 250 }) }),
      expect.objectContaining({ payload: expect.objectContaining({ id: guestFirstId, quantity: 200 }) }),
    ]));
    expect(rows.filter((row) => row.entityType === 'pantry_lot' && row.payload !== null
      && (row.payload as { id?: string }).id === duplicateLotId)).toHaveLength(1);
    const rekeyRows = rows.filter((row) => row.entityType === 'pantry_lot' && row.payload !== null
      && (row.payload as { ingredientId?: string }).ingredientId === 'rekey-pasta');
    expect(rekeyRows).toHaveLength(1);
    expect(rekeyRows[0]).toMatchObject({ payload: expect.objectContaining({ quantity: 160 }) });
  });

  it('orders offset timestamps by instant when importing a newer account lot into a house', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db);
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = randomUUID();
    const admin = await authRepository.createUser({
      email: `offset-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date(),
    });
    const member = await authRepository.createUser({
      email: `offset-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: new Date(),
    });
    const houseId = (await service.createHouse(admin.id, 'Offset Casa')).state.house!.id;
    const lotId = `offset-lot-${suffix}`;
    const deviceId = `offset-device-${suffix}`;
    const lot = (quantity: number, updatedAt: string): PantryLot => ({
      id: lotId, ingredientId: `offset-pasta-${suffix}`, label: 'Pasta', known: true,
      quantity, unit: 'g', expiresAt: '2026-10-01',
      createdAt: '2026-09-24T10:00:00Z', updatedAt,
    });
    await service.addMember(admin.id, member.email);
    await syncRepository.mergeGuestPantryToHouse(member.id, houseId, {
      deviceId, lots: [lot(100, '2026-09-25T00:30:00+01:00')], stapleIds: [],
    });
    await service.importPendingAccountQueue(member.id, [{
      mutationId: `offset-account-${suffix}`, deviceId,
      entityType: 'pantry_lot', entityId: lotId, operation: 'upsert',
      payload: lot(400, '2026-09-24T23:45:00Z'),
      clientUpdatedAt: '2026-09-24T23:45:00Z', syncScope: `account:${member.id}`,
    }]);

    await expect(syncRepository.readEntity(member.id, 'pantry_lot', lotId)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 400 }),
    });
  });

  it('rejects stale personal writes while a pending house migration is in flight', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const now = new Date('2026-09-24T12:00:00.000Z');
    const suffix = Date.now();
    const admin = await authRepository.createUser({ email: `integration-pending-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `integration-pending-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const created = await service.createHouse(admin.id, `Casa pending ${suffix}`);
    const lotId = `pending-lot-${suffix}`;
    const lot = (quantity: number, updatedAt: string): PantryLot => ({
      id: lotId,
      ingredientId: 'pending-pasta',
      label: 'Pending pasta',
      known: true,
      quantity,
      unit: 'g',
      expiresAt: '2026-10-01',
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt,
    });
    await syncRepository.applyMutation(member.id, {
      mutationId: `integration-pending-before-${suffix}`,
      deviceId: `pending-device-${suffix}`,
      entityType: 'pantry_lot',
      entityId: lotId,
      operation: 'upsert',
      payload: lot(100, '2026-09-24T10:01:00.000Z'),
      clientUpdatedAt: '2026-09-24T10:01:00.000Z',
      syncScope: `account:${member.id}`,
    });
    // Simulate a committed membership whose automatic migration needs a bootstrap retry.
    await houseRepository.addExistingMember({ adminUserId: admin.id, email: member.email, now: new Date() });

    await database.db.execute(sql`DROP TRIGGER IF EXISTS sync_items_test_pause_house_merge ON sync_items`);
    await database.db.execute(sql`DROP FUNCTION IF EXISTS sync_items_test_pause_house_merge()`);
    await database.db.execute(sql`
      CREATE FUNCTION sync_items_test_pause_house_merge()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF NEW.scope_type = 'house' AND NEW.entity_type = 'pantry_lot' THEN PERFORM pg_sleep(0.25); END IF;
        RETURN NEW;
      END; $$
    `);
    await database.db.execute(sql`
      CREATE TRIGGER sync_items_test_pause_house_merge
      BEFORE INSERT ON sync_items
      FOR EACH ROW EXECUTE FUNCTION sync_items_test_pause_house_merge()
    `);

    try {
      const mergePromise = syncRepository.mergeUserPantryToHouse(member.id, created.state.house!.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(syncRepository.applyMutation(member.id, {
        mutationId: `integration-pending-after-${suffix}`,
        deviceId: `pending-device-${suffix}`,
        entityType: 'pantry_lot',
        entityId: lotId,
        operation: 'upsert',
        payload: lot(250, '2026-09-24T10:02:00.000Z'),
        clientUpdatedAt: '2026-09-24T10:02:00.000Z',
        syncScope: `account:${member.id}`,
      })).rejects.toMatchObject({ code: 'sync_scope_invalid' });
      await mergePromise;
    } finally {
      await database.db.execute(sql`DROP TRIGGER IF EXISTS sync_items_test_pause_house_merge ON sync_items`);
      await database.db.execute(sql`DROP FUNCTION IF EXISTS sync_items_test_pause_house_merge()`);
    }

    await syncRepository.mergeUserPantryToHouse(member.id, created.state.house!.id);
    await expect(syncRepository.readEntity(member.id, 'pantry_lot', lotId)).resolves.toMatchObject({
      syncScope: `house:${created.state.house!.id}`,
      payload: expect.objectContaining({ quantity: 100 }),
    });
    await syncRepository.applyMutation(member.id, {
      mutationId: `integration-pending-house-after-${suffix}`,
      deviceId: `pending-device-${suffix}`, entityType: 'pantry_lot', entityId: lotId,
      operation: 'upsert', payload: lot(250, '2026-09-24T10:02:00.000Z'),
      clientUpdatedAt: '2026-09-24T10:02:00.000Z', syncScope: `house:${created.state.house!.id}`,
    });
    await expect(syncRepository.readEntity(member.id, 'pantry_lot', lotId)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 250 }),
    });
  });

  it('serializes membership removal behind an in-flight shared sync mutation', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = Date.now();
    const now = new Date('2026-09-24T13:00:00.000Z');
    const admin = await authRepository.createUser({ email: `integration-toctou-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `integration-toctou-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const created = await service.createHouse(admin.id, `Casa TOCTOU ${suffix}`);
    await service.addMember(admin.id, member.email);
    const houseId = created.state.house!.id;

    await database.db.execute(sql`DROP TRIGGER IF EXISTS sync_items_test_pause_membership_race ON processed_sync_mutations`);
    await database.db.execute(sql`DROP FUNCTION IF EXISTS sync_items_test_pause_membership_race()`);
    await database.db.execute(sql`
      CREATE FUNCTION sync_items_test_pause_membership_race()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF NEW.scope_type = 'house' THEN PERFORM pg_sleep(0.5); END IF;
        RETURN NEW;
      END; $$
    `);
    await database.db.execute(sql`
      CREATE TRIGGER sync_items_test_pause_membership_race
      BEFORE INSERT ON processed_sync_mutations
      FOR EACH ROW EXECUTE FUNCTION sync_items_test_pause_membership_race()
    `);

    try {
      const applyPromise = syncRepository.applyMutation(member.id, {
        mutationId: `toctou-mutation-${suffix}`,
        deviceId: `toctou-device-${suffix}`,
        entityType: 'pantry_item',
        entityId: `toctou-item-${suffix}`,
        operation: 'upsert',
        payload: { id: `toctou-item-${suffix}`, label: 'TOCTOU', known: true },
        clientUpdatedAt: '2026-09-24T13:01:00.000Z',
        syncScope: `house:${houseId}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      let removeFinished = false;
      const removePromise = service.removeMember(admin.id, member.id).then(() => { removeFinished = true; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(removeFinished).toBe(false);
      await expect(applyPromise).resolves.toMatchObject({ applied: true });
      await removePromise;
    } finally {
      await database.db.execute(sql`DROP TRIGGER IF EXISTS sync_items_test_pause_membership_race ON processed_sync_mutations`);
      await database.db.execute(sql`DROP FUNCTION IF EXISTS sync_items_test_pause_membership_race()`);
    }
  });

  it('rejects a read-only house scope after membership removal in PostgreSQL', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const suffix = Date.now();
    const now = new Date('2026-09-24T14:00:00.000Z');
    const admin = await authRepository.createUser({ email: `integration-read-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `integration-read-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const created = await service.createHouse(admin.id, `Casa read ${suffix}`);
    await service.addMember(admin.id, member.email);
    const houseScope = `house:${created.state.house!.id}` as const;

    await expect(syncRepository.readChanges(member.id, 0, 100, houseScope)).resolves.toEqual([]);
    await expect(service.removeMember(admin.id, member.id)).resolves.toBeUndefined();
    await expect(syncRepository.readChanges(member.id, 0, 100, houseScope))
      .rejects.toMatchObject({ code: 'house_membership_required' });
  });

  it('serializes concurrent guest merges so neither source is lost', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const now = new Date('2026-09-24T12:00:00.000Z');
    const suffix = Date.now();
    const admin = await authRepository.createUser({ email: `integration-concurrent-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `integration-concurrent-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    await service.createHouse(admin.id, `Casa concurrente ${suffix}`);
    await service.addMember(admin.id, member.email);
    const lot = (id: string, quantity: number): PantryLot => ({
      id,
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity,
      unit: 'g',
      expiresAt: '2026-10-01',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    await Promise.all([
      service.mergeGuestPantry(admin.id, { deviceId: `admin-device-${suffix}`, lots: [lot('same-lot', 100)], stapleIds: [] }),
      service.mergeGuestPantry(member.id, { deviceId: `member-device-${suffix}`, lots: [lot('same-lot', 200)], stapleIds: [] }),
    ]);

    const houseRows = await syncRepository.readAll(admin.id);
    expect(houseRows.filter((row) => row.entityType === 'pantry_lot'))
      .toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ quantity: 300, unit: 'g' }) }));
  });
  it('serializes a shared mutation with a concurrent pantry merge without losing either write', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const service = createHouseService({ repository: houseRepository, syncRepository });
    const now = new Date('2026-09-24T12:00:00.000Z');
    const suffix = Date.now();
    const admin = await authRepository.createUser({ email: `integration-mutation-race-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `integration-mutation-race-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    await service.createHouse(admin.id, `Casa mutation race ${suffix}`);
    await service.addMember(admin.id, member.email);
    const lot = (id: string, quantity: number): PantryLot => ({
      id,
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity,
      unit: 'g',
      expiresAt: '2026-10-01',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    await Promise.all([
      service.mergeGuestPantry(admin.id, { deviceId: `admin-device-${suffix}`, lots: [lot('merge-lot', 100)], stapleIds: [] }),
      syncRepository.applyMutation(member.id, {
        mutationId: `integration-mutation-race-${suffix}`,
        deviceId: `member-device-${suffix}`,
        entityType: 'pantry_lot',
        entityId: 'sync-lot',
        operation: 'upsert',
        payload: lot('sync-lot', 50),
        clientUpdatedAt: now.toISOString(),
      }),
    ]);

    const houseLots = (await syncRepository.readAll(admin.id)).flatMap((row) => {
      if (row.entityType !== 'pantry_lot' || row.payload === null || row.payload === undefined) return [];
      const quantity = (row.payload as { quantity?: unknown }).quantity;
      return typeof quantity === 'number' ? [quantity] : [];
    });
    expect(houseLots.reduce((total, quantity) => total + quantity, 0)).toBe(150);
  });

  it('does not depend on migration source files at runtime', async () => {
    const migration = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '0001_accounts_and_sync.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "users"');
  });

  it('resolves a shared mutation against membership inside PostgreSQL even when its resolver snapshot is stale', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const authRepository = createDrizzleAuthRepository(database.db);
    const houseRepository = createDrizzleHouseRepository(database.db);
    const suffix = `${Date.now()}-${randomUUID()}`;
    const now = new Date();
    const admin = await authRepository.createUser({ email: `scope-race-admin-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    const member = await authRepository.createUser({ email: `scope-race-member-${suffix}@example.com`, passwordHash: null, emailVerifiedAt: now });
    await houseRepository.createHouse({ name: `Scope race ${suffix}`, userId: admin.id, now });
    await houseRepository.addExistingMember({ adminUserId: admin.id, email: member.email, now });
    const repository = createDrizzleSyncRepository(database.db, { scopeResolver: async () => null });
    const timestamp = now.toISOString();
    const staleMutation: SyncMutation = {
      mutationId: `stale-scope-${suffix}`,
      deviceId: 'scope-race-device',
      entityType: 'cook_event',
      entityId: `event-${suffix}`,
      operation: 'upsert',
      payload: {
        id: `event-${suffix}`, recipeId: `recipe-${suffix}`, recipeTitle: 'Cena', servings: 2,
        cookedAt: timestamp, note: null, createdAt: timestamp, updatedAt: timestamp,
      },
      clientUpdatedAt: timestamp,
      syncScope: `account:${member.id}`,
    };

    await expect(repository.applyMutation(member.id, staleMutation)).rejects.toMatchObject({ code: 'sync_scope_invalid' });
    const accountRows = await database.db.select().from(syncItems).where(and(
      eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, member.id), eq(syncItems.entityType, 'cook_event'),
    ));
    expect(accountRows).toHaveLength(0);

    const internalMutation = { ...staleMutation, mutationId: `internal-scope-${suffix}`, syncScope: undefined };
    await repository.applyMutation(member.id, internalMutation);
    await expect(repository.readEntity(member.id, 'cook_event', `event-${suffix}`)).resolves.toMatchObject({
      syncScope: expect.stringMatching(/^house:/),
    });
  });

  it('bounds future client clocks and resolves equal timestamps by device id', async () => {
    if (database === null) throw new Error('Integration database is not configured');

    const user = await createDrizzleAuthRepository(database.db).createUser({
      email: `integration-clock-${Date.now()}@example.com`,
      passwordHash: 'clock-test-password-hash',
      emailVerifiedAt: new Date('2026-09-13T11:00:00.000Z'),
    });
    const serverNow = new Date('2026-09-13T12:00:00.000Z');
    const repository = createDrizzleSyncRepository(database.db, {
      clock: () => serverNow,
      logger: { warn: () => undefined },
    });
    const baseMutation = {
      deviceId: 'device-b',
      entityType: 'pantry_item' as const,
      entityId: 'clock-item',
      operation: 'upsert' as const,
      clientUpdatedAt: '2026-09-13T12:10:00.000Z',
    };

    await repository.applyMutation(user.id, {
      ...baseMutation,
      mutationId: `clock-device-b-${Date.now()}`,
      payload: { id: 'clock-item', label: 'Device B', known: true },
    });
    await repository.applyMutation(user.id, {
      ...baseMutation,
      deviceId: 'device-a',
      mutationId: `clock-device-a-${Date.now()}`,
      payload: { id: 'clock-item', label: 'Device A', known: true },
    });

    await expect(repository.readEntity(user.id, 'pantry_item', 'clock-item')).resolves.toMatchObject({
      clientUpdatedAt: serverNow,
      payload: { label: 'Device B' },
    });
  });
});
