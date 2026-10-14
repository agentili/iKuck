import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { createDrizzleAuthRepository } from '../auth/repository.js';
import { createAuthService } from '../auth/service.js';
import { createOpaqueToken, hashOpaqueToken } from '../auth/tokens.js';
import { createRedisAuthRateLimiter } from '../auth/rateLimit.js';
import { createCache } from '../cache/client.js';
import { createApp } from '../app.js';
import { createDatabase } from '../db/client.js';
import { bringConnections } from '../db/schema.js';
import { createBringService } from '../bring/service.js';
import { createDrizzleBringRepository } from '../bring/repository.js';
import { createSessionCipher } from '../bring/sessionCipher.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';
import { createDrizzleProfileRepository } from '../profile/repository.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';
import type { BringGateway, RawItems } from '../bring/gateway.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
const runIntegration = databaseUrl !== undefined && redisUrl !== undefined ? describe : describe.skip;
const appOrigin = 'http://127.0.0.1:4173';
const bringListId = '11111111-1111-4111-8111-111111111111';
const waitWithin = <T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`${label} did not resolve within ${timeoutMs}ms`)), timeoutMs);
  void promise.then((value) => {
    clearTimeout(timeout);
    resolve(value);
  }, (error: unknown) => {
    clearTimeout(timeout);
    reject(error);
  });
});
const findUnusedLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a loopback port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
};

