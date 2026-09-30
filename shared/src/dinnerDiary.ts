import type { DietType, EuAllergen } from './contracts.js';
import {
  DIARY_DESCRIPTION_MAX_LENGTH, DIARY_DURATION_MINUTES_MAX, DIARY_DURATION_MINUTES_MIN,
  DIARY_ID_MAX_LENGTH, DIARY_INGREDIENT_AMOUNT_MAX_LENGTH, DIARY_INGREDIENT_NAME_MAX_LENGTH,
  DIARY_MAX_RECIPES, DIARY_MAX_STEPS, DIARY_NOTE_MAX_LENGTH, DIARY_SERVINGS_MAX,
  DIARY_SERVINGS_MIN, DIARY_STEP_MAX_LENGTH, DIARY_TEXT_MAX_LENGTH, DIARY_TITLE_MAX_LENGTH,
  RECIPE_MAX_INGREDIENTS,
} from '@ikuck/shared/limits';

export interface DinnerRecipeLink { recipeId: string; title: string; source: 'catalog' | 'diary' }
export interface DinnerEntry { id: string; date: string; text: string; servings: number | null; note: string | null; recipes: DinnerRecipeLink[]; authorId: string | null; createdAt: string; updatedAt: string }
export interface DiaryIngredient { name: string; amount: string; ingredientId: string | null; optional: boolean; provenance: 'provided' | 'suggested' }
export const DIARY_SUGGESTED_FIELDS = ['title', 'description', 'ingredients', 'amounts', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens'] as const;
export type DiarySuggestedField = typeof DIARY_SUGGESTED_FIELDS[number];
export interface DiaryRecipeDraft { draftId: string; title: string; description: string; ingredients: DiaryIngredient[]; steps: string[]; servings: number | null; durationMinutes: number | null; diets: DietType[] | null; allergens: EuAllergen[] | null; suggestedFields: DiarySuggestedField[] }
export interface SavedRecipe extends Omit<DiaryRecipeDraft, 'draftId'> { id: string; source: 'diary'; authorId: string | null; createdAt: string; updatedAt: string }
export interface DiaryDraftSet { entryId: string; entryUpdatedAt: string; drafts: DiaryRecipeDraft[] }

const diets: readonly DietType[] = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'];
const allergens: readonly EuAllergen[] = ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'];
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Obj, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const str = (v: unknown, max: number, nonblank = false) => typeof v === 'string' && v.length <= max && (!nonblank || v.trim().length > 0);
const id = (v: unknown) => str(v, DIARY_ID_MAX_LENGTH, true);
const boundedInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max;
const nullable = (v: unknown, check: (x: unknown) => boolean) => v === null || check(v);
const uniqueEnumArray = <T extends string>(v: unknown, values: readonly T[]): v is T[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && values.includes(x as T)) && new Set(v).size === v.length;
const timestamp = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const date = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
};
const link = (v: unknown): v is DinnerRecipeLink => object(v) && exact(v, ['recipeId', 'title', 'source']) && id(v.recipeId) && str(v.title, DIARY_TITLE_MAX_LENGTH, true) && (v.source === 'catalog' || v.source === 'diary');
export const isDinnerRecipeLink = link;
export function isDinnerEntry(v: unknown): v is DinnerEntry {
  return object(v) && exact(v, ['id', 'date', 'text', 'servings', 'note', 'recipes', 'authorId', 'createdAt', 'updatedAt']) && id(v.id) && date(v.date) && str(v.text, DIARY_TEXT_MAX_LENGTH, true) && nullable(v.servings, (x) => boundedInt(x, DIARY_SERVINGS_MIN, DIARY_SERVINGS_MAX)) && nullable(v.note, (x) => str(x, DIARY_NOTE_MAX_LENGTH)) && Array.isArray(v.recipes) && v.recipes.length <= DIARY_MAX_RECIPES && v.recipes.every(link) && nullable(v.authorId, id) && timestamp(v.createdAt) && timestamp(v.updatedAt);
}
export function isDiaryIngredient(v: unknown): v is DiaryIngredient {
  return object(v) && exact(v, ['name', 'amount', 'ingredientId', 'optional', 'provenance']) && str(v.name, DIARY_INGREDIENT_NAME_MAX_LENGTH, true) && str(v.amount, DIARY_INGREDIENT_AMOUNT_MAX_LENGTH) && nullable(v.ingredientId, id) && typeof v.optional === 'boolean' && (v.provenance === 'provided' || v.provenance === 'suggested');
}
function recipeFields(v: Obj) {
  return str(v.title, DIARY_TITLE_MAX_LENGTH, true) && str(v.description, DIARY_DESCRIPTION_MAX_LENGTH) && Array.isArray(v.ingredients) && v.ingredients.length > 0 && v.ingredients.length <= RECIPE_MAX_INGREDIENTS && v.ingredients.every(isDiaryIngredient) && Array.isArray(v.steps) && v.steps.length > 0 && v.steps.length <= DIARY_MAX_STEPS && v.steps.every((s) => str(s, DIARY_STEP_MAX_LENGTH, true)) && nullable(v.servings, (x) => boundedInt(x, DIARY_SERVINGS_MIN, DIARY_SERVINGS_MAX)) && nullable(v.durationMinutes, (x) => boundedInt(x, DIARY_DURATION_MINUTES_MIN, DIARY_DURATION_MINUTES_MAX)) && (v.diets === null || uniqueEnumArray(v.diets, diets)) && (v.allergens === null || uniqueEnumArray(v.allergens, allergens));
}
export function isDiaryRecipeDraft(v: unknown): v is DiaryRecipeDraft {
  return object(v) && exact(v, ['draftId', 'title', 'description', 'ingredients', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens', 'suggestedFields']) && id(v.draftId) && recipeFields(v) && uniqueEnumArray(v.suggestedFields, DIARY_SUGGESTED_FIELDS);
}
export function isSavedRecipe(v: unknown): v is SavedRecipe {
  const keys = ['id', 'title', 'description', 'ingredients', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens', 'suggestedFields', 'source', 'authorId', 'createdAt', 'updatedAt'];
  return object(v) && exact(v, keys) && id(v.id) && v.source === 'diary' && nullable(v.authorId, id) && timestamp(v.createdAt) && timestamp(v.updatedAt) && recipeFields(v) && uniqueEnumArray(v.suggestedFields, DIARY_SUGGESTED_FIELDS);
}
export function isDiaryDraftSet(v: unknown): v is DiaryDraftSet {
  return object(v) && exact(v, ['entryId', 'entryUpdatedAt', 'drafts']) && id(v.entryId) && timestamp(v.entryUpdatedAt) && Array.isArray(v.drafts) && v.drafts.length <= DIARY_MAX_RECIPES && v.drafts.every(isDiaryRecipeDraft);
}
