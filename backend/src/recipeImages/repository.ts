import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { hasCommonsImageCredit } from '@ikuck/shared/contracts';
import type { ApplicationDatabase } from '../db/client.js';
import type { ImageConfig } from './config.js';
import { createImageProvider, ImageProviderError, type ImageRecipe } from './providers.js';
import { COMMONS_ASSET_PROVENANCE, hasImageConsent } from './generation.js';
type Database = ApplicationDatabase['db'];
class StaleImageClaim extends Error {}
export async function runImageTick(db: Database, config: ImageConfig, provider = createImageProvider(config), targetJobId?: string) {
  if (!config.enabled) return;
  const job = await db.transaction(async claim => {
    // The helper is deliberately absent before 0020. No claim or cleanup is
    // allowed until the database supports the same policy as this worker.
    await claim.execute(sql`SELECT public.set_recipe_image_policy_v2()`);
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
  const fail = (executor: Pick<Database,'execute'>, error: unknown) => executor.execute(sql`UPDATE recipe_image_jobs
    SET state=CASE WHEN ${error instanceof ImageProviderError && error.ambiguous} OR dispatched_at IS NOT NULL OR attempts>=3 THEN 'failed' ELSE 'pending' END,
        available_at=now()+interval '1 minute'*attempts,updated_at=now() WHERE ${currentClaim}`);
  try {
    await db.transaction(async tx => {
      if (job.user_id) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ikuck:ai-consent:${job.user_id}`},0))`);
      }
      const consent = !job.sync_item_id || (job.user_id && await hasImageConsent(tx, String(job.user_id), config));
      if (!(await tx.execute(sql`SELECT id FROM recipe_image_jobs WHERE ${currentClaim} AND dispatched_at IS NULL`)).length) return;
      if (!consent) {
        await tx.execute(sql`UPDATE recipe_image_jobs SET state='consent_required' WHERE ${currentClaim}`);
        return;
      }
      const recipe = job.recipe as unknown as ImageRecipe;
      const [asset] = await tx.execute(sql`SELECT a.* FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id
        WHERE j.state='ready' AND j.recipe=${JSON.stringify(job.recipe)}::jsonb AND j.user_id IS NOT DISTINCT FROM ${job.user_id}::uuid AND j.id<>${id}
        AND (a.source IN ('ai','pexels') OR (a.source='wikimedia' AND a.model=${COMMONS_ASSET_PROVENANCE})) LIMIT 1`);
      const reused = asset && (asset.source !== 'wikimedia' || hasCommonsImageCredit(asset.author, asset.source_url, asset.license)) ? asset : undefined;
      let result: Awaited<ReturnType<typeof provider.search>>;
      try {
        result = reused ? { bytes: Buffer.from(reused.content as Uint8Array), width: Number(reused.width), height: Number(reused.height), source: reused.source as 'ai' | 'pexels' | 'wikimedia', author: String(reused.author), sourceUrl: String(reused.source_url), license: String(reused.license) } : await provider.search(recipe);
        if (result?.source === 'wikimedia' && !hasCommonsImageCredit(result.author, result.sourceUrl, result.license)) throw new ImageProviderError();
      } catch (error) { await fail(tx, error); return; }
      if (result === null) {
        const principal = job.user_id ? String(job.user_id) : 'catalog';
        // This transaction uses a separate connection. The outer consent
        // transaction has not acquired a row lock on the job.
        let reserved: boolean;
        try {
          reserved = await db.transaction(async reservation => {
            const quota = await reservation.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES(${principal},CURRENT_DATE,1) ON CONFLICT(principal,day) DO UPDATE SET used=recipe_image_quota.used+1 WHERE recipe_image_quota.used<${config.dailyLimit} RETURNING used`);
            if (!quota.length) return false;
            const marked = await reservation.execute(sql`UPDATE recipe_image_jobs SET dispatched_at=clock_timestamp()
              WHERE ${currentClaim} AND dispatched_at IS NULL RETURNING id`);
            if (!marked.length) throw new StaleImageClaim(); // Roll back the quota increment too.
            return true;
          });
        } catch (error) { if (error instanceof StaleImageClaim) return; throw error; }
        if (!reserved) {
          await tx.execute(sql`UPDATE recipe_image_jobs SET state='quota_exceeded',available_at=date_trunc('day',statement_timestamp())+interval '1 day'
            WHERE ${currentClaim} AND dispatched_at IS NULL`);
          return;
        }
        if (!(await tx.execute(sql`SELECT id FROM recipe_image_jobs WHERE ${currentClaim} AND dispatched_at IS NOT NULL FOR UPDATE`)).length) return;
        try { result = await provider.generate(recipe); }
        catch (error) { await fail(tx, error); return; }
      } else if (!(await tx.execute(sql`SELECT id FROM recipe_image_jobs WHERE ${currentClaim} AND dispatched_at IS NULL FOR UPDATE`)).length) {
        return;
      }
      const hash = createHash('sha256').update(result.bytes).digest('hex');
      const provenance = result.source === 'wikimedia' ? COMMONS_ASSET_PROVENANCE : result.source === 'ai' ? config.model : null;
      await tx.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license,model)
        VALUES (${id},${result.bytes},${hash},${result.width},${result.height},${result.source},${result.author},${result.sourceUrl},${result.license},${provenance})`);
      await tx.execute(sql`UPDATE recipe_image_jobs SET state='ready',updated_at=clock_timestamp() WHERE ${currentClaim}`);
    });
  } catch (error) {
    // A database failure can abort the consent transaction. The committed
    // dispatch marker still prevents automatic replay and this update is fenced.
    await fail(db, error);
  }
}
