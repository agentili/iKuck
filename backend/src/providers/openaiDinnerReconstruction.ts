import { randomUUID } from 'node:crypto';
import {
  DIARY_DESCRIPTION_MAX_LENGTH,
  DIARY_DURATION_MINUTES_MAX,
  DIARY_DURATION_MINUTES_MIN,
  DIARY_INGREDIENT_AMOUNT_MAX_LENGTH,
  DIARY_INGREDIENT_NAME_MAX_LENGTH,
  DIARY_MAX_RECIPES,
  DIARY_MAX_STEPS,
  DIARY_SERVINGS_MAX,
  DIARY_SERVINGS_MIN,
  DIARY_STEP_MAX_LENGTH,
  DIARY_TITLE_MAX_LENGTH,
  RECIPE_MAX_INGREDIENTS,
} from '@ikuck/shared/limits';
import { DIARY_SUGGESTED_FIELDS, type DiaryRecipeDraft } from '@ikuck/shared/dinnerDiary';
import { FetchTimeoutError, fetchWithTimeoutBody } from './fetchWithTimeout.js';
import { ProviderRequestError, ProviderTimeoutError, type DinnerReconstructionProvider } from './types.js';
import {
  DINNER_RECONSTRUCTION_INSTRUCTIONS,
  isValidDinnerReconstructionRequest,
  parseDinnerReconstructionDrafts,
} from './dinnerReconstructionShared.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const diaryRecipeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: DIARY_TITLE_MAX_LENGTH },
    description: { type: 'string', maxLength: DIARY_DESCRIPTION_MAX_LENGTH },
    ingredients: {
      type: 'array',
      minItems: 1,
      maxItems: RECIPE_MAX_INGREDIENTS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: DIARY_INGREDIENT_NAME_MAX_LENGTH },
          amount: { type: 'string', maxLength: DIARY_INGREDIENT_AMOUNT_MAX_LENGTH },
          ingredientId: { type: 'null' },
          optional: { type: 'boolean' },
          provenance: { type: 'string', enum: ['provided', 'suggested'] },
        },
        required: ['name', 'amount', 'ingredientId', 'optional', 'provenance'],
      },
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: DIARY_MAX_STEPS,
      items: { type: 'string', minLength: 1, maxLength: DIARY_STEP_MAX_LENGTH },
    },
    servings: { type: ['integer', 'null'], minimum: DIARY_SERVINGS_MIN, maximum: DIARY_SERVINGS_MAX },
    durationMinutes: { type: ['integer', 'null'], minimum: DIARY_DURATION_MINUTES_MIN, maximum: DIARY_DURATION_MINUTES_MAX },
    diets: {
      type: ['array', 'null'],
      minItems: 1,
      items: { type: 'string', enum: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'] },
    },
    allergens: {
      type: ['array', 'null'],
      minItems: 1,
      items: {
        type: 'string',
        enum: ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'],
      },
    },
    suggestedFields: { type: 'array', items: { type: 'string', enum: DIARY_SUGGESTED_FIELDS } },
  },
  required: ['title', 'description', 'ingredients', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens', 'suggestedFields'],
} as const;

interface OpenAiDinnerReconstructionOptions {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  createDraftId?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const readOutputText = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  if (typeof value.output_text === 'string') return value.output_text;
  if (!Array.isArray(value.output)) return null;
  for (const item of value.output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return null;
};


export const createOpenAiDinnerReconstructionProvider = ({
  apiKey,
  model,
  fetch,
  timeoutMs = 30000,
  createDraftId = randomUUID,
}: OpenAiDinnerReconstructionOptions): DinnerReconstructionProvider => ({
  reconstruct: async (request) => {
    if (apiKey.trim() === '' || model.trim() === '' || !isValidDinnerReconstructionRequest(request.dinnerText, request.servings)) {
      throw new ProviderRequestError('dinner_reconstruction', 'OpenAI dinner reconstruction request is invalid');
    }

    const requestFetch = fetch ?? globalThis.fetch;
    const body = {
      model,
      store: false,
      instructions: DINNER_RECONSTRUCTION_INSTRUCTIONS,
      input: JSON.stringify({ dinnerText: request.dinnerText, servings: request.servings }),
      text: {
        format: {
          type: 'json_schema',
          name: 'ikuck_dinner_reconstruction',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              recipes: { type: 'array', minItems: 0, maxItems: DIARY_MAX_RECIPES, items: diaryRecipeJsonSchema },
            },
            required: ['recipes'],
          },
        },
      },
    };

    let responseData: { ok: boolean; body: unknown; invalidJson: boolean };
    try {
      responseData = await fetchWithTimeoutBody(requestFetch, OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      }, timeoutMs, async (response) => {
        if (!response.ok) return { ok: false, body: null, invalidJson: false };
        try {
          return { ok: true, body: await response.json(), invalidJson: false };
        } catch {
          return { ok: true, body: null, invalidJson: true };
        }
      });
    } catch (error) {
      if (error instanceof FetchTimeoutError) throw new ProviderTimeoutError('dinner_reconstruction');
      throw new ProviderRequestError('dinner_reconstruction');
    }
    if (!responseData.ok) throw new ProviderRequestError('dinner_reconstruction');
    if (responseData.invalidJson) throw new ProviderRequestError('dinner_reconstruction', 'OpenAI response is not valid JSON');
    const outputText = readOutputText(responseData.body);
    if (outputText === null) throw new ProviderRequestError('dinner_reconstruction', 'OpenAI response contains no structured output');
    try {
      const parsed = JSON.parse(outputText) as unknown;
      const drafts = parseDinnerReconstructionDrafts(parsed, createDraftId, request.servings);
      if (drafts === null) throw new Error('Invalid dinner reconstruction output');
      return drafts;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError('dinner_reconstruction', 'OpenAI structured output is invalid');
    }
  },
});

export type { DiaryRecipeDraft };
