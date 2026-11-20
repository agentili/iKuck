import { expect, test } from '@playwright/test';
import { installOfflineBackend } from './helpers/backendMode';
test('catalog image arrives asynchronously with attribution and remains available offline', async ({ page, context }) => {
  await installOfflineBackend(page);
  // New read-only image endpoints are explicitly mocked after the context guard.
  await context.route('**/v1/recipe-images/**', async route => {
    const request = new URL(route.request().url());
    expect(request.searchParams.getAll('metadataVersion')).toEqual(['2']);
    if (request.pathname.includes('/assets/')) {
      // A small valid WebP fixture is served by the existing local artwork.
      const response = await page.request.get('/recipe-images/uova-al-pomodoro.webp');
      await route.fulfill({ status: 200, contentType: 'image/webp', body: await response.body() });
    } else await route.fulfill({ json: { state: 'ready', metadataVersion: 2, url: '/v1/recipe-images/assets/11111111-1111-1111-1111-111111111111?metadataVersion=2', width: 720, height: 720, source: 'wikimedia', author: 'Test photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Test.jpg', license: 'https://creativecommons.org/publicdomain/zero/1.0/' } });
  });
  await page.goto('/recipes/pollo-al-limone');
  await expect(page.getByRole('img', { name: 'Pollo al limone: immagine illustrativa' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Wikimedia Commons', exact: true })).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Test.jpg');
  await expect(page.getByRole('link', { name: 'CC0 1.0', exact: true })).toHaveAttribute('href', 'https://creativecommons.org/publicdomain/zero/1.0/');
  await expect(page.getByText(/Test photographer.*convertita in WebP/)).toBeVisible();
  // SPA navigation exercises the bounded offline cache without relying on a service worker.
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Chef', exact: true }).first().click();
  await page.goBack();
  await expect(page.getByRole('img', { name: 'Pollo al limone: immagine illustrativa' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CC0 1.0', exact: true })).toBeVisible();
});

test('ignores unversioned Commons online and in the old public cache, but still credits legacy Pexels', async ({ page, context }) => {
  await installOfflineBackend(page);
  const asset = '/v1/recipe-images/assets/11111111-1111-1111-1111-111111111111';
  const legacy = { state: 'ready', url: asset, width: 720, height: 720, source: 'wikimedia', author: 'Legacy credit',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Test.jpg', license: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  let pexels = false;
  let assetRequests = 0;
  await context.route('**/v1/recipe-images/**', async route => {
    if (route.request().url().includes('/assets/')) {
      assetRequests += 1;
      const response = await page.request.get('/recipe-images/uova-al-pomodoro.webp');
      await route.fulfill({ contentType: 'image/webp', body: await response.body() });
    } else await route.fulfill({ json: pexels ? { ...legacy, source: 'pexels', sourceUrl: 'https://www.pexels.com/photo/test-1/', license: 'https://www.pexels.com/license/' } : legacy });
  });
  await page.goto('/recipes/pollo-al-limone');
  const photo = page.getByRole('img', { name: 'Pollo al limone: immagine illustrativa' });
  await expect(page.getByRole('img', { name: 'Illustrazione per Pollo al limone' })).toBeVisible();
  await expect(photo).toHaveCount(0);
  await page.evaluate(async ({ legacy, asset }) => {
    const cache = await caches.open('ikuck-public-recipe-images-v1');
    await cache.put('/v1/recipe-images/pollo-al-limone?kind=catalog', new Response(JSON.stringify(legacy)));
    await cache.put(asset, await fetch('/recipe-images/uova-al-pomodoro.webp'));
  }, { legacy, asset });
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Chef', exact: true }).first().click();
  await page.goBack();
  await expect(page.getByRole('img', { name: 'Illustrazione per Pollo al limone' })).toBeVisible();
  expect(assetRequests).toBe(0);
  await context.setOffline(false);
  pexels = true;
  await page.reload();
  await expect(photo).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pexels', exact: true })).toHaveAttribute('href', 'https://www.pexels.com/photo/test-1/');
  await expect(page.getByText(/Unsplash/)).toHaveCount(0);
});

test('Profile grants image consent to its selected provider without granting Home recipe consent', async ({ page }) => {
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: 'image-user', email: 'images@example.com', emailVerifiedAt: '2026-11-01T00:00:00Z' }, csrfToken: 'image-csrf', expiresAt: '2099-01-01T00:00:00Z' } },
    'GET /v1/profile': { json: { profile: { displayName: 'Images' } } },
    'GET /v1/house': { json: null },
    'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
    'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
    'GET /v1/ai-recipes/consent': { json: {
      consent: { enabled: false, updatedAt: '2026-11-01T00:00:00Z' },
      selectedProvider: 'gemini', selectedImageProvider: 'openai',
    } },
    'PUT /v1/ai-recipes/consent': { json: {
      consent: { enabled: true, imageProvider: 'openai', imagePolicyVersion: 'recipe-images-v2', updatedAt: '2026-11-01T00:01:00Z' },
      selectedProvider: 'gemini', selectedImageProvider: 'openai',
    } },
  } });
  const imageGrantRequests: import('@playwright/test').Request[] = [];
  let recipeCollectionReads = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'PUT' && url.pathname === '/v1/ai-recipes/consent') imageGrantRequests.push(request);
    if (request.method() === 'GET' && url.pathname === '/v1/ai-recipes') recipeCollectionReads += 1;
  });

  await page.goto('/profile');
  const homeConsent = page.getByRole('checkbox', { name: 'Acconsento all’invio a Gemini di Google dei dati necessari per creare ricette AI' });
  const imageConsent = page.getByRole('checkbox', { name: 'Acconsento all’invio a OpenAI per le immagini delle ricette' });
  await expect(imageConsent).toBeVisible();
  await expect(homeConsent).not.toBeChecked();
  await imageConsent.check();
  await page.getByRole('button', { name: 'Salva consenso immagini AI' }).click();

  await expect(page.getByText('Consenso immagini attivo per OpenAI.')).toBeVisible();
  await expect(homeConsent).not.toBeChecked();
  expect(imageGrantRequests).toHaveLength(1);
  expect(imageGrantRequests[0]?.headers()['x-csrf-token']).toBe('image-csrf');
  expect(imageGrantRequests[0]?.postDataJSON()).toEqual({
    enabled: true,
    imagePolicyVersion: 'recipe-images-v2',
    imageProvider: 'openai',
    expectedRevision: '2026-11-01T00:00:00Z',
  });
  expect(recipeCollectionReads).toBe(0);
});

