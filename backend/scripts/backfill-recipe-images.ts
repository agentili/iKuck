import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { RECIPES } from '../../frontend/src/domain/recipes.js';
import { getIngredient } from '@ikuck/shared/ingredients';
// This CLI is run via tsx from the source checkout, never imported by the API build.
const apply = process.argv.includes('--apply');
const maximum = Number(process.argv.find(a => a.startsWith('--max='))?.slice(6));
if (apply && (!Number.isSafeInteger(maximum) || maximum < 1)) throw new Error('--apply requires --max=N');
const database = createDatabase(loadConfig(process.env).databaseUrl);
try {
  const privateRows = await database.db.execute(sql`SELECT id,user_id,payload FROM sync_items WHERE entity_type IN ('generated_recipe','saved_recipe') AND NOT deleted AND NOT EXISTS(SELECT 1 FROM recipe_image_jobs j WHERE j.sync_item_id=sync_items.id)`);
  console.info(JSON.stringify({ catalogCandidates: RECIPES.length - 1, privateCandidates: privateRows.length, apply }));
  if (apply) {
    let remaining = maximum;
    for (const recipe of RECIPES) {
      if (!remaining || recipe.id === 'uova-al-pomodoro') continue;
      const payload = { title: recipe.title, ingredients: recipe.ingredients.map(i => ({ name: i.name ?? getIngredient(i.ingredientId)?.label ?? i.ingredientId })) };
      const inserted = await database.db.execute(sql`INSERT INTO recipe_image_jobs(catalog_id,recipe) VALUES(${recipe.id},${JSON.stringify(payload)}::jsonb) ON CONFLICT(catalog_id) DO NOTHING RETURNING id`);
      remaining -= inserted.length;
    }
    for (const row of privateRows) {
      if (!remaining) break;
      await database.db.execute(sql`INSERT INTO recipe_image_jobs(sync_item_id,user_id,recipe) VALUES(${String(row.id)},${row.user_id},${JSON.stringify(row.payload)}::jsonb) ON CONFLICT(sync_item_id) DO NOTHING`); remaining--;
    }
  }
} finally { await database.close(); }
