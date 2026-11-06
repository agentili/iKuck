import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import { decideQuota } from './chefChatQuota.js';
import type { QuotaCounts, QuotaReservation } from './chefChatQuota.js';

export function createChefChatQuotaStore(db: ApplicationDatabase['db']) {
  async function transition(id: string, token: string, from: 'reserved' | 'dispatched', to: 'dispatched' | 'cancelled' | 'settled' | 'quarantined'): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        const control = await tx.execute<{ enabled: boolean }>(sql`SELECT enabled FROM chef_chat_control WHERE id = 1 FOR UPDATE`);
        if (!control[0]) return false;
        if (to === 'dispatched' && !control[0].enabled) return false;
        const result = await tx.execute(sql`
          UPDATE chef_chat_operations SET state = ${to}, created_at = CASE WHEN ${to} = 'dispatched' THEN clock_timestamp() ELSE created_at END
          WHERE id = ${id}::uuid AND token = ${token}::uuid AND state = ${from}
          RETURNING id`);
        if (result.length === 1) return true;
        if (to === 'dispatched') return false;
        const existing = await tx.execute(sql`SELECT id FROM chef_chat_operations WHERE id = ${id}::uuid AND token = ${token}::uuid AND state = ${to}`);
        return existing.length === 1;
      });
    } catch {
      return false;
    }
  }
  return {
    async cleanup(): Promise<number> {
      return db.transaction(async (tx) => {
        const control = await tx.execute(sql`SELECT id FROM chef_chat_control WHERE id = 1 FOR UPDATE`);
        if (!control.length) throw new Error('Quota control unavailable');
        const deleted = await tx.execute(sql`
          DELETE FROM chef_chat_operations
          WHERE state IN ('settled', 'cancelled')
            AND created_at < date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            AND created_at < clock_timestamp() - interval '60 seconds'
          RETURNING id`);
        return deleted.length;
      });
    },
    dispatch: (id: string, token: string) => transition(id, token, 'reserved', 'dispatched'),
    cancel: (id: string, token: string) => transition(id, token, 'reserved', 'cancelled'),
    settle: (id: string, token: string) => transition(id, token, 'dispatched', 'settled'),
    quarantine: (id: string, token: string) => transition(id, token, 'dispatched', 'quarantined'),
    async reserve(userId: string): Promise<QuotaReservation> {
      try {
        return await db.transaction(async (tx) => {
          const user = await tx.execute(sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`);
          if (!user.length) return { kind: 'unavailable' };
          const control = await tx.execute<{ enabled: boolean }>(sql`SELECT enabled FROM chef_chat_control WHERE id = 1 FOR UPDATE`);
          if (!control[0]?.enabled) return { kind: 'unavailable' };
          const rows = await tx.execute<QuotaCounts>(sql`
            SELECT
              count(*) FILTER (WHERE state IN ('reserved','dispatched','quarantined') AND user_id = ${userId}::uuid)::int AS active_user,
              count(*) FILTER (WHERE state IN ('reserved','dispatched','quarantined'))::int AS active_global,
              count(*) FILTER (WHERE user_id = ${userId}::uuid AND state <> 'cancelled' AND created_at >= date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS daily,
              count(*) FILTER (WHERE user_id = ${userId}::uuid AND state <> 'cancelled' AND created_at > statement_timestamp() - interval '60 seconds')::int AS minute,
              greatest(1, ceil(extract(epoch from (min(created_at) FILTER (WHERE user_id = ${userId}::uuid AND state <> 'cancelled' AND created_at > statement_timestamp() - interval '60 seconds') + interval '60 seconds' - statement_timestamp()))))::int AS minute_retry,
              greatest(1, ceil(extract(epoch from (date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' - statement_timestamp())))::int AS day_retry
            FROM chef_chat_operations`);
          const counts = rows[0];
          if (!counts) throw new Error('Quota counts missing');
          const decision = decideQuota(counts);
          if (decision.kind === 'limited') return decision;
          const operationId = randomUUID();
          const token = randomUUID();
          await tx.execute(sql`INSERT INTO chef_chat_operations (id, user_id, token, state, created_at) VALUES (${operationId}::uuid, ${userId}::uuid, ${token}::uuid, 'reserved', clock_timestamp())`);
          return { kind: 'allowed', operationId, token };
        });
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
