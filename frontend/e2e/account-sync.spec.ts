import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const verifiedUser = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

const clearLocalDatabase = async (page: Page) => {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('ikuck-local-v2');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  }));
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: '2026-09-14T00:00:00.000Z' } } },
      'GET /v1/ai-recipes': { json: { recipes: [] } },
    },
  });
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('guest pantry survives reload while the API is offline', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) => route.fulfill({
    status: 200,
    json: { authenticated: false },
  }));
  await page.goto('/pantry');
  await clearLocalDatabase(page);
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

  await page.unroute('**/v1/auth/session');
  await page.route('**/v1/auth/session', (route) => route.abort());
  await page.reload();
  await expect(page.getByText('Tonno', { exact: true })).toBeVisible();
});

test('verified users explicitly import the local pantry into the account', async ({ page }) => {
  const syncRequests: Array<{ mutations: unknown[] }> = [];
  await page.route('**/v1/auth/session', (route) => route.fulfill({
    status: 200,
    json: {
      authenticated: true,
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    },
  }));
  await page.route('**/v1/profile', (route) => route.fulfill({
    status: 200,
    json: { profile: { displayName: null } },
  }));
  await page.route('**/v1/house', (route) => route.fulfill({ status: 200, json: null }));
  await page.route('**/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { mutations: unknown[] };
    syncRequests.push(body);
    await route.fulfill({ status: 200, json: { changes: [], nextCursor: 1 } });
  });

  await page.goto('/pantry');
  await clearLocalDatabase(page);
  await page.reload();
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('link', { name: 'Profilo' }).click();
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();

  await page.getByRole('button', { name: 'Importa i dati locali' }).click();
  await page.getByRole('button', { name: 'Conferma importazione' }).click();
  await expect(page.getByText(/Sincronizzazione completata/)).toBeVisible();
  expect(syncRequests.some(({ mutations }) => mutations.some((mutation) => (
    typeof mutation === 'object' && mutation !== null && 'entityId' in mutation && mutation.entityId === 'pasta'
  )))).toBe(true);
});

