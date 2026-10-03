import { randomUUID } from 'node:crypto';
import {
  DIARY_MAX_STEPS,
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

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const diaryRecipeJsonSchema = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    ingredients: {
      type: 'ARRAY', maxItems: RECIPE_MAX_INGREDIENTS,
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' }, amount: { type: 'STRING' }, ingredientId: { type: 'STRING', nullable: true },
          optional: { type: 'BOOLEAN' }, provenance: { type: 'STRING', enum: ['provided', 'suggested'] },
        },
        required: ['name', 'amount', 'ingredientId', 'optional', 'provenance'],
      },
    },
    steps: { type: 'ARRAY', maxItems: DIARY_MAX_STEPS, items: { type: 'STRING' } },
    servings: { type: 'INTEGER', nullable: true },
    durationMinutes: { type: 'INTEGER', nullable: true },
    diets: { type: 'ARRAY', nullable: true, items: { type: 'STRING', enum: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'] } },
    allergens: {
      type: 'ARRAY', nullable: true,
      items: {
        type: 'STRING',
        enum: ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'],
      },
    },
    suggestedFields: { type: 'ARRAY', items: { type: 'STRING', enum: DIARY_SUGGESTED_FIELDS } },
  },
  required: ['title', 'description', 'ingredients', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens', 'suggestedFields'],
} as const;

interface GeminiDinnerReconstructionOptions {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  createDraftId?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const readOutputText = (value: unknown): string | null => {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return null;
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
    const text = candidate.content.parts.filter(isRecord).map((part) => part.text)
      .filter((part): part is string => typeof part === 'string').join('');
    if (text.length > 0) return text;
  }
  return null;
};

export const createGeminiDinnerReconstructionProvider = ({
  apiKey, model, fetch, timeoutMs = 30000, createDraftId = randomUUID,
}: GeminiDinnerReconstructionOptions): DinnerReconstructionProvider => ({
  reconstruct: async (request) => {
    if (apiKey.trim() === '' || model.trim() === '' || !isValidDinnerReconstructionRequest(request.dinnerText, request.servings)) {
      throw new ProviderRequestError('dinner_reconstruction', 'Gemini dinner reconstruction request is invalid');
    }
    const requestFetch = fetch ?? globalThis.fetch;
    const body = {
      contents: [{
        role: 'user',
        parts: [{ text: `${DINNER_RECONSTRUCTION_INSTRUCTIONS}\n\n${JSON.stringify({ dinnerText: request.dinnerText, servings: request.servings })}` }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { recipes: { type: 'ARRAY', minItems: 0, items: diaryRecipeJsonSchema } },
          required: ['recipes'],
        },
      },
    };
    let responseData: { ok: boolean; body: unknown; invalidJson: boolean };
    try {
      responseData = await fetchWithTimeoutBody(requestFetch, `${GEMINI_API_URL}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal,
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
    if (responseData.invalidJson) throw new ProviderRequestError('dinner_reconstruction', 'Gemini response is not valid JSON');
    const outputText = readOutputText(responseData.body);
    if (outputText === null) throw new ProviderRequestError('dinner_reconstruction', 'Gemini response contains no structured output');
    try {
      const parsed = JSON.parse(outputText) as unknown;
      const drafts = parseDinnerReconstructionDrafts(parsed, createDraftId, request.servings);
      if (drafts === null) throw new Error('Invalid dinner reconstruction output');
      return drafts;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError('dinner_reconstruction', 'Gemini structured output is invalid');
    }
  },
});

export type { DiaryRecipeDraft };
