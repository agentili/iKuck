import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const clearLocalDatabase = async (page: Page): Promise<void> => {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('ikuck-local-v2');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  }));
};

const readGuestState = async (page: Page) => page.evaluate(async () => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ikuck-local-v2');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const readValue = (key: string): Promise<unknown> => new Promise((resolve, reject) => {
    const request = database.transaction('keyValue', 'readonly').objectStore('keyValue').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const pantryRequest = await readValue('pantry');
  const dinnersRequest = await readValue('ikuck:guest:dinner-entries');
  const consumptionRequest = database.transaction('dinnerConsumption', 'readonly')
    .objectStore('dinnerConsumption').getAll();
  const records = await new Promise<unknown[]>((resolve, reject) => {
    consumptionRequest.onsuccess = () => resolve(consumptionRequest.result as unknown[]);
    consumptionRequest.onerror = () => reject(consumptionRequest.error);
  });
  database.close();
  const pantryState = typeof pantryRequest === 'string' ? JSON.parse(pantryRequest) as { state?: unknown } : null;
  const dinnerState = typeof dinnersRequest === 'string' ? JSON.parse(dinnersRequest) as { items?: unknown[] } : null;
  return {
    pantry: pantryState?.state ?? null,
    dinners: dinnerState?.items ?? [],
    outbox: records.filter((record): record is { operationId: string; scope: string; status: string; receipt: unknown } => (
      typeof record === 'object' && record !== null
      && 'operationId' in record && typeof record.operationId === 'string'
      && 'scope' in record && typeof record.scope === 'string'
      && 'status' in record && typeof record.status === 'string' && 'receipt' in record
    )),
  };
});

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('adds and retains optional lot quantity and expiry details', async ({ page }) => {
  await page.goto('/pantry');
  await page.evaluate(() => indexedDB.deleteDatabase('ikuck-local-v2'));
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  await page.getByRole('button', { name: 'Aggiungi lotto' }).click();
  await page.getByLabel('Quantità del lotto').fill('320');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByLabel('Data di scadenza').fill('2099-09-20');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();

  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await expect(page.getByText(/Scade il|Scade presto/).first()).toBeVisible();

  await page.reload();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await expect(page.getByText(/2099|20 set/).first()).toBeVisible();
});

