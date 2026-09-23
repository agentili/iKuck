import { describe, expect, it, vi } from 'vitest';
import { createGeminiRecipeProvider } from './geminiRecipes.js';

const draft = {
  title: 'Ceci croccanti',
  description: 'Una ricetta semplice.',
  ingredients: [{ name: 'Ceci', amount: '240 g' }],
  steps: ['Scola i ceci.', 'Cuocili in padella.'],
  diets: ['vegan'],
  allergens: [],
};

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('Gemini recipe provider', () => {
  it('requests JSON structured output without sending the API key in the body', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }],
    }));
    const provider = createGeminiRecipeProvider({ apiKey: 'secret-key', model: 'gemini-test', fetch });

    await expect(provider.generate({
      ingredients: ['Ceci'],
      constraints: ['Use one pan'],
      dietProfile: { diet: 'vegan', excludedAllergens: [], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null } },
    })).resolves.toEqual(draft);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'secret-key' });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('apiKey');
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json' });
    expect((body.generationConfig as { responseSchema: unknown }).responseSchema).toBeTypeOf('object');
  });

  it('rejects non-success responses and malformed structured output', async () => {
    const failed = createGeminiRecipeProvider({ apiKey: 'secret-key', model: 'gemini-test', fetch: vi.fn().mockResolvedValue(response({}, 500)) });
    await expect(failed.generate({ ingredients: ['Ceci'], constraints: [] })).rejects.toMatchObject({ code: 'provider_error', provider: 'recipes' });

    const malformed = createGeminiRecipeProvider({
      apiKey: 'secret-key',
      model: 'gemini-test',
      fetch: vi.fn().mockResolvedValue(response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...draft, title: '' }) }] } }] })),
    });
    await expect(malformed.generate({ ingredients: ['Ceci'], constraints: [] })).rejects.toMatchObject({ code: 'provider_error', provider: 'recipes' });
  });

  it('maps a network timeout to a stable recipes timeout error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const provider = createGeminiRecipeProvider({ apiKey: 'secret-key', model: 'gemini-test', fetch, timeoutMs: 1 });

    await expect(provider.generate({ ingredients: ['Ceci'], constraints: [] })).rejects.toMatchObject({
      code: 'provider_timeout', provider: 'recipes',
    });
  });
});
