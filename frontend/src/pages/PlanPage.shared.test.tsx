import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { HouseTimeZoneState, PlanCommand, PlanState } from '@ikuck/shared/contracts';
import PlanPage from './PlanPage';
import { mealPlanApi, MealPlanUnavailableError } from '../mealPlan/api';
import { readMealPlanOutbox, readMealPlanSnapshot, commitMealPlanCommand, enqueueMealPlanCommand } from '../mealPlan/storage';
import { scopeStorageKey, setActiveDataScope } from '../sync/scopeContext';
import { completeScopePurge, resumeScope, revokeScope } from '../sync/scopeWriteFence';
import * as syncQueue from '../sync/syncQueue';
import { useAuthStore } from '../auth/authStore';
import { useHouseStore } from '../house/houseStore';
import { RECIPES } from '../domain/recipes';
import { ApiClientError } from '../api/apiClient';
import { deleteLocalDatabase, readQueueValues } from '../storage/indexedDb';
import { getNextSevenCivilDates } from '../mealPlan/dates';
import type { MealPlanApi } from '../mealPlan/api';

const user = { id: 'user-1', email: 'user@example.test', emailVerifiedAt: '2026-10-01T00:00:00.000Z' };

beforeEach(async () => {
  await deleteLocalDatabase();
  setActiveDataScope('house:house-1');
  useAuthStore.setState({ user, csrfToken: 'csrf-token', expiresAt: '2026-12-01T00:00:00.000Z' });
  vi.spyOn(mealPlanApi, 'readSyncPage').mockResolvedValue({ changes: [], nextCursor: 0 });
  vi.spyOn(mealPlanApi, 'readRecovery').mockResolvedValue({ version: 2, conflicts: [], quarantined: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  useHouseStore.setState({ state: null });
  setActiveDataScope('guest');
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const setupExistingSharedPlan = () => {
  const dates = [...new Set([
    ...getNextSevenCivilDates(new Date(), 'Europe/Rome'),
    ...getNextSevenCivilDates(new Date(), 'America/New_York'),
  ])];
  const statesByScope = new Map<string, Map<string, PlanState>>();
  for (const [scope, offset] of [['house:house-1', 0], ['house:house-2', 7]] as const) {
    statesByScope.set(scope, new Map(dates.map((date, index) => [date, {
      date,
      revision: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000001`,
      serverSequence: index + 1,
      kind: 'automatic',
      recipeId: RECIPES[(index + offset) % RECIPES.length]!.id,
    }])));
  }
  let timeZone: HouseTimeZoneState = {
    timeZone: 'Europe/Rome', revision: '123e4567-e89b-42d3-a456-426614174000',
  };
  const getZone = vi.spyOn(mealPlanApi, 'getHouseTimeZone').mockImplementation(async () => timeZone);
  vi.spyOn(mealPlanApi, 'getCapabilities').mockResolvedValue({ version: 2, syncReadVersion: 2 });
  vi.spyOn(mealPlanApi, 'readSyncPage').mockImplementation(async (scope, _deviceId, cursor) => {
    const states = [...(statesByScope.get(scope)?.values() ?? [])];
    return cursor === 0
      ? { changes: states.map((state) => ({ state, serverSequence: state.serverSequence })), nextCursor: states.at(-1)?.serverSequence ?? 0 }
      : { changes: [], nextCursor: cursor };
  });
  vi.spyOn(mealPlanApi, 'readStates').mockImplementation(async (scope, requestedDates) => requestedDates.map((date) => ({
    date,
    state: statesByScope.get(scope)?.get(date) ?? null,
  })));
  return { dates, statesByScope, getZone, setTimeZone: (value: HouseTimeZoneState): void => { timeZone = value; } };
};

describe('PlanPage shared mode', () => {
  it('loads the local guest plan when the session has no user identity', async () => {
    useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
    setActiveDataScope('guest');
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    expect(await screen.findByText(/salvato su questo dispositivo/i)).toBeVisible();
    expect(await screen.findAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByRole('link', { name: 'Apri la lista della spesa' })).toHaveAttribute('href', '/shopping-list');
    expect(screen.getByRole('link', { name: 'Torna al Chef' })).toHaveAttribute('href', '/');
  });

  it('aborts a guest recipe change when the account changes during the native IndexedDB read', async () => {
    useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
    setActiveDataScope('guest');
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    expect(await screen.findByText(/salvato su questo dispositivo/i)).toBeVisible();
    const firstRow = (await screen.findAllByRole('listitem'))[0]!;
    const before = await readMealPlanSnapshot('guest');
    const transactionRead = deferred<void>();
    const originalGet = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalGet.call(this, key);
      if (this.transaction.mode === 'readwrite' && key === scopeStorageKey('guest', 'meal-plan-v2')) {
        request.addEventListener('success', () => {
          act(() => useAuthStore.setState({
            user: { ...user, id: 'user-2', email: 'second@example.test' },
            csrfToken: 'second-csrf-token',
          }));
          transactionRead.resolve();
        }, { once: true });
      }
      return request;
    });

    await userEvent.setup().click(within(firstRow).getByRole('button', { name: /cambia ricetta/i }));
    await transactionRead.promise;
    get.mockRestore();

    await waitFor(async () => {
      expect(await readMealPlanSnapshot('guest')).toEqual(before);
      expect(await readQueueValues<unknown>('guest')).toEqual([]);
      expect(screen.queryByRole('list', { name: 'Pasti da domani' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not write or present local-only content as shared when v2 capability is unavailable', async () => {
    vi.spyOn(mealPlanApi, 'getCapabilities').mockRejectedValue(new MealPlanUnavailableError());
    const read = vi.spyOn(mealPlanApi, 'readStates');
    const send = vi.spyOn(mealPlanApi, 'sendCommand');
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText(/non supporta ancora il piano condiviso/i)).toBeVisible());
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('button', { name: /cambia ricetta/i })).toHaveLength(0);
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toEqual([]);
  });

  it('shows a provisional device-timezone calendar on first offline load without sending plan data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    vi.spyOn(mealPlanApi, 'getCapabilities').mockRejectedValue(new ApiClientError(0, 'network_error', 'offline'));
    const read = vi.spyOn(mealPlanApi, 'readStates');
    const send = vi.spyOn(mealPlanApi, 'sendCommand');
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    expect(await screen.findByText(/fuso provvisorio/i)).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText(/non vengono letti o modificati/i)).toBeVisible();
    expect(screen.queryAllByRole('button', { name: /cambia ricetta/i })).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('bootstraps from the shared scope and confirms real automatic recipe commands', async () => {
    const current = new Map<string, PlanState>();
    let sequence = 0;
    vi.spyOn(mealPlanApi, 'getCapabilities').mockResolvedValue({ version: 2, syncReadVersion: 2 });
    vi.spyOn(mealPlanApi, 'getHouseTimeZone').mockResolvedValue({
      timeZone: 'Europe/Rome', revision: '123e4567-e89b-42d3-a456-426614174000',
    });
    const read = vi.spyOn(mealPlanApi, 'readStates').mockImplementation(async (_scope, dates) => dates.map((date) => ({
      date,
      state: current.get(date) ?? null,
    })));
    const send = vi.spyOn(mealPlanApi, 'sendCommand').mockImplementation(async (command: PlanCommand) => {
      sequence += 1;
      const state: PlanState = command.action === 'manual_delete'
        ? {
          date: command.date,
          revision: `0000000${sequence}-0000-4000-8000-000000000001`,
          serverSequence: sequence,
          kind: 'deleted',
          recipeId: null,
        }
        : {
          date: command.date,
          revision: `0000000${sequence}-0000-4000-8000-000000000001`,
          serverSequence: sequence,
          kind: command.action === 'auto_create' ? 'automatic' : 'manual',
          recipeId: command.recipeId,
        };
      current.set(command.date, state);
      return { version: 2, operationId: command.operationId, outcome: 'applied', current: state };
    });
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Condiviso con la Casa')).toBeVisible());
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(send).toHaveBeenCalledTimes(7);
    expect(send.mock.calls.every(([command]) => command.action === 'auto_create' && command.baseRevision === null)).toBe(true);
    expect(read.mock.calls[0]?.[0]).toBe('house:house-1');
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toEqual([]);
  });

  it('persists a manual replacement to the house and reloads it for another member', async () => {
    const current = new Map<string, PlanState>();
    let sequence = 0;
    vi.spyOn(mealPlanApi, 'getCapabilities').mockResolvedValue({ version: 2, syncReadVersion: 2 });
    vi.spyOn(mealPlanApi, 'getHouseTimeZone').mockResolvedValue({
      timeZone: 'Europe/Rome', revision: '123e4567-e89b-42d3-a456-426614174000',
    });
    const read = vi.spyOn(mealPlanApi, 'readStates').mockImplementation(async (_scope, dates) => dates.map((date) => ({
      date,
      state: current.get(date) ?? null,
    })));
    const send = vi.spyOn(mealPlanApi, 'sendCommand').mockImplementation(async (command: PlanCommand) => {
      sequence += 1;
      const state: PlanState = command.action === 'manual_delete'
        ? {
          date: command.date,
          revision: `${String(sequence).padStart(8, '0')}-0000-4000-8000-000000000001`,
          serverSequence: sequence,
          kind: 'deleted',
          recipeId: null,
        }
        : {
          date: command.date,
          revision: `${String(sequence).padStart(8, '0')}-0000-4000-8000-000000000001`,
          serverSequence: sequence,
          kind: command.action === 'auto_create' ? 'automatic' : 'manual',
          recipeId: command.recipeId,
        };
      current.set(command.date, state);
      return { version: 2, operationId: command.operationId, outcome: 'applied', current: state };
    });
    const userInput = userEvent.setup();
    const firstDevice = render(<MemoryRouter><PlanPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Condiviso con la Casa')).toBeVisible());
    const firstRow = screen.getAllByRole('listitem')[0];
    const originalTitle = RECIPES.find((recipe) => recipe.id === current.get(firstRow.getAttribute('data-date')!)?.recipeId)!.title;
    await userInput.click(within(firstRow).getByRole('button', { name: /cambia ricetta/i }));
    await waitFor(() => {
      const state = current.get(firstRow.getAttribute('data-date')!);
      expect(state?.kind).toBe('manual');
      expect(state?.recipeId).not.toBe(RECIPES.find((recipe) => recipe.title === originalTitle)?.id);
    });
    const replacement = RECIPES.find((recipe) => recipe.id === current.get(firstRow.getAttribute('data-date')!)?.recipeId)!;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      action: 'manual_set', scope: 'house:house-1', date: firstRow.getAttribute('data-date'), recipeId: replacement.id,
    }), 'csrf-token');

    firstDevice.unmount();
    await deleteLocalDatabase();
    useAuthStore.setState({
      user: { id: 'user-2', email: 'second@example.test', emailVerifiedAt: '2026-10-01T00:00:00.000Z' },
      csrfToken: 'second-csrf-token', expiresAt: '2026-12-01T00:00:00.000Z',
    });
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const secondRow = (await screen.findAllByRole('listitem'))[0];
    await waitFor(() => expect(within(secondRow).getByText(replacement.title)).toBeVisible());
    expect(read.mock.calls.some(([scope]) => scope === 'house:house-1')).toBe(true);
    expect(send).toHaveBeenCalledTimes(8);
  });

  it('does not start a rendered action from the previous session after an account swap in the same house', async () => {
    setupExistingSharedPlan();
    const deviceId = vi.spyOn(syncQueue, 'getDeviceId').mockResolvedValue('device-test');
    render(<MemoryRouter><PlanPage /></MemoryRouter>);
    const firstRow = (await screen.findAllByRole('listitem'))[0]!;
    const changeButton = within(firstRow).getByRole('button', { name: /cambia ricetta/i });
    deviceId.mockClear();

    act(() => {
      useAuthStore.setState({
        user: { ...user, id: 'user-2', email: 'second@example.test' },
        csrfToken: 'second-csrf-token',
      });
      changeButton.click();
    });

    expect(deviceId).not.toHaveBeenCalled();
    expect(await readMealPlanOutbox(['house:house-1'])).toEqual([]);
  });

  it('does not queue a replacement when the session and house change during device ID lookup', async () => {
    const { setTimeZone } = setupExistingSharedPlan();
    const deviceId = deferred<string>();
    const getDeviceId = vi.spyOn(syncQueue, 'getDeviceId').mockResolvedValue('bootstrap-device');
    const send = vi.spyOn(mealPlanApi, 'sendCommand');
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const firstRow = (await screen.findAllByRole('listitem'))[0]!;
    getDeviceId.mockImplementationOnce(() => deviceId.promise);
    await userInput.click(within(firstRow).getByRole('button', { name: /cambia ricetta/i }));
    await waitFor(() => expect(getDeviceId).toHaveBeenCalledTimes(2));

    setTimeZone({ timeZone: 'America/New_York', revision: '123e4567-e89b-42d3-a456-426614174001' });
    act(() => {
      useAuthStore.setState({
        user: { ...user, id: 'user-2', email: 'second@example.test' },
        csrfToken: 'second-csrf-token',
      });
      setActiveDataScope('house:house-2');
    });
    expect(await screen.findByText(/Fuso: America\/New_York/)).toBeVisible();
    deviceId.resolve('action-device');

    await waitFor(async () => {
      expect(await readMealPlanOutbox(['house:house-1'])).toEqual([]);
      expect(await readMealPlanOutbox(['house:house-2'])).toEqual([]);
    });
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a persisted replacement in its original outbox and rejects its late response after a session and house switch', async () => {
    const { statesByScope, setTimeZone } = setupExistingSharedPlan();
    const sendStarted = deferred<PlanCommand>();
    const lateResponse = deferred<Awaited<ReturnType<MealPlanApi['sendCommand']>>>();
    vi.spyOn(mealPlanApi, 'sendCommand').mockImplementation(async (command) => {
      sendStarted.resolve(command);
      return lateResponse.promise;
    });
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const oldZone = await screen.findByText(/Fuso: Europe\/Rome/);
    expect(oldZone).toBeVisible();
    const firstRow = screen.getAllByRole('listitem')[0]!;
    await userInput.click(within(firstRow).getByRole('button', { name: /cambia ricetta/i }));
    const command = await sendStarted.promise;
    await waitFor(async () => expect(await readMealPlanOutbox(['house:house-1'])).toHaveLength(1));

    setTimeZone({ timeZone: 'America/New_York', revision: '123e4567-e89b-42d3-a456-426614174001' });
    act(() => {
      useAuthStore.setState({
        user: { ...user, id: 'user-2', email: 'second@example.test' },
        csrfToken: 'second-csrf-token',
      });
      setActiveDataScope('house:house-2');
    });
    expect(await screen.findByText(/Fuso: America\/New_York/)).toBeVisible();

    const previous = statesByScope.get('house:house-1')!.get(command.date)!;
    if (command.action !== 'manual_set') throw new Error('Expected a manual replacement command');
    lateResponse.resolve({
      version: 2,
      operationId: command.operationId,
      outcome: 'applied',
      current: { ...previous, revision: '223e4567-e89b-42d3-a456-426614174002', serverSequence: 10, kind: 'manual', recipeId: command.recipeId },
    });

    await waitFor(async () => {
      expect(await readMealPlanOutbox(['house:house-1'])).toHaveLength(1);
      expect(screen.getByText(/Fuso: America\/New_York/)).toBeVisible();
    });
    expect(await readMealPlanOutbox(['house:house-2'])).toEqual([]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides the revoked house plan and preserves a command while its network response is pending', async () => {
    const { statesByScope } = setupExistingSharedPlan();
    const sendStarted = deferred<PlanCommand>();
    const lateResponse = deferred<Awaited<ReturnType<MealPlanApi['sendCommand']>>>();
    vi.spyOn(mealPlanApi, 'sendCommand').mockImplementation(async (command) => {
      sendStarted.resolve(command);
      return lateResponse.promise;
    });
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    expect(await screen.findByText(/Fuso: Europe\/Rome/)).toBeVisible();
    await userInput.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: /cambia ricetta/i }));
    const command = await sendStarted.promise;
    await waitFor(async () => expect(await readMealPlanOutbox(['house:house-1'])).toHaveLength(1));

    try {
      act(() => revokeScope('house:house-1'));
      expect(screen.queryByRole('list', { name: 'Pasti da domani' })).not.toBeInTheDocument();
      if (command.action !== 'manual_set') throw new Error('Expected a manual replacement command');
      const previous = statesByScope.get('house:house-1')!.get(command.date)!;
      await act(async () => {
        lateResponse.resolve({
          version: 2,
          operationId: command.operationId,
          outcome: 'applied',
          current: { ...previous, revision: '423e4567-e89b-42d3-a456-426614174004', serverSequence: 12, kind: 'manual', recipeId: command.recipeId },
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });

      await waitFor(async () => {
        expect(await readQueueValues<unknown>('house:house-1')).toHaveLength(1);
        expect((await readMealPlanSnapshot('house:house-1')).states[command.date]).toEqual(previous);
        expect(screen.queryByRole('list', { name: 'Pasti da domani' })).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    } finally {
      completeScopePurge('house:house-1');
      resumeScope('house:house-1');
    }
  });

  it('aborts the recipe transaction when house revocation arrives during the native IndexedDB queue write', async () => {
    setupExistingSharedPlan();
    vi.spyOn(syncQueue, 'getDeviceId').mockResolvedValue('device-test');
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const firstRow = (await screen.findAllByRole('listitem'))[0]!;
    const before = await readMealPlanSnapshot('house:house-1');
    const queueWriteReached = deferred<void>();
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      if (this.name === 'syncQueue' && typeof value === 'object' && value !== null
        && 'entityType' in value && value.entityType === 'meal_plan_entry') {
        request.addEventListener('success', () => {
          revokeScope('house:house-1');
          queueWriteReached.resolve();
        }, { once: true });
      }
      return request;
    });

    try {
      await userInput.click(within(firstRow).getByRole('button', { name: /cambia ricetta/i }));
      await queueWriteReached.promise;
      put.mockRestore();

      await waitFor(async () => {
        expect(await readQueueValues<unknown>('house:house-1')).toEqual([]);
        expect(await readMealPlanSnapshot('house:house-1')).toEqual(before);
        expect(screen.queryByRole('list', { name: 'Pasti da domani' })).not.toBeInTheDocument();
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      put.mockRestore();
      completeScopePurge('house:house-1');
      resumeScope('house:house-1');
    }
  });

  it('keeps a conflict retry queued in the old scope when its network response arrives after switching houses', async () => {
    const { statesByScope, setTimeZone } = setupExistingSharedPlan();
    const date = getNextSevenCivilDates(new Date(), 'Europe/Rome')[0]!;
    const current = statesByScope.get('house:house-1')!.get(date)!;
    const conflictCommand: PlanCommand = {
      version: 2,
      scope: 'house:house-1',
      date,
      operationId: crypto.randomUUID(),
      deviceId: 'device-before-retry',
      clientUpdatedAt: new Date().toISOString(),
      action: 'manual_set',
      recipeId: RECIPES[10]!.id,
    };
    await enqueueMealPlanCommand('house:house-1', conflictCommand);
    await commitMealPlanCommand('house:house-1', 'house:house-1', conflictCommand, {
      version: 2, operationId: conflictCommand.operationId, outcome: 'conflict', current,
    }, current);
    const sendStarted = deferred<PlanCommand>();
    const lateResponse = deferred<Awaited<ReturnType<MealPlanApi['sendCommand']>>>();
    vi.spyOn(mealPlanApi, 'sendCommand').mockImplementation(async (command) => {
      sendStarted.resolve(command);
      return lateResponse.promise;
    });
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const retry = await screen.findByRole('button', { name: 'Riproporre la scelta' });
    await userInput.click(retry);
    const retryCommand = await sendStarted.promise;
    if (retryCommand.action !== 'manual_set') throw new Error('Expected a manual retry command');
    const queuedRetry = (await readMealPlanOutbox(['house:house-1']))[0];
    expect(queuedRetry).toMatchObject({
      mutationId: retryCommand.operationId,
      resolvesConflictId: conflictCommand.operationId,
    });

    setTimeZone({ timeZone: 'America/New_York', revision: '123e4567-e89b-42d3-a456-426614174001' });
    act(() => {
      useAuthStore.setState({
        user: { ...user, id: 'user-2', email: 'second@example.test' },
        csrfToken: 'second-csrf-token',
      });
      setActiveDataScope('house:house-2');
    });
    expect(await screen.findByText(/Fuso: America\/New_York/)).toBeVisible();

    lateResponse.resolve({
      version: 2,
      operationId: retryCommand.operationId,
      outcome: 'applied',
      current: { ...current, revision: '323e4567-e89b-42d3-a456-426614174003', serverSequence: 11, kind: 'manual', recipeId: retryCommand.recipeId },
    });

    await waitFor(async () => {
      expect(await readMealPlanOutbox(['house:house-1'])).toHaveLength(1);
      expect((await readMealPlanSnapshot('house:house-1')).conflicts).toContainEqual(expect.objectContaining({ id: conflictCommand.operationId }));
      expect(screen.getByText(/Fuso: America\/New_York/)).toBeVisible();
    });
  });

  it('does not update or persist a house timezone after its session changes during the timezone read', async () => {
    const { getZone, setTimeZone } = setupExistingSharedPlan();
    useHouseStore.setState({ state: {
      house: { id: 'house-1', name: 'Casa', createdAt: '2026-01-01T00:00:00.000Z' },
      membership: { role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' },
      members: [],
    } });
    const update = vi.spyOn(mealPlanApi, 'updateHouseTimeZone').mockResolvedValue({
      timeZone: 'America/New_York', revision: '123e4567-e89b-42d3-a456-426614174001',
    });
    const pendingRead = deferred<HouseTimeZoneState>();
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const input = await screen.findByRole('textbox', { name: 'Fuso orario della Casa' });
    await userInput.clear(input);
    await userInput.type(input, 'America/New_York');
    getZone.mockImplementationOnce(() => pendingRead.promise);
    await userInput.click(screen.getByRole('button', { name: 'Aggiorna fuso' }));
    await waitFor(() => expect(getZone).toHaveBeenCalledTimes(2));

    setTimeZone({ timeZone: 'America/New_York', revision: '123e4567-e89b-42d3-a456-426614174002' });
    act(() => {
      useAuthStore.setState({
        user: { ...user, id: 'user-2', email: 'second@example.test' },
        csrfToken: 'second-csrf-token',
      });
      setActiveDataScope('house:house-2');
    });
    expect(await screen.findByText(/Fuso: America\/New_York/)).toBeVisible();
    pendingRead.resolve({ timeZone: 'Europe/Rome', revision: '123e4567-e89b-42d3-a456-426614174000' });

    await waitFor(async () => {
      expect(update).not.toHaveBeenCalled();
      expect((await readMealPlanSnapshot('house:house-1')).timeZone?.timeZone).toBe('Europe/Rome');
      expect(screen.getByText(/Fuso: America\/New_York/)).toBeVisible();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not commit an updated timezone when the session changes during its IndexedDB write', async () => {
    const { setTimeZone } = setupExistingSharedPlan();
    useHouseStore.setState({ state: {
      house: { id: 'house-1', name: 'Casa', createdAt: '2026-01-01T00:00:00.000Z' },
      membership: { role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' },
      members: [],
    } });
    const update = vi.spyOn(mealPlanApi, 'updateHouseTimeZone').mockResolvedValue({
      timeZone: 'America/New_York', revision: '123e4567-e89b-42d3-a456-426614174001',
    });
    let timezoneUpdated = false;
    const transactionRead = deferred<void>();
    const originalGet = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalGet.call(this, key);
      if (timezoneUpdated && this.transaction.mode === 'readwrite'
        && key === scopeStorageKey('house:house-1', 'meal-plan-v2')) {
        timezoneUpdated = false;
        request.addEventListener('success', () => {
          useAuthStore.setState({
            user: { ...user, id: 'user-2', email: 'second@example.test' },
            csrfToken: 'second-csrf-token',
          });
          setActiveDataScope('house:house-2');
          setTimeZone({ timeZone: 'America/New_York', revision: '123e4567-e89b-42d3-a456-426614174002' });
          useHouseStore.setState({ state: {
            house: { id: 'house-2', name: 'Altra casa', createdAt: '2026-01-01T00:00:00.000Z' },
            membership: { role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' },
            members: [],
          } });
          transactionRead.resolve();
        }, { once: true });
      }
      return request;
    });
    update.mockImplementation(async (nextTimeZone) => {
      timezoneUpdated = true;
      return { timeZone: nextTimeZone, revision: '123e4567-e89b-42d3-a456-426614174001' };
    });
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const input = await screen.findByRole('textbox', { name: 'Fuso orario della Casa' });
    await userInput.clear(input);
    await userInput.type(input, 'America/New_York');
    await userInput.click(screen.getByRole('button', { name: 'Aggiorna fuso' }));
    await transactionRead.promise;
    get.mockRestore();

    expect(await screen.findByText(/Fuso: America\/New_York/)).toBeVisible();
    await waitFor(async () => {
      expect(update).toHaveBeenCalledTimes(1);
      expect((await readMealPlanSnapshot('house:house-1')).timeZone).toEqual({
        timeZone: 'Europe/Rome', revision: '123e4567-e89b-42d3-a456-426614174000',
      });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lets a house admin update the shared IANA timezone with the current revision', async () => {
    useHouseStore.setState({ state: {
      house: { id: 'house-1', name: 'Casa', createdAt: '2026-01-01T00:00:00.000Z' },
      membership: { role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' },
      members: [],
    } });
    let timeZone: string | null = 'Europe/Rome';
    let revision: string | null = '123e4567-e89b-42d3-a456-426614174000';
    vi.spyOn(mealPlanApi, 'getCapabilities').mockResolvedValue({ version: 2, syncReadVersion: 2 });
    vi.spyOn(mealPlanApi, 'getHouseTimeZone').mockImplementation(async () => ({ timeZone, revision }));
    const update = vi.spyOn(mealPlanApi, 'updateHouseTimeZone').mockImplementation(async (nextTimeZone) => {
      timeZone = nextTimeZone;
      revision = '123e4567-e89b-42d3-a456-426614174001';
      return { timeZone, revision };
    });
    vi.spyOn(mealPlanApi, 'readStates').mockImplementation(async (_scope, dates) => dates.map((date, index) => ({
      date,
      state: {
        date,
        revision: `0000000${index + 1}-0000-4000-8000-000000000001`,
        serverSequence: index + 1,
        kind: 'automatic' as const,
        recipeId: RECIPES[0].id,
      },
    })));
    const userInput = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    const timeZoneInput = await screen.findByRole('textbox', { name: 'Fuso orario della Casa' });
    await userInput.clear(timeZoneInput);
    await userInput.type(timeZoneInput, 'America/New_York');
    expect(timeZoneInput).toHaveValue('America/New_York');
    await userInput.click(screen.getByRole('button', { name: 'Aggiorna fuso' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith('America/New_York', '123e4567-e89b-42d3-a456-426614174000', 'csrf-token'));
    await waitFor(() => expect(screen.getByText(/America\/New_York/)).toBeVisible());
  });
});
