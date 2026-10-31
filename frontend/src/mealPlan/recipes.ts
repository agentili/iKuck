import type { DietProfilePayload } from '@ikuck/shared/contracts';
import { isRecipeCompatible } from '../domain/dietary';
import type { PantryRecipe } from '../domain/types';

export function selectPlanRecipe(input: {
  recipes: readonly PantryRecipe[];
  profile: DietProfilePayload;
  date: string;
  excludedRecipeIds?: readonly string[];
}): PantryRecipe | undefined {
  const eligible = input.recipes.filter((recipe) => isRecipeCompatible(recipe, input.profile));
  if (eligible.length === 0) return undefined;
  const unused = eligible.filter((recipe) => !input.excludedRecipeIds?.includes(recipe.id));
  const candidates = unused.length > 0 ? unused : eligible;
  const withinPreference = candidates.filter((recipe) => recipe.durationMinutes !== null && recipe.durationMinutes <= 30);
  const known = candidates.filter((recipe) => recipe.durationMinutes !== null);
  const preferred = (withinPreference.length > 0 ? withinPreference : known.length > 0 ? known : candidates)
    .slice()
    .sort((left, right) => {
      if (left.durationMinutes === null) return right.durationMinutes === null ? left.id.localeCompare(right.id) : 1;
      if (right.durationMinutes === null) return -1;
      const timeDifference = Math.abs(left.durationMinutes - 30) - Math.abs(right.durationMinutes - 30);
      return timeDifference === 0 ? left.id.localeCompare(right.id) : timeDifference;
    });
  return preferred[dateHash(input.date) % preferred.length];
}

function dateHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}
