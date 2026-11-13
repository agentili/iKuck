import { choosePlanRecipe } from '../test/choosePlanRecipe';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanCommand, PlanState, SyncMutationScope } from '@ikuck/shared/contracts';
import PlanPage from './PlanPage';
import { mealPlanApi } from '../mealPlan/api';
import type { MealPlanRecoveryConflict, MealPlanRecoveryQuarantine, MealPlanRecoveryResponse } from '../mealPlan/api';
import { createLocalPlanState, readMealPlanOutbox, saveGuestPlanState } from '../mealPlan/storage';
import { getDeviceTimeZone, getNextSevenCivilDates } from '../mealPlan';
import { RECIPES } from '../domain/recipes';
import { useAuthStore } from '../auth/authStore';
import { useHouseStore } from '../house/houseStore';
import { usePantryStore } from '../store/localPantryStore';
import { useShoppingListStore, waitForPendingShoppingListWrites } from '../store/shoppingListStore';
import { usePersistenceStatusStore } from '../store/persistenceStatusStore';
import { ApiClientError } from '../api/apiClient';
import { setActiveDataScope, setPersonalDataScope } from '../sync/scopeContext';
import { waitForPendingQueueWrites } from '../sync/syncQueue';
import { deleteLocalDatabase } from '../storage/indexedDb';
import type { ShoppingListItem } from '@ikuck/shared/contracts';

const verifiedUser = { id: 'user-1', email: 'user@example.test', emailVerifiedAt: '2026-10-01T00:00:00.000Z' };
const emptyRecovery: MealPlanRecoveryResponse = { version: 2, conflicts: [], quarantined: [] };
const pastaRecipe = RECIPES.find((recipe) => recipe.id === 'pasta-tonno-pomodoro')!;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const shoppingItem = (ingredientId: string, purchased: boolean): ShoppingListItem => {
  const now = new Date().toISOString();
  return {
    id: `shopping:${ingredientId}`,
    ingredientId,
    label: ingredientId,
    quantity: null,
    unit: null,
    note: null,
    purchased,
    sourceRecipeId: null,
    createdAt: now,
    updatedAt: now,
  };
};

const createPlanState = (date: string, recipeId: string | null, sequence: number): PlanState => {
  const common = {
    date,
    revision: `0000000${sequence}-0000-4000-8000-000000000001`,
    serverSequence: sequence,
  };
  return recipeId === null
    ? { ...common, kind: 'deleted', recipeId: null }
    : { ...common, kind: 'manual', recipeId };
};

const setupSharedPlan = (scopes: readonly SyncMutationScope[], recipesByScope: Partial<Record<SyncMutationScope, string>> = {}) => {
  const datesByScope = new Map<SyncMutationScope, string[]>();
  const statesByScope = new Map<SyncMutationScope, PlanState[]>();
  for (const scope of scopes) {
    const zone = scope.startsWith('house:') ? 'Europe/Rome' : getDeviceTimeZone() ?? 'UTC';
    const dates = getNextSevenCivilDates(new Date(), zone);
    datesByScope.set(scope, dates);
    statesByScope.set(scope, dates.map((date, index) => createPlanState(
      date,
      index === 0 ? recipesByScope[scope] ?? pastaRecipe.id : null,
      index + 1,
    )));
  }

  vi.spyOn(mealPlanApi, 'getCapabilities').mockResolvedValue({ version: 2, syncReadVersion: 2 });
  vi.spyOn(mealPlanApi, 'getHouseTimeZone').mockResolvedValue({
    timeZone: 'Europe/Rome', revision: '123e4567-e89b-42d3-a456-426614174000',
  });
  vi.spyOn(mealPlanApi, 'readSyncPage').mockImplementation(async (scope, _deviceId, cursor) => {
    const states = statesByScope.get(scope) ?? [];
    return {
      changes: cursor === 0 ? states.map((state) => ({ state, serverSequence: state.serverSequence })) : [],
      nextCursor: cursor === 0 ? states.at(-1)?.serverSequence ?? 0 : cursor,
    };
  });
  vi.spyOn(mealPlanApi, 'readStates').mockImplementation(async (scope, dates) => {
    const states = new Map((statesByScope.get(scope) ?? []).map((state) => [state.date, state]));
    return dates.map((date) => ({ date, state: states.get(date) ?? null }));
  });
  vi.spyOn(mealPlanApi, 'readRecovery').mockResolvedValue(emptyRecovery);
  return { datesByScope, statesByScope, readRecovery: vi.mocked(mealPlanApi.readRecovery) };
};

