/* eslint-disable @typescript-eslint/no-explicit-any -- postgres-js execute rows have dynamic SQL projections; authorization fields are validated before use. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PantryLot, DietProfile } from '@ikuck/shared/contracts';
import * as schema from '../db/schema.js';
import { houseMemberships, houses, s2sServiceCredentials, s2sServiceGrants, syncItems, users } from '../db/schema.js';
import { S2S_SERVICE_ID } from './constants.js';

export type S2sFailure = 'service_auth_required' | 'service_access_denied' | 'service_integrity_error' | 'snapshot_limit_exceeded' | 'pantry_representation_unsupported';
export class S2sRepositoryError extends Error {
  constructor(readonly code: S2sFailure) { super(code); }
}
export type SuppliedServiceCredential = { keyId: string; secret: string };
export type AuthorizedDinnerSnapshot = { grant: { keyId: string; scope: 'dinner-context:read'; expiresAt: string }; pantryLots: PantryLot[]; dietProfile: DietProfile | null };
const digest = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');
const matches = (provided: string, stored: string) => {
  const a = Buffer.from(digest(provided), 'hex'); const b = Buffer.from(stored, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
};
const DUMMY_DIGEST = '0'.repeat(64);
const ROLLBACK_GRACE_MS = 250;
const ADMIN_POOL_ACQUIRE_TIMEOUT_MS = 3000;
// PostgreSQL disallows FOR SHARE in READ ONLY transactions, so enforce this exact query allowlist before dispatch.
const READ_SNAPSHOT_SELECTS = new Set([
  'SELECT c.key_id AS "keyId", c.secret_digest AS "secretDigest", c.revoked_at AS "credentialRevokedAt", c.expires_at AS "credentialExpiresAt", g.id AS "grantId", g.house_id AS "houseId", g.sponsor_user_id AS "sponsorUserId", g.sponsor_membership_id AS "sponsorMembershipId", g.scope, g.expires_at AS "grantExpiresAt", g.revoked_at AS "grantRevokedAt", u.email_verified_at AS "verifiedAt", m.id AS "membershipId", m.house_id AS "membershipHouseId", m.user_id AS "membershipUserId", m.role FROM s2s_service_credentials c JOIN s2s_service_grants g ON g.id=c.grant_id LEFT JOIN users u ON u.id=g.sponsor_user_id LEFT JOIN house_memberships m ON m.id=g.sponsor_membership_id WHERE c.key_id = $1',
  'SELECT id FROM "users" WHERE id=$1 FOR SHARE',
  'SELECT id FROM "houses" WHERE id=$1 FOR SHARE',
  'SELECT id FROM "house_memberships" WHERE id=$1 FOR SHARE',
  'SELECT id FROM "s2s_service_grants" WHERE id=$1 FOR SHARE',
  'SELECT key_id FROM "s2s_service_credentials" WHERE key_id=$1 FOR SHARE',
  'SELECT 1 FROM "sync_items" WHERE scope_type=\'house\' AND scope_id=$1 AND entity_type=\'pantry_item\' AND deleted=false LIMIT 1',
  'SELECT payload FROM "sync_items" WHERE scope_type=\'house\' AND scope_id=$1 AND entity_type=\'pantry_lot\' AND deleted=false ORDER BY entity_id LIMIT 2001',
  'SELECT payload FROM "sync_items" WHERE scope_type=\'house\' AND scope_id=$1 AND entity_type=\'diet_profile\' AND entity_id=\'profile\' AND deleted=false LIMIT 1',
]);
const assertReadOnlyStatement = (query: string) => {
  const statement = query.trim();
  const transactionControl = ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement.toUpperCase());
  const localTimeout = /^SET\s+LOCAL\s+(?:statement_timeout|lock_timeout)\s*=\s*'[0-9]+(?:ms|s)'$/i.test(statement);
  if (!transactionControl && !localTimeout && !READ_SNAPSHOT_SELECTS.has(statement)) throw new Error('s2s_read_only_violation');
};
const currentSponsorIsAuthorized = (row: any) => Boolean(row.verifiedAt)
  && row.role === 'admin'
  && row.membershipId === row.sponsorMembershipId
  && row.membershipHouseId === row.houseId
  && row.membershipUserId === row.sponsorUserId;
const authorized = (row: any, credential: SuppliedServiceCredential) => {
  if (!row || row.credentialRevokedAt || new Date(row.credentialExpiresAt).getTime() <= Date.now() || !matches(credential.secret, row.secretDigest)) throw new S2sRepositoryError('service_auth_required');
  if (row.grantRevokedAt || new Date(row.grantExpiresAt).getTime() <= Date.now()) throw new S2sRepositoryError('service_auth_required');
  if (!currentSponsorIsAuthorized(row)) throw new S2sRepositoryError('service_access_denied');
};
const selected = sql`SELECT c.key_id AS "keyId", c.secret_digest AS "secretDigest", c.revoked_at AS "credentialRevokedAt", c.expires_at AS "credentialExpiresAt", g.id AS "grantId", g.house_id AS "houseId", g.sponsor_user_id AS "sponsorUserId", g.sponsor_membership_id AS "sponsorMembershipId", g.scope, g.expires_at AS "grantExpiresAt", g.revoked_at AS "grantRevokedAt", u.email_verified_at AS "verifiedAt", m.id AS "membershipId", m.house_id AS "membershipHouseId", m.user_id AS "membershipUserId", m.role FROM s2s_service_credentials c JOIN s2s_service_grants g ON g.id=c.grant_id LEFT JOIN users u ON u.id=g.sponsor_user_id LEFT JOIN house_memberships m ON m.id=g.sponsor_membership_id WHERE c.key_id = `;

export const createDrizzleS2sRepository = (database: any, hooks: { afterAuthorization?: () => Promise<void> | void; afterCredentialWrite?: () => Promise<void> | void; clock?: () => number; adminPoolAcquireTimeoutMs?: number } = {}) => {
  const setAdminTransactionTimeouts = async (tx: any) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
  };
  const runAdminTransaction = async <T>(callback: (tx: any) => Promise<T>) => {
    const client = database.$client;
    if (typeof client?.reserve !== 'function') return database.transaction(callback) as Promise<T>;

    let connection: any;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rollbackFailed = false;
    const reservation = Promise.resolve().then(() => client.reserve());
    try {
      connection = await Promise.race([
        reservation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('s2s_admin_pool_acquire_timeout')), hooks.adminPoolAcquireTimeoutMs ?? ADMIN_POOL_ACQUIRE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      void reservation.then((lateConnection: any) => lateConnection.release(), () => undefined);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    try {
      const reservedClient = new Proxy(connection, {
        get: (target, property) => {
          if (property === 'options') return client.options ?? { parsers: {}, serializers: {} };
          if (property === 'begin') return async (callback: (transactionClient: any) => Promise<T>) => {
            await target.unsafe('BEGIN');
            try {
              const result = await callback(target);
              await target.unsafe('COMMIT');
              return result;
            } catch (error) {
              try {
                await target.unsafe('ROLLBACK');
              } catch (rollbackError) {
                rollbackFailed = true;
                throw new AggregateError([error, rollbackError], 'S2S admin transaction and rollback failed');
              }
              throw error;
            }
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const reservedDatabase = drizzle(reservedClient, { schema });
      return await reservedDatabase.transaction(callback) as T;
    } finally {
      if (rollbackFailed) {
        try { await client.end({ timeout: 0 }); } catch { /* never release a connection after an uncertain rollback */ }
      } else {
        connection.release();
      }
    }
  };

  return {
  async readAuthorizedSnapshot(credential: SuppliedServiceCredential, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AuthorizedDinnerSnapshot> {
    const requestedTimeout = options.timeoutMs ?? 5000;
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1, requestedTimeout) : 5000;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', relayAbort, { once: true });
    const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;
    const deadlineError = () => new Error('s2s_deadline_exceeded');
    const assertActive = () => {
      if (signal.aborted || Date.now() >= deadline) throw deadlineError();
    };
    const acquire = async () => {
      assertActive();
      const pending = database.$client.reserve();
      let abortListener: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => {
          abortListener = () => reject(deadlineError());
          signal.addEventListener('abort', abortListener, { once: true });
        });
        const connection = await Promise.race([pending, aborted]);
        assertActive();
        return connection;
      } catch (error) {
        void pending.then((lateConnection: any) => lateConnection.release(), () => undefined);
        throw error;
      } finally {
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
    };
    let connection: any;
    let poolTerminated = false;
    const execute = async (client: any, query: string, params: unknown[] = []) => {
      assertReadOnlyStatement(query);
      assertActive();
      const pending = client.unsafe(query, params);
      const cancel = () => { try { void Promise.resolve(pending.cancel?.()).catch(() => undefined); } catch { /* best-effort PostgreSQL cancellation */ } };
      const remainingMs = Math.max(1, Math.ceil(deadline - Date.now()));
      const queryTimer = setTimeout(() => controller.abort(), remainingMs);
      let abortQuery!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        abortQuery = () => { cancel(); reject(deadlineError()); };
      });
      signal.addEventListener('abort', abortQuery, { once: true });
      if (signal.aborted) abortQuery();
      try {
        const result = await Promise.race([pending, aborted]);
        assertActive();
        return result;
      } catch (error) {
        if (signal.aborted || Date.now() >= deadline) throw deadlineError();
        throw error;
      } finally {
        clearTimeout(queryTimer);
        signal.removeEventListener('abort', abortQuery);
      }
    };
    const executeDrizzle = async (client: any, statement: any) => {
      assertActive();
      const remainingMs = Math.max(1, Math.ceil(deadline - Date.now()));
      await execute(client, `SET LOCAL statement_timeout = '${remainingMs}ms'`);
      const compiled = database.dialect.sqlToQuery(statement);
      return execute(client, compiled.sql, compiled.params);
    };
    const waitForRollbackSettlement = async (pending: any): Promise<'fulfilled' | 'rejected' | 'timed_out'> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.resolve(pending).then(() => 'fulfilled' as const, () => 'rejected' as const),
        new Promise<'timed_out'>((resolve) => { timer = setTimeout(() => resolve('timed_out'), ROLLBACK_GRACE_MS); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      return settled;
    };
    const terminatePool = async () => {
      poolTerminated = true;
      try { await database.$client.end({ timeout: 0 }); } catch { /* do not release a connection from a pool being terminated */ }
    };
    const rollback = async () => {
      if (!connection) return;
      let pending: any;
      try { pending = connection.unsafe('ROLLBACK', []); } catch { await terminatePool(); return; }
      const initialSettlement = await waitForRollbackSettlement(pending);
      if (initialSettlement === 'fulfilled') return;
      if (initialSettlement === 'rejected') { await terminatePool(); return; }
      try { void Promise.resolve(pending.cancel?.()).catch(() => undefined); } catch { /* best-effort cancellation */ }
      const cancellationSettlement = await waitForRollbackSettlement(pending);
      if (cancellationSettlement === 'fulfilled') return;
      await terminatePool();
    };
    try {
      connection = await acquire();
      await execute(connection, 'BEGIN');
      await execute(connection, "SET LOCAL lock_timeout = '3s'");
      const lookup = await executeDrizzle(connection, sql`${selected}${credential.keyId}`);
      const initial = lookup[0] as any;
      if (!initial) { matches(credential.secret, DUMMY_DIGEST); throw new S2sRepositoryError('service_auth_required'); }
      if (!matches(credential.secret, initial.secretDigest)) throw new S2sRepositoryError('service_auth_required');
      await executeDrizzle(connection, sql`SELECT id FROM ${users} WHERE id=${initial.sponsorUserId} FOR SHARE`);
      await executeDrizzle(connection, sql`SELECT id FROM ${houses} WHERE id=${initial.houseId} FOR SHARE`);
      await executeDrizzle(connection, sql`SELECT id FROM ${houseMemberships} WHERE id=${initial.sponsorMembershipId} FOR SHARE`);
      await executeDrizzle(connection, sql`SELECT id FROM ${s2sServiceGrants} WHERE id=${initial.grantId} FOR SHARE`);
      await executeDrizzle(connection, sql`SELECT key_id FROM ${s2sServiceCredentials} WHERE key_id=${credential.keyId} FOR SHARE`);
      const checked = await executeDrizzle(connection, sql`${selected}${credential.keyId}`);
      const row = checked[0] as any;
      authorized(row, credential);
      if (row.scope !== 'dinner-context:read') throw new S2sRepositoryError('service_access_denied');
      const legacy = await executeDrizzle(connection, sql`SELECT 1 FROM ${syncItems} WHERE scope_type='house' AND scope_id=${row.houseId} AND entity_type='pantry_item' AND deleted=false LIMIT 1`);
      if (legacy.length > 0) throw new S2sRepositoryError('pantry_representation_unsupported');
      const items = await executeDrizzle(connection, sql`SELECT payload FROM ${syncItems} WHERE scope_type='house' AND scope_id=${row.houseId} AND entity_type='pantry_lot' AND deleted=false ORDER BY entity_id LIMIT 2001`);
      if (items.length > 2000) throw new S2sRepositoryError('snapshot_limit_exceeded');
      const diets = await executeDrizzle(connection, sql`SELECT payload FROM ${syncItems} WHERE scope_type='house' AND scope_id=${row.houseId} AND entity_type='diet_profile' AND entity_id='profile' AND deleted=false LIMIT 1`);
      if (diets.length > 0 && (diets[0].payload === null || diets[0].payload === undefined)) throw new S2sRepositoryError('service_integrity_error');
      if (hooks.afterAuthorization) {
        const hookResult = Promise.resolve(hooks.afterAuthorization());
        let abortListener: (() => void) | undefined;
        try {
          await Promise.race([hookResult, new Promise<never>((_, reject) => {
            abortListener = () => reject(deadlineError());
            signal.addEventListener('abort', abortListener, { once: true });
          })]);
          assertActive();
        } finally { if (abortListener) signal.removeEventListener('abort', abortListener); }
      }
      const finalNow = hooks.clock?.() ?? Date.now();
      if (row.credentialRevokedAt || new Date(row.credentialExpiresAt).getTime() <= finalNow || row.grantRevokedAt || new Date(row.grantExpiresAt).getTime() <= finalNow) throw new S2sRepositoryError('service_auth_required');
      const snapshot = { grant: { keyId: row.keyId, scope: 'dinner-context:read' as const, expiresAt: new Date(row.grantExpiresAt).toISOString() }, pantryLots: items.map((item: any) => item.payload as PantryLot), dietProfile: diets.length === 0 ? null : diets[0].payload as DietProfile };
      await execute(connection, 'COMMIT');
      return snapshot;
    } catch (error) {
      await rollback();
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', relayAbort);
      if (!poolTerminated) connection?.release();
    }
  },
  async reconcileCredential(keyId: string, secret: string): Promise<{ grantId: string; expiresAt: Date; active: boolean } | null> {
    return runAdminTransaction(async (tx: any) => {
      await setAdminTransactionTimeouts(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${keyId}))`);
      const rows = await tx.execute(sql`SELECT c.key_id AS "keyId", c.secret_digest AS "secretDigest", c.revoked_at AS "credentialRevokedAt", c.expires_at AS "credentialExpiresAt", g.id AS "grantId", g.house_id AS "houseId", g.sponsor_user_id AS "sponsorUserId", g.sponsor_membership_id AS "sponsorMembershipId", g.scope, g.expires_at AS "grantExpiresAt", g.revoked_at AS "grantRevokedAt", u.email_verified_at AS "verifiedAt", m.id AS "membershipId", m.house_id AS "membershipHouseId", m.user_id AS "membershipUserId", m.role FROM ${s2sServiceCredentials} c LEFT JOIN ${s2sServiceGrants} g ON g.id=c.grant_id LEFT JOIN ${users} u ON u.id=g.sponsor_user_id LEFT JOIN ${houseMemberships} m ON m.id=g.sponsor_membership_id WHERE c.key_id=${keyId}`);
      const row = rows[0] as any;
      if (!row) { matches(secret, DUMMY_DIGEST); return null; }
      if (row.keyId !== keyId || !matches(secret, row.secretDigest) || !row.grantId || row.credentialExpiresAt == null || row.grantExpiresAt == null) throw new S2sRepositoryError('service_integrity_error');
      const expiryMs = Math.min(new Date(row.credentialExpiresAt).getTime(), new Date(row.grantExpiresAt).getTime());
      if (!Number.isFinite(expiryMs)) throw new S2sRepositoryError('service_integrity_error');
      const now = hooks.clock?.() ?? Date.now();
      return { grantId: row.grantId, expiresAt: new Date(expiryMs), active: !row.credentialRevokedAt && !row.grantRevokedAt && expiryMs > now && currentSponsorIsAuthorized(row) && row.scope === 'dinner-context:read' };
    });
  },
  async createGrant(input: { serviceId: string; houseId: string; sponsorUserId: string; sponsorMembershipId: string; expiresAt: Date; keyId: string; secret: string; credentialExpiresAt: Date }) {
    return runAdminTransaction(async (tx: any) => {
      await setAdminTransactionTimeouts(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.keyId}))`);
      await tx.execute(sql`SELECT id FROM ${users} WHERE id=${input.sponsorUserId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${houses} WHERE id=${input.houseId} FOR UPDATE`);
      const m = await tx.execute(sql`SELECT id, role FROM ${houseMemberships} WHERE id=${input.sponsorMembershipId} AND user_id=${input.sponsorUserId} AND house_id=${input.houseId} FOR UPDATE`);
      const u = await tx.execute(sql`SELECT email_verified_at FROM ${users} WHERE id=${input.sponsorUserId}`);
      if (m.length !== 1 || m[0].role !== 'admin' || !u[0]?.email_verified_at) throw new S2sRepositoryError('service_access_denied');
      if (input.serviceId !== S2S_SERVICE_ID) throw new S2sRepositoryError('service_access_denied');
      const now = hooks.clock?.() ?? Date.now();
      const boundedExpiry = new Date(Math.min(input.expiresAt.getTime(), now + 90 * 24 * 60 * 60 * 1000));
      const credentialExpiry = new Date(Math.min(input.credentialExpiresAt.getTime(), boundedExpiry.getTime()));
      if (boundedExpiry.getTime() <= now) throw new S2sRepositoryError('service_auth_required');
      await tx.execute(sql`UPDATE ${s2sServiceGrants} SET revoked_at=now() WHERE sponsor_membership_id=${input.sponsorMembershipId} AND revoked_at IS NULL`);
      await tx.execute(sql`UPDATE ${s2sServiceCredentials} SET revoked_at=now() WHERE grant_id IN (SELECT id FROM ${s2sServiceGrants} WHERE sponsor_membership_id=${input.sponsorMembershipId}) AND revoked_at IS NULL`);
      const [grant] = await tx.insert(s2sServiceGrants).values({ serviceId: input.serviceId, houseId: input.houseId, sponsorUserId: input.sponsorUserId, sponsorMembershipId: input.sponsorMembershipId, scope: 'dinner-context:read', expiresAt: boundedExpiry }).returning();
      await tx.insert(s2sServiceCredentials).values({ keyId: input.keyId, grantId: grant.id, secretDigest: digest(input.secret), expiresAt: credentialExpiry });
      await hooks.afterCredentialWrite?.();
      return grant;
    });
  },
  async issueOrRotate(grantId: string, keyId: string, secret: string, expiresAt: Date) {
    return runAdminTransaction(async (tx: any) => {
      await setAdminTransactionTimeouts(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${keyId}))`);
      const g = await tx.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, grantId));
      if (!g[0]) throw new S2sRepositoryError('service_auth_required');
      await tx.execute(sql`SELECT id FROM ${users} WHERE id=${g[0].sponsorUserId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${houses} WHERE id=${g[0].houseId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${houseMemberships} WHERE id=${g[0].sponsorMembershipId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${s2sServiceGrants} WHERE id=${grantId} FOR UPDATE`);
      const checked = await tx.execute(sql`SELECT g.revoked_at AS "revokedAt", g.expires_at AS "grantExpiresAt", u.email_verified_at AS "verifiedAt", m.role, m.id AS "membershipId" FROM ${s2sServiceGrants} g LEFT JOIN ${users} u ON u.id=g.sponsor_user_id LEFT JOIN ${houseMemberships} m ON m.id=g.sponsor_membership_id WHERE g.id=${grantId}`);
      const grant = checked[0] as any;
      const now = hooks.clock?.() ?? Date.now();
      if (!grant || grant.revokedAt || new Date(grant.grantExpiresAt).getTime() <= now) throw new S2sRepositoryError('service_auth_required');
      if (!grant.verifiedAt || grant.role !== 'admin' || grant.membershipId !== g[0].sponsorMembershipId) throw new S2sRepositoryError('service_access_denied');
      const boundedExpiry = new Date(Math.min(expiresAt.getTime(), new Date(grant.grantExpiresAt).getTime(), now + 90 * 24 * 60 * 60 * 1000));
      if (boundedExpiry.getTime() <= now) throw new S2sRepositoryError('service_auth_required');
      const live = await tx.execute(sql`SELECT key_id AS "keyId", created_at AS "createdAt" FROM ${s2sServiceCredentials} WHERE grant_id=${grantId} AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at ASC FOR UPDATE`);
      if (live.length) await tx.execute(sql`UPDATE ${s2sServiceCredentials} SET expires_at=LEAST(expires_at, now() + interval '24 hours') WHERE grant_id=${grantId} AND revoked_at IS NULL AND expires_at > now()`);
      if (live.length >= 2) await tx.execute(sql`UPDATE ${s2sServiceCredentials} SET revoked_at=now() WHERE key_id=${live[0].keyId}`);
      await tx.insert(s2sServiceCredentials).values({ keyId, grantId, secretDigest: digest(secret), expiresAt: boundedExpiry });
      await hooks.afterCredentialWrite?.();
      return { expiresAt: boundedExpiry };
    });
  },
  async revoke(grantId: string) {
    return runAdminTransaction(async (tx: any) => {
      await setAdminTransactionTimeouts(tx);
      const rows = await tx.select().from(s2sServiceGrants).where(eq(s2sServiceGrants.id, grantId));
      if (!rows[0]) return;
      const g = rows[0];
      await tx.execute(sql`SELECT id FROM ${users} WHERE id=${g.sponsorUserId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${houses} WHERE id=${g.houseId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${houseMemberships} WHERE id=${g.sponsorMembershipId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM ${s2sServiceGrants} WHERE id=${grantId} FOR UPDATE`);
      await tx.update(s2sServiceGrants).set({ revokedAt: new Date() }).where(eq(s2sServiceGrants.id, grantId));
      await tx.update(s2sServiceCredentials).set({ revokedAt: new Date() }).where(and(eq(s2sServiceCredentials.grantId, grantId), sql`${s2sServiceCredentials.revokedAt} IS NULL`));
    });
  },
  };
};
