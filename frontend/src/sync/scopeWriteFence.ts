import type { SyncScope } from './scopeContext';

const revokedScopes = new Set<SyncScope>();
const uncertainScopes = new Set<SyncScope>();
const pendingWrites = new Map<SyncScope, Set<Promise<unknown>>>();
const availabilityListeners = new Set<() => void>();
const purgeKey = (scope: SyncScope): string => `ikuck:pending-house-purge:${scope}`;
const notifyAvailability = (): void => { for (const listener of availabilityListeners) listener(); };

export const isLocalStorageAvailable = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    void window.localStorage;
    return true;
  } catch {
    return false;
  }
};

export const isScopePurgeMarkerUnavailable = (scope: SyncScope): boolean => {
  if (!scope.startsWith('house:') || typeof window === 'undefined') return false;
  try {
    window.localStorage.getItem(purgeKey(scope));
    return false;
  } catch {
    return true;
  }
};

export const hasPendingScopePurge = (scope: SyncScope): boolean => {
  if (!scope.startsWith('house:') || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(purgeKey(scope)) === '1';
  } catch {
    // Unknown is not a pending purge: callers must not start destructive cleanup.
    return false;
  }
};

export const subscribeScopeAvailability = (listener: () => void): (() => void) => {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
};

export class ScopeRevokedError extends Error {
  readonly code = 'scope_revoked';

  constructor() {
    super('The data scope is no longer available');
    this.name = 'ScopeRevokedError';
  }
}

export class ScopeUncertainError extends Error {
  readonly code = 'scope_unverified';

  constructor() {
    super('House membership could not be verified');
    this.name = 'ScopeUncertainError';
  }
}

export const isScopeUncertain = (scope: SyncScope): boolean => uncertainScopes.has(scope);
export const isScopeWritable = (scope: SyncScope): boolean => !revokedScopes.has(scope)
  && !uncertainScopes.has(scope)
  && !isScopePurgeMarkerUnavailable(scope)
  && !hasPendingScopePurge(scope);
export const assertScopeWritable = (scope: SyncScope): void => {
  if (isScopeUncertain(scope)) throw new ScopeUncertainError();
  if (!isScopeWritable(scope)) throw new ScopeRevokedError();
};
export const markScopeUncertain = (scope: SyncScope): void => {
  if (!scope.startsWith('house:') || uncertainScopes.has(scope)) return;
  uncertainScopes.add(scope);
  notifyAvailability();
};
export const revokeScope = (scope: SyncScope): void => {
  uncertainScopes.delete(scope);
  revokedScopes.add(scope);
  try {
    if (scope.startsWith('house:') && typeof window !== 'undefined') {
      window.localStorage.setItem(purgeKey(scope), '1');
    }
  } finally {
    notifyAvailability();
  }
};
export const completeScopePurge = (scope: SyncScope): void => {
  if (scope.startsWith('house:') && typeof window !== 'undefined') {
    window.localStorage.removeItem(purgeKey(scope));
  }
  // A successful purge does not restore membership or permit new writes.
};
export const resumeScope = (scope: SyncScope): void => {
  if (hasPendingScopePurge(scope)) throw new ScopeRevokedError();
  revokedScopes.delete(scope);
  uncertainScopes.delete(scope);
  notifyAvailability();
};

// Register synchronously at submission, including writes waiting on a store's
// per-scope chain. Purge waits for these before removing IndexedDB and queues.
export const trackScopedWrite = <T>(scope: SyncScope, action: (assertWritable: () => void) => Promise<T>): Promise<T> => {
  const assertWritable = (): void => assertScopeWritable(scope);
  try {
    assertWritable();
  } catch (error) {
    return Promise.reject(error);
  }
  const operation = (async () => {
    assertWritable();
    const result = await action(assertWritable);
    if (isScopeUncertain(scope)) throw new ScopeUncertainError();
    return result;
  })();
  const pending = pendingWrites.get(scope) ?? new Set<Promise<unknown>>();
  pending.add(operation);
  pendingWrites.set(scope, pending);
  void operation.then(() => {
    pending.delete(operation);
    if (pending.size === 0) pendingWrites.delete(scope);
  }, () => {
    pending.delete(operation);
    if (pending.size === 0) pendingWrites.delete(scope);
  });
  return operation;
};

export const waitForScopedWrites = async (scope: SyncScope): Promise<void> => {
  while ((pendingWrites.get(scope)?.size ?? 0) > 0) {
    await Promise.allSettled([...(pendingWrites.get(scope) ?? [])]);
  }
};

export const waitForAllScopedWrites = async (): Promise<void> => {
  while (pendingWrites.size > 0) {
    const operations = [...pendingWrites.values()].flatMap((writes) => [...writes]);
    await Promise.allSettled(operations);
  }
};
