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

  it('sends prior proposals to the model with the 30 percent novelty rule', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ output_text: JSON.stringify(draft) }));
    const provider = createOpenAiRecipeProvider({ apiKey: 'secret-key', model: 'gpt-5.5', fetch });
    const existingRecipes = [{
      title: 'Pasta al pomodoro',
      ingredients: [
        { name: 'Pasta', amount: '80 g', ingredientId: 'ref-a', optional: false, provenance: 'provided' as const },
        { name: 'Pomodoro', amount: '100 g', ingredientId: null, optional: false, provenance: 'provided' as const },
      ],
    }];

    await provider.generate({ ingredients: ['Ceci'], constraints: [], existingRecipes });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { instructions: string; input: string };
    const encodedInput = JSON.parse(body.input) as { existingRecipes: unknown[] };
    expect(encodedInput.existingRecipes).toEqual([{
      title: 'Pasta al pomodoro',
      ingredients: [{ name: 'Pasta', amount: '80 g' }, { name: 'Pomodoro', amount: '100 g' }],
    }]);
    expect(body.instructions).toMatch(/30%/);
    expect(body.instructions).toMatch(/Jaccard/i);
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

  it('aborts a stalled response body before the provider dispatch lock can remain held indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const requestSignal: { current: AbortSignal | null } = { current: null };
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
        requestSignal.current = init?.signal ?? null;
        return Promise.resolve({
          ok: true,
          json: () => new Promise((_resolve, reject) => {
            requestSignal.current?.addEventListener('abort', () => reject(new Error('response body aborted')), { once: true });
          }),
        } as Response);
      });
      const provider = createOpenAiRecipeProvider({ apiKey: 'synthetic-test-key', model: 'synthetic-test-model', fetch, timeoutMs: 25 });
      const pending = provider.generate({ ingredients: ['Ceci'], constraints: [] });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'provider_timeout', provider: 'recipes' });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

      await vi.advanceTimersByTimeAsync(25);

      expect(requestSignal.current?.aborted).toBe(true);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