test('Profile fails closed when image provider is null and availability is omitted', async ({ page }) => {
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: 'image-user', email: 'images@example.com', emailVerifiedAt: '2026-11-01T00:00:00Z' }, csrfToken: 'image-csrf', expiresAt: '2099-01-01T00:00:00Z' } },
    'GET /v1/profile': { json: { profile: { displayName: 'Images' } } },
    'GET /v1/house': { json: null },
    'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
    'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
    'GET /v1/ai-recipes/consent': { json: {
      consent: { enabled: false, updatedAt: '2026-11-01T00:00:00Z' },
      selectedProvider: 'gemini', selectedImageProvider: null,
    } },
  } });
  let consentWrites = 0;
  let recipeCollectionReads = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'PUT' && url.pathname === '/v1/ai-recipes/consent') consentWrites += 1;
    if (request.method() === 'GET' && url.pathname === '/v1/ai-recipes') recipeCollectionReads += 1;
  });

  await page.goto('/profile');
  await expect(page.getByText(/Il servizio per la creazione di immagini non è disponibile sul server/i)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /per le immagini/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Salva consenso immagini AI' })).toHaveCount(0);
  await expect(page.getByText(/foto candidate vengono inviati a/i)).toHaveCount(0);
  expect(consentWrites).toBe(0);
  expect(recipeCollectionReads).toBe(0);
});

test('bulk generation is only in profile and single generation stays in recipe detail', async ({ page, context }) => {
  const consent = { enabled: true, updatedAt: '2026-11-01T00:00:00Z', imageProvider: 'openai', imagePolicyVersion: 'recipe-images-v2' };
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: 'image-user', email: 'images@example.com', emailVerifiedAt: '2026-11-01T00:00:00Z' }, csrfToken: 'image-csrf', expiresAt: '2099-01-01T00:00:00Z' } },
    'GET /v1/profile': { json: { profile: { displayName: 'Images' } } },
    'GET /v1/house': { json: null },
    'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
    'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
    'GET /v1/ai-recipes/consent': { json: { consent, selectedProvider: 'openai', selectedImageProvider: 'openai' } },
  } });
  let collectionRequests = 0; let singleRequests = 0; let requested = false;
  await context.route('**/v1/recipe-images/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('image-csrf');
      if (url.pathname === '/v1/recipe-images/generate') collectionRequests += 1;
      else { expect(url.pathname).toBe('/v1/recipe-images/pollo-al-limone/generate'); singleRequests += 1; requested = true; }
      await route.fulfill({ status: 202, json: { queued: url.pathname === '/v1/recipe-images/generate' ? 20 : 1 } });
    } else if (url.pathname.includes('/assets/')) {
      const image = await page.request.get('/recipe-images/uova-al-pomodoro.webp');
      await route.fulfill({ contentType: 'image/webp', body: await image.body() });
    } else await route.fulfill({ json: requested && url.pathname.endsWith('/pollo-al-limone')
      ? { state: 'ready', url: '/v1/recipe-images/assets/11111111-1111-1111-1111-111111111111', width: 720, height: 720, source: 'ai', author: 'OpenAI' }
      : { state: 'missing' } });
  });
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Genera tutte le immagini', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '20 immagini aggiunte alla coda' })).toBeVisible();
  await page.goto('/recipes');
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Genera tutte le immagini', exact: true })).toHaveCount(0);
  expect(collectionRequests).toBe(1);
  await page.goto('/recipes/pollo-al-limone');
  await page.getByRole('button', { name: 'Genera immagine', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Pollo al limone: immagine illustrativa' })).toBeVisible();
  await expect(page.getByText(/Immagine generata con AI/)).toBeVisible();
  expect(singleRequests).toBe(1);
});
