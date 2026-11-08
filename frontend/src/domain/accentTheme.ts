/**
 * Accent Color Theme System
 * Allows users to choose from predefined color palettes.
 * Each palette defines the primary/accent colors for the autumn warm design.
 */

export type AccentThemeId =
  | 'autumn'    // Original orange (default)
  | 'ocean'     // Blue
  | 'forest'    // Green
  | 'berry'     // Purple/pink
  | 'sunset'    // Red/coral
  | 'teal'      // Teal
  | 'violet'    // Violet
  | 'rose';     // Rose

export interface AccentPalette {
  id: AccentThemeId;
  name: string;
  description: string;
  // Core colors
  primary: string;        // Main brand color (buttons, links, accents)
  primaryAction: string;  // Hover/active state for primary
  onPrimaryAction: string; // Text on primary action
  accent: string;         // Secondary accent (highlights, focus)
  // Semantic colors (can vary per palette)
  warning: string;
  danger: string;
  focus: string;
  // Surface/border (usually stay consistent)
  surface: string;
  border: string;
  textMuted: string;
}

export const ACCENT_PALETTES: Record<AccentThemeId, AccentPalette> = {
  autumn: {
    id: 'autumn',
    name: 'Autunno',
    description: 'Caldo e avvolgente (predefinito)',
    primary: '#c76b43',
    primaryAction: '#d98a63',
    onPrimaryAction: '#191512',
    accent: '#e3a857',
    warning: '#ec8a3c',
    danger: '#e0604f',
    focus: '#e3a857',
    surface: '#261f1a',
    border: '#4c4540',
    textMuted: '#9c9188',
  },
  ocean: {
    id: 'ocean',
    name: 'Oceano',
    description: 'Profondo e rilassante',
    primary: '#0d9488',
    primaryAction: '#14b8a6',
    onPrimaryAction: '#ffffff',
    accent: '#06b6d4',
    warning: '#f59e0b',
    danger: '#ef4444',
    focus: '#06b6d4',
    surface: '#1f2937',
    border: '#374151',
    textMuted: '#9ca3af',
  },
  forest: {
    id: 'forest',
    name: 'Foresta',
    description: 'Naturale e fresco',
    primary: '#16a34a',
    primaryAction: '#22c55e',
    onPrimaryAction: '#ffffff',
    accent: '#4ade80',
    warning: '#f59e0b',
    danger: '#ef4444',
    focus: '#4ade80',
    surface: '#166534',
    border: '#166534',
    textMuted: '#86efac',
  },
  berry: {
    id: 'berry',
    name: 'Frutti di bosco',
    description: 'Vivace e dolce',
    primary: '#c026d3',
    primaryAction: '#d946ef',
    onPrimaryAction: '#ffffff',
    accent: '#f0abfc',
    warning: '#f59e0b',
    danger: '#ef4444',
    focus: '#f0abfc',
    surface: '#701a75',
    border: '#a21caf',
    textMuted: '#f0abfc',
  },
  sunset: {
    id: 'sunset',
    name: 'Tramonto',
    description: 'Caldo e appassionato',
    primary: '#e11d48',
    primaryAction: '#f43f5e',
    onPrimaryAction: '#ffffff',
    accent: '#fb7185',
    warning: '#f59e0b',
    danger: '#ef4444',
    focus: '#fb7185',
    surface: '#9f1239',
    border: '#be123c',
    textMuted: '#fda4af',
  },
  teal: {
    id: 'teal',
    name: 'Petrolio',
    description: 'Elegante e moderno',
    primary: '#0d9488',
    primaryAction: '#14b8a6',
    onPrimaryAction: '#ffffff',
    accent: '#5eead4',
    warning: '#f59e0b',
    danger: '#ef4444',
    focus: '#5eead4',
    surface: '#134e4a',
    border: '#0f766e',
    textMuted: '#99f6e4',
  },
  violet: {
    id: 'violet',
    name: 'Viola',
    description: 'Misterioso e creativo',
    primary: '#7c3aed',
    primaryAction: '#a855f7',
    onPrimaryAction: '#ffffff',
    accent: '#c084fc',
    warning: '#f59e0b',
    danger: '#ef4444',
    focus: '#c084fc',
    surface: '#4c1d95',
    border: '#6d28d9',
    textMuted: '#c084fc',
  },
  rose: {
    id: 'rose',
    name: 'Rosa',
    description: 'Delicato e romantico',
    primary: '#e11d48',
    primaryAction: '#f43f5e',
    onPrimaryAction: '#ffffff',
    accent: '#fda4af',
    warning: '#f59e0b',
    danger: '#ef4444',
    focus: '#fda4af',
    surface: '#9f1239',
    border: '#be123c',
    textMuted: '#fda4af',
  },
};

const ACCENT_THEME_KEY = 'ikuck-accent-theme';

let sessionAccentTheme: AccentThemeId | null = null;
let sessionAccentPersistenceFailed = false;
const accentThemeListeners = new Set<() => void>();

export const subscribeAccentTheme = (listener: () => void): (() => void) => {
  accentThemeListeners.add(listener);
  return () => accentThemeListeners.delete(listener);
};

export const hasUnpersistedAccentTheme = (): boolean =>
  sessionAccentTheme !== null && sessionAccentPersistenceFailed;

export const getAccentThemePreference = (): AccentThemeId => {
  if (sessionAccentTheme !== null) return sessionAccentTheme;
  if (typeof window === 'undefined') return 'autumn';

  try {
    const preference = window.localStorage.getItem(ACCENT_THEME_KEY);
    if (preference && preference in ACCENT_PALETTES) return preference as AccentThemeId;
  } catch {
    return 'autumn';
  }
  return 'autumn';
};

export const applyAccentTheme = (): void => {
  if (typeof document === 'undefined') return;

  const themeId = getAccentThemePreference();
  const palette = ACCENT_PALETTES[themeId];
  const root = document.documentElement;

  // Apply all palette colors as CSS custom properties
  Object.entries(palette).forEach(([key, value]) => {
    if (key !== 'id' && key !== 'name' && key !== 'description') {
      const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      root.style.setProperty(`--color-${cssKey}`, value);
    }
  });

  // Also update the theme-color meta tag for PWA
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = palette.primary;

  accentThemeListeners.forEach((listener) => listener());
};

export const saveAccentThemePreference = (preference: AccentThemeId): boolean => {
  if (typeof document === 'undefined') return false;

  let persisted = false;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACCENT_THEME_KEY, preference);
      persisted = true;
    }
  } catch {
    persisted = false;
  }

  sessionAccentTheme = persisted ? null : preference;
  sessionAccentPersistenceFailed = !persisted;
  applyAccentTheme();
  return persisted;
};

export const getAccentPalette = (themeId?: AccentThemeId): AccentPalette => {
  const id = themeId ?? getAccentThemePreference();
  return ACCENT_PALETTES[id];
};