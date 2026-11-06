import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanCommand, PlanState } from '@ikuck/shared/contracts';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { enqueueMealPlanCommand, readMealPlanOutbox, saveGuestPlanState } from './storage';
import type { MealPlanApi } from './api';
import { importGuestMealPlan, syncPendingMealPlan, synchronizeMealPlanScope } from './service';
import {
  activateMealPlanBootstrap,
  createMealPlanCapabilityFingerprint,
  readMealPlanBootstrap,
  readMealPlanSnapshot,
  saveMealPlanBootstrapPage,
  saveMealPlanRead,
} from './storage';

const state: PlanState = {
  date: '2026-10-29', revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 7,
  kind: 'manual', recipeId: 'pollo-al-limone',
};
const command: PlanCommand = {
  version: 2, scope: 'house:house-1', date: state.date, operationId: 'operation-1', deviceId: 'device-1',
  clientUpdatedAt: '2026-10-28T12:00:00.000Z', action: 'manual_set', recipeId: state.recipeId!,
};

beforeEach(async () => {
  await deleteLocalDatabase();
});

const prepareBootstrap = async (scope: 'house:house-1' | 'account:user-1'): Promise<void> => {
  const fingerprint = createMealPlanCapabilityFingerprint({ version: 2, syncReadVersion: 2 });
  await saveMealPlanBootstrapPage(scope, fingerprint, 0, { changes: [], nextCursor: 0 });
  await activateMealPlanBootstrap(scope, fingerprint);
};

describe('meal plan outbox synchronization', () => {
  it('negotiates capability, sends the persisted command, reads the winner, then acknowledges atomically', async () => {
    await prepareBootstrap('house:house-1');
    await enqueueMealPlanCommand('house:house-1', command);
    const api = {
      getCapabilities: vi.fn().mockResolvedValue({ version: 2, syncReadVersion: 2 }),
      sendCommand: vi.fn().mockResolvedValue({ version: 2, operationId: command.operationId, outcome: 'applied', current: state }),
      readStates: vi.fn().mockResolvedValue([{ date: state.date, state }]),
    } as unknown as MealPlanApi;

    await expect(syncPendingMealPlan('house:house-1', 'csrf-token', api, () => {})).resolves.toMatchObject({ acknowledged: 1, conflicts: 0 });
    expect(api.sendCommand).toHaveBeenCalledWith(command, 'csrf-token');
    expect(api.readStates).toHaveBeenCalledWith('house:house-1', [state.date], 'csrf-token');
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toEqual([]);
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({ states: { [state.date]: state } });
  });

  it('sends same-date commands in durable enqueue order rather than mutation ID order', async () => {
    await prepareBootstrap('house:house-1');
    const first: PlanCommand = { ...command, operationId: 'z-created-first', recipeId: 'first-recipe' };
    const second: PlanCommand = { ...command, operationId: 'a-created-second', recipeId: 'second-recipe' };
    await enqueueMealPlanCommand('house:house-1', first);
    await enqueueMealPlanCommand('house:house-1', second);
    const sent: string[] = [];
    let latest: PlanState | null = null;
    const api = {
      getCapabilities: vi.fn().mockResolvedValue({ version: 2, syncReadVersion: 2 }),
      sendCommand: vi.fn(async (entry: PlanCommand) => {
        sent.push(entry.operationId);
        latest = { ...state, revision: crypto.randomUUID(), serverSequence: sent.length, recipeId: entry.action === 'manual_set' ? entry.recipeId : state.recipeId };
        return { version: 2 as const, operationId: entry.operationId, outcome: 'applied' as const, current: latest };
      }),
      readStates: vi.fn(async (_scope: string, dates: readonly string[]) => dates.map((date) => ({
        date, state: date === state.date ? latest : null,
      }))),
    } as unknown as MealPlanApi;

    await expect(syncPendingMealPlan('house:house-1', 'csrf-token', api, () => {}))
      .resolves.toMatchObject({ acknowledged: 2, pending: 0 });

    expect(sent).toEqual([first.operationId, second.operationId]);
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({
      states: { [state.date]: { recipeId: 'second-recipe' } },
      receipts: {
        [first.operationId]: { operationId: first.operationId, outcome: 'applied' },
        [second.operationId]: { operationId: second.operationId, outcome: 'applied' },
      },
    });
  });

  it('retries the same operation after a lost receipt without acknowledging its queue or overlay early', async () => {
    await prepareBootstrap('house:house-1');
    const optimistic = { ...state, revision: crypto.randomUUID(), serverSequence: 0 };
    await enqueueMealPlanCommand('house:house-1', command, { optimisticState: optimistic });
    const receipt = { version: 2 as const, operationId: command.operationId, outcome: 'applied' as const, current: state };
    const sendCommand = vi.fn<MealPlanApi['sendCommand']>()
      .mockRejectedValueOnce(new Error('response lost after server commit'))
      .mockResolvedValueOnce(receipt);
    const api = {
      getCapabilities: vi.fn().mockResolvedValue({ version: 2, syncReadVersion: 2 }),
      sendCommand,
      readStates: vi.fn().mockResolvedValue([{ date: state.date, state }]),
    } as unknown as MealPlanApi;

    await expect(syncPendingMealPlan('house:house-1', 'csrf-token', api, () => {}))
      .rejects.toThrow('response lost after server commit');
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toMatchObject([{ mutationId: command.operationId }]);
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({ overlays: { [state.date]: optimistic }, receipts: {} });
    expect(api.readStates).not.toHaveBeenCalled();

    await expect(syncPendingMealPlan('house:house-1', 'csrf-token', api, () => {}))
      .resolves.toMatchObject({ acknowledged: 1, pending: 0 });

    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls.map(([entry]) => entry.operationId)).toEqual([command.operationId, command.operationId]);
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({
      overlays: {},
      receipts: { [command.operationId]: receipt },
    });
  });

  it('serializes concurrent synchronizations for one scope so they cannot submit the same command twice in parallel', async () => {
    await prepareBootstrap('house:house-1');
    await enqueueMealPlanCommand('house:house-1', command);
    let release!: (value: Awaited<ReturnType<MealPlanApi['sendCommand']>>) => void;
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const commandResponse = new Promise<Awaited<ReturnType<MealPlanApi['sendCommand']>>>((resolve) => { release = resolve; });
    const sendCommand = vi.fn(() => {
      started();
      return commandResponse;
    });
    const api = {
      getCapabilities: vi.fn().mockResolvedValue({ version: 2, syncReadVersion: 2 }),
      sendCommand,
      readStates: vi.fn().mockResolvedValue([{ date: state.date, state }]),
    } as unknown as MealPlanApi;

    const first = syncPendingMealPlan('house:house-1', 'csrf-token', api, () => {});
    await sendStarted;
    const second = syncPendingMealPlan('house:house-1', 'csrf-token', api, () => {});
    await Promise.resolve();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    release({ version: 2, operationId: command.operationId, outcome: 'applied', current: state });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { acknowledged: 1, pending: 0 },
      { acknowledged: 0, pending: 0 },
    ]);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('keeps pending commands when the v2 capability handshake is unavailable', async () => {
    await prepareBootstrap('house:house-1');
    await enqueueMealPlanCommand('house:house-1', command);
    const api = {
      getCapabilities: vi.fn().mockRejectedValue(new Error('unsupported')),
      sendCommand: vi.fn(),
      importCommands: vi.fn(),
      readStates: vi.fn(),
      readSyncPage: vi.fn(),
    } as unknown as MealPlanApi;

    await expect(syncPendingMealPlan('house:house-1', 'csrf-token', api, () => {})).rejects.toThrow('unsupported');
    expect(api.sendCommand).not.toHaveBeenCalled();
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toHaveLength(1);
  });
});

