import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { users } from '../db/schema.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('meal plan capability pagination in PostgreSQL', () => {
  const database = createDatabase(url!);
  const userId = randomUUID();
  const repository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });

  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations') });
    await database.db.insert(users).values({ id: userId, email: `plan-page-${userId}@example.com`, emailVerifiedAt: new Date() });
  });
  afterAll(async () => { await database.close(); });

  it('returns legacy changes beyond 200 unsupported meal plan rows', async () => {
    await expect(repository.isMealPlanV2Enabled()).resolves.toBe(true);
    for (let index = 0; index < 201; index += 1) {
      const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
      await repository.applyMealPlanCommand(userId, {
        version: 2, scope: `account:${userId}`, date, operationId: randomUUID(),
        deviceId: 'plan-page-device', action: 'auto_create', recipeId: `recipe-${index}`,
        baseRevision: null, clientUpdatedAt: '2025-01-01T00:00:00.000Z',
      });
    }
    await repository.applyMutation(userId, {
      mutationId: randomUUID(), deviceId: 'plan-page-device', entityType: 'pantry_item', entityId: 'tomato',
      operation: 'upsert', payload: { id: 'tomato', label: 'Tomato', known: true },
      clientUpdatedAt: '2025-01-01T00:00:00.000Z', syncScope: `account:${userId}`,
    });
    const page = await repository.readChanges(userId, 0, 200, `account:${userId}`, ['pantry_item']);
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ entityType: 'pantry_item', entityId: 'tomato' });
    await expect(repository.readChanges(userId, page[0].serverSequence, 200, `account:${userId}`, ['pantry_item'])).resolves.toEqual([]);
  });
});
