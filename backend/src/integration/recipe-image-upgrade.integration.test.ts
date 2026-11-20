import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/client.js';
import { runImageTick } from '../recipeImages/repository.js';

const url = process.env.INTEGRATION_RECIPE_IMAGE_UPGRADE_DATABASE_URL;
(url ? describe : describe.skip)('recipe image migration 0019 → 0020', () => {
  it('blocks the new worker on 0019 and quarantines old dispatches on upgrade without refund or replay', async () => {
    const database = createDatabase(url!);
    const { db } = database;
    const beforeV2 = await mkdtemp(join(tmpdir(), 'ikuck-before-image-v2-'));
    const migrationsFolder = 'src/db/migrations';
    try {
      const [existing] = await db.execute(sql`SELECT to_regclass('public.users') AS users`);
      expect(existing.users, 'The upgrade test requires its own fresh disposable database').toBeNull();
      const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 20);
      await mkdir(join(beforeV2, 'meta'));
      await writeFile(join(beforeV2, 'meta', '_journal.json'), JSON.stringify(journal));
      for (const { tag } of journal.entries) await cp(join(migrationsFolder, `${tag}.sql`), join(beforeV2, `${tag}.sql`));
      await migrate(db, { migrationsFolder: beforeV2 });
      const rows = await db.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe,state,attempts,dispatched_at,updated_at) VALUES
        ('still-pending','{}','pending',0,NULL,now()),
        ('interrupted','{}','processing',2,now(),now()-interval '20 minutes'),
        ('old-commons','{}','ready',1,NULL,now()),
        ('legacy-pexels','{}','ready',1,NULL,now()) RETURNING id,catalog_id,dispatched_at`);
      const jobs = Object.fromEntries(rows.map(row => [String(row.catalog_id), row]));
      await db.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license) VALUES
        (${jobs['old-commons'].id},${Buffer.from('old')},'test',10,10,'wikimedia','Name','https://commons.wikimedia.org/wiki/File:Old.jpg','https://creativecommons.org/publicdomain/zero/1.0/'),
        (${jobs['legacy-pexels'].id},${Buffer.from('old')},'test',10,10,'pexels','Name','https://www.pexels.com/photo/old-1/','https://www.pexels.com/license/')`);
      await db.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES('catalog',CURRENT_DATE,2)`);
      const config = { enabled: true, provider: 'openai' as const, apiKey: 'test', model: 'test', visionModel: 'test', dailyLimit: 5 };
      const provider = { search: vi.fn(), generate: vi.fn() };
      await expect(runImageTick(db, config, provider, String(jobs['still-pending'].id))).rejects.toMatchObject({ cause: { code: '42883' } });
      expect(provider.search).not.toHaveBeenCalled();
      const [old] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${jobs.interrupted.id}`);
      expect(old.state).toBe('processing');

      await migrate(db, { migrationsFolder });
      await migrate(db, { migrationsFolder });
      const [interrupted] = await db.execute(sql`SELECT state,attempts,dispatched_at FROM recipe_image_jobs WHERE id=${jobs.interrupted.id}`);
      expect(interrupted).toMatchObject({ state: 'failed', dispatched_at: jobs.interrupted.dispatched_at });
      expect(Number(interrupted.attempts)).toBe(2);
      const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal='catalog'`);
      expect(Number(quota.used)).toBe(2);
      const [commons] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${jobs['old-commons'].id}`);
      expect(commons.state).toBe('failed');
      expect((await db.execute(sql`SELECT source FROM recipe_image_assets`)).map(row => row.source)).toEqual(['pexels']);
      await runImageTick(db, config, provider, String(jobs.interrupted.id));
      expect(provider.search).not.toHaveBeenCalled();
      expect(provider.generate).not.toHaveBeenCalled();
    } finally {
      await database.close();
      await rm(beforeV2, { recursive: true, force: true });
    }
  });
});