runIntegration('PostgreSQL and Redis Bring integration', () => {
  const database = databaseUrl === undefined ? null : createDatabase(databaseUrl);
  const cache = redisUrl === undefined ? null : createCache(redisUrl, { disableOfflineQueue: true });
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

  beforeAll(async () => {
    if (database === null || cache === null) throw new Error('Integration services are not configured');
    await migrate(database.db, { migrationsFolder });
    await database.ping();
    await cache.ping();
  });

  afterAll(async () => {
    await cache?.close();
    await database?.close();
  });

  it('applies the Bring migration twice without duplicate tables', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    await migrate(database.db, { migrationsFolder });
    await migrate(database.db, { migrationsFolder });

    const tables = await database.db.execute(sql<{ table_count: number }>`
      SELECT count(*)::int AS table_count
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'bring_connections'
    `);
    const columns = await database.db.execute(sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'bring_connections'
      ORDER BY ordinal_position
    `);

    expect(tables[0]?.table_count).toBe(1);
    expect(columns.map((column) => column.column_name)).toEqual([
      'user_id',
      'connection_id',
      'encrypted_session',
      'connected_at',
    ]);
  });

  const createVerifiedUser = async (label: string) => {
    if (database === null) throw new Error('Integration database is not configured');
    return createDrizzleAuthRepository(database.db).createUser({
      email: `bring-${label}-${randomUUID()}@example.test`,
      passwordHash: null,
      emailVerifiedAt: new Date(),
    });
  };

  const makeGateway = (overrides: Partial<BringGateway> = {}) => {
    const session = { userId: `bring-user-${randomUUID()}`, accessToken: `synthetic-access-${randomUUID()}` };
    let raw: RawItems = { uuid: bringListId, status: 'REGISTERED', purchase: [], recently: [] };
    const gateway: BringGateway = {
      authenticate: vi.fn(async () => ({ ...session })),
      lists: vi.fn(async () => [{ id: raw.uuid, name: 'Lista di prova' }]),
      items: vi.fn(async () => structuredClone(raw)),
      catalog: vi.fn(async () => []),
      change: vi.fn(async (_session, input) => {
        const entry = { name: input.name, specification: input.specification };
        const purchase = raw.purchase.filter((item) => item.name !== input.name);
        const recently = raw.recently.filter((item) => item.name !== input.name);
        if (input.action === 'complete') recently.push(entry);
        else if (input.action !== 'remove') purchase.push(entry);
        raw = { ...raw, purchase, recently };
      }),
      ...overrides,
    };
    return {
      gateway,
      session,
      getRaw: () => structuredClone(raw),
      setRaw: (next: RawItems) => { raw = structuredClone(next); },
    };
  };

  const createService = (
    databaseForService: ReturnType<typeof createDatabase>,
    gateway: BringGateway,
    shoppingRepository: ReturnType<typeof createDrizzleSyncRepository> = createDrizzleSyncRepository(databaseForService.db),
  ) => createBringService({
    repository: createDrizzleBringRepository(databaseForService.db),
    cipher: createSessionCipher('11'.repeat(32)),
    gateway,
    allowedListIds: [],
    shoppingRepository,
  });

  const createAuthSession = async (databaseForAuth: ReturnType<typeof createDatabase>, label: string) => {
    const repository = createDrizzleAuthRepository(databaseForAuth.db);
    const user = await repository.createUser({
      email: `bring-session-${label}-${randomUUID()}@example.test`,
      passwordHash: null,
      emailVerifiedAt: new Date(),
    });
    const sessionToken = createOpaqueToken();
    const csrfToken = `bring-csrf-${randomUUID()}`;
    await repository.createSession({
      userId: user.id,
      tokenHash: sessionToken.hash,
      csrfTokenHash: hashOpaqueToken(csrfToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const authService = createAuthService({
      repository,
      email: { send: async () => ({ messageId: `bring-integration-${randomUUID()}` }) },
      appOrigin,
      tokenFactory: () => {
        const raw = `bring-token-${randomUUID()}`;
        return { raw, hash: hashOpaqueToken(raw) };
      },
    });
    return {
      user,
      authService,
      headers: {
        cookie: `ikuck_session=${sessionToken.raw}`,
        origin: appOrigin,
        'x-csrf-token': csrfToken,
      },
    };
  };

  const createBringApp = (
    databaseForApp: ReturnType<typeof createDatabase>,
    cacheForApp: NonNullable<typeof cache>,
    authService: ReturnType<typeof createAuthService>,
    service: ReturnType<typeof createBringService>,
  ) => createApp({
    database: databaseForApp,
    cache: cacheForApp,
    bring: {
      service,
      authService,
      appOrigin,
      rateLimiter: createRedisAuthRateLimiter(cacheForApp),
    },
  });

  const createImportApp = (
    databaseForApp: ReturnType<typeof createDatabase>,
    cacheForApp: NonNullable<typeof cache>,
    authService: ReturnType<typeof createAuthService>,
    service: ReturnType<typeof createBringService>,
    syncRepository: ReturnType<typeof createDrizzleSyncRepository>,
  ) => createApp({
    database: databaseForApp,
    cache: cacheForApp,
    shoppingList: { repository: syncRepository, authService, appOrigin },
    bring: {
      service,
      authService,
      appOrigin,
      rateLimiter: createRedisAuthRateLimiter(cacheForApp),
    },
  });

  it('stores only owner-bound encrypted session data', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const owner = await createVerifiedUser('cipher-owner');
    const other = await createVerifiedUser('cipher-other');
    const { gateway, session } = makeGateway();
    const service = createService(database, gateway);
    const email = `synthetic-bring-${randomUUID()}@example.test`;
    const password = `synthetic-password-${randomUUID()}`;

    const connected = await service.connect(owner.id, { email, password });
    const [record] = await database.db.select().from(bringConnections).where(eq(bringConnections.userId, owner.id));

    expect(record?.connectionId).toBe(connected.connectionId);
    expect(record?.encryptedSession).not.toContain(session.accessToken);
    expect(record?.encryptedSession).not.toContain(email);
    expect(record?.encryptedSession).not.toContain(password);
    expect(createSessionCipher('11'.repeat(32)).open(owner.id, record!.encryptedSession)).toBe(JSON.stringify(session));
    expect(() => createSessionCipher('11'.repeat(32)).open(other.id, record!.encryptedSession)).toThrow('Bring session cannot be decrypted');
    await expect(service.status(other.id)).resolves.toEqual({ enabled: true, connected: false, connectionId: null });
    expect(gateway.authenticate).toHaveBeenCalledTimes(1);
  });

  it('persists a connection across service recreation', async () => {
    if (database === null || databaseUrl === undefined) throw new Error('Integration database is not configured');
    const owner = await createVerifiedUser('recreated-service');
    const { gateway, session } = makeGateway();
    const connected = await createService(database, gateway).connect(owner.id, {
      email: `synthetic-bring-${randomUUID()}@example.test`,
      password: `synthetic-password-${randomUUID()}`,
    });
    const connectionId = connected.connectionId;
    if (connectionId === null) throw new Error('Bring connection was not created');
    const recreatedDatabase = createDatabase(databaseUrl, { max: 1 });

    try {
      const recreatedService = createService(recreatedDatabase, gateway);
      await expect(recreatedService.lists(owner.id, connectionId)).resolves.toEqual({
        connectionId,
        lists: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Lista di prova' }],
      });
      expect(gateway.authenticate).toHaveBeenCalledTimes(1);
      expect(gateway.lists).toHaveBeenLastCalledWith(session, expect.any(AbortSignal));
    } finally {
      await recreatedDatabase.close();
    }
  });

  it('rejects another process while a write holds the user lock', async () => {
    if (cache === null || databaseUrl === undefined) throw new Error('Integration services are not configured');
    const authDatabase = createDatabase(databaseUrl, { max: 2 });
    const firstDatabase = createDatabase(databaseUrl, { max: 1 });
    const secondDatabase = createDatabase(databaseUrl, { max: 1 });
    const { user, authService, headers } = await createAuthSession(authDatabase, 'write-lock');
    const { gateway } = makeGateway();
    let signalChange!: () => void;
    let releaseChange!: () => void;
    const changeStarted = new Promise<void>((resolve) => { signalChange = resolve; });
    const changeGate = new Promise<void>((resolve) => { releaseChange = resolve; });
    const applyChange = vi.mocked(gateway.change).getMockImplementation();
    if (applyChange === undefined) throw new Error('The fake Bring gateway change handler is missing');
    vi.mocked(gateway.change).mockImplementation(async (session, input, signal) => {
      await applyChange(session, input, signal);
      signalChange();
      await changeGate;
    });
    let appOne: ReturnType<typeof createApp> | undefined;
    let appTwo: ReturnType<typeof createApp> | undefined;
    let pendingWrite: Promise<unknown> | undefined;

    try {
      appOne = createBringApp(firstDatabase, cache, authService, createService(firstDatabase, gateway));
      appTwo = createBringApp(secondDatabase, cache, authService, createService(secondDatabase, gateway));
      const connected = await appOne.inject({
        method: 'POST',
        url: '/v1/integrations/bring/connection',
        headers,
        payload: { email: user.email, password: 'synthetic-bring-password', confirmExternalAccess: true },
      });
      expect(connected.statusCode).toBe(200);
      const connectionId = connected.json<{ connectionId: string }>().connectionId;
      expect(connectionId).toMatch(/^[0-9a-f-]{36}$/i);

      const write = appOne.inject({
        method: 'POST',
        url: '/v1/integrations/bring/items',
        headers,
        payload: { connectionId, listId: bringListId, action: 'add', name: 'Latte', specification: '1 l' },
      });
      pendingWrite = write;
      await waitWithin(changeStarted, 'gateway write under the PostgreSQL user lock');

      const busyDisconnect = await appTwo.inject({
        method: 'DELETE',
        url: '/v1/integrations/bring/connection',
        headers,
        payload: { connectionId },
      });
      expect(busyDisconnect.statusCode).toBe(409);
      expect(busyDisconnect.json()).toMatchObject({ code: 'bring_busy' });

      releaseChange();
      const confirmedWrite = await waitWithin(write, 'write confirmation after releasing the lock');
      expect(confirmedWrite.statusCode).toBe(200);
      const disconnected = await appTwo.inject({
        method: 'DELETE',
        url: '/v1/integrations/bring/connection',
        headers,
        payload: { connectionId },
      });
      expect(disconnected.statusCode).toBe(204);
      await expect(secondDatabase.db.select().from(bringConnections).where(eq(bringConnections.userId, user.id))).resolves.toHaveLength(0);

      const oldConnectionWrite = await appOne.inject({
        method: 'POST',
        url: '/v1/integrations/bring/items',
        headers,
        payload: { connectionId, listId: bringListId, action: 'add', name: 'Pane', specification: '1 kg' },
      });
      expect(oldConnectionWrite.statusCode).toBe(409);
      expect(oldConnectionWrite.json()).toMatchObject({ code: 'bring_not_connected' });
      expect(gateway.change).toHaveBeenCalledTimes(1);
    } finally {
      releaseChange();
      if (pendingWrite !== undefined) await Promise.allSettled([pendingWrite]);
      await appOne?.close();
      await appTwo?.close();
      await Promise.all([firstDatabase.close(), secondDatabase.close(), authDatabase.close()]);
    }
  });

  it('releases the connection after upstream failure', async () => {
    if (databaseUrl === undefined) throw new Error('Integration database is not configured');
    const oneConnectionDatabase = createDatabase(databaseUrl, { max: 1 });
    const owner = await createVerifiedUser('failed-upstream');
    const { gateway } = makeGateway();
    const originalItems = vi.mocked(gateway.items).getMockImplementation();
    if (originalItems === undefined) throw new Error('The fake Bring gateway items handler is missing');
    let failFirstRead = true;
    let activeGatewayCallbacks = 0;
    vi.mocked(gateway.items).mockImplementation(async (session, listId, signal) => {
      activeGatewayCallbacks += 1;
      try {
        if (failFirstRead) {
          failFirstRead = false;
          throw new Error('synthetic upstream failure');
        }
        return await originalItems(session, listId, signal);
      } finally {
        activeGatewayCallbacks -= 1;
      }
    });

    try {
      const service = createService(oneConnectionDatabase, gateway);
      const connected = await service.connect(owner.id, {
        email: `synthetic-bring-${randomUUID()}@example.test`,
        password: `synthetic-password-${randomUUID()}`,
      });
      const connectionId = connected.connectionId;
      if (connectionId === null) throw new Error('Bring connection was not created');
      const mutation = {
        connectionId,
        listId: bringListId,
        action: 'add' as const,
        name: 'Latte',
        specification: '1 l',
      };

      await expect(waitWithin(service.write(owner.id, mutation), 'upstream failure cleanup')).rejects.toMatchObject({
        code: 'bring_unavailable',
        status: 503,
      });
      expect(activeGatewayCallbacks).toBe(0);
      await expect(waitWithin(oneConnectionDatabase.db.execute(sql`SELECT 1 AS pool_available`), 'single-connection pool query'))
        .resolves.toBeDefined();
      await expect(waitWithin(service.read(owner.id, connectionId, bringListId), 'operation after upstream failure'))
        .resolves.toMatchObject({ connectionId, listId: bringListId, items: [] });
      expect(activeGatewayCallbacks).toBe(0);
    } finally {
      await oneConnectionDatabase.close();
    }
  });

  it('cascades the connection on account deletion without deleting Bring items', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const owner = await createVerifiedUser('account-delete');
    const remote = makeGateway();
    const remoteItem = { name: `Remote item ${randomUUID()}`, specification: '1 confezione' };
    remote.setRaw({
      uuid: bringListId,
      status: 'REGISTERED',
      purchase: [remoteItem],
      recently: [],
    });
    const service = createService(database, remote.gateway);
    await service.connect(owner.id, {
      email: `synthetic-bring-${randomUUID()}@example.test`,
      password: `synthetic-password-${randomUUID()}`,
    });
    const remoteItemsBeforeDeletion = remote.getRaw();
    const authRepository = createDrizzleAuthRepository(database.db);
    const profileRepository = createDrizzleProfileRepository(database.db, createDrizzleSyncRepository(database.db));

    await profileRepository.deleteAccount(owner.id);

    await expect(database.db.select().from(bringConnections).where(eq(bringConnections.userId, owner.id)))
      .resolves.toHaveLength(0);
    await expect(authRepository.findUserById(owner.id)).resolves.toBeNull();
    expect(remote.gateway.change).not.toHaveBeenCalled();
    expect(remote.getRaw()).toEqual(remoteItemsBeforeDeletion);
  });

  it('never exports Bring credentials through profile or sync', async () => {
    if (database === null || cache === null) throw new Error('Integration services are not configured');
    const { user, authService, headers } = await createAuthSession(database, 'export-sync');
    const { gateway, session } = makeGateway();
    const service = createService(database, gateway);
    const bringEmail = `synthetic-bring-${randomUUID()}@example.test`;
    const bringPassword = `synthetic-password-${randomUUID()}`;
    const connected = await service.connect(user.id, { email: bringEmail, password: bringPassword });
    const connectionId = connected.connectionId;
    if (connectionId === null) throw new Error('Bring connection was not created');
    const [storedConnection] = await database.db.select().from(bringConnections).where(eq(bringConnections.userId, user.id));
    if (storedConnection === undefined) throw new Error('Bring connection was not persisted');
    const syncRepository = createDrizzleSyncRepository(database.db);
    const app = createApp({
      database,
      cache,
      profile: {
        repository: createDrizzleProfileRepository(database.db, syncRepository),
        authService,
        appOrigin,
        secureCookies: false,
      },
      sync: { repository: syncRepository, authService, appOrigin },
      bring: {
        service,
        authService,
        appOrigin,
        rateLimiter: createRedisAuthRateLimiter(cache),
      },
    });

    try {
      const exportResponse = await app.inject({ method: 'GET', url: '/v1/profile/export', headers });
      const syncResponse = await app.inject({
        method: 'POST',
        url: '/v1/sync',
        headers,
        payload: { deviceId: `bring-sync-${randomUUID()}`, cursor: 0, syncScope: `account:${user.id}`, mutations: [] },
      });
      expect(exportResponse.statusCode).toBe(200);
      expect(syncResponse.statusCode).toBe(200);
      expect(syncResponse.json()).toMatchObject({ changes: [] });
      const output = JSON.stringify({ export: exportResponse.json(), sync: syncResponse.json() });
      for (const secret of [bringEmail, bringPassword, session.accessToken, storedConnection.encryptedSession]) {
        expect(output).not.toContain(secret);
      }
      expect(output).not.toMatch(/"(?:encryptedSession|accessToken|refreshToken|bringPassword)"/);
    } finally {
      await app.close();
    }
  });

  it('fails closed when Redis cannot enforce a Bring limit', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const { user, authService, headers } = await createAuthSession(database, 'redis-outage');
    const { gateway } = makeGateway();
    const service = createService(database, gateway);
    const connected = await service.connect(user.id, {
      email: `synthetic-bring-${randomUUID()}@example.test`,
      password: `synthetic-password-${randomUUID()}`,
    });
    const connectionId = connected.connectionId;
    if (connectionId === null) throw new Error('Bring connection was not created');
    const callsBefore = {
      authenticate: vi.mocked(gateway.authenticate).mock.calls.length,
      lists: vi.mocked(gateway.lists).mock.calls.length,
      items: vi.mocked(gateway.items).mock.calls.length,
      catalog: vi.mocked(gateway.catalog).mock.calls.length,
      change: vi.mocked(gateway.change).mock.calls.length,
    };
    const unavailablePort = await findUnusedLoopbackPort();
    const unavailableCache = createCache(`redis://127.0.0.1:${unavailablePort}`, {
      disableOfflineQueue: true,
      connectOnCreate: true,
      reconnectOnDemand: true,
    });
    const app = createBringApp(database, unavailableCache, authService, service);

    try {
      const response = await waitWithin(app.inject({
        method: 'GET',
        url: `/v1/integrations/bring/lists?connectionId=${encodeURIComponent(connectionId)}`,
        headers,
      }), 'fail-closed Redis rate limit', 5_000);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'rate_limit_unavailable' });
      expect({
        authenticate: vi.mocked(gateway.authenticate).mock.calls.length,
        lists: vi.mocked(gateway.lists).mock.calls.length,
        items: vi.mocked(gateway.items).mock.calls.length,
        catalog: vi.mocked(gateway.catalog).mock.calls.length,
        change: vi.mocked(gateway.change).mock.calls.length,
      }).toEqual(callsBefore);
    } finally {
      await app.close();
      await unavailableCache.close();
    }
  }, 10_000);

  it('imports the purchase articles of a connected list into the iKuck shopping list exactly once', async () => {
    if (database === null || cache === null) throw new Error('Integration services are not configured');
    const { user, authService, headers } = await createAuthSession(database, 'import-once');
    const remote = makeGateway({
      catalog: vi.fn(async () => [{ itemId: 'Milch', name: 'Latte' }]),
    });
    remote.setRaw({
      uuid: bringListId,
      status: 'REGISTERED',
      purchase: [
        { name: 'Milch', specification: '2 l bio' },
        { name: 'custom-item', specification: 'nota' },
      ],
      recently: [{ name: 'Yogurt', specification: '2' }],
    });
    const syncRepository = createDrizzleSyncRepository(database.db);
    const app = createImportApp(database, cache, authService, createService(database, remote.gateway, syncRepository), syncRepository);

    try {
      const connected = await app.inject({
        method: 'POST',
        url: '/v1/integrations/bring/connection',
        headers,
        payload: { email: user.email, password: 'synthetic-bring-password', confirmExternalAccess: true },
      });
      expect(connected.statusCode).toBe(200);
      const connectionId = connected.json<{ connectionId: string }>().connectionId;

      const imported = await app.inject({
        method: 'POST',
        url: '/v1/integrations/bring/import',
        headers,
        payload: { connectionId, listId: bringListId },
      });
      expect(imported.statusCode).toBe(200);
      expect(imported.json()).toEqual({ imported: 2, skipped: 0, recently: 1 });

      const listed = await app.inject({ method: 'GET', url: '/v1/shopping-list', headers });
      expect(listed.statusCode).toBe(200);
      const items = listed.json<{ items: { label: string; note: string | null; ingredientId: string; quantity: number | null; unit: string | null; purchased: boolean; sourceRecipeId: string | null }[] }>().items;
      expect(items).toHaveLength(2);
      expect(items.map((item) => item.label)).toEqual(['Latte', 'custom-item']);
      expect(items[0]).toMatchObject({
        ingredientId: 'custom:latte',
        note: '2 l bio',
        quantity: null,
        unit: null,
        purchased: false,
        sourceRecipeId: null,
      });

      const repeated = await app.inject({
        method: 'POST',
        url: '/v1/integrations/bring/import',
        headers,
        payload: { connectionId, listId: bringListId },
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toEqual({ imported: 0, skipped: 2, recently: 1 });
      const afterRepeat = await app.inject({ method: 'GET', url: '/v1/shopping-list', headers });
      expect(afterRepeat.json<{ items: unknown[] }>().items).toHaveLength(2);
      expect(remote.gateway.change).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('imports into the shared house scope so every member reads the copied articles', async () => {
    if (database === null || cache === null) throw new Error('Integration services are not configured');
    const admin = await createAuthSession(database, 'import-house-admin');
    const member = await createAuthSession(database, 'import-house-member');
    const houseRepository = createDrizzleHouseRepository(database.db);
    const syncRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership === null ? null : { kind: 'house', id: membership.houseId };
      },
    });
    const houseService = createHouseService({ repository: houseRepository, syncRepository });
    await houseService.createHouse(admin.user.id, 'Casa import');
    await houseRepository.addExistingMember({ adminUserId: admin.user.id, email: member.user.email, now: new Date() });
    const remote = makeGateway();
    remote.setRaw({
      uuid: bringListId,
      status: 'REGISTERED',
      purchase: [{ name: 'Pane', specification: '1 kg' }],
      recently: [],
    });
    const app = createImportApp(database, cache, admin.authService, createService(database, remote.gateway, syncRepository), syncRepository);

    try {
      const connected = await app.inject({
        method: 'POST',
        url: '/v1/integrations/bring/connection',
        headers: admin.headers,
        payload: { email: admin.user.email, password: 'synthetic-bring-password', confirmExternalAccess: true },
      });
      expect(connected.statusCode).toBe(200);
      const connectionId = connected.json<{ connectionId: string }>().connectionId;

      const imported = await app.inject({
        method: 'POST',
        url: '/v1/integrations/bring/import',
        headers: admin.headers,
        payload: { connectionId, listId: bringListId },
      });
      expect(imported.statusCode).toBe(200);
      expect(imported.json()).toEqual({ imported: 1, skipped: 0, recently: 0 });

      const memberList = await app.inject({ method: 'GET', url: '/v1/shopping-list', headers: member.headers });
      expect(memberList.statusCode).toBe(200);
      expect(memberList.json<{ items: { label: string; note: string | null }[] }>().items)
        .toMatchObject([{ label: 'Pane', note: '1 kg' }]);
    } finally {
      await app.close();
    }
  });
});
