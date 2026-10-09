import { beforeEach, describe, expect, it } from 'vitest';
import { getActiveDataScope, scopeStorageKey, setActiveDataScope } from './scopeContext';
import { hasPendingScopePurge, isScopePurgeMarkerUnavailable, isScopeWritable } from './scopeWriteFence';

describe('active data scope', () => {
  beforeEach(() => setActiveDataScope('guest'));

  it('uses distinct namespaces for guest, account and house data', () => {
    expect(scopeStorageKey('guest', 'pantry')).not.toBe(scopeStorageKey('account:user-a', 'pantry'));
    expect(scopeStorageKey('account:user-a', 'pantry')).not.toBe(scopeStorageKey('house:house-a', 'pantry'));
  });

  it('keeps the active scope usable when browser storage cannot persist it', () => {
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new DOMException('Storage denied', 'SecurityError'); };
    try {
      setActiveDataScope('house:house-a');
      expect(getActiveDataScope()).toBe('house:house-a');
    } finally {
      window.localStorage.setItem = setItem;
    }
  });

  it('fails closed for a house scope when localStorage access is denied', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });
    try {
      expect(isScopeWritable('guest')).toBe(true);
      expect(isScopeWritable('account:user-a')).toBe(true);
      expect(isScopePurgeMarkerUnavailable('house:house-a')).toBe(true);
      expect(hasPendingScopePurge('house:house-a')).toBe(false);
      expect(isScopeWritable('house:house-a')).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });

  it('persists and returns the active scope', () => {
    setActiveDataScope('house:house-a');
    expect(getActiveDataScope()).toBe('house:house-a');
  });
});
