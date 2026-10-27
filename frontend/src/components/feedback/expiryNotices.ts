import type { PantryLot } from '@ikuck/shared/contracts';

const localDate = (date: Date): string => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');

export function expiryNotices(lots: readonly PantryLot[], now = new Date()) {
  const today = localDate(now);
  const deadline = new Date(now);
  deadline.setDate(deadline.getDate() + 3);
  const soon = localDate(deadline);
  return lots.flatMap((lot) => {
    if (!lot.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(lot.expiresAt) || lot.expiresAt > soon) return [];
    const state = lot.expiresAt < today ? 'scaduto' : 'in scadenza';
    return [{
      key: JSON.stringify([lot.id, lot.expiresAt, state]),
      message: `${lot.label}: ${state} (${lot.expiresAt.split('-').reverse().join('/')}).`,
    }];
  });
}
