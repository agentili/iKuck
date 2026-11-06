import { describe, expect, it } from 'vitest';
import { parseSyncMutation } from './validation.js';

const mutation = {
  mutationId: 'plan-1', deviceId: 'device-1', entityType: 'meal_plan_entry',
  entityId: '2024-02-29', operation: 'upsert',
  payload: { date: '2024-02-29', recipeId: 'recipe-1' },
  clientUpdatedAt: '2024-02-29T12:00:00.000Z', syncScope: 'account:user-1',
};

describe('meal plan mutation validation', () => {
  it('accepts a valid leap-day selection', () => {
    expect(parseSyncMutation(mutation)).toMatchObject(mutation);
  });

  it('rejects invalid dates, mismatched IDs, unexpected fields and invalid recipe IDs', () => {
    const invalid = [
      { ...mutation, entityId: '2023-02-29', payload: { date: '2023-02-29', recipeId: 'r' } },
      { ...mutation, entityId: '2024-02-28' },
      { ...mutation, payload: { ...mutation.payload, origin: 'automatic' } },
      { ...mutation, payload: { ...mutation.payload, recipeId: '  ' } },
      { ...mutation, payload: { ...mutation.payload, recipeId: 'x'.repeat(129) } },
      { ...mutation, operation: 'delete', payload: null, entityId: 'not-a-date' },
      { ...mutation, operation: 'delete', payload: mutation.payload },
    ];
    for (const entry of invalid) expect(parseSyncMutation(entry)).toBeNull();
  });

  it('accepts a tombstone and trims a valid recipe identifier', () => {
    expect(parseSyncMutation({ ...mutation, operation: 'delete', payload: null })).toMatchObject({ operation: 'delete', payload: null });
    expect(parseSyncMutation({ ...mutation, payload: { ...mutation.payload, recipeId: ' recipe ' } })).toMatchObject({ payload: { recipeId: 'recipe' } });
  });
});
