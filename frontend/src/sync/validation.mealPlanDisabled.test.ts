import { describe, expect, it } from 'vitest';
import { parseSyncMutation } from './validation';

describe('unsupported meal plan sync mutations', () => {
  it.each(['upsert', 'delete'] as const)('rejects %s until the client supports the capability', (operation) => {
    expect(parseSyncMutation({
      mutationId: 'mutation-1',
      deviceId: 'device-1',
      entityType: 'meal_plan_entry',
      entityId: '2026-10-29',
      operation,
      payload: operation === 'delete' ? null : { date: '2026-10-29', recipeId: 'pollo-al-limone' },
      clientUpdatedAt: '2026-10-28T12:00:00.000Z',
    })).toBeNull();
  });
});