describe('explicit guest plan import', () => {
  const guestState: PlanState = {
    date: '2026-11-03', revision: '223e4567-e89b-42d3-a456-426614174001', serverSequence: 0,
    kind: 'manual', recipeId: 'guest-pasta',
  };
  const serverState: PlanState = {
    ...guestState, revision: '323e4567-e89b-42d3-a456-426614174002', serverSequence: 1,
  };

  const makeImportApi = (importCommands: MealPlanApi['importCommands'], current = serverState): MealPlanApi => ({
    getCapabilities: vi.fn().mockResolvedValue({ version: 2, syncReadVersion: 2 }),
    readSyncPage: vi.fn().mockResolvedValue({ changes: [], nextCursor: 0 }),
    importCommands,
    readStates: vi.fn(async (_scope: string, dates: readonly string[]) => dates.map((date) => ({ date, state: date === current.date ? current : null }))),
  } as unknown as MealPlanApi);

  it('keeps guest source and queued receipt after interruption, then retries the same idempotent command', async () => {
    await saveGuestPlanState(guestState);
    const importCommands = vi.fn<MealPlanApi['importCommands']>()
      .mockRejectedValueOnce(new Error('network interrupted'))
      .mockImplementation(async (_scope, items) => ({
        version: 2 as const,
        results: items.map((item) => ({
          sourceId: item.sourceId,
          localRevision: item.localRevision,
          result: { version: 2 as const, operationId: item.command.operationId, outcome: 'applied' as const, current: serverState },
        })),
      }));
    const api = makeImportApi(importCommands);

    await expect(importGuestMealPlan({ scope: 'account:user-1', csrfToken: 'csrf-token', api, deviceId: 'device-1' }))
      .rejects.toThrow('network interrupted');
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [guestState.date]: guestState } });
    await expect(readMealPlanOutbox(['account:user-1'])).resolves.toHaveLength(1);
    const firstCommand = importCommands.mock.calls[0]?.[1][0]?.command;

    await expect(importGuestMealPlan({ scope: 'account:user-1', csrfToken: 'csrf-token', api, deviceId: 'device-1' }))
      .resolves.toMatchObject({ acknowledged: 1, pending: 0 });

    expect(importCommands).toHaveBeenCalledTimes(2);
    expect(importCommands.mock.calls[1]?.[1][0]?.command).toEqual(firstCommand);
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: {} });
    await expect(readMealPlanOutbox(['account:user-1'])).resolves.toEqual([]);
  });

  it('retains a conflicted guest source and does not automatically overwrite it on retry', async () => {
    await saveGuestPlanState(guestState);
    const remoteState: PlanState = {
      ...serverState, revision: '423e4567-e89b-42d3-a456-426614174003', recipeId: 'remote-choice', serverSequence: 2,
    };
    const importCommands = vi.fn<MealPlanApi['importCommands']>(async (_scope, items) => ({
      version: 2 as const,
      results: items.map((item) => ({
        sourceId: item.sourceId,
        localRevision: item.localRevision,
        result: { version: 2 as const, operationId: item.command.operationId, outcome: 'conflict' as const, current: remoteState },
      })),
    }));
    const api = makeImportApi(importCommands, remoteState);

    await expect(importGuestMealPlan({ scope: 'account:user-1', csrfToken: 'csrf-token', api, deviceId: 'device-1' }))
      .resolves.toMatchObject({ conflicts: 1, preservedConflicts: 1 });
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [guestState.date]: guestState } });
    await expect(readMealPlanSnapshot('account:user-1')).resolves.toMatchObject({
      conflicts: [{ sourceScope: 'guest', sourceRevision: guestState.revision }],
    });

    await expect(importGuestMealPlan({ scope: 'account:user-1', csrfToken: 'csrf-token', api, deviceId: 'device-1' }))
      .resolves.toMatchObject({ acknowledged: 0, preservedConflicts: 1 });
    expect(importCommands).toHaveBeenCalledTimes(1);
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [guestState.date]: guestState } });
  });
});

