import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reportPersistenceMemoryOnly,
  reportPersistenceSaved,
  retryPersistence,
  trackPersistence,
  usePersistenceStatusStore,
} from '../persistenceStatusStore';

describe('persistence status store', () => {
  beforeEach(() => {
    usePersistenceStatusStore.getState().reset();
  });

  it('records a persistence failure with the last error and an explicit retry', async () => {
    const error = new Error('IndexedDB unavailable');
    const retry = vi.fn(async () => undefined);

    reportPersistenceMemoryOnly('pantry', error, retry);

    expect(usePersistenceStatusStore.getState().statuses.pantry).toMatchObject({
      state: 'memory-only',
      error,
    });
    await retryPersistence('pantry');
    expect(retry).toHaveBeenCalledOnce();
  });

  it('marks a successful retry as saved and clears the previous error', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);

    expect(await trackPersistence('diet', operation)).toBe(false);
    expect(usePersistenceStatusStore.getState().statuses.diet.state).toBe('memory-only');

    await retryPersistence('diet');

    expect(operation).toHaveBeenCalledTimes(2);
    expect(usePersistenceStatusStore.getState().statuses.diet).toMatchObject({
      state: 'saved',
      error: null,
      retry: null,
    });
  });

  it('allows stores to clear an obsolete status after a successful write', () => {
    reportPersistenceMemoryOnly('activity', new Error('failure'), async () => undefined);
    reportPersistenceSaved('activity');

    expect(usePersistenceStatusStore.getState().statuses.activity).toEqual({
      state: 'saved',
      error: null,
      retry: null,
    });
  });
});
