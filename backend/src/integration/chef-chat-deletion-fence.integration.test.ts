import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChefChatQuotaStore } from '../ai/chefChatQuotaStore.js';
import { createDatabase } from '../db/client.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

suite('chef chat account deletion fence', () => {
  const database = createDatabase(databaseUrl ?? 'postgres://unused');
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder });
    await database.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET enabled = true`);
  });
  afterAll(async () => { await database.close(); });

  it('does not admit a reservation for an account that does not exist', async () => {
    const result = await createChefChatQuotaStore(database.db).reserve(randomUUID());
    expect(result).toEqual({ kind: 'unavailable' });
  });
});