const makeRecoveryConflict = (
  scope: `house:${string}`,
  date: string,
  sourceRecipeId: string,
  targetRecipeId: string,
): MealPlanRecoveryConflict => {
 const sourceState = createPlanState(date, sourceRecipeId, 101);
 const targetBase = createPlanState(date, targetRecipeId, 202);
  const targetState: PlanState = targetBase.kind === 'deleted'
    ? targetBase
    : { ...targetBase, kind: 'automatic' };
  const command: PlanCommand = {
    version: 2,
    scope,
    date,
    operationId: crypto.randomUUID(),
    deviceId: 'device-recovery-test',
    clientUpdatedAt: '2026-11-04T10:00:00.000Z',
    action: 'manual_set',
    recipeId: sourceRecipeId,
  };
  return {
    id: `recovery:${scope}:${date}`,
    sourceAccountId: 'user-1',
    targetHouseId: scope.slice('house:'.length),
    planDate: date,
    sourceRevision: sourceState.revision,
    sourceProjectionMutationId: 'source-mutation-1',
    sourceDeviceId: 'device-source',
    sourceClientUpdatedAt: '2026-11-04T10:00:00.000Z',
    sourceServerUpdatedAt: '2026-11-04T10:01:00.000Z',
    sourceState,
    sourceProjection: null,
    targetRevisionAtStaging: targetState.revision,
    targetStateAtStaging: targetState,
    originalCommand: command,
    createdAt: '2026-11-04T10:02:00.000Z',
  };
};

const prepareGuestPlan = async (): Promise<void> => {
  const timeZone = getDeviceTimeZone() ?? 'UTC';
  const dates = getNextSevenCivilDates(new Date(), timeZone);
  await saveGuestPlanState(createLocalPlanState(dates[0]!, 'manual', pastaRecipe.id));
  for (const date of dates.slice(1)) {
    await saveGuestPlanState(createLocalPlanState(date, 'deleted', null));
  }
};

beforeEach(async () => {
  await deleteLocalDatabase();
  setPersonalDataScope('account:user-1');
  setActiveDataScope('guest');
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  useHouseStore.setState({ state: null });
  usePantryStore.setState({ hasHydrated: true, pantryItems: [], pantryLots: [], stapleIds: [] });
  useShoppingListStore.setState({ hasHydrated: true, items: [] });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  useHouseStore.setState({ state: null });
  setActiveDataScope('guest');
  usePantryStore.setState({ hasHydrated: true, pantryItems: [], pantryLots: [], stapleIds: [] });
  useShoppingListStore.setState({ hasHydrated: true, items: [] });
  await waitForPendingShoppingListWrites();
  await waitForPendingQueueWrites();
  await deleteLocalDatabase();
});

