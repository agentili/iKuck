import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let colorTheme: typeof import('./colorTheme');
let originalMatchMedia: PropertyDescriptor | undefined;
let activeMediaQuery: {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
} | undefined;
let mediaChangeListener: ((event: MediaQueryListEvent) => void) | undefined;

const mockMatchMedia = (matches: boolean) => {
  const query = {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: EventListener) => {
      mediaChangeListener = listener as (event: MediaQueryListEvent) => void;
    }),
    removeEventListener: vi.fn(),
  };
  activeMediaQuery = query;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => query as unknown as MediaQueryList),
  });
  return query;
};

beforeEach(async () => {
  vi.resetModules();
  colorTheme = await import('./colorTheme');
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  let themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeColorMeta) {
    themeColorMeta = document.createElement('meta');
    themeColorMeta.name = 'theme-color';
    document.head.append(themeColorMeta);
  }
  themeColorMeta.content = '#247A4A';
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  activeMediaQuery = undefined;
  mediaChangeListener = undefined;
  mockMatchMedia(false);
});

afterEach(() => {
  if (originalMatchMedia === undefined) {
    Reflect.deleteProperty(window, 'matchMedia');
  } else {
    Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  }
});

describe('device-only color theme preference', () => {
  it('defaults to system and resolves system to the current light scheme', () => {
    expect(colorTheme.getColorThemePreference()).toBe('system');
    expect(colorTheme.resolveColorTheme()).toBe('light');
    expect(colorTheme.hasUnpersistedColorTheme()).toBe(false);
  });

  it.each(['light', 'dark', 'system'] as const)('persists and restores the %s preference', async (preference) => {
    expect(colorTheme.saveColorThemePreference(preference)).toBe(true);
    expect(window.localStorage.getItem('ikuck-color-theme')).toBe(preference);

    vi.resetModules();
    colorTheme = await import('./colorTheme');
    colorTheme.applyColorTheme();

    expect(colorTheme.getColorThemePreference()).toBe(preference);
    expect(document.documentElement.dataset.theme).toBe(preference === 'dark' ? 'dark' : 'light');
  });

  it('resolves system preference from matchMedia in both directions', () => {
    mockMatchMedia(true);
    expect(colorTheme.resolveColorTheme()).toBe('dark');

    mockMatchMedia(false);
    expect(colorTheme.resolveColorTheme()).toBe('light');
  });

  it('uses system preference when localStorage reads throw', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });

    expect(() => colorTheme.applyColorTheme()).not.toThrow();
    expect(colorTheme.getColorThemePreference()).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(colorTheme.hasUnpersistedColorTheme()).toBe(false);

    getItem.mockRestore();
  });

  it('keeps a session-only preference when localStorage writes throw', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });

    expect(colorTheme.saveColorThemePreference('dark')).toBe(false);
    expect(colorTheme.getColorThemePreference()).toBe('dark');
    expect(colorTheme.hasUnpersistedColorTheme()).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    setItem.mockRestore();
  });

  it('uses system when accessing localStorage throws and applies session-only selections', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => { throw new DOMException('Storage disabled', 'SecurityError'); },
    });

    try {
      expect(colorTheme.getColorThemePreference()).toBe('system');
      expect(colorTheme.applyColorTheme()).toBeUndefined();
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(colorTheme.saveColorThemePreference('dark')).toBe(false);
      expect(colorTheme.hasUnpersistedColorTheme()).toBe(true);
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });

  it('applies the resolved theme and updates the browser theme color', () => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta).not.toBeNull();

    colorTheme.saveColorThemePreference('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(meta?.content).toBe('#101613');

    colorTheme.saveColorThemePreference('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(meta?.content).toBe('#247A4A');
  });

  it('updates the applied theme when the system color scheme changes', () => {
    colorTheme.saveColorThemePreference('system');
    const query = activeMediaQuery;
    colorTheme.watchSystemColorTheme();

    expect(query?.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    query!.matches = true;
    mediaChangeListener?.({ matches: true } as MediaQueryListEvent);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#101613');
  });

  it('does not follow system changes when an explicit preference is selected', () => {
    colorTheme.saveColorThemePreference('light');
    colorTheme.watchSystemColorTheme();
    activeMediaQuery!.matches = true;
    mediaChangeListener?.({ matches: true } as MediaQueryListEvent);

    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
