import { expect, test, type Page, type Route } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

type AccountKey = 'a' | 'b';
type BringState = 'purchase' | 'recently';

interface TestAccount {
  id: string;
  email: string;
  csrf: string;
  cookie: string;
}

interface RemoteItem {
  name: string;
  label: string;
  specification: string;
  state: BringState;
  mutable: boolean;
}

interface RequestRecord {
  method: string;
  path: string;
  principal: AccountKey | null;
  listId?: string;
  action?: string;
  name?: string;
  connectionId?: string;
}

interface BringFetchGate {
  holdNextItemsResponse: boolean;
  itemsResponseHeld: boolean;
  itemsResponseResumed: boolean;
  releaseItemsResponse: (() => void) | null;
}

interface BringBackendOptions {
  connected?: AccountKey[];
  items?: Partial<Record<AccountKey, Record<string, RemoteItem[]>>>;
  expiredRead?: boolean;
  uncertainNextWrite?: boolean;
}

const LIST_ONE = '11111111-1111-4111-8111-111111111111';
const LIST_TWO = '22222222-2222-4222-8222-222222222222';
const CONNECTION_A = '33333333-3333-4333-8333-333333333333';
const CONNECTION_B = '44444444-4444-4444-8444-444444444444';
const CONNECTION_RECONNECTED = '77777777-7777-4777-8777-777777777777';
const LISTS = [{ id: LIST_ONE, name: 'Spesa settimanale' }, { id: LIST_TWO, name: 'Casa' }];
const ACCOUNT_DATA: Record<AccountKey, TestAccount> = {
  a: { id: 'account-a', email: 'a@example.test', csrf: 'csrf-account-a', cookie: 'session-account-a' },
  b: { id: 'account-b', email: 'b@example.test', csrf: 'csrf-account-b', cookie: 'session-account-b' },
};
const defaultItems = (): Record<string, RemoteItem[]> => ({
  [LIST_ONE]: [{ name: 'Acqua', label: 'Acqua', specification: '6 bottiglie', state: 'purchase', mutable: true }],
  [LIST_TWO]: [{ name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true }],
});

const isBringHost = (hostname: string): boolean => hostname === 'getbring.com' || hostname.endsWith('.getbring.com');
const asRecord = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
);
const responseJson = async (route: Route, json: unknown, status = 200, headers?: Record<string, string>): Promise<true> => {
  await route.fulfill({ status, json, ...(headers === undefined ? {} : { headers }) });
  return true;
};

class StatefulBringBackend {
  readonly requests: RequestRecord[] = [];
  readonly syncMutations: Array<Array<{ entityType?: string }>> = [];
  readonly csrfFailures: string[] = [];
  readonly upstreamRequests: string[] = [];
  readonly writes: Array<{ principal: AccountKey; action: string; name: string }> = [];
  readonly logoutPrincipals: AccountKey[] = [];
  readonly itemReads: Array<{ principal: AccountKey; listId: string }> = [];
  private readonly connections = new Map<AccountKey, string>();
  private readonly remoteItems = new Map<AccountKey, Map<string, RemoteItem[]>>();
  private readonly options: BringBackendOptions;
  private expirationObserved = false;

  constructor(options: BringBackendOptions = {}) {
    this.options = options;
    for (const key of ['a', 'b'] as const) {
      if (options.connected?.includes(key)) this.connections.set(key, key === 'a' ? CONNECTION_A : CONNECTION_B);
      const supplied = options.items?.[key] ?? {};
      const defaults = defaultItems();
      this.remoteItems.set(key, new Map(Object.entries({ ...defaults, ...supplied }).map(([listId, items]) => [listId, structuredClone(items)])));
    }
  }

