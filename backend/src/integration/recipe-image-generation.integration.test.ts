import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { createDatabase } from '../db/client.js';
import { createDrizzleSyncRepository, DEFAULT_AI_CONSENT_REVISION } from '../sync/repository.js';
import { imageRoutes } from '../recipeImages/routes.js';
import { catalogImageRecipes } from '../recipeImages/generation.js';
import { runImageTick } from '../recipeImages/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
(url ? describe : describe.skip)('user-requested recipe image generation', () => {
  const database = createDatabase(url!, { max: 5 });
  const db = database.db;
  const owner = randomUUID(); const other = randomUUID(); const house = randomUUID();
  const origin = 'https://images.test';
  const headers = { cookie: 'ikuck_session=owner', origin, 'x-csrf-token': 'image-csrf' };
  const config = { enabled: true, provider: 'openai' as const, apiKey: 'test', model: 'test', dailyLimit: 5 };
  const auth = { authenticate: async (token: string) => token === 'owner' ? {
    id: 'image-session', userId: owner, email: 'images@example.com', emailVerifiedAt: new Date(),
    csrfTokenHash: hashOpaqueToken('image-csrf'), expiresAt: new Date('2099-01-01'),
  } : null } as unknown as AuthService;
  const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined } });
  const save = async (userId: string, id: string, entityType = 'saved_recipe', scopeId = userId, deleted = false) => {
    const rows = await db.execute(sql`INSERT INTO sync_items(user_id,scope_type,scope_id,entity_type,entity_id,device_id,payload,deleted,client_updated_at,mutation_id)
      VALUES(${userId}::uuid,${scopeId === house ? 'house' : 'user'},${scopeId},${entityType},${id},'image-test',
        ${JSON.stringify(entityType === 'ai_consent' ? { enabled: true, imagePolicyVersion: 'recipe-images-v2', imageProvider: 'openai' } : { title: id, ingredients: [{ name: 'Riso' }] })}::jsonb,
        ${deleted},now(),${randomUUID()}) RETURNING id`);
    return String(rows[0].id);
  };
  const grantImageConsent = (userId: string) => createDrizzleSyncRepository(db).updateAiConsent(userId, {
    enabled: true,
    imagePolicyVersion: 'recipe-images-v3',
    imageProvider: 'openai',
    expectedRevision: DEFAULT_AI_CONSENT_REVISION,
  });
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'src/db/migrations' });
    await db.execute(sql`INSERT INTO users(id,email) VALUES(${owner},${`${owner}@images.test`}),(${other},${`${other}@images.test`})`);
    await db.execute(sql`INSERT INTO houses(id,name,created_by_user_id) VALUES(${house},'Image test',${owner})`);
    await db.execute(sql`INSERT INTO house_memberships(house_id,user_id,role) VALUES(${house},${owner},'admin'),(${house},${other},'member')`);
    vi.stubEnv('RECIPE_IMAGES_ENABLED', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test');
    vi.stubEnv('RECIPE_IMAGE_MODEL', 'test');
    await app.register(imageRoutes(db, auth, origin));
    await app.ready();
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM sync_items WHERE user_id IN (${owner}::uuid,${other}::uuid)`);
    await db.execute(sql`DELETE FROM recipe_image_jobs WHERE catalog_id IS NOT NULL`);
    await db.execute(sql`DELETE FROM recipe_image_quota WHERE principal=${owner}`);
  });
  afterAll(async () => {
    await app.close();
    await db.execute(sql`DELETE FROM sync_items WHERE user_id IN (${owner}::uuid,${other}::uuid)`);
    await db.execute(sql`DELETE FROM processed_sync_mutations
      WHERE scope_type='user' AND scope_id IN (${owner},${other})
        AND user_id IN (${owner}::uuid,${other}::uuid)`);
    await db.execute(sql`DELETE FROM houses WHERE id=${house}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${owner}::uuid,${other}::uuid)`);
    await db.execute(sql`DELETE FROM recipe_image_jobs WHERE catalog_id IS NOT NULL`);
    await db.execute(sql`DELETE FROM recipe_image_quota WHERE principal=${owner}`);
    await database.close(); vi.unstubAllEnvs();
  });
  const single = (id: string, kind = 'private') => app.inject({ method: 'POST', url: `/v1/recipe-images/${id}/generate?kind=${kind}`, headers });

  it('rejects old v2 grants and the legacy collection endpoint', async () => {
    await save(owner, 'profile', 'ai_consent');
    await save(owner, 'legacy-v2-recipe');

    expect((await single('legacy-v2-recipe')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/recipe-images/generate', headers })).statusCode).toBe(404);
  });

  it('enforces verified session, same-origin and CSRF before queuing', async () => {
    const count = (await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${owner}::uuid`)).length;
    for (const [requestHeaders, code] of [
      [{ ...headers, cookie: '' }, 401], [{ ...headers, origin: 'https://other.test' }, 403], [{ ...headers, 'x-csrf-token': 'wrong' }, 403],
    ] as const) {
      expect((await app.inject({ method: 'POST', url: '/v1/recipe-images/mine/generate?kind=private', headers: requestHeaders })).statusCode).toBe(code);
    }
    expect((await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${owner}::uuid`)).length).toBe(count);
  });

  it('requires current image consent and rejects private recipes owned by someone else', async () => {
    await save(owner, 'mine'); await save(other, 'theirs'); await save(other, 'shared-theirs', 'saved_recipe', house);
    await grantImageConsent(owner);
    expect((await single('theirs')).statusCode).toBe(404);
    expect((await single('shared-theirs')).statusCode).toBe(404);
    expect((await single('unknown')).statusCode).toBe(404);
  });

  it('authorizes only the explicit v3 OpenAI image grant and revokes it globally', async () => {
    await save(owner, 'image-only-recipe');
    const repository = createDrizzleSyncRepository(db);
    const granted = await grantImageConsent(owner);

    expect(granted).toMatchObject({ enabled: true, imagePolicyVersion: 'recipe-images-v3', imageProvider: 'openai' });
    expect(granted).not.toHaveProperty('homeProvider');
    await expect(repository.withAiConsentDispatch(owner, { kind: 'home', provider: 'openai' }, async () => 'dispatched'))
      .rejects.toMatchObject({ code: 'ai_consent_required' });
    await expect(repository.updateAiConsent(owner, {
      enabled: true, imagePolicyVersion: 'recipe-images-v3', imageProvider: 'openai',
    })).rejects.toMatchObject({ code: 'ai_consent_revision_required' });
    await expect(repository.updateAiConsent(owner, {
      enabled: true, imagePolicyVersion: 'recipe-images-v3', imageProvider: 'openai',
      expectedRevision: DEFAULT_AI_CONSENT_REVISION,
    })).rejects.toMatchObject({ code: 'ai_consent_revision_conflict' });
    expect((await single('image-only-recipe')).statusCode).toBe(202);

    await db.execute(sql`UPDATE sync_items SET payload=payload || '{"imagePolicyVersion":"recipe-images-v3","imageProvider":"gemini"}'::jsonb
      WHERE user_id=${owner}::uuid AND entity_type='ai_consent' AND entity_id='profile'`);
    expect((await single('image-only-recipe')).statusCode).toBe(403);

    await db.execute(sql`UPDATE sync_items SET payload=(payload - 'imageProvider') || '{"homeProvider":"openai"}'::jsonb
      WHERE user_id=${owner}::uuid AND entity_type='ai_consent' AND entity_id='profile'`);
    expect((await single('image-only-recipe')).statusCode).toBe(403);

    const revoked = await repository.updateAiConsent(owner, { enabled: false });
    expect(revoked).toMatchObject({ enabled: false });
    expect(revoked).not.toHaveProperty('imagePolicyVersion');
    expect(revoked).not.toHaveProperty('imageProvider');
    expect((await single('image-only-recipe')).statusCode).toBe(403);
  });

  it('creates a missing private association only after the explicit single request', async () => {
    await grantImageConsent(owner);
    const id = await save(owner, 'missing');
    expect((await app.inject({ url: '/v1/recipe-images/missing?kind=private', headers })).json()).toEqual({ state: 'missing' });
    const responses = await Promise.all([single('missing'), single('missing')]);
    expect(responses.map(response => response.statusCode)).toEqual([202, 202]);
    expect(responses.reduce((sum, response) => sum + response.json().queued, 0)).toBe(1);
    expect((await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE sync_item_id=${id}::uuid`)).length).toBe(1);
  });

  it('queues only authoritative catalog recipes and keeps existing local artwork', async () => {
    expect((await single('invented-recipe', 'catalog')).statusCode).toBe(404);
    expect((await single('uova-al-pomodoro', 'catalog')).json().queued).toBe(0);
    expect((await single('pollo-al-limone', 'catalog')).json().queued).toBe(1);
    const [job] = await db.execute(sql`SELECT recipe,user_id FROM recipe_image_jobs WHERE catalog_id='pollo-al-limone'`);
    expect(job.recipe).toMatchObject({ title: 'Pollo al limone', ingredients: catalogImageRecipes.find(recipe => recipe.id === 'pollo-al-limone')!.ingredients });
    expect(job.user_id).toBeNull();
  });

  it('does not enqueue a bulk batch and does not auto-enqueue saved recipes', async () => {
    await grantImageConsent(owner);
    await save(owner, 'personal');
    await save(owner, 'shared', 'saved_recipe', house);
    await save(owner, 'deleted', 'saved_recipe', owner, true);
    await save(other, 'someone-elses');

    expect((await app.inject({ method: 'POST', url: '/v1/recipe-images/generate', headers })).statusCode).toBe(404);
    expect(await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${owner}::uuid OR catalog_id IS NOT NULL`)).toEqual([]);
  });

  it('preserves ready/processing/quota-limited jobs and only explicitly retries a failed dispatch', async () => {
    await grantImageConsent(owner);
    for (const state of ['ready', 'processing', 'quota_exceeded', 'failed']) {
      const id = await save(owner, state);
      expect((await single(state)).statusCode).toBe(202);
      await db.transaction(async tx => {
        await tx.execute(sql`SELECT public.set_recipe_image_policy_v3()`);
        await tx.execute(sql`UPDATE recipe_image_jobs SET state=${state},attempts=2,dispatched_at=now(),available_at=now()+interval '1 day' WHERE sync_item_id=${id}::uuid`);
      });
      const response = await single(state);
      expect(response.statusCode).toBe(202);
      expect(response.json().queued).toBe(state === 'failed' ? 1 : 0);
      const [job] = await db.execute(sql`SELECT state,attempts,dispatched_at FROM recipe_image_jobs WHERE sync_item_id=${id}::uuid`);
      expect(job.state).toBe(state === 'failed' ? 'pending' : state);
      expect(Number(job.attempts)).toBe(state === 'failed' ? 0 : 2);
      expect(job.dispatched_at === null).toBe(state === 'failed');
    }
  });

  it('resumes an unreserved quota-limited job and rechecks revoked consent before a second job', async () => {
    await grantImageConsent(owner);
    const id = await save(owner, 'tomorrow');
    expect((await single('tomorrow')).statusCode).toBe(202);
    const [job] = await db.execute(sql`UPDATE recipe_image_jobs SET state='quota_exceeded',dispatched_at=NULL,available_at=now()-interval '1 second' WHERE sync_item_id=${id}::uuid RETURNING id`);
    const provider = { generate: vi.fn().mockResolvedValue({ bytes: Buffer.from('webp'), width: 1, height: 1, author: 'openai' }) };
    await runImageTick(db, config, provider, String(job.id));
    expect(provider.generate).toHaveBeenCalledTimes(1);

    const revokedId = await save(owner, 'revoked-before-claim');
    expect((await single('revoked-before-claim')).statusCode).toBe(202);
    const [revokedJob] = await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE sync_item_id=${revokedId}::uuid`);
    await createDrizzleSyncRepository(db).updateAiConsent(owner, { enabled: false });
    await runImageTick(db, config, provider, String(revokedJob.id));
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const [current] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${String(revokedJob.id)}::uuid`);
    expect(current.state).toBe('consent_required');
  });
});
