import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { DEFAULT_AI_CONSENT_REVISION, createDrizzleSyncRepository } from '../sync/repository.js';
import { createDatabase } from '../db/client.js';
import { COMMONS_ASSET_PROVENANCE, queuePrivateImages } from '../recipeImages/generation.js';
import { runImageTick } from '../recipeImages/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
(url ? describe : describe.skip)('OpenAI recipe image worker', () => {
  const database = createDatabase(url!, { max: 5 });
  const { db } = database;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const config = {
    enabled: true,
    provider: 'openai' as const,
    apiKey: 'disposable-test-key',
    model: 'gpt-image-2.5-flare',
    dailyLimit: 5,
  };
  const save = (entityId: string, payload: unknown, entityType = 'saved_recipe', ownerId: string = userId) => db.execute(sql`
    INSERT INTO sync_items(user_id,scope_type,scope_id,entity_type,entity_id,device_id,payload,client_updated_at,mutation_id)
    VALUES(${ownerId}::uuid,'user',${ownerId},${entityType},${entityId},'image-integration',${JSON.stringify(payload)}::jsonb,now(),${randomUUID()})
    ON CONFLICT(scope_type,scope_id,entity_type,entity_id) DO UPDATE SET payload=excluded.payload,deleted=false
  `);
  const grantImageConsent = async (ownerId: string = userId) => {
    const [row] = await db.execute(sql`SELECT payload FROM sync_items WHERE user_id=${ownerId}::uuid AND entity_type='ai_consent' AND entity_id='profile' AND NOT deleted`);
    const payload = row?.payload as { updatedAt?: string } | undefined;
    return createDrizzleSyncRepository(db).updateAiConsent(ownerId, {
      enabled: true,
      imagePolicyVersion: 'recipe-images-v3',
      imageProvider: 'openai',
      expectedRevision: payload?.updatedAt ?? DEFAULT_AI_CONSENT_REVISION,
    });
  };
  const enqueuePrivate = async (recipeId: string, ownerId: string = userId) => db.transaction(async tx => {
    await tx.execute(sql`SELECT public.set_recipe_image_request_v3()`);
    await queuePrivateImages(tx, ownerId, recipeId);
    const [job] = await tx.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${ownerId}::uuid AND sync_item_id=(
      SELECT id FROM sync_items WHERE user_id=${ownerId}::uuid AND entity_id=${recipeId} AND entity_type='saved_recipe')`);
    return String(job.id);
  });
  const enqueueCatalog = async (catalogId: string, recipe: unknown) => {
    const [job] = await db.transaction(async tx => {
      await tx.execute(sql`SELECT public.set_recipe_image_request_v3()`);
      return tx.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe,state)
        VALUES(${catalogId},${JSON.stringify(recipe)}::jsonb,'pending') RETURNING id`);
    });
    return String(job.id);
  };
  const pollUntil = async (condition: () => Promise<boolean>, message: string) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  };
  const waitForBothProcessing = (firstJobId: string, secondJobId: string) => pollUntil(async () => {
    const rows = await db.execute(sql`SELECT state FROM recipe_image_jobs
      WHERE id IN (${firstJobId}::uuid,${secondJobId}::uuid)`);
    return rows.length === 2 && rows.every(row => row.state === 'processing');
  }, 'Expected both distinct jobs to reach processing before releasing the provider stub');
  const imageBytes = () => sharp({
    create: { width: 32, height: 24, channels: 3, background: '#386641' },
  }).png().toBuffer();
  const imageResponse = async () => Response.json({
    data: [{ b64_json: (await imageBytes()).toString('base64') }],
  });
  const seededProvenance = (provenance: {
    source: string;
    author: string;
    model: string | null;
    sourceUrl?: string;
    license?: string;
  }) => ({
    source: provenance.source,
    author: provenance.author,
    model: provenance.model,
    sourceUrl: provenance.sourceUrl ?? '',
    license: provenance.license ?? '',
  });
  const seedReadyPrivateAsset = async (
    ownerId: string,
    recipeId: string,
    recipe: unknown,
    provenance: ReturnType<typeof seededProvenance>,
  ) => {
    await save(recipeId, recipe, 'saved_recipe', ownerId);
    const jobId = await enqueuePrivate(recipeId, ownerId);
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT public.set_recipe_image_policy_v3()`);
      await tx.execute(sql`UPDATE recipe_image_jobs SET state='ready',dispatched_at=clock_timestamp() WHERE id=${jobId}::uuid`);
      await tx.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license,model)
        VALUES(${jobId}::uuid,${Buffer.from('synthetic-source-image')},'synthetic-source-hash',32,24,
          ${provenance.source},${provenance.author},${provenance.sourceUrl},${provenance.license},${provenance.model})`);
    });
    return jobId;
  };
  const seedReadyCatalogAsset = async (
    recipe: unknown,
    provenance: ReturnType<typeof seededProvenance>,
  ) => {
    const [job] = await db.transaction(async tx => {
      await tx.execute(sql`SELECT public.set_recipe_image_request_v3()`);
      return tx.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe,state)
        VALUES(${`red-dedup:${randomUUID()}`},${JSON.stringify(recipe)}::jsonb,'ready') RETURNING id`);
    });
    const jobId = String(job.id);
    await db.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license,model)
      VALUES(${jobId}::uuid,${Buffer.from('synthetic-catalog-image')},'synthetic-catalog-hash',32,24,
        ${provenance.source},${provenance.author},${provenance.sourceUrl},${provenance.license},${provenance.model})`);
    return jobId;
  };

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'src/db/migrations' });
    await db.execute(sql`INSERT INTO users(id,email) VALUES
      (${userId},${`${userId}@images.test`}),(${otherUserId},${`${otherUserId}@images.test`})`);
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM sync_items WHERE user_id IN (${userId}::uuid,${otherUserId}::uuid)`);
    await db.execute(sql`DELETE FROM recipe_image_jobs WHERE user_id IN (${userId}::uuid,${otherUserId}::uuid)`);
    await db.execute(sql`DELETE FROM recipe_image_jobs WHERE catalog_id LIKE 'red-dedup:%'`);
    await db.execute(sql`DELETE FROM recipe_image_quota WHERE principal IN (${userId},${otherUserId},'catalog')`);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await db.execute(sql`DELETE FROM sync_items WHERE scope_id IN (${userId},${otherUserId})`);
    await db.execute(sql`DELETE FROM processed_sync_mutations
      WHERE scope_type='user' AND scope_id IN (${userId},${otherUserId})
        AND user_id IN (${userId}::uuid,${otherUserId}::uuid)`);
    await db.execute(sql`DELETE FROM recipe_image_jobs WHERE catalog_id LIKE 'red-dedup:%'`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${userId}::uuid,${otherUserId}::uuid)`);
    await db.execute(sql`DELETE FROM recipe_image_quota WHERE principal IN (${userId},${otherUserId},'catalog')`);
    await database.close();
  });

  it('does not enqueue jobs when a recipe is saved or private consent changes', async () => {
    await save('automatic-path', { title: 'Saved only', ingredients: [{ name: 'Rice' }] });
    await grantImageConsent();
    expect(await db.execute(sql`SELECT id FROM recipe_image_jobs WHERE user_id=${userId}::uuid`)).toEqual([]);
  });

  it('uses only the v3 worker marker and keeps it transaction-local', async () => {
    await grantImageConsent();
    await save('fenced', { title: 'Fenced', ingredients: [{ name: 'Rice' }] });
    const jobId = await enqueuePrivate('fenced');
    const claim = sql`UPDATE recipe_image_jobs SET state='processing' WHERE id=${jobId}::uuid AND state='pending'`;
    await expect(db.execute(claim)).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(db.transaction(async tx => {
      await tx.execute(sql`SELECT public.set_recipe_image_policy_v2()`);
      await tx.execute(claim);
    })).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(db.transaction(async tx => {
      await tx.execute(sql`SELECT public.set_recipe_image_policy_v3()`);
      await tx.execute(claim);
    })).resolves.toBeUndefined();
    const [marker] = await db.execute(sql`SELECT current_setting('ikuck.recipe_image_policy', true) AS value`);
    expect(marker.value).not.toBe('recipe-images-v3');
  });

  it('dispatches one medium square OpenAI request across concurrent claims and reserves one quota unit', async () => {
    await grantImageConsent();
    await save('private-dish', {
      title: 'Private rice bowl',
      description: 'Do not send',
      steps: ['Do not send'],
      ingredients: [{ name: 'Rice', amount: '250 g', privateId: 'Do not send' }],
    });
    const jobId = await enqueuePrivate('private-dish');
    const fetch = vi.fn().mockImplementation(imageResponse);
    vi.stubGlobal('fetch', fetch);

    await Promise.all([
      runImageTick(db, config, undefined, jobId),
      runImageTick(db, config, undefined, jobId),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('https://api.openai.com/v1/images/generations');
    expect(init.method).toBe('POST');
    const request = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['model', 'n', 'prompt', 'quality', 'size']);
    expect(request).toMatchObject({ model: config.model, n: 1, size: '1024x1024', quality: 'medium' });
    expect(request.prompt).toContain('Private rice bowl');
    expect(request.prompt).toContain('Rice');
    expect(request.prompt).not.toContain('250 g');
    expect(request.prompt).not.toContain('Do not send');
    const [job] = await db.execute(sql`SELECT state,dispatched_at,recipe FROM recipe_image_jobs WHERE id=${jobId}::uuid`);
    expect(job.state).toBe('ready');
    expect(job.dispatched_at).not.toBeNull();
    expect(job.recipe).toEqual({ title: 'Private rice bowl', ingredients: [{ name: 'Rice' }] });
    const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
    expect(Number(quota.used)).toBe(1);
    const [asset] = await db.execute(sql`SELECT source,author,source_url,license,model FROM recipe_image_assets WHERE job_id=${jobId}::uuid`);
    expect(asset).toEqual({ source: 'ai', author: 'openai', source_url: '', license: '', model: config.model });
  });

  it('reuses a ready OpenAI image for an equivalent private recipe without a second quota dispatch', async () => {
    await grantImageConsent();
    const recipe = { title: 'Equivalent rice bowl', ingredients: [{ name: 'Rice' }, { name: 'Tomato' }] };
    await save('equivalent-first', recipe);
    await save('equivalent-second', recipe);
    const firstJobId = await enqueuePrivate('equivalent-first');
    const secondJobId = await enqueuePrivate('equivalent-second');
    expect(firstJobId).not.toBe(secondJobId);

    const fetch = vi.fn().mockImplementation(imageResponse);
    vi.stubGlobal('fetch', fetch);
    await runImageTick(db, config, undefined, firstJobId);
    await db.execute(sql`UPDATE recipe_image_assets SET model='gpt-image-prior-model' WHERE job_id=${firstJobId}::uuid`);
    const [sourceBeforeReuse] = await db.execute(sql`SELECT encode(content,'base64') AS bytes,hash,width,height,
      source,author,source_url,license,model FROM recipe_image_assets WHERE job_id=${firstJobId}::uuid`);
    await runImageTick(db, config, undefined, secondJobId);

    const jobs = await db.execute(sql`SELECT id,state,dispatched_at FROM recipe_image_jobs
      WHERE id IN (${firstJobId}::uuid,${secondJobId}::uuid) ORDER BY id`);
    const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
    const [assets] = await db.execute(sql`SELECT count(*) AS count FROM recipe_image_assets
      WHERE job_id IN (${firstJobId}::uuid,${secondJobId}::uuid)`);
    const snapshot = {
      distinctJobs: jobs.length,
      states: jobs.map(job => String(job.state)).sort(),
      generatorDispatched: jobs.find(job => String(job.id) === firstJobId)?.dispatched_at !== null,
      reusedJobDispatched: jobs.find(job => String(job.id) === secondJobId)?.dispatched_at !== null,
      providerCalls: fetch.mock.calls.length,
      quotaUsed: Number(quota?.used ?? 0),
      assets: Number(assets.count),
    };
    expect(snapshot).toEqual({
      distinctJobs: 2,
      states: ['ready', 'ready'],
      generatorDispatched: true,
      reusedJobDispatched: false,
      providerCalls: 1,
      quotaUsed: 1,
      assets: 2,
    });

    const [sourceAfterReuse] = await db.execute(sql`SELECT encode(content,'base64') AS bytes,hash,width,height,
      source,author,source_url,license,model FROM recipe_image_assets WHERE job_id=${firstJobId}::uuid`);
    const [reusedAsset] = await db.execute(sql`SELECT encode(content,'base64') AS bytes,hash,width,height,
      source,author,source_url,license,model FROM recipe_image_assets WHERE job_id=${secondJobId}::uuid`);
    expect(sourceBeforeReuse).toMatchObject({
      source: 'ai', author: 'openai', source_url: '', license: '', model: 'gpt-image-prior-model',
    });
    expect(sourceAfterReuse).toEqual(sourceBeforeReuse);
    expect(reusedAsset).toEqual(sourceBeforeReuse);
  });

  it('deduplicates equivalent private jobs when distinct claims run concurrently', async () => {
    await grantImageConsent();
    const recipe = { title: 'Concurrent private dish', ingredients: [{ name: 'Chickpeas' }] };
    await save('concurrent-private-first', recipe);
    await save('concurrent-private-second', recipe);
    const firstJobId = await enqueuePrivate('concurrent-private-first');
    const secondJobId = await enqueuePrivate('concurrent-private-second');
    expect(firstJobId).not.toBe(secondJobId);

    let releaseProvider: () => void = () => undefined;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    const fetch = vi.fn().mockImplementation(async () => {
      await providerGate;
      return imageResponse();
    });
    vi.stubGlobal('fetch', fetch);
    const runs: Promise<void>[] = [runImageTick(db, config, undefined, firstJobId)];
    try {
      await pollUntil(async () => fetch.mock.calls.length === 1, 'First private provider request did not start');
      runs.push(runImageTick(db, config, undefined, secondJobId));
      await waitForBothProcessing(firstJobId, secondJobId);
    } finally {
      releaseProvider();
      await Promise.all(runs);
    }

    const jobs = await db.execute(sql`SELECT id,state,dispatched_at FROM recipe_image_jobs
      WHERE id IN (${firstJobId}::uuid,${secondJobId}::uuid)`);
    const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
    const [assets] = await db.execute(sql`SELECT count(*) AS count FROM recipe_image_assets
      WHERE job_id IN (${firstJobId}::uuid,${secondJobId}::uuid)`);
    expect({
      distinctJobs: jobs.length,
      states: jobs.map(job => String(job.state)).sort(),
      firstDispatched: jobs.find(job => String(job.id) === firstJobId)?.dispatched_at !== null,
      secondDispatched: jobs.find(job => String(job.id) === secondJobId)?.dispatched_at !== null,
      providerCalls: fetch.mock.calls.length,
      quotaUsed: Number(quota?.used ?? 0),
      assets: Number(assets.count),
    }).toEqual({
      distinctJobs: 2,
      states: ['ready', 'ready'],
      firstDispatched: true,
      secondDispatched: false,
      providerCalls: 1,
      quotaUsed: 1,
      assets: 2,
    });
  });

  it('deduplicates equivalent catalog jobs when distinct claims run concurrently', async () => {
    const recipe = { title: 'Concurrent catalog dish', ingredients: [{ name: 'Polenta' }] };
    const firstJobId = await enqueueCatalog(`red-dedup:${randomUUID()}`, recipe);
    const secondJobId = await enqueueCatalog(`red-dedup:${randomUUID()}`, recipe);
    expect(firstJobId).not.toBe(secondJobId);

    let releaseProvider: () => void = () => undefined;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    const fetch = vi.fn().mockImplementation(async () => {
      await providerGate;
      return imageResponse();
    });
    vi.stubGlobal('fetch', fetch);
    const runs: Promise<void>[] = [runImageTick(db, config, undefined, firstJobId)];
    try {
      await pollUntil(async () => fetch.mock.calls.length === 1, 'First catalog provider request did not start');
      runs.push(runImageTick(db, config, undefined, secondJobId));
      await waitForBothProcessing(firstJobId, secondJobId);
    } finally {
      releaseProvider();
      await Promise.all(runs);
    }

    const jobs = await db.execute(sql`SELECT id,state,dispatched_at FROM recipe_image_jobs
      WHERE id IN (${firstJobId}::uuid,${secondJobId}::uuid)`);
    const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal='catalog'`);
    const [assets] = await db.execute(sql`SELECT count(*) AS count FROM recipe_image_assets
      WHERE job_id IN (${firstJobId}::uuid,${secondJobId}::uuid)`);
    expect({
      distinctJobs: jobs.length,
      states: jobs.map(job => String(job.state)).sort(),
      firstDispatched: jobs.find(job => String(job.id) === firstJobId)?.dispatched_at !== null,
      secondDispatched: jobs.find(job => String(job.id) === secondJobId)?.dispatched_at !== null,
      providerCalls: fetch.mock.calls.length,
      quotaUsed: Number(quota?.used ?? 0),
      assets: Number(assets.count),
    }).toEqual({
      distinctJobs: 2,
      states: ['ready', 'ready'],
      firstDispatched: true,
      secondDispatched: false,
      providerCalls: 1,
      quotaUsed: 1,
      assets: 2,
    });
  });

  it('does not reuse a private image across different user principals', async () => {
    const recipe = { title: 'Shared text, private identity', ingredients: [{ name: 'Beans' }] };
    await grantImageConsent(userId);
    await grantImageConsent(otherUserId);
    await save('principal-owner', recipe, 'saved_recipe', userId);
    await save('principal-other', recipe, 'saved_recipe', otherUserId);
    const ownerJobId = await enqueuePrivate('principal-owner', userId);
    const otherJobId = await enqueuePrivate('principal-other', otherUserId);
    const fetch = vi.fn().mockImplementation(imageResponse);
    vi.stubGlobal('fetch', fetch);

    await runImageTick(db, config, undefined, ownerJobId);
    await runImageTick(db, config, undefined, otherJobId);

    const jobs = await db.execute(sql`SELECT state FROM recipe_image_jobs
      WHERE id IN (${ownerJobId}::uuid,${otherJobId}::uuid)`);
    const quotas = await db.execute(sql`SELECT principal,used FROM recipe_image_quota
      WHERE principal IN (${userId},${otherUserId}) ORDER BY principal`);
    expect({
      distinctJobs: jobs.length,
      states: jobs.map(job => String(job.state)).sort(),
      providerCalls: fetch.mock.calls.length,
      quotaUsedByPrincipal: quotas.map(row => Number(row.used)),
    }).toEqual({
      distinctJobs: 2,
      states: ['ready', 'ready'],
      providerCalls: 2,
      quotaUsedByPrincipal: [1, 1],
    });
  });

  it('does not reuse a catalog image for a private recipe with identical content', async () => {
    const recipe = { title: 'Catalog only image', ingredients: [{ name: 'Polenta' }] };
    const catalogJobId = await seedReadyCatalogAsset(recipe, seededProvenance({
      source: 'ai', author: 'openai', model: 'gpt-image-prior-model',
    }));
    await grantImageConsent();
    await save('private-catalog-match', recipe);
    const privateJobId = await enqueuePrivate('private-catalog-match');
    const fetch = vi.fn().mockImplementation(imageResponse);
    vi.stubGlobal('fetch', fetch);

    await runImageTick(db, config, undefined, privateJobId);

    const [privateJob] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${privateJobId}::uuid`);
    const [sourceAsset] = await db.execute(sql`SELECT source,author,model FROM recipe_image_assets WHERE job_id=${catalogJobId}::uuid`);
    const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
    expect({
      privateState: privateJob.state,
      providerCalls: fetch.mock.calls.length,
      privateQuota: Number(quota?.used ?? 0),
      catalogSource: sourceAsset,
    }).toEqual({
      privateState: 'ready',
      providerCalls: 1,
      privateQuota: 1,
      catalogSource: { source: 'ai', author: 'openai', model: 'gpt-image-prior-model' },
    });
  });

  it.each([
    ['Gemini-marked AI', { source: 'ai', author: 'gemini', model: 'gemini-image-model' }],
    ['AI with an empty author marker', { source: 'ai', author: '', model: 'openai-image-model' }],
    ['AI with no model marker', { source: 'ai', author: 'openai', model: null }],
    ['AI with an empty model marker', { source: 'ai', author: 'openai', model: '' }],
    ['Pexels with valid credit', {
      source: 'pexels', author: 'Pexels contributor', model: null,
      sourceUrl: 'https://www.pexels.com/photo/example', license: 'https://www.pexels.com/license/',
    }],
    ['Wikimedia CC0 with valid credit', {
      source: 'wikimedia', author: 'Commons contributor', model: COMMONS_ASSET_PROVENANCE,
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
      license: 'https://creativecommons.org/publicdomain/zero/1.0/',
    }],
  ] as const)('does not reuse %s as an OpenAI source asset', async (_label, source) => {
    const recipe = { title: 'Provenance control', ingredients: [{ name: 'Lentils' }] };
    await grantImageConsent();
    const expectedSource = seededProvenance(source);
    const sourceJobId = await seedReadyPrivateAsset(userId, 'source-provenance', recipe, expectedSource);
    await save('target-provenance', recipe);
    const targetJobId = await enqueuePrivate('target-provenance');
    const fetch = vi.fn().mockImplementation(imageResponse);
    vi.stubGlobal('fetch', fetch);

    await runImageTick(db, config, undefined, targetJobId);

    const [targetJob] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${targetJobId}::uuid`);
    const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
    const [sourceAsset] = await db.execute(sql`SELECT source,author,source_url,license,model
      FROM recipe_image_assets WHERE job_id=${sourceJobId}::uuid`);
    expect({
      targetState: targetJob.state,
      providerCalls: fetch.mock.calls.length,
      quotaUsed: Number(quota?.used ?? 0),
      sourceAsset,
    }).toEqual({
      targetState: 'ready',
      providerCalls: 1,
      quotaUsed: 1,
      sourceAsset: {
        source: expectedSource.source, author: expectedSource.author, source_url: expectedSource.sourceUrl,
        license: expectedSource.license, model: expectedSource.model,
      },
    });
  });

  it('does not automatically retry an ambiguous dispatch but permits a fresh single retry', async () => {
    await grantImageConsent();
    await save('ambiguous', { title: 'Ambiguous dish', ingredients: [{ name: 'Rice' }] });
    const jobId = await enqueuePrivate('ambiguous');
    const fetch = vi.fn().mockRejectedValueOnce(new Error('connection reset'));
    vi.stubGlobal('fetch', fetch);

    await runImageTick(db, config, undefined, jobId);
    await runImageTick(db, config, undefined, jobId);
    const [failed] = await db.execute(sql`SELECT state,dispatched_at FROM recipe_image_jobs WHERE id=${jobId}::uuid`);
    expect(failed.state).toBe('failed');
    expect(failed.dispatched_at).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [firstQuota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
    expect(Number(firstQuota.used)).toBe(1);

    expect(await enqueuePrivate('ambiguous')).toBe(jobId);
    fetch.mockResolvedValueOnce(await imageResponse());
    await runImageTick(db, config, undefined, jobId);
    const [ready] = await db.execute(sql`SELECT state,dispatched_at FROM recipe_image_jobs WHERE id=${jobId}::uuid`);
    expect(ready.state).toBe('ready');
    expect(ready.dispatched_at).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [quota] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId}`);
    expect(Number(quota.used)).toBe(2);
  });

  it.each([
    ['missing v3 grant', false],
    ['revoked v3 grant', true],
  ] as const)('requires current image consent before reusing a ready asset when %s', async (_consentState, revokeGrant) => {
    const suffix = randomUUID();
    const recipe = { title: 'R12 private dish', ingredients: [{ name: 'Rice' }, { name: 'Beans' }] };
    const sourceJobId = await seedReadyPrivateAsset(userId, `r12-source-${suffix}`, recipe, seededProvenance({
      source: 'ai', author: 'openai', model: 'gpt-image-r12-prior-model',
    }));
    await save(`r12-target-${suffix}`, recipe);
    const targetJobId = await enqueuePrivate(`r12-target-${suffix}`);
    expect(targetJobId).not.toBe(sourceJobId);

    const jobsBefore = await db.execute(sql`SELECT id,user_id,sync_item_id,state,dispatched_at,recipe
      FROM recipe_image_jobs WHERE id IN (${sourceJobId}::uuid,${targetJobId}::uuid)`);
    const sourceBefore = jobsBefore.find(job => String(job.id) === sourceJobId);
    const targetBefore = jobsBefore.find(job => String(job.id) === targetJobId);
    expect(sourceBefore).toMatchObject({ user_id: userId, state: 'ready', recipe });
    expect(targetBefore).toMatchObject({ user_id: userId, state: 'pending', recipe });
    expect(sourceBefore?.sync_item_id).not.toBe(targetBefore?.sync_item_id);

    if (revokeGrant) {
      await grantImageConsent();
      await createDrizzleSyncRepository(db).updateAiConsent(userId, { enabled: false });
    }

    await db.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES(${userId},CURRENT_DATE,2)`);
    const [sourceAssetBefore] = await db.execute(sql`SELECT job_id,encode(content,'base64') AS bytes,hash,width,height,
      source,author,source_url,license,model FROM recipe_image_assets WHERE job_id=${sourceJobId}::uuid`);
    expect(sourceAssetBefore).toMatchObject({
      job_id: sourceJobId, source: 'ai', author: 'openai', model: 'gpt-image-r12-prior-model',
    });
    const fetch = vi.fn().mockImplementation(imageResponse);
    vi.stubGlobal('fetch', fetch);

    await runImageTick(db, config, undefined, targetJobId);

    const [targetAfter] = await db.execute(sql`SELECT state,dispatched_at FROM recipe_image_jobs WHERE id=${targetJobId}::uuid`);
    const [targetAssets] = await db.execute(sql`SELECT count(*) AS count FROM recipe_image_assets WHERE job_id=${targetJobId}::uuid`);
    const [quotaAfter] = await db.execute(sql`SELECT used FROM recipe_image_quota WHERE principal=${userId} AND day=CURRENT_DATE`);
    const [sourceJobAfter] = await db.execute(sql`SELECT id,user_id,sync_item_id,state,dispatched_at,recipe
      FROM recipe_image_jobs WHERE id=${sourceJobId}::uuid`);
    const [sourceAssetAfter] = await db.execute(sql`SELECT job_id,encode(content,'base64') AS bytes,hash,width,height,
      source,author,source_url,license,model FROM recipe_image_assets WHERE job_id=${sourceJobId}::uuid`);

    expect({
      targetState: targetAfter.state,
      targetDispatched: targetAfter.dispatched_at !== null,
      targetAssets: Number(targetAssets.count),
      providerCalls: fetch.mock.calls.length,
      quotaUsed: Number(quotaAfter.used),
      sourceJob: sourceJobAfter,
      sourceAsset: sourceAssetAfter,
    }).toEqual({
      targetState: 'consent_required',
      targetDispatched: false,
      targetAssets: 0,
      providerCalls: 0,
      quotaUsed: 2,
      sourceJob: sourceBefore,
      sourceAsset: sourceAssetBefore,
    });
  });

  it('rechecks private consent immediately before dispatch and respects the daily quota', async () => {
    await grantImageConsent();
    await save('revoked', { title: 'Private after revoke', ingredients: [{ name: 'Rice' }] });
    const revokedJob = await enqueuePrivate('revoked');
    await createDrizzleSyncRepository(db).updateAiConsent(userId, { enabled: false });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await runImageTick(db, config, undefined, revokedJob);
    const [revoked] = await db.execute(sql`SELECT state FROM recipe_image_jobs WHERE id=${revokedJob}::uuid`);
    expect(revoked.state).toBe('consent_required');
    expect(fetch).not.toHaveBeenCalled();

    await grantImageConsent();
    await save('quota-boundary', { title: 'At limit', ingredients: [{ name: 'Rice' }] });
    const quotaJob = await enqueuePrivate('quota-boundary');
    await db.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES(${userId},CURRENT_DATE,5)
      ON CONFLICT(principal,day) DO UPDATE SET used=5`);
    await runImageTick(db, config, undefined, quotaJob);
    const [limited] = await db.execute(sql`SELECT state,dispatched_at FROM recipe_image_jobs WHERE id=${quotaJob}::uuid`);
    expect(limited.state).toBe('quota_exceeded');
    expect(limited.dispatched_at).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});