/**
 * iKuck Design Tokens — Autumn Warm Palette (dark-first)
 *
 * Single source of truth for colors, typography, spacing, radius, shadows.
 * No green in palette. CSS custom properties are generated for :root (dark)
 * and can be extended for light theme later if approved.
 *
 * Usage in CSS: var(--color-bg), var(--font-serif), etc.
 * Usage in TS: import { tokens } from '@/theme/tokens'; tokens.color.bg
 */

export const tokens = {
  color: {
    bg: '#191512',
    surface: '#261f1a',
    border: '#4c4540',
    primary: '#c76b43',
    primaryAction: '#d98a63',
    onPrimaryAction: '#191512',
    accent: '#e3a857',
    warning: '#ec8a3c',
    danger: '#e0604f',
    text: '#f6f2e9',
    textMuted: '#9c9188',
    focus: '#e3a857',
  } as const,

  font: {
    serif: "Georgia, 'Noto Serif', serif",
    sans: "'Bricolage Grotesque Variable', system-ui, sans-serif",
  } as const,

  radius: {
    control: '12px',
    panel: '20px',
    feature: '28px',
    pill: '100px',
  } as const,

  space: {
    1: '0.25rem',
    2: '0.5rem',
    3: '0.75rem',
    4: '1rem',
    5: '1.5rem',
    6: '2rem',
  } as const,

  shadow: {
    card: '0 4px 12px rgb(0 0 0 / 0.35)',
    surface: '0 12px 30px rgb(0 0 0 / 0.45)',
    lift: '0 16px 32px rgb(0 0 0 / 0.55)',
  } as const,

  // Ingredient status colors (semantic aliases)
  ingredientStatus: {
    ok: 'var(--color-text)',
    expiringSoon: 'var(--color-warning)',
    expired: 'var(--color-danger)',
  } as const,

  // Button variants
  button: {
    primary: {
      bg: 'var(--color-primary-action)',
      text: 'var(--color-on-primary-action)',
      border: 'none',
    },
    secondary: {
      bg: 'transparent',
      text: 'var(--color-text)',
      border: 'var(--color-border)',
    },
  } as const,
} as const;

export type Tokens = typeof tokens;

/**
 * Generates CSS custom properties string for injection into :root.
 * Called once at app startup or included in global CSS.
 */
export function generateCssVariables(): string {
  const { color, font, radius, space, shadow } = tokens;
  const lines: string[] = [':root {'];

  // Colors
  Object.entries(color).forEach(([key, value]) => {
    const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    lines.push(`  --color-${cssKey}: ${value};`);
  });

  // Fonts
  Object.entries(font).forEach(([key, value]) => {
    lines.push(`  --font-${key}: ${value};`);
  });

  // Radius
  Object.entries(radius).forEach(([key, value]) => {
    lines.push(`  --radius-${key}: ${value};`);
  });

  // Spacing
  Object.entries(space).forEach(([key, value]) => {
    lines.push(`  --space-${key}: ${value};`);
  });

  // Shadows
  Object.entries(shadow).forEach(([key, value]) => {
    lines.push(`  --shadow-${key}: ${value};`);
  });

  lines.push('}');
  return lines.join('\n');
}

/**
 * Runtime injection of CSS variables (used in main.tsx before React mounts).
 * Ensures tokens are available even if global CSS hasn't loaded yet.
 */
export function injectCssVariables(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'ikuck-design-tokens';
  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = generateCssVariables();
}