import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createRecoveringDatabaseWithFactory } from '../db/client.js';
import { createDrizzleS2sRepository } from './repository.js';
import { S2S_SERVICE_ID } from './constants.js';

const credential = { keyId: 'key_0123456789abcdef', secret: 's'.repeat(43) };
const makeAuthorizedRow = () => ({
  keyId: credential.keyId,
  secretDigest: createHash('sha256').update(credential.secret).digest('hex'),
  credentialRevokedAt: null,
  credentialExpiresAt: new Date(Date.now() + 60_000),
  grantId: 'grant-1',
  houseId: 'house-1',
  sponsorUserId: 'user-1',
  sponsorMembershipId: 'membership-1',
  scope: 'dinner-context:read',
  grantExpiresAt: new Date(Date.now() + 60_000),
  grantRevokedAt: null,
  verifiedAt: new Date(),
  membershipId: 'membership-1',
  membershipHouseId: 'house-1',
  membershipUserId: 'user-1',
  role: 'admin',
});

const repositoryWithSnapshotRows = (input: { legacyRows?: unknown[]; pantryRows?: unknown[]; dietRows?: unknown[]; grantExpiresAt?: Date }) => {
  const authorizedRow = { ...makeAuthorizedRow(), ...(input.grantExpiresAt === undefined ? {} : { grantExpiresAt: input.grantExpiresAt }) };
  const responses: unknown[][] = [
    [authorizedRow], [], [], [], [], [], [authorizedRow], input.legacyRows ?? [], input.pantryRows ?? [], input.dietRows ?? [],
  ];
  const connection = {
    unsafe: (query: string) => query.startsWith('SET LOCAL') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query)
      ? Promise.resolve([])
      : Promise.resolve(responses.shift() ?? []),
    release: () => undefined,
  };
  return createDrizzleS2sRepository({
    dialect: new PgDialect(),
    $client: { reserve: async () => connection },
  });
};
const repositoryWithDietRows = (dietRows: unknown[]) => repositoryWithSnapshotRows({ dietRows });

const adminTransactionHarness = (clock?: () => number) => {
  const statements: string[] = [];
  const inserts: unknown[] = [];
  const dialect = new PgDialect();
  const expiresAt = new Date(Date.now() + 60_000);
  const grant = { id: 'grant-1', sponsorUserId: 'user-1', houseId: 'house-1', sponsorMembershipId: 'membership-1', expiresAt, revokedAt: null };
  const tx = {
    execute: async (statement: unknown) => {
      const query = dialect.sqlToQuery(statement as never);
      statements.push(query.sql);
      const normalized = query.sql.toLowerCase();
      if (normalized.includes('house_memberships') && normalized.includes('role') && normalized.includes('for update')) return [{ id: 'membership-1', role: 'admin' }];
      if (normalized.includes('select email_verified_at')) return [{ email_verified_at: new Date() }];
      if (normalized.includes('revoked_at') && normalized.includes('email_verified_at')) return [{ revokedAt: null, grantExpiresAt: expiresAt, verifiedAt: new Date(), role: 'admin', membershipId: 'membership-1' }];
      return [];
    },
    select: () => ({ from: () => ({ where: async () => [grant] }) }),
    insert: () => ({ values: (values: unknown) => {
      inserts.push(values);
      return Object.assign(Promise.resolve([]), { returning: async () => [{ id: 'grant-new' }] });
    } }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  };
  const repository = createDrizzleS2sRepository({ dialect, transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) }, clock ? { clock } : {});
  return { repository, statements, inserts };
};

