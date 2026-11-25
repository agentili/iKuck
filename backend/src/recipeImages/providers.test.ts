import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createImageProvider, normalizeImage } from './providers.js';
import { imageConfig } from './config.js';

const config = {
  enabled: true,
  provider: 'openai' as const,
  apiKey: 'test-image-key',
  model: 'gpt-image-2.5-flare',
  dailyLimit: 5,
};
const imageBytes = () => sharp({
  create: { width: 16, height: 16, channels: 3, background: '#123456' },
}).png().toBuffer();

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI recipe images', () => {
  it('requires image credentials only when enabled and does not require vision configuration', () => {
    expect(imageConfig({}).enabled).toBe(false);
    expect(() => imageConfig({ RECIPE_IMAGES_ENABLED: 'true' })).toThrow();
    expect(imageConfig({
      RECIPE_IMAGES_ENABLED: 'true',
      OPENAI_API_KEY: 'test-image-key',
      RECIPE_IMAGE_MODEL: 'gpt-image-2.5-flare',
      RECIPE_PROVIDER: 'gemini',
    })).toMatchObject({
      enabled: true,
      provider: 'openai',
      model: 'gpt-image-2.5-flare',
    });
  });

  it('rejects invalid image bytes and normalizes output to bounded WebP', async () => {
    await expect(normalizeImage(Buffer.from('not an image'))).rejects.toThrow();
    const input = await sharp({
      create: { width: 1600, height: 800, channels: 3, background: '#ff0000' },
    }).png().toBuffer();
    const output = await normalizeImage(input);
    expect(output.width).toBe(1024);
    expect(output.height).toBe(512);
    expect((await sharp(output.bytes).metadata()).format).toBe('webp');
  });

  it('dispatches one medium square OpenAI request containing only title and ingredient names', async () => {
    const bytes = await imageBytes();
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ b64_json: bytes.toString('base64') }] }));
    vi.stubGlobal('fetch', fetch);
    const recipe = {
      title: 'Private recipe title',
      description: 'Must not be sent',
      steps: ['Must not be sent'],
      ingredients: [{ name: 'Rice', amount: '1 kg', id: 'must-not-be-sent' }],
    };

    const generated = await createImageProvider(config).generate(recipe);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-image-key');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['model', 'n', 'prompt', 'quality', 'size']);
    expect(body).toMatchObject({
      model: 'gpt-image-2.5-flare',
      n: 1,
      quality: 'medium',
      size: '1024x1024',
    });
    expect(body.prompt).toContain('Private recipe title');
    expect(body.prompt).toContain('Rice');
    expect(body.prompt).not.toContain('Must not be sent');
    expect(body.prompt).not.toContain('1 kg');
    expect(generated).toMatchObject({ source: 'ai', author: 'openai', sourceUrl: '', license: '' });
  });

  it.each(['network timeout', 429, 503])('marks an ambiguous paid failure for manual retry: %s', async failure => {
    const fetch = vi.fn().mockImplementation(() => typeof failure === 'string'
      ? Promise.reject(new Error(failure))
      : Promise.resolve(new Response('', { status: failure })));
    vi.stubGlobal('fetch', fetch);

    await expect(createImageProvider(config).generate({ title: 'Pasta', ingredients: [] }))
      .rejects.toMatchObject({ ambiguous: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed and oversized generation payloads after one dispatch', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{}] }));
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).generate({ title: 'Pasta', ingredients: [] }))
      .rejects.toMatchObject({ ambiguous: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
