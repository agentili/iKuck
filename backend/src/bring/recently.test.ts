import { describe, expect, it } from 'vitest';
import { diffRecentlySnapshot, recentlyItemKey, type RecentlySnapshotItem } from './recently.js';

const item = (overrides: Partial<RecentlySnapshotItem> = {}): RecentlySnapshotItem => ({
  listId: 'list-1',
  listName: 'Spesa',
  name: 'Milch',
  label: 'Latte',
  specification: '1 l',
  checkedOffAt: '2026-10-15T10:00:00.000Z',
  ...overrides,
});

describe('Bring recently snapshot diff', () => {
  it('uses the first sync as a baseline and does not backfill historical items', () => {
    expect(diffRecentlySnapshot(null, [item()])).toEqual({ baseline: true, added: [] });
  });

  it('finds an offline check-off even when its timestamp predates the previous watermark', () => {
    const watermarkAt = '2026-10-15T12:00:00.000Z';
    const historical = item({ name: 'Yogurt', label: 'Yogurt', checkedOffAt: '2026-10-15T09:00:00.000Z' });
    const delta = diffRecentlySnapshot([item()], [item(), historical]);

    expect(Date.parse(historical.checkedOffAt)).toBeLessThan(Date.parse(watermarkAt));
    expect(delta).toEqual({ baseline: false, added: [historical] });
  });

  it('does not treat an unchanged recently snapshot as new work on retry', () => {
    const snapshot = [item()];
    expect(diffRecentlySnapshot(snapshot, snapshot)).toEqual({ baseline: false, added: [] });
  });

  it('distinguishes the same remote item in different Bring lists', () => {
    expect(recentlyItemKey(item())).not.toBe(recentlyItemKey(item({ listId: 'list-2' })));
  });
});
