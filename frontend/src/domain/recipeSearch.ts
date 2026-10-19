import type { PantryRecipe } from './types';
import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import { getIngredient } from '@ikuck/shared/ingredients';

export interface SearchableRecipe {
  id: string;
  title: string;
  ingredientNames: string[];
  createdAt: string | null;
}

/**
 * Normalizza un testo per la ricerca: minuscolo, rimozione diacritici
 * (es. è → e, ì → i), trim e collasso degli spazi multipli.
 */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

/**
 * Motore di ricerca client-side puro: nessuna dipendenza da store o rete.
 * Restituisce una nuova array; query vuota o solo spazi restituisce tutte le ricette.
 */
export const searchRecipes = (
  recipes: SearchableRecipe[],
  query: string
): SearchableRecipe[] => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return recipes.slice();
  }
  return recipes.filter((recipe) => {
    const haystack = [recipe.title, ...recipe.ingredientNames].map(normalize);
    return haystack.some((text) => text.includes(normalizedQuery));
  });
};

/**
 * Adatta una ricetta del catalogo (PantryRecipe) all'interfaccia di ricerca,
 * risolvendo i nomi degli ingredienti dal catalogo condiviso.
 */
export const adaptPantryRecipe = (recipe: PantryRecipe): SearchableRecipe => ({
  id: recipe.id,
  title: recipe.title,
  ingredientNames: recipe.ingredients.map(
    (ingredient) =>
      ingredient.name ??
      getIngredient(ingredient.ingredientId)?.label ??
      ingredient.ingredientId
  ),
  createdAt: null,
});

/**
 * Adatta una ricetta generata (GeneratedRecipe) all'interfaccia di ricerca.
 * I nomi degli ingredienti sono già testuali.
 */
export const adaptGeneratedRecipe = (recipe: GeneratedRecipe): SearchableRecipe => ({
  id: recipe.id,
  title: recipe.title,
  ingredientNames: recipe.ingredients.map((ingredient) => ingredient.name),
  createdAt: recipe.createdAt,
});
