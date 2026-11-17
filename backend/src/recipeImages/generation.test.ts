import { describe, expect, it, vi } from 'vitest';
import { hasImageConsent } from './generation.js';
import type { ImageConfig } from './config.js';

const imageConfig: ImageConfig = {
  enabled: true,
  provider: 'openai',
  apiKey: '',
  searchKey: '',
  model: '',
  visionModel: '',
  dailyLimit: 5,
};

const databaseWithConsent = (payload: unknown): Parameters<typeof hasImageConsent>[0] => ({
  execute: vi.fn().mockResolvedValue([{ payload }]),
}) as unknown as Parameters<typeof hasImageConsent>[0];

describe('recipe image consent', () => {
  it('requires an explicit image provider matching the configured image provider', async () => {
    await expect(hasImageConsent(databaseWithConsent({
      enabled: true,
      imagePolicyVersion: 'recipe-images-v1',
      homeProvider: 'openai',
    }), 'user-1', imageConfig)).resolves.toBe(false);

    await expect(hasImageConsent(databaseWithConsent({
      enabled: true,
      imagePolicyVersion: 'recipe-images-v1',
      imageProvider: 'gemini',
      homeProvider: 'openai',
    }), 'user-1', imageConfig)).resolves.toBe(false);

    await expect(hasImageConsent(databaseWithConsent({
      enabled: true,
      imagePolicyVersion: 'recipe-images-v1',
      imageProvider: 'openai',
    }), 'user-1', imageConfig)).resolves.toBe(true);
  });
});
