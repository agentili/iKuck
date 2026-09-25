import type { SyncMutationScope } from '@ikuck/shared/contracts';

export type SyncScope = 'guest' | SyncMutationScope;

const ACTIVE_SCOPE_KEY = 'ikuck-active-data-scope';
const PERSONAL_SCOPE_KEY = 'ikuck-personal-data-scope';
const isSyncScope = (value: unknown): value is SyncScope => value === 'guest'
  || (typeof value === 'string' && (value.startsWith('account:') || value.startsWith('house:')) && value.length > value.indexOf(':') + 1);
const readStoredScope = (key: string): SyncScope | null => {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(key);
  return isSyncScope(stored) ? stored : null;
};

let sharedScope: SyncScope = readStoredScope(ACTIVE_SCOPE_KEY) ?? 'guest';
let personalScope: SyncScope = readStoredScope(PERSONAL_SCOPE_KEY)
  ?? (sharedScope === 'guest' || sharedScope.startsWith('account:') ? sharedScope : 'guest');
const activeListeners = new Set<(scope: SyncScope) => void>();
const personalListeners = new Set<(scope: SyncScope) => void>();

export const getActiveDataScope = (): SyncScope => sharedScope;
export const getSharedDataScope = (): SyncScope => sharedScope;
export const getPersonalDataScope = (): SyncScope => personalScope;

export const setActiveDataScope = (scope: SyncScope): void => {
  const activeChanged = sharedScope !== scope;
  const previousPersonalScope = personalScope;
  sharedScope = scope;
  if (scope === 'guest' || scope.startsWith('account:')) personalScope = scope;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ACTIVE_SCOPE_KEY, scope);
    window.localStorage.setItem(PERSONAL_SCOPE_KEY, personalScope);
  }
  if (activeChanged) for (const listener of activeListeners) listener(scope);
  if (previousPersonalScope !== personalScope) {
    for (const listener of personalListeners) listener(personalScope);
  }
};

export const setPersonalDataScope = (scope: SyncScope): void => {
  const changed = personalScope !== scope;
  personalScope = scope;
  if (typeof window !== 'undefined') window.localStorage.setItem(PERSONAL_SCOPE_KEY, scope);
  if (changed) for (const listener of personalListeners) listener(scope);
};

export const subscribeActiveDataScope = (listener: (scope: SyncScope) => void): (() => void) => {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
};

export const subscribePersonalDataScope = (listener: (scope: SyncScope) => void): (() => void) => {
  personalListeners.add(listener);
  return () => personalListeners.delete(listener);
};

export const scopeStorageKey = (scope: SyncScope, key: string): string => `ikuck:${scope}:${key}`;
