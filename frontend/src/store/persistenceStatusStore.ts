import { create } from 'zustand';

export type PersistenceState = 'saved' | 'saving' | 'memory-only' | 'sync-pending' | 'sync-error';
export type PersistenceDomain = 'pantry' | 'shopping-list' | 'activity' | 'diet';
export type PersistenceRetry = () => Promise<void>;

export interface PersistenceStatus {
  state: PersistenceState;
  error: unknown | null;
  retry: PersistenceRetry | null;
}

type PersistenceStatusMap = Record<PersistenceDomain, PersistenceStatus>;

const domains: readonly PersistenceDomain[] = ['pantry', 'shopping-list', 'activity', 'diet'];

const createInitialStatus = (): PersistenceStatus => ({
  state: 'saved',
  error: null,
  retry: null,
});

const createInitialStatuses = (): PersistenceStatusMap => ({
  pantry: createInitialStatus(),
  'shopping-list': createInitialStatus(),
  activity: createInitialStatus(),
  diet: createInitialStatus(),
});

interface PersistenceStatusStore {
  statuses: PersistenceStatusMap;
  setStatus: (domain: PersistenceDomain, status: PersistenceStatus) => void;
  reset: () => void;
}

export const usePersistenceStatusStore = create<PersistenceStatusStore>((set) => ({
  statuses: createInitialStatuses(),
  setStatus: (domain, status) => set((current) => ({
    statuses: { ...current.statuses, [domain]: status },
  })),
  reset: () => set({ statuses: createInitialStatuses() }),
}));

const setStatus = (domain: PersistenceDomain, status: PersistenceStatus): void => {
  usePersistenceStatusStore.getState().setStatus(domain, status);
};

export const reportPersistenceSaving = (domain: PersistenceDomain, retry: PersistenceRetry): void => {
  setStatus(domain, { state: 'saving', error: null, retry });
};

export const reportPersistenceSaved = (domain: PersistenceDomain): void => {
  const current = usePersistenceStatusStore.getState().statuses[domain];
  if (current.state === 'sync-pending' || current.state === 'sync-error') return;
  setStatus(domain, { state: 'saved', error: null, retry: null });
};

export const reportPersistenceMemoryOnly = (
  domain: PersistenceDomain,
  error: unknown,
  retry: PersistenceRetry,
): void => {
  setStatus(domain, { state: 'memory-only', error, retry });
};

export const reportSyncPending = (domain: PersistenceDomain): void => {
  const current = usePersistenceStatusStore.getState().statuses[domain];
  if (current.state === 'memory-only') return;
  setStatus(domain, { state: 'sync-pending', error: null, retry: null });
};

export const reportSyncError = (
  domain: PersistenceDomain,
  error: unknown,
  retry: PersistenceRetry,
): void => {
  const current = usePersistenceStatusStore.getState().statuses[domain];
  if (current.state === 'memory-only') return;
  setStatus(domain, { state: 'sync-error', error, retry });
};

export async function trackPersistence(
  domain: PersistenceDomain,
  operation: () => Promise<void>,
): Promise<boolean> {
  const retry = async () => {
    await trackPersistence(domain, operation);
  };
  reportPersistenceSaving(domain, retry);
  try {
    await operation();
    reportPersistenceSaved(domain);
    return true;
  } catch (error) {
    reportPersistenceMemoryOnly(domain, error, retry);
    return false;
  }
}

export async function trackSync(
  domain: PersistenceDomain,
  operation: () => Promise<void>,
): Promise<boolean> {
  try {
    await operation();
    reportSyncPending(domain);
    return true;
  } catch (error) {
    const retry = async () => {
      await trackSync(domain, operation);
    };
    reportSyncError(domain, error, retry);
    return false;
  }
}

export async function retryPersistence(domain: PersistenceDomain): Promise<void> {
  const retry = usePersistenceStatusStore.getState().statuses[domain].retry;
  if (retry === null) return;
  await retry();
}

export const persistenceDomains = domains;
