import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import { createDrizzleAuthRepository } from '../auth/repository.js';
import { createCache } from '../cache/client.js';
import { createDatabase } from '../db/client.js';
import { createDrizzleProfileRepository } from '../profile/repository.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';
import { hashOpaqueToken } from '../auth/tokens.js';

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
    app = createApp({
      database,
      cache,
      auth: { service: auth, appOrigin, secureCookies: false },
      profile: { repository: profile, authService: auth, appOrigin, secureCookies: false },
      sync: { repository: sync, authService: auth, appOrigin },
      pantryLots: { repository: sync, authService: auth, appOrigin },
      shoppingList: { repository: sync, authService: auth, appOrigin },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cache?.close();
    await database?.close();
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

    const exported = await app.inject({ method: 'GET', url: '/v1/profile/export', headers: { cookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain('integration password 123');
    expect(exported.body).not.toContain(loginBody.csrfToken);
    expect(exported.json<{ account: { id: string } }>().account.id).toBe(loginBody.user.id);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/v1/profile',
      headers: { origin: appOrigin, cookie, 'x-csrf-token': loginBody.csrfToken },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('does not depend on migration source files at runtime', async () => {
    const migration = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '0001_accounts_and_sync.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "users"');
  });
});
