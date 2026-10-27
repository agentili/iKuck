export const COLOR_PALETTES = [
  { id: 'pistachio-lemon', label: 'Pistacchio e limone', description: 'Crema luminosa, verde oliva e giallo morbido.' },
  { id: 'peach-coral', label: 'Pesca e corallo', description: 'Toni pesca, terracotta e corallo delicato.' },
  { id: 'lavender-blueberry', label: 'Lavanda e mirtillo', description: 'Lavanda chiara, mirtillo e accenti di pesca.' },
  { id: 'sea-terracotta', label: 'Mare e terracotta', description: 'Verde mare, schiuma chiara e terracotta.' },
] as const;

export type ColorPaletteId = typeof COLOR_PALETTES[number]['id'];

export const DEFAULT_COLOR_PALETTE: ColorPaletteId = 'pistachio-lemon';

const COLOR_PALETTE_PREFERENCE_KEY = 'ikuck-color-palette';
const BROWSER_THEME_COLOR_TOKEN = '--ik-browser-theme-color';

let sessionColorPalette: ColorPaletteId | null = null;
let sessionPreferencePersistenceFailed = false;
const colorPaletteListeners = new Set<() => void>();

export const isColorPaletteId = (value: unknown): value is ColorPaletteId =>
  typeof value === 'string' && COLOR_PALETTES.some((palette) => palette.id === value);

export const subscribeColorPalette = (listener: () => void): (() => void) => {
  colorPaletteListeners.add(listener);
  return () => colorPaletteListeners.delete(listener);
};

export const hasUnpersistedColorPalette = (): boolean =>
  sessionColorPalette !== null && sessionPreferencePersistenceFailed;

export const getColorPalettePreference = (): ColorPaletteId => {
  if (sessionColorPalette !== null) return sessionColorPalette;
  if (typeof window === 'undefined') return DEFAULT_COLOR_PALETTE;

  try {
    const preference = window.localStorage.getItem(COLOR_PALETTE_PREFERENCE_KEY);
    if (isColorPaletteId(preference)) return preference;
  } catch {
    return DEFAULT_COLOR_PALETTE;
  }

  return DEFAULT_COLOR_PALETTE;
};

const syncThemeColorMeta = (): void => {
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeColor || typeof window === 'undefined') return;

  try {
    const browserThemeColor = window.getComputedStyle(document.documentElement)
      .getPropertyValue(BROWSER_THEME_COLOR_TOKEN).trim();
    if (browserThemeColor !== '') themeColor.content = browserThemeColor;
  } catch {
    // Keep the static HTML theme color when computed styles are unavailable.
  }
};

export const applyColorPalette = (): void => {
  if (typeof document === 'undefined') return;

  document.documentElement.dataset.palette = getColorPalettePreference();
  syncThemeColorMeta();
  colorPaletteListeners.forEach((listener) => listener());
};

export const saveColorPalettePreference = (preference: ColorPaletteId): boolean => {
  if (typeof document === 'undefined') return false;

  let persisted = false;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COLOR_PALETTE_PREFERENCE_KEY, preference);
      persisted = true;
    }
  } catch {
    persisted = false;
  }

  sessionColorPalette = persisted ? null : preference;
  sessionPreferencePersistenceFailed = !persisted;
  applyColorPalette();
  return persisted;
};
