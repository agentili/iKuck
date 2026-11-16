import Fastify from 'fastify';
import { imageRoutes } from '../recipeImages/routes.js';
import type { AuthService } from '../auth/service.js';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createDatabase } from '../db/client.js';
import { runImageTick as tick } from '../recipeImages/repository.js';
import { ImageProviderError } from '../recipeImages/providers.js';
const url = process.env.INTEGRATION_DATABASE_URL;
(url ? describe : describe.skip)('recipe image persistence', () => {
  const database = createDatabase(url!, { max: 5 });
  const db = database.db;
  const userId = randomUUID();
  const config = { enabled: true, provider: 'openai' as const, apiKey: 'test', searchKey: 'test', model: 'test', visionModel: 'test', dailyLimit: 5 };
  const runImageTick = async () => {
    const [job] = await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${userId} AND state='pending' ORDER BY available_at LIMIT 1`);
    if (job) await tick(db,config,provider,String(job.id));
  };
  const result = { bytes: Buffer.from('test-binary'), width: 10, height: 10, source: 'ai' as const, author: 'openai', sourceUrl: '', license: '' };
  const provider = { search: vi.fn().mockResolvedValue(null), generate: vi.fn().mockResolvedValue(result) };
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'src/db/migrations' });
    await db.execute(sql`INSERT INTO users(id,email) VALUES(${userId},${`${userId}@images.test`})`);
  });
  afterAll(async () => { await db.execute(sql`DELETE FROM sync_items WHERE scope_id=${userId}`); await db.execute(sql`DELETE FROM users WHERE id=${userId}`); await db.execute(sql`DELETE FROM recipe_image_quota WHERE principal=${userId}`); await database.close(); });
  const save = async (entityType: string, id: string, payload: unknown) => db.execute(sql`INSERT INTO sync_items(user_id,scope_type,scope_id,entity_type,entity_id,device_id,payload,client_updated_at,mutation_id) VALUES(${userId},'user',${userId},${entityType},${id},'test',${JSON.stringify(payload)}::jsonb,now(),${randomUUID()}) ON CONFLICT(scope_type,scope_id,entity_type,entity_id) DO UPDATE SET payload=excluded.payload`);
  it('queues atomically, waits for consent, resumes and persists binary without changing the recipe', async () => {
    await save('generated_recipe', 'image-recipe', { title: 'Pasta', ingredients: [{ name: 'Pasta' }] });
    await runImageTick();
    let rows = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE user_id=${userId}`);
    expect(rows[0].state).toBe('consent_required'); expect(provider.search).not.toHaveBeenCalled();
    await save('ai_consent','profile',{ enabled: true, homeProvider: 'openai', imagePolicyVersion: 'recipe-images-v1' });
    await Promise.all([runImageTick(),runImageTick()]);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    rows = await db.execute(sql`SELECT a.content,j.state FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id WHERE j.user_id=${userId}`);
    expect(rows[0].state).toBe('ready'); expect(Buffer.from(rows[0].content as Uint8Array)).toEqual(result.bytes);
    await db.execute(sql`UPDATE sync_items SET deleted=true,payload=NULL WHERE scope_id=${userId} AND entity_id='image-recipe'`);
    expect((await db.execute(sql`SELECT * FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id WHERE j.user_id=${userId}`)).length).toBe(0);
  });
  it('does not automatically repeat an ambiguous paid generation', async () => {
    provider.generate.mockRejectedValueOnce(new ImageProviderError(true));
    await save('saved_recipe', 'ambiguous', { title: 'Rice', ingredients: [{ name: 'Rice' }] });
    await runImageTick();
    const rows = await db.execute(sql`SELECT state,dispatched_at FROM recipe_image_jobs WHERE user_id=${userId}`);
    expect(rows[0].state).toBe('failed'); expect(rows[0].dispatched_at).not.toBeNull();
    const count = provider.generate.mock.calls.length;
    await runImageTick(); expect(provider.generate).toHaveBeenCalledTimes(count);
  });
  it('enforces the daily generation quota before dispatch', async () => {
    await db.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES(${userId},CURRENT_DATE,5) ON CONFLICT(principal,day) DO UPDATE SET used=5`);
    await save('generated_recipe','over-quota',{ title: 'Soup', ingredients: [{ name: 'Soup' }] });
    const calls = provider.generate.mock.calls.length;
    await runImageTick();
    const [row] = await db.execute(sql`SELECT state FROM recipe_image_jobs j JOIN sync_items s ON s.id=j.sync_item_id WHERE s.entity_id='over-quota' AND j.user_id=${userId}`);
    expect(row.state).toBe('quota_exceeded'); expect(provider.generate).toHaveBeenCalledTimes(calls);
  });
  it('never serves another user private assets, and marks authorized binaries no-store', async () => {
    vi.stubEnv('RECIPE_IMAGES_ENABLED','true'); vi.stubEnv('PEXELS_API_KEY','test'); vi.stubEnv('OPENAI_API_KEY','test'); vi.stubEnv('RECIPE_IMAGE_MODEL','test'); vi.stubEnv('RECIPE_IMAGE_VISION_MODEL','test');
    const [job] = await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${userId} LIMIT 1`);
    await db.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license) VALUES(${String(job.id)},${result.bytes},'hash',10,10,'ai','test','','') ON CONFLICT DO NOTHING`);
    const auth = { authenticate: async (token: string) => ({ id: 'test', userId: token === 'owner' ? userId : randomUUID(), email: 'test@example.com', emailVerifiedAt: new Date(), csrfTokenHash: 'test', expiresAt: new Date('2099-01-01') }) } as unknown as AuthService;
    const app = Fastify(); await app.register(imageRoutes(db,auth,'https://example.com'));
    try {
      const forbidden = await app.inject({ url: `/v1/recipe-images/assets/${job.id}`, headers: { cookie: 'ikuck_session=other' } });
      expect(forbidden.statusCode).toBe(404);
      const allowed = await app.inject({ url: `/v1/recipe-images/assets/${job.id}`, headers: { cookie: 'ikuck_session=owner' } });
      expect(allowed.statusCode).toBe(200); expect(allowed.headers['cache-control']).toBe('private, no-store'); expect(allowed.rawPayload).toEqual(result.bytes);
    } finally { await app.close(); vi.unstubAllEnvs(); }
  });

});
