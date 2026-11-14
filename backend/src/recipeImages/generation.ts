import { sql } from 'drizzle-orm';
import { RECIPES } from '@ikuck/shared/recipeCatalog';
import { getIngredient } from '@ikuck/shared/ingredients';
import type { ApplicationDatabase } from '../db/client.js';
import type { ImageConfig } from './config.js';

type Database = Pick<ApplicationDatabase['db'], 'execute'>;
export const catalogImageRecipes = RECIPES.filter(recipe => recipe.id !== 'uova-al-pomodoro').map(recipe => ({
  id: recipe.id,
  title: recipe.title,
  ingredients: recipe.ingredients.map(item => ({ name: item.name ?? getIngredient(item.ingredientId)?.label ?? item.ingredientId })),
}));

export async function hasImageConsent(db: Database, userId: string, config: ImageConfig) {
  const [row] = await db.execute(sql`SELECT payload FROM sync_items WHERE scope_type='user' AND scope_id=${userId} AND entity_type='ai_consent' AND NOT deleted`);
  const consent = row?.payload as { enabled?: boolean; imagePolicyVersion?: string; imageProvider?: string; homeProvider?: string } | undefined;
  return consent?.enabled === true && consent.imagePolicyVersion === 'recipe-images-v1'
    && (consent.imageProvider ?? consent.homeProvider) === config.provider;
}

// Never replace ready assets or reset a running dispatch, including concurrent requests.
export async function queueCatalogImages(db: Database, recipeId?: string) {
  const recipes = catalogImageRecipes.filter(recipe => recipeId === undefined || recipe.id === recipeId);
  if (!recipes.length) return 0;
  const rows = await db.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe)
    SELECT r->>'id',r-'id' FROM jsonb_array_elements(${JSON.stringify(recipes)}::jsonb) r WHERE true
    ON CONFLICT(catalog_id) DO UPDATE SET state='pending',attempts=0,dispatched_at=NULL,available_at=now(),updated_at=now()
    WHERE recipe_image_jobs.state IN ('failed','consent_required') RETURNING id`);
  return rows.length;
}

export async function queuePrivateImages(db: Database, userId: string, recipeId?: string) {
  // Only the author can authorize a paid retry; house membership alone is insufficient.
  const rows = await db.execute(sql`INSERT INTO recipe_image_jobs(sync_item_id,user_id,recipe)
    SELECT s.id,${userId}::uuid,jsonb_build_object('title',s.payload->'title','ingredients',s.payload->'ingredients')
    FROM sync_items s WHERE s.user_id=${userId}::uuid AND NOT s.deleted
    AND s.entity_type IN ('generated_recipe','saved_recipe')
    AND (${recipeId ?? null}::text IS NULL OR s.entity_id=${recipeId ?? null})
    AND ((s.scope_type='user' AND s.scope_id=${userId}) OR (s.scope_type='house' AND EXISTS(
      SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${userId}::uuid)))
    ON CONFLICT(sync_item_id) DO UPDATE SET state='pending',attempts=0,dispatched_at=NULL,available_at=now(),updated_at=now()
    WHERE recipe_image_jobs.user_id=${userId}::uuid AND recipe_image_jobs.state IN ('failed','consent_required') RETURNING id`);
  return rows.length;
}
