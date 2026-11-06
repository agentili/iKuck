import { describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../api/apiClient';
import { createMealPlanApi } from './api';

const request = vi.fn<ApiRequest>();

describe('meal plan API client', () => {
  it('negotiates v2 before reading or writing the shared plan', async () => {
    request.mockResolvedValueOnce({ version: 2, syncReadVersion: 2 });
    const api = createMealPlanApi(request as unknown as ApiRequest);

    await expect(api.getCapabilities()).resolves.toEqual({ version: 2, syncReadVersion: 2 });
    expect(request).toHaveBeenCalledWith('/v1/meal-plan/capabilities');
  });

  it('uses the versioned command endpoint and validates its receipt', async () => {
    const command = {
      version: 2 as const, scope: 'account:user-1' as const, date: '2026-10-29', operationId: 'op-1',
      deviceId: 'device-1', clientUpdatedAt: '2026-10-28T12:00:00.000Z', action: 'manual_delete' as const,
    };
    request.mockResolvedValueOnce({ version: 2, operationId: 'op-1', outcome: 'applied', current: {
      date: command.date, revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 1,
      kind: 'deleted', recipeId: null,
    } });
    const api = createMealPlanApi(request as unknown as ApiRequest);

    await expect(api.sendCommand(command, 'csrf-token')).resolves.toMatchObject({ outcome: 'applied' });
    expect(request).toHaveBeenCalledWith('/v1/meal-plan/commands', {
      method: 'POST', csrfToken: 'csrf-token', body: command,
    });
  });

  it('rejects a malformed successful response instead of trusting its contents', async () => {
    request.mockResolvedValueOnce({ version: 1, states: [] });
    const api = createMealPlanApi(request as unknown as ApiRequest);

    await expect(api.readStates('house:house-1', ['2026-10-29'], 'csrf-token')).rejects.toThrow(/risposta/i);
  });

  it('reads a scoped v2 sync page from the requested cursor without uploading mutations', async () => {
    const state = {
      date: '2020-01-01', revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 9,
      kind: 'deleted', recipeId: null,
    };
    request.mockResolvedValueOnce({
      changes: [{
        mutationId: 'change-9', deviceId: 'device-1', entityType: 'meal_plan_entry', entityId: state.date,
        operation: 'upsert', payload: state, clientUpdatedAt: '2020-01-01T12:00:00.000Z',
        syncScope: 'house:house-1', serverSequence: 9,
      }],
      nextCursor: 9,
    });
    const api = createMealPlanApi(request as unknown as ApiRequest);

    await expect(api.readSyncPage('house:house-1', 'device-1', 0, 'csrf-token')).resolves.toEqual({
      changes: [{ state, serverSequence: 9 }], nextCursor: 9,
    });
    expect(request).toHaveBeenCalledWith('/v1/sync', {
      method: 'POST', csrfToken: 'csrf-token', body: {
        deviceId: 'device-1', cursor: 0, syncScope: 'house:house-1', mutations: [],
        supportedEntityTypes: ['meal_plan_entry'], mealPlanReadVersion: 2,
      },
    });
  });

  it('rejects sync pages that contain another scope or do not advance a non-empty cursor', async () => {
    request.mockResolvedValueOnce({
      changes: [{
        mutationId: 'change-9', deviceId: 'device-1', entityType: 'meal_plan_entry', entityId: '2020-01-01',
        operation: 'upsert', payload: {
          date: '2020-01-01', revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 9,
          kind: 'manual', recipeId: 'recipe',
        }, clientUpdatedAt: '2020-01-01T12:00:00.000Z',
        syncScope: 'account:other-user', serverSequence: 9,
      }], nextCursor: 0,
    });
    const api = createMealPlanApi(request as unknown as ApiRequest);

    await expect(api.readSyncPage('house:house-1', 'device-1', 0, 'csrf-token')).rejects.toThrow(/sincronizzazione.*valida/i);
  });

  it('sends guest provenance in a bounded import batch and validates per-item receipts', async () => {
    const command = {
      version: 2 as const, scope: 'account:user-1' as const, date: '2020-01-01', operationId: 'guest-plan-2020-01-01-rev',
      deviceId: 'device-1', clientUpdatedAt: '2026-10-28T12:00:00.000Z', action: 'manual_set' as const, recipeId: 'recipe',
    };
    const current = {
      date: command.date, revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 10,
      kind: 'manual' as const, recipeId: 'recipe',
    };
    const item = { source: 'guest' as const, sourceId: command.date, localRevision: 'local-revision', command };
    request.mockResolvedValueOnce({
      version: 2,
      results: [{ sourceId: item.sourceId, localRevision: item.localRevision, result: {
        version: 2, operationId: command.operationId, outcome: 'applied', current,
      } }],
    });
    const api = createMealPlanApi(request as unknown as ApiRequest);

    await expect(api.importCommands('account:user-1', [item], 'csrf-token')).resolves.toMatchObject({
      results: [{ sourceId: command.date, localRevision: 'local-revision', result: { outcome: 'applied' } }],
    });
    expect(request).toHaveBeenCalledWith('/v1/meal-plan/import', {
      method: 'POST', csrfToken: 'csrf-token', body: { version: 2, scope: 'account:user-1', items: [item] },
    });
  });
});
