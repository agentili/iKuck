export type ColorThemePreference = 'light' | 'dark' | 'system';

const COLOR_THEME_PREFERENCE_KEY = 'ikuck-color-theme';
const SYSTEM_COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const LIGHT_THEME_COLOR = '#247A4A';
const DARK_THEME_COLOR = '#101613';

let sessionColorThemePreference: ColorThemePreference | null = null;
let sessionPreferencePersistenceFailed = false;
let watchedSystemColorThemeCleanup: (() => void) | null = null;
const colorThemeListeners = new Set<() => void>();

export const subscribeColorTheme = (listener: () => void): (() => void) => {
  colorThemeListeners.add(listener);
  return () => colorThemeListeners.delete(listener);
};

export const hasUnpersistedColorTheme = (): boolean => sessionColorThemePreference !== null && sessionPreferencePersistenceFailed;

export const getColorThemePreference = (): ColorThemePreference => {
  if (sessionColorThemePreference !== null) return sessionColorThemePreference;
  if (typeof window === 'undefined') return 'system';

  try {
    const preference = window.localStorage.getItem(COLOR_THEME_PREFERENCE_KEY);
    if (preference === 'light' || preference === 'dark' || preference === 'system') return preference;
  } catch {
    return 'system';
  }

  return 'system';
};

export const resolveColorTheme = (): 'light' | 'dark' => {
  const preference = getColorThemePreference();
  if (preference !== 'system') return preference;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';

  try {
    return window.matchMedia(SYSTEM_COLOR_SCHEME_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

export const applyColorTheme = (): void => {
  if (typeof document === 'undefined') return;

  const theme = resolveColorTheme();
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  colorThemeListeners.forEach((listener) => listener());
};

export const saveColorThemePreference = (preference: ColorThemePreference): boolean => {
  if (typeof document === 'undefined') return false;

  let persisted = false;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COLOR_THEME_PREFERENCE_KEY, preference);
      persisted = true;
    }
  } catch {
    persisted = false;
  }

  sessionColorThemePreference = persisted ? null : preference;
  sessionPreferencePersistenceFailed = !persisted;
  applyColorTheme();
  return persisted;
};

export const watchSystemColorTheme = (): void => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  try {
    try {
      watchedSystemColorThemeCleanup?.();
    } catch {
      // Continue watching if a stale media-query cleanup fails.
    }

    const mediaQuery = window.matchMedia(SYSTEM_COLOR_SCHEME_QUERY);
    const listener = (): void => {
      if (getColorThemePreference() === 'system') applyColorTheme();
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', listener);
      watchedSystemColorThemeCleanup = () => mediaQuery.removeEventListener('change', listener);
    } else {
      mediaQuery.addListener(listener);
      watchedSystemColorThemeCleanup = () => mediaQuery.removeListener(listener);
    }
  } catch {
    watchedSystemColorThemeCleanup = null;
  }
};
