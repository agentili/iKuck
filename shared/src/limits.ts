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

export const DIARY_ID_MAX_LENGTH = 128;
export const DIARY_TITLE_MAX_LENGTH = 160;
export const DIARY_DESCRIPTION_MAX_LENGTH = 1000;
export const DIARY_TEXT_MAX_LENGTH = 5000;
export const DIARY_NOTE_MAX_LENGTH = 1000;
export const DIARY_INGREDIENT_NAME_MAX_LENGTH = 120;
export const DIARY_INGREDIENT_AMOUNT_MAX_LENGTH = 80;
export const DIARY_MAX_STEPS = 20;
export const DIARY_STEP_MAX_LENGTH = 1000;
export const DIARY_MAX_RECIPES = 10;
export const DIARY_SERVINGS_MIN = 1;
export const DIARY_SERVINGS_MAX = 100;
export const DIARY_DURATION_MINUTES_MIN = 1;
export const DIARY_DURATION_MINUTES_MAX = 1440;

export const CHEF_CHAT_MESSAGE_MAX_LENGTH = 2000;
export const CHEF_CHAT_HISTORY_MAX_MESSAGES = 8;
export const CHEF_CHAT_INPUT_MAX_LENGTH = 10000;
export const CHEF_CHAT_REPLY_MAX_LENGTH = 4000;
