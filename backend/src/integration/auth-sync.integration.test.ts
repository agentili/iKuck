import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import { createDrizzleAuthRepository } from '../auth/repository.js';
import { createCache } from '../cache/client.js';
import { createDatabase } from '../db/client.js';
import { houseMemberships, houses, syncItems, users } from '../db/schema.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';
import { createDrizzleProfileRepository } from '../profile/repository.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';
import type { PantryLot, SyncMutation } from '@ikuck/shared/contracts';
import { hashOpaqueToken, createOpaqueToken } from '../auth/tokens.js';
import { createRedisGenerationRateLimiter } from '../ai/rateLimit.js';
import type { RecipeGenerationProvider } from '../providers/types.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
const runIntegration = databaseUrl !== undefined && redisUrl !== undefined ? describe : describe.skip;
const appOrigin = 'http://127.0.0.1:4173';

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
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cache?.close();
    await database?.close();
  });

  it('enforces diary sharing and ownership in PostgreSQL without migrating private history', async () => {
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
    const timestamp = new Date().toISOString();
    const entry = {
      id: 'shared-entry', date: timestamp.slice(0, 10), text: 'Pasta con zucchine', servings: 2, note: null, recipes: [],
      authorId: 'forged-author', createdAt: timestamp, updatedAt: timestamp,
    };
    const createEntry = mutation(ownerId, 'dinner_entry', entry.id, entry);
    const created = await repository.applyMutation(ownerId, createEntry);
    expect(created.change?.payload).toMatchObject({ id: entry.id, authorId: ownerId });
    await expect(repository.readEntity(memberId, 'dinner_entry', entry.id)).resolves.toMatchObject({ payload: { text: entry.text, authorId: ownerId } });
    await expect(repository.readEntity(outsiderId, 'dinner_entry', entry.id)).resolves.toBeNull();
    await expect(repository.applyMutation(memberId, mutation(memberId, 'dinner_entry', entry.id, { ...entry, text: 'Hijack', authorId: memberId })))
      .rejects.toMatchObject({ code: 'sync_permission_denied', status: 403 });
    await expect(repository.applyMutation(memberId, mutation(memberId, 'dinner_entry', entry.id, null, 'delete')))
      .rejects.toMatchObject({ code: 'sync_permission_denied', status: 403 });

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

    const privateEntryId = 'pre-house-entry';
    await repository.applyMutation(ownerId, mutation(ownerId, 'dinner_entry', privateEntryId, { ...entry, id: privateEntryId, text: 'Diario privato', authorId: null }, 'upsert', `account:${ownerId}`));
    await repository.migrateUserSharedDataToHouse(ownerId, houseId);
    await expect(repository.readEntity(ownerId, 'dinner_entry', privateEntryId)).resolves.toMatchObject({ syncScope: `account:${ownerId}`, payload: { text: 'Diario privato', authorId: ownerId } });
    await expect(repository.readEntity(memberId, 'dinner_entry', privateEntryId)).resolves.toBeNull();
    const memberChanges = await repository.readAll(memberId);
    expect(memberChanges.some((change) => change.entityId === privateEntryId)).toBe(false);

    const authorDelete = await repository.applyMutation(ownerId, mutation(ownerId, 'dinner_entry', entry.id, null, 'delete'));
    expect(authorDelete.change).toMatchObject({ operation: 'delete', payload: null });
    await expect(repository.applyMutation(memberId, mutation(memberId, 'dinner_entry', entry.id, { ...entry, authorId: memberId })))
      .rejects.toMatchObject({ code: 'sync_permission_denied', status: 403 });
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

    const forbidden = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${houseEntryId}/confirm-recipe`, headers: member.headers,
      payload: { draft: { ...recipeDraft, draftId: 'house-route-draft-member', title: 'Ricetta non autorizzata' } },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'sync_permission_denied' });
    const notFound = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${houseEntryId}/confirm-recipe`, headers: outsider.headers,
      payload: { draft: { ...recipeDraft, draftId: 'house-route-draft-outsider' } },
    });
    expect(notFound.statusCode).toBe(404);

    const privateEntryId = `private-dinner-${randomUUID()}`;
    await repository.applyMutation(owner.user.id, {
      mutationId: randomUUID(), deviceId: 'integration-private-dinner', entityType: 'dinner_entry',
      entityId: privateEntryId, operation: 'upsert', payload: dinner(privateEntryId, 'Cena personale precedente'),
      clientUpdatedAt: now, syncScope: `account:${owner.user.id}`,
    });
    const privateConfirmed = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${privateEntryId}/confirm-recipe`, headers: owner.headers,
      payload: { draft: { ...recipeDraft, draftId: 'private-route-draft-owner' } },
    });
    expect(privateConfirmed.statusCode).toBe(200);
    const privateRecipeId = privateConfirmed.json().recipe.id as string;
    await expect(repository.readEntity(member.user.id, 'dinner_entry', privateEntryId)).resolves.toBeNull();
    await expect(repository.readEntity(member.user.id, 'saved_recipe', privateRecipeId)).resolves.toBeNull();
    const privateAccess = await app.inject({
      method: 'POST', url: `/v1/dinner-entries/${privateEntryId}/confirm-recipe`, headers: member.headers,
      payload: { draft: { ...recipeDraft, draftId: 'private-route-draft-member' } },
    });
    expect(privateAccess.statusCode).toBe(404);
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
          },
          {
            mutationId: 'integration-preference-mutation', deviceId: 'device-1', entityType: 'recipe_preference',
            entityId: preference.recipeId, operation: 'upsert', payload: preference, clientUpdatedAt: preference.updatedAt,
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

    const aiConsent = await app.inject({
      method: 'PUT',
      url: '/v1/ai-recipes/consent',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
      payload: { enabled: true },
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
    await service.addMember(admin.id, member.email);
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

  it('preserves a personal source edit committed while a database merge is pending', async () => {
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
    await service.addMember(admin.id, member.email);
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
      await syncRepository.applyMutation(member.id, {
        mutationId: `integration-pending-after-${suffix}`,
        deviceId: `pending-device-${suffix}`,
        entityType: 'pantry_lot',
        entityId: lotId,
        operation: 'upsert',
        payload: lot(250, '2026-09-24T10:02:00.000Z'),
        clientUpdatedAt: '2026-09-24T10:02:00.000Z',
        syncScope: `account:${member.id}`,
      });
      await mergePromise;
    } finally {
      await database.db.execute(sql`DROP TRIGGER IF EXISTS sync_items_test_pause_house_merge ON sync_items`);
      await database.db.execute(sql`DROP FUNCTION IF EXISTS sync_items_test_pause_house_merge()`);
    }

    await syncRepository.mergeUserPantryToHouse(member.id, created.state.house!.id);
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
