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
