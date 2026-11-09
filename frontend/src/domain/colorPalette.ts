export const COLOR_PALETTES = [
  { value: 'basilico', label: 'Basilico', description: 'Verde e naturale' },
  { value: 'oceano', label: 'Oceano', description: 'Blu e aria fresca' },
  { value: 'lavanda', label: 'Lavanda', description: 'Viola e quiete' },
  { value: 'pesca', label: 'Pesca', description: 'Corallo e calore' },
  { value: 'terracotta', label: 'Terracotta', description: 'Terra e spezie' },
  { value: 'limone', label: 'Limone', description: 'Oliva e luce' },
  { value: 'salvia', label: 'Salvia', description: 'Verde eucalipto' },
  { value: 'rosa', label: 'Rosa', description: 'Rosa e prugna' },
  { value: 'caffe', label: 'Caffè', description: 'Cacao e crema' },
  { value: 'laguna', label: 'Laguna', description: 'Turchese e acqua' },
] as const;

export type ColorPalettePreference = (typeof COLOR_PALETTES)[number]['value'];

const COLOR_PALETTE_PREFERENCE_KEY = 'ikuck-color-palette';

let sessionColorPalettePreference: ColorPalettePreference | null = null;
let sessionPreferencePersistenceFailed = false;
const colorPaletteListeners = new Set<() => void>();

const isColorPalettePreference = (value: string | null): value is ColorPalettePreference =>
  COLOR_PALETTES.some((palette) => palette.value === value);

export const subscribeColorPalette = (listener: () => void): (() => void) => {
  colorPaletteListeners.add(listener);
  return () => colorPaletteListeners.delete(listener);
};

export const hasUnpersistedColorPalette = (): boolean =>
  sessionColorPalettePreference !== null && sessionPreferencePersistenceFailed;

export const getColorPalettePreference = (): ColorPalettePreference => {
  if (sessionColorPalettePreference !== null) return sessionColorPalettePreference;
  if (typeof window === 'undefined') return 'basilico';

  try {
    const preference = window.localStorage.getItem(COLOR_PALETTE_PREFERENCE_KEY);
    if (isColorPalettePreference(preference)) return preference;
  } catch {
    return 'basilico';
  }

  return 'basilico';
};

export const applyColorPalette = (): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.palette = getColorPalettePreference();
  colorPaletteListeners.forEach((listener) => listener());
};

export const saveColorPalettePreference = (preference: ColorPalettePreference): boolean => {
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

  sessionColorPalettePreference = persisted ? null : preference;
  sessionPreferencePersistenceFailed = !persisted;
  applyColorPalette();
  return persisted;
};
