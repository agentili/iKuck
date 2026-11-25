import { describe, expect, it, vi } from 'vitest';
import { hasImageConsent } from './generation.js';

const databaseWithConsent = (payload: unknown): Parameters<typeof hasImageConsent>[0] => ({
  execute: vi.fn().mockResolvedValue([{ payload }]),
}) as unknown as Parameters<typeof hasImageConsent>[0];

describe('recipe image consent', () => {
  it.each(['recipe-images-v1', 'recipe-images-v2', undefined])('does not authorize stale image policy %s', async imagePolicyVersion => {
    await expect(hasImageConsent(databaseWithConsent({ enabled: true, imagePolicyVersion, imageProvider: 'openai' }), 'user-1'))
      .resolves.toBe(false);
  });

  it('requires an explicit v3 OpenAI image grant and enabled consent', async () => {
    await expect(hasImageConsent(databaseWithConsent({
      enabled: true,
      imagePolicyVersion: 'recipe-images-v3',
      imageProvider: 'gemini',
    }), 'user-1')).resolves.toBe(false);

    await expect(hasImageConsent(databaseWithConsent({
      enabled: false,
      imagePolicyVersion: 'recipe-images-v3',
      imageProvider: 'openai',
    }), 'user-1')).resolves.toBe(false);

    await expect(hasImageConsent(databaseWithConsent({
      enabled: true,
      imagePolicyVersion: 'recipe-images-v3',
      imageProvider: 'openai',
    }), 'user-1')).resolves.toBe(true);
  });
});
