import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installOfflineBackend } from './helpers/backendMode';

test('scope storage property denial does not prevent SPA startup', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Storage denied', 'SecurityError'); },
    });
  });
  await page.route('**/v1/**', (route) => route.fulfill({ status: 200, json: null }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
});

test('persisted pantry survives reload when localStorage getItem is denied', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/pantry');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pomodoro');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  await page.waitForFunction(() => new Promise<boolean>((resolve) => {
    const request = indexedDB.open('ikuck-local-v2');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('keyValue', 'readonly').objectStore('keyValue').get('pantry');
      read.onsuccess = () => {
        database.close();
        resolve(typeof read.result === 'string' && read.result.includes('pomodoro'));
      };
      read.onerror = () => { database.close(); resolve(false); };
    };
  }));
  await page.reload();
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key.includes('pantry')) throw new DOMException('Storage disabled', 'SecurityError');
      return getItem.call(this, key);
    };
  });
  await page.reload();
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  const pantryRecord = await page.evaluate(() => new Promise<string | null>((resolve) => {
    const request = indexedDB.open('ikuck-local-v2');
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('keyValue', 'readonly').objectStore('keyValue').get('pantry');
      read.onsuccess = () => { database.close(); resolve(read.result ?? null); };
      read.onerror = () => { database.close(); resolve(null); };
    };
  }));
  expect(pantryRecord).toContain('tomato');
});

test('successful IndexedDB pantry write outranks a stale mirror when mirror update and removal fail across reload', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/pantry');
  const addItem = async (name: string) => {
    await page.getByRole('combobox', { name: 'Ingredienti presenti' }).fill(name);
    await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  };
  await addItem('pomodoro');
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'ikuck-pantry-v1') throw new DOMException('Storage disabled', 'SecurityError');
      return setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (key === 'ikuck-pantry-v1') throw new DOMException('Storage disabled', 'SecurityError');
      return removeItem.call(this, key);
    };
  });
  await addItem('pasta');
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  const persisted = await page.evaluate(() => new Promise<string | null>((resolve) => {
    const request = indexedDB.open('ikuck-local-v2');
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('keyValue', 'readonly').objectStore('keyValue').get('pantry');
      read.onsuccess = () => { db.close(); resolve(read.result ?? null); };
      read.onerror = () => { db.close(); resolve(null); };
    };
    request.onerror = () => resolve(null);
  }));
  expect(persisted).toContain('pasta');
});
test('legacy mirror newer than IndexedDB remains visible when the pending marker is absent', async ({ page }) => {
  await page.addInitScript(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ikuck-local-v2', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('keyValue')) db.createObjectStore('keyValue');
        if (!db.objectStoreNames.contains('syncQueue')) {
          const queue = db.createObjectStore('syncQueue', { keyPath: 'mutationId' });
          queue.createIndex('byCreatedAt', 'createdAt');
          queue.createIndex('byScope', 'scope');
        }
        if (!db.objectStoreNames.contains('syncMeta')) db.createObjectStore('syncMeta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('keyValue', 'readwrite');
    transaction.objectStore('keyValue').put(JSON.stringify({
      state: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [] }, version: 1,
    }), 'pantry');
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    window.localStorage.setItem('ikuck-pantry-v1', JSON.stringify({
      state: { pantryItems: [{ id: 'tomato', label: 'Pomodoro', known: true }], stapleIds: [] }, version: 1,
    }));
  });
  await installOfflineBackend(page);
  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  await expect(page.getByText('Pasta', { exact: true })).toHaveCount(0);
});

test('new pantry item survives reload when IndexedDB write fails but localStorage mirror succeeds', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/pantry');
  const addItem = async (name: string) => {
    await page.getByRole('combobox', { name: 'Ingredienti presenti' }).fill(name);
    await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  };
  await addItem('pomodoro');
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'keyValue' && args[1] === 'pantry') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return originalPut.apply(this, args);
    };
  });
  await addItem('pasta');
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Pomodoro', { exact: true })).toBeVisible();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
});

test('motion storage denial does not prevent SPA startup', async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'ikuck-motion-preference') throw new DOMException('Storage disabled', 'SecurityError');
      return getItem.call(this, key);
    };
  });
  await page.route('**/v1/**', (route) => route.fulfill({ status: 200, json: null }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  expect(await page.locator('html').getAttribute('data-motion')).toBe('system');
});

