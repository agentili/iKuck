import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { waitForPendingQueueWrites } from '../sync/syncQueue';

beforeEach(async () => {
  await deleteLocalDatabase();
  window.localStorage.clear();
});

afterEach(async () => {
  await waitForPendingQueueWrites();
  cleanup();
  window.localStorage.clear();
});
