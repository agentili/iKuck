import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanCommand, PlanState, SyncMutation } from '@ikuck/shared/contracts';
import { ApiClientError, type ApiRequest } from '../api/apiClient';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { enqueueMealPlanCommand, readMealPlanOutbox, readMealPlanSnapshot } from '../mealPlan/storage';
import { getActiveDataScope, getPersonalDataScope, setActiveDataScope, setPersonalDataScope } from './scopeContext';
import { enqueueMutation, initializeSessionScope, readQueuedMutations, syncNow } from './syncQueue';

const session = {
  userId: 'account-owner',
  emailVerifiedAt: '2026-10-29T08:00:00.000Z',
  csrfToken: 'csrf-account-owner',
};
const accountScope = `account:${session.userId}` as const;
const houseScope = 'house:shared-home' as const;
const createdAt = '2026-10-28T08:00:00.000Z';
const houseState = {
  house: { id: 'shared-home', name: 'Casa', createdAt },
  membership: { role: 'member' as const, joinedAt: createdAt },
  members: [],
};
const recipeId = 'recipe-from-account';

const pendingCommand = (operationId: string, date: string): PlanCommand => ({
  version: 2,
  scope: accountScope,
  date,
  operationId,
  deviceId: 'account-device',
  clientUpdatedAt: createdAt,
  action: 'manual_set',
  recipeId,
});

const stateFor = (command: PlanCommand, serverSequence: number): PlanState => {
  const base = {
    date: command.date,
    revision: serverSequence === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    serverSequence,
  };
  return command.action === 'manual_delete'
    ? { ...base, kind: 'deleted', recipeId: null }
    : { ...base, kind: 'manual', recipeId: command.recipeId };
};