  async install(page: Page): Promise<void> {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (isBringHost(url.hostname)) {
        this.upstreamRequests.push(`${url.hostname}${url.pathname}`);
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
    });
    await installOfflineBackend(page);
    await page.route('**/v1/**', async (route) => {
      if (!await this.handleApiRequest(route)) await route.fallback();
    });
  }

  get bringRequests(): RequestRecord[] {
    return this.requests.filter((request) => request.path.startsWith('/v1/integrations/bring'));
  }

  get syncWriteTypes(): string[] {
    return this.syncMutations.flatMap((mutations) => mutations.map((mutation) => mutation.entityType ?? ''));
  }

  getConnection(key: AccountKey): string | null {
    return this.connections.get(key) ?? null;
  }

  getItems(key: AccountKey, listId: string): RemoteItem[] {
    return structuredClone(this.remoteItems.get(key)?.get(listId) ?? []);
  }

  private principal(cookieHeader: string | undefined): AccountKey | null {
    if (cookieHeader === undefined) return null;
    for (const key of ['a', 'b'] as const) {
      if (cookieHeader.split(';').some((part) => part.trim() === `ikuck_session=${ACCOUNT_DATA[key].cookie}`)) return key;
    }
    return null;
  }

  private async handleApiRequest(route: Route): Promise<boolean> {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const key = this.principal(headers.cookie);
    const method = request.method();
    const path = url.pathname;
    const record: RequestRecord = { method, path, principal: key };
    if (path === '/v1/integrations/bring/lists' && method === 'GET') {
      record.connectionId = url.searchParams.get('connectionId') ?? undefined;
    }
    if (path === '/v1/integrations/bring/items' && method === 'GET') {
      record.listId = url.searchParams.get('listId') ?? undefined;
      record.connectionId = url.searchParams.get('connectionId') ?? undefined;
    }
    if (path === '/v1/integrations/bring/items' && method === 'POST') {
      const body = asRecord(request.postDataJSON());
      record.listId = typeof body.listId === 'string' ? body.listId : undefined;
      record.action = typeof body.action === 'string' ? body.action : undefined;
      record.name = typeof body.name === 'string' ? body.name : undefined;
      record.connectionId = typeof body.connectionId === 'string' ? body.connectionId : undefined;
    }
    this.requests.push(record);

    if (path === '/v1/auth/session' && method === 'GET') {
      if (key === null) return responseJson(route, { authenticated: false });
      const account = ACCOUNT_DATA[key];
      return responseJson(route, {
        authenticated: true,
        user: { id: account.id, email: account.email, emailVerifiedAt: '2026-10-01T09:00:00.000Z' },
        csrfToken: account.csrf,
        expiresAt: '2026-11-01T09:00:00.000Z',
      });
    }
    if (path === '/v1/auth/login' && method === 'POST') {
      const body = asRecord(request.postDataJSON());
      const keyForEmail = (['a', 'b'] as const).find((candidate) => ACCOUNT_DATA[candidate].email === body.email);
      if (keyForEmail === undefined) return responseJson(route, { code: 'invalid_credentials' }, 401);
      const account = ACCOUNT_DATA[keyForEmail];
      return responseJson(route, {
        authenticated: true,
        user: { id: account.id, email: account.email, emailVerifiedAt: '2026-10-01T09:00:00.000Z' },
        csrfToken: account.csrf,
        expiresAt: '2026-11-01T09:00:00.000Z',
      }, 200, { 'set-cookie': `ikuck_session=${account.cookie}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (path === '/v1/auth/logout' && method === 'POST') {
      if (!await this.authorize(route, key, headers['x-csrf-token'], true, path)) return true;
      this.logoutPrincipals.push(key!);
      return route.fulfill({ status: 204, body: '', headers: { 'set-cookie': 'ikuck_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' } }).then(() => true);
    }
    if (path === '/v1/house' && method === 'GET') {
      if (key === null) return responseJson(route, { code: 'session_required' }, 401);
      return responseJson(route, null);
    }
    if (path === '/v1/sync' && method === 'POST') {
      if (!await this.authorize(route, key, headers['x-csrf-token'], true, path)) return true;
      const body = asRecord(request.postDataJSON());
      const mutations = Array.isArray(body.mutations) ? body.mutations.map(asRecord) : [];
      this.syncMutations.push(mutations.map((mutation) => ({ entityType: typeof mutation.entityType === 'string' ? mutation.entityType : undefined })));
      const cursor = typeof body.cursor === 'number' ? body.cursor : 0;
      return responseJson(route, { accepted: mutations.map((mutation) => mutation.mutationId), changes: [], nextCursor: cursor });
    }
    if (path === '/v1/profile' && method === 'GET') {
      if (key === null) return responseJson(route, { code: 'session_required' }, 401);
      return responseJson(route, { profile: { displayName: null } });
    }
    if (path === '/v1/ai-recipes/consent' && method === 'GET') {
      if (key === null) return responseJson(route, { code: 'session_required' }, 401);
      return responseJson(route, { consent: { enabled: false, updatedAt: '2026-10-01T09:00:00.000Z' }, selectedProvider: 'openai' });
    }
    if (path === '/v1/ai-recipes' && method === 'GET') {
      if (key === null) return responseJson(route, { code: 'session_required' }, 401);
      return responseJson(route, { recipes: [] });
    }

    if (!path.startsWith('/v1/integrations/bring')) return false;
    if (method === 'GET' && path === '/v1/integrations/bring') {
      if (!await this.authorize(route, key, undefined, false, path)) return true;
      const connectionId = this.connections.get(key!);
      return responseJson(route, { enabled: true, connected: connectionId !== undefined, connectionId: connectionId ?? null });
    }
    if (method === 'POST' && path === '/v1/integrations/bring/connection') {
      if (!await this.authorize(route, key, headers['x-csrf-token'], true, path)) return true;
      const body = asRecord(request.postDataJSON());
      if (body.confirmExternalAccess !== true || typeof body.email !== 'string' || typeof body.password !== 'string') {
        return responseJson(route, { code: 'bring_invalid_payload', message: 'bring_invalid_payload' }, 400);
      }
      const connectionId = key === 'a' && this.expirationObserved
        ? CONNECTION_RECONNECTED
        : key === 'a' ? CONNECTION_A : CONNECTION_B;
      this.connections.set(key!, connectionId);
      return responseJson(route, { enabled: true, connected: true, connectionId, lists: LISTS });
    }
    if (method === 'DELETE' && path === '/v1/integrations/bring/connection') {
      if (!await this.authorize(route, key, headers['x-csrf-token'], true, path)) return true;
      const body = asRecord(request.postDataJSON());
      if (body.connectionId !== this.connections.get(key!)) return responseJson(route, { code: 'bring_stale_connection', message: 'bring_stale_connection' }, 409);
      this.connections.delete(key!);
      return route.fulfill({ status: 204, body: '' }).then(() => true);
    }
    if (method === 'GET' && path === '/v1/integrations/bring/lists') {
      if (!await this.authorize(route, key, undefined, false, path)) return true;
      if (url.searchParams.get('connectionId') !== this.connections.get(key!)) return responseJson(route, { code: 'bring_stale_connection', message: 'bring_stale_connection' }, 409);
      return responseJson(route, { connectionId: this.connections.get(key!), lists: LISTS });
    }
    if (method === 'GET' && path === '/v1/integrations/bring/items') {
      if (!await this.authorize(route, key, undefined, false, path)) return true;
      const connectionId = url.searchParams.get('connectionId');
      const listId = url.searchParams.get('listId') ?? '';
      if (connectionId !== this.connections.get(key!) || !LISTS.some((list) => list.id === listId)) {
        return responseJson(route, { code: 'bring_list_not_found', message: 'bring_list_not_found' }, 404);
      }
      this.itemReads.push({ principal: key!, listId });
      if (this.options.expiredRead && !this.expirationObserved) {
        this.expirationObserved = true;
        return responseJson(route, { code: 'bring_reconnect_required', message: 'bring_reconnect_required' }, 409);
      }
      return responseJson(route, { connectionId, listId, labelsAvailable: true, items: this.getItems(key!, listId) });
    }
    if (method === 'POST' && path === '/v1/integrations/bring/items') {
      if (!await this.authorize(route, key, headers['x-csrf-token'], true, path)) return true;
      const body = asRecord(request.postDataJSON());
      const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
      const listId = typeof body.listId === 'string' ? body.listId : '';
      const action = typeof body.action === 'string' ? body.action : '';
      const name = typeof body.name === 'string' ? body.name : '';
      const specification = typeof body.specification === 'string' ? body.specification : '';
      if (connectionId !== this.connections.get(key!) || !LISTS.some((list) => list.id === listId)) {
        return responseJson(route, { code: 'bring_list_not_found', message: 'bring_list_not_found' }, 404);
      }
      const current = this.getItems(key!, listId);
      const rawName = action === 'add' && name.trim().toLocaleLowerCase('it-IT') === 'latte' ? 'Milch' : name;
      const matching = current.filter((item) => item.name === rawName);
      if (action === 'add' && matching.length > 1) return responseJson(route, { code: 'bring_ambiguous_item', message: 'bring_ambiguous_item' }, 409);
      if (action !== 'add' && matching.length > 1) return responseJson(route, { code: 'bring_ambiguous_item', message: 'bring_ambiguous_item' }, 409);
      if (action !== 'add' && (matching.length !== 1 || matching[0]?.specification !== body.expectedSpecification)) {
        return responseJson(route, { code: 'bring_item_changed', message: 'bring_item_changed' }, 409);
      }
      const changed = current.filter((item) => item.name !== rawName);
      if (action === 'add') {
        changed.push({ name: rawName, label: rawName === 'Milch' ? 'Latte' : rawName, specification, state: 'purchase', mutable: true });
      } else if (action === 'update') {
        changed.push({ ...matching[0]!, specification, state: 'purchase' });
      } else if (action === 'complete') {
        changed.push({ ...matching[0]!, state: 'recently' });
      } else if (action === 'restore') {
        changed.push({ ...matching[0]!, state: 'purchase' });
      } else if (action !== 'remove') {
        return responseJson(route, { code: 'bring_invalid_payload', message: 'bring_invalid_payload' }, 400);
      }
      const next = this.remoteItems.get(key!)!;
      next.set(listId, changed);
      this.writes.push({ principal: key!, action, name });
      if (this.options.uncertainNextWrite) {
        this.options.uncertainNextWrite = false;
        return responseJson(route, { code: 'bring_write_unconfirmed', message: 'bring_write_unconfirmed' }, 503);
      }
      return responseJson(route, { connectionId, listId, labelsAvailable: true, items: structuredClone(changed) });
    }
    return false;
  }

  private async authorize(route: Route, key: AccountKey | null, token: string | undefined, csrfRequired: boolean, path: string): Promise<boolean> {
    if (key === null) {
      await responseJson(route, { code: 'session_required', message: 'session_required' }, 401);
      return false;
    }
    if (csrfRequired && token !== ACCOUNT_DATA[key].csrf) {
      this.csrfFailures.push(path);
      await responseJson(route, { code: 'csrf_failed', message: 'csrf_failed' }, 403);
      return false;
    }
    return true;
  }
}

const openBring = async (page: Page): Promise<void> => {
  const disclosure = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Bring!$/ }) });
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) await disclosure.locator('summary').click();
};

const backends = new WeakMap<Page, StatefulBringBackend>();
const installBackend = async (page: Page, options: BringBackendOptions = {}): Promise<StatefulBringBackend> => {
  const backend = new StatefulBringBackend(options);
  backends.set(page, backend);
  await backend.install(page);
  return backend;
};

const loginAs = async (page: Page, account: AccountKey): Promise<void> => {
  const data = ACCOUNT_DATA[account];
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Accedi o registrati' }).click();
  await page.getByRole('button', { name: 'Accedi', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(data.email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-only-account-password');
  await page.getByRole('button', { name: 'Accedi al profilo' }).click();
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
  await expect(page.getByText(data.email, { exact: true })).toBeVisible();
};

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
  const backend = backends.get(page);
  expect(backend?.upstreamRequests ?? [], 'the browser must never contact Bring! directly').toEqual([]);
  expect(backend?.csrfFailures ?? [], 'state-changing requests must use the principal cookie and its CSRF token').toEqual([]);
});

test('guest keeps local list and cannot connect Bring', async ({ page }) => {
  const backend = await installBackend(page);
  await page.goto('/shopping-list');
  await page.getByLabel('Cosa ti serve?').fill('Pasta');
  await page.getByRole('button', { name: 'Aggiungi alla lista' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

  await openBring(page);
  await expect(page.getByText(/Per collegare Bring! serve un account verificato\./)).toBeVisible();
  expect(backend.bringRequests).toEqual([]);
  await expect(page.getByRole('link', { name: 'Accedi o verifica il tuo account' })).toHaveAttribute('href', '/profile');

  await page.locator('summary').filter({ hasText: /^Bring!$/ }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  expect(backend.bringRequests).toEqual([]);
  expect(backend.syncWriteTypes).toEqual([]);
});



test('verified account connects and reads only its explicitly chosen Bring list', async ({ page }) => {
  const backend = await installBackend(page);
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await expect(page.locator('summary').filter({ hasText: /^Bring!$/ }).locator('..')).not.toHaveAttribute('open', '');
  await expect(page.getByLabel('Email Bring!')).toHaveCount(0);
  expect(backend.bringRequests).toEqual([]);
  await openBring(page);

  const email = page.getByLabel('Email Bring!');
  const password = page.getByLabel('Password Bring!');
  await email.fill('bring-account@example.test');
  await password.fill('synthetic-only-bring-password');
  await page.getByRole('checkbox', { name: /Autorizzo A tavola ad accedere/ }).check();
  await page.getByRole('button', { name: 'Collega Bring!', exact: true }).click();

  const list = page.getByRole('combobox', { name: 'Lista Bring!' });
  await expect(list).toBeVisible();
  await expect(list).toHaveValue('');
  expect(backend.itemReads).toEqual([]);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/connection'))).toHaveLength(1);
  expect(backend.bringRequests.filter((request) => request.method === 'GET' && request.path.endsWith('/items'))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({
    local: Array.from({ length: localStorage.length }, (_, index) => [localStorage.key(index), localStorage.getItem(localStorage.key(index) ?? '')]),
    session: Array.from({ length: sessionStorage.length }, (_, index) => [sessionStorage.key(index), sessionStorage.getItem(sessionStorage.key(index) ?? '')]),
  }))).not.toContain('synthetic-only-bring-password');

  await list.selectOption(LIST_TWO);
  const remoteMilk = page.locator(`[data-bring-name="Milch"]`);
  await expect(remoteMilk.getByText('Latte', { exact: true })).toBeVisible();
  expect(backend.itemReads).toEqual([{ principal: 'a', listId: LIST_TWO }]);
  expect(backend.bringRequests.filter((request) => request.method === 'GET' && request.path.endsWith('/items')).map((request) => request.listId)).toEqual([LIST_TWO]);

  await page.reload();
  await openBring(page);
  await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: /^Bring!$/ }).locator('..')).toHaveAttribute('open', '');
  const reopenedList = page.getByRole('combobox', { name: 'Lista Bring!' });
  await expect(reopenedList).toHaveValue('');
  await reopenedList.selectOption(LIST_TWO);
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();

  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/connection'))).toHaveLength(1);
  expect(backend.itemReads.every((read) => read.listId === LIST_TWO && read.principal === 'a')).toBe(true);
  expect(backend.syncWriteTypes).not.toContain('shopping_list_item');
});

test('adds and confirms a remote ingredient without writing it to local sync', async ({ page }) => {
  const backend = await installBackend(page, { connected: ['a'], items: { a: { [LIST_TWO]: [] } } });
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  await expect(page.getByText('La lista Bring! è vuota.')).toBeVisible();

  await page.getByLabel('Cosa aggiungere a Bring!').fill('Latte');
  await page.getByLabel('Specifica Bring!').fill('2 l');
  await page.getByRole('button', { name: 'Aggiungi a Bring!' }).click();
  await expect(page.getByText('Modifica confermata su Bring!.')).toBeVisible();
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Cosa aggiungere a Bring!')).toHaveValue('');
  expect(backend.writes).toEqual([{ principal: 'a', action: 'add', name: 'Latte' }]);
  const syncCountAfterWrite = backend.syncMutations.length;
  expect(backend.syncWriteTypes).toEqual([]);

  await page.locator('summary').filter({ hasText: /^Bring!$/ }).click();
  await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
  await expect(page.getByText('La lista è vuota')).toBeVisible();
  await expect(page.getByText('Latte', { exact: true })).toHaveCount(0);
  expect(backend.syncMutations.length).toBe(syncCountAfterWrite);
  expect(backend.syncWriteTypes).toEqual([]);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/items'))).toMatchObject([
    { principal: 'a', listId: LIST_TWO, action: 'add', connectionId: CONNECTION_A },
  ]);
});

test('updates completes restores and removes the selected item by raw Bring name', async ({ page }) => {
  const backend = await installBackend(page, { connected: ['a'] });
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  const milk = page.locator('[data-bring-name="Milch"]');
  await expect(milk.getByText('Latte', { exact: true })).toBeVisible();

  await milk.getByText('Modifica specifica di Latte').click();
  await milk.getByLabel('Nuova specifica di Latte').fill('2 l');
  await milk.getByRole('button', { name: 'Salva specifica di Latte' }).click();
  await expect(page.getByText('Modifica confermata su Bring!.')).toBeVisible();
  await expect(milk.getByText('2 l', { exact: true })).toBeVisible();

  await milk.getByRole('button', { name: 'Segna Latte acquistato su Bring!' }).click();
  await expect(page.getByRole('heading', { name: 'Acquistati su Bring!' })).toBeVisible();
  await expect(page.getByText('Modifica confermata su Bring!.')).toBeVisible();
  await milk.getByRole('button', { name: 'Ripristina Latte su Bring!' }).click();
  await expect(page.getByRole('heading', { name: 'Da acquistare su Bring!' })).toBeVisible();
  await expect(page.getByText('Modifica confermata su Bring!.')).toBeVisible();
  await milk.getByRole('button', { name: 'Rimuovi Latte da Bring!' }).click();
  await expect(page.getByText('La lista Bring! è vuota.')).toBeVisible();

  expect(backend.writes.map(({ action, name, principal }) => ({ action, name, principal }))).toEqual([
    { action: 'update', name: 'Milch', principal: 'a' },
    { action: 'complete', name: 'Milch', principal: 'a' },
    { action: 'restore', name: 'Milch', principal: 'a' },
    { action: 'remove', name: 'Milch', principal: 'a' },
  ]);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/items'))).toMatchObject([
    { principal: 'a', listId: LIST_TWO, action: 'update', connectionId: CONNECTION_A },
    { principal: 'a', listId: LIST_TWO, action: 'complete', connectionId: CONNECTION_A },
    { principal: 'a', listId: LIST_TWO, action: 'restore', connectionId: CONNECTION_A },
    { principal: 'a', listId: LIST_TWO, action: 'remove', connectionId: CONNECTION_A },
  ]);
  expect(backend.syncWriteTypes).toEqual([]);
});

test('keeps an uncertain write draft until the user reconciles the remote list', async ({ page }) => {
  const backend = await installBackend(page, { connected: ['a'], items: { a: { [LIST_TWO]: [] } }, uncertainNextWrite: true });
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  await expect(page.getByText('La lista Bring! è vuota.')).toBeVisible();

  const name = page.getByLabel('Cosa aggiungere a Bring!');
  const specification = page.getByLabel('Specifica Bring!');
  await name.fill('Latte');
  await specification.fill('2 l');
  await page.getByRole('button', { name: 'Aggiungi a Bring!' }).click();
  await expect(page.getByRole('alert')).toHaveText('Non posso confermare la modifica. Aggiorna la lista prima di riprovare.');
  await expect(name).toHaveValue('Latte');
  await expect(specification).toHaveValue('2 l');
  await expect(page.getByText('Modifica confermata su Bring!.')).toHaveCount(0);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/items'))).toHaveLength(1);
  expect(backend.writes).toEqual([{ principal: 'a', action: 'add', name: 'Latte' }]);

  await page.waitForTimeout(300);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/items'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Aggiorna lista Bring!' }).click();
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();
  expect(backend.itemReads).toHaveLength(2);
  expect(backend.writes).toHaveLength(1);
  expect(backend.syncWriteTypes).toEqual([]);
});

test('reconnects with a fresh remote session after Bring expires', async ({ page }) => {
  const backend = await installBackend(page, { connected: ['a'], expiredRead: true });
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  await expect(page.getByText('Il collegamento è scaduto. Ricollega Bring!.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Lista Bring!' })).toHaveCount(0);
  await expect.poll(() => page.getByRole('banner').getByText('Account verificato').evaluateAll((items) => items.some((item) => item.getClientRects().length > 0))).toBe(true);
  await expect(page.getByText('Ospite · dati locali')).toHaveCount(0);
  expect(backend.logoutPrincipals).toEqual([]);
  expect(backend.bringRequests.every((request) => request.principal === 'a')).toBe(true);

  await page.getByLabel('Email Bring!').fill('bring-account@example.test');
  await page.getByLabel('Password Bring!').fill('synthetic-only-reconnect-password');
  await page.getByRole('checkbox', { name: /Autorizzo A tavola ad accedere/ }).check();
  await page.getByRole('button', { name: 'Collega Bring!', exact: true }).click();
  await expect(page.getByText('Bring! collegato. Scegli la lista da aprire.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();

  expect(backend.itemReads.map(({ listId, principal }) => ({ listId, principal }))).toEqual([
    { listId: LIST_TWO, principal: 'a' },
    { listId: LIST_TWO, principal: 'a' },
  ]);
  expect(backend.bringRequests.filter((request) => request.method === 'GET' && request.path.endsWith('/items')).map((request) => request.connectionId)).toEqual([
    CONNECTION_A,
    CONNECTION_RECONNECTED,
  ]);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/connection'))).toHaveLength(1);
  expect(backend.writes).toEqual([]);
  expect(backend.logoutPrincipals).toEqual([]);
});

test('does not apply account A items after the session switches to account B', async ({ page }) => {
  const backend = await installBackend(page, {
    connected: ['a', 'b'],
    items: {
      a: {
        [LIST_ONE]: [{ name: 'Water', label: 'Acqua', specification: '', state: 'purchase', mutable: true }],
        [LIST_TWO]: [{ name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true }],
      },
      b: {
        [LIST_ONE]: [{ name: 'Bread', label: 'Pane', specification: '', state: 'purchase', mutable: true }],
        [LIST_TWO]: [{ name: 'Cookies', label: 'Biscotti', specification: '200 g', state: 'purchase', mutable: true }],
      },
    },
  });
  await page.addInitScript(() => {
    const target = window as typeof window & { __bringFetchGate?: BringFetchGate };
    const gate: BringFetchGate = {
      holdNextItemsResponse: false,
      itemsResponseHeld: false,
      itemsResponseResumed: false,
      releaseItemsResponse: null,
    };
    target.__bringFetchGate = gate;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const inputUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(inputUrl, window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (gate.holdNextItemsResponse && method.toUpperCase() === 'GET' && url.pathname === '/v1/integrations/bring/items') {
        gate.holdNextItemsResponse = false;
        gate.itemsResponseHeld = true;
        const body = await response.clone().text();
        await new Promise<void>((resolve) => { gate.releaseItemsResponse = resolve; });
        gate.itemsResponseResumed = true;
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      return response;
    };
  });

  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_ONE);
  await expect(page.locator('[data-bring-name="Water"]').getByText('Acqua', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __bringFetchGate?: BringFetchGate }).__bringFetchGate!.holdNextItemsResponse = true;
  });
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  await page.waitForFunction(() => (window as typeof window & { __bringFetchGate?: BringFetchGate }).__bringFetchGate?.itemsResponseHeld === true);

  try {
    await page.getByRole('link', { name: 'Profilo', exact: true }).click();
    await page.getByRole('button', { name: 'Esci', exact: true }).click();
    await page.getByRole('link', { name: 'Profilo', exact: true }).click();
    await page.getByRole('button', { name: 'Accedi o registrati' }).click();
    await page.getByRole('button', { name: 'Accedi', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill(ACCOUNT_DATA.b.email);
    await page.getByLabel('Password', { exact: true }).fill('synthetic-only-account-password');
    await page.getByRole('button', { name: 'Accedi al profilo' }).click();
    await expect(page.getByText(ACCOUNT_DATA.b.email, { exact: true })).toBeVisible();
    await expect.poll(() => page.getByRole('banner').getByText('Account verificato').evaluateAll((items) => items.some((item) => item.getClientRects().length > 0))).toBe(true);
    await expect(page.getByText('Ospite · dati locali')).toHaveCount(0);

    await page.getByRole('link', { name: 'Spesa', exact: true }).click();
    await openBring(page);
    await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
    await expect(page.locator('[data-bring-name="Cookies"]').getByText('Biscotti', { exact: true })).toBeVisible();

    await page.evaluate(() => {
      (window as typeof window & { __bringFetchGate?: BringFetchGate }).__bringFetchGate!.releaseItemsResponse?.();
    });
    await page.waitForFunction(() => (window as typeof window & { __bringFetchGate?: BringFetchGate }).__bringFetchGate?.itemsResponseResumed === true);
    await expect(page.locator('[data-bring-name="Cookies"]').getByText('Biscotti', { exact: true })).toBeVisible();
    await expect(page.getByText('Latte', { exact: true })).toHaveCount(0);
    expect(backend.logoutPrincipals).toEqual(['a']);
    expect(backend.itemReads.map(({ principal, listId }) => ({ principal, listId }))).toEqual([
      { principal: 'a', listId: LIST_ONE },
      { principal: 'a', listId: LIST_TWO },
      { principal: 'b', listId: LIST_TWO },
    ]);
    expect(backend.bringRequests.filter((request) => request.method === 'GET' && request.path.endsWith('/items')).map((request) => request.principal)).toEqual(['a', 'a', 'b']);
    expect(backend.syncWriteTypes).toEqual([]);
  } finally {
    await page.evaluate(() => {
      (window as typeof window & { __bringFetchGate?: BringFetchGate }).__bringFetchGate?.releaseItemsResponse?.();
    }).catch(() => undefined);
  }
});

test('keeps remote reads and mutations disabled offline until explicit refresh', async ({ page }) => {
  const backend = await installBackend(page, { connected: ['a'] });
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();
  const initialReadCount = backend.itemReads.length;

  await page.context().setOffline(true);
  await expect(page.getByText('Sei offline: i dati Bring! mostrati potrebbero non essere aggiornati. Le modifiche sono disabilitate.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aggiungi a Bring!' })).toBeDisabled();
  await expect(page.locator('[data-bring-name="Milch"]').getByRole('button', { name: 'Rimuovi Latte da Bring!' })).toBeDisabled();
  expect(backend.itemReads).toHaveLength(initialReadCount);
  expect(backend.writes).toEqual([]);

  await page.context().setOffline(false);
  await expect(page.getByText('Sei offline: i dati Bring! mostrati potrebbero non essere aggiornati. Le modifiche sono disabilitate.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aggiorna lista Bring!' })).toBeEnabled();
  expect(backend.itemReads).toHaveLength(initialReadCount);
  await page.getByRole('button', { name: 'Aggiorna lista Bring!' }).click();
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();
  expect(backend.itemReads).toHaveLength(initialReadCount + 1);
  expect(backend.writes).toEqual([]);
  expect(backend.syncWriteTypes).toEqual([]);
});

test('disconnects A tavola without deleting remote Bring lists', async ({ page }) => {
  const backend = await installBackend(page, { connected: ['a'] });
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();
  const remoteItemsBeforeDisconnect = backend.getItems('a', LIST_TWO);

  await page.getByRole('button', { name: 'Scollega Bring!' }).click();
  await expect(page.getByText('Bring! scollegato da A tavola. Le liste su Bring! non sono state cancellate.')).toBeVisible();
  expect(backend.getConnection('a')).toBeNull();
  expect(backend.getItems('a', LIST_TWO)).toEqual(remoteItemsBeforeDisconnect);
  expect(backend.bringRequests.filter((request) => request.method === 'DELETE' && request.path.endsWith('/connection'))).toHaveLength(1);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
  await expect(page.getByText('La lista è vuota')).toBeVisible();
  await openBring(page);
  await expect(page.getByLabel('Email Bring!')).toBeVisible();
  expect(backend.getConnection('a')).toBeNull();
  expect(backend.getItems('a', LIST_TWO)).toEqual(remoteItemsBeforeDisconnect);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/connection'))).toEqual([]);
  expect(backend.syncWriteTypes).toEqual([]);
});

test('keeps duplicate raw names read-only when their remote identity is ambiguous', async ({ page }) => {
  const duplicates: RemoteItem[] = [
    { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: false },
    { name: 'Milch', label: 'Latte', specification: '2 l', state: 'purchase', mutable: false },
  ];
  const backend = await installBackend(page, { connected: ['a'], items: { a: { [LIST_TWO]: duplicates } } });
  await loginAs(page, 'a');
  await page.goto('/shopping-list');
  await openBring(page);
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(LIST_TWO);
  const milkRows = page.locator('[data-bring-name="Milch"]');
  await expect(milkRows).toHaveCount(2);
  await expect(milkRows.first().getByText('1 l', { exact: true })).toBeVisible();
  await expect(milkRows.nth(1).getByText('2 l', { exact: true })).toBeVisible();
  await expect(milkRows.getByText('Articolo non modificabile in sicurezza: gestiscilo nell’app Bring!.')).toHaveCount(2);
  await expect(milkRows.getByRole('button')).toHaveCount(0);

  await page.getByLabel('Cosa aggiungere a Bring!').fill('Latte');
  await expect(page.getByRole('button', { name: 'Aggiungi a Bring!' })).toBeDisabled();
  expect(backend.getItems('a', LIST_TWO)).toEqual(duplicates);
  expect(backend.writes).toEqual([]);
  expect(backend.bringRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/items'))).toEqual([]);
  expect(backend.syncWriteTypes).toEqual([]);
});
