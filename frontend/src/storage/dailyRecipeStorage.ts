import { isRecipeCompatible } from '../domain/dietary';
import { selectDailyRecipe, type DailyRecipeOptions, type DailyRecipeSelection } from '../domain/dailyRecipe';
import { scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { trackScopedWrite } from '../sync/scopeWriteFence';
import { deleteKeyValue, isIndexedDbAvailable, updateKeyValue } from './indexedDb';

const key = (scope: SyncScope) => scopeStorageKey(scope, 'daily-recipes-v1');
type History = Record<string, string>;

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export async function getDailyRecipe(options: Omit<DailyRecipeOptions, 'previousIds'> & { scope: SyncScope }): Promise<DailyRecipeSelection | null> {
  return trackScopedWrite(options.scope, async (assertWritable) => {
    let selection: DailyRecipeSelection | null = null;
    await updateKeyValue<History>(key(options.scope), (current) => {
      const history = current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
      const selected = options.recipes.find((recipe) => recipe.id === history[options.date] && isRecipeCompatible(recipe, options.profile));
      const previousIds = Object.keys(history).filter((date) => date < options.date).sort().reverse().slice(0, 2).map((date) => history[date]);
      selection = selectDailyRecipe({ ...options, recipes: selected ? [selected] : options.recipes, previousIds });
      if (selection !== null) history[options.date] = selection.recipe.id;
      else delete history[options.date];
      return history;
    }, assertWritable);
    return selection;
  });
}

export async function clearDailyRecipes(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(key(scope));
}
