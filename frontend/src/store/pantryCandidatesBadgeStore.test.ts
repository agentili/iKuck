import { describe, expect, it, beforeEach } from 'vitest';
import { createPantryCandidatesBadgeStore } from './pantryCandidatesBadgeStore';

describe('pantryCandidatesBadgeStore', () => {
  let store: ReturnType<typeof createPantryCandidatesBadgeStore>;

  beforeEach(() => {
    store = createPantryCandidatesBadgeStore();
  });

  it('starts empty with no house', () => {
    const state = store.getState();
    expect(state.houseId).toBeNull();
    expect(state.pendingCount).toBe(0);
  });

  it('keeps the count when the same house is set again', () => {
    store.getState().setHouse('house-a');
    store.getState().setPendingCount(3);
    store.getState().setHouse('house-a');

    expect(store.getState().houseId).toBe('house-a');
    expect(store.getState().pendingCount).toBe(3);
  });

  it('resets the count when the house changes', () => {
    store.getState().setHouse('house-a');
    store.getState().setPendingCount(3);
    store.getState().setHouse('house-b');

    expect(store.getState().houseId).toBe('house-b');
    expect(store.getState().pendingCount).toBe(0);
  });

  it('sets the pending count', () => {
    store.getState().setHouse('house-a');
    store.getState().setPendingCount(5);

    expect(store.getState().pendingCount).toBe(5);
  });

  it('increments and decrements the pending count, never below zero', () => {
    store.getState().setHouse('house-a');
    store.getState().setPendingCount(2);
    store.getState().incrementPendingCount();
    expect(store.getState().pendingCount).toBe(3);
    store.getState().decrementPendingCount();
    expect(store.getState().pendingCount).toBe(2);
    store.getState().decrementPendingCount();
    store.getState().decrementPendingCount();
    expect(store.getState().pendingCount).toBe(0);
  });

  it('resets the store', () => {
    store.getState().setHouse('house-a');
    store.getState().setPendingCount(5);
    store.getState().reset();

    expect(store.getState().houseId).toBeNull();
    expect(store.getState().pendingCount).toBe(0);
  });

  it('clears the count when the house is removed', () => {
    store.getState().setHouse('house-a');
    store.getState().setPendingCount(3);
    store.getState().setHouse(null);

    expect(store.getState().houseId).toBeNull();
    expect(store.getState().pendingCount).toBe(0);
  });
});