describe('meal plan bootstrap', () => {
  const makeHistory = (count: number): PlanState[] => Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    revision: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    serverSequence: index + 1,
    kind: 'manual' as const,
    recipeId: `recipe-${index + 1}`,
  }));

  it('bootstraps every historical page from cursor zero before exposing complete state', async () => {
    const scope = 'house:house-1';
    const history = makeHistory(201);
    const byDate = new Map(history.map((item) => [item.date, item]));
    const api = {
      getCapabilities: vi.fn().mockResolvedValue({ version: 2, syncReadVersion: 2 }),
      readSyncPage: vi.fn(async (_scope: string, _deviceId: string, cursor: number) => {
        const page = history.filter((item) => item.serverSequence > cursor).slice(0, 200);
        return { changes: page.map((item) => ({ state: item, serverSequence: item.serverSequence })),
          nextCursor: page.at(-1)?.serverSequence ?? cursor };
      }),
      readStates: vi.fn(async (_scope: string, dates: readonly string[]) => dates.map((date) => ({ date, state: byDate.get(date) ?? null }))),
    } as unknown as MealPlanApi;

    await synchronizeMealPlanScope({ scope, csrfToken: 'csrf-token', api, deviceId: 'device-1' });

    expect(api.readSyncPage).toHaveBeenNthCalledWith(1, scope, 'device-1', 0, 'csrf-token');
    expect(api.readSyncPage).toHaveBeenNthCalledWith(2, scope, 'device-1', 200, 'csrf-token');
    expect(api.readSyncPage).toHaveBeenNthCalledWith(3, scope, 'device-1', 201, 'csrf-token');
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({
      states: { [history[0]!.date]: history[0], [history[200]!.date]: history[200] },
      bootstrap: { version: 2, cursor: 201 },
    });
    expect(api.readStates).toHaveBeenCalled();
  });

  it('keeps the old snapshot while a page fails and resumes staging from its durable cursor', async () => {
    const scope = 'account:user-1';
    const history = makeHistory(201);
    const byDate = new Map(history.map((item) => [item.date, item]));
    const fingerprint = createMealPlanCapabilityFingerprint({ version: 2, syncReadVersion: 2 });
    const oldState = { ...state, date: '2019-01-01' };
    await saveMealPlanRead(scope, [oldState.date], [{ date: oldState.date, state: oldState }]);
    const readSyncPage = vi.fn()
      .mockResolvedValueOnce({
        changes: history.slice(0, 200).map((item) => ({ state: item, serverSequence: item.serverSequence })),
        nextCursor: 200,
      })
      .mockRejectedValueOnce(new Error('network interrupted'))
      .mockResolvedValueOnce({
        changes: [{ state: history[200]!, serverSequence: 201 }], nextCursor: 201,
      })
      .mockResolvedValueOnce({ changes: [], nextCursor: 201 })
      .mockResolvedValueOnce({ changes: [], nextCursor: 201 });
    const api = {
      getCapabilities: vi.fn().mockResolvedValue({ version: 2, syncReadVersion: 2 }),
      readSyncPage,
      readStates: vi.fn(async (_scope: string, dates: readonly string[]) => dates.map((date) => ({ date, state: byDate.get(date) ?? null }))),
    } as unknown as MealPlanApi;

    await expect(synchronizeMealPlanScope({ scope, csrfToken: 'csrf-token', api, deviceId: 'device-1' }))
      .rejects.toThrow('network interrupted');
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({ states: { [oldState.date]: oldState }, bootstrap: null });
    await expect(readMealPlanBootstrap(scope, fingerprint)).resolves.toMatchObject({ cursor: 200 });

    await synchronizeMealPlanScope({ scope, csrfToken: 'csrf-token', api, deviceId: 'device-1' });

    expect(readSyncPage.mock.calls[2]?.[2]).toBe(200);
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({
      states: { [history[0]!.date]: history[0], [history[200]!.date]: history[200] },
      bootstrap: { version: 2, cursor: 201 },
    });
  });
});
