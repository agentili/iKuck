import { describe, expect, it } from 'vitest';
import { createMemorySyncRepository } from './repository.js';

describe('sync capability filtering', () => {
  it('filters unsupported types before applying the page limit', async () => {
    const repository = createMemorySyncRepository();
    for (let index = 0; index < 201; index += 1) {
      await repository.applyMutation('user-1', {
        mutationId: `hidden-${index}`, deviceId: 'device-1', entityType: 'staple_preference',
        entityId: `staple-${index}`, operation: 'upsert', payload: { enabled: true },
        clientUpdatedAt: '2026-01-01T00:00:00.000Z', syncScope: 'account:user-1',
      });
    }
    await repository.applyMutation('user-1', {
      mutationId: 'visible', deviceId: 'device-1', entityType: 'pantry_item',
      entityId: 'tomato', operation: 'upsert', payload: { id: 'tomato', label: 'Tomato', known: true },
      clientUpdatedAt: '2026-01-01T00:00:00.000Z', syncScope: 'account:user-1',
    });
    const page = await repository.readChanges('user-1', 0, 200, 'account:user-1', ['pantry_item']);
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ entityType: 'pantry_item', entityId: 'tomato' });
  });
});
