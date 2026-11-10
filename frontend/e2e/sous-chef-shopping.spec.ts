import { expect, test, type Page, type Route } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';
import { openShellProfileMenu } from './helpers/appMode';

// These are browser contracts for the Sous Chef build, not production Bring! calls.

const externalRequests = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
  expect(externalRequests.get(page) ?? [], 'no external network requests').toEqual([]);
});

type ShoppingItem = { id: string; label: string; purchased: boolean };

async function storedShopping(page: Page, scope = 'guest'): Promise<ShoppingItem[]> {
  return page.evaluate(async (targetScope) => {
    const key = targetScope === 'guest' ? 'shopping-list' : `ikuck:${targetScope}:shopping-list`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ikuck-local-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const raw = await new Promise<string | undefined>((resolve, reject) => {
        const request = db.transaction('keyValue').objectStore('keyValue').get(key);
        request.onsuccess = () => resolve(request.result as string | undefined);
        request.onerror = () => reject(request.error);
      });
      return raw ? (JSON.parse(raw) as { items: ShoppingItem[] }).items : [];
    } finally {
      db.close();
    }
  }, scope);
}

async function expectReachable(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector);
  await expect(target).toBeVisible();
  const geometry = await target.evaluate((element) => {
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      height: rect.height,
      left: rect.left,
      right: rect.right,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      hit: top === element || element.contains(top),
    };
  });
  expect(geometry.scrollWidth, `horizontal overflow at ${geometry.viewport}px`).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.hit, `control occluded: ${selector}`).toBe(true);
}

async function enlarge(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.fontSize = '200%';
    document.documentElement.dataset.theme = value;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function blockExternalRequests(page: Page): Promise<string[]> {
  const upstream: string[] = [];
  externalRequests.set(page, upstream);
  const base = new URL(test.info().project.use.baseURL!).origin;
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.fallback();
    upstream.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    await route.abort('blockedbyclient');
  });
  return upstream;
}

for (const { width, theme } of [
  { width: 320, theme: 'light' },
  { width: 390, theme: 'dark' },
] as const) {
  test(`guest shopping: empty, edit, purchase, undo and offline reload at ${width}px/200% (${theme})`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 844 });
    await blockExternalRequests(page);
    await installOfflineBackend(page, { serviceWorkers: 'allow' });
    await page.goto('/shopping-list');
    await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    await enlarge(page, theme);
    await expect(page.getByText('La lista è vuota')).toBeVisible();
    await expect(page.getByRole('button', { name: 'iKuck' })).toHaveAttribute('aria-pressed', 'true');
    await expectReachable(page, 'main form[aria-label="Aggiungi un prodotto"] button[type="submit"]');

    const form = page.getByRole('form', { name: 'Aggiungi un prodotto' });
    await form.getByLabel('Cosa ti serve?').fill('Uova');
    await form.getByRole('button', { name: 'Aggiungi alla lista' }).click();
    await expect(page.locator('li[data-state="pending"]')).toContainText('Uova');
    await page.getByRole('button', { name: 'Modifica Uova' }).click();
    const editor = page.getByRole('form', { name: 'Modifica Uova' });
    await expect(editor.getByRole('textbox', { name: 'Nome' })).toBeFocused();
    await editor.getByRole('textbox', { name: 'Nome' }).fill('Uova fresche');
    await editor.getByRole('spinbutton', { name: 'Quantità' }).fill('2');
    await editor.getByRole('combobox', { name: 'Unità' }).selectOption('pack');
    await editor.getByRole('button', { name: 'Salva dettagli' }).click();
    await expect(page.locator('li[data-state="pending"]')).toContainText('2 confezioni');
    await expectReachable(page, 'main li[data-state="pending"] button[aria-label="Segna Uova fresche come acquistato"]');
    await page.getByRole('button', { name: 'Segna Uova fresche come acquistato' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Segna Uova fresche come da acquistare' })).toBeFocused();
    await expect.poll(async () => (await storedShopping(page)).find((item) => item.label === 'Uova fresche')?.purchased).toBe(true);
    const saved = (await storedShopping(page)).find((item) => item.label === 'Uova fresche');
    expect(saved?.id).toBeTruthy();
    await page.getByRole('button', { name: 'Rimuovi gli acquistati' }).click();
    await expect(page.getByRole('button', { name: 'Annulla', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await storedShopping(page)).find((item) => item.id === saved?.id)).toEqual(saved);
    await page.getByRole('button', { name: 'Bring!', exact: true }).click();
    await expect(page.getByText(/Per collegare Bring! accedi a un account iKuck verificato/)).toBeVisible();
    await expect(page.getByLabel('Email Bring!')).toHaveCount(0);
    await expectReachable(page, 'main [aria-label="Origine della lista"] button[aria-pressed="false"]');
    await page.getByRole('button', { name: 'iKuck', exact: true }).click();
    await expect(page.locator('li[data-state="purchased"]')).toContainText('Uova fresche');
    await context.setOffline(true);
    await page.reload();
    // A Workbox-cached reload exercises IndexedDB rather than an in-memory Zustand snapshot.
    await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    await expect(page.locator('li[data-state="purchased"]')).toContainText('Uova fresche');
    await expect.poll(async () => (await storedShopping(page)).find((item) => item.id === saved?.id)).toEqual(saved);
    await context.setOffline(false);
    assertOfflineBackendClean(page);
  });
}

