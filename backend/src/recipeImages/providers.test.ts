import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createImageProvider, normalizeImage } from './providers.js';
import { imageConfig } from './config.js';
const config = { enabled: true, provider: 'openai' as const, apiKey: 'test', searchKey: 'test', model: 'image-test', visionModel: 'vision-test', dailyLimit: 5 };
afterEach(() => vi.unstubAllGlobals());
describe('recipe images', () => {
  it('requires explicit configuration only when enabled', () => {
    expect(imageConfig({}).enabled).toBe(false);
    expect(() => imageConfig({ RECIPE_IMAGES_ENABLED: 'true' })).toThrow();
  });
  it('rejects invalid image bytes and normalizes dimensions', async () => {
    await expect(normalizeImage(Buffer.from('not an image'))).rejects.toThrow();
    const input = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const output = await normalizeImage(input);
    expect(output.width).toBe(1024); expect(output.height).toBe(512);
    expect((await sharp(output.bytes).metadata()).format).toBe('webp');
  });
  it('distinguishes an empty search from service failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ photos: [] }))));
    expect(await createImageProvider(config).search({ title: 'Pasta', ingredients: [] })).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(createImageProvider(config).search({ title: 'Pasta', ingredients: [] })).rejects.toThrow();
  });
  it('never downloads arbitrary provider URLs', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ photos: [{ src: { large: 'http://127.0.0.1/secrets' }, url: 'https://www.pexels.com/photo/test', photographer: 'x' }] })));
    vi.stubGlobal('fetch', fetch);
    expect(await createImageProvider(config).search({ title: 'Pasta', ingredients: [] })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['openai', 'gemini'] as const)('quarantines ambiguous generation failures for %s', async provider => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(createImageProvider({ ...config, provider }).generate({ title: 'Pasta', ingredients: [] })).rejects.toMatchObject({ ambiguous: true });
  });
  it.each(['openai','gemini'] as const)('decodes generated binary images from %s', async provider => {
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
    const payload = provider === 'openai' ? { data: [{ b64_json: bytes.toString('base64') }] } : { candidates: [{ content: { parts: [{ inlineData: { data: bytes.toString('base64') } }] } }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    const image = await createImageProvider({ ...config, provider }).generate({ title: 'Pasta', ingredients: [] });
    expect(image.source).toBe('ai'); expect(image.width).toBe(16); expect((await sharp(image.bytes).metadata()).format).toBe('webp');
  });

});
