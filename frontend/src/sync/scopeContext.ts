export type SyncScope = 'guest' | `account:${string}` | `house:${string}`;

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
const listeners = new Set<(scope: SyncScope) => void>();

export const getActiveDataScope = (): SyncScope => sharedScope;
export const getSharedDataScope = (): SyncScope => sharedScope;
export const getPersonalDataScope = (): SyncScope => personalScope;

export const setActiveDataScope = (scope: SyncScope): void => {
  const changed = sharedScope !== scope;
  sharedScope = scope;
  if (scope === 'guest' || scope.startsWith('account:')) personalScope = scope;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ACTIVE_SCOPE_KEY, scope);
    window.localStorage.setItem(PERSONAL_SCOPE_KEY, personalScope);
  }
  if (changed) for (const listener of listeners) listener(scope);
};

export const setPersonalDataScope = (scope: SyncScope): void => {
  personalScope = scope;
  if (typeof window !== 'undefined') window.localStorage.setItem(PERSONAL_SCOPE_KEY, scope);
};

export const subscribeActiveDataScope = (listener: (scope: SyncScope) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const scopeStorageKey = (scope: SyncScope, key: string): string => `ikuck:${scope}:${key}`;
