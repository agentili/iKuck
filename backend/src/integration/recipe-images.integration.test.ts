import Fastify from 'fastify';
import { imageRoutes } from '../recipeImages/routes.js';
import type { AuthService } from '../auth/service.js';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { createDatabase } from '../db/client.js';
import { runImageTick as tick } from '../recipeImages/repository.js';
import { ImageProviderError } from '../recipeImages/providers.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';
import { COMMONS_ASSET_PROVENANCE } from '../recipeImages/generation.js';
import sharp from 'sharp';
const url = process.env.INTEGRATION_DATABASE_URL;
(url ? describe : describe.skip)('recipe image persistence', () => {
  const database = createDatabase(url!, { max: 5 });
  const db = database.db;
  const userId = randomUUID();
  const config = { enabled: true, provider: 'openai' as const, apiKey: 'test', model: 'test', visionModel: 'test', dailyLimit: 5 };
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
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM sync_items WHERE user_id=${userId}::uuid`);
    await db.execute(sql`DELETE FROM recipe_image_jobs WHERE user_id=${userId}::uuid`);
    await db.execute(sql`DELETE FROM recipe_image_quota WHERE principal=${userId}`);
    provider.search.mockReset().mockResolvedValue(null);
    provider.generate.mockReset().mockResolvedValue(result);
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM sync_items WHERE scope_id=${userId}`);
    await db.execute(sql`DELETE FROM processed_sync_mutations WHERE scope_type='user' AND scope_id=${userId} AND user_id=${userId}`);
    await db.execute(sql`DELETE FROM users WHERE id=${userId}`);
    await db.execute(sql`DELETE FROM recipe_image_quota WHERE principal=${userId}`);
    await database.close();
  });
  const save = async (entityType: string, id: string, payload: unknown) => db.execute(sql`INSERT INTO sync_items(user_id,scope_type,scope_id,entity_type,entity_id,device_id,payload,client_updated_at,mutation_id) VALUES(${userId},'user',${userId},${entityType},${id},'test',${JSON.stringify(payload)}::jsonb,now(),${randomUUID()}) ON CONFLICT(scope_type,scope_id,entity_type,entity_id) DO UPDATE SET payload=excluded.payload`);
  const grantImageConsent = () => save('ai_consent', 'profile', {
    enabled: true,
    homeProvider: 'openai',
    imagePolicyVersion: 'recipe-images-v2',
    imageProvider: 'openai',
  });
  const enqueue = async (id: string) => {
    await grantImageConsent();
    await save('saved_recipe', id, { title: id, ingredients: [] });
    const [job] = await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${userId} AND recipe->>'title'=${id}`);
    return String(job.id);
  };
  it.each(['pending', 'quota_exceeded'])('fences old %s claims and keeps the marker transaction-local', async state => {
    const id = await enqueue('guard');
    await db.execute(sql`UPDATE recipe_image_jobs SET state=${state},available_at=now()-interval '1 second' WHERE id=${id}`);
    const legacyClaim = () => sql`UPDATE recipe_image_jobs SET state='processing' WHERE id=${id} AND state IN ('pending','quota_exceeded')`;
    await expect(db.execute(legacyClaim())).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('ikuck.recipe_image_policy','recipe-images-v20',true)`);
      await tx.execute(legacyClaim());
    })).rejects.toMatchObject({ cause: { code: '55000' } });
    const single = createDatabase(url!, { max: 1 });
    try {
      await single.db.transaction(async tx => { await tx.execute(sql`SELECT public.set_recipe_image_policy_v2()`); });
      const [marker] = await single.db.execute(sql`SELECT current_setting('ikuck.recipe_image_policy', true) AS value`);
      expect(marker.value).not.toBe('recipe-images-v2');
      await expect(single.db.execute(legacyClaim())).rejects.toMatchObject({ cause: { code: '55000' } });
    } finally { await single.close(); }
  });
  it('rolls back quota and never dispatches when the exact claim becomes stale during search', async () => {
    const id = await enqueue('stale while searching');
    provider.search.mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE recipe_image_jobs SET attempts=attempts+1 WHERE id=${id}`);
      return null;
    });
    await tick(db, config, provider, id);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`)).toHaveLength(0);
    const [job] = await db.execute(sql`SELECT state,attempts,dispatched_at FROM recipe_image_jobs WHERE id=${id}`);
    expect(job).toMatchObject({ state: 'processing', dispatched_at: null });
    expect(Number(job.attempts)).toBe(2);
  });
  it('serializes revocation with an active dispatch and does not dispatch a later private job', async () => {
    const id = await enqueue('dispatch before revoke');
    const next = await enqueue('waiting for revoke');
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<typeof result>();
    provider.generate.mockImplementationOnce(() => { started.resolve(); return release.promise; });
    const processing = tick(db, config, provider, id);
    await Promise.race([started.promise, processing.then(() => { throw new Error('missing dispatch'); })]);
    const repository = createDrizzleSyncRepository(db);
    let revoked = false;
    const revoking = repository.updateAiConsent(userId, { enabled: false }).then(() => { revoked = true; });
    try {
      const [marker] = await db.execute(sql`SELECT dispatched_at FROM recipe_image_jobs WHERE id=${id}`);
      expect(marker.dispatched_at).not.toBeNull();
      expect(revoked).toBe(false);
    } finally { release.resolve(result); await Promise.all([processing, revoking]); }
    await tick(db, config, provider, next);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const [job] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${next}`);
    expect(job.state).toBe('consent_required');
  });
  it('does not reserve quota or generate after a failed Commons/vision lookup', async () => {
    const id = await enqueue('failed lookup');
    provider.search.mockRejectedValueOnce(new ImageProviderError());
    await tick(db, config, provider, id);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`)).toHaveLength(0);
    const [job] = await db.execute(sql`SELECT state,dispatched_at FROM recipe_image_jobs WHERE id=${id}`);
    expect(job).toMatchObject({ state: 'pending', dispatched_at: null });
  });
  const pixel = () => sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
  const unlicensedPage = (index: number) => {
    const file = `Dish_${index}.jpg`;
    const url = `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`;
    return { pageid: index + 100, index, ns: 6, title: `File:Dish ${index}.jpg`, imagerepository: 'local',
      imageinfo: [{ url, thumburl: url, descriptionurl: `https://commons.wikimedia.org/wiki/File:${file}`, thumbwidth: 500, thumbheight: 500 }] };
  };
  const paginatedBatch = (ranks: number[], offset: number) => ({
    batchcomplete: true, continue: { gsroffset: offset, continue: 'gsroffset||' }, query: { pages: ranks.map(unlicensedPage) },
  });
  it.each([
    ['malformed', { batchcomplete: true, query: { pages: [{}] } }, false],
    ['incomplete', { batchcomplete: false, query: { pages: [] } }, false],
    ['missing ranked pages', paginatedBatch([5], 5), false],
    ['impossible continuation offset', paginatedBatch([1, 2, 3, 4, 5], 1000), false],
    ['gap in a final batch', { batchcomplete: true, query: { pages: [unlicensedPage(1), unlicensedPage(3)] } }, false],
    ['complete first batch', paginatedBatch([5, 1, 3, 2, 4], 5), true],
    ['complete short final batch', { batchcomplete: true, query: { pages: [unlicensedPage(2), unlicensedPage(1)] } }, true],
    ['valid empty', { batchcomplete: true }, true],
  ] as const)('runs the real worker on a %s Commons response', async (label, response, dispatch) => {
    const id = await enqueue(label);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: (await pixel()).toString('base64') }] }));
    vi.stubGlobal('fetch', fetch);
    try {
      await tick(db, config, undefined, id);
      const [job] = await db.execute(sql`SELECT state,dispatched_at,available_at>now() AS backing_off FROM recipe_image_jobs WHERE id=${id}`);
      const quota = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
      expect(fetch).toHaveBeenNthCalledWith(1, expect.stringMatching(/^https:\/\/commons\.wikimedia\.org/), expect.anything());
      if (dispatch) {
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.openai.com/v1/images/generations', expect.anything());
        expect(job.state).toBe('ready'); expect(job.dispatched_at).not.toBeNull();
        expect(quota.map(row => Number(row.used))).toEqual([1]);
      } else {
        expect({ requests: fetch.mock.calls.length, job, quota }).toEqual({ requests: 1, job: { state: 'pending', dispatched_at: null, backing_off: true }, quota: [] });
      }
    } finally { vi.unstubAllGlobals(); }
  });
  it('stores and reuses proven Commons credit from a real adapter match without consuming quota', async () => {
    const id = await enqueue('Pizza with mushrooms and cheese');
    const duplicate = await enqueue('Duplicate Commons match');
    await db.execute(sql`UPDATE recipe_image_jobs SET recipe=(SELECT recipe FROM recipe_image_jobs WHERE id=${id}) WHERE id=${duplicate}`);
    const file = 'Pizza_with_mushrooms_and_cheese.jpg';
    const sourceUrl = `https://commons.wikimedia.org/wiki/File:${file}`;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ batchcomplete: true, query: { pages: [{
      pageid: 79703781, ns: 6, title: 'File:Pizza with mushrooms and cheese.jpg', index: 1, imagerepository: 'local',
      imageinfo: [{ url: `https://upload.wikimedia.org/wikipedia/commons/1/16/${file}`, descriptionurl: sourceUrl,
        thumburl: `https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/${file}/960px-${file}`, thumbwidth: 960, thumbheight: 1440,
        extmetadata: { Artist: { value: 'LEi - DESIGN' }, License: { value: 'cc0' }, LicenseUrl: { value: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en' },
          LicenseShortName: { value: 'CC0' }, UsageTerms: { value: 'Creative Commons Zero, Public Domain Dedication' }, AttributionRequired: { value: 'false' }, Restrictions: { value: '' } },
      }],
    }] } })).mockResolvedValueOnce(new Response(new Uint8Array(await pixel()))).mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'MATCH' } }] }));
    vi.stubGlobal('fetch', fetch);
    try {
      await tick(db, config, undefined, id);
      await tick(db, config, undefined, duplicate);
      expect(fetch).toHaveBeenCalledTimes(3);
      const assets = await db.execute(sql`SELECT a.hash,a.source,a.author,a.source_url,a.license,a.model,j.dispatched_at FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id WHERE a.job_id IN (${id},${duplicate})`);
      expect(assets).toHaveLength(2);
      expect(assets[0]).toMatchObject({ source: 'wikimedia', author: 'LEi - DESIGN', source_url: sourceUrl, license: 'https://creativecommons.org/publicdomain/zero/1.0/', model: COMMONS_ASSET_PROVENANCE, dispatched_at: null });
      expect(assets[1]).toEqual(assets[0]);
      expect(await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`)).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it('queues atomically, waits for consent, resumes and persists binary without changing the recipe', async () => {
    await save('generated_recipe', 'image-recipe', { title: 'Pasta', ingredients: [{ name: 'Pasta' }] });
    await runImageTick();
    let rows = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE user_id=${userId}`);
    expect(rows[0].state).toBe('consent_required'); expect(provider.search).not.toHaveBeenCalled();
    await save('ai_consent','profile',{ enabled: true, homeProvider: 'openai', imagePolicyVersion: 'recipe-images-v1', imageProvider: 'openai' });
    expect((await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE user_id=${userId}`))[0].state).toBe('consent_required');
    await save('ai_consent','profile',{ enabled: true, homeProvider: 'openai', imagePolicyVersion: 'recipe-images-v2', imageProvider: 'openai' });
    await Promise.all([runImageTick(),runImageTick()]);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    rows = await db.execute(sql`SELECT a.content,j.state FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id WHERE j.user_id=${userId}`);
    expect(rows[0].state).toBe('ready'); expect(Buffer.from(rows[0].content as Uint8Array)).toEqual(result.bytes);
    await db.execute(sql`UPDATE sync_items SET deleted=true,payload=NULL WHERE scope_id=${userId} AND entity_id='image-recipe'`);
    expect((await db.execute(sql`SELECT * FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id WHERE j.user_id=${userId}`)).length).toBe(0);
  });
  it('does not reuse Home consent as image permission when imageProvider is absent', async () => {
    const searchesBefore = provider.search.mock.calls.length;
    const generationsBefore = provider.generate.mock.calls.length;
    await save('generated_recipe', 'home-only-image-job', { title: 'Home-only image', ingredients: [{ name: 'Riso' }] });
    await save('ai_consent', 'profile', {
      enabled: true,
      homeProvider: 'openai',
      imagePolicyVersion: 'recipe-images-v2',
    });
    const [job] = await db.execute(sql`SELECT id FROM recipe_image_jobs
      WHERE user_id=${userId}::uuid AND recipe->>'title'='Home-only image'`);

    await tick(db, config, provider, String(job.id));

    const [stored] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${String(job.id)}::uuid`);
    expect(stored.state).toBe('consent_required');
    expect(provider.search).toHaveBeenCalledTimes(searchesBefore);
    expect(provider.generate).toHaveBeenCalledTimes(generationsBefore);
  });

  it('does not automatically repeat an ambiguous paid generation', async () => {
    provider.generate.mockRejectedValueOnce(new ImageProviderError(true));
    await grantImageConsent();
    await save('saved_recipe', 'ambiguous', { title: 'Rice', ingredients: [{ name: 'Rice' }] });
    await runImageTick();
    const rows = await db.execute(sql`SELECT state,dispatched_at FROM recipe_image_jobs WHERE user_id=${userId}`);
    expect(rows[0].state).toBe('failed'); expect(rows[0].dispatched_at).not.toBeNull();
    const count = provider.generate.mock.calls.length;
    await runImageTick(); expect(provider.generate).toHaveBeenCalledTimes(count);
  });
  it('enforces the daily generation quota before dispatch', async () => {
    await grantImageConsent();
    await db.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES(${userId},CURRENT_DATE,5) ON CONFLICT(principal,day) DO UPDATE SET used=5`);
    await save('generated_recipe','over-quota',{ title: 'Soup', ingredients: [{ name: 'Soup' }] });
    const calls = provider.generate.mock.calls.length;
    await runImageTick();
    const [row] = await db.execute(sql`SELECT state FROM recipe_image_jobs j JOIN sync_items s ON s.id=j.sync_item_id WHERE s.entity_id='over-quota' AND j.user_id=${userId}`);
    expect(row.state).toBe('quota_exceeded'); expect(provider.generate).toHaveBeenCalledTimes(calls);
  });
  it('requires explicit v2 for compliant Commons metadata and bytes, without bypassing private access', async () => {
    vi.stubEnv('RECIPE_IMAGES_ENABLED','true'); vi.stubEnv('RECIPE_IMAGE_PROVIDER','openai'); vi.stubEnv('OPENAI_API_KEY','test'); vi.stubEnv('RECIPE_IMAGE_MODEL','test'); vi.stubEnv('RECIPE_IMAGE_VISION_MODEL','test');
    const id = await enqueue('commons');
    const credit = { source: 'wikimedia' as const, author: 'A. Photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Dish.jpg', license: 'https://creativecommons.org/publicdomain/zero/1.0/' };
    provider.search.mockResolvedValueOnce({ ...result, ...credit });
    await tick(db, config, provider, id);
    const auth = { authenticate: async (token: string) => ({ id: 'test', userId: token === 'owner' ? userId : randomUUID(), email: 'test@example.com', emailVerifiedAt: new Date(), csrfTokenHash: 'test', expiresAt: new Date('2099-01-01') }) } as unknown as AuthService;
    const app = Fastify(); await app.register(imageRoutes(db,auth,'https://example.com'));
    const metadata = '/v1/recipe-images/commons?kind=private';
    const asset = `/v1/recipe-images/assets/${id}`;
    const get = (url: string, token = 'owner') => app.inject({ url, headers: { cookie: `ikuck_session=${token}` } });
    try {
      expect((await get(metadata)).json()).toEqual({ state: 'missing' });
      expect((await get(asset)).statusCode).toBe(404);
      for (const query of ['metadataVersion=1', 'metadataVersion=', 'metadataVersion=2&metadataVersion=2']) {
        expect((await get(`${metadata}&${query}`)).statusCode).toBe(400);
        expect((await get(`${asset}?${query}`)).statusCode).toBe(400);
      }
      const meta = await get(`${metadata}&metadataVersion=2`);
      expect(meta.headers['cache-control']).toBe('no-store');
      expect(meta.json()).toMatchObject({ state: 'ready', metadataVersion: 2, ...credit, url: `${asset}?metadataVersion=2` });
      expect((await get(`${metadata}&metadataVersion=2`, 'other')).json()).toEqual({ state: 'missing', metadataVersion: 2 });
      expect((await get(`${asset}?metadataVersion=2`, 'other')).statusCode).toBe(404);
      const binary = await get(`${asset}?metadataVersion=2`);
      expect(binary.statusCode).toBe(200);
      expect(binary.headers['cache-control']).toBe('private, no-store');
      expect(binary.rawPayload).toEqual(result.bytes);
      // Even credit which happens to look compliant does not establish pre-fix provenance.
      await db.execute(sql`UPDATE recipe_image_assets SET model=NULL WHERE job_id=${id}`);
      expect((await get(`${metadata}&metadataVersion=2`)).json()).toEqual({ state: 'missing', metadataVersion: 2 });
      expect((await get(`${asset}?metadataVersion=2`)).statusCode).toBe(404);
      const duplicate = await enqueue('duplicate commons');
      await db.execute(sql`UPDATE recipe_image_jobs SET recipe=(SELECT recipe FROM recipe_image_jobs WHERE id=${id}) WHERE id=${duplicate}`);
      await tick(db, config, provider, duplicate);
      expect(provider.generate).toHaveBeenCalledTimes(1);
    } finally { await app.close(); vi.unstubAllEnvs(); }
  });
  it('never serves another user private assets, and marks authorized binaries no-store', async () => {
    vi.stubEnv('RECIPE_IMAGES_ENABLED','true'); vi.stubEnv('OPENAI_API_KEY','test'); vi.stubEnv('RECIPE_IMAGE_MODEL','test'); vi.stubEnv('RECIPE_IMAGE_VISION_MODEL','test');
    await save('generated_recipe', 'private-asset-recipe', { title: 'Private asset recipe', ingredients: [{ name: 'Riso' }] });
    const [job] = await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${userId} AND recipe->>'title'='Private asset recipe'`);
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
