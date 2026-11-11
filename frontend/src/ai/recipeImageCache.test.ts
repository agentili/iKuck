import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { clearPrivateImages, readPrivateImage, writePrivateImage } from './recipeImageCache';
import { setActiveDataScope } from '../sync/scopeContext';
beforeEach(async () => { setActiveDataScope('account:image-test'); await clearPrivateImages(); });
it('persists bounded private blobs under the active scope and clears them on logout', async () => {
  const key = 'account:image-test:recipe';
  await writePrivateImage(key, { metadata: { state: 'ready' }, blob: new Blob(['image']) }, 'account:image-test');
  expect((await readPrivateImage(key))?.metadata.state).toBe('ready');
  setActiveDataScope('guest'); await clearPrivateImages();
  expect(await readPrivateImage(key)).toBeUndefined();
});
it('does not write an image after its originating scope has been revoked', async () => {
  await writePrivateImage('old', { metadata: { state: 'ready' }, blob: new Blob(['image']) }, 'account:old');
  expect(await readPrivateImage('old')).toBeUndefined();
});
