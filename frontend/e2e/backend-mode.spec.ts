import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const expectUnexpectedRequestToBeReported = (page: Parameters<typeof assertOfflineBackendClean>[0]): void => {
  expect(() => assertOfflineBackendClean(page)).toThrow(/unexpected API request/i);
};

test('l’audit offline resta cumulativo dopo una reinstallazione', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');
  await page.evaluate(async () => {
    await fetch('/v1/unlisted?source=first-install').catch(() => undefined);
  });
  expectUnexpectedRequestToBeReported(page);

  await installOfflineBackend(page, { responses: {
    'GET /v1/second-install': { json: { ok: true } },
  } });
  expectUnexpectedRequestToBeReported(page);
});

test('una fixture offline richiede la query esatta', async ({ page }) => {
  await installOfflineBackend(page, { responses: {
    'GET /v1/probe?mode=allowed': { json: { allowed: true } },
  } });
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const allowed = await fetch('/v1/probe?mode=allowed').then((response) => response.json());
    const unexpected = await fetch('/v1/probe?mode=unexpected')
      .then((response) => `status:${response.status}`)
      .catch(() => 'aborted');
    return { allowed, unexpected };
  });

  expect(result.allowed).toEqual({ allowed: true });
  expect(result.unexpected).toBe('aborted');
  expectUnexpectedRequestToBeReported(page);
});

test('il fallback implicito della sessione non accetta query aggiuntive', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');

  const outcome = await page.evaluate(async () => fetch('/v1/auth/session?unexpected=1')
    .then((response) => `status:${response.status}`)
    .catch(() => 'aborted'));

  expect(outcome).toBe('aborted');
  expectUnexpectedRequestToBeReported(page);
});

test('il guard abortisce e registra origine o metodo inattesi', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');

  const outcomes = await page.evaluate(async () => {
    const crossOrigin = await fetch('https://offline-guard.invalid/v1/auth/session')
      .then((response) => `status:${response.status}`)
      .catch(() => 'aborted');
    const wrongMethod = await fetch('/v1/auth/session', { method: 'POST' })
      .then((response) => `status:${response.status}`)
      .catch(() => 'aborted');
    return { crossOrigin, wrongMethod };
  });

  expect(outcomes).toEqual({ crossOrigin: 'aborted', wrongMethod: 'aborted' });
  let auditMessage = '';
  try {
    assertOfflineBackendClean(page);
  } catch (error) {
    auditMessage = error instanceof Error ? error.message : String(error);
  }
  expect(auditMessage).toContain('https://offline-guard.invalid');
  expect(auditMessage).toContain('POST /v1/auth/session');
});

test('il guard del contesto copre anche una pagina popup', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');
  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.textContent = 'Apri finestra';
    opener.style.position = 'fixed';
    opener.style.top = '8px';
    opener.style.left = '8px';
    opener.style.zIndex = '2147483647';
    opener.addEventListener('click', () => window.open('/', 'offline-guard-popup'));
    document.body.append(opener);
  });
  const popupPromise = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Apri finestra' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');

  const outcome = await popup.evaluate(async () => fetch('/v1/popup-unlisted')
    .then((response) => `status:${response.status}`)
    .catch(() => 'aborted'));

  expect(outcome).toBe('aborted');
  expectUnexpectedRequestToBeReported(page);
});

test('una pagina popup di altra origine non può consumare fixture same-origin', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');

  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.textContent = 'Apri popup esterno';
    opener.style.position = 'fixed';
    opener.style.top = '8px';
    opener.style.left = '8px';
    opener.style.zIndex = '2147483647';
    opener.addEventListener('click', () => window.open('about:blank', 'offline-guard-external-popup'));
    document.body.append(opener);
  });
  const popupPromise = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Apri popup esterno' }).click();
  const popup = await popupPromise;
  await popup.route('https://offline-guard.invalid/', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body>popup esterno</body></html>',
  }));
  await popup.goto('https://offline-guard.invalid/');

  const outcome = await popup.evaluate(async () => fetch('/v1/auth/session')
    .then((response) => `status:${response.status}`)
    .catch(() => 'aborted'));

  expect(outcome).toBe('aborted');
  expectUnexpectedRequestToBeReported(page);
});

test('il guard offline nasconde l’API service worker nel contesto di test', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');

  const serviceWorkerIsUnavailable = await page.evaluate(() => !('serviceWorker' in navigator));

  expect(serviceWorkerIsUnavailable).toBe(true);
});

test('il guard context-wide abortisce le mutazioni API anche con service worker abilitato', async ({ page }) => {
  await installOfflineBackend(page, { serviceWorkers: 'allow' });
  await page.goto('/');
  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);

  const outcome = await page.evaluate(async () => fetch('/v1/unlisted-mutation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mutate: true }),
  }).then((response) => `status:${response.status}`).catch(() => 'aborted'));

  expect(outcome).toBe('aborted');
  let auditMessage = '';
  try {
    assertOfflineBackendClean(page);
  } catch (error) {
    auditMessage = error instanceof Error ? error.message : String(error);
  }
  expect(auditMessage).toContain('POST /v1/unlisted-mutation');
});
