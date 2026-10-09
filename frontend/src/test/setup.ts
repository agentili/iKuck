import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { waitForPendingQueueWrites } from '../sync/syncQueue';
import { waitForAllScopedWrites } from '../sync/scopeWriteFence';

interface TestLockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

const createTestLockManager = (): TestLockManager => {
  const tails = new Map<string, Promise<void>>();
  return {
    request<T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, current);
      return previous.then(async () => {
        try {
          return await callback();
        } finally {
          release();
          if (tails.get(name) === current) tails.delete(name);
        }
      });
    },
  };
};

beforeEach(async () => {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '');
  await waitForPendingQueueWrites();
  await waitForAllScopedWrites();
  await deleteLocalDatabase();
  window.localStorage.clear();
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    writable: true,
    value: createTestLockManager(),
  });
});

afterEach(async () => {
  await waitForPendingQueueWrites();
  await waitForAllScopedWrites();
  cleanup();
  window.localStorage.clear();
});
