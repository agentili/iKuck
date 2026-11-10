import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { PlanCommand, PlanState, SyncMutationScope } from '@ikuck/shared/contracts';
import { RECIPES } from '../src/domain/recipes';

test.skip(process.env.IKUCK_MEAL_PLAN_DISPOSABLE !== 'true', 'Requires dedicated PostgreSQL/Redis, never production');
const origin = 'http://127.0.0.1:5173';
const password = 'disposable-t06-password';
interface Session { user: { id: string; email: string }; csrfToken: string }

async function register(context: BrowserContext): Promise<Session> {
  const email = `t06-${randomUUID()}@example.test`;
  const registered = await context.request.post(`${origin}/v1/auth/register`, { headers: { origin }, data: { email, password } });
  expect(registered.ok()).toBe(true);
  const loggedIn = await context.request.post(`${origin}/v1/auth/login`, { headers: { origin }, data: { email, password } });
  expect(loggedIn.ok()).toBe(true);
  return await loggedIn.json() as Session;
}

async function post(context: BrowserContext, session: Session, path: string, data: unknown) {
  return context.request.post(`${origin}${path}`, { headers: { origin, 'x-csrf-token': session.csrfToken }, data });
}

async function storedPlanOutbox(page: Page, scope: string): Promise<Array<{ entityType: string; mutationId: string; localOrder: number; command?: PlanCommand }>> {
  return page.evaluate(async (dataScope) => {
    const opening = indexedDB.open('ikuck-local-v2');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<Array<{ entityType: string; mutationId: string; localOrder: number; command?: PlanCommand }>>((resolve, reject) => {
        const transaction = db.transaction('syncQueue', 'readonly');
        const query = transaction.objectStore('syncQueue').index('byScope').getAll(dataScope);
        query.onsuccess = () => resolve((query.result ?? []).filter((entry) => entry.entityType === 'meal_plan_entry'));
        query.onerror = () => reject(query.error);
      });
    } finally { db.close(); }
  }, scope);
}

async function storedPlan(page: Page, scope: string) {
  return page.evaluate(async (dataScope) => {
    const opening = indexedDB.open('ikuck-local-v2');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<{ states: Record<string, PlanState>; overlays: Record<string, PlanState>; bootstrap: unknown } | null>((resolve, reject) => {
        const query = db.transaction('keyValue').objectStore('keyValue').get(`ikuck:${dataScope}:meal-plan-v2`);
        query.onsuccess = () => resolve(query.result ?? null);
        query.onerror = () => reject(query.error);
      });
    } finally { db.close(); }
  }, scope);
}

async function storedMutationCount(page: Page, scope: string, entityType: string): Promise<number> {
  return page.evaluate(async ({ dataScope, type }) => {
    const opening = indexedDB.open('ikuck-local-v2');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const query = db.transaction('syncQueue', 'readonly').objectStore('syncQueue').index('byScope').getAll(dataScope);
        query.onsuccess = () => resolve((query.result ?? []).filter((entry) => entry.entityType === type).length);
        query.onerror = () => reject(query.error);
      });
    } finally { db.close(); }
  }, { dataScope: scope, type: entityType });
}

