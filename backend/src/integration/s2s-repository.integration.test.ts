import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, createRecoveringDatabaseWithFactory } from '../db/client.js';
import { createApp } from '../app.js';
import { createS2sDinnerContextService } from '../s2s/dinnerContext.js';
import { houseMemberships, houses, s2sServiceCredentials, s2sServiceGrants, syncItems, users } from '../db/schema.js';
import * as schema from '../db/schema.js';
import { createDrizzleS2sRepository } from '../s2s/repository.js';
import { executeS2sAdmin } from '../s2s/adminCli.js';
import { S2S_SERVICE_ID } from '../s2s/constants.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createDrizzleProfileRepository } from '../profile/repository.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';


const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('S2S PostgreSQL repository integration', () => {
  const database = createDatabase(databaseUrl!);
  beforeAll(async () => migrate(database.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations') }));
  afterAll(async () => database.close());

  const fixture = async (role = 'admin', grantExpiry = new Date(Date.now() + 7 * 86400_000)) => {
    const userId = randomUUID(), houseId = randomUUID(), membershipId = randomUUID();
    const keyId = `integration_${randomUUID()}`, secret = randomUUID() + randomUUID(), now = new Date();
    await database.db.insert(users).values({ id: userId, email: `${userId}@example.test`, emailVerifiedAt: now });
    await database.db.insert(houses).values({ id: houseId, name: 'S2S fixture', createdByUserId: userId });
    await database.db.insert(houseMemberships).values({ id: membershipId, houseId, userId, role });
    const [grant] = await database.db.insert(s2sServiceGrants).values({ serviceId: S2S_SERVICE_ID, houseId, sponsorUserId: userId, sponsorMembershipId: membershipId, scope: 'dinner-context:read', expiresAt: grantExpiry }).returning();
    await database.db.insert(s2sServiceCredentials).values({ keyId, grantId: grant.id, secretDigest: createHash('sha256').update(secret).digest('hex'), expiresAt: grantExpiry });
    return { userId, houseId, membershipId, keyId, secret, grantId: grant.id };
  };
  const addSecondAdmin = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const userId = randomUUID();
    await database.db.insert(users).values({ id: userId, email: `${userId}@example.test`, emailVerifiedAt: new Date() });
    await database.db.insert(houseMemberships).values({ id: randomUUID(), houseId: f.houseId, userId, role: 'admin' });
    return userId;
  };

  const requestableGrant = async () => {
    const userId = randomUUID(), houseId = randomUUID(), membershipId = randomUUID();
    const now = new Date();
    await database.db.insert(users).values({ id: userId, email: `${userId}@example.test`, emailVerifiedAt: now });
    await database.db.insert(houses).values({ id: houseId, name: 'S2S HTTP fixture', createdByUserId: userId });
    await database.db.insert(houseMemberships).values({ id: membershipId, houseId, userId, role: 'admin' });
    const keyId = randomBytes(18).toString('base64url'), secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60_000);
    const repository = createDrizzleS2sRepository(database.db);
    const grant = await repository.createGrant({ serviceId: S2S_SERVICE_ID, houseId, sponsorUserId: userId, sponsorMembershipId: membershipId, expiresAt, keyId, secret, credentialExpiresAt: expiresAt });
    return { repository, keyId, secret, houseId, userId, membershipId, grantId: grant.id };
  };
  const requestDinnerContext = async (repository: ReturnType<typeof createDrizzleS2sRepository>, keyId: string, secret: string) => {
    const source = { readAuthorizedSnapshot: async (token: string, options?: { signal: AbortSignal; timeoutMs: number }) => {
      const [credentialKeyId, credentialSecret] = token.split('.');
      if (!credentialKeyId || !credentialSecret) return null;
      const snapshot = await repository.readAuthorizedSnapshot({ keyId: credentialKeyId, secret: credentialSecret }, options);
      return { ...snapshot, grant: { ...snapshot.grant, digest: '', enabled: true } };
    } };
    const service = createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async () => true } });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service });
    try {
      return await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: `Bearer ${keyId}.${secret}` } });
    } finally {
      await app.close();
    }
  };
  type S2sFixture = Awaited<ReturnType<typeof fixture>>;
  const runReadMutationRace = async (
    f: S2sFixture,
    mutate: (writerDb: ReturnType<typeof createDatabase>['db']) => Promise<unknown>,
  ) => {
    const readerApp = `s2s-reader-${randomUUID()}`;
    const writerApp = `s2s-writer-${randomUUID()}`;
    const readerClient = postgres(databaseUrl!, { max: 1, connection: { application_name: readerApp } });
    const writerClient = postgres(databaseUrl!, { max: 1, connection: { application_name: writerApp } });
    const readerDb = drizzle(readerClient, { schema });
    const writerDb = drizzle(writerClient, { schema });
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const reader = createDrizzleS2sRepository(readerDb, { afterAuthorization: async () => { signalRead(); await readGate; } });
    let mutation: Promise<unknown> | undefined;

    try {
      const snapshotPromise = reader.readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret });
      await readEntered;
      mutation = mutate(writerDb);
      let waitingForSnapshotLock = false;
      const lockDeadline = Date.now() + 3000;
      while (!waitingForSnapshotLock && Date.now() < lockDeadline) {
        const [state] = await database.db.execute(sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${writerApp} AND state='active' AND wait_event_type='Lock') AS waiting`);
        waitingForSnapshotLock = state?.waiting === true;
        if (!waitingForSnapshotLock) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!waitingForSnapshotLock) throw new Error('s2s_revocation_did_not_wait_for_read_lock');
      releaseRead();
      const [snapshot, result] = await Promise.all([snapshotPromise, mutation]);
      return { snapshot, result };
    } finally {
      releaseRead();
      await mutation?.catch(() => undefined);
      await Promise.all([readerClient.end({ timeout: 5 }), writerClient.end({ timeout: 5 })]);
    }
  };

  it('retains an unknown CLI credential and rolls back writes after the reserved admin connection rejects ROLLBACK', async () => {
    const userId = randomUUID(), houseId = randomUUID(), membershipId = randomUUID();
    const now = new Date();
    await database.db.insert(users).values({ id: userId, email: `${userId}@example.test`, emailVerifiedAt: now });
    await database.db.insert(houses).values({ id: houseId, name: 'S2S rollback fixture', createdByUserId: userId });
    await database.db.insert(houseMemberships).values({ id: membershipId, houseId, userId, role: 'admin' });

    const directory = await mkdtemp(join(tmpdir(), 'ikuck-s2s-rollback-'));
    const path = join(directory, 'credential.json');
    const operationError = new Error('injected failure after credential writes');
    const rollbackError = new Error('injected reserved-client ROLLBACK rejection');
    const poolEndCalls: Array<{ timeout: number }> = [];
    let released = 0;
    let grantInsertAttempted = false;
    let credentialInsertAttempted = false;
    const client = postgres(databaseUrl!, { max: 1, idle_timeout: 20, connection: { application_name: `s2s-admin-rollback-${randomUUID()}` } });
    const adminClient = {
      options: client.options,
      reserve: async () => {
        const connection = await client.reserve();
        return {
          unsafe: (query: string, params: unknown[] = []) => {
            const normalized = query.trim().toLowerCase();
            if (normalized === 'rollback') return Promise.reject(rollbackError);
            if (normalized.includes('insert into "s2s_service_grants"')) grantInsertAttempted = true;
            if (normalized.includes('insert into "s2s_service_credentials"')) credentialInsertAttempted = true;
            return connection.unsafe(query, params as never[]);
          },
          release: () => { released += 1; connection.release(); },
        };
      },
      end: (options: { timeout: number }) => {
        poolEndCalls.push(options);
        return client.end(options);
      },
    };
    const repository = createDrizzleS2sRepository({ dialect: new PgDialect(), $client: adminClient }, {
      afterCredentialWrite: () => { throw operationError; },
    });
    const output = { stdout: '', stderr: '' };
    try {
      let failure: unknown;
      try {
        await executeS2sAdmin([
          'provision', '--service', S2S_SERVICE_ID, '--house', houseId,
          '--sponsor-user', userId, '--sponsor-membership', membershipId, '--out', path,
        ], {
          repository,
          output: { stdout: (text) => { output.stdout += text; }, stderr: (text) => { output.stderr += text; } },
        });
      } catch (error) {
        failure = error;
      }

      expect(grantInsertAttempted).toBe(true);
      expect(credentialInsertAttempted).toBe(true);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([operationError, rollbackError]);
      const saved = JSON.parse(await readFile(path, 'utf8')) as { keyId: string; token: string; outcome: string };
      expect(saved).toMatchObject({ outcome: 'unknown' });
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(poolEndCalls).toEqual([{ timeout: 0 }]);
      expect(released).toBe(0);

      const verificationClient = postgres(databaseUrl!, { max: 1, idle_timeout: 20 });
      try {
        const grants = await verificationClient.unsafe('SELECT id FROM s2s_service_grants WHERE sponsor_membership_id=$1', [membershipId]);
        const credentials = await verificationClient.unsafe('SELECT key_id FROM s2s_service_credentials WHERE key_id=$1', [saved.keyId]);
        expect(grants).toHaveLength(0);
        expect(credentials).toHaveLength(0);
      } finally {
        await verificationClient.end({ timeout: 5 });
      }
      expect(output.stdout + output.stderr).not.toContain(saved.token);
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  it('provisions the CLI service through createGrant and the migrated PostgreSQL constraint', async () => {
    const userId = randomUUID(), houseId = randomUUID(), membershipId = randomUUID();
    const now = Date.now();
    await database.db.insert(users).values({ id: userId, email: `${userId}@example.test`, emailVerifiedAt: new Date(now) });
    await database.db.insert(houses).values({ id: houseId, name: 'S2S CLI fixture', createdByUserId: userId });
    await database.db.insert(houseMemberships).values({ id: membershipId, houseId, userId, role: 'admin' });

    const directory = await mkdtemp(join(tmpdir(), 'ikuck-s2s-cli-'));
    const path = join(directory, 'credential.json');
    const output = { stdout: '', stderr: '' };
    try {
      await expect(executeS2sAdmin([
        'provision', '--service', S2S_SERVICE_ID, '--house', houseId,
        '--sponsor-user', userId, '--sponsor-membership', membershipId, '--out', path,
      ], {
        repository: createDrizzleS2sRepository(database.db),
        output: { stdout: (text) => { output.stdout += text; }, stderr: (text) => { output.stderr += text; } },
        now: () => now,
      })).resolves.toBe(0);

      const credential = JSON.parse(await readFile(path, 'utf8')) as { keyId: string; token: string; grantId: string; outcome: string };
      const [grant] = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, credential.grantId));
      const [storedCredential] = await database.db.select().from(s2sServiceCredentials).where(eq(s2sServiceCredentials.keyId, credential.keyId));
      expect(grant).toMatchObject({ serviceId: S2S_SERVICE_ID, houseId, sponsorUserId: userId, sponsorMembershipId: membershipId, scope: 'dinner-context:read' });
      expect(storedCredential?.grantId).toBe(credential.grantId);
      expect(storedCredential?.secretDigest).toBe(createHash('sha256').update(credential.token.split('.')[1]!).digest('hex'));
      expect(credential.outcome).toBe('active');
      expect(output.stdout).toContain(credential.grantId);
      expect(output.stdout + output.stderr).not.toContain(credential.token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the provisioned grantId for the real CLI rotate and revoke lifecycle', async () => {
    const userId = randomUUID(), houseId = randomUUID(), membershipId = randomUUID();
    const now = Date.now();
    await database.db.insert(users).values({ id: userId, email: `${userId}@example.test`, emailVerifiedAt: new Date(now) });
    await database.db.insert(houses).values({ id: houseId, name: 'S2S lifecycle fixture', createdByUserId: userId });
    await database.db.insert(houseMemberships).values({ id: membershipId, houseId, userId, role: 'admin' });

    const directory = await mkdtemp(join(tmpdir(), 'ikuck-s2s-lifecycle-'));
    const provisionPath = join(directory, 'provision.json');
    const rotatePath = join(directory, 'rotate.json');
    const repository = createDrizzleS2sRepository(database.db);
    const output = { stdout: '', stderr: '' };
    const deps = { repository, output: { stdout: (text: string) => { output.stdout += text; }, stderr: (text: string) => { output.stderr += text; } }, now: () => now };
    try {
      await executeS2sAdmin([
        'provision', '--service', S2S_SERVICE_ID, '--house', houseId,
        '--sponsor-user', userId, '--sponsor-membership', membershipId, '--out', provisionPath,
      ], deps);
      const provisioned = JSON.parse(await readFile(provisionPath, 'utf8')) as { grantId: string; keyId: string; token: string };
      expect(provisioned.grantId).toMatch(/^[0-9a-f-]{36}$/i);

      await executeS2sAdmin(['rotate', '--grant', provisioned.grantId, '--expires-in-days', '30', '--out', rotatePath], deps);
      const rotated = JSON.parse(await readFile(rotatePath, 'utf8')) as { grantId: string; keyId: string; token: string };
      expect(rotated.grantId).toBe(provisioned.grantId);

      await executeS2sAdmin(['revoke', '--grant', provisioned.grantId], deps);
      const [grant] = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, provisioned.grantId));
      const credentials = await database.db.select().from(s2sServiceCredentials).where(eq(s2sServiceCredentials.grantId, provisioned.grantId));
      expect(grant?.revokedAt).not.toBeNull();
      expect(credentials).toHaveLength(2);
      expect(credentials.every((credential) => credential.revokedAt !== null)).toBe(true);
      expect(output.stdout).toContain(provisioned.grantId);
      expect(output.stdout + output.stderr).not.toContain(provisioned.token);
      expect(output.stdout + output.stderr).not.toContain(rotated.token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('re-provisions a revoked sponsor membership with a fresh grant and a 90-day expiry cap', async () => {
    const userId = randomUUID(), houseId = randomUUID(), membershipId = randomUUID();
    const now = Date.now();
    await database.db.insert(users).values({ id: userId, email: `${userId}@example.test`, emailVerifiedAt: new Date(now) });
    await database.db.insert(houses).values({ id: houseId, name: 'S2S reprovision fixture', createdByUserId: userId });
    await database.db.insert(houseMemberships).values({ id: membershipId, houseId, userId, role: 'admin' });
    const repository = createDrizzleS2sRepository(database.db, { clock: () => now });
    const requestedExpiry = new Date(now + 365 * 86400_000);
    const first = await repository.createGrant({ serviceId: S2S_SERVICE_ID, houseId, sponsorUserId: userId, sponsorMembershipId: membershipId, expiresAt: requestedExpiry, keyId: randomBytes(18).toString('base64url'), secret: randomBytes(32).toString('base64url'), credentialExpiresAt: requestedExpiry });
    await repository.revoke(first.id);
    const second = await repository.createGrant({ serviceId: S2S_SERVICE_ID, houseId, sponsorUserId: userId, sponsorMembershipId: membershipId, expiresAt: requestedExpiry, keyId: randomBytes(18).toString('base64url'), secret: randomBytes(32).toString('base64url'), credentialExpiresAt: requestedExpiry });
    const [firstAfterReprovision] = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, first.id));
    expect(second.id).not.toBe(first.id);
    expect(second.expiresAt).toEqual(new Date(now + 90 * 86400_000));
    expect(firstAfterReprovision?.revokedAt).not.toBeNull();
    expect(second.revokedAt).toBeNull();
  });

  it('fails boundedly when grant revocation encounters a row lock', async () => {
    const f = await fixture();
    const blockerPool = postgres(databaseUrl!, { max: 1 });
    const blocker = await blockerPool.reserve();
    try {
      await blocker.unsafe('BEGIN', []);
      await blocker.unsafe('SELECT id FROM s2s_service_grants WHERE id=$1 FOR UPDATE', [f.grantId]);
      const startedAt = Date.now();
      await expect(createDrizzleS2sRepository(database.db).revoke(f.grantId)).rejects.toMatchObject({ cause: { code: '55P03' } });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(2500);
      expect(elapsed).toBeLessThan(7000);
      const [grant] = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, f.grantId));
      expect(grant?.revokedAt).toBeNull();
    } finally {
      try { await blocker.unsafe('ROLLBACK', []); } catch { /* release cleanup after an assertion failure */ }
      blocker.release();
      await blockerPool.end({ timeout: 5 });
    }
  }, 10000);

  it.each(['provision', 'rotate'] as const)('reconciliation waits for the %s transaction before checking credential visibility', async (operation) => {
    const fixture = await requestableGrant();
    const readerPool = postgres(databaseUrl!, { max: 1, idle_timeout: 20 });
    await readerPool.unsafe('SELECT 1');
    const reader = createDrizzleS2sRepository(drizzle(readerPool, { schema }));
    const keyId = randomBytes(18).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60_000);
    let announceWrite!: () => void;
    let resumeWriter!: () => void;
    const writeReached = new Promise<void>((resolve) => { announceWrite = resolve; });
    const writerBarrier = new Promise<void>((resolve) => { resumeWriter = resolve; });
    const writer = createDrizzleS2sRepository(database.db, { afterCredentialWrite: async () => { announceWrite(); await writerBarrier; } });
    let writerOperation: Promise<{ id: string; expiresAt: Date } | { expiresAt: Date }> | undefined;
    try {
      writerOperation = operation === 'provision'
        ? writer.createGrant({ serviceId: S2S_SERVICE_ID, houseId: fixture.houseId, sponsorUserId: fixture.userId, sponsorMembershipId: fixture.membershipId, expiresAt, keyId, secret, credentialExpiresAt: expiresAt })
        : writer.issueOrRotate(fixture.grantId, keyId, secret, expiresAt);
      await writeReached;
      let settled = false;
      const reconciliation = reader.reconcileCredential(keyId, secret).then((result) => { settled = true; return result; }, (error) => { settled = true; throw error; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      resumeWriter();
      const committed = await writerOperation;
      const grantId = 'id' in committed ? committed.id : fixture.grantId;
      await expect(reconciliation).resolves.toMatchObject({ grantId, active: true });
    } finally {
      resumeWriter();
      await writerOperation?.catch(() => undefined);
      await readerPool.end({ timeout: 5 });
    }
  }, 15000);

  it('returns 503 through the HTTP route for a live diet profile row with a null payload', async () => {
    const fixture = await requestableGrant();
    const now = new Date();
    await database.db.insert(syncItems).values({ scopeType: 'house', scopeId: fixture.houseId, entityType: 'diet_profile', entityId: 'profile', userId: fixture.userId, deviceId: 'corrupt-diet-fixture', payload: null, deleted: false, clientUpdatedAt: now, mutationId: randomUUID() });
    const response = await requestDinnerContext(fixture.repository, fixture.keyId, fixture.secret);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'service_unavailable' });
  });

  it('returns 409 through the HTTP route for legacy pantry representation in the real repository', async () => {
    const fixture = await requestableGrant();
    const now = new Date();
    await database.db.insert(syncItems).values({ scopeType: 'house', scopeId: fixture.houseId, entityType: 'pantry_item', entityId: 'legacy-item', userId: fixture.userId, deviceId: 'legacy-fixture', payload: { id: 'legacy-item' }, deleted: false, clientUpdatedAt: now, mutationId: randomUUID() });
    const response = await requestDinnerContext(fixture.repository, fixture.keyId, fixture.secret);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'pantry_representation_unsupported' });
  });

  it('returns 409 through the HTTP route when the real repository sees more than 2000 pantry lots', async () => {
    const fixture = await requestableGrant();
    const now = new Date();
    const rows = Array.from({ length: 2001 }, (_, index) => {
      const entityId = `oversized-lot-${index}`;
      return { scopeType: 'house' as const, scopeId: fixture.houseId, entityType: 'pantry_lot' as const, entityId, userId: fixture.userId, deviceId: 'limit-fixture', payload: { id: entityId, ingredientId: 'beans', label: 'Beans', known: true, quantity: 1, unit: 'g', expiresAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }, deleted: false, clientUpdatedAt: now, mutationId: randomUUID() };
    });
    await database.db.insert(syncItems).values(rows);
    const response = await requestDinnerContext(fixture.repository, fixture.keyId, fixture.secret);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'snapshot_limit_exceeded' });
  });

  it('cancels a lock-blocked snapshot at its global deadline and returns the sole pooled connection', async () => {
    const fixture = await requestableGrant();
    const queryPool = postgres(databaseUrl!, { max: 1, idle_timeout: 20 });
    const blockerPool = postgres(databaseUrl!, { max: 1, idle_timeout: 20 });
    const blocker = await blockerPool.reserve();
    try {
      await queryPool.unsafe('SELECT 1');
      await blocker.unsafe('BEGIN', []);
      await blocker.unsafe('SELECT id FROM houses WHERE id=$1 FOR UPDATE', [fixture.houseId]);
      const repository = createDrizzleS2sRepository(drizzle(queryPool, { schema }));
      await expect(repository.readAuthorizedSnapshot({ keyId: fixture.keyId, secret: fixture.secret }, { timeoutMs: 500 })).rejects.toThrow('s2s_deadline_exceeded');
      const available = await queryPool.unsafe('SELECT 1 AS ok');
      expect(available[0]?.ok).toBe(1);
    } finally {
      try { await blocker.unsafe('ROLLBACK', []); } catch { /* connection may already be closed */ }
      blocker.release();
      await Promise.all([queryPool.end({ timeout: 5 }), blockerPool.end({ timeout: 5 })]);
    }
  }, 15000);

  it('replaces the dedicated pool after a real snapshot rollback failure', async () => {
    const fixture = await requestableGrant();
    let poolCount = 0;
    const recoveringDatabase = createRecoveringDatabaseWithFactory(() => {
      const poolId = ++poolCount;
      const client = postgres(databaseUrl!, { max: 1, idle_timeout: 20 });
      return {
        client: {
          reserve: async () => {
            const connection = await client.reserve();
            return {
              unsafe: (query: string, params: unknown[] = []) => {
                if (poolId === 1 && query.toUpperCase() === 'ROLLBACK') return Promise.reject(new Error('injected_rollback_failure'));
                return connection.unsafe(query, params as never[]);
              },
              release: () => connection.release(),
            };
          },
          end: (options: { timeout: number }) => client.end(options),
        },
        db: drizzle(client, { schema }),
      };
    });
    try {
      const failingRepository = createDrizzleS2sRepository(recoveringDatabase.db, {
        afterAuthorization: async () => { throw new Error('injected_snapshot_failure'); },
      });
      await expect(failingRepository.readAuthorizedSnapshot({ keyId: fixture.keyId, secret: fixture.secret })).rejects.toThrow('injected_snapshot_failure');
      expect(poolCount).toBe(2);
      const recoveredRepository = createDrizzleS2sRepository(recoveringDatabase.db);
      await expect(recoveredRepository.readAuthorizedSnapshot({ keyId: fixture.keyId, secret: fixture.secret })).resolves.toMatchObject({ grant: { keyId: fixture.keyId } });
      expect(poolCount).toBe(2);
    } finally {
      await recoveringDatabase.close();
    }
  }, 15000);

  it('does not mutate grant, credential, or pantry rows while reading a snapshot', async () => {
    const fixture = await requestableGrant();
    const now = new Date();
    const entityId = `read-only-${randomUUID()}`;
    await database.db.insert(syncItems).values({ scopeType: 'house', scopeId: fixture.houseId, entityType: 'pantry_lot', entityId, userId: fixture.userId, deviceId: 'read-only-fixture', payload: { id: entityId, ingredientId: 'beans', label: 'Beans', known: true, quantity: 1, unit: 'g', expiresAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }, deleted: false, clientUpdatedAt: now, mutationId: randomUUID() });
    const state = async () => {
      const [grant] = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, fixture.grantId));
      const credentials = await database.db.select().from(s2sServiceCredentials).where(eq(s2sServiceCredentials.grantId, fixture.grantId));
      const pantry = await database.db.select().from(syncItems).where(eq(syncItems.scopeId, fixture.houseId));
      return { grant, credentials, pantry };
    };
    const before = await state();
    const snapshot = await fixture.repository.readAuthorizedSnapshot({ keyId: fixture.keyId, secret: fixture.secret });
    const after = await state();
    expect(snapshot.pantryLots).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it('reads only live house data under the authorized grant; rejects altered and revoked credentials', async () => {
    const userId = randomUUID(); const houseId = randomUUID(); const otherId = randomUUID();
    const membershipId = randomUUID(); const otherHouse = randomUUID(); const keyId = `integration_${randomUUID()}`;
    const secret = randomUUID() + randomUUID(); const now = new Date();
    await database.db.insert(users).values([{ id: userId, email: `${userId}@example.test`, emailVerifiedAt: now }, { id: otherId, email: `${otherId}@example.test`, emailVerifiedAt: now }]);
    await database.db.insert(houses).values([{ id: houseId, name: 'S2S test', createdByUserId: userId }, { id: otherHouse, name: 'Other test', createdByUserId: otherId }]);
    await database.db.insert(houseMemberships).values({ id: membershipId, houseId, userId, role: 'admin' });
    const grant = await database.db.insert(s2sServiceGrants).values({ serviceId: S2S_SERVICE_ID, houseId, sponsorUserId: userId, sponsorMembershipId: membershipId, scope: 'dinner-context:read', expiresAt: new Date(Date.now() + 60_000) }).returning();
    await database.db.insert(s2sServiceCredentials).values({ keyId, grantId: grant[0]!.id, secretDigest: createHash('sha256').update(secret).digest('hex'), expiresAt: new Date(Date.now() + 60_000) });
    const payload = (id: string) => ({ id, ingredientId: 'beans', label: 'Beans', known: true, quantity: 300, unit: 'g', expiresAt: null });
    await database.db.insert(syncItems).values([
      { scopeType: 'house', scopeId: houseId, entityType: 'pantry_lot', entityId: 'house-lot', userId, deviceId: 'test', payload: payload('house-lot'), deleted: false, clientUpdatedAt: now, mutationId: randomUUID() },
      { scopeType: 'house', scopeId: otherHouse, entityType: 'pantry_lot', entityId: 'other-lot', userId: otherId, deviceId: 'test', payload: payload('other-lot'), deleted: false, clientUpdatedAt: now, mutationId: randomUUID() },
      { scopeType: 'user', scopeId: userId, entityType: 'pantry_lot', entityId: 'private-lot', userId, deviceId: 'test', payload: payload('private-lot'), deleted: false, clientUpdatedAt: now, mutationId: randomUUID() },
    ]);
    const repo = createDrizzleS2sRepository(database.db);
    const result = await repo.readAuthorizedSnapshot({ keyId, secret });
    expect(result.pantryLots.map((lot) => lot.id)).toEqual(['house-lot']);
    await expect(repo.readAuthorizedSnapshot({ keyId, secret: `${secret}altered` })).rejects.toMatchObject({ code: 'service_auth_required' });
    await repo.revoke(grant[0]!.id);
    await expect(repo.readAuthorizedSnapshot({ keyId, secret })).rejects.toMatchObject({ code: 'service_auth_required' });
  });

  it.each(['pantry_lot', 'diet_profile'] as const)('serializes a snapshot before a shared %s update', async (entityType) => {
    const f = await fixture();
    const timestamp = new Date().toISOString();
    const lot = { id: randomUUID(), ingredientId: 'beans', label: 'Beans', known: true, quantity: 200, unit: 'g' as const, expiresAt: null, createdAt: timestamp, updatedAt: timestamp };
    const dietProfile = { diet: 'vegan' as const, excludedAllergens: ['milk' as const], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: timestamp };
    const entityId = entityType === 'pantry_lot' ? lot.id : 'profile';
    const race = await runReadMutationRace(f, (writerDb) => createDrizzleSyncRepository(writerDb).applyMutation(f.userId, {
      mutationId: randomUUID(), deviceId: 's2s-shared-write-race', entityType, entityId, operation: 'upsert',
      payload: entityType === 'pantry_lot' ? lot : dietProfile, clientUpdatedAt: timestamp, syncScope: `house:${f.houseId}`,
    }));
    expect(race.result).toMatchObject({ applied: true });
    if (entityType === 'pantry_lot') expect(race.snapshot.pantryLots).toHaveLength(0);
    else expect(race.snapshot.dietProfile).toBeNull();

    const after = await createDrizzleS2sRepository(database.db).readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret });
    if (entityType === 'pantry_lot') expect(after.pantryLots).toEqual([expect.objectContaining({ id: lot.id, quantity: 200, unit: 'g' })]);
    else expect(after.dietProfile).toEqual(dietProfile);
  });

  it('serializes a snapshot before concurrent sponsor demotion and revokes its credentials atomically', async () => {
    const f = await fixture();
    const secondId = await addSecondAdmin(f);

    const race = await runReadMutationRace(f, (writerDb) => createDrizzleHouseRepository(writerDb).updateMemberRole({ adminUserId: secondId, userId: f.userId, role: 'member', now: new Date() }));
    expect(race.result).toBe('updated');
    expect(race.snapshot.grant.keyId).toBe(f.keyId);
    const [grant] = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, f.grantId));
    const credentials = await database.db.select().from(s2sServiceCredentials).where(eq(s2sServiceCredentials.grantId, f.grantId));
    expect(grant?.revokedAt).not.toBeNull();
    expect(credentials.every((credential) => credential.revokedAt !== null)).toBe(true);

    const repository = createDrizzleS2sRepository(database.db);
    await expect(repository.readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
    expect(await createDrizzleHouseRepository(database.db).updateMemberRole({ adminUserId: secondId, userId: f.userId, role: 'admin', now: new Date() })).toBe('updated');
    await expect(repository.readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
  });

  it.each(['grant revocation', 'member removal', 'house leave', 'account deletion'] as const)('serializes a snapshot before %s', async (action) => {
    const f = await fixture();
    const secondId = await addSecondAdmin(f);
    const race = await runReadMutationRace(f, (writerDb) => {
      if (action === 'grant revocation') return createDrizzleS2sRepository(writerDb).revoke(f.grantId);
      if (action === 'member removal') return createDrizzleHouseRepository(writerDb).removeMember({ adminUserId: secondId, userId: f.userId });
      if (action === 'house leave') return createDrizzleHouseRepository(writerDb).leaveHouse({ userId: f.userId });
      return createDrizzleProfileRepository(writerDb, createDrizzleSyncRepository(writerDb)).deleteAccount(f.userId);
    });
    expect(race.snapshot.grant.keyId).toBe(f.keyId);
    if (action === 'grant revocation') expect(race.result).toBeUndefined();
    if (action === 'member removal') expect(race.result).toBe('removed');
    if (action === 'house leave') expect(race.result).toBe('left');
    const grants = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, f.grantId));
    if (action === 'grant revocation') expect(grants[0]?.revokedAt).not.toBeNull();
    else expect(grants).toHaveLength(0);
    if (action === 'account deletion') expect(await database.db.select().from(users).where(eq(users.id, f.userId))).toHaveLength(0);
    await expect(createDrizzleS2sRepository(database.db).readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
  });

  it('orders credential rotation behind an in-flight read and preserves only the configured overlap', async () => {
    const f = await fixture();
    const nextKeyId = `integration_${randomUUID()}`;
    const nextSecret = randomUUID() + randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const race = await runReadMutationRace(f, (writerDb) => createDrizzleS2sRepository(writerDb).issueOrRotate(f.grantId, nextKeyId, nextSecret, expiresAt));
    expect(race.snapshot.grant.keyId).toBe(f.keyId);
    expect(race.result).toMatchObject({ expiresAt: expect.any(Date) });

    const repository = createDrizzleS2sRepository(database.db);
    await expect(repository.readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).resolves.toMatchObject({ grant: { keyId: f.keyId } });
    await expect(repository.readAuthorizedSnapshot({ keyId: nextKeyId, secret: nextSecret })).resolves.toMatchObject({ grant: { keyId: nextKeyId } });

    await repository.issueOrRotate(f.grantId, `integration_${randomUUID()}`, randomUUID() + randomUUID(), expiresAt);
    await expect(repository.readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
  });

  it('rejects a prior credential after its sponsor leaves and rejoins', async () => {
    const f = await fixture();
    const secondId = randomUUID();
    await database.db.insert(users).values({ id: secondId, email: `${secondId}@example.test`, emailVerifiedAt: new Date() });
    await database.db.insert(houseMemberships).values({ id: randomUUID(), houseId: f.houseId, userId: secondId, role: 'admin' });
    const houseRepo = createDrizzleHouseRepository(database.db);
    expect(await houseRepo.leaveHouse({ userId: f.userId })).toBe('left');
    await expect(createDrizzleS2sRepository(database.db).readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
    await database.db.insert(houseMemberships).values({ id: randomUUID(), houseId: f.houseId, userId: f.userId, role: 'admin' });
    await expect(createDrizzleS2sRepository(database.db).readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
  });

  it('rejects rotation for revoked or expired grants', async () => {
    for (const expired of [false, true]) {
      const f = await fixture('admin');
      if (expired) await database.db.execute(sql`UPDATE s2s_service_grants SET created_at = now() - interval '3 days', expires_at = now() - interval '1 day' WHERE id = ${f.grantId}`);
      else await createDrizzleS2sRepository(database.db).revoke(f.grantId);
      await expect(createDrizzleS2sRepository(database.db).issueOrRotate(f.grantId, `integration_${randomUUID()}`, randomUUID(), new Date(Date.now() + 60_000))).rejects.toMatchObject({ code: 'service_auth_required' });
    }
  });

  it('denies a snapshot if the credential expires while materializing', async () => {
    const f = await fixture();
    let now = Date.now();
    const repo = createDrizzleS2sRepository(database.db, { afterAuthorization: () => { now = Number.MAX_SAFE_INTEGER; }, clock: () => now });
    await expect(repo.readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
  });

  it('limits successive rotations to two live credentials and bounds expiries', async () => {
    const f = await fixture('admin', new Date(Date.now() + 24 * 3600_000));
    const repo = createDrizzleS2sRepository(database.db);
    const requestedExpiry = new Date(Date.now() + 3 * 86400_000);
    const initialExpiry = (await database.db.select().from(s2sServiceCredentials).where(eq(s2sServiceCredentials.keyId, f.keyId)))[0]!.expiresAt;
    await repo.issueOrRotate(f.grantId, `integration_${randomUUID()}`, randomUUID(), requestedExpiry);
    await repo.issueOrRotate(f.grantId, `integration_${randomUUID()}`, randomUUID(), requestedExpiry);
    const rows = await database.db.select().from(s2sServiceCredentials).where(eq(s2sServiceCredentials.grantId, f.grantId));
    const active = rows.filter((row) => row.revokedAt === null && row.expiresAt.getTime() > Date.now());
    expect(active).toHaveLength(2);
    const old = rows.filter((row) => row.keyId === f.keyId);
    expect(old).toHaveLength(1);
    expect(initialExpiry.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600_000 + 5000);
    expect(old.every((row) => row.expiresAt.getTime() <= Date.now() + 24 * 3600_000 + 5000)).toBe(true);
    const [grant] = await database.db.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, f.grantId));
    expect(rows.every((row) => row.expiresAt.getTime() <= grant.expiresAt.getTime())).toBe(true);
    await expect(repo.readAuthorizedSnapshot({ keyId: f.keyId, secret: f.secret })).rejects.toMatchObject({ code: 'service_auth_required' });
  });
});