test('consumes only mapped dinner ingredients once, rolls back failed persistence, and keeps pantry history after reloads', async ({ page }) => {
  await page.addInitScript(() => {
    const databasePrototype = IDBDatabase.prototype as unknown as {
      transaction: (...args: unknown[]) => IDBTransaction;
    };
    const originalTransaction = databasePrototype.transaction;
    databasePrototype.transaction = function (this: IDBDatabase, ...args: unknown[]): IDBTransaction {
      const transaction = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
      const requestedStores = typeof args[0] === 'string' ? [args[0]] : args[0] as string[];
      if (window.sessionStorage.getItem('fail-dinner-consumption-write') === 'true'
        && args[1] === 'readwrite' && requestedStores.includes('dinnerConsumption')) {
        window.sessionStorage.removeItem('fail-dinner-consumption-write');
        queueMicrotask(() => {
          try { transaction.abort(); } catch { /* The transaction may already have failed. */ }
        });
      }
      return transaction;
    };
  });
  const bringRequests: string[] = [];
  const aiRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.toLowerCase().includes('bring')) bringRequests.push(url.pathname);
    if (url.pathname === '/v1/ai-dinner-reconstruction') aiRequests.push(request.method());
  });

  await page.goto('/pantry');
  await clearLocalDatabase(page);
  await page.reload();
  await page.getByLabel('Ingredienti presenti').fill('pasta, sale');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();

  const pastaLots = page.getByRole('list', { name: 'Lotti di Pasta' });
  await pastaLots.getByRole('listitem').first().getByRole('button', { name: 'Modifica' }).click();
  await page.getByLabel('Quantità del lotto').fill('80');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByLabel('Data di scadenza').fill('2026-10-01');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();

  const pastaArticle = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Lotti di Pasta' }) });
  await pastaArticle.getByRole('button', { name: 'Aggiungi lotto' }).click();
  await page.getByLabel('Quantità del lotto').fill('200');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByLabel('Data di scadenza').fill('2099-09-20');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();
  await page.locator('details').last().locator('summary').click();
  await page.getByRole('checkbox', { name: 'Sale' }).check();

  const beforeCommit = await readGuestState(page);
  const beforePantry = beforeCommit.pantry as {
    pantryItems: Array<{ id: string }>;
    stapleIds: string[];
    pantryLots: Array<{ id: string; ingredientId: string; quantity: number | null; expiresAt: string | null }>;
  } | null;
  if (beforePantry === null) throw new Error('Guest pantry was not persisted before dinner confirmation');
  expect(beforePantry.pantryItems.map(({ id }) => id).sort()).toEqual(['pasta', 'salt']);
  expect(beforePantry.stapleIds).toContain('salt');
  expect(beforePantry.pantryLots.filter((lot) => lot.ingredientId === 'pasta')).toHaveLength(2);
  const expiredPastaLotId = beforePantry.pantryLots.find((lot) => lot.ingredientId === 'pasta' && lot.expiresAt === '2026-10-01')?.id;
  expect(expiredPastaLotId).toBeDefined();

  await page.getByRole('link', { name: 'Diario delle cene', exact: true }).first().click();
  await page.getByLabel('Data della cena').fill('2026-10-05');
  await page.getByLabel(/Porzioni/).fill('2');
  await page.getByLabel('Com’è andata la cena?').fill('Pasta e sale usati per cena.');
  await page.getByRole('button', { name: 'Registra la cena' }).click();
  await expect(page.getByRole('alert')).toContainText('Indica gli ingredienti utilizzati');
  expect((await readGuestState(page)).dinners).toHaveLength(0);

  await page.getByRole('button', { name: 'Aggiungi ingrediente utilizzato' }).click();
  await page.getByLabel('Ingrediente usato 1').selectOption('pasta');
  await page.getByLabel('Quantità per porzione di Pasta').fill('un po’');
  await page.getByRole('button', { name: 'Aggiungi ingrediente utilizzato' }).click();
  await page.getByLabel('Ingrediente usato 2').selectOption('salt');
  await page.getByRole('button', { name: 'Registra la cena' }).click();
  await expect(page.getByRole('alert')).toContainText('Chiarisci ogni ingrediente o quantità ambigua');
  expect((await readGuestState(page)).dinners).toHaveLength(0);
  expect((await readGuestState(page)).pantry).toEqual(beforeCommit.pantry);

  await page.getByLabel('Quantità per porzione di Pasta').fill('80 g');
  await page.evaluate(() => window.sessionStorage.setItem('fail-dinner-consumption-write', 'true'));
  await page.getByRole('button', { name: 'Registra la cena' }).click();
  await expect(page.getByRole('alert')).toContainText('La dispensa non è stata aggiornata');
  const afterFailure = await readGuestState(page);
  expect(afterFailure.pantry).toEqual(beforeCommit.pantry);
  expect(afterFailure.dinners).toHaveLength(0);
  expect(afterFailure.outbox).toHaveLength(0);

  await page.getByRole('button', { name: 'Registra la cena' }).click();
  await expect(page.getByText('Scalati 160 g di Pasta.')).toBeVisible();
  await expect(page.getByText('Rimossa la presenza di Sale; quantità non registrata.')).toBeVisible();
  const afterCommit = await readGuestState(page);
  const committedPantry = afterCommit.pantry as {
    pantryItems: Array<{ id: string }>;
    stapleIds: string[];
    pantryLots: Array<{ id: string; ingredientId: string; quantity: number | null; unit?: string | null }>;
  } | null;
  expect(committedPantry).toMatchObject({
    pantryItems: [expect.objectContaining({ id: 'pasta' })],
    stapleIds: expect.arrayContaining(['salt']),
    pantryLots: [expect.objectContaining({ ingredientId: 'pasta', quantity: 120, unit: 'g' })],
  });
  expect(committedPantry?.pantryLots.some((lot) => lot.id === expiredPastaLotId)).toBe(false);
  expect(afterCommit.dinners).toHaveLength(1);
  expect(afterCommit.outbox).toHaveLength(1);
  expect(afterCommit.outbox[0]).toMatchObject({ scope: 'guest', status: 'pending' });
  const committedOperationId = afterCommit.outbox[0]?.operationId;
  const committedReceipt = afterCommit.outbox[0]?.receipt;
  expect(committedReceipt).toMatchObject({
    plan: { deleteLotIds: expect.arrayContaining([expiredPastaLotId]) },
  });
  expect(bringRequests).toEqual([]);
  expect(aiRequests).toEqual([]);

  await page.reload();
  await expect(page.getByText('Pasta e sale usati per cena.')).toBeVisible();
  const afterReload = await readGuestState(page);
  expect(afterReload.pantry).toEqual(afterCommit.pantry);
  expect(afterReload.outbox).toHaveLength(1);
  expect(afterReload.outbox[0]).toMatchObject({ operationId: committedOperationId, receipt: committedReceipt });

  await page.getByRole('button', { name: /Modifica cena del/ }).click();
  await page.getByLabel('Nota (facoltativa)').fill('Solo una nota, non un nuovo consumo.');
  await page.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(page.getByText('Nota: Solo una nota, non un nuovo consumo.')).toBeVisible();
  const afterNoteEdit = await readGuestState(page);
  expect(afterNoteEdit.pantry).toEqual(afterCommit.pantry);
  expect(afterNoteEdit.outbox).toHaveLength(1);
  expect(afterNoteEdit.outbox[0]).toMatchObject({ operationId: committedOperationId, receipt: committedReceipt });
  expect(bringRequests).toEqual([]);
  expect(aiRequests).toEqual([]);
});
