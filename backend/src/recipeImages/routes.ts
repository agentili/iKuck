import { z } from 'zod';
import { RECIPES } from '@ikuck/shared/recipeCatalog';
import { getIngredient } from '@ikuck/shared/ingredients';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ApplicationDatabase } from '../db/client.js';
import type { AuthService } from '../auth/service.js';
import { ensureSameOrigin, ensureCsrf, requireVerifiedSession } from '../routes/auth.js';
import { imageConfig } from './config.js';

export const imageRoutes = (db: ApplicationDatabase['db'], auth: AuthService, appOrigin: string): FastifyPluginAsync => async app => {
  const config = imageConfig();
  app.get<{ Params: { recipeId: string }; Querystring: { kind?: string } }>('/v1/recipe-images/:recipeId', async (request, reply) => {
    if (!config.enabled) return { state: 'disabled' };
    const kind = request.query.kind === 'private' ? 'private' : 'catalog';
    const userId = kind === 'private' ? (await requireVerifiedSession(request, auth)).session.userId : null;
    const rows = await db.execute(sql`SELECT j.id,j.state,a.width,a.height,a.source,a.author,a.source_url,a.license FROM recipe_image_jobs j LEFT JOIN recipe_image_assets a ON a.job_id=j.id LEFT JOIN sync_items s ON s.id=j.sync_item_id WHERE (${kind}='catalog' AND j.catalog_id=${request.params.recipeId}) OR (${kind}='private' AND s.entity_id=${request.params.recipeId} AND NOT s.deleted AND ((s.scope_type='user' AND s.scope_id=${userId}) OR (s.scope_type='house' AND EXISTS(SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${userId})))) LIMIT 1`);
    reply.header('Cache-Control', 'no-store');
    const row = rows[0];
    return row ? { state: row.state, ...(row.state === 'ready' ? { url: `/v1/recipe-images/assets/${row.id}`, width: Number(row.width), height: Number(row.height), source: row.source, author: row.author, sourceUrl: row.source_url, license: row.license } : {}) } : { state: 'pending' };
  });
  app.get<{ Params: { id: string } }>('/v1/recipe-images/assets/:id', async (request, reply) => {
    if (!config.enabled || !/^[a-f0-9-]{36}$/.test(request.params.id)) return reply.code(404).send();
    const [job] = await db.execute(sql`SELECT catalog_id FROM recipe_image_jobs WHERE id=${request.params.id}`);
    if (!job) return reply.code(404).send();
    const userId = job.catalog_id ? null : (await requireVerifiedSession(request, auth)).session.userId;
    const [asset] = await db.execute(sql`SELECT a.content,a.hash FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id LEFT JOIN sync_items s ON s.id=j.sync_item_id WHERE j.id=${request.params.id} AND (j.catalog_id IS NOT NULL OR (NOT s.deleted AND ((s.scope_type='user' AND s.scope_id=${userId}) OR (s.scope_type='house' AND EXISTS(SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${userId})))) )`);
    if (!asset) return reply.code(404).send();
    reply.header('Cache-Control', job.catalog_id ? 'public, max-age=86400' : 'private, no-store').header('X-Content-Type-Options','nosniff').type('image/webp');
    return reply.send(asset.content);
  });
  app.post('/v1/recipe-images/generate-library', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, auth);
    ensureCsrf(request, session.csrfTokenHash);
    if (!config.enabled) return reply.code(503).send({ error: 'images_disabled' });
    const parsed = z.object({ scope: z.string().min(1).max(100) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_scope' });
    const scope = parsed.data.scope;
    const userId = session.userId;
    const houseId = scope.startsWith('house:') ? scope.slice(6) : null;
    if (scope !== `account:${userId}` && houseId === null) return reply.code(403).send({ error: 'scope_forbidden' });
    const queued = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ikuck:ai-consent:${userId}`},0))`);
      if (houseId !== null) {
        const membership = await tx.execute(sql`SELECT 1 FROM house_memberships WHERE house_id::text=${houseId} AND user_id=${userId} FOR SHARE`);
        if (!membership.length) return null;
      }
      const [row] = await tx.execute(sql`SELECT payload FROM sync_items WHERE scope_type='user' AND scope_id=${userId} AND entity_type='ai_consent' AND NOT deleted`);
      const consent = row?.payload as { enabled?: boolean; imagePolicyVersion?: string; imageProvider?: string; homeProvider?: string } | undefined;
      if (!consent?.enabled || consent.imagePolicyVersion !== 'recipe-images-v1' || (consent.imageProvider ?? consent.homeProvider) !== config.provider) return false;
      let count = 0;
      for (const recipe of RECIPES) {
        // Existing bundled artwork does not need provider work.
        if (recipe.id === 'uova-al-pomodoro') continue;
        const payload = { title: recipe.title, ingredients: recipe.ingredients.map(i => ({ name: i.name ?? getIngredient(i.ingredientId)?.label ?? i.ingredientId })) };
        const rows = await tx.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe) VALUES(${recipe.id},${JSON.stringify(payload)}::jsonb) ON CONFLICT(catalog_id) DO NOTHING RETURNING id`);
        count += rows.length;
      }
      const inserted = await tx.execute(sql`INSERT INTO recipe_image_jobs(sync_item_id,user_id,recipe)
        SELECT s.id,s.user_id,jsonb_build_object('title',s.payload->'title','ingredients',s.payload->'ingredients') FROM sync_items s
        WHERE NOT s.deleted AND s.entity_type IN ('generated_recipe','saved_recipe') AND s.user_id=${userId}
        AND ((s.scope_type='user' AND s.scope_id=${userId} AND ${houseId}::text IS NULL)
          OR (s.scope_type='house' AND s.scope_id=${houseId}))
        ON CONFLICT(sync_item_id) DO NOTHING RETURNING id`);
      count += inserted.length;
      const resumed = await tx.execute(sql`UPDATE recipe_image_jobs j SET state='pending',attempts=0,available_at=now(),updated_at=now()
        FROM sync_items s WHERE j.sync_item_id=s.id AND j.user_id=${userId} AND NOT s.deleted
        AND j.state IN ('consent_required','quota_exceeded') AND j.dispatched_at IS NULL
        AND ((s.scope_type='user' AND s.scope_id=${userId} AND ${houseId}::text IS NULL)
          OR (s.scope_type='house' AND s.scope_id=${houseId})) RETURNING j.id`);
      return count + resumed.length;
    });
    if (queued === null) return reply.code(403).send({ error: 'scope_forbidden' });
    if (queued === false) return reply.code(403).send({ error: 'ai_image_consent_required' });
    return reply.code(202).send({ queued });
  });
  app.post<{ Params: { recipeId: string } }>('/v1/recipe-images/:recipeId/retry', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, auth); ensureCsrf(request, session.csrfTokenHash);
    if (!config.enabled) return reply.code(503).send({ error: 'images_disabled' });
    // Only the owner who authorizes dispatch can trigger another paid attempt.
    await db.execute(sql`UPDATE recipe_image_jobs j SET state='pending',attempts=0,dispatched_at=NULL,available_at=now(),updated_at=now() FROM sync_items s WHERE j.sync_item_id=s.id AND s.entity_id=${request.params.recipeId} AND j.user_id=${session.userId} AND NOT s.deleted AND j.state IN ('failed','consent_required','quota_exceeded')`);
    return reply.code(202).send({ state: 'pending' });
  });
};
