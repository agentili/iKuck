import { describe, expect, it } from 'vitest';
import { parsePantryQuantity, planPantryConsumption, type DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { PantryLot } from '@ikuck/shared/contracts';

const lot = (overrides: Partial<PantryLot> = {}): PantryLot => ({
  id: 'oil-lot',
  ingredientId: 'oil',
  label: 'Olio',
  known: true,
  quantity: 0.5,
  unit: 'l',
  expiresAt: '2026-10-01',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  ...overrides,
});

const requiredLiters = 0.8;
const command: DinnerConsumptionCommand = {
  operationId: 'operation-house-1',
  entryId: 'dinner-house-1',
  scope: 'house:house-42',
  servings: 1,
  ingredients: [{ ingredientId: 'oil', name: 'Olio', amount: `${requiredLiters} l`, optional: false, used: true }],
};

describe('shared pantry consumption from the backend package', () => {
  it('plans a house-scoped volume consumption across liters and milliliters', () => {
    const first = lot({ id: 'oil-liters' });
    const second = lot({ id: 'oil-milliliters', quantity: 350, unit: 'ml', expiresAt: '2026-11-01' });
    const requiredMilliliters = 0.8 * 1000;
    const result = planPantryConsumption({
      lots: [second, first],
      command,
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.deleteLotIds).toEqual([first.id]);
    expect(result.upsertLots).toEqual([{
      ...second,
      quantity: second.quantity! - (requiredMilliliters - first.quantity! * 1000),
      updatedAt: '2026-10-07T08:00:00.000Z',
    }]);
    expect(result.summary.lines[0]).toMatchObject({
      ingredientId: 'oil',
      status: 'consumed',
      requiredQuantity: requiredLiters,
      consumedQuantity: requiredLiters,
      unit: 'l',
      deficit: 0,
      lotIds: [first.id, second.id],
    });
    expect(first.quantity).toBe(0.5);
  });

  it('exposes separate certain and prefix-only quantity parsing', () => {
    expect(parsePantryQuantity('25 g chopped')).toBeNull();
    expect(parsePantryQuantity('25 g chopped', 'prefix')).toEqual({ quantity: 25, unit: 'g' });
  });
});
