import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ApplicationDatabase } from '../db/client.js';
import type { AuthService } from '../auth/service.js';
import { ensureSameOrigin, ensureCsrf, requireVerifiedSession } from '../routes/auth.js';
import { RECIPES } from '@ikuck/shared/recipeCatalog';
import { hasImageConsent, queueCatalogImages, queuePrivateImages } from './generation.js';
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
    return row ? { state: row.state, ...(row.state === 'ready' ? { url: `/v1/recipe-images/assets/${row.id}`, width: Number(row.width), height: Number(row.height), source: row.source, author: row.author, sourceUrl: row.source_url, license: row.license } : {}) } : { state: 'missing' };
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
  app.post('/v1/recipe-images/generate', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, auth);
    ensureCsrf(request, session.csrfTokenHash);
    if (!config.enabled) return reply.code(503).send({ code: 'images_disabled' });
    if (!await hasImageConsent(db, session.userId, config)) return reply.code(403).send({ code: 'image_consent_required' });
    const queued = await db.transaction(async tx =>
      await queueCatalogImages(tx) + await queuePrivateImages(tx, session.userId));
    return reply.code(202).send({ queued });
  });
  const generateSingle = async (request: import('fastify').FastifyRequest<{ Params: { recipeId: string }; Querystring: { kind?: string } }>, reply: import('fastify').FastifyReply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, auth);
    ensureCsrf(request, session.csrfTokenHash);
    if (!config.enabled) return reply.code(503).send({ code: 'images_disabled' });
    const recipeId = request.params.recipeId;
    if (request.query.kind === 'catalog') {
      if (!RECIPES.some(recipe => recipe.id === recipeId)) return reply.code(404).send({ code: 'recipe_not_found' });
      const queued = await queueCatalogImages(db, recipeId);
      return reply.code(202).send({ queued });
    }
    if (!await hasImageConsent(db, session.userId, config)) return reply.code(403).send({ code: 'image_consent_required' });
    const [recipe] = await db.execute(sql`SELECT s.id FROM sync_items s WHERE s.entity_id=${recipeId} AND s.user_id=${session.userId}::uuid
      AND NOT s.deleted AND s.entity_type IN ('generated_recipe','saved_recipe')
      AND ((s.scope_type='user' AND s.scope_id=${session.userId}) OR (s.scope_type='house' AND EXISTS(
        SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${session.userId}::uuid))) LIMIT 1`);
    if (!recipe) return reply.code(404).send({ code: 'recipe_not_found' });
    const queued = await queuePrivateImages(db, session.userId, recipeId);
    return reply.code(202).send({ queued });
  };
  app.post<{ Params: { recipeId: string }; Querystring: { kind?: string } }>('/v1/recipe-images/:recipeId/generate', generateSingle);
  app.post<{ Params: { recipeId: string }; Querystring: { kind?: string } }>('/v1/recipe-images/:recipeId/retry', generateSingle);
};
