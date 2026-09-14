import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout.js';
import { ProviderRequestError, type NutritionEstimate, type NutritionLookup, type NutritionProvider } from './types.js';
import { ProviderTimeoutError } from './types.js';

const USDA_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';

const requiredNutrients = [
  { id: 1008, key: 'calories', label: 'calories' },
  { id: 1003, key: 'proteinGrams', label: 'protein' },
  { id: 1005, key: 'carbohydrateGrams', label: 'carbohydrate' },
  { id: 1004, key: 'fatGrams', label: 'fat' },
] as const;

interface UsdaProviderOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const numericNutrientValue = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);

const parseResponse = (value: unknown): { description: string; nutrients: Map<number, number> } => {
  if (!isRecord(value) || !Array.isArray(value.foods) || value.foods.length === 0) {
    throw new ProviderRequestError('nutrition', 'USDA response contains no food');
  }
  const food = value.foods[0];
  if (!isRecord(food) || typeof food.description !== 'string' || food.description.trim() === '' || !Array.isArray(food.foodNutrients)) {
    throw new ProviderRequestError('nutrition', 'USDA response is malformed');
  }

  const nutrients = new Map<number, number>();
  for (const item of food.foodNutrients) {
    if (!isRecord(item)) continue;
    const nutrientId = typeof item.nutrientId === 'number'
      ? item.nutrientId
      : typeof item.nutrientId === 'string' && /^\d+$/.test(item.nutrientId) ? Number(item.nutrientId) : null;
    const nutrientValue = numericNutrientValue(item.value);
    if (nutrientId !== null && nutrientValue !== null) nutrients.set(nutrientId, nutrientValue);
  }
  return { description: food.description.trim(), nutrients };
};

const scaleValue = (value: number | null, quantityGrams: number | undefined): number | null => (
  value === null ? null : value * (quantityGrams === undefined ? 1 : quantityGrams / 100)
);

export const createUsdaNutritionProvider = ({ apiKey, fetch, timeoutMs = 8000 }: UsdaProviderOptions): NutritionProvider => ({
  lookup: async (lookup: NutritionLookup): Promise<NutritionEstimate> => {
    if (apiKey.trim() === '' || lookup.query.trim() === ''
      || (lookup.quantityGrams !== undefined && (!Number.isFinite(lookup.quantityGrams) || lookup.quantityGrams <= 0))) {
      throw new ProviderRequestError('nutrition', 'USDA request is invalid');
    }

    const request = fetch ?? globalThis.fetch;
    const url = new URL(USDA_SEARCH_URL);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('query', lookup.query.trim());
    url.searchParams.set('pageSize', '1');

    let response: Response;
    try {
      response = await fetchWithTimeout(request, url, { method: 'GET', headers: { accept: 'application/json' } }, timeoutMs);
    } catch (error) {
      if (error instanceof FetchTimeoutError) throw new ProviderTimeoutError('nutrition');
      throw new ProviderRequestError('nutrition');
    }
    if (!response.ok) throw new ProviderRequestError('nutrition');

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderRequestError('nutrition', 'USDA response is not valid JSON');
    }
    const parsed = parseResponse(body);
    const values = requiredNutrients.map((nutrient) => ({
      ...nutrient,
      value: scaleValue(parsed.nutrients.get(nutrient.id) ?? null, lookup.quantityGrams),
    }));
    const missingNutrients = values.filter(({ value }) => value === null).map(({ label }) => label);
    const estimate = Object.fromEntries(values.map(({ key, value }) => [key, value])) as Pick<
      NutritionEstimate,
      'calories' | 'proteinGrams' | 'carbohydrateGrams' | 'fatGrams'
    >;

    return {
      source: 'usda',
      ...estimate,
      matchedFood: parsed.description,
      isComplete: missingNutrients.length === 0,
      missingNutrients,
    };
  },
});
