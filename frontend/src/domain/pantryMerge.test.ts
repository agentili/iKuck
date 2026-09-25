import { describe, expect, it } from 'vitest';
import type { PantryLot } from '@ikuck/shared/contracts';
import { mergePantryLots, mergePantrySnapshots } from '@ikuck/shared/pantryMerge';

const lot = (overrides: Partial<PantryLot> & Pick<PantryLot, 'id' | 'ingredientId' | 'label'>): PantryLot => ({
  id: overrides.id,
  ingredientId: overrides.ingredientId,
  label: overrides.label,
  known: overrides.known ?? true,
  quantity: overrides.quantity ?? null,
  unit: overrides.unit ?? null,
  expiresAt: overrides.expiresAt ?? null,
  createdAt: overrides.createdAt ?? '2026-09-24T10:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-09-24T10:00:00.000Z',
});

describe('shared pantry merge', () => {
  it('sums compatible duplicate quantities and keeps different expiries separate', () => {
    const result = mergePantryLots(
      [lot({ id: 'lot-a', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'kg', expiresAt: '2026-10-01' })],
      [
        lot({ id: 'lot-b', ingredientId: 'pasta', label: 'Pasta', quantity: 500, unit: 'g', expiresAt: '2026-10-01' }),
        lot({ id: 'lot-c', ingredientId: 'pasta', label: 'Pasta', quantity: 250, unit: 'g', expiresAt: '2026-11-01' }),
      ],
    );

    expect(result.lots).toEqual([
      expect.objectContaining({ id: 'lot-a', quantity: 1500, unit: 'g', expiresAt: '2026-10-01' }),
      expect.objectContaining({ id: 'lot-c', quantity: 250, unit: 'g', expiresAt: '2026-11-01' }),
    ]);
    expect(result.summary).toMatchObject({ mergedGroups: 1, mergedLots: 1 });
  });

  it('keeps same-id lots from different sources instead of dropping one quantity', () => {
    const result = mergePantryLots(
      [lot({ id: 'pasta', ingredientId: 'pasta', label: 'Pasta', quantity: 1000, unit: 'g' })],
      [lot({ id: 'pasta', ingredientId: 'pasta', label: 'Pasta', quantity: 500, unit: 'g', updatedAt: '2026-09-24T10:01:00.000Z' })],
    );

    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]).toMatchObject({ quantity: 1500, unit: 'g' });
  });

  it('orders same-id revisions by instant when timestamps use different offsets', () => {
    const result = mergePantryLots([], [
      lot({ id: 'offset', ingredientId: 'pasta', label: 'Pasta', quantity: 100, unit: 'g', updatedAt: '2026-09-12T10:00:00+02:00' }),
      lot({ id: 'offset', ingredientId: 'pasta', label: 'Pasta', quantity: 200, unit: 'g', updatedAt: '2026-09-12T09:30:00Z' }),
    ]);

    expect(result.lots).toEqual([expect.objectContaining({ id: 'offset', quantity: 200, updatedAt: '2026-09-12T09:30:00Z' })]);
  });

  it('does not invent quantity when merging a presence lot with a quantified lot', () => {
    const result = mergePantryLots(
      [lot({ id: 'presence', ingredientId: 'salt', label: 'Sale' })],
      [lot({ id: 'quantity', ingredientId: 'salt', label: 'Sale', quantity: 500, unit: 'g' })],
    );

    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]).toMatchObject({ quantity: 500, unit: 'g' });
  });

  it('merges unknown ingredients by normalized label and is idempotent by lot id', () => {
    const source = lot({ id: 'custom-a', ingredientId: 'custom:caffe', label: 'Caffè', known: false, quantity: 1, unit: 'pack' });
    const result = mergePantryLots([], [source, { ...source }, lot({
      id: 'custom-b', ingredientId: 'custom:coffee', label: ' caffe ', known: false, quantity: 2, unit: 'pack',
    })]);

    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]).toMatchObject({ quantity: 3, unit: 'pack' });
    expect(result.summary.mergedLots).toBe(1);
  });

  it('unions enabled staples without duplicating them', () => {
    const result = mergePantrySnapshots(
      { lots: [], stapleIds: ['salt'] },
      { lots: [], stapleIds: ['salt', 'water'] },
    );

    expect(result.stapleIds).toEqual(['salt', 'water']);
    expect(result.summary.importedStaples).toBe(1);
  });
});
