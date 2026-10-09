import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMotionPreference, saveReducedMotionPreference } from './motionPreference';

describe('device-only motion preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-motion');
  });

  it('persists locally and applies reduced motion without a network request', () => {
    saveReducedMotionPreference(true);
    expect(window.localStorage.getItem('ikuck-motion-preference')).toBe('reduced');
    expect(document.documentElement.dataset.motion).toBe('reduced');
  });

  it('restores the saved local preference when the application starts', () => {
    window.localStorage.setItem('ikuck-motion-preference', 'reduced');
    applyMotionPreference();
    expect(document.documentElement.dataset.motion).toBe('reduced');
  });

  it('uses system motion when getItem throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage disabled', 'SecurityError'); });
    applyMotionPreference();
    expect(document.documentElement.dataset.motion).toBe('system');
    getItem.mockRestore();
  });

  it('falls back to system motion and reports failed persistence when accessing localStorage throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new DOMException('Storage disabled', 'SecurityError'); } });
    try {
      expect(() => applyMotionPreference()).not.toThrow();
      expect(document.documentElement.dataset.motion).toBe('system');
      expect(saveReducedMotionPreference(true)).toBe(false);
      expect(document.documentElement.dataset.motion).toBe('reduced');
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });

  it('applies the session preference but reports that setItem persistence failed', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage disabled', 'SecurityError'); });
    expect(saveReducedMotionPreference(true)).toBe(false);
    expect(document.documentElement.dataset.motion).toBe('reduced');
    setItem.mockRestore();
  });
});
