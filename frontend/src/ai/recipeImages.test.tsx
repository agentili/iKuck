import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeImageMetadata } from '@ikuck/shared/contracts';

const request = vi.hoisted(() => vi.fn());
vi.mock('../api/apiClient', () => ({ apiRequest: request }));
vi.mock('../sync/scopeContext', () => ({ getActiveDataScope: () => 'guest', subscribeActiveDataScope: () => () => undefined }));
let useRecipeImage: typeof import('./recipeImages')['useRecipeImage'];
const ready: RecipeImageMetadata = { state: 'ready', url: '/v1/recipe-images/assets/test', width: 10, height: 10, source: 'ai' };
const createUrl = vi.fn(); const revokeUrl = vi.fn();

beforeEach(async () => {
  vi.stubEnv('VITE_RECIPE_IMAGES_ENABLED', 'false');
  ({ useRecipeImage } = await import('./recipeImages'));
  createUrl.mockReset().mockReturnValue('blob:image'); revokeUrl.mockReset(); request.mockReset();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('image', { headers: { 'content-type': 'image/webp' } })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('recipe image refresh', () => {
  const commons = { ...ready, source: 'wikimedia', metadataVersion: 2,
    url: '/v1/recipe-images/assets/11111111-1111-1111-1111-111111111111?metadataVersion=2', author: 'Test author',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Dish.jpg', license: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  it.each([
    { metadataVersion: undefined }, { url: ready.url }, { author: '<i>Author</i>' },
    { license: 'https://creativecommons.org/licenses/by-sa/4.0/' }, { sourceUrl: 'https://example.com/wiki/File:X' }, { source: 'unknown' },
  ])('does not fetch or render unsupported ready metadata %j', async changes => {
    request.mockResolvedValue({ ...commons, ...changes });
    const { result } = renderHook(() => useRecipeImage('pollo-al-limone'));
    await waitFor(() => expect(result.current.metadata?.state).toBe('missing'));
    expect(fetch).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });
  it('negotiates and caches Commons separately from old public data', async () => {
    request.mockResolvedValue(commons);
    const put = vi.fn();
    const open = vi.fn().mockResolvedValue({ put, keys: async () => [] });
    vi.stubGlobal('caches', { open });
    const { result } = renderHook(() => useRecipeImage('pollo-al-limone'));
    await waitFor(() => expect(result.current.url).toBe('blob:image'));
    const path = '/v1/recipe-images/pollo-al-limone?kind=catalog&metadataVersion=2';
    expect(request).toHaveBeenCalledWith(path);
    expect(open).toHaveBeenCalledWith('ikuck-public-recipe-images-v2');
    expect(put).toHaveBeenCalledWith(path, expect.any(Response));
    expect(put).toHaveBeenCalledWith(commons.url, expect.any(Response));
  });
  it('ignores an older missing response after a generation request has refreshed the image', async () => {
    let finishOld!: (value: RecipeImageMetadata) => void;
    request.mockReturnValueOnce(new Promise<RecipeImageMetadata>(resolve => { finishOld = resolve; })).mockResolvedValueOnce(ready);
    const { result } = renderHook(() => useRecipeImage('pollo-al-limone'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    act(() => { window.dispatchEvent(new Event('recipe-image-retry')); });
    await waitFor(() => expect(result.current.url).toBe('blob:image'));
    await act(async () => { finishOld({ state: 'missing' }); });
    expect(result.current.metadata?.state).toBe('ready');
    expect(result.current.url).toBe('blob:image');
  });

  it('releases replaced and unmounted image URLs', async () => {
    request.mockResolvedValue(ready);
    createUrl.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
    const { result, unmount } = renderHook(() => useRecipeImage('pollo-al-limone'));
    await waitFor(() => expect(result.current.url).toBe('blob:first'));
    act(() => { window.dispatchEvent(new Event('recipe-image-retry')); });
    await waitFor(() => expect(result.current.url).toBe('blob:second'));
    expect(revokeUrl).toHaveBeenCalledWith('blob:first');
    unmount();
    expect(revokeUrl).toHaveBeenCalledWith('blob:second');
  });
});