describe('PlanPage pantry and recovery', () => {
  it('uses the local guest pantry offline, adds only absent ingredients once, and reacts to store changes', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await prepareGuestPlan();
    usePantryStore.setState({
      pantryItems: [
        { id: 'pasta', label: 'Pasta', known: true },
        { id: 'olive_oil', label: 'Olio', known: true },
      ],
      pantryLots: [],
      stapleIds: [],
    });
    useShoppingListStore.setState({
      items: [shoppingItem('tuna', true), shoppingItem('tomato_sauce', false)],
    });
    const capabilities = vi.spyOn(mealPlanApi, 'getCapabilities');
    const readRecovery = vi.spyOn(mealPlanApi, 'readRecovery');
    const user = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    expect(await screen.findByText('Pasta tonno e pomodoro')).toBeVisible();
    const missing = await screen.findByRole('region', { name: 'Ingredienti mancanti per il piano' });
    expect(missing).toHaveTextContent('3 ingredienti non presenti in dispensa');
    expect(within(missing).getAllByRole('listitem')).toHaveLength(3);
    expect(within(missing).getByText('tuna', { exact: true })).toBeVisible();
    expect(within(missing).getByText('tomato_sauce', { exact: true })).toBeVisible();
    expect(within(missing).getByText('salt', { exact: true })).toBeVisible();
    expect(within(missing).queryByText('pasta', { exact: true })).not.toBeInTheDocument();
    expect(within(missing).queryByText('olive_oil', { exact: true })).not.toBeInTheDocument();
    expect(within(missing).queryByText('garlic', { exact: true })).not.toBeInTheDocument();
    expect(within(missing).getAllByText('Già nella lista')).toHaveLength(2);
    expect(capabilities).not.toHaveBeenCalled();
    expect(readRecovery).not.toHaveBeenCalled();

    const addButton = within(missing).getByRole('button', { name: /aggiungi alla lista/i });
    await user.click(addButton);
    expect(useShoppingListStore.getState().items.map((item) => item.ingredientId).sort()).toEqual([
      'salt', 'tomato_sauce', 'tuna',
    ]);
    expect(within(missing).getAllByText('Già nella lista')).toHaveLength(3);

    await user.click(addButton);
    expect(useShoppingListStore.getState().items.map((item) => item.ingredientId).sort()).toEqual([
      'salt', 'tomato_sauce', 'tuna',
    ]);

    act(() => usePantryStore.getState().addIngredients([{ id: 'tuna', label: 'Tonno', known: true }]));
    await waitFor(() => expect(usePersistenceStatusStore.getState().statuses.pantry.state).not.toBe('saving'));
    await waitForPendingQueueWrites();
    await waitFor(() => {
      expect(within(missing).getAllByRole('listitem')).toHaveLength(2);
      expect(within(missing).queryByText('tuna', { exact: true })).not.toBeInTheDocument();
    });
  });

  it.each([
    {
      scope: 'account:user-1' as const,
      pantryIds: ['pasta'],
      present: 'pasta',
      missing: 'olive_oil',
      status: 'Sincronizzato con il tuo account',
    },
    {
      scope: 'house:house-1' as const,
      pantryIds: ['olive_oil'],
      present: 'olive_oil',
      missing: 'pasta',
      status: 'Condiviso con la Casa',
    },
  ])('uses the active $scope pantry without mixing shopping-list state into stock', async ({ scope, pantryIds, present, missing, status }) => {
    setPersonalDataScope('account:user-1');
    setActiveDataScope(scope);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-token', expiresAt: '2026-12-01T00:00:00.000Z' });
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: pantryIds.map((id) => ({ id, label: id, known: true })),
      pantryLots: [],
      stapleIds: [],
    });
    useShoppingListStore.setState({
      hasHydrated: true,
      items: [shoppingItem('tuna', true), shoppingItem('tomato_sauce', false)],
    });
    setupSharedPlan([scope]);
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    expect(await screen.findByText(status)).toBeVisible();
    const missingSection = await screen.findByRole('region', { name: 'Ingredienti mancanti per il piano' });
    expect(within(missingSection).getByText(missing, { exact: true })).toBeVisible();
    expect(within(missingSection).queryByText(present, { exact: true })).not.toBeInTheDocument();
    expect(within(missingSection).getByText('tuna', { exact: true })).toBeVisible();
    expect(within(missingSection).getByText('tomato_sauce', { exact: true })).toBeVisible();
  });

  it('shows the named source and destination recipes and preserves deletion wording in conflict and quarantine recovery', async () => {
    setPersonalDataScope('account:user-1');
    setActiveDataScope('house:house-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-token', expiresAt: '2026-12-01T00:00:00.000Z' });
    const { datesByScope, readRecovery } = setupSharedPlan(['house:house-1']);
    const dates = datesByScope.get('house:house-1')!;
    const sourceRecipe = RECIPES.find((recipe) => recipe.id === 'pollo-al-limone')!;
    const targetRecipe = RECIPES.find((recipe) => recipe.id === 'polpette-al-pomodoro')!;
    const quarantineTarget = RECIPES.find((recipe) => recipe.id === 'salmone-al-limone')!;
    const conflict = makeRecoveryConflict('house:house-1', dates[0]!, sourceRecipe.id, targetRecipe.id);
    const deletedSource = createPlanState(dates[1]!, null, 303);
    const quarantineTargetState: PlanState = {
      date: dates[1]!,
      revision: '0000404-0000-4000-8000-000000000001',
      serverSequence: 404,
      kind: 'automatic',
      recipeId: quarantineTarget.id,
    };
    const quarantine: MealPlanRecoveryQuarantine = {
      planDate: dates[1]!,
      reasonCode: 'legacy_snapshot_incomplete',
      sourceSnapshot: { state: deletedSource, projection: null },
      targetSnapshot: { state: quarantineTargetState, projection: null },
      observed: { manualTuple: null, command: null },
      createdAt: '2026-11-04T10:03:00.000Z',
    };
    readRecovery.mockResolvedValue({ version: 2, conflicts: [conflict], quarantined: [quarantine] });
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const recovery = await screen.findByRole('region', { name: 'Modifiche in conflitto e recovery' });
    expect(recovery).toHaveTextContent(`Fonte (account): ${sourceRecipe.title}`);
    expect(recovery).toHaveTextContent(`Destinazione (Casa): ${targetRecipe.title}`);
    expect(recovery).toHaveTextContent(`Quarantena migrazione: ${dates[1]}`);
    expect(recovery).toHaveTextContent('Codice: legacy_snapshot_incomplete');
    expect(recovery).toHaveTextContent('Fonte (account): Pasto rimosso');
    expect(recovery).toHaveTextContent(`Destinazione (Casa): ${quarantineTarget.title}`);
  });

  it('keeps cached house edits available offline when the recovery service is unreachable', async () => {
    setPersonalDataScope('account:user-1');
    setActiveDataScope('house:house-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-token', expiresAt: '2026-12-01T00:00:00.000Z' });
    const { datesByScope, readRecovery } = setupSharedPlan(['house:house-1']);
    render(<MemoryRouter><PlanPage /></MemoryRouter>);
    expect(await screen.findByText('Condiviso con la Casa')).toBeVisible();

    vi.mocked(mealPlanApi.getCapabilities).mockRejectedValueOnce(new ApiClientError(0, 'network_error', 'offline'));
    readRecovery.mockRejectedValueOnce(new ApiClientError(0, 'network_error', 'offline'));
    vi.spyOn(mealPlanApi, 'sendCommand').mockRejectedValue(new ApiClientError(0, 'network_error', 'offline'));
    act(() => window.dispatchEvent(new Event('online')));

    expect(await screen.findByText(/Connessione assente: la copia salvata/i)).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent(/conflitti di migrazione/i);
    const planList = screen.getByRole('list', { name: 'Pasti da domani' });
    const firstRow = within(planList).getAllByRole('listitem')[0]!;
    const replaceButton = within(firstRow).getByRole('button', { name: /modifica ricetta/i });
    expect(replaceButton).toBeEnabled();

    await choosePlanRecipe(replaceButton);

    await waitFor(async () => {
      expect(await screen.findByText(/non è ancora condivisa/i)).toBeVisible();
      expect(await readMealPlanOutbox(['house:house-1'])).toHaveLength(1);
    });
    expect(datesByScope.get('house:house-1')).toContain(firstRow.getAttribute('data-date'));
  });

  it('surfaces a failed recovery read and keeps the house plan read-only instead of hiding the error', async () => {
    setPersonalDataScope('account:user-1');
    setActiveDataScope('house:house-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-token', expiresAt: '2026-12-01T00:00:00.000Z' });
    const { readRecovery } = setupSharedPlan(['house:house-1']);
    readRecovery.mockRejectedValue(new Error('recovery denied'));
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Non è stato possibile verificare i conflitti di migrazione');
    expect(screen.getByText('Pasta tonno e pomodoro')).toBeVisible();
    expect(screen.queryByRole('button', { name: /modifica ricetta/i })).not.toBeInTheDocument();
  });

  it('does not publish recovery data after an in-flight request belongs to an old session and house scope', async () => {
    setPersonalDataScope('account:user-1');
    setActiveDataScope('house:house-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-token', expiresAt: '2026-12-01T00:00:00.000Z' });
    const { datesByScope, readRecovery } = setupSharedPlan(
      ['house:house-1', 'house:house-2'],
      { 'house:house-1': 'pasta-tonno-pomodoro', 'house:house-2': 'pollo-al-limone' },
    );
    const oldRead = deferred<MealPlanRecoveryResponse>();
    readRecovery.mockImplementationOnce(() => oldRead.promise);
    render(<MemoryRouter><PlanPage /></MemoryRouter>);
    await waitFor(() => expect(readRecovery).toHaveBeenCalledTimes(1));

    act(() => {
      setPersonalDataScope('account:user-2');
      setActiveDataScope('house:house-2');
      useAuthStore.setState({
        user: { ...verifiedUser, id: 'user-2', email: 'second@example.test' },
        csrfToken: 'second-csrf-token',
      });
    });
    expect(await screen.findByText('Pollo al limone', { exact: true })).toBeVisible();
    await waitFor(() => expect(readRecovery).toHaveBeenCalledTimes(2));

    const dates = datesByScope.get('house:house-1')!;
    const staleConflict = makeRecoveryConflict('house:house-1', dates[0]!, 'salmone-al-limone', 'frittata-zucchine');
    await act(async () => {
      oldRead.resolve({ version: 2, conflicts: [staleConflict], quarantined: [] });
      await oldRead.promise;
    });
    await waitFor(() => {
      expect(screen.queryByText(/Salmone al limone/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Destinazione \(Casa\): Frittata di zucchine/)).not.toBeInTheDocument();
    });
  });

  it('does not surface a recovery-read error after its session and house scope become stale', async () => {
    setPersonalDataScope('account:user-1');
    setActiveDataScope('house:house-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-token', expiresAt: '2026-12-01T00:00:00.000Z' });
    setupSharedPlan(
      ['house:house-1', 'house:house-2'],
      { 'house:house-1': 'pasta-tonno-pomodoro', 'house:house-2': 'pollo-al-limone' },
    );
    const oldRead = deferred<MealPlanRecoveryResponse>();
    const readRecovery = vi.mocked(mealPlanApi.readRecovery);
    readRecovery.mockImplementationOnce(() => oldRead.promise);
    render(<MemoryRouter><PlanPage /></MemoryRouter>);
    await waitFor(() => expect(readRecovery).toHaveBeenCalledTimes(1));

    act(() => {
      setPersonalDataScope('account:user-2');
      setActiveDataScope('house:house-2');
      useAuthStore.setState({
        user: { ...verifiedUser, id: 'user-2', email: 'second@example.test' },
        csrfToken: 'second-csrf-token',
      });
    });
    expect(await screen.findByText('Pollo al limone', { exact: true })).toBeVisible();
    await waitFor(() => expect(readRecovery).toHaveBeenCalledTimes(2));

    await act(async () => {
      oldRead.reject(new Error('old session recovery failure'));
      await oldRead.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Pollo al limone', { exact: true })).toBeVisible();
  });
});