const localPlanDateInTwoDays = (): string => {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

test('a losing account manual choice does not break the house Plan sync page after real membership bootstrap', async ({ browser }) => {
  const admin = await browser.newContext();
  const member = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
  try {
    const adminSession = await register(admin);
    const memberSession = await register(member);
    const created = await post(admin, adminSession, '/v1/house', { name: 'Casa T06 manuale perdente' });
    expect(created.status()).toBe(201);
    const house = await created.json() as { house: { id: string } };
    const houseScope: SyncMutationScope = `house:${house.house.id}`;
    const accountScope: SyncMutationScope = `account:${memberSession.user.id}`;
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 2);
    const planDate = date.toISOString().slice(0, 10);
    const winningRecipe = RECIPES[0];
    const losingRecipe = RECIPES[1];
    if (winningRecipe === undefined || losingRecipe === undefined) {
      throw new Error('The live Plan regression requires at least two recipes');
    }
    const houseCommand: PlanCommand = {
      version: 2, scope: houseScope, date: planDate, operationId: randomUUID(), deviceId: 't06-house-choice',
      clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_set', recipeId: winningRecipe.id,
    };
    const accountCommand: PlanCommand = {
      version: 2, scope: accountScope, date: planDate, operationId: randomUUID(), deviceId: 't06-account-choice',
      clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'manual_set', recipeId: losingRecipe.id,
    };
    expect((await post(admin, adminSession, '/v1/meal-plan/commands', houseCommand)).status()).toBe(200);
    expect((await post(member, memberSession, '/v1/meal-plan/commands', accountCommand)).status()).toBe(200);
    expect((await post(admin, adminSession, '/v1/house/members', { email: memberSession.user.email })).status()).toBe(201);

    const page = await member.newPage();
    const planSyncRequests: Array<{ syncScope?: string }> = [];
    const planSyncPages: Array<Promise<unknown>> = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname !== '/v1/sync' || request.method() !== 'POST') return;
      const requestBody = request.postDataJSON() as { mealPlanReadVersion?: number; syncScope?: string };
      if (requestBody.mealPlanReadVersion === 2) planSyncRequests.push(requestBody);
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname !== '/v1/sync' || response.request().method() !== 'POST') return;
      const requestBody = response.request().postDataJSON() as { mealPlanReadVersion?: number };
      if (requestBody.mealPlanReadVersion === 2) planSyncPages.push(response.json());
    });
    await page.goto('/plan');
    await expect.poll(() => planSyncPages.length).toBeGreaterThan(0);
    expect(planSyncRequests.some((request) => request.syncScope === houseScope)).toBe(true);
    await expect(page.getByRole('alert').filter({ hasText: 'La pagina di sincronizzazione del piano non è valida.' })).toHaveCount(0);
    await expect(page.getByText('Condiviso con la Casa', { exact: true })).toBeVisible();
    const row = page.locator(`[data-date="${planDate}"]`);
    await expect(row).toContainText(winningRecipe.title);

    const pages = await Promise.all(planSyncPages) as Array<{
      changes: Array<{ entityType: string; entityId: string; syncScope: string; payload: unknown }>;
    }>;
    const planChangesForDate = pages.flatMap((syncPage) => syncPage.changes)
      .filter((change) => change.entityType === 'meal_plan_entry' && change.entityId === planDate);
    expect(planChangesForDate).toEqual([
      expect.objectContaining({
        syncScope: houseScope,
        payload: expect.objectContaining({ kind: 'manual', recipeId: winningRecipe.id }),
      }),
    ]);
  } finally { await Promise.all([admin.close(), member.close()]); }
});

