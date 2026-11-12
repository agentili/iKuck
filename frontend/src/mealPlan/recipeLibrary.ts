import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { toDiaryPantryRecipe, type ScopedSavedRecipe } from '../domain/diaryRecipes';
import { RECIPES } from '../domain/recipes';
import { isRecipeCompatible } from '../domain/dietary';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import type { SyncScope } from '../sync/scopeContext';
import type { PantryRecipe } from '../domain/types';

export const generatedToSavedRecipe = (recipe: GeneratedRecipe, authorId: string | null): SavedRecipe => ({
  id: recipe.id, source: 'diary', authorId,
  title: recipe.title, description: recipe.description,
  ingredients: recipe.ingredients.map(ingredient => ({ ...ingredient, ingredientId: null, optional: false, provenance: 'suggested' })),
  steps: [...recipe.steps], diets: [...recipe.diets], allergens: [...recipe.allergens],
  servings: null, durationMinutes: null,
  suggestedFields: ['title', 'description', 'ingredients', 'amounts', 'steps', 'diets', 'allergens'],
  createdAt: recipe.createdAt, updatedAt: recipe.updatedAt,
});

export const planRecipeLibrary = (scope: SyncScope, saved: readonly ScopedSavedRecipe[], generated: readonly GeneratedRecipe[] = []): PantryRecipe[] => {
  const scoped = saved.filter(item => item.scope === scope);
  const library = scoped.map(toDiaryPantryRecipe);
  // Explicit guest import and account-to-house migration keep plan references.
  // Resolve their original IDs using only recipes present in the active scope.
  const aliases = scoped.flatMap(item => {
    const current = toDiaryPantryRecipe(item);
    const origins: SyncScope[] = ['guest', ...(item.value.authorId ? [`account:${item.value.authorId}` as SyncScope] : [])];
    return origins.filter(origin => origin !== scope).map(origin => ({
      ...current, id: toDiaryPantryRecipe({ scope: origin, value: item.value }).id,
    }));
  });
  const personal = generated.map(recipe => ({
    ...toDiaryPantryRecipe({ scope, value: generatedToSavedRecipe(recipe, null) }), id: recipe.id,
  }));
  return [...RECIPES, ...library, ...personal, ...aliases];
};

export const availablePlanRecipes = (recipes: readonly PantryRecipe[], profile: DietProfilePayload, availableIds: readonly string[], currentId: string | null): PantryRecipe[] => {
  const available = new Set(availableIds);
  const current = recipes.find(recipe => recipe.id === currentId);
  const seen = new Set<string>();
  return recipes.filter(recipe => {
    const key = recipe.diary?.savedRecipeId ?? recipe.id;
    if (recipe.id === currentId || (current?.diary && key === current.diary.savedRecipeId)
      || seen.has(key) || !isRecipeCompatible(recipe, profile)
      || !recipe.ingredients.every(ingredient => ingredient.optional || available.has(ingredient.ingredientId))) return false;
    seen.add(key);
    return true;
  });
};
