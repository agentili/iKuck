import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { houses, pushPreferences, users } from '../db/schema.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createPushRepository } from '../push/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('fixed UTC persistence policy', () => {
  const database = createDatabase(url!);
  const owner = randomUUID();
  let houseId: string;
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations') });
    await database.db.insert(users).values({ id: owner, email: `${owner}@utc.test`, emailVerifiedAt: new Date() });
  });
  afterAll(async () => {
    await database.db.delete(users).where(eq(users.id, owner));
    if (houseId) await database.db.delete(houses).where(eq(houses.id, houseId));
    await database.close();
  });

  it('creates UTC houses server-side and forbids non-UTC or unset values in PostgreSQL', async () => {
    const repository = createDrizzleHouseRepository(database.db);
    const created = await repository.createHouse({ name: 'UTC house', userId: owner, now: new Date() });
    houseId = created.house.id;
    expect(created.house).toMatchObject({ timeZone: 'UTC', timeZoneRevision: expect.any(String) });
    for (const timeZone of ['Europe/Rome', 'America/New_York', null]) {
      await expect(database.db.execute(sql`UPDATE houses SET time_zone = ${timeZone} WHERE id = ${houseId}`)).rejects.toThrow();
    }
    expect(await repository.getTimeZoneForUser(owner)).toMatchObject({ state: { timeZone: 'UTC' } });
  });

  it('defaults personal notifications to UTC and ignores legacy zones at the repository boundary', async () => {
    const repository = createPushRepository(database.db);
    expect(await repository.status(owner)).toMatchObject({ preferences: { timeZone: 'UTC' }, effectiveTimeZone: 'UTC' });
    await repository.savePreferences(owner, { enabled: true, fridayTime: '19:00', timeZone: 'Europe/Rome' });
    const [stored] = await database.db.select().from(pushPreferences).where(eq(pushPreferences.userId, owner));
    expect(stored).toMatchObject({ enabled: true, fridayTime: '19:00', timeZone: 'UTC' });
    await expect(database.db.execute(sql`UPDATE push_preferences SET time_zone = 'Europe/Rome' WHERE user_id = ${owner}`)).rejects.toThrow();
  });

  it('migrates legacy and unset zones before enforcing UTC without shifting stored dates or reminder times', async () => {
    const migration = await readFile(new URL('../db/migrations/0019_fixed_utc.sql', import.meta.url), 'utf8');
    const namespace = `utc_${randomUUID().replaceAll('-', '')}`;
    const oldRevision = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA ${namespace}`));
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${namespace}`));
      await tx.execute(sql`CREATE TABLE houses (id integer PRIMARY KEY, time_zone text, time_zone_revision uuid, updated_at timestamptz DEFAULT now())`);
      await tx.execute(sql`CREATE TABLE push_preferences (enabled boolean, friday_time text, time_zone text NOT NULL)`);
      await tx.execute(sql`CREATE TABLE push_deliveries (status text)`);
      await tx.execute(sql`CREATE TABLE meal_plan_states (plan_date date)`);
      await tx.execute(sql`INSERT INTO houses (id, time_zone, time_zone_revision) VALUES (1, NULL, NULL), (2, 'Europe/Rome', ${oldRevision}), (3, 'UTC', ${oldRevision})`);
      await tx.execute(sql`INSERT INTO push_preferences VALUES (true, '19:00', 'Europe/Rome'), (false, '23:30', 'America/New_York')`);
      await tx.execute(sql`INSERT INTO meal_plan_states VALUES ('2030-01-07')`);
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      const rows = await tx.execute<{ id: number; time_zone: string; time_zone_revision: string }>(sql`SELECT * FROM houses ORDER BY id`);
      expect(rows.map(row => row.time_zone)).toEqual(['UTC', 'UTC', 'UTC']);
      expect(rows[0].time_zone_revision).toEqual(expect.any(String));
      expect(rows[1].time_zone_revision).not.toBe(oldRevision);
      expect(rows[2].time_zone_revision).toBe(oldRevision);
      expect([...(await tx.execute(sql`SELECT * FROM push_preferences ORDER BY friday_time`))]).toEqual([
        { enabled: true, friday_time: '19:00', time_zone: 'UTC' },
        { enabled: false, friday_time: '23:30', time_zone: 'UTC' },
      ]);
      expect((await tx.execute<{ date: string }>(sql`SELECT plan_date::text AS date FROM meal_plan_states`))[0].date).toBe('2030-01-07');
      await tx.execute(sql.raw(`DROP SCHEMA ${namespace} CASCADE`));
    });
  });
});
