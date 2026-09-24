import { beforeEach, describe, expect, it } from 'vitest';
import { getActiveDataScope, scopeStorageKey, setActiveDataScope } from './scopeContext';

describe('active data scope', () => {
  beforeEach(() => setActiveDataScope('guest'));

  it('uses distinct namespaces for guest, account and house data', () => {
    expect(scopeStorageKey('guest', 'pantry')).not.toBe(scopeStorageKey('account:user-a', 'pantry'));
    expect(scopeStorageKey('account:user-a', 'pantry')).not.toBe(scopeStorageKey('house:house-a', 'pantry'));
  });

  it('persists and returns the active scope', () => {
    setActiveDataScope('house:house-a');
    expect(getActiveDataScope()).toBe('house:house-a');
  });
});
