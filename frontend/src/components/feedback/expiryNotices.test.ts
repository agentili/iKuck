import { afterEach, expect, it, vi } from 'vitest';
import type { PantryLot } from '@ikuck/shared/contracts';
import { expiryNotices } from './expiryNotices';

const lot = (id: string, expiresAt: string | null): PantryLot => ({ id, ingredientId: id, label: id, known: true, quantity: null, unit: null, expiresAt, createdAt: '', updatedAt: '' });
afterEach(() => vi.restoreAllMocks());

it('uses local calendar days, includes today and three days ahead, and excludes later lots', () => {
  const now = new Date(2026, 9, 26, 23, 30);
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-27T01:30:00.000Z');
  const notices = expiryNotices([lot('Ieri', '2026-10-25'), lot('Oggi', '2026-10-26'), lot('Presto', '2026-10-29'), lot('Dopo', '2026-10-30'), lot('Senza data', null)], now);
  expect(notices.map((notice) => notice.message)).toEqual(['Ieri: scaduto (25/10/2026).', 'Oggi: in scadenza (26/10/2026).', 'Presto: in scadenza (29/10/2026).']);
});

it('changes the deduplication key when a lot expires or its expiry is edited', () => {
  const lots = [lot('Latte', '2026-10-26')];
  const today = expiryNotices(lots, new Date(2026, 9, 26))[0];
  expect(expiryNotices(lots, new Date(2026, 9, 27))[0].key).not.toBe(today.key);
  expect(expiryNotices([lot('Latte', '2026-10-27')], new Date(2026, 9, 26))[0].key).not.toBe(today.key);
});
