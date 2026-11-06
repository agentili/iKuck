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

integration('meal plan account isolation in PostgreSQL', () => {
  const database = createDatabase(url!);
  const owner = randomUUID();
  const other = randomUUID();
  const repository = createDrizzleSyncRepository(database.db);
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations') });
    await database.db.insert(users).values([owner, other].map((id) => ({ id, email: `plan-isolation-${id}@example.com`, emailVerifiedAt: new Date() })));
  });
  afterAll(async () => { await database.close(); });

  it('does not expose an account meal plan to a different account', async () => {
    const date = '2026-11-03';
    await repository.applyMealPlanCommand(owner, {
      version: 2, scope: `account:${owner}`, date, operationId: randomUUID(),
      deviceId: 'owner-device', action: 'manual_set', recipeId: 'private-recipe',
      clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    const ownerChanges = await repository.readChanges(owner, 0, 200, `account:${owner}`, ['meal_plan_entry']);
    expect(ownerChanges).toHaveLength(1);
    await expect(repository.readChanges(other, 0, 200, `account:${other}`, ['meal_plan_entry'])).resolves.toEqual([]);
  });
});
