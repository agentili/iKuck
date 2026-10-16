import { eq, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import { bringConnections, users } from '../db/schema.js';
import { createDispatchCapacityGate, type DispatchCapacityGate } from '../sync/dispatchCapacity.js';
import { BringError } from './errors.js';

export interface ConnectionRecord {
  connectionId: string;
  encryptedSession: string;
  connectedAt: string;
}

export interface ConnectionUnit {
  get: () => Promise<ConnectionRecord | null>;
  put: (record: ConnectionRecord) => Promise<void>;
  remove: () => Promise<void>;
}

export interface BringRepository {
  withUser: <T>(userId: string, work: (unit: ConnectionUnit) => Promise<T>) => Promise<T>;
}

const dispatchGates = new WeakMap<object, DispatchCapacityGate>();

const dispatchGateFor = (database: ApplicationDatabase['db']): DispatchCapacityGate => {
  const client = database.$client as object;
  const existing = dispatchGates.get(client);
  if (existing !== undefined) return existing;

  const gate = createDispatchCapacityGate(database.$client.options.max, {
    maxQueueSize: 8,
    waitTimeoutMs: 1_000,
  });
  dispatchGates.set(client, gate);
  return gate;
};

export const createMemoryBringRepository = (): BringRepository => {
  const rows = new Map<string, ConnectionRecord>();
  const busy = new Set<string>();

  return {
    withUser: async (userId, work) => {
      if (busy.has(userId)) throw new BringError('bring_busy', 409);
      busy.add(userId);
      const stored = rows.get(userId);
      let current = stored === undefined ? null : { ...stored };

      try {
        const result = await work({
          get: async () => current === null ? null : { ...current },
          put: async (record) => { current = { ...record }; },
          remove: async () => { current = null; },
        });
        if (current === null) rows.delete(userId);
        else rows.set(userId, current);
        return result;
      } finally {
        busy.delete(userId);
      }
    },
  };
};

export const createDrizzleBringRepository = (database: ApplicationDatabase['db']): BringRepository => {
  const slots = dispatchGateFor(database);

  return {
    withUser: async (userId, work) => {
      let release: (() => void) | undefined;
      try {
        release = await slots.acquire();
        return await database.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL lock_timeout = '2s'`);
          await transaction.execute(sql`SET LOCAL statement_timeout = '5s'`);

          const [owner] = await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
            .for('key share');
          if (owner === undefined) throw new BringError('bring_not_connected', 409);

          const lock = await transaction.execute<{ acquired: boolean }>(sql`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${`ikuck:bring:${userId}`}, 0)) AS acquired
          `);
          if (!lock[0]?.acquired) throw new BringError('bring_busy', 409);

          return work({
            get: async () => {
              const [record] = await transaction
                .select()
                .from(bringConnections)
                .where(eq(bringConnections.userId, userId))
                .limit(1);
              return record === undefined ? null : {
                connectionId: record.connectionId,
                encryptedSession: record.encryptedSession,
                connectedAt: record.connectedAt.toISOString(),
              };
            },
            put: async (record) => {
              const values = {
                userId,
                connectionId: record.connectionId,
                encryptedSession: record.encryptedSession,
                connectedAt: new Date(record.connectedAt),
                recentlyWatermarkAt: null,
                recentlySnapshot: null,
              };
              await transaction
                .insert(bringConnections)
                .values(values)
                .onConflictDoUpdate({ target: bringConnections.userId, set: values });
            },
            remove: async () => {
              await transaction.delete(bringConnections).where(eq(bringConnections.userId, userId));
            },
          });
        });
      } catch (error) {
        if (error instanceof BringError) throw error;
        throw new BringError(release === undefined ? 'bring_busy' : 'bring_unavailable', 503);
      } finally {
        release?.();
      }
    },
  };
};
