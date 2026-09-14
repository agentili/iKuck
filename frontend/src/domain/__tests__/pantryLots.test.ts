import { describe, expect, it } from 'vitest';
import {
  aggregatePantryLots,
  getExpiryStatus,
  getQuantityWarning,
  validatePantryLotDetails,
} from '../pantryLots';
import type { PantryLot } from '@ikuck/shared/contracts';

const lot = (overrides: Partial<PantryLot> = {}): PantryLot => ({
  id: 'lot-1',
  ingredientId: 'pasta',
  label: 'Pasta',
  known: true,
  quantity: null,
  unit: null,
  expiresAt: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z',
  ...overrides,
});

describe('pantry lot domain', () => {
  it('accepts a presence-only lot', () => {
    expect(validatePantryLotDetails(null, null, null)).toEqual([]);
    expect(aggregatePantryLots([lot()])[0]).toMatchObject({
      lotCount: 1,
      totalQuantity: null,
      totalUnit: null,
    });
  });

  it('rejects a non-positive quantity and a quantity without a unit', () => {
    expect(validatePantryLotDetails(0, 'g', null)).toContain('quantity_positive');
    expect(validatePantryLotDetails(10, null, null)).toContain('unit_required');
    expect(validatePantryLotDetails(Number.NaN, 'g', null)).toContain('quantity_finite');
  });

  it('converts compatible mass units and keeps incompatible units separate', () => {
    const aggregate = aggregatePantryLots([
      lot({ id: 'lot-kg', quantity: 1, unit: 'kg', expiresAt: '2026-09-20' }),
      lot({ id: 'lot-g', quantity: 250, unit: 'g', expiresAt: '2026-09-18' }),
      lot({ id: 'lot-piece', quantity: 2, unit: 'piece' }),
    ])[0];

    expect(aggregate).toMatchObject({ totalQuantity: null, totalUnit: null, lotCount: 3 });
    expect(aggregate.quantities).toEqual([
      { quantity: 1, unit: 'kg' },
      { quantity: 250, unit: 'g' },
      { quantity: 2, unit: 'piece' },
    ]);
    expect(aggregate.earliestExpiresAt).toBe('2026-09-18');

    const massOnly = aggregatePantryLots([
      lot({ id: 'lot-kg', quantity: 1, unit: 'kg' }),
      lot({ id: 'lot-g', quantity: 250, unit: 'g' }),
    ])[0];
    expect(massOnly).toMatchObject({ totalQuantity: 1250, totalUnit: 'g' });
  });

  it('classifies expiry dates against an injected current date', () => {
    const today = new Date('2026-09-13T12:00:00.000Z');
    expect(getExpiryStatus(null, today)).toBe('unknown');
    expect(getExpiryStatus('2026-09-12', today)).toBe('expired');
    expect(getExpiryStatus('2026-09-16', today)).toBe('expiring_soon');
    expect(getExpiryStatus('2026-09-30', today)).toBe('okay');
  });

  it('compares expiry dates with the local civil date, not the UTC date', () => {
    class DateWithLocalDay extends Date {
      override getFullYear(): number {
        return 2026;
      }

      override getMonth(): number {
        return 8;
      }

      override getDate(): number {
        return 14;
      }
    }

    const justAfterLocalMidnight = new DateWithLocalDay('2026-09-13T22:30:00.000Z');

    expect(getExpiryStatus('2026-09-13', justAfterLocalMidnight)).toBe('expired');
    expect(getExpiryStatus('2026-09-14', justAfterLocalMidnight)).toBe('expiring_soon');
  });

  it('warns when a recipe needs more compatible quantity without changing presence', () => {
    const aggregate = aggregatePantryLots([lot({ quantity: 100, unit: 'g' })])[0];
    expect(getQuantityWarning({ ingredientId: 'pasta', amount: '80 g' }, aggregate)).toBe(false);
    expect(getQuantityWarning({ ingredientId: 'pasta', amount: '200 g' }, aggregate)).toBe(true);
    expect(getQuantityWarning({ ingredientId: 'pasta', amount: 'q.b.' }, aggregate)).toBe(false);
  });
});
