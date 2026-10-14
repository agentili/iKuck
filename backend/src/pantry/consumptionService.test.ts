import { describe, expect, it } from 'vitest';
import type { CookEvent, PantryLot } from '@ikuck/shared/contracts';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { createMemorySyncRepository } from '../sync/repository.js';
import { createDinnerConsumptionService } from './consumptionService.js';

const now = '2026-10-07T10:00:00.000Z';
const houseScope = 'house:house-1' as const;
const command: DinnerConsumptionCommand = {
  operationId: 'operation-1',
  entryId: 'dinner-1',
  scope: houseScope,
  servings: 2,
  ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
};
const entry: DinnerEntry = {
  id: command.entryId,
  date: '2026-10-07',
  text: 'Pasta',
  servings: command.servings,
  note: null,
  recipes: [],
  authorId: null,
  createdAt: now,
  updatedAt: now,
};
const cookEvent: CookEvent = {
  id: command.entryId,
  recipeId: 'pasta-recipe',
  recipeTitle: 'Pasta',
  servings: command.servings,
  cookedAt: now,
  note: null,
  createdAt: now,
  updatedAt: now,
};
const lot: PantryLot = {
  id: 'pasta-lot',
  ingredientId: 'pasta',
  label: 'Pasta',
  known: true,
  quantity: 500,
  unit: 'g',
  expiresAt: null,
  createdAt: now,
  updatedAt: now,
};

const createService = () => {
  const repository = createMemorySyncRepository({
    clock: () => new Date(now),
    scopeResolver: async () => ({ kind: 'house', id: 'house-1' }),
  });
  return { repository, service: createDinnerConsumptionService({ repository }) };
};

const seedLot = async (repository: ReturnType<typeof createMemorySyncRepository>) => repository.applyMutation('member-1', {
  mutationId: 'seed-pasta-lot',
  deviceId: 'device-1',
  entityType: 'pantry_lot',
  entityId: lot.id,
  operation: 'upsert',
  payload: lot,
  clientUpdatedAt: now,
  syncScope: houseScope,
});

describe('dinner consumption service', () => {
  it('consumes current household stock and records the dinner projections exactly once', async () => {
    const { repository, service } = createService();
    await seedLot(repository);

    const first = await service.confirm('member-1', { command, entry, cookEvent });
    const retry = await service.confirm('member-2', { command, entry, cookEvent });
    const savedLot = await repository.readEntity('member-1', 'pantry_lot', lot.id);
    const changes = await repository.readChanges('member-2', 0, 100, houseScope);

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(first.pantrySnapshot.pantryLots).toEqual([{ ...lot, quantity: 300, updatedAt: first.receipt.committedAt }]);
    expect(savedLot?.payload).toEqual(first.pantrySnapshot.pantryLots[0]);
    expect(changes.filter((change) => change.entityType === 'dinner_entry')).toHaveLength(1);
    expect(changes.filter((change) => change.entityType === 'cook_event')).toHaveLength(1);
    expect(retry.receipt).toEqual(first.receipt);
  });
});
