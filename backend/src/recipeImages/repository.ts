import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { ApplicationDatabase } from '../db/client.js';
import type { ImageConfig } from './config.js';
import { createImageProvider, ImageProviderError, type ImageRecipe } from './providers.js';
type Database = ApplicationDatabase['db'];
export async function runImageTick(db: Database, config: ImageConfig, provider = createImageProvider(config), targetJobId?: string) {
  if (!config.enabled) return;
  // An interrupted dispatch may have incurred charges. Quarantine instead of dispatching again.
  await db.execute(sql`UPDATE recipe_image_jobs SET state='failed' WHERE state='processing' AND updated_at < now()-interval '10 minutes'`);
  const rows = await db.execute(sql`UPDATE recipe_image_jobs SET state='processing', attempts=attempts+1, updated_at=now() WHERE id=(SELECT id FROM recipe_image_jobs WHERE (state='pending' OR (state='quota_exceeded' AND catalog_id IS NOT NULL)) AND available_at<=now() AND (${targetJobId ?? null}::uuid IS NULL OR id=${targetJobId ?? null}::uuid) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
  const job = rows[0]; if (!job) return;
  const id = String(job.id);
  try {
    await db.transaction(async tx => {
      if (job.sync_item_id && !job.user_id) { await tx.execute(sql`UPDATE recipe_image_jobs SET state='consent_required' WHERE id=${id}`); return; }
      if (job.user_id) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ikuck:ai-consent:${job.user_id}`},0))`);
        const consent = await tx.execute(sql`SELECT payload FROM sync_items WHERE scope_type='user' AND scope_id=${String(job.user_id)} AND entity_type='ai_consent' AND NOT deleted`);
        const payload = consent[0]?.payload as { enabled?: boolean; imagePolicyVersion?: string; homeProvider?: string; imageProvider?: string } | undefined;
        if (!payload?.enabled || payload.imagePolicyVersion !== 'recipe-images-v1' || (payload.imageProvider ?? payload.homeProvider) !== config.provider) {
          await tx.execute(sql`UPDATE recipe_image_jobs SET state='consent_required' WHERE id=${id}`); return;
        }
      }
      const exists = await tx.execute(sql`SELECT id FROM recipe_image_jobs WHERE id=${id}`); if (!exists.length) return;
      const recipe = job.recipe as unknown as ImageRecipe;
      const [reused] = await tx.execute(sql`SELECT a.* FROM recipe_image_assets a JOIN recipe_image_jobs j ON j.id=a.job_id WHERE j.recipe=${JSON.stringify(job.recipe)}::jsonb AND j.user_id IS NOT DISTINCT FROM ${job.user_id}::uuid AND j.id<>${id} LIMIT 1`);
      let result = reused ? { bytes: Buffer.from(reused.content as Uint8Array), width: Number(reused.width), height: Number(reused.height), source: reused.source as 'ai' | 'pexels', author: String(reused.author), sourceUrl: String(reused.source_url), license: String(reused.license) } : await provider.search(recipe);
      if (!result) {
        const principal = job.user_id ? String(job.user_id) : 'catalog';
        // Commit the reservation and dispatch marker independently before paid external work.
        const reserved = await db.transaction(async reservation => {
          const quota = await reservation.execute(sql`INSERT INTO recipe_image_quota(principal,day,used) VALUES(${principal},CURRENT_DATE,1) ON CONFLICT(principal,day) DO UPDATE SET used=recipe_image_quota.used+1 WHERE recipe_image_quota.used<${config.dailyLimit} RETURNING used`);
          if (!quota.length) return false;
          await reservation.execute(sql`UPDATE recipe_image_jobs SET dispatched_at=now() WHERE id=${id}`); return true;
        });
        if (!reserved) { await tx.execute(sql`UPDATE recipe_image_jobs SET state='quota_exceeded',available_at=date_trunc('day',now())+interval '1 day' WHERE id=${id}`); return; }
        result = await provider.generate(recipe);
      }
      const hash = createHash('sha256').update(result.bytes).digest('hex');
      await tx.execute(sql`INSERT INTO recipe_image_assets(job_id,content,hash,width,height,source,author,source_url,license,model) SELECT ${id},${result.bytes},${hash},${result.width},${result.height},${result.source},${result.author},${result.sourceUrl},${result.license},${result.source === 'ai' ? config.model : null} WHERE EXISTS(SELECT 1 FROM recipe_image_jobs WHERE id=${id}) ON CONFLICT(job_id) DO NOTHING`);
      await tx.execute(sql`UPDATE recipe_image_jobs SET state='ready',updated_at=now() WHERE id=${id}`);
    });
  } catch (error) {
    const ambiguous = error instanceof ImageProviderError && error.ambiguous;
    await db.execute(sql`UPDATE recipe_image_jobs SET state=CASE WHEN ${ambiguous} OR dispatched_at IS NOT NULL OR attempts>=3 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '1 minute'*attempts,updated_at=now() WHERE id=${id}`);
  }
}