test('verified house member gets a recoverable storage error when purge-marker storage is unavailable', async ({ page }) => {
  let trackFunctionalWrites = false;
  const functionalWrites: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (trackFunctionalWrites && path.startsWith('/v1/') && request.method() !== 'GET') functionalWrites.push(`${request.method()} ${path}`);
  });
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('deny-house-purge-storage') === '1') {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('Storage denied', 'SecurityError'); },
      });
    }
  });
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: {
      authenticated: true,
      user: { id: 'scope-storage-member', email: 'member@example.com', emailVerifiedAt: '2026-10-01T00:00:00.000Z' },
      csrfToken: 'csrf-scope-storage-member', expiresAt: '2026-10-24T10:00:00.000Z',
    } },
    'GET /v1/house': { json: {
      house: { id: 'scope-storage-house', name: 'Casa verificata', createdAt: '2026-10-01T00:00:00.000Z' },
      membership: { role: 'member', joinedAt: '2026-10-01T00:00:00.000Z' },
      members: [],
    } },
    'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: '2026-10-01T00:00:00.000Z' }, selectedProvider: 'openai' } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
    'POST /v1/sync': { json: { changes: [], nextCursor: 0 } },
  } });
  const initialSyncResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/sync'
    && response.request().method() === 'POST');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  await initialSyncResponse;
  await page.evaluate(() => window.sessionStorage.setItem('deny-house-purge-storage', '1'));
  trackFunctionalWrites = true;
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: /non posso verificare la sicurezza dei dati della casa/i })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navigazione principale' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ricarica l’app' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toHaveCount(0);
  expect(functionalWrites).toEqual([]);
});

test('motion preference reports when browser storage cannot persist the choice', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'ikuck-motion-preference') throw new DOMException('Storage disabled', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
  await page.route('**/v1/**', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));
  await page.goto('/profile');
  const reducedMotion = page.getByRole('checkbox', { name: 'Riduci le animazioni su questo dispositivo' });
  await reducedMotion.check();
  await expect(page.getByText('La scelta vale solo finché l’app resta aperta: questo browser non consente di salvarla.', { exact: true })).toBeVisible();
  expect(await page.locator('html').getAttribute('data-motion')).toBe('reduced');
});

test('session motion choice stays checked after leaving and returning to Profile when storage writes fail', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'ikuck-motion-preference') throw new DOMException('Storage disabled', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
  await page.route('**/v1/**', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));
  await page.goto('/profile');
  const checkbox = page.getByRole('checkbox', { name: 'Riduci le animazioni su questo dispositivo' });
  await checkbox.check();
  await page.getByRole('link', { name: /Torna alle ricette/ }).click();
  await page.getByRole('link', { name: 'Profilo' }).click();
  await expect(page.getByRole('checkbox', { name: 'Riduci le animazioni su questo dispositivo' })).toBeChecked();
  await expect(page.getByText('La scelta vale solo finché l’app resta aperta: questo browser non consente di salvarla.', { exact: true })).toBeVisible();
  expect(await page.locator('html').getAttribute('data-motion')).toBe('reduced');
});

test('pantry autocomplete stays keyboard reachable at 320px with 200% text and preserves editing', async ({ page }) => {
  await installOfflineBackend(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/pantry');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const input = page.getByRole('combobox', { name: 'Ingredienti presenti' });
  await input.focus();
  await page.keyboard.type('pom');
  await expect(page.getByRole('listbox', { name: 'Ingredienti suggeriti' })).toBeVisible();
  await input.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Ingredienti suggeriti' })).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('pom');
  await input.fill('pomodoro');
  await input.press('Enter');
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pomodoro', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  const addButton = page.getByRole('button', { name: 'Aggiungi ingredienti' });
  await addButton.focus();
  await expect(addButton).toBeFocused();
  await input.fill('pasta');
  await addButton.click();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await page.getByRole('link', { name: 'Cucina', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'L’idea di oggi' })).toBeVisible();
});

test('recipe result cards show known servings in browser', async ({ page }) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 200, json: null }));
  await page.goto('/pantry');
  await page.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('link', { name: 'Cucina', exact: true }).click();
  const card = page.getByRole('article', { name: 'Pasta tonno e pomodoro' });
  await expect(card).toContainText('2 porzioni');
});

test('recipe detail preserves pantry availability for missing ingredients', async ({ page }) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 200, json: null }));
  await page.goto('/recipes/pasta-tonno-pomodoro');
  await expect(page.getByRole('region', { name: 'Disponibilità della ricetta' })).toContainText('Ingredienti mancanti');
  await expect(page.getByRole('region', { name: 'Disponibilità della ricetta' })).toContainText('Da acquistare:');
});

test('uova al pomodoro photo attribution is readable and axe-clean', async ({ page }) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 200, json: null }));
  await page.goto('/recipes/uova-al-pomodoro');
  const attribution = page.getByText('Foto illustrativa · Alex Bayev · Unsplash');
  await expect(attribution).toBeVisible();
  await expect(page.getByRole('img', { name: /foto illustrativa, non una riproduzione esatta/i })).toBeVisible();
  const colors = await attribution.evaluate((element) => ({
    foreground: getComputedStyle(element).color,
    background: getComputedStyle(element.parentElement!).backgroundColor,
  }));
  expect(colors.foreground).not.toBe('rgb(250, 251, 247)');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
});