describe('account-to-house meal plan outbox reconciliation', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    setActiveDataScope('guest');
    setPersonalDataScope('guest');
  });

  it('imports pending account plan commands in local order without blocking other account mutations or house bootstrap', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);

    const first = pendingCommand('account-plan-first', '2026-10-30');
    const second = pendingCommand('account-plan-second', '2026-10-31');
    const sameDateLast = pendingCommand('account-plan-same-date-last', '2026-10-30');
    await enqueueMealPlanCommand(accountScope, first, {
      optimisticState: { ...stateFor(first, 0), revision: '33333333-3333-4333-8333-333333333333' },
    });
    await enqueueMealPlanCommand(accountScope, second, {
      optimisticState: { ...stateFor(second, 0), revision: '44444444-4444-4444-8444-444444444444' },
    });
    await enqueueMealPlanCommand(accountScope, sameDateLast, {
      optimisticState: { ...stateFor(sameDateLast, 0), revision: '88888888-8888-4888-8888-888888888888' },
    });
    const otherAccountScope = 'account:other-owner' as const;
    const otherAccountCommand = { ...pendingCommand('other-account-plan', '2026-11-02'), scope: otherAccountScope };
    await enqueueMealPlanCommand(otherAccountScope, otherAccountCommand, {
      optimisticState: { ...stateFor(otherAccountCommand, 0), revision: '55555555-5555-4555-8555-555555555555' },
    });
    const shopping: SyncMutation = {
      mutationId: 'account-shopping-pending',
      deviceId: 'account-device',
      entityType: 'shopping_list_item',
      entityId: 'shopping-pasta',
      operation: 'upsert',
      payload: {
        id: 'shopping-pasta', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack',
        note: null, purchased: false, sourceRecipeId: null, createdAt, updatedAt: createdAt,
      },
      clientUpdatedAt: createdAt,
      syncScope: accountScope,
    };
    await enqueueMutation(accountScope, shopping);

    const importedPlanStates = new Map<string, PlanState>();
    const requestMock = vi.fn(async (path: string, options?: { body?: unknown }) => {
      if (path === '/v1/house') return houseState;
      if (path === '/v1/house/account-queue/import') return undefined;
      if (path === '/v1/meal-plan/capabilities') return { version: 2, syncReadVersion: 2 };
      if (path === '/v1/meal-plan/import') {
        const body = options?.body as { items: Array<{ sourceId: string; localRevision: string; command: PlanCommand }> };
        const results = body.items.map((item, index) => {
          const state = stateFor(item.command, index + 1);
          importedPlanStates.set(item.command.date, state);
          return {
            sourceId: item.sourceId,
            localRevision: item.localRevision,
            result: { version: 2, operationId: item.command.operationId, outcome: 'applied', current: state },
          };
        });
        return { version: 2, results };
      }
      if (path === '/v1/meal-plan/read') {
        const body = options?.body as { dates: string[] };
        return { version: 2, states: body.dates.map((date) => ({ date, state: importedPlanStates.get(date) ?? null })) };
      }
      if (path === '/v1/sync') return { changes: [], nextCursor: 0 };
      throw new Error(`Unexpected request ${path}`);
    });
    const request = requestMock as unknown as ApiRequest;

    await expect(initializeSessionScope(session, request)).resolves.toMatchObject({ state: houseState });
    await expect(syncNow({ session, request })).resolves.toMatchObject({ complete: true, pending: 0 });

    expect(getActiveDataScope()).toBe(houseScope);
    expect(getPersonalDataScope()).toBe(accountScope);
    const accountQueueImport = requestMock.mock.calls.find(([path]) => path === '/v1/house/account-queue/import');
    expect(accountQueueImport?.[1]).toMatchObject({ body: { mutations: [expect.objectContaining({
      mutationId: shopping.mutationId,
      entityType: 'shopping_list_item',
      syncScope: accountScope,
    })] } });
    const planImport = requestMock.mock.calls.find(([path]) => path === '/v1/meal-plan/import');
    expect(planImport?.[1]).toMatchObject({
      method: 'POST',
      csrfToken: session.csrfToken,
      body: {
        version: 2,
        scope: houseScope,
        items: [
          {
            source: 'account',
            sourceId: 'account-plan-first',
            localRevision: '1',
            command: { ...first, scope: houseScope },
          },
          {
            source: 'account',
            sourceId: 'account-plan-second',
            localRevision: '2',
            command: { ...second, scope: houseScope },
          },
          {
            source: 'account',
            sourceId: 'account-plan-same-date-last',
            localRevision: '3',
            command: { ...sameDateLast, scope: houseScope },
          },
        ],
      },
    });
    const importedItems = (planImport?.[1]?.body as { items: Array<Record<string, unknown>> } | undefined)?.items;
    expect(importedItems?.[0]).not.toHaveProperty('provenance');
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
    await expect(readMealPlanOutbox([accountScope])).resolves.toEqual([]);
    await expect(readMealPlanOutbox([otherAccountScope])).resolves.toHaveLength(1);
    await expect(readMealPlanOutbox([houseScope])).resolves.toEqual([]);
    await expect(readMealPlanSnapshot(houseScope)).resolves.toMatchObject({
      states: {
        '2026-10-30': expect.objectContaining({ recipeId, serverSequence: 3 }),
        '2026-10-31': expect.objectContaining({ recipeId, serverSequence: 2 }),
      },
    });
  });

  it('retains an account command after a lost import response and retries the identical receipt without blocking normal sync', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const command = pendingCommand('account-plan-lost-response', '2026-11-01');
    await enqueueMealPlanCommand(accountScope, command, {
      optimisticState: { ...stateFor(command, 0), revision: '33333333-3333-4333-8333-333333333333' },
    });
    const serverState = stateFor(command, 1);
    const importedStates = new Map<string, PlanState>();
    const importBodies: unknown[] = [];
    let importAttempts = 0;
    let syncRequests = 0;
    const requestMock = vi.fn(async (path: string, options?: { body?: unknown }) => {
      if (path === '/v1/house') return houseState;
      if (path === '/v1/house/account-queue/import') return undefined;
      if (path === '/v1/meal-plan/capabilities') return { version: 2, syncReadVersion: 2 };
      if (path === '/v1/meal-plan/import') {
        importBodies.push(structuredClone(options?.body));
        importAttempts += 1;
        const body = options?.body as { items: Array<{ sourceId: string; localRevision: string; command: PlanCommand }> };
        for (const item of body.items) importedStates.set(item.command.date, serverState);
        if (importAttempts === 1) throw new Error('Response lost after server commit');
        return {
          version: 2,
          results: body.items.map((item) => ({
            sourceId: item.sourceId,
            localRevision: item.localRevision,
            result: { version: 2, operationId: item.command.operationId, outcome: 'applied', current: serverState },
          })),
        };
      }
      if (path === '/v1/meal-plan/read') {
        const body = options?.body as { dates: string[] };
        return { version: 2, states: body.dates.map((date) => ({ date, state: importedStates.get(date) ?? null })) };
      }
      if (path === '/v1/sync') {
        syncRequests += 1;
        return { changes: [], nextCursor: 0 };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const request = requestMock as unknown as ApiRequest;
    await initializeSessionScope(session, request);

    await expect(syncNow({ session, request })).resolves.toMatchObject({ complete: false, pending: 1 });
    await expect(readMealPlanOutbox([accountScope])).resolves.toHaveLength(1);
    expect(syncRequests).toBe(1);

    await expect(syncNow({ session, request })).resolves.toMatchObject({ complete: true, pending: 0 });
    await expect(readMealPlanOutbox([accountScope])).resolves.toEqual([]);
    expect(importAttempts).toBe(2);
    expect(importBodies[1]).toEqual(importBodies[0]);
    expect(syncRequests).toBe(2);
    await expect(readMealPlanSnapshot(houseScope)).resolves.toMatchObject({
      states: { '2026-11-01': expect.objectContaining({ recipeId, serverSequence: 1 }) },
    });
  });

  it('does not commit an import receipt after the session and active House scope change in flight', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const command = pendingCommand('account-plan-session-change', '2026-11-03');
    await enqueueMealPlanCommand(accountScope, command, {
      optimisticState: { ...stateFor(command, 0), revision: '66666666-6666-4666-8666-666666666666' },
    });
    const serverState = stateFor(command, 1);
    let sessionCurrent = true;
    let syncRequests = 0;
    const requestMock = vi.fn(async (path: string, options?: { body?: unknown }) => {
      if (path === '/v1/house') return houseState;
      if (path === '/v1/house/account-queue/import') return undefined;
      if (path === '/v1/meal-plan/capabilities') return { version: 2, syncReadVersion: 2 };
      if (path === '/v1/meal-plan/import') {
        const body = options?.body as { items: Array<{ sourceId: string; localRevision: string; command: PlanCommand }> };
        sessionCurrent = false;
        setActiveDataScope('house:other-home');
        setPersonalDataScope('account:other-owner');
        return {
          version: 2,
          results: body.items.map((item) => ({
            sourceId: item.sourceId,
            localRevision: item.localRevision,
            result: { version: 2, operationId: item.command.operationId, outcome: 'applied', current: serverState },
          })),
        };
      }
      if (path === '/v1/sync') {
        syncRequests += 1;
        return { changes: [], nextCursor: 0 };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const request = requestMock as unknown as ApiRequest;
    await initializeSessionScope(session, request);

    await expect(syncNow({ session, request, isSessionCurrent: () => sessionCurrent })).rejects.toThrow();
    expect(syncRequests).toBe(0);
    expect(getActiveDataScope()).toBe('house:other-home');
    await expect(readMealPlanOutbox([accountScope])).resolves.toHaveLength(1);
    await expect(readMealPlanSnapshot(houseScope)).resolves.toMatchObject({ states: {} });
  });

  it('keeps the outbox and stops sync when House authorization is revoked during account recovery', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const command = pendingCommand('account-plan-revoked-house', '2026-11-04');
    await enqueueMealPlanCommand(accountScope, command, {
      optimisticState: { ...stateFor(command, 0), revision: '77777777-7777-4777-8777-777777777777' },
    });
    let syncRequests = 0;
    const requestMock = vi.fn(async (path: string) => {
      if (path === '/v1/house') return houseState;
      if (path === '/v1/house/account-queue/import') return undefined;
      if (path === '/v1/meal-plan/capabilities') return { version: 2, syncReadVersion: 2 };
      if (path === '/v1/meal-plan/import') throw new ApiClientError(403, 'house_membership_required', 'Membership revoked');
      if (path === '/v1/sync') {
        syncRequests += 1;
        return { changes: [], nextCursor: 0 };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const request = requestMock as unknown as ApiRequest;
    await initializeSessionScope(session, request);

    await expect(syncNow({ session, request })).rejects.toThrow('Membership revoked');
    expect(syncRequests).toBe(0);
    await expect(readMealPlanOutbox([accountScope])).resolves.toHaveLength(1);
  });

  it('stores a server conflict in the target House for later user resolution before acknowledging the source command', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const command = pendingCommand('account-plan-conflict', '2026-11-05');
    await enqueueMealPlanCommand(accountScope, command, {
      optimisticState: { ...stateFor(command, 0), revision: '99999999-9999-4999-8999-999999999999' },
    });
    const serverState: PlanState = {
      date: command.date,
      revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      serverSequence: 1,
      kind: 'manual',
      recipeId: 'house-kept-recipe',
    };
    const requestMock = vi.fn(async (path: string, options?: { body?: unknown }) => {
      if (path === '/v1/house') return houseState;
      if (path === '/v1/house/account-queue/import') return undefined;
      if (path === '/v1/meal-plan/capabilities') return { version: 2, syncReadVersion: 2 };
      if (path === '/v1/meal-plan/import') {
        const body = options?.body as { items: Array<{ sourceId: string; localRevision: string; command: PlanCommand }> };
        return {
          version: 2,
          results: body.items.map((item) => ({
            sourceId: item.sourceId,
            localRevision: item.localRevision,
            result: { version: 2, operationId: item.command.operationId, outcome: 'conflict', current: serverState },
          })),
        };
      }
      if (path === '/v1/meal-plan/read') return { version: 2, states: [{ date: command.date, state: serverState }] };
      if (path === '/v1/sync') return { changes: [], nextCursor: 0 };
      throw new Error(`Unexpected request ${path}`);
    });
    const request = requestMock as unknown as ApiRequest;
    await initializeSessionScope(session, request);

    await expect(syncNow({ session, request })).resolves.toMatchObject({ complete: true, pending: 0 });
    await expect(readMealPlanOutbox([accountScope])).resolves.toEqual([]);
    await expect(readMealPlanSnapshot(houseScope)).resolves.toMatchObject({
      states: { '2026-11-05': serverState },
      conflicts: [expect.objectContaining({
        id: command.operationId,
        command: { ...command, scope: houseScope },
        current: serverState,
        sourceScope: accountScope,
        sourceRevision: '1',
      })],
    });
  });

  it('retains the source outbox when the import response does not match its receipt identity', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const command = pendingCommand('account-plan-invalid-receipt', '2026-11-06');
    await enqueueMealPlanCommand(accountScope, command, {
      optimisticState: { ...stateFor(command, 0), revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    });
    const invalidState = stateFor(command, 1);
    const requestMock = vi.fn(async (path: string, options?: { body?: unknown }) => {
      if (path === '/v1/house') return houseState;
      if (path === '/v1/house/account-queue/import') return undefined;
      if (path === '/v1/meal-plan/capabilities') return { version: 2, syncReadVersion: 2 };
      if (path === '/v1/meal-plan/import') {
        const body = options?.body as { items: Array<{ sourceId: string; localRevision: string; command: PlanCommand }> };
        return {
          version: 2,
          results: body.items.map((item) => ({
            sourceId: 'receipt-for-a-different-source',
            localRevision: item.localRevision,
            result: { version: 2, operationId: item.command.operationId, outcome: 'applied', current: invalidState },
          })),
        };
      }
      if (path === '/v1/sync') return { changes: [], nextCursor: 0 };
      throw new Error(`Unexpected request ${path}`);
    });
    const request = requestMock as unknown as ApiRequest;
    await initializeSessionScope(session, request);

    await expect(syncNow({ session, request })).resolves.toMatchObject({ complete: false, pending: 1 });
    await expect(readMealPlanOutbox([accountScope])).resolves.toHaveLength(1);
    await expect(readMealPlanSnapshot(houseScope)).resolves.toMatchObject({ states: {}, conflicts: [] });
  });
});
