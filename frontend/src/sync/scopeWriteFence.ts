import type { SyncScope } from './scopeContext';

const revokedScopes = new Set<SyncScope>();
const pendingWrites = new Map<SyncScope, Set<Promise<unknown>>>();
const availabilityListeners = new Set<() => void>();
const purgeKey = (scope: SyncScope): string => `ikuck:pending-house-purge:${scope}`;
const notifyAvailability = (): void => { for (const listener of availabilityListeners) listener(); };

export const hasPendingScopePurge = (scope: SyncScope): boolean => scope.startsWith('house:')
  && typeof window !== 'undefined' && window.localStorage.getItem(purgeKey(scope)) === '1';

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

export const isScopeWritable = (scope: SyncScope): boolean => !revokedScopes.has(scope) && !hasPendingScopePurge(scope);
export const revokeScope = (scope: SyncScope): void => {
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
  notifyAvailability();
};

// Register synchronously at submission, including writes waiting on a store's
// per-scope chain. Purge waits for these before removing IndexedDB and queues.
export const trackScopedWrite = <T>(scope: SyncScope, action: () => Promise<T>): Promise<T> => {
  if (!isScopeWritable(scope)) return Promise.reject(new ScopeRevokedError());
  const operation = (async () => {
    if (!isScopeWritable(scope)) throw new ScopeRevokedError();
    return action();
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
