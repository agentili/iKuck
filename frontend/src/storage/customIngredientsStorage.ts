import type { IngredientDefinition } from '@ikuck/shared/ingredients';

const STORAGE_KEY = 'ikuck-custom-ingredients-v1';

export const loadCustomIngredients = (): IngredientDefinition[] => {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is IngredientDefinition =>
        typeof item === 'object' && item !== null &&
        typeof item.id === 'string' &&
        typeof item.label === 'string'
    );
  } catch {
    return [];
  }
};

export const saveCustomIngredients = (ingredients: IngredientDefinition[]): void => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ingredients));
  } catch {
    // Quota exceeded or private mode: best effort, do not break the flow.
  }
};

export const appendCustomIngredient = (definition: IngredientDefinition): void => {
  const current = loadCustomIngredients();
  if (current.some((i) => i.id === definition.id)) return;
  saveCustomIngredients([...current, definition]);
};