test('account Plan outbox survives offline-to-House transition, retries a lost receipt, and remains isolated after revocation', async ({ browser }) => {

  const admin = await browser.newContext();
  const member = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const outsider = await browser.newContext();
  try {
    const adminSession = await register(admin);
    const memberSession = await register(member);
    const outsiderSession = await register(outsider);
    const outsiderHouseResponse = await post(outsider, outsiderSession, '/v1/house', { name: 'Casa T06 isolamento' });
    expect(outsiderHouseResponse.status()).toBe(201);
    const outsiderHouse = await outsiderHouseResponse.json() as { house: { id: string } };
    const created = await post(admin, adminSession, '/v1/house', { name: 'Casa T06 account outbox' });
    expect(created.status()).toBe(201);
    const house = await created.json() as { house: { id: string } };
    const houseScope: SyncMutationScope = `house:${house.house.id}`;
    const accountScope = `account:${memberSession.user.id}`;
    const date = localPlanDateInTwoDays();
    const seeded = await post(member, memberSession, '/v1/meal-plan/import', {
      version: 2,
      scope: accountScope,
      items: [{
        source: 'guest',
        sourceId: date,
        localRevision: randomUUID(),
        command: {
          version: 2,
          scope: accountScope,
          date,
          operationId: randomUUID(),
          deviceId: 't06-account-seed',
          clientUpdatedAt: new Date().toISOString(),
          action: 'manual_set',
          recipeId: RECIPES[0].id,
        },
      }],
    });
    expect(seeded.status()).toBe(200);

    const page = await member.newPage();
    await page.goto('/plan');
    await expect(page.getByText('Sincronizzato con il tuo account', { exact: true })).toBeVisible();
    const row = page.locator(`[data-date="${date}"]`);
    await expect(row.getByRole('button', { name: /modifica ricetta/i })).toBeVisible();

    await page.route('**/v1/sync', (route) => route.abort('failed'));
    await page.goto('/shopping-list');
    await page.getByRole('button', { name: 'iKuck', exact: true }).click();
    await page.getByLabel('Cosa ti serve?').fill('riso');
    await page.getByRole('button', { name: 'Aggiungi alla lista' }).click();
    await expect(page.getByText('Riso', { exact: true })).toBeVisible();
    await expect.poll(() => storedMutationCount(page, accountScope, 'shopping_list_item')).toBeGreaterThan(0);

    await page.goto('/plan');
    await expect(page.getByText('In attesa di conferma · non ancora condiviso', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: /modifica ricetta/i })).toBeVisible();
    await member.setOffline(true);
    await row.getByRole('button', { name: /modifica ricetta/i }).click();
    await expect(row.getByText('In attesa di conferma · non condivisa', { exact: true })).toBeVisible();
    const pending = await storedPlanOutbox(page, accountScope);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.command).toMatchObject({ scope: accountScope, date, action: 'manual_set' });
    const pendingCommand = pending[0]?.command;
    if (pendingCommand?.action !== 'manual_set') throw new Error('Expected a pending manual Plan command');

    const membership = await post(admin, adminSession, '/v1/house/members', { email: memberSession.user.email });
    expect(membership.status()).toBe(201);
    const importRequests: unknown[] = [];
    const queueImportRequests: unknown[] = [];
    let dropResponse = true;
    let explicitReloadRetry = false;
    await page.route('**/v1/house/account-queue/import', async (route) => {
      queueImportRequests.push(route.request().postDataJSON());
      await route.fulfill({ response: await route.fetch() });
    });
    await page.route('**/v1/meal-plan/import', async (route) => {
      const body = route.request().postDataJSON() as unknown;
      importRequests.push(body);
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      if (dropResponse) {
        dropResponse = false;
        await route.abort('failed');
      } else if (!explicitReloadRetry || route.request().headers()['x-t06-retry'] !== 'yes') {
        await route.abort('failed');
      } else {
        await route.fulfill({ response });
      }
    });

    await page.unroute('**/v1/sync');
    await member.setOffline(false);
    await page.goto('/plan');
    await expect(page.getByText('Condiviso con la Casa', { exact: true })).toBeVisible();
    await expect.poll(() => importRequests.length).toBe(1);
    await expect.poll(async () => storedPlanOutbox(page, accountScope)).toHaveLength(1);
    await expect.poll(() => queueImportRequests.length).toBeGreaterThan(0);

    explicitReloadRetry = true;
    await page.setExtraHTTPHeaders({ 'x-t06-retry': 'yes' });
    await page.reload();
    await expect(page.getByText('Condiviso con la Casa', { exact: true })).toBeVisible();
    await expect.poll(() => importRequests.length).toBeGreaterThan(1);
    expect(importRequests.every((body) => JSON.stringify(body) === JSON.stringify(importRequests[0]))).toBe(true);
    const accountImport = importRequests[0] as { version: number; scope: string; items: Array<{ source: string; sourceId: string; localRevision: string; command: PlanCommand }> };
    expect(accountImport).toMatchObject({ version: 2, scope: houseScope });
    expect(accountImport.items[0]).toMatchObject({
      source: 'account',
      sourceId: pending[0]?.mutationId,
      localRevision: String(pending[0]?.localOrder),
      command: { scope: houseScope, date, action: 'manual_set' },
    });
    await expect.poll(async () => storedPlanOutbox(page, accountScope)).toHaveLength(0);
    const housePlan = await post(member, memberSession, '/v1/meal-plan/read', { version: 2, scope: houseScope, dates: [date] });
    expect(housePlan.status()).toBe(200);
    const houseState = (await housePlan.json() as { states: Array<{ state: PlanState | null }> }).states[0]?.state;
    expect(houseState).not.toBeNull();
    expect(houseState?.recipeId).toBe(pendingCommand.recipeId);

    const importedQueueMutations = queueImportRequests.flatMap((entry) => (
      (entry as { mutations?: Array<{ entityType: string; payload: unknown }> }).mutations ?? []
    ));
    expect(importedQueueMutations.some((mutation) => mutation.entityType === 'shopping_list_item'
      && JSON.stringify(mutation.payload).toLocaleLowerCase().includes('riso'))).toBe(true);
    const sharedChanges = await post(member, memberSession, '/v1/sync', {
      deviceId: 't06-live-verification', cursor: 0, syncScope: houseScope, mutations: [],
      supportedEntityTypes: ['shopping_list_item'],
    });
    expect(sharedChanges.status()).toBe(200);
    expect(JSON.stringify(await sharedChanges.json()).toLocaleLowerCase()).toContain('riso');

    const sharedShopping = await member.request.get(`${origin}/v1/shopping-list`, { headers: { origin } });
    expect(sharedShopping.status()).toBe(200);
    expect(JSON.stringify(await sharedShopping.json())).toContain('Riso');
    const outsiderRead = await post(outsider, outsiderSession, '/v1/meal-plan/read', { version: 2, scope: houseScope, dates: [date] });
    expect(outsiderRead.status()).toBe(409);
    expect(await outsiderRead.json()).toMatchObject({ code: 'sync_scope_invalid' });
    const outsiderHousePlan = await post(outsider, outsiderSession, '/v1/meal-plan/read', {
      version: 2, scope: `house:${outsiderHouse.house.id}`, dates: [date],
    });
    expect(outsiderHousePlan.status()).toBe(200);
    expect((await outsiderHousePlan.json() as { states: Array<{ state: PlanState | null }> }).states[0]?.state).toBeNull();

    const removed = await admin.request.delete(`${origin}/v1/house/members/${encodeURIComponent(memberSession.user.id)}`, {
      headers: { origin, 'x-csrf-token': adminSession.csrfToken },
    });
    expect(removed.status()).toBe(204);
    const revokedRead = await post(member, memberSession, '/v1/meal-plan/read', { version: 2, scope: houseScope, dates: [date] });
    expect(revokedRead.status()).toBe(403);
    const adminRead = await post(admin, adminSession, '/v1/meal-plan/read', { version: 2, scope: houseScope, dates: [date] });
    expect(adminRead.status()).toBe(200);
    expect((await adminRead.json() as { states: Array<{ state: PlanState | null }> }).states[0]?.state?.recipeId)
      .toBe(pendingCommand.recipeId);
  } finally { await Promise.all([admin.close(), member.close(), outsider.close()]); }
});

