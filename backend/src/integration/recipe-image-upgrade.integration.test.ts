import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/client.js';
import { runImageTick } from '../recipeImages/repository.js';

const url = process.env.INTEGRATION_RECIPE_IMAGE_UPGRADE_DATABASE_URL;
(url ? describe : describe.skip)('recipe image migration 0020 → 0021', () => {
  it('fences v2 workers, quarantines old jobs, and preserves v2 assets and quota', async () => {
    const database = createDatabase(url!);
    const { db } = database;
    const beforeV3 = await mkdtemp(join(tmpdir(), 'ikuck-before-image-v3-'));
    const migrationsFolder = 'src/db/migrations';
    try {
      const [existing] = await db.execute(sql`SELECT to_regclass('public.users') AS users`);
      expect(existing.users, 'The upgrade test requires its own fresh disposable database').toBeNull();
      const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 20);
      await mkdir(join(beforeV3, 'meta'));
      await writeFile(join(beforeV3, 'meta', '_journal.json'), JSON.stringify(journal));
      for (const { tag } of journal.entries) await cp(join(migrationsFolder, `${tag}.sql`), join(beforeV3, `${tag}.sql`));
      await migrate(db, { migrationsFolder: beforeV3 });

      const rows = await db.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe,state,attempts,dispatched_at,updated_at) VALUES
        ('untouched-pending','{}','pending',0,NULL,now()),
        ('interrupted','{}','processing',2,'2026-11-01T11:00:00Z',now()-interval '20 minutes'),
        ('quota-wait','{}','quota_exceeded',3,'2026-11-01T12:00:00Z',now()),
        ('consent-wait','{}','consent_required',0,NULL,now()),
        ('ready-openai','{}','ready',1,'2026-11-01T13:00:00Z',now()),
        ('ready-pexels','{}','ready',1,NULL,now()),
        ('ready-wikimedia','{}','ready',1,NULL,now()) RETURNING id,catalog_id,dispatched_at`);
      const jobs = Object.fromEntries(rows.map(row => [String(row.catalog_id), row]));
      const oldAssets = [
        { id: jobs['ready-openai'].id, bytes: Buffer.from('openai-webp-v2'), source: 'ai', author: 'openai', sourceUrl: '', license: '', model: 'gpt-image-2.5-flare' },
        { id: jobs['ready-pexels'].id, bytes: Buffer.from('pexels-webp-v2'), source: 'pexels', author: 'Artist', sourceUrl: 'https://www.pexels.com/photo/123', license: 'https://www.pexels.com/license/', model: null },
        { id: jobs['ready-wikimedia'].id, bytes: Buffer.from('commons-webp-v2'), source: 'wikimedia', author: 'Photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Soup.jpg', license: 'https://creativecommons.org/publicdomain/zero/1.0/', model: 'commons-cc0-v2' },
      ];
      for (const asset of oldAssets) {
        await db.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license,model)
          VALUES(${asset.id},${asset.bytes},${asset.source},16,16,${asset.source},${asset.author},${asset.sourceUrl},${asset.license},${asset.model})`);
      }
      await db.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES('catalog',CURRENT_DATE,2)`);

      const config = { enabled: true, provider: 'openai' as const, apiKey: 'test', model: 'gpt-image-2.5-flare', dailyLimit: 5 };
      const provider = { generate: vi.fn() };
      await expect(runImageTick(db, config, provider, String(jobs['untouched-pending'].id)))
        .rejects.toMatchObject({ cause: { code: '42883' } });
      expect(provider.generate).not.toHaveBeenCalled();

      await migrate(db, { migrationsFolder });
      await migrate(db, { migrationsFolder });

      const oldWorkerClaim = sql`UPDATE recipe_image_jobs SET state='processing' WHERE id=${jobs['untouched-pending'].id} AND state='failed'`;
      await expect(db.transaction(async tx => {
        await tx.execute(sql`SELECT public.set_recipe_image_policy_v2()`);
        await tx.execute(oldWorkerClaim);
      })).rejects.toMatchObject({ cause: { code: '55000' } });
      await expect(db.transaction(async tx => {
        await tx.execute(sql`SELECT public.set_recipe_image_policy_v2()`);
        await tx.execute(sql`UPDATE recipe_image_jobs SET dispatched_at=clock_timestamp() WHERE id=${jobs['untouched-pending'].id} AND dispatched_at IS NULL`);
      })).rejects.toMatchObject({ cause: { code: '55000' } });

      const quarantined = await db.execute(sql`SELECT catalog_id,state,attempts,dispatched_at FROM recipe_image_jobs
        WHERE catalog_id IN ('untouched-pending','interrupted','quota-wait','consent-wait') ORDER BY catalog_id`);
      expect(quarantined.map(row => [row.catalog_id, row.state])).toEqual([
        ['consent-wait', 'failed'],
        ['interrupted', 'failed'],
        ['quota-wait', 'failed'],
        ['untouched-pending', 'failed'],
      ]);
      expect(Number(quarantined.find(row => row.catalog_id === 'interrupted')?.attempts)).toBe(2);
      expect(quarantined.find(row => row.catalog_id === 'interrupted')?.dispatched_at).toBe(jobs.interrupted.dispatched_at);
      expect(Number(quarantined.find(row => row.catalog_id === 'quota-wait')?.attempts)).toBe(3);
      expect(quarantined.find(row => row.catalog_id === 'quota-wait')?.dispatched_at).toBe(jobs['quota-wait'].dispatched_at);
      expect(Number((await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal='catalog'`))[0].used)).toBe(2);

      const retained = await db.execute(sql`SELECT a.job_id,a.content,a.source,a.author,a.source_url,a.license,a.model,j.state
        FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id ORDER BY a.source`);
      expect(retained).toHaveLength(oldAssets.length);
      for (const expected of oldAssets) {
        const actual = retained.find(asset => String(asset.job_id) === String(expected.id));
        expect(actual).toMatchObject({
          content: expected.bytes,
          source: expected.source,
          author: expected.author,
          source_url: expected.sourceUrl,
          license: expected.license,
          model: expected.model,
          state: 'ready',
        });
      }

      const legacyTriggers = await db.execute(sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
        AND tgname IN ('sync_recipe_image','sync_image_consent')`);
      expect(legacyTriggers).toEqual([]);
      const [legacyQueueFunction] = await db.execute(sql`SELECT to_regprocedure('public.queue_recipe_image()') AS fn`);
      expect(legacyQueueFunction.fn).toBeNull();
      await runImageTick(db, config, provider, String(jobs.interrupted.id));
      expect(provider.generate).not.toHaveBeenCalled();
    } finally {
      await database.close();
      await rm(beforeV3, { recursive: true, force: true });
    }
  });
});