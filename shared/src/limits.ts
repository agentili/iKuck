/**
 * Central recipe and ingredient limits shared by the browser app and the API.
 * Change values here only: every consumer imports from this module.
 */

/** Maximum number of pantry ingredients accepted by an AI recipe generation request. */
export const AI_RECIPE_MAX_GENERATION_INGREDIENTS = 100;

/** Maximum number of ingredients allowed in a generated or saved recipe. */
export const RECIPE_MAX_INGREDIENTS = 30;

/** Maximum number of ingredients accepted by a recipe nutrition lookup request. */
export const RECIPE_NUTRITION_MAX_INGREDIENTS = 30;
