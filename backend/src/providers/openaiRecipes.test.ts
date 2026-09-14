import { describe, expect, it, vi } from 'vitest';
import { createOpenAiRecipeProvider } from './openaiRecipes.js';

const draft = {
  title: 'Ceci croccanti',
  description: 'Una ricetta semplice.',
  ingredients: [{ name: 'Ceci', amount: '240 g' }],
  steps: ['Scola i ceci.', 'Cuocili in padella.'],
  diets: ['vegan'],
  allergens: [],
};

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('OpenAI recipe provider', () => {
  it('requests strict structured output without storing the response', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ output_text: JSON.stringify(draft) }));
    const provider = createOpenAiRecipeProvider({ apiKey: 'secret-key', model: 'gpt-5.5', fetch });

    await expect(provider.generate({
      ingredients: ['Ceci'],
      constraints: ['Use one pan'],
      dietProfile: { diet: 'vegan', excludedAllergens: [], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null } },
    })).resolves.toEqual(draft);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-key' });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('apiKey');
    expect(body.store).toBe(false);
    expect(body.text).toMatchObject({ format: { type: 'json_schema', name: 'ikuck_generated_recipe', strict: true } });
    expect((body.text as { format: { schema: unknown } }).format.schema).toBeTypeOf('object');
  });

  it('rejects non-success responses and malformed structured output', async () => {
    const failed = createOpenAiRecipeProvider({ apiKey: 'secret-key', model: 'gpt-5.5', fetch: vi.fn().mockResolvedValue(response({}, 500)) });
    await expect(failed.generate({ ingredients: ['Ceci'], constraints: [] })).rejects.toMatchObject({ code: 'provider_error', provider: 'recipes' });

    const malformed = createOpenAiRecipeProvider({
      apiKey: 'secret-key',
      model: 'gpt-5.5',
      fetch: vi.fn().mockResolvedValue(response({ output_text: JSON.stringify({ ...draft, title: '' }) })),
    });
    await expect(malformed.generate({ ingredients: ['Ceci'], constraints: [] })).rejects.toMatchObject({ code: 'provider_error', provider: 'recipes' });
  });

  it('maps a network timeout to a stable recipes timeout error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const provider = createOpenAiRecipeProvider({ apiKey: 'secret-key', model: 'gpt-5.5', fetch, timeoutMs: 1 });

    await expect(provider.generate({ ingredients: ['Ceci'], constraints: [] })).rejects.toMatchObject({
      code: 'provider_timeout', provider: 'recipes',
    });
  });
});
