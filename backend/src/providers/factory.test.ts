import { describe, expect, it, vi } from 'vitest';
import { createProviders } from './factory.js';

describe('createProviders', () => {
  it('returns a typed unavailable error without provider credentials', async () => {
    const providers = createProviders({ providers: {} });

    await expect(providers.nutrition.lookup({ query: 'tomato' })).rejects.toMatchObject({
      code: 'provider_unavailable',
      provider: 'nutrition',
    });
  });

  it('exposes all provider ports without performing network work', async () => {
    const providers = createProviders({ providers: {} });

    await expect(providers.email.send({
      to: 'person@example.com',
      subject: 'Verification',
      html: '<p>Verify</p>',
    })).rejects.toMatchObject({ provider: 'email' });
    await expect(providers.recipes.generate({
      ingredients: ['tomato'],
      constraints: [],
    })).rejects.toMatchObject({ provider: 'recipes' });
  });

  it('selects the USDA adapter only when an API key is configured', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      foods: [{ description: 'Tomato', foodNutrients: [{ nutrientId: 1008, value: 18 }] }],
    })));
    const providers = createProviders({ providers: { usdaApiKey: 'test-key' } }, { fetch });

    await expect(providers.nutrition.lookup({ query: 'tomato' })).resolves.toMatchObject({ source: 'usda', calories: 18 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
