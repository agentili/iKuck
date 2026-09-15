import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { waitForPendingQueueWrites } from '../sync/syncQueue';

beforeEach(async () => {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '');
  await deleteLocalDatabase();
  window.localStorage.clear();
});

afterEach(async () => {
  await waitForPendingQueueWrites();
  cleanup();
  window.localStorage.clear();
});