test('two verified accounts share the house pantry while member authorization stays isolated', async ({ browser, page }) => {
  let houseCreated = true;
  let memberAdded = false;
  let bVerified = false;
  let nextServerSequence = 1;
  const sharedChanges: Array<{ serverSequence: number; deviceId: string; syncScope: string; entityType: string; entityId: string; operation: string; payload: unknown }> = [{
    serverSequence: nextServerSequence,
    deviceId: 'house-pantry-merge',
    syncScope: 'house:house-e2e',
    entityType: 'pantry_item',
    entityId: 'admin-rice',
    operation: 'upsert',
    payload: { id: 'admin-rice', label: 'Riso', known: true },
  }];
  const syncResponses: Array<{ userId: string; changes: typeof sharedChanges }> = [];
  const mergeMarkers = new Set<string>();
  const mergeRequests: Array<{ userId: string; lots: unknown[]; stapleIds: string[] }> = [];
  const admin = { id: 'e2e-admin', email: 'admin@example.com', emailVerifiedAt: '2026-09-24T10:00:00.000Z' };
  const member = { id: 'e2e-member', email: 'member@example.com', emailVerifiedAt: '2026-09-24T10:01:00.000Z' };
  const houseState = (userId: string) => ({
    house: { id: 'house-e2e', name: 'Casa E2E', createdAt: '2026-09-24T10:00:00.000Z' },
    membership: { role: userId === admin.id ? 'admin' : 'member', joinedAt: '2026-09-24T10:00:00.000Z' },
    members: [
      { userId: admin.id, email: admin.email, displayName: 'Admin', role: 'admin', joinedAt: '2026-09-24T10:00:00.000Z' },
      ...(memberAdded ? [{ userId: member.id, email: member.email, displayName: 'Member', role: 'member', joinedAt: '2026-09-24T10:01:00.000Z' }] : []),
    ],
  });

  const configureApi = async (target: Page, user: typeof admin, isVerified: () => boolean): Promise<void> => {
    await installOfflineBackend(target);
    await target.route('**/v1/auth/session', async (route) => {
      if (!isVerified()) {
        await route.fulfill({ status: 200, json: { authenticated: false } });
        return;
      }
      await route.fulfill({
        status: 200,
        json: { authenticated: true, user, csrfToken: `csrf-${user.id}`, expiresAt: '2026-10-24T10:00:00.000Z' },
      });
    });
    await target.route('**/v1/profile', (route) => route.fulfill({ status: 200, json: { profile: { displayName: null } } }));
    await target.route('**/v1/ai-recipes/consent', (route) => route.fulfill({ status: 200, json: { consent: { enabled: false, updatedAt: '2026-09-24T00:00:00.000Z' } } }));
    await target.route('**/v1/ai-recipes', (route) => route.fulfill({ status: 200, json: { recipes: [] } }));
    await target.route('**/v1/sync', async (route) => {
      const body = route.request().postDataJSON() as { cursor?: number; mutations?: Array<Record<string, unknown>> };
      const cursor = body.cursor ?? 0;
      for (const mutation of body.mutations ?? []) {
        if (mutation.entityType !== 'pantry_item' && mutation.entityType !== 'pantry_lot' && mutation.entityType !== 'staple_preference') continue;
        sharedChanges.push({
          serverSequence: ++nextServerSequence,
          deviceId: String(mutation.deviceId ?? user.id),
          syncScope: String(mutation.syncScope ?? `house:house-e2e`),
          entityType: String(mutation.entityType),
          entityId: String(mutation.entityId),
          operation: String(mutation.operation),
          payload: mutation.payload ?? null,
        });
      }
      const changes = sharedChanges.filter((change) => change.serverSequence > cursor);
      syncResponses.push({ userId: user.id, changes });
      await route.fulfill({ status: 200, json: { changes, nextCursor: nextServerSequence } });
    });
    await target.route('**/v1/house', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, json: houseCreated ? houseState(user.id) : null });
        return;
      }
      houseCreated = true;
      await route.fulfill({ status: 200, json: houseState(user.id) });
    });
    await target.route('**/v1/house/members', async (route) => {
      if (user.id !== admin.id) {
        await route.fulfill({ status: 403, json: { code: 'house_admin_required', message: 'House admin permission is required' } });
        return;
      }
      memberAdded = true;
      await route.fulfill({ status: 200, json: { member: houseState(member.id).members[1] } });
    });
    await target.route('**/v1/house/pantry/merge', async (route) => {
      const body = route.request().postDataJSON() as { deviceId?: string; lots?: Array<Record<string, unknown>>; stapleIds?: string[] };
      mergeRequests.push({ userId: user.id, lots: body.lots ?? [], stapleIds: body.stapleIds ?? [] });
      const marker = `${user.id}:${body.deviceId ?? 'unknown'}`;
      if (!mergeMarkers.has(marker)) {
        mergeMarkers.add(marker);
        for (const lot of body.lots ?? []) {
          sharedChanges.push({
            serverSequence: ++nextServerSequence,
            deviceId: 'house-pantry-merge',
            syncScope: 'house:house-e2e',
            entityType: 'pantry_lot', entityId: String(lot.id), operation: 'upsert', payload: lot });
        }
        for (const stapleId of body.stapleIds ?? []) {
          sharedChanges.push({
            serverSequence: ++nextServerSequence,
            deviceId: 'house-pantry-merge',
            syncScope: 'house:house-e2e',
            entityType: 'staple_preference', entityId: stapleId, operation: 'upsert', payload: { enabled: true },
          });
        }
      }
      await route.fulfill({ status: 200, json: { summary: { addedLots: 1, mergedLots: 1, mergedGroups: 1, importedStaples: 1 } } });
    });
    await target.route('**/v1/house/import-personal-data', (route) => route.fulfill({ status: 200, json: {} }));
  };

  await configureApi(page, admin, () => true);
  await page.goto('/house');
  await expect(page.getByRole('heading', { name: 'Casa E2E' })).toBeVisible();
  await page.getByLabel('Email della persona').fill(member.email);
  await page.getByRole('button', { name: 'Aggiungi persona' }).click();
  await expect(page.getByText('Persona aggiunta alla casa.')).toBeVisible();

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await configureApi(memberPage, member, () => bVerified);
  await memberPage.goto('/pantry');
  await clearLocalDatabase(memberPage);
  await memberPage.reload();
  await memberPage.getByLabel('Ingredienti presenti').fill('pasta');
  await memberPage.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(memberPage.getByText('Pasta', { exact: true })).toBeVisible();

  bVerified = true;
  await memberPage.reload();
  await expect.poll(() => mergeRequests.filter((request) => request.userId === member.id).length).toBeGreaterThanOrEqual(1);
  const memberMerges = mergeRequests.filter((request) => request.userId === member.id);
  expect(memberMerges.filter((request) => request.lots.length > 0)).toHaveLength(1);
  const memberMerge = memberMerges.find((request) => request.lots.length > 0);
  expect(memberMerge?.lots).toEqual(expect.arrayContaining([expect.objectContaining({ ingredientId: 'pasta' })]));
  expect(memberMerge?.stapleIds).toEqual(expect.arrayContaining(['salt', 'black_pepper', 'olive_oil']));
  await expect.poll(() => syncResponses.some((response) => response.userId === member.id
    && response.changes.some((change) => change.entityId === 'admin-rice'))).toBe(true);
  await memberPage.goto('/pantry');
  await expect(memberPage.getByText('Riso', { exact: true })).toBeVisible();
  const unauthorizedMemberAction = await memberPage.evaluate(async () => (await fetch('/v1/house/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'other@example.com' }),
  })).status);
  expect(unauthorizedMemberAction).toBe(403);

  await memberPage.goto('/house');
  await expect(memberPage.getByRole('heading', { name: 'Casa E2E' })).toBeVisible();
  await expect(memberPage.getByText('Il tuo ruolo: member')).toBeVisible();
  await expect(memberPage.getByRole('heading', { name: 'Aggiungi persona' })).toHaveCount(0);

  assertOfflineBackendClean(memberPage);
  await memberContext.close();
});

test('unverified login remains blocked with clear guidance', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) => route.fulfill({
    status: 200,
    json: { authenticated: false },
  }));
  await page.route('**/v1/auth/login', (route) => route.fulfill({
    status: 403,
    json: { code: 'email_not_verified', message: 'Email verification is required' },
  }));

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Accedi o registrati' }).click();
  await page.getByLabel('Email').fill('ale@example.com');
  await page.getByLabel('Password').fill('a long enough password');
  await page.getByRole('button', { name: 'Accedi al profilo' }).click();

  await expect(page.getByText('Devi verificare la tua email prima di accedere.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accedi al tuo profilo' })).toBeVisible();
});
