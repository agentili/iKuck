import { describe, expect, it } from 'vitest';
import { planPantryConsumption, parsePantryQuantity, type DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { PantryLot } from '@ikuck/shared/contracts';

const lot = (overrides: Partial<PantryLot> = {}): PantryLot => ({
  id: 'flour-lot',
  ingredientId: 'flour',
  label: 'Farina',
  known: true,
  quantity: 500,
  unit: 'g',
  expiresAt: '2026-12-01',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  ...overrides,
});

const command = (requiredGrams: number, servings = 1): DinnerConsumptionCommand => ({
  operationId: 'operation-1',
  entryId: 'dinner-1',
  scope: 'guest',
  servings,
  ingredients: [{ ingredientId: 'flour', name: 'Farina', amount: `${requiredGrams} g`, optional: false, used: true }],
});

describe('shared pantry consumption planner', () => {
  it('separates certain full amounts from permissive warning prefixes', () => {
    const amount = '200 g chopped tomatoes';

    expect(parsePantryQuantity(amount)).toBeNull();
    expect(parsePantryQuantity(amount, 'prefix')).toEqual({ quantity: 200, unit: 'g' });
    expect(parsePantryQuantity('q.b.', 'prefix')).toBeNull();
  });

  it('scales a certain ingredient amount by servings and keeps the lot residual', () => {
    const initial = lot();
    const requiredGrams = 80;
    const servings = 3;
    const updatedAt = '2026-10-07T08:00:00.000Z';
    const result = planPantryConsumption({ lots: [initial], command: command(requiredGrams, servings), updatedAt });

    expect(result.upsertLots).toEqual([{
      ...initial,
      quantity: initial.quantity! - requiredGrams * servings,
      updatedAt,
    }]);
    expect(result.deleteLotIds).toEqual([]);
    expect(result.summary.lines[0]).toMatchObject({
      ingredientId: initial.ingredientId,
      status: 'consumed',
      requiredQuantity: requiredGrams * servings,
      consumedQuantity: requiredGrams * servings,
      unit: initial.unit,
      deficit: 0,
      lotIds: [initial.id],
    });
    expect(result.missingIngredients).toEqual([]);
    expect(result.unresolvedIngredients).toEqual([]);
  });

  it('allocates across compatible lots by expiry, creation time, and id', () => {
    const earliestExpiry = lot({ id: 'expiry-first', quantity: 0.25, unit: 'kg', expiresAt: '2026-10-20' });
    const earliestCreatedIdZ = lot({ id: 'created-z', quantity: 200, unit: 'g', expiresAt: '2026-10-21', createdAt: '2026-02-01T10:00:00.000Z' });
    const earliestCreatedIdA = lot({ id: 'created-a', quantity: 100, unit: 'g', expiresAt: '2026-10-21', createdAt: '2026-02-01T10:00:00.000Z' });
    const laterCreated = lot({ id: 'created-later', quantity: 500, unit: 'g', expiresAt: '2026-10-21', createdAt: '2026-03-01T10:00:00.000Z' });
    const laterExpiry = lot({ id: 'expiry-later', quantity: 900, unit: 'g', expiresAt: '2026-10-22' });
    const noExpiry = lot({ id: 'expiry-null', quantity: 900, unit: 'g', expiresAt: null });
    const orderedLots = [noExpiry, laterCreated, earliestCreatedIdZ, laterExpiry, earliestExpiry, earliestCreatedIdA];
    const requiredGrams = 620;
    const result = planPantryConsumption({
      lots: orderedLots,
      command: command(requiredGrams),
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.summary.lines[0].lotIds).toEqual([earliestExpiry.id, earliestCreatedIdA.id, earliestCreatedIdZ.id, laterCreated.id]);
    expect(result.deleteLotIds).toEqual([earliestExpiry.id, earliestCreatedIdA.id, earliestCreatedIdZ.id]);
    expect(result.upsertLots).toEqual([{
      ...laterCreated,
      quantity: laterCreated.quantity! - (requiredGrams - earliestExpiry.quantity! * 1000 - earliestCreatedIdA.quantity! - earliestCreatedIdZ.quantity!),
      updatedAt: '2026-10-07T08:00:00.000Z',
    }]);
  });

  it('converts liters and milliliters without mixing volume with mass', () => {
    const first = lot({ id: 'oil-first', ingredientId: 'oil', quantity: 0.75, unit: 'l', expiresAt: '2026-10-01' });
    const second = lot({ id: 'oil-second', ingredientId: 'oil', quantity: 400, unit: 'ml', expiresAt: '2026-11-01' });
    const requiredLiters = 1;
    const result = planPantryConsumption({
      lots: [second, first],
      command: {
        ...command(requiredLiters),
        ingredients: [{ ingredientId: 'oil', name: 'Olio', amount: `${requiredLiters} l`, optional: false, used: true }],
      },
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.summary.lines[0]).toMatchObject({ consumedQuantity: requiredLiters, unit: 'l', deficit: 0, lotIds: [first.id, second.id] });
    expect(result.deleteLotIds).toEqual([first.id]);
    expect(result.upsertLots).toEqual([{ ...second, quantity: second.quantity! - (requiredLiters * 1000 - first.quantity! * 1000), updatedAt: '2026-10-07T08:00:00.000Z' }]);
  });

  it('consumes an optional ingredient only when explicitly marked used', () => {
    const unusedStock = lot({ id: 'unused-sugar', ingredientId: 'sugar', quantity: 200, unit: 'g' });
    const usedStock = lot({ id: 'used-oil', ingredientId: 'oil', quantity: 2, unit: 'l' });
    const result = planPantryConsumption({
      lots: [unusedStock, usedStock],
      command: {
        ...command(1),
        ingredients: [
          { ingredientId: 'sugar', name: 'Zucchero', amount: '50 g', optional: true, used: false },
          { ingredientId: 'oil', name: 'Olio', amount: '250 ml', optional: true, used: true },
        ],
      },
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.upsertLots).toEqual([{ ...usedStock, quantity: usedStock.quantity! - 0.25, updatedAt: '2026-10-07T08:00:00.000Z' }]);
    expect(result.summary.lines.map(({ status }) => status)).toEqual(['unused', 'consumed']);
    expect(unusedStock.quantity).toBe(200);
  });

  it('removes a used presence-only lot without fabricating a quantity', () => {
    const presence = lot({ id: 'garlic-presence', ingredientId: 'garlic', quantity: null, unit: null });
    const result = planPantryConsumption({
      lots: [presence],
      command: {
        ...command(1),
        ingredients: [{ ingredientId: 'garlic', name: 'Aglio', amount: 'q.b.', optional: false, used: true }],
      },
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.upsertLots).toEqual([]);
    expect(result.deleteLotIds).toEqual([presence.id]);
    expect(result.summary.lines[0]).toMatchObject({ status: 'presence_consumed', requiredQuantity: null, consumedQuantity: null, unit: null, deficit: null });
    expect(presence.quantity).toBeNull();
  });

  it('reports a deficit while exhausting available stock without going negative', () => {
    const stock = lot({ id: 'short-flour', quantity: 0.45, unit: 'kg' });
    const amountPerServing = 300;
    const servings = 2;
    const availableGrams = stock.quantity! * 1000;
    const requiredGrams = amountPerServing * servings;
    const result = planPantryConsumption({
      lots: [stock],
      command: command(amountPerServing, servings),
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.upsertLots).toEqual([]);
    expect(result.deleteLotIds).toEqual([stock.id]);
    expect(result.summary.lines[0]).toMatchObject({ status: 'partial', requiredQuantity: requiredGrams, consumedQuantity: availableGrams, unit: 'g', deficit: requiredGrams - availableGrams });
    expect(result.missingIngredients[0]?.deficit).toBe(requiredGrams - availableGrams);
  });

  it('leaves quantified stock unchanged when the amount is ambiguous or the units are incompatible', () => {
    const flour = lot({ id: 'flour-stock', quantity: 1, unit: 'kg' });
    const oil = lot({ id: 'oil-stock', ingredientId: 'oil', quantity: 500, unit: 'ml' });
    const result = planPantryConsumption({
      lots: [flour, oil],
      command: {
        ...command(1),
        ingredients: [
          { ingredientId: 'flour', name: 'Farina', amount: '200 g tritata', optional: false, used: true },
          { ingredientId: 'oil', name: 'Olio', amount: '50 g', optional: false, used: true },
        ],
      },
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.upsertLots).toEqual([]);
    expect(result.deleteLotIds).toEqual([]);
    expect(result.unresolvedIngredients.map(({ reason }) => reason)).toEqual(['amount_ambiguous', 'unit_incompatible']);
    expect(flour.quantity).toBe(1);
    expect(oil.quantity).toBe(500);
  });

  it('reports identified ingredients missing from the snapshot and unresolved identities', () => {
    const result = planPantryConsumption({
      lots: [],
      command: {
        ...command(1),
        ingredients: [
          { ingredientId: 'tomato', name: 'Pomodoro', amount: '2 piece', optional: false, used: true },
          { ingredientId: null, name: 'Ingrediente libero', amount: 'q.b.', optional: false, used: true },
        ],
      },
      updatedAt: '2026-10-07T08:00:00.000Z',
    });

    expect(result.missingIngredients).toEqual([{ ingredientId: 'tomato', name: 'Pomodoro', requiredQuantity: 2, unit: 'piece', deficit: 2 }]);
    expect(result.unresolvedIngredients).toEqual([{ ingredientId: null, name: 'Ingrediente libero', reason: 'ingredient_unidentified' }]);
  });
});
