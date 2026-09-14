import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout.js';
import {
  ProviderRequestError,
  ProviderTimeoutError,
  type GeneratedRecipeDraft,
  type RecipeGenerationProvider,
} from './types.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const generatedRecipeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    ingredients: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, amount: { type: 'string' } },
        required: ['name', 'amount'],
      },
    },
    steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
    diets: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'] } },
    allergens: { type: 'array', maxItems: 14, items: { type: 'string', enum: ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'] } },
  },
  required: ['title', 'description', 'ingredients', 'steps', 'diets', 'allergens'],
} as const;

interface OpenAiRecipeProviderOptions {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

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

export const createOpenAiRecipeProvider = ({ apiKey, model, fetch, timeoutMs = 30000 }: OpenAiRecipeProviderOptions): RecipeGenerationProvider => ({
  generate: async (request): Promise<GeneratedRecipeDraft> => {
    if (apiKey.trim() === '' || model.trim() === '' || request.ingredients.length === 0) {
      throw new ProviderRequestError('recipes', 'OpenAI request is invalid');
    }

    const requestFetch = fetch ?? globalThis.fetch;
    const body = {
      model,
      store: false,
      instructions: 'Generate one practical recipe. Return only the requested JSON. The recipe diets and allergens must be truthful and must satisfy the supplied dietary profile. Never invent an allergen-free claim when an ingredient implies an allergen.',
      input: JSON.stringify({ ingredients: request.ingredients, constraints: request.constraints, dietProfile: request.dietProfile ?? null }),
      text: {
        format: {
          type: 'json_schema',
          name: 'ikuck_generated_recipe',
          strict: true,
          schema: generatedRecipeJsonSchema,
        },
      },
    };

    let response: Response;
    try {
      response = await fetchWithTimeout(requestFetch, OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
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
      throw new ProviderRequestError('recipes', 'OpenAI response is not valid JSON');
    }
    const outputText = readOutputText(responseBody);
    if (outputText === null) throw new ProviderRequestError('recipes', 'OpenAI response contains no structured output');
    try {
      const parsed = JSON.parse(outputText) as unknown;
      const { parseGeneratedRecipeDraft } = await import('../ai/validation.js');
      const draft = parseGeneratedRecipeDraft(parsed);
      if (draft === null) throw new Error('Invalid generated recipe');
      return draft;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError('recipes', 'OpenAI structured output is invalid');
    }
  },
});