describe('S2S administrative transaction timeouts', () => {
  it('bounds a queued administrative transaction and releases a late reservation without executing it', async () => {
    let finishReservation!: (connection: { release: () => void }) => void;
    let released = 0;
    let transactionCalls = 0;
    const reservation = new Promise<{ release: () => void }>((resolve) => { finishReservation = resolve; });
    const database = {
      $client: { reserve: () => reservation },
      transaction: async () => { transactionCalls += 1; },
    };
    const repository = createDrizzleS2sRepository(database, { adminPoolAcquireTimeoutMs: 5 });
    await expect(repository.revoke('grant-queued')).rejects.toThrow('s2s_admin_pool_acquire_timeout');
    finishReservation({ release: () => { released += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(1);
    expect(transactionCalls).toBe(0);
  });

  it.each(['createGrant', 'issueOrRotate', 'revoke'] as const)('sets bounded lock and statement timeouts before %s operations', async (operation) => {
    const { repository, statements } = adminTransactionHarness();
    if (operation === 'createGrant') {
      await repository.createGrant({ serviceId: S2S_SERVICE_ID, houseId: 'house-1', sponsorUserId: 'user-1', sponsorMembershipId: 'membership-1', expiresAt: new Date(Date.now() + 30_000), keyId: credential.keyId, secret: credential.secret, credentialExpiresAt: new Date(Date.now() + 30_000) });
    } else if (operation === 'issueOrRotate') {
      await repository.issueOrRotate('grant-1', credential.keyId, credential.secret, new Date(Date.now() + 30_000));
    } else {
      await repository.revoke('grant-1');
    }
    expect(statements.slice(0, 2).map((statement) => statement.toLowerCase())).toEqual([
      "set local lock_timeout = '3s'",
      "set local statement_timeout = '15s'",
    ]);
  });

  it.each(['rejected', 'thrown synchronously'] as const)('terminates the admin pool and withholds its connection after a %s rollback failure', async (failureMode) => {
    const operationError = new Error('failure after credential writes');
    const rollbackError = new Error('injected rollback failure');
    let released = 0;
    let endOptions: { timeout: number } | undefined;
    let poolEnded = false;
    let reservations = 0;
    const connection = {
      unsafe: (query: string) => {
        let rows: Record<string, unknown>[] = [];
        if (query === 'ROLLBACK') {
          if (failureMode === 'thrown synchronously') throw rollbackError;
          return Promise.reject(rollbackError);
        }
        if (query.includes('house_memberships') && query.includes('FOR UPDATE')) rows = [{ id: 'membership-1', role: 'admin' }];
        else if (query.includes('SELECT email_verified_at')) rows = [{ email_verified_at: new Date() }];
        else if (query.includes('insert into "s2s_service_grants"')) rows = [{ id: 'grant-new' }];
        return Object.assign(Promise.resolve(rows), { values: async () => rows.map((row) => Object.values(row)) });
      },
      release: () => { released += 1; },
    };
    const client = {
      options: { parsers: {}, serializers: {} },
      reserve: async () => {
        reservations += 1;
        if (poolEnded) throw new Error('admin pool ended');
        return connection;
      },
      end: async (options: { timeout: number }) => { endOptions = options; poolEnded = true; },
    };
    const database = { dialect: new PgDialect(), $client: client };
    const repository = createDrizzleS2sRepository(database, { afterCredentialWrite: () => { throw operationError; } });

    let failure: unknown;
    try {
      await repository.createGrant({
        serviceId: S2S_SERVICE_ID,
        houseId: 'house-1',
        sponsorUserId: 'user-1',
        sponsorMembershipId: 'membership-1',
        expiresAt: new Date(Date.now() + 30_000),
        keyId: credential.keyId,
        secret: credential.secret,
        credentialExpiresAt: new Date(Date.now() + 30_000),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([operationError, rollbackError]);
    expect(endOptions).toEqual({ timeout: 0 });
    expect(released).toBe(0);
    await expect(repository.reconcileCredential(credential.keyId, credential.secret)).rejects.toThrow('admin pool ended');
    expect(reservations).toBe(2);
    expect(released).toBe(0);
  });
});

describe('S2S grant credential expiry', () => {
  it.each([
    ['shorter', 20_000, 20_000],
    ['longer', 120_000, 60_000],
  ] as const)('stores the %s requested credential expiry bounded by the grant', async (_lifetime, credentialLifetimeMs, expectedCredentialLifetimeMs) => {
    const now = 1_700_000_000_000;
    const grantExpiry = new Date(now + 60_000);
    const { repository, inserts } = adminTransactionHarness(() => now);

    await repository.createGrant({
      serviceId: S2S_SERVICE_ID,
      houseId: 'house-1',
      sponsorUserId: 'user-1',
      sponsorMembershipId: 'membership-1',
      expiresAt: grantExpiry,
      keyId: credential.keyId,
      secret: credential.secret,
      credentialExpiresAt: new Date(now + credentialLifetimeMs),
    });

    expect((inserts[0] as { expiresAt: Date }).expiresAt).toEqual(grantExpiry);
    expect((inserts[1] as { expiresAt: Date }).expiresAt).toEqual(new Date(now + expectedCredentialLifetimeMs));
  });
});

describe('S2S dinner-context repository diet profile presence', () => {
  it('returns the grant expiry as an ISO string with millisecond precision', async () => {
    const expiresAt = new Date(Date.now() + 60_123);
    const repository = repositoryWithSnapshotRows({ grantExpiresAt: expiresAt });

    const snapshot = await repository.readAuthorizedSnapshot(credential);

    expect(snapshot.grant.expiresAt).toBe(expiresAt.toISOString());
  });

  it('reconciles a credential using the stored digest and effective expiry', async () => {
    const storedSecret = credential.secret;
    const row = {
      keyId: credential.keyId,
      secretDigest: createHash('sha256').update(storedSecret).digest('hex'),
      credentialRevokedAt: null,
      credentialExpiresAt: new Date(10_000),
      grantId: 'grant-reconciled',
      grantExpiresAt: new Date(5_000),
      grantRevokedAt: null,
    };
    let calls = 0;
    const database = { transaction: async (callback: (tx: { execute: () => Promise<unknown[]> }) => Promise<unknown>) => callback({ execute: async () => { calls += 1; return calls === 4 ? [row] : []; } }) };
    const repository = createDrizzleS2sRepository(database, { clock: () => 1_000 });
    await expect(repository.reconcileCredential(credential.keyId, storedSecret)).resolves.toEqual({ grantId: 'grant-reconciled', expiresAt: new Date(5_000), active: true });
    expect(calls).toBe(4);
  });

  it('does not reconcile an expired or revoked credential as usable', async () => {
    const row = {
      keyId: credential.keyId,
      secretDigest: createHash('sha256').update(credential.secret).digest('hex'),
      credentialRevokedAt: null,
      credentialExpiresAt: new Date(10_000),
      grantId: 'grant-reconciled',
      grantExpiresAt: new Date(5_000),
      grantRevokedAt: null,
    };
    let calls = 0;
    const database = { transaction: async (callback: (tx: { execute: () => Promise<unknown[]> }) => Promise<unknown>) => callback({ execute: async () => { calls += 1; return calls === 4 ? [row] : []; } }) };
    const repository = createDrizzleS2sRepository(database, { clock: () => 5_000 });
    await expect(repository.reconcileCredential(credential.keyId, credential.secret)).resolves.toMatchObject({ active: false });
  });

  it('blocks non-read SQL before sending it to PostgreSQL', async () => {
    const statements: string[] = [];
    const connection = {
      unsafe: async (statement: string) => { statements.push(statement); return []; },
      release: () => undefined,
    };
    const database = {
      dialect: { sqlToQuery: () => ({ sql: 'UPDATE users SET email = $1', params: ['not-sent'] }) },
      $client: { reserve: async () => connection },
    };
    const repository = createDrizzleS2sRepository(database);
    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toThrow('s2s_read_only_violation');
    expect(statements.some((statement) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(statement))).toBe(false);
  });

  it('blocks sequence-mutating SELECT SQL before sending it to PostgreSQL', async () => {
    const statements: string[] = [];
    const connection = {
      unsafe: async (statement: string) => { statements.push(statement); return []; },
      release: () => undefined,
    };
    const database = {
      dialect: { sqlToQuery: () => ({ sql: "SELECT nextval('s2s_test_seq')", params: [] }) },
      $client: { reserve: async () => connection },
    };
    const repository = createDrizzleS2sRepository(database);
    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toThrow('s2s_read_only_violation');
    expect(statements).not.toContain("SELECT nextval('s2s_test_seq')");
  });

  it('blocks multi-statement SQL with a read-only prefix before sending it to PostgreSQL', async () => {
    const statements: string[] = [];
    const connection = {
      unsafe: async (statement: string) => { statements.push(statement); return []; },
      release: () => undefined,
    };
    const database = {
      dialect: { sqlToQuery: () => ({ sql: 'SELECT 1; DELETE FROM users', params: [] }) },
      $client: { reserve: async () => connection },
    };
    const repository = createDrizzleS2sRepository(database);
    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toThrow('s2s_read_only_violation');
    expect(statements.some((statement) => statement.includes(';'))).toBe(false);
  });

  it('cancels an active PostgreSQL query and releases its reserved connection on abort', async () => {
    let cancelled = 0;
    let released = 0;
    let rejectQuery!: (error: Error) => void;
    const blockingQuery = Object.assign(new Promise<unknown[]>((_, reject) => { rejectQuery = reject; }), {
      cancel: () => { cancelled += 1; rejectQuery(new Error('cancelled')); },
    });
    const reserved = {
      unsafe: (query: string) => query.startsWith('SET LOCAL') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query) ? Promise.resolve([]) : blockingQuery,
      release: () => { released += 1; },
    };
    const database = {
      dialect: new PgDialect(),
      $client: { reserve: async () => reserved },
    };
    const controller = new AbortController();
    const repository = createDrizzleS2sRepository(database);
    const request = repository.readAuthorizedSnapshot(credential, { signal: controller.signal, timeoutMs: 1000 });
    const abortTimer = setTimeout(() => controller.abort(), 5);
    try {
      const outcome = await Promise.race([request.then(() => 'resolved', () => 'rejected'), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100))]);
      expect(outcome).toBe('rejected');
      expect(cancelled).toBe(1);
      expect(released).toBe(1);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('rollback failed'))],
    ['throws synchronously', () => { throw new Error('rollback failed'); }],
  ])('terminates the pool and withholds the connection when rollback %s', async (_kind, makeRollback) => {
    let released = 0;
    let poolEndOptions: { timeout?: number } | undefined;
    const connection = {
      unsafe: (query: string) => query === 'ROLLBACK' ? makeRollback() : Promise.resolve([]),
      release: () => { released += 1; },
    };
    const database = {
      dialect: new PgDialect(),
      $client: {
        reserve: async () => connection,
        end: async (options: { timeout?: number }) => { poolEndOptions = options; },
      },
    };
    const repository = createDrizzleS2sRepository(database);
    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toThrow('service_auth_required');
    expect(poolEndOptions).toEqual({ timeout: 0 });
    expect(released).toBe(0);
  });

  it('force-closes the pool instead of waiting forever for a stalled rollback', async () => {
    let cancelled = 0;
    let released = 0;
    let poolEndOptions: { timeout?: number } | undefined;
    const stalledRollback = Object.assign(new Promise<unknown[]>(() => undefined), { cancel: () => { cancelled += 1; return new Promise<void>(() => undefined); } });
    const connection = {
      unsafe: (query: string) => query === 'ROLLBACK' ? stalledRollback : Promise.resolve([]),
      release: () => { released += 1; },
    };
    const database = {
      dialect: new PgDialect(),
      $client: {
        reserve: async () => connection,
        end: async (options: { timeout?: number }) => { poolEndOptions = options; },
      },
    };
    const repository = createDrizzleS2sRepository(database);
    const outcome = await Promise.race([
      repository.readAuthorizedSnapshot(credential).then(() => 'resolved', () => 'rejected'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
    expect(outcome).toBe('rejected');
    expect(cancelled).toBe(1);
    expect(poolEndOptions).toEqual({ timeout: 0 });
    expect(released).toBe(0);
  });

  it('force-closes the pool when a canceled statement and rollback both remain pending', async () => {
    let queryCancelled = 0;
    let rollbackCancelled = 0;
    let released = 0;
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
    let poolEndOptions: { timeout?: number } | undefined;
    const stalled = (onCancel: () => void) => Object.assign(new Promise<unknown[]>(() => undefined), {
      cancel: () => { onCancel(); return new Promise<void>(() => undefined); },
    });
    const statement = stalled(() => { queryCancelled += 1; });
    const rollback = stalled(() => { rollbackCancelled += 1; });
    const connection = {
      unsafe: (query: string) => {
        if (query === 'ROLLBACK') return rollback;
        if (query === 'BEGIN' || query.startsWith('SET LOCAL')) return Promise.resolve([]);
        markQueryStarted();
        return statement;
      },
      release: () => { released += 1; },
    };
    const database = {
      dialect: new PgDialect(),
      $client: {
        reserve: async () => connection,
        end: async (options: { timeout?: number }) => { poolEndOptions = options; },
      },
    };
    const controller = new AbortController();
    const repository = createDrizzleS2sRepository(database);
    const request = repository.readAuthorizedSnapshot(credential, { signal: controller.signal, timeoutMs: 1000 });
    await queryStarted;
    controller.abort();
    const outcome = await Promise.race([
      request.then(() => 'resolved', () => 'rejected'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
    expect(outcome).toBe('rejected');
    expect(queryCancelled).toBe(1);
    expect(rollbackCancelled).toBe(1);
    expect(poolEndOptions).toEqual({ timeout: 0 });
    expect(released).toBe(0);
  });

  it('replaces a terminated reader pool and completes the next authorized read', async () => {
    const endedPools: Array<{ id: number; timeout: number }> = [];
    let nextPoolId = 0;
    const database = createRecoveringDatabaseWithFactory(() => {
      const id = ++nextPoolId;
      const responses: unknown[][] = [
        [makeAuthorizedRow()], [], [], [], [], [], [makeAuthorizedRow()], [], [], [],
      ];
      const connection = {
        unsafe: (query: string) => {
          if (query === 'BEGIN' || query === 'COMMIT' || query.startsWith('SET LOCAL')) return Promise.resolve([]);
          if (id === 1 && query === 'ROLLBACK') return Promise.reject(new Error('rollback failed'));
          if (id === 1) return Promise.reject(new Error('read failed'));
          if (query === 'ROLLBACK') return Promise.resolve([]);
          return Promise.resolve(responses.shift() ?? []);
        },
        release: () => undefined,
      };
      const client = {
        reserve: async () => connection,
        end: async ({ timeout }: { timeout: number }) => { endedPools.push({ id, timeout }); },
      };
      return { client, db: { dialect: new PgDialect(), transaction: async () => undefined } };
    });
    const repository = createDrizzleS2sRepository(database.db);

    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toThrow('read failed');
    await expect(repository.readAuthorizedSnapshot(credential)).resolves.toMatchObject({
      grant: { keyId: credential.keyId },
      pantryLots: [],
      dietProfile: null,
    });
    expect(endedPools).toEqual([{ id: 1, timeout: 0 }]);

    await database.close();
  });

  it('does not retain a connection that becomes available after a timed-out pool wait', async () => {
    let finishReservation!: (connection: { release: () => void }) => void;
    let released = 0;
    const reservation = new Promise<{ release: () => void }>((resolve) => { finishReservation = resolve; });
    const database = {
      dialect: new PgDialect(),
      $client: { reserve: () => reservation },
    };
    const controller = new AbortController();
    const repository = createDrizzleS2sRepository(database);
    const request = repository.readAuthorizedSnapshot(credential, { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await expect(request).rejects.toThrow('s2s_deadline_exceeded');
    finishReservation({ release: () => { released += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(1);
  });

  it('treats an absent live profile row as not configured', async () => {
    const repository = repositoryWithDietRows([]);
    await expect(repository.readAuthorizedSnapshot(credential)).resolves.toMatchObject({ dietProfile: null });
  });

  it('rejects a live diet profile row whose JSON payload is null as corrupt', async () => {
    const repository = repositoryWithDietRows([{ payload: null }]);
    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toMatchObject({ code: 'service_integrity_error' });
  });

  it('reports legacy pantry rows as a representation conflict', async () => {
    const repository = repositoryWithSnapshotRows({ legacyRows: [{ exists: 1 }] });
    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toMatchObject({ code: 'pantry_representation_unsupported' });
  });

  it('reports an oversized pantry snapshot as a limit conflict', async () => {
    const repository = repositoryWithSnapshotRows({ pantryRows: Array.from({ length: 2001 }, () => ({ payload: {} })) });
    await expect(repository.readAuthorizedSnapshot(credential)).rejects.toMatchObject({ code: 'snapshot_limit_exceeded' });
  });
});
