import { RECIPES as catalog } from '@ikuck/shared/recipeCatalog';
import type { PantryRecipe } from './types';

export const RECIPES: readonly PantryRecipe[] = catalog;
export const getRecipeById = (id: string): PantryRecipe | undefined =>
  RECIPES.find((recipe) => recipe.id === id);
