import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout.js';
import {
  ProviderRequestError,
  ProviderTimeoutError,
  type GeneratedRecipeDraft,
  type RecipeGenerationProvider,
} from './types.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const generatedRecipeJsonSchema = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    ingredients: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, amount: { type: 'STRING' } },
        required: ['name', 'amount'],
      },
    },
    steps: { type: 'ARRAY', items: { type: 'STRING' } },
    diets: { type: 'ARRAY', items: { type: 'STRING', enum: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'] } },
    allergens: { type: 'ARRAY', items: { type: 'STRING', enum: ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'] } },
  },
  required: ['title', 'description', 'ingredients', 'steps', 'diets', 'allergens'],
} as const;

interface GeminiRecipeProviderOptions {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readOutputText = (value: unknown): string | null => {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return null;
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
    const text = candidate.content.parts
      .filter(isRecord)
      .map((part) => part.text)
      .filter((part): part is string => typeof part === 'string')
      .join('');
    if (text.length > 0) return text;
  }
  return null;
};

const instruction = 'Generate one practical recipe. Return only the requested JSON. The recipe diets and allergens must be truthful and must satisfy the supplied dietary profile. Never invent an allergen-free claim when an ingredient implies an allergen.';

export const createGeminiRecipeProvider = ({ apiKey, model, fetch, timeoutMs = 30000 }: GeminiRecipeProviderOptions): RecipeGenerationProvider => ({
  generate: async (request): Promise<GeneratedRecipeDraft> => {
    if (apiKey.trim() === '' || model.trim() === '' || request.ingredients.length === 0) {
      throw new ProviderRequestError('recipes', 'Gemini request is invalid');
    }

    const requestFetch = fetch ?? globalThis.fetch;
    const body = {
      contents: [{
        role: 'user',
        parts: [{ text: `${instruction}\n\n${JSON.stringify({ ingredients: request.ingredients, constraints: request.constraints, dietProfile: request.dietProfile ?? null })}` }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: generatedRecipeJsonSchema,
      },
    };

    let response: Response;
    try {
      response = await fetchWithTimeout(requestFetch, `${GEMINI_API_URL}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, timeoutMs);
    } catch (error) {
      if (error instanceof FetchTimeoutError) throw new ProviderTimeoutError('recipes');
      throw new ProviderRequestError('recipes');
    }
    if (!response.ok) throw new ProviderRequestError('recipes');

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new ProviderRequestError('recipes', 'Gemini response is not valid JSON');
    }
    const outputText = readOutputText(responseBody);
    if (outputText === null) throw new ProviderRequestError('recipes', 'Gemini response contains no structured output');
    try {
      const parsed = JSON.parse(outputText) as unknown;
      const { parseGeneratedRecipeDraft } = await import('../ai/validation.js');
      const draft = parseGeneratedRecipeDraft(parsed);
      if (draft === null) throw new Error('Invalid generated recipe');
      return draft;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError('recipes', 'Gemini structured output is invalid');
    }
  },
});
