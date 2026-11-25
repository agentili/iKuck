import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ApplicationDatabase } from '../db/client.js';
import type { AuthService } from '../auth/service.js';
import { ensureSameOrigin, ensureCsrf, requireVerifiedSession } from '../routes/auth.js';
import { RECIPES } from '@ikuck/shared/recipeCatalog';
import { hasCommonsImageCredit, RECIPE_IMAGE_METADATA_VERSION } from '@ikuck/shared/contracts';
import { COMMONS_ASSET_PROVENANCE, hasImageConsent, queueCatalogImages, queuePrivateImages } from './generation.js';
import { imageConfig } from './config.js';

const metadataVersion = (url: string) => {
  const values = new URLSearchParams(url.slice(url.indexOf('?') + 1)).getAll('metadataVersion');
  return !values.length ? undefined : values.length === 1 && values[0] === String(RECIPE_IMAGE_METADATA_VERSION)
    ? RECIPE_IMAGE_METADATA_VERSION : null;
};
const creditAllowsServing = (row: Record<string, unknown>, version: number | undefined) =>
  row.source === 'ai' || row.source === 'pexels' || (row.source === 'wikimedia' && version === RECIPE_IMAGE_METADATA_VERSION
    && row.model === COMMONS_ASSET_PROVENANCE && hasCommonsImageCredit(row.author, row.source_url, row.license));

export const imageRoutes = (db: ApplicationDatabase['db'], auth: AuthService, appOrigin: string): FastifyPluginAsync => async app => {
  const config = imageConfig();
  app.get<{ Params: { recipeId: string }; Querystring: { kind?: string } }>('/v1/recipe-images/:recipeId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const version = metadataVersion(request.url);
    if (version === null) return reply.code(400).send({ code: 'invalid_metadata_version' });
    const contract = version ? { metadataVersion: version } : {};
    if (!config.enabled) return { state: 'disabled', ...contract };
    const kind = request.query.kind === 'private' ? 'private' : 'catalog';
    const userId = kind === 'private' ? (await requireVerifiedSession(request, auth)).session.userId : null;
    const [row] = await db.execute(sql`SELECT j.id,j.state,a.width,a.height,a.source,a.author,a.source_url,a.license,a.model FROM recipe_image_jobs j LEFT JOIN recipe_image_assets a ON a.job_id=j.id LEFT JOIN sync_items s ON s.id=j.sync_item_id WHERE (${kind}='catalog' AND j.catalog_id=${request.params.recipeId}) OR (${kind}='private' AND s.entity_id=${request.params.recipeId} AND NOT s.deleted AND ((s.scope_type='user' AND s.scope_id=${userId}) OR (s.scope_type='house' AND EXISTS(SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${userId})))) LIMIT 1`);
    if (!row || (row.state === 'ready' && !creditAllowsServing(row, version))) return { state: 'missing', ...contract };
    if (row.state !== 'ready') return { state: row.state, ...contract };
    return { state: 'ready', ...contract, url: `/v1/recipe-images/assets/${row.id}${version ? `?metadataVersion=${version}` : ''}`,
      width: Number(row.width), height: Number(row.height), source: row.source, author: row.author, sourceUrl: row.source_url, license: row.license };
  });
  app.get<{ Params: { id: string } }>('/v1/recipe-images/assets/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const version = metadataVersion(request.url);
    if (version === null) return reply.code(400).send({ code: 'invalid_metadata_version' });
    if (!config.enabled || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.params.id)) return reply.code(404).send();
    const [job] = await db.execute(sql`SELECT catalog_id FROM recipe_image_jobs WHERE id=${request.params.id}`);
    if (!job) return reply.code(404).send();
    const userId = job.catalog_id ? null : (await requireVerifiedSession(request, auth)).session.userId;
    const [asset] = await db.execute(sql`SELECT a.content,a.source,a.model,a.author,a.source_url,a.license,j.state FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id LEFT JOIN sync_items s ON s.id=j.sync_item_id WHERE j.id=${request.params.id} AND (j.catalog_id IS NOT NULL OR (NOT s.deleted AND ((s.scope_type='user' AND s.scope_id=${userId}) OR (s.scope_type='house' AND EXISTS(SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${userId})))) )`);
    if (!asset || !creditAllowsServing(asset, version) || (asset.source === 'wikimedia' && asset.state !== 'ready')) return reply.code(404).send();
    reply.header('Cache-Control', job.catalog_id ? 'public, max-age=86400' : 'private, no-store').header('X-Content-Type-Options','nosniff').type('image/webp');
    return reply.send(asset.content);
  });
  const generateSingle = async (request: import('fastify').FastifyRequest<{ Params: { recipeId: string }; Querystring: { kind?: string } }>, reply: import('fastify').FastifyReply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, auth);
    ensureCsrf(request, session.csrfTokenHash);
    if (!config.enabled) return reply.code(503).send({ code: 'images_disabled' });
    if (request.query.kind !== undefined && request.query.kind !== 'catalog' && request.query.kind !== 'private') {
      return reply.code(400).send({ code: 'invalid_image_kind' });
    }
    const recipeId = request.params.recipeId;
    if (request.query.kind === 'catalog') {
      if (!RECIPES.some(recipe => recipe.id === recipeId)) return reply.code(404).send({ code: 'recipe_not_found' });
      const queued = await db.transaction(async tx => {
        await tx.execute(sql`SELECT public.set_recipe_image_request_v3()`);
        return queueCatalogImages(tx, recipeId);
      });
      return reply.code(202).send({ queued });
    }
    if (!await hasImageConsent(db, session.userId)) return reply.code(403).send({ code: 'image_consent_required' });
    const [recipe] = await db.execute(sql`SELECT s.id FROM sync_items s WHERE s.entity_id=${recipeId} AND s.user_id=${session.userId}::uuid
      AND NOT s.deleted AND s.entity_type IN ('generated_recipe','saved_recipe')
      AND ((s.scope_type='user' AND s.scope_id=${session.userId}) OR (s.scope_type='house' AND EXISTS(
        SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${session.userId}::uuid))) LIMIT 1`);
    if (!recipe) return reply.code(404).send({ code: 'recipe_not_found' });
    const queued = await db.transaction(async tx => {
      await tx.execute(sql`SELECT public.set_recipe_image_request_v3()`);
      return queuePrivateImages(tx, session.userId, recipeId);
    });
    return reply.code(202).send({ queued });
  };
  app.post<{ Params: { recipeId: string }; Querystring: { kind?: string } }>('/v1/recipe-images/:recipeId/generate', generateSingle);
  app.post<{ Params: { recipeId: string }; Querystring: { kind?: string } }>('/v1/recipe-images/:recipeId/retry', generateSingle);
};
