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
import { createDrizzleProfileRepository } from '../profile/repository.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';
import { hashOpaqueToken } from '../auth/tokens.js';
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
        const raw = `integration-token-${tokenNumber += 1}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
        return { raw, hash: hashOpaqueToken(raw) };
      },
    });
    const sync = createDrizzleSyncRepository(database.db);
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
      pantryLots: { repository: sync, authService: auth, appOrigin },
      shoppingList: { repository: sync, authService: auth, appOrigin },
      activity: { repository: sync, authService: auth, appOrigin },
      recipePreferences: { repository: sync, authService: auth, appOrigin },
      dietProfile: { repository: sync, authService: auth, appOrigin },
      aiRecipes: {
        provider: recipeProvider,
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
        .rejects.toThrow('profile insert failed');
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
      })).rejects.toThrow('identity insert failed');
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
      method: 'GET',
      url: `/v1/auth/verify-email?token=${decodeURIComponent(tokenMatch![1])}`,
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
      payload: { id: 'rollback-item', label: 'Rollback' },
      clientUpdatedAt: 'not-a-date',
    })).rejects.toThrow();
    await expect(rollbackRepository.applyMutation(loginBody.user.id, {
      mutationId: rollbackMutationId,
      deviceId: 'device-rollback',
      entityType: 'pantry_item',
      entityId: 'rollback-item',
      operation: 'upsert',
      payload: { id: 'rollback-item', label: 'Recovered' },
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
      method: 'GET',
      url: `/v1/auth/verify-email?token=${decodeURIComponent(tokenMatch![1])}`,
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
    expect(beforeMidnight).toMatchObject({ used: 1, remaining: 4, allowed: true });
    const nextDayLimiter = createRedisGenerationRateLimiter({
      incrementWithExpiry: cache.incrementWithExpiry,
      clock: () => new Date('2026-09-14T00:01:00.000Z'),
    });
    const afterMidnight = await nextDayLimiter.consume(quotaUser);
    expect(afterMidnight).toMatchObject({ used: 1, remaining: 4, allowed: true });

    await migrate(database.db, {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'),
    });
  });

  it('does not depend on migration source files at runtime', async () => {
    const migration = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '0001_accounts_and_sync.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "users"');
  });
});
