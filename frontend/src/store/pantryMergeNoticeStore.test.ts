import { beforeEach, describe, expect, it } from 'vitest';
import { usePantryMergeNoticeStore } from './pantryMergeNoticeStore';

describe('pantry merge notice store', () => {
  beforeEach(() => usePantryMergeNoticeStore.getState().clear());

  it('stores a non-blocking merge summary and dismisses it', () => {
    usePantryMergeNoticeStore.getState().show({
      addedLots: 2,
      mergedLots: 1,
      mergedGroups: 1,
      importedStaples: 3,
    });

    expect(usePantryMergeNoticeStore.getState().summary).toEqual({
      addedLots: 2,
      mergedLots: 1,
      mergedGroups: 1,
      importedStaples: 3,
    });

    usePantryMergeNoticeStore.getState().clear();
    expect(usePantryMergeNoticeStore.getState().summary).toBeNull();
  });
});
