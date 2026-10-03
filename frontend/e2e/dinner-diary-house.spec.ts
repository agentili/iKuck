import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

interface FixtureUser {
  id: string;
  email: string;
  emailVerifiedAt: string;
}

interface StoredChange {
  serverSequence: number;
  mutationId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: unknown;
  clientUpdatedAt: string;
  syncScope: string;
}

const houseId = 'dinner-diary-house-e2e';
const houseScope = `house:${houseId}`;
const admin: FixtureUser = { id: 'diary-house-admin', email: 'admin@example.com', emailVerifiedAt: '2026-09-24T10:00:00.000Z' };
const member: FixtureUser = { id: 'diary-house-member', email: 'member@example.com', emailVerifiedAt: '2026-09-24T10:01:00.000Z' };
const outsider: FixtureUser = { id: 'diary-house-outsider', email: 'outsider@example.com', emailVerifiedAt: '2026-09-24T10:02:00.000Z' };
const dinnerText = 'Pasta condivisa dopo la cena di famiglia.';
const privateText = 'Cena privata offline dell’estraneo.';
const memberDinnerText = 'Cena del membro con la ricetta condivisa.';
const recipeTitle = 'Pasta condivisa dalla Casa';

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('shares confirmed dinner recipes with House members while isolating outsiders, offline records and account changes', async ({ page }) => {
  let currentUser: FixtureUser | null = admin;
  let memberAdded = false;
  let apiUnavailable = false;
  let nextSequence = 0;
  const consentByUser = new Map<string, boolean>();
  const homeConsentByUser = new Map<string, 'openai' | 'gemini'>();
  const dinnerConsentByUser = new Map<string, 'openai' | 'gemini'>();
  const houseChanges: StoredChange[] = [];
  const accountChanges = new Map<string, StoredChange[]>();
  const syncCalls: Array<{
    userId: string | null;
    scope: string;
    csrfAuthorized: boolean;
    mutations: Array<Record<string, unknown>>;
    returnedEntityIds: string[];
    unavailable: boolean;
  }> = [];
  let sharedDinnerId: string | null = null;
  let memberDinnerId: string | null = null;
  const savedRecipeId = 'confirmed-house-recipe';
  const draft = {
    draftId: 'house-draft-1',
    title: 'Pasta semplice della casa',
    description: 'La pasta annotata dopo la cena.',
    ingredients: [{ name: 'pasta', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' as const }],
    steps: ['Cuoci la pasta e condiscila.'],
    servings: 2,
    durationMinutes: 15,
    diets: null,
    allergens: null,
    suggestedFields: ['title', 'description', 'ingredients', 'amounts', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens'],
  };

  const isMember = (userId: string): boolean => userId === admin.id || (userId === member.id && memberAdded);
  const houseState = (userId: string) => ({
    house: { id: houseId, name: 'Casa Diario', createdAt: '2026-09-24T10:00:00.000Z' },
    membership: { role: userId === admin.id ? 'admin' : 'member', joinedAt: '2026-09-24T10:00:00.000Z' },
    members: [
      { userId: admin.id, email: admin.email, displayName: 'Admin', role: 'admin', joinedAt: '2026-09-24T10:00:00.000Z' },
      ...(memberAdded ? [{ userId: member.id, email: member.email, displayName: 'Member', role: 'member', joinedAt: '2026-09-24T10:01:00.000Z' }] : []),
    ],
  });
  const appendChange = (userId: string, mutation: Record<string, unknown>, scope: string): StoredChange => {
    const change: StoredChange = {
      serverSequence: ++nextSequence,
      mutationId: String(mutation.mutationId ?? `fixture-${nextSequence}`),
      deviceId: String(mutation.deviceId ?? userId),
      entityType: String(mutation.entityType),
      entityId: String(mutation.entityId),
      operation: String(mutation.operation),
      payload: mutation.payload ?? null,
      clientUpdatedAt: String(mutation.clientUpdatedAt ?? new Date().toISOString()),
      syncScope: scope,
    };
    if (scope === houseScope) {
      houseChanges.push(change);
      if (change.entityType === 'dinner_entry' && typeof change.payload === 'object' && change.payload !== null
        && 'text' in change.payload && change.payload.text === dinnerText) sharedDinnerId = change.entityId;
      if (change.entityType === 'dinner_entry' && typeof change.payload === 'object' && change.payload !== null
        && 'text' in change.payload && change.payload.text === memberDinnerText) memberDinnerId = change.entityId;
    } else {
      accountChanges.set(userId, [...(accountChanges.get(userId) ?? []), change]);
    }
    return change;
  };
  appendChange(admin.id, {
    mutationId: 'seed-house-pasta',
    deviceId: 'fixture-house',
    entityType: 'pantry_lot',
    entityId: 'house-pasta-lot',
    operation: 'upsert',
    payload: {
      id: 'house-pasta-lot', ingredientId: 'pasta', label: 'Pasta', known: true,
      quantity: null, unit: null, expiresAt: null,
      createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z',
    },
    clientUpdatedAt: '2026-09-24T10:00:00.000Z',
  }, houseScope);

  await page.route('**/v1/auth/session', async (route) => {
    if (currentUser === null) {
      await route.fulfill({ status: 200, json: { authenticated: false } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: { authenticated: true, user: currentUser, csrfToken: `csrf-${currentUser.id}`, expiresAt: '2026-10-24T10:00:00.000Z' },
    });
  });
  await page.route('**/v1/profile', (route) => route.fulfill({ status: 200, json: { profile: { displayName: null } } }));
  await page.route('**/v1/ai-recipes', (route) => route.fulfill({ status: 200, json: { recipes: [] } }));
  await page.route('**/v1/ai-recipes/consent', async (route) => {
    const userId = currentUser?.id ?? 'guest';
    if (route.request().method() === 'GET') {
      const homeProvider = homeConsentByUser.get(userId);
      const dinnerProvider = dinnerConsentByUser.get(userId);
      await route.fulfill({ status: 200, json: {
        consent: { enabled: consentByUser.get(userId) ?? false, updatedAt: '2026-09-24T10:00:00.000Z', ...(homeProvider === undefined ? {} : { homeProvider }), ...(dinnerProvider === undefined ? {} : { dinnerProvider }) },
        selectedProvider: 'openai',
      } });
      return;
    }
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { enabled?: boolean; homeProvider?: 'openai' | 'gemini'; dinnerProvider?: 'openai' | 'gemini' | null; expectedRevision?: string };
      expect(body.expectedRevision).toBeDefined();
      if (body.enabled !== undefined) {
        if (body.enabled) expect(body.homeProvider).toBe('openai');
        consentByUser.set(userId, body.enabled);
        if (!body.enabled) {
          homeConsentByUser.delete(userId);
          dinnerConsentByUser.delete(userId);
        }
      }
      if (body.homeProvider !== undefined) homeConsentByUser.set(userId, body.homeProvider);
      if (body.dinnerProvider === null) dinnerConsentByUser.delete(userId);
      else if (body.dinnerProvider !== undefined) {
        expect(body.dinnerProvider).toBe('openai');
        dinnerConsentByUser.set(userId, body.dinnerProvider);
      }
      const homeProvider = homeConsentByUser.get(userId);
      const dinnerProvider = dinnerConsentByUser.get(userId);
      await route.fulfill({ status: 200, json: {
        consent: { enabled: consentByUser.get(userId) ?? false, updatedAt: '2026-09-24T10:01:00.000Z', ...(homeProvider === undefined ? {} : { homeProvider }), ...(dinnerProvider === undefined ? {} : { dinnerProvider }) },
        selectedProvider: 'openai',
      } });
      return;
    }
    await route.fallback();
  });
  await page.route('**/v1/ai-dinner-reconstruction', async (route) => {
    if (currentUser?.id !== admin.id || consentByUser.get(admin.id) !== true
      || homeConsentByUser.get(admin.id) !== 'openai' || dinnerConsentByUser.get(admin.id) !== 'openai') {
      await route.fulfill({ status: 403, json: { code: 'ai_consent_required', message: 'AI consent is required' } });
      return;
    }
    await route.fulfill({ status: 200, json: { drafts: [draft] } });
  });
  await page.route('**/v1/dinner-entries/*/confirm-recipe', async (route) => {
    if (currentUser?.id !== admin.id) {
      await route.fulfill({ status: 403, json: { code: 'sync_permission_denied', message: 'Not permitted' } });
      return;
    }
    const entryId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    const current = [...houseChanges].reverse().find((change) => change.entityType === 'dinner_entry' && change.entityId === entryId);
    if (!current || typeof current.payload !== 'object' || current.payload === null) {
      await route.fulfill({ status: 404, json: { code: 'dinner_entry_not_found', message: 'Dinner entry was not found' } });
      return;
    }
    const body = route.request().postDataJSON() as { draft: typeof draft };
    const savedRecipe = {
      id: savedRecipeId,
      title: body.draft.title,
      description: body.draft.description,
      ingredients: body.draft.ingredients,
      steps: body.draft.steps,
      servings: body.draft.servings,
      durationMinutes: body.draft.durationMinutes,
      diets: body.draft.diets,
      allergens: body.draft.allergens,
      suggestedFields: body.draft.suggestedFields,
      source: 'diary' as const,
      authorId: admin.id,
      createdAt: '2026-09-24T10:02:00.000Z',
      updatedAt: '2026-09-24T10:02:00.000Z',
    };
    const entryPayload = current.payload as Record<string, unknown>;
    const updatedEntry = {
      ...entryPayload,
      updatedAt: '2026-09-24T10:02:00.000Z',
      recipes: [{ recipeId: savedRecipe.id, title: savedRecipe.title, source: 'diary' as const }],
    };
    appendChange(admin.id, {
      mutationId: 'confirm-entry-revision', deviceId: 'diary-confirmation-api', entityType: 'dinner_entry',
      entityId: entryId, operation: 'upsert', payload: updatedEntry, clientUpdatedAt: updatedEntry.updatedAt,
    }, houseScope);
    appendChange(admin.id, {
      mutationId: 'confirm-saved-recipe', deviceId: 'diary-confirmation-api', entityType: 'saved_recipe',
      entityId: savedRecipe.id, operation: 'upsert', payload: savedRecipe, clientUpdatedAt: savedRecipe.updatedAt,
    }, houseScope);
    await route.fulfill({ status: 200, json: { entry: updatedEntry, recipe: savedRecipe } });
  });
  await page.route('**/v1/dinner-entries/*/link-recipe', async (route) => {
    const userId = currentUser?.id;
    const entryId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    const current = [...houseChanges].reverse().find((change) => change.entityType === 'dinner_entry'
      && change.entityId === entryId && change.operation === 'upsert');
    const body = route.request().postDataJSON() as { recipeId: string; source: 'diary' };
    const recipeChange = [...houseChanges].reverse().find((change) => change.entityType === 'saved_recipe'
      && change.entityId === body.recipeId && change.operation === 'upsert');
    if (userId === undefined || !isMember(userId) || current === undefined || recipeChange === undefined
      || typeof current.payload !== 'object' || current.payload === null
      || typeof recipeChange.payload !== 'object' || recipeChange.payload === null) {
      await route.fulfill({ status: 403, json: { code: 'sync_permission_denied', message: 'Not permitted' } });
      return;
    }
    const entryPayload = current.payload as Record<string, unknown>;
    const existingLinks = Array.isArray(entryPayload.recipes) ? entryPayload.recipes as Array<Record<string, unknown>> : [];
    const recipePayload = recipeChange.payload as Record<string, unknown>;
    const updatedEntry = {
      ...entryPayload,
      updatedAt: '2026-09-24T10:04:00.000Z',
      recipes: existingLinks.some((link) => link.recipeId === body.recipeId) ? existingLinks : [
        ...existingLinks,
        { recipeId: body.recipeId, title: recipePayload.title, source: body.source },
      ],
    };
    appendChange(userId, {
      mutationId: 'link-member-existing-house-recipe', deviceId: 'diary-link-api', entityType: 'dinner_entry',
      entityId: entryId, operation: 'upsert', payload: updatedEntry, clientUpdatedAt: updatedEntry.updatedAt,
    }, houseScope);
    await route.fulfill({ status: 200, json: { entry: updatedEntry } });
  });
  await page.route('**/v1/house', async (route) => {
    if (route.request().method() === 'GET') {
      const state = currentUser !== null && isMember(currentUser.id) ? houseState(currentUser.id) : null;
      await route.fulfill({ status: 200, json: state });
      return;
    }
    await route.fulfill({ status: 200, json: houseState(currentUser?.id ?? admin.id) });
  });
  await page.route('**/v1/house/members', async (route) => {
    if (currentUser?.id !== admin.id) {
      await route.fulfill({ status: 403, json: { code: 'house_admin_required', message: 'House admin permission is required' } });
      return;
    }
    memberAdded = true;
    await route.fulfill({ status: 200, json: { member: houseState(admin.id).members[1] } });
  });
  await page.route('**/v1/house/pantry/merge', (route) => route.fulfill({
    status: 200,
    json: { summary: { addedLots: 0, mergedLots: 0, mergedGroups: 0, importedStaples: 0 } },
  }));
  await page.route('**/v1/auth/logout', async (route) => {
    currentUser = null;
    await route.fulfill({ status: 200, json: {} });
  });
  await page.route('**/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { cursor?: number; syncScope?: string; mutations?: Array<Record<string, unknown>> };
    const userId = currentUser?.id ?? null;
    const csrfAuthorized = currentUser !== null
      && route.request().headers()['x-csrf-token'] === `csrf-${currentUser.id}`;
    const requestedScope = body.syncScope ?? (userId === null ? 'guest' : `account:${userId}`);
    const mutations = body.mutations ?? [];
    if (apiUnavailable) {
      syncCalls.push({ userId, scope: requestedScope, csrfAuthorized, mutations, returnedEntityIds: [], unavailable: true });
      await route.abort('failed');
      return;
    }
    if (!csrfAuthorized) {
      syncCalls.push({ userId, scope: requestedScope, csrfAuthorized, mutations, returnedEntityIds: [], unavailable: false });
      await route.fulfill({ status: 403, json: { code: 'csrf_invalid', message: 'CSRF token is invalid' } });
      return;
    }
    for (const mutation of mutations) {
      const entityType = String(mutation.entityType);
      if (!['dinner_entry', 'saved_recipe', 'pantry_item', 'pantry_lot', 'staple_preference'].includes(entityType)) continue;
      const scope = String(mutation.syncScope ?? (userId === null ? 'guest' : `account:${userId}`));
      if (scope === houseScope && userId !== null && isMember(userId)) appendChange(userId, mutation, houseScope);
      else if (userId !== null && scope === `account:${userId}`) appendChange(userId, mutation, scope);
    }
    const cursor = body.cursor ?? 0;
    const isVisible = (change: StoredChange): boolean => userId !== null && (
      (requestedScope === houseScope && isMember(userId) && change.syncScope === houseScope)
      || change.syncScope === `account:${userId}`
    );
    const available = [...houseChanges, ...(userId === null ? [] : accountChanges.get(userId) ?? [])]
      .filter(isVisible)
      .filter((change) => change.serverSequence > cursor)
      .sort((left, right) => left.serverSequence - right.serverSequence);
    syncCalls.push({ userId, scope: requestedScope, csrfAuthorized, mutations, returnedEntityIds: available.map((change) => change.entityId), unavailable: false });
    await route.fulfill({ status: 200, json: { changes: available, nextCursor: Math.max(cursor, nextSequence) } });
  });

  await page.goto('/house');
  await expect(page.getByRole('heading', { name: 'Casa Diario' })).toBeVisible();
  await page.getByLabel('Email della persona').fill(member.email);
  await page.getByRole('button', { name: 'Aggiungi persona' }).click();
  await expect(page.getByText('Persona aggiunta alla casa.')).toBeVisible();

  await page.goto('/pantry');
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

  await page.goto('/dinner-diary');
  await expect(page.getByRole('heading', { name: 'Diario delle cene' })).toBeVisible();
  const globalConsent = page.getByRole('checkbox', { name: /OpenAI.*ingredienti della dispensa.*profilo alimentare/i });
  await globalConsent.check();
  await page.getByRole('button', { name: 'Salva consenso AI globale' }).click();
  const dinnerConsent = page.getByRole('checkbox', { name: 'Acconsento all’invio a OpenAI del testo della cena e delle porzioni' });
  await dinnerConsent.check();
  await page.getByRole('button', { name: 'Salva consenso Dinner' }).click();
  await page.getByLabel('Data della cena').fill('2026-09-24');
  await page.getByLabel('Porzioni (facoltative)').fill('2');
  await page.getByLabel('Com’è andata la cena?').fill(dinnerText);
  await page.getByRole('button', { name: 'Salva cena' }).click();
  await expect(page.getByText(dinnerText)).toBeVisible();
  await page.reload();
  await expect.poll(() => sharedDinnerId).not.toBeNull();
  await page.getByRole('button', { name: 'Prepara bozze ricetta' }).click();
  await expect(page.getByText('Bozza 1 — non ancora salvata come ricetta')).toBeVisible();
  await page.getByRole('textbox', { name: 'Titolo ricetta' }).fill(recipeTitle);
  await page.getByRole('button', { name: 'Conferma questa ricetta' }).click();
  await expect(page.getByText('1 ricetta collegata')).toBeVisible();
  await expect(page.getByRole('button', { name: /Modifica cena del/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Elimina cena del/ })).toBeVisible();
  expect(houseChanges.some((change) => change.entityType === 'saved_recipe' && change.entityId === savedRecipeId)).toBe(true);

  currentUser = outsider;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Diario delle cene' })).toBeVisible();
  await expect(page.getByText('Non hai ancora registrato una cena.')).toBeVisible();
  await expect.poll(() => syncCalls.some((call) => call.userId === outsider.id && !call.unavailable)).toBe(true);
  expect(syncCalls.filter((call) => call.userId === outsider.id).flatMap((call) => call.returnedEntityIds)).not.toContain(sharedDinnerId);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Aggiungi prima gli ingredienti' })).toBeVisible();
  await expect(page.getByText(recipeTitle)).toHaveCount(0);

  await page.goto('/dinner-diary');
  await page.context().setOffline(true);
  await page.getByLabel('Data della cena').fill('2026-09-25');
  await page.getByLabel('Com’è andata la cena?').fill(privateText);
  await page.getByRole('button', { name: 'Salva cena' }).click();
  await expect(page.getByText(privateText)).toBeVisible();
  await page.waitForFunction(async (text) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ikuck-local-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction('syncQueue', 'readonly').objectStore('syncQueue').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return values.some((value) => typeof value === 'object' && value !== null
      && 'scope' in value && value.scope === 'account:diary-house-outsider'
      && 'entityType' in value && value.entityType === 'dinner_entry'
      && 'payload' in value && typeof value.payload === 'object' && value.payload !== null
      && 'text' in value.payload && value.payload.text === text);
  }, privateText);
  apiUnavailable = true;
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => syncCalls.some((call) => call.userId === outsider.id && call.unavailable
    && call.mutations.some((mutation) => mutation.entityType === 'dinner_entry'
      && typeof mutation.payload === 'object' && mutation.payload !== null && 'text' in mutation.payload && mutation.payload.text === privateText))).toBe(true);

  currentUser = member;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Diario delle cene' })).toBeVisible();
  apiUnavailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => syncCalls.some((call) => call.userId === member.id && !call.unavailable
    && call.returnedEntityIds.includes(savedRecipeId))).toBe(true);
  await expect(page.getByText(dinnerText)).toBeVisible();
  await expect(page.getByText(recipeTitle)).toBeVisible();
  await expect(page.getByText('Condivisa con la Casa')).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: dinnerText })
    .getByRole('button', { name: /Modifica cena del/ })).toHaveCount(1);
  await expect(page.getByRole('article').filter({ hasText: dinnerText })
    .getByRole('button', { name: /Elimina cena del/ })).toHaveCount(1);
  expect(syncCalls.filter((call) => call.userId === member.id && call.csrfAuthorized).flatMap((call) => call.mutations)
    .some((mutation) => typeof mutation.payload === 'object' && mutation.payload !== null
      && 'text' in mutation.payload && mutation.payload.text === privateText)).toBe(false);

  await page.getByRole('article').filter({ hasText: dinnerText })
    .getByRole('button', { name: /Modifica cena del/ }).click();
  await page.getByLabel('Nota (facoltativa)').fill('Nota della casa');
  await page.getByRole('button', { name: 'Salva modifiche' }).click();
  await page.waitForFunction(async (scope) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ikuck-local-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction('syncQueue', 'readonly').objectStore('syncQueue').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return values.some((value) => typeof value === 'object' && value !== null
      && 'scope' in value && value.scope === scope
      && 'entityType' in value && value.entityType === 'dinner_entry'
      && 'payload' in value && typeof value.payload === 'object' && value.payload !== null
      && 'note' in value.payload && value.payload.note === 'Nota della casa');
  }, houseScope);
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => houseChanges.some((change) => change.entityType === 'dinner_entry'
    && change.entityId === sharedDinnerId && change.operation === 'upsert'
    && typeof change.payload === 'object' && change.payload !== null
    && 'note' in change.payload && change.payload.note === 'Nota della casa'
    && 'authorId' in change.payload && change.payload.authorId === admin.id)).toBe(true);
  await expect(page.getByRole('article').filter({ hasText: dinnerText }).getByText('Nota: Nota della casa')).toBeVisible();

  await page.getByLabel('Data della cena').fill('2026-09-26');
  await page.getByLabel('Com’è andata la cena?').fill(memberDinnerText);
  await page.getByRole('button', { name: 'Salva cena' }).click();
  await expect(page.getByText(memberDinnerText)).toBeVisible();
  await page.reload();
  await expect.poll(() => memberDinnerId).not.toBeNull();
  await page.getByLabel('Collega una ricetta già salvata').selectOption(savedRecipeId);
  await page.getByRole('button', { name: 'Collega ricetta' }).click();
  await expect.poll(() => houseChanges.some((change) => change.entityId === memberDinnerId
    && change.entityType === 'dinner_entry' && typeof change.payload === 'object' && change.payload !== null
    && 'recipes' in change.payload && Array.isArray(change.payload.recipes)
    && change.payload.recipes.some((link) => typeof link === 'object' && link !== null
      && 'recipeId' in link && link.recipeId === savedRecipeId))).toBe(true);
  await expect(page.getByRole('article').filter({ hasText: memberDinnerText })
    .getByRole('button', { name: /Modifica cena del/ })).toHaveCount(1);
  await expect(page.getByRole('article').filter({ hasText: dinnerText })
    .getByRole('button', { name: /Modifica cena del/ })).toHaveCount(1);
  await expect(page.getByLabel('Collega una ricetta già salvata')).toHaveCount(0);

  await page.goto('/pantry');
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByRole('article', { name: recipeTitle })).toHaveAttribute('data-availability', 'ready');
  await page.getByRole('link', { name: `Apri ${recipeTitle}` }).click();
  await expect(page.getByRole('heading', { name: recipeTitle })).toBeVisible();

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Esci' }).click();
  await page.goto('/dinner-diary');
  await expect(page.getByText('Non hai ancora registrato una cena.')).toBeVisible();
  await expect(page.getByText(dinnerText)).toHaveCount(0);
  await expect(page.getByText(privateText)).toHaveCount(0);

  currentUser = outsider;
  await page.reload();
  await expect(page.getByText(privateText)).toBeVisible();
  await expect(page.getByText(dinnerText)).toHaveCount(0);
});