const LIST_ID = '11111111-1111-4111-8111-111111111111';
const accounts = {
  a: { id: 'shop-a', email: 'shop-a@example.test', csrf: 'csrf-shop-a', cookie: 'shop-session-a', item: 'Acqua' },
  b: { id: 'shop-b', email: 'shop-b@example.test', csrf: 'csrf-shop-b', cookie: 'shop-session-b', item: 'Pane' },
} as const;
type Account = keyof typeof accounts;

async function installAccountFixture(page: Page) {
  const seen: Array<{ path: string; principal: Account | null; csrf: string | undefined }> = [];
  const upstream = await blockExternalRequests(page);
  const base = new URL(test.info().project.use.baseURL!).origin;
  await installOfflineBackend(page, { serviceWorkers: 'block' });
  await page.route('**/v1/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      upstream.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    const headers = await request.allHeaders();
    const principal = (Object.keys(accounts) as Account[]).find(
      (key) => headers.cookie?.split(';').some((part) => part.trim() === `ikuck_session=${accounts[key].cookie}`),
    ) ?? null;
    const path = `${request.method()} ${url.pathname}${url.search}`;
    seen.push({ path, principal, csrf: headers['x-csrf-token'] });
    const respond = (json: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, json, headers: extra });
    if (path === 'GET /v1/auth/session') {
      if (principal === null) return respond({ authenticated: false });
      const account = accounts[principal];
      return respond({ authenticated: true, user: { id: account.id, email: account.email, emailVerifiedAt: '2026-10-01T09:00:00.000Z' }, csrfToken: account.csrf, expiresAt: '2027-11-01T09:00:00.000Z' });
    }
    if (path === 'POST /v1/auth/login') {
      const body = request.postDataJSON() as { email?: string };
      const key = (Object.keys(accounts) as Account[]).find((candidate) => accounts[candidate].email === body.email);
      if (!key) return respond({ code: 'invalid_credentials' }, 401);
      const account = accounts[key];
      return respond({ authenticated: true, user: { id: account.id, email: account.email, emailVerifiedAt: '2026-10-01T09:00:00.000Z' }, csrfToken: account.csrf, expiresAt: '2027-11-01T09:00:00.000Z' }, 200,
        { 'set-cookie': `ikuck_session=${account.cookie}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (path === 'POST /v1/auth/logout') {
      if (principal === null || headers['x-csrf-token'] !== accounts[principal].csrf) return respond({ code: 'csrf_failed' }, 403);
      return route.fulfill({ status: 204, body: '', headers: { 'set-cookie': 'ikuck_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' } });
    }
    if (principal === null) return route.fallback();
    if (path === 'GET /v1/house') return respond(null);
    if (path === 'GET /v1/profile') return respond({ profile: { displayName: null } });
    if (path === 'GET /v1/ai-recipes/consent') return respond({ consent: { enabled: false, updatedAt: '2026-10-01T09:00:00.000Z' }, selectedProvider: 'openai' });
    if (path === 'GET /v1/ai-recipes') return respond({ recipes: [] });
    if (path === 'POST /v1/sync') {
      if (headers['x-csrf-token'] !== accounts[principal].csrf) return respond({ code: 'csrf_failed' }, 403);
      const body = request.postDataJSON() as { cursor?: number; mutations?: Array<{ mutationId: string }> };
      return respond({ accepted: (body.mutations ?? []).map((mutation) => mutation.mutationId), changes: [], nextCursor: body.cursor ?? 0 });
    }
    if (path === 'GET /v1/integrations/bring') return respond({ enabled: true, connected: true, connectionId: `connection-${principal}` });
    if (path === `GET /v1/integrations/bring/lists?connectionId=connection-${principal}`) {
      return respond({ connectionId: `connection-${principal}`, lists: [{ id: LIST_ID, name: 'Lista di prova' }] });
    }
    if (path === `GET /v1/integrations/bring/items?connectionId=connection-${principal}&listId=${LIST_ID}`) {
      return respond({ connectionId: `connection-${principal}`, listId: LIST_ID, labelsAvailable: true, items: [
        { name: accounts[principal].item, label: accounts[principal].item, specification: '', state: 'purchase', mutable: true },
      ] });
    }
    return route.fallback(); // The context catch-all aborts and records any undocumented endpoint.
  });
  return { seen, upstream };
}

async function login(page: Page, account: Account): Promise<void> {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Accedi o registrati' }).click();
  await page.getByRole('button', { name: 'Accedi', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(accounts[account].email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-only-password');
  await page.getByRole('button', { name: 'Accedi al profilo' }).click();
  await expect(page.getByText(accounts[account].email, { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ikuck-active-data-scope'))).toBe(`account:${accounts[account].id}`);
}

for (const { width, theme } of [
  { width: 320, theme: 'dark' },
  { width: 390, theme: 'light' },
] as const) {
  test(`verified Bring! is separate from iKuck and from the next session at ${width}px/200% (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await installAccountFixture(page);
    await login(page, 'a');
    await page.goto('/shopping-list');
    await enlarge(page, theme);
    await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Lista Bring!' })).toHaveValue('');
    await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_ID);
    await expect(page.getByText('Acqua', { exact: true })).toBeVisible();
    await expectReachable(page, 'main [data-bring-name="Acqua"] button:has-text("Segna Acqua acquistato su Bring!")');
    const itemReadsBeforeOffline = fixture.seen.filter(({ path }) => path.startsWith('GET /v1/integrations/bring/items')).length;
    await page.context().setOffline(true);
    await expect(page.getByRole('status', { name: 'Connessione offline' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Segna Acqua acquistato su Bring!' })).toBeDisabled();
    await page.getByRole('button', { name: 'iKuck', exact: true }).click();
    await expect(page.getByText('Acqua', { exact: true })).toHaveCount(0);
    await expect(page.getByText('La lista è vuota')).toBeVisible();
    await page.getByLabel('Cosa ti serve?').fill('Segreto di A');
    await page.getByRole('button', { name: 'Aggiungi alla lista' }).click();
    await expect.poll(async () => (await storedShopping(page, 'account:shop-a')).map((item) => item.label)).toContain('Segreto di A');
    expect(fixture.seen.filter(({ path }) => path.startsWith('GET /v1/integrations/bring/items'))).toHaveLength(itemReadsBeforeOffline);
    await page.context().setOffline(false);
    await openShellProfileMenu(page);
    await page.getByRole('button', { name: /Esci$/ }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ikuck-active-data-scope'))).toBe('guest');
    await page.goto('/shopping-list');
    await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    await expect(page.getByText('Segreto di A', { exact: true })).toHaveCount(0);
    await expect(page.getByText('La lista è vuota')).toBeVisible();
    await openShellProfileMenu(page);
    await page.getByRole('link', { name: 'Profilo', exact: true }).click();
    await login(page, 'b');
    await page.goto('/shopping-list');
    await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Lista Bring!' })).toHaveValue('');
    await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_ID);
    await expect(page.getByText('Pane', { exact: true })).toBeVisible();
    await expect(page.getByText('Acqua', { exact: true })).toHaveCount(0);
    await expectReachable(page, 'main [data-bring-name="Pane"] button:has-text("Segna Pane acquistato su Bring!")');
    await page.getByRole('button', { name: 'iKuck', exact: true }).click();
    await expect(page.getByText('La lista è vuota')).toBeVisible();
    await expect(page.getByText('Segreto di A', { exact: true })).toHaveCount(0);
    expect(await storedShopping(page, 'account:shop-b')).toEqual([]);
    expect(fixture.seen.filter(({ path }) => path.includes('/v1/integrations/bring/items')).map(({ principal }) => principal)).toEqual(['a', 'b']);
    expect(fixture.seen.filter(({ path }) => path.startsWith('POST /v1/sync')).every(({ principal, csrf }) => principal !== null && csrf === accounts[principal].csrf)).toBe(true);
    expect(fixture.upstream).toEqual([]);
    assertOfflineBackendClean(page);
  });
}