test('a new member bootstraps 201 historical dates, stays isolated from outsiders, and reconnects an offline choice', async ({ browser }) => {
  const admin = await browser.newContext();
  const member = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const outsider = await browser.newContext();
  try {
    const adminSession = await register(admin);
    const memberSession = await register(member);
    const outsiderSession = await register(outsider);
    const created = await post(admin, adminSession, '/v1/house', { name: 'Casa T06 disposable' });
    expect(created.status()).toBe(201);
    const house = await created.json() as { house: { id: string } };
    const scope: SyncMutationScope = `house:${house.house.id}`;
    const history = Array.from({ length: 201 }, (_, index) => new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10));
    for (let offset = 0; offset < history.length; offset += 100) {
      const items = history.slice(offset, offset + 100).map((date) => ({ source: 'guest', sourceId: date, localRevision: randomUUID(),
        command: { version: 2, scope, date, operationId: randomUUID(), deviceId: 'disposable-history',
          clientUpdatedAt: new Date().toISOString(), action: 'manual_set', recipeId: RECIPES[0].id } }));
      const seeded = await post(admin, adminSession, '/v1/meal-plan/import', { version: 2, scope, items });
      expect(seeded.status()).toBe(200);
    }
    expect((await post(admin, adminSession, '/v1/house/members', { email: memberSession.user.email })).status()).toBe(201);
    const page = await member.newPage();
    const cursors: number[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname !== '/v1/sync' || request.method() !== 'POST') return;
      const body = request.postDataJSON() as { mealPlanReadVersion?: number; cursor: number };
      if (body.mealPlanReadVersion === 2) cursors.push(body.cursor);
    });
    await page.goto('/plan');
    await expect(page.getByText('Condiviso con la Casa', { exact: true })).toBeVisible();
    await expect.poll(async () => Object.keys((await storedPlan(page, scope))?.states ?? {}).filter((date) => date.startsWith('2020-')).length).toBe(201);
    expect(cursors[0]).toBe(0);
    expect(cursors.length).toBeGreaterThanOrEqual(2);
    expect(cursors[1]).toBeGreaterThan(0);
    const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect((await page.getByRole('button', { name: /modifica ricetta/i }).first().boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: '../.hermes/plans/t06-bootstrap-plan-mobile.png', fullPage: true });

    const rejected = await post(outsider, outsiderSession, '/v1/meal-plan/read', { version: 2, scope, dates: [history[0]] });
    expect(rejected.status()).toBe(403);
    const outsiderPage = await outsider.newPage();
    await outsiderPage.goto('/plan');
    await expect(outsiderPage.getByText('Sincronizzato con il tuo account', { exact: true })).toBeVisible();
    const outsiderSnapshot = await storedPlan(outsiderPage, `account:${outsiderSession.user.id}`);
    expect(Object.keys(outsiderSnapshot?.states ?? {}).some((date) => date.startsWith('2020-'))).toBe(false);

    const firstRow = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
    const date = (await firstRow.getAttribute('data-date'))!;
    await member.setOffline(true);
    await firstRow.getByRole('button', { name: /modifica ricetta/i }).click();
    await expect(firstRow.getByText('In attesa di conferma · non condivisa', { exact: true })).toBeVisible();
    await expect.poll(async () => (await storedPlan(page, scope))?.overlays[date]?.kind).toBe('manual');
    const offlineChoice = (await storedPlan(page, scope))!.overlays[date]!;
    await member.setOffline(false);
    await expect.poll(async () => (await storedPlan(page, scope))?.overlays[date] ?? null, { timeout: 15000 }).toBeNull();
    const read = await post(admin, adminSession, '/v1/meal-plan/read', { version: 2, scope, dates: [date] });
    expect(read.status()).toBe(200);
    expect((await read.json() as { states: Array<{ state: PlanState }> }).states[0]?.state.recipeId).toBe(offlineChoice.recipeId);
  } finally { await Promise.all([admin.close(), member.close(), outsider.close()]); }
});

test('guest import requires confirmation and retries the same operations after a real server commit with a lost response', async ({ browser }) => {
  const account = await browser.newContext();
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const session = await register(account);
    const page = await guest.newPage();
    await page.goto('/plan');
    const first = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
    await expect(first.getByRole('button', { name: /modifica ricetta/i })).toBeVisible();
    await first.getByRole('button', { name: /modifica ricetta/i }).click();
    const date = (await first.getAttribute('data-date'))!;
    await expect.poll(async () => (await storedPlan(page, 'guest'))?.states[date]?.kind).toBe('manual');
    const source = (await storedPlan(page, 'guest'))!.states[date]!;
    const requests: PlanCommand[][] = [];
    let dropResponse = true;
    await page.route('**/v1/meal-plan/import', async (route) => {
      const body = route.request().postDataJSON() as { items: Array<{ command: PlanCommand }> };
      requests.push(body.items.map((item) => item.command));
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (dropResponse) { dropResponse = false; await route.abort('failed'); }
      else await route.fulfill({ response });
    });
    await page.goto('/profile');
    await page.getByRole('button', { name: 'Accedi o registrati' }).click();
    await page.getByLabel('Email', { exact: true }).fill(session.user.email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Accedi al profilo' }).click();
    await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
    expect(requests).toHaveLength(0);
    expect((await storedPlan(page, 'guest'))!.states[date]?.revision).toBe(source.revision);
    await page.getByRole('button', { name: 'Importa Piano ospite' }).click();
    await page.screenshot({ path: '../.hermes/plans/t06-bootstrap-import-mobile.png', fullPage: true });
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Conferma importazione Piano' }).click();
    await expect(page.getByRole('alert')).toContainText('Sei offline');
    expect(requests).toHaveLength(1);
    expect((await storedPlan(page, 'guest'))!.states[date]?.revision).toBe(source.revision);
    await page.getByRole('button', { name: 'Conferma importazione Piano' }).click();
    await expect(page.getByText(/Importazione Piano completata/)).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((await storedPlan(page, 'guest'))!.states[date]).toBeUndefined();
  } finally { await Promise.all([account.close(), guest.close()]); }
});
