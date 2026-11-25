import { sql } from 'drizzle-orm';
import { RECIPES } from '@ikuck/shared/recipeCatalog';
import { getIngredient } from '@ikuck/shared/ingredients';
import type { ApplicationDatabase } from '../db/client.js';
type Database = Pick<ApplicationDatabase['db'], 'execute'>;
// The existing model slot is a provenance tag for Commons, never an AI model.
export const COMMONS_ASSET_PROVENANCE = 'commons-cc0-v2';
export const catalogImageRecipes = RECIPES.filter(recipe => recipe.id !== 'uova-al-pomodoro').map(recipe => ({
  id: recipe.id,
  title: recipe.title,
  ingredients: recipe.ingredients.map(item => ({ name: item.name ?? getIngredient(item.ingredientId)?.label ?? item.ingredientId })),
}));

export async function hasImageConsent(db: Database, userId: string) {
  const [row] = await db.execute(sql`SELECT payload FROM sync_items WHERE scope_type='user' AND scope_id=${userId} AND entity_type='ai_consent' AND entity_id='profile' AND NOT deleted`);
  const consent = row?.payload as { enabled?: boolean; imagePolicyVersion?: string; imageProvider?: string } | undefined;
  return consent?.enabled === true && consent.imagePolicyVersion === 'recipe-images-v3'
    && consent.imageProvider === 'openai';
}

// A paid request is admitted only for one authoritative catalog recipe.
export async function queueCatalogImages(db: Database, recipeId: string) {
  const recipe = catalogImageRecipes.find(item => item.id === recipeId);
  if (!recipe) return 0;
  const rows = await db.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe)
    VALUES(${recipe.id},${JSON.stringify({ title: recipe.title, ingredients: recipe.ingredients })}::jsonb)
    ON CONFLICT(catalog_id) DO UPDATE SET recipe=EXCLUDED.recipe,state='pending',attempts=0,dispatched_at=NULL,available_at=now(),updated_at=now()
    WHERE recipe_image_jobs.state IN ('failed','consent_required') RETURNING id`);
  return rows.length;
}

export async function queuePrivateImages(db: Database, userId: string, recipeId: string) {
  // Only the author can authorize a paid retry; house membership alone is insufficient.
  const rows = await db.execute(sql`INSERT INTO recipe_image_jobs(sync_item_id,user_id,recipe)
    SELECT s.id,${userId}::uuid,jsonb_build_object(
      'title',s.payload->'title',
      'ingredients',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',ingredient->>'name'))
        FROM jsonb_array_elements(s.payload->'ingredients') ingredient),'[]'::jsonb))
    FROM sync_items s WHERE s.user_id=${userId}::uuid AND NOT s.deleted
    AND s.entity_type IN ('generated_recipe','saved_recipe') AND s.entity_id=${recipeId}
    AND ((s.scope_type='user' AND s.scope_id=${userId}) OR (s.scope_type='house' AND EXISTS(
      SELECT 1 FROM house_memberships m WHERE m.house_id::text=s.scope_id AND m.user_id=${userId}::uuid)))
    ON CONFLICT(sync_item_id) DO UPDATE SET recipe=EXCLUDED.recipe,state='pending',attempts=0,dispatched_at=NULL,available_at=now(),updated_at=now()
    WHERE recipe_image_jobs.user_id=${userId}::uuid AND recipe_image_jobs.state IN ('failed','consent_required') RETURNING id`);
  return rows.length;
}
