import { getPantry } from './pantryService';
import { query } from '../db/connection';
import { Recipe, PantryItem } from '../types';

export const suggest = async (userId: string, mealType: string = 'dinner') => {
  const pantry = await getPantry(userId);
  const pantryMap = new Map(pantry.map(item => [item.name.toLowerCase(), item.quantity]));

  const recipesResult = await query(
    "SELECT * FROM recipes WHERE difficulty IN ('easy', 'medium') AND preparation_time <= 45"
  );
  const allRecipes: Recipe[] = recipesResult.rows;

  const viableRecipes = allRecipes.map(recipe => {
    const required = recipe.ingredients.filter((ing: any) => !ing.isOptional);
    const matched = required.filter((ing: any) => {
      const pantryQty = pantryMap.get(ing.name.toLowerCase()) || 0;
      return pantryQty >= (ing.quantity || 0);
    });

    const matchPct = required.length > 0 ? (matched.length / required.length) * 100 : 100;
    return { ...recipe, matchPct, isViable: matchPct >= 90, ingredientMatch: matched.length };
  }).filter(r => r.isViable);

  // Load history
  const historyResult = await query(
    'SELECT recipe_id FROM recipe_history WHERE user_id = $1',
    [userId]
  );
  const executedIds = new Set(historyResult.rows.map(h => h.recipe_id));

  const executed = viableRecipes.filter(r => executedIds.has(r.id));
  const newRecipes = viableRecipes.filter(r => !executedIds.has(r.id));

  // Sort by matchPct
  newRecipes.sort((a, b) => b.matchPct - a.matchPct);
  executed.sort((a, b) => b.matchPct - a.matchPct);

  let finalSelection: any[] = [];
  if (executed.length > 0) {
    finalSelection = [
      { ...executed[0], wasExecuted: true },
      ...newRecipes.slice(0, 2).map(r => ({ ...r, wasExecuted: false }))
    ];
  } else {
    finalSelection = newRecipes.slice(0, 3).map(r => ({ ...r, wasExecuted: false }));
  }

  return finalSelection;
};
