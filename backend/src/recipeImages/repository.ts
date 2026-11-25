import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import type { ImageConfig } from './config.js';
import { createImageProvider, ImageProviderError, type ImageRecipe } from './providers.js';
import { hasImageConsent } from './generation.js';

type Database = ApplicationDatabase['db'];
class StaleImageClaim extends Error {}

export async function runImageTick(
  db: Database,
  config: ImageConfig,
  provider = createImageProvider(config),
  targetJobId?: string,
) {
  if (!config.enabled) return;
  const job = await db.transaction(async claim => {
    // The helper is deliberately absent until 0021 so a v3 worker cannot run on a v2 schema.
    await claim.execute(sql`SELECT public.set_recipe_image_policy_v3()`);
    await claim.execute(sql`UPDATE recipe_image_jobs SET state='failed',updated_at=now() WHERE id IN (
      SELECT id FROM recipe_image_jobs WHERE state='processing' AND updated_at < now()-interval '10 minutes' FOR UPDATE SKIP LOCKED)`);
    const [row] = await claim.execute(sql`UPDATE recipe_image_jobs SET state='processing', attempts=attempts+1, updated_at=clock_timestamp()
      WHERE id=(SELECT id FROM recipe_image_jobs WHERE state IN ('pending','quota_exceeded') AND dispatched_at IS NULL AND available_at<=now()
        AND (${targetJobId ?? null}::uuid IS NULL OR id=${targetJobId ?? null}::uuid) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *, updated_at::text AS claim_time`);
    return row;
  });
  if (!job) return;

  const id = String(job.id);
  const currentClaim = sql`id=${id} AND state='processing' AND attempts=${String(job.attempts)}::bigint AND updated_at=${String(job.claim_time)}::timestamptz`;
  const fail = (executor: Pick<Database, 'execute'>, error: unknown) => executor.execute(sql`UPDATE recipe_image_jobs
    SET state=CASE WHEN ${error instanceof ImageProviderError && error.ambiguous} OR dispatched_at IS NOT NULL OR attempts>=3 THEN 'failed' ELSE 'pending' END,
        available_at=now()+interval '1 minute'*attempts,updated_at=now() WHERE ${currentClaim}`);

  try {
    await db.transaction(async tx => {
      if (job.user_id) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ikuck:ai-consent:${job.user_id}`},0))`);
      }
      const consent = !job.sync_item_id || (job.user_id && await hasImageConsent(tx, String(job.user_id)));
      if (!(await tx.execute(sql`SELECT id FROM recipe_image_jobs WHERE ${currentClaim} AND dispatched_at IS NULL`)).length) return;
      if (!consent) {
        await tx.execute(sql`UPDATE recipe_image_jobs SET state='consent_required' WHERE ${currentClaim}`);
        return;
      }

      const recipe = job.recipe as unknown as ImageRecipe;
      const principal = job.user_id ? String(job.user_id) : 'catalog';
      const identityScope = job.user_id
        ? `private:${principal}`
        : job.catalog_id
          ? 'catalog'
          : undefined;
      if (identityScope) {
        const identityRecipe = {
          title: recipe.title,
          ingredients: recipe.ingredients.map(({ name }) => ({ name })),
        };
        const identityFingerprint = createHash('sha256')
          .update(JSON.stringify(identityRecipe))
          .digest('hex');
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${`ikuck:recipe-image-dedupe:v1:${identityScope}:${identityFingerprint}`},0))`);
        const principalFilter = job.user_id
          ? sql`j.user_id=${String(job.user_id)}::uuid`
          : sql`j.user_id IS NULL AND j.catalog_id IS NOT NULL`;
        const [reusableAsset] = await tx.execute(sql`SELECT a.content,a.hash,a.width,a.height,
            a.source,a.author,a.source_url,a.license,a.model
          FROM recipe_image_jobs j JOIN recipe_image_assets a ON a.job_id=j.id
          WHERE j.state='ready' AND j.recipe=${JSON.stringify(identityRecipe)}::jsonb
            AND j.id<>${id}::uuid AND ${principalFilter}
            AND a.source='ai' AND a.author='openai' AND a.model IS NOT NULL AND a.model<>''
          ORDER BY j.updated_at DESC,j.id ASC LIMIT 1`);
        if (reusableAsset) {
          if (!(await tx.execute(sql`SELECT id FROM recipe_image_jobs
            WHERE ${currentClaim} AND dispatched_at IS NULL FOR UPDATE`)).length) return;
          await tx.execute(sql`INSERT INTO recipe_image_assets(
              job_id,content,hash,width,height,source,author,source_url,license,model)
            VALUES(${id},${reusableAsset.content},${reusableAsset.hash},${reusableAsset.width},
              ${reusableAsset.height},${reusableAsset.source},${reusableAsset.author},
              ${reusableAsset.source_url},${reusableAsset.license},${reusableAsset.model})`);
          await tx.execute(sql`UPDATE recipe_image_jobs SET state='ready',updated_at=clock_timestamp()
            WHERE ${currentClaim} AND dispatched_at IS NULL`);
          return;
        }
      }

      let reserved: boolean;
      try {
        reserved = await db.transaction(async reservation => {
          await reservation.execute(sql`SELECT public.set_recipe_image_policy_v3()`);
          const quota = await reservation.execute(sql`INSERT INTO recipe_image_quota(principal,day,used)
            VALUES(${principal},CURRENT_DATE,1)
            ON CONFLICT(principal,day) DO UPDATE SET used=recipe_image_quota.used+1
            WHERE recipe_image_quota.used<${config.dailyLimit} RETURNING used`);
          if (!quota.length) return false;
          const marked = await reservation.execute(sql`UPDATE recipe_image_jobs SET dispatched_at=clock_timestamp()
            WHERE ${currentClaim} AND dispatched_at IS NULL RETURNING id`);
          if (!marked.length) throw new StaleImageClaim();
          return true;
        });
      } catch (error) {
        if (error instanceof StaleImageClaim) return;
        throw error;
      }
      if (!reserved) {
        await tx.execute(sql`UPDATE recipe_image_jobs SET state='quota_exceeded',
          available_at=date_trunc('day',statement_timestamp())+interval '1 day'
          WHERE ${currentClaim} AND dispatched_at IS NULL`);
        return;
      }
      if (!(await tx.execute(sql`SELECT id FROM recipe_image_jobs WHERE ${currentClaim} AND dispatched_at IS NOT NULL FOR UPDATE`)).length) return;

      let result;
      try {
        result = await provider.generate(recipe);
      } catch (error) {
        await fail(tx, error);
        return;
      }
      const hash = createHash('sha256').update(result.bytes).digest('hex');
      await tx.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license,model)
        VALUES (${id},${result.bytes},${hash},${result.width},${result.height},'ai',${result.author},'','',${config.model})`);
      await tx.execute(sql`UPDATE recipe_image_jobs SET state='ready',updated_at=clock_timestamp() WHERE ${currentClaim}`);
    });
  } catch (error) {
    // The committed dispatch marker and quota survive transaction failure, preventing paid replay.
    await fail(db, error);
  }
}