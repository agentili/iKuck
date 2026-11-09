import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';
import { isSousChefBuild } from './helpers/appMode';

test.skip(!isSousChefBuild, 'Piano disponibile solo nella build Sous-Chef');

test('il piano ospite propone ricette reali e conserva una sostituzione dopo il reload', async ({ page }) => {
  await installOfflineBackend(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const planResponse = await page.goto('/plan');
  expect(planResponse?.status()).toBe(200);
  const planHeading = page.getByRole('heading', { name: 'Piano settimanale', exact: true });
  await expect(planHeading).toBeVisible();

  const plan = page.getByRole('list', { name: 'Pasti da domani' });
  await expect(plan.getByRole('listitem')).toHaveCount(7);
  await expect(page.getByText(/salvato su questo dispositivo · non condiviso/i)).toBeVisible();

  const firstRow = plan.getByRole('listitem').first();
  const recipeTitle = firstRow.locator('div p').first();
  await expect(recipeTitle).toBeVisible();
  await expect(firstRow.getByRole('img', { name: 'Proposta automatica' })).toBeVisible();
  await expect(firstRow.getByText(/\d+\s+minuti/i)).toHaveCount(0);
  const originalTitle = await recipeTitle.textContent();
  const date = await firstRow.getAttribute('data-date');
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await firstRow.getByRole('button', { name: /modifica ricetta/i }).click();
  await expect(recipeTitle).not.toHaveText(originalTitle ?? '');
  const replacementTitle = await recipeTitle.textContent();
  expect(replacementTitle).not.toBeNull();

  await expect.poll(() => page.evaluate(async (planDate) => {
    const opened = indexedDB.open('ikuck-local-v2');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('keyValue', 'readonly')
        .objectStore('keyValue').get('ikuck:guest:meal-plan-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (typeof stored !== 'object' || stored === null || !('states' in stored)
      || typeof stored.states !== 'object' || stored.states === null) return false;
    const state = (stored.states as Record<string, unknown>)[planDate ?? ''];
    return typeof state === 'object' && state !== null && 'kind' in state && state.kind === 'manual';
  }, date)).toBe(true);

  await page.reload();
  const reloadedRow = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
  await expect(reloadedRow.locator('div p').first()).toHaveText(replacementTitle!);
  await expect(page.getByText(/salvato su questo dispositivo · non condiviso/i)).toBeVisible();
  assertOfflineBackendClean(page);
});

test('una ricevuta del Piano arrivata dopo il logout conserva la coda account già persistita', async ({ page }) => {
  let resolveCommandStarted!: (command: Record<string, unknown>) => void;
  const commandStarted = new Promise<Record<string, unknown>>((resolve) => { resolveCommandStarted = resolve; });
  let releaseCommandResponse!: () => void;
  const commandResponseGate = new Promise<void>((resolve) => { releaseCommandResponse = resolve; });
  let resolveCommandResponseDelivered!: () => void;
  const commandResponseDelivered = new Promise<void>((resolve) => { resolveCommandResponseDelivered = resolve; });
  const userId = 'browser-plan-user';
  const accountScope = `account:${userId}`;
  const revision = '123e4567-e89b-42d3-a456-426614174000';

  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: {
      authenticated: true,
      user: { id: userId, email: 'piano@example.test', emailVerifiedAt: '2026-10-01T00:00:00.000Z' },
      csrfToken: 'csrf-test-token',
      expiresAt: '2027-10-01T00:00:00.000Z',
    } },
    'GET /v1/profile': { json: { profile: { displayName: null } } },
    'GET /v1/house': { json: null },
    'GET /v1/meal-plan/capabilities': { json: { version: 2, syncReadVersion: 2 } },
    'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: '2026-10-01T00:00:00.000Z' }, selectedProvider: 'openai' } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
  } });
  await page.route('**/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { cursor?: number };
    await route.fulfill({ status: 200, json: { changes: [], nextCursor: body.cursor ?? 0 } });
  });
  await page.route('**/v1/meal-plan/read', async (route) => {
    const body = route.request().postDataJSON() as { dates: string[] };
    await route.fulfill({ status: 200, json: { version: 2, states: body.dates.map((date, index) => ({
      date,
      state: { date, revision, serverSequence: index + 1, kind: 'automatic', recipeId: 'seed-recipe' },
    })) } });
  });
  await page.route('**/v1/meal-plan/commands', async (route) => {
    const command = route.request().postDataJSON() as Record<string, unknown> & { date: string; operationId: string; recipeId: string };
    resolveCommandStarted(command);
    await commandResponseGate;
    await route.fulfill({ status: 200, json: {
      version: 2,
      operationId: command.operationId,
      outcome: 'applied',
      current: { date: command.date, revision: '223e4567-e89b-42d3-a456-426614174001', serverSequence: 9, kind: 'manual', recipeId: command.recipeId },
    } });
    resolveCommandResponseDelivered();
  });
  await page.route('**/v1/auth/logout', (route) => route.fulfill({ status: 204, body: '' }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/plan');
  const planHeading = page.getByRole('heading', { name: 'Piano settimanale', exact: true });
  await expect(planHeading).toBeVisible();

  const plan = page.getByRole('list', { name: 'Pasti da domani' });
  await expect(page.getByText('Sincronizzato con il tuo account', { exact: true })).toBeVisible();
  await expect(plan.getByRole('listitem')).toHaveCount(7);
  await plan.getByRole('listitem').first().getByRole('button', { name: /modifica ricetta/i }).click();
  const command = await commandStarted;
  expect(command).toMatchObject({ scope: accountScope, action: 'manual_set' });

  const hasPersistedCommand = async (): Promise<boolean> => page.evaluate(async (input) => {
    const request = indexedDB.open('ikuck-local-v2');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const query = database.transaction('syncQueue', 'readonly').objectStore('syncQueue').getAll();
      query.onsuccess = () => resolve(query.result as Array<Record<string, unknown>>);
      query.onerror = () => reject(query.error);
    });
    database.close();
    return records.some((record) => record.scope === input.scope
      && record.entityType === 'meal_plan_entry' && record.mutationId === input.operationId);
  }, { scope: accountScope, operationId: command.operationId });
  await expect.poll(hasPersistedCommand).toBe(true);

  await page.getByRole('button', { name: 'Profilo' }).click();
  await page.getByRole('button', { name: 'Esci' }).click();
  await expect(page.getByText(/Salvato su questo dispositivo · non condiviso/i)).toBeVisible();
  const guestPlan = page.getByRole('list', { name: 'Pasti da domani' });
  await expect(guestPlan.getByRole('listitem')).toHaveCount(7);
  const guestTitle = await guestPlan.getByRole('listitem').first().locator('div p').first().textContent();
  expect(guestTitle).not.toBeNull();

  releaseCommandResponse();
  await commandResponseDelivered;
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  await expect(guestPlan.getByRole('listitem').first().locator('div p').first()).toHaveText(guestTitle!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(hasPersistedCommand).toBe(true);
  assertOfflineBackendClean(page);
});

test('il Piano ospite si importa solo su conferma e si riprende dopo la riconnessione', async ({ page }) => {
  await installOfflineBackend(page, { responses: {
    'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: '2026-10-01T00:00:00.000Z' }, selectedProvider: 'openai' } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
  } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/plan');
  const planHeading = page.getByRole('heading', { name: 'Piano settimanale', exact: true });
  await expect(planHeading).toBeVisible();

  const firstRow = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
  const planDate = await firstRow.getAttribute('data-date');
  expect(planDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await firstRow.getByRole('button', { name: /modifica ricetta/i }).click();
  await expect.poll(() => page.evaluate(async (date) => {
    const request = indexedDB.open('ikuck-local-v2');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const query = database.transaction('keyValue', 'readonly').objectStore('keyValue').get('ikuck:guest:meal-plan-v2');
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    database.close();
    if (typeof stored !== 'object' || stored === null || !('states' in stored)
      || typeof stored.states !== 'object' || stored.states === null) return null;
    return (stored.states as Record<string, unknown>)[date ?? ''] ?? null;
  }, planDate)).toMatchObject({ date: planDate, kind: 'manual' });

  const guestState = await page.evaluate(async (date) => {
    const request = indexedDB.open('ikuck-local-v2');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const query = database.transaction('keyValue', 'readonly').objectStore('keyValue').get('ikuck:guest:meal-plan-v2');
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    database.close();
    if (typeof stored !== 'object' || stored === null || !('states' in stored)
      || typeof stored.states !== 'object' || stored.states === null) return null;
    return (stored.states as Record<string, unknown>)[date ?? ''] ?? null;
  }, planDate) as { date: string; revision: string; serverSequence: number; kind: 'manual' | 'automatic' | 'deleted'; recipeId: string | null } | null;
  expect(guestState).not.toBeNull();

  let authenticated = true;
  let online = false;
  const imports: Array<{ scope: string; items: Array<{ source: string; sourceId: string; localRevision: string; command: { operationId: string; date: string; action: string; recipeId?: string } }> }> = [];
  const importedStates = new Map<string, typeof guestState>();
  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: {
    authenticated,
    ...(authenticated ? { user: { id: 'user-1', email: 'ale@example.com', emailVerifiedAt: '2026-09-12T10:00:00.000Z' }, csrfToken: 'csrf-1', expiresAt: '2026-12-01T00:00:00.000Z' } : {}),
  } }));
  await page.route('**/v1/profile', (route) => route.fulfill({ status: 200, json: { profile: { displayName: null } } }));
  await page.route('**/v1/house', (route) => route.fulfill({ status: 200, json: null }));
  await page.route('**/v1/meal-plan/capabilities', (route) => online
    ? route.fulfill({ status: 200, json: { version: 2, syncReadVersion: 2 } })
    : route.abort('failed'));
  await page.route('**/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { cursor?: number };
    await route.fulfill({ status: 200, json: { changes: [], nextCursor: body.cursor ?? 0 } });
  });
  await page.route('**/v1/meal-plan/read', async (route) => {
    const body = route.request().postDataJSON() as { dates: string[] };
    const states = body.dates.map((date) => ({ date, state: importedStates.get(date) ?? null }));
    await route.fulfill({ status: 200, json: { version: 2, states } });
  });
  await page.route('**/v1/meal-plan/import', async (route) => {
    const body = route.request().postDataJSON() as typeof imports[number];
    imports.push(body);
    const results = body.items.map((item) => {
      const kind: 'deleted' | 'manual' | 'automatic' = item.command.action === 'manual_delete' ? 'deleted'
        : item.command.action === 'manual_set' ? 'manual' : 'automatic';
      const current = {
        date: item.sourceId,
        revision: '523e4567-e89b-42d3-a456-426614174004',
        serverSequence: 1,
        kind,
        recipeId: kind === 'deleted' ? null : item.command.recipeId ?? null,
      };
      importedStates.set(item.sourceId, current);
      return { sourceId: item.sourceId, localRevision: item.localRevision, result: {
        version: 2, operationId: item.command.operationId, outcome: 'applied', current,
      } };
    });
    await route.fulfill({ status: 200, json: { version: 2, results } });
  });

  authenticated = true;
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
  const openImport = page.getByRole('button', { name: 'Importa Piano ospite' });
  await expect(openImport).toBeVisible();
  expect(imports).toHaveLength(0);
  await openImport.click();
  await expect(page.getByRole('button', { name: 'Conferma importazione Piano' })).toBeVisible();
  expect(imports).toHaveLength(0);

  await page.getByRole('button', { name: 'Conferma importazione Piano' }).click();
  await expect(page.getByRole('alert')).toContainText('Sei offline');
  expect(imports).toHaveLength(0);
  await expect.poll(() => page.evaluate(async (date) => {
    const request = indexedDB.open('ikuck-local-v2');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const query = database.transaction('keyValue', 'readonly').objectStore('keyValue').get('ikuck:guest:meal-plan-v2');
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    database.close();
    if (typeof stored !== 'object' || stored === null || !('states' in stored)
      || typeof stored.states !== 'object' || stored.states === null) return null;
    return (stored.states as Record<string, unknown>)[date ?? ''] ?? null;
  }, planDate)).toMatchObject({ date: planDate, revision: guestState?.revision });

  online = true;
  await page.getByRole('button', { name: 'Conferma importazione Piano' }).click();
  await expect(page.getByText(/Importazione Piano completata/)).toBeVisible();
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({
    scope: 'account:user-1',
    items: expect.arrayContaining([expect.objectContaining({
      source: 'guest', sourceId: planDate, localRevision: guestState?.revision,
      command: expect.objectContaining({ scope: 'account:user-1', date: planDate }),
    })]),
  });
  await expect.poll(() => page.evaluate(async (date) => {
    const request = indexedDB.open('ikuck-local-v2');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const query = database.transaction('keyValue', 'readonly').objectStore('keyValue').get('ikuck:guest:meal-plan-v2');
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    database.close();
    if (typeof stored !== 'object' || stored === null || !('states' in stored)
      || typeof stored.states !== 'object' || stored.states === null) return false;
    return (stored.states as Record<string, unknown>)[date ?? ''] === undefined;
  }, planDate)).toBe(true);
  assertOfflineBackendClean(page);
});

test('rimuove il conflitto dal Piano solo dopo retry applicato e verificato dal server', async ({ page }) => {
  const userId = 'plan-conflict-user';
  const scope = `account:${userId}`;
  const states = new Map<string, { date: string; revision: string; serverSequence: number; kind: 'manual' | 'automatic'; recipeId: string }>();
  const commands: Array<{ operationId: string; date: string; recipeId: string }> = [];
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: {
      authenticated: true,
      user: { id: userId, email: 'plan-conflict@example.test', emailVerifiedAt: '2026-10-01T00:00:00.000Z' },
      csrfToken: 'csrf-plan-conflict',
      expiresAt: '2027-10-01T00:00:00.000Z',
    } },
    'GET /v1/profile': { json: { profile: { displayName: null } } },
    'GET /v1/house': { json: null },
    'GET /v1/meal-plan/capabilities': { json: { version: 2, syncReadVersion: 2 } },
    'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: '2026-10-01T00:00:00.000Z' }, selectedProvider: 'openai' } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
  } });
  await page.route('**/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { cursor?: number };
    await route.fulfill({ status: 200, json: { changes: [], nextCursor: body.cursor ?? 0 } });
  });
  await page.route('**/v1/meal-plan/read', async (route) => {
    const body = route.request().postDataJSON() as { dates: string[] };
    const result = body.dates.map((date, index) => {
      let current = states.get(date);
      if (current === undefined) {
        current = {
          date,
          revision: `123e4567-e89b-42d3-a456-${String(index + 1).padStart(12, '0')}`,
          serverSequence: index + 1,
          kind: 'automatic',
          recipeId: `seed-recipe-${index + 1}`,
        };
        states.set(date, current);
      }
      return { date, state: current };
    });
    await route.fulfill({ status: 200, json: { version: 2, states: result } });
  });
  await page.route('**/v1/meal-plan/commands', async (route) => {
    const command = route.request().postDataJSON() as { operationId: string; date: string; recipeId: string };
    commands.push(command);
    if (commands.length === 1) {
      await route.fulfill({ status: 200, json: {
        version: 2,
        operationId: command.operationId,
        outcome: 'conflict',
        current: states.get(command.date),
      } });
      return;
    }
    if (commands.length === 2) {
      await route.abort('failed');
      return;
    }
    const applied = {
      date: command.date,
      revision: '223e4567-e89b-42d3-a456-426614174009',
      serverSequence: 20,
      kind: 'manual' as const,
      recipeId: command.recipeId,
    };
    states.set(command.date, applied);
    await route.fulfill({ status: 200, json: {
      version: 2, operationId: command.operationId, outcome: 'applied', current: applied,
    } });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/plan');
  const planHeading = page.getByRole('heading', { name: 'Piano settimanale', exact: true });
  await expect(planHeading).toBeVisible();
  const plan = page.getByRole('list', { name: 'Pasti da domani' });
  await expect(plan.getByRole('listitem')).toHaveCount(7);
  await plan.getByRole('listitem').first().getByRole('button', { name: /modifica ricetta/i }).click();
  const conflictRegion = page.getByRole('region', { name: 'Modifiche in conflitto' });
  await expect(conflictRegion).toContainText('non è stata condivisa');
  await expect(page.getByRole('button', { name: 'Riproporre la scelta' })).toBeVisible();

  await page.getByRole('button', { name: 'Riproporre la scelta' }).click();
  await expect(page.getByRole('alert')).toHaveText('La scelta resta conservata sul dispositivo e non è stata confermata dal server.');
  await expect(conflictRegion).toContainText('non è stata condivisa');
  await expect(page.getByRole('button', { name: 'Riproporre la scelta' })).toBeVisible();
  expect(commands).toHaveLength(2);

  await page.getByRole('button', { name: 'Riproporre la scelta' }).click();
  await expect(conflictRegion).toHaveCount(0);
  await expect(page.getByText('Sincronizzato con il tuo account', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(3);
  expect(commands[1]).toMatchObject({ date: commands[0]?.date, recipeId: commands[0]?.recipeId });
  expect(commands[1]?.operationId).not.toBe(commands[0]?.operationId);
  expect(commands[2]).toEqual(commands[1]);

  const persisted = await page.evaluate(async (input) => {
    const request = indexedDB.open('ikuck-local-v2');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['keyValue', 'syncQueue'], 'readonly');
    const stored = await new Promise<unknown>((resolve, reject) => {
      const query = transaction.objectStore('keyValue').get(`ikuck:${input.scope}:meal-plan-v2`);
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    const queued = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const query = transaction.objectStore('syncQueue').getAll();
      query.onsuccess = () => resolve(query.result as Array<Record<string, unknown>>);
      query.onerror = () => reject(query.error);
    });
    database.close();
    return { stored, queued: queued.filter((entry) => entry.scope === input.scope && entry.entityType === 'meal_plan_entry') };
  }, { scope });
  expect(persisted.stored).toMatchObject({ conflicts: [], overlays: {} });
  expect(persisted.stored).toHaveProperty(['receipts', commands[1]?.operationId]);
  expect(persisted.queued).toEqual([]);

  await page.reload();
  await expect(conflictRegion).toHaveCount(0);
  await expect(page.getByText('Sincronizzato con il tuo account', { exact: true })).toBeVisible();
  assertOfflineBackendClean(page);
});
