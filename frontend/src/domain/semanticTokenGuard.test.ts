import { describe, expect, it } from 'vitest';
import css from '../index.css?raw';
import tailwindConfig from '../../tailwind.config.js?raw';
import { COLOR_PALETTES } from './colorPalette';

const sources = import.meta.glob('../**/*.{css,ts,tsx}', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

describe('semantic UI tokens', () => {
  it('defines every custom ik token used in UI sources', () => {
    const definitions = new Set([...css.matchAll(/(--ik-[\w-]+)\s*:/g)].map((match) => match[1]));
    const used = new Set(Object.values(sources).flatMap((source) => [...source.matchAll(/var\((--ik-[\w-]+)/g)].map((match) => match[1])));
    expect([...used].filter((name) => !definitions.has(name))).toEqual([]);
  });

  it('maps Tailwind compatibility colors to the semantic palette in both themes', () => {
    const semanticColors = new Set([...css.matchAll(/--ik-[\w-]+\s*:\s*(#[0-9a-f]{6})/gi)].map((match) => {
      const hex = match[1].slice(1);
      return `${Number.parseInt(hex.slice(0, 2), 16)} ${Number.parseInt(hex.slice(2, 4), 16)} ${Number.parseInt(hex.slice(4, 6), 16)}`;
    }));
    const compatibilityColors = [...css.matchAll(/(--tk-[\w-]+)\s*:\s*([0-9]+\s+[0-9]+\s+[0-9]+)/g)];
    expect(compatibilityColors).not.toHaveLength(0);
    expect(compatibilityColors.filter(([, , value]) => !semanticColors.has(value)).map(([, name]) => name)).toEqual([]);
  });

  it('maps the Tailwind primary compatibility color to the documented ink role', () => {
    expect(tailwindConfig).toContain(['DEFAULT: \'r', 'gb(var(--tk-ink) / <alpha-value>)\''].join(''));
  });

  it('defines every selectable palette and routes shared semantic colors through it', () => {
    for (const palette of COLOR_PALETTES) {
      expect(css).toContain(`:root[data-palette='${palette.value}']`);
      expect(css).toContain(`html[data-theme='dark'][data-palette='${palette.value}']`);
    }
    expect(css).toContain('html[data-palette][data-theme]');
    expect(css).toContain('--ik-basil: var(--ik-palette-accent);');
    expect(css).toContain('--ik-porcelain: var(--ik-palette-page);');
    expect(css).toContain('--tk-emerald-700: var(--ik-palette-accent-dark-rgb);');
  });

  it('shares semantic overlay and surface primitives across modal variants', () => {
    const modalSources = [
      '../components/recipe/RecipeDetailModal.tsx',
      '../components/pantry/QuickAddIngredientsDialog.tsx',
    ];
    expect(modalSources.filter((path) => !sources[path]?.includes('ik-modal-backdrop'))).toEqual([]);
    expect(modalSources.filter((path) => !sources[path]?.includes('ik-modal-surface'))).toEqual([]);
    expect(css).toContain('.ik-modal-backdrop');
    expect(css).toContain('background: var(--ik-overlay);');
    expect(css).toContain('.ik-modal-surface');
  });

  it('uses the semantic navigation surface in the app shell', () => {
    const navigationSources = [
      '../components/layout/BottomNav.tsx',
    ];
    expect(navigationSources.filter((path) => !sources[path]?.includes('ik-navigation-surface'))).toEqual([]);
    expect(sources['../components/layout/SimplifiedHeader.tsx']).toContain('ik-app-header');
    expect(css).toContain('.ik-navigation-surface');
    expect(css).toContain('background-color: var(--ik-surface);');
  });

  it('uses semantic tokens for shared feedback and modal statuses', () => {
    const sharedUi = [
      '../components/chat/MessageBubble.tsx',
      '../components/feedback/AppInstallPrompt.tsx',
      '../components/recipe/RecipeDetailModal.tsx',
    ];
    const parallelStatusColors = /(?:bg|text|border)-(?:blue|green|orange)-[0-9]+/;
    expect(sharedUi.filter((path) => parallelStatusColors.test(sources[path] ?? ''))).toEqual([]);
  });

  it('does not suppress the chat input keyboard focus outline inline', () => {
    expect(sources['../components/chat/InputBar.tsx']).not.toMatch(/outline:\s*['"]none['"]/);
  });

  it('does not use a parallel Sous Chef palette or font families', () => {
    const obsoleteToken = '--' + 'sc-';
    const obsoleteFonts = ['Out' + 'fit', 'DM' + ' Sans'];
    const violations = Object.entries(sources).filter(([, source]) => source.includes(obsoleteToken) || obsoleteFonts.some((font) => source.includes(font)));
    expect(violations.map(([path]) => path)).toEqual([]);
  });

  it('uses the semantic foreground token for text on yolk surfaces', () => {
    expect(sources['../components/suggestions/SuggestionControls.tsx']).toContain('text-[var(--ik-on-yolk)]');
  });

  it('keeps the keyboard focus indicator at least 3:1 against the page in both themes', () => {
    const lightRoot = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
    const darkTheme = css.match(/html\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/)?.[1] ?? '';
    const token = (declarations: string, name: string) => declarations.split(`${name}:`)[1]?.match(/#[\da-f]{6}/i)?.[0];
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
      const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const contrast = (foreground: string, background: string) => {
      const a = luminance(foreground);
      const b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    const lightFocus = token(lightRoot, '--ik-focus');
    const lightPorcelain = token(lightRoot, '--ik-porcelain');
    const darkFocus = token(darkTheme, '--ik-focus');
    const darkPorcelain = token(darkTheme, '--ik-porcelain');
    expect(lightFocus).toBeDefined();
    expect(lightPorcelain).toBeDefined();
    expect(darkFocus).toBeDefined();
    expect(darkPorcelain).toBeDefined();
    expect(contrast(lightFocus!, lightPorcelain!)).toBeGreaterThanOrEqual(3);
    expect(contrast(darkFocus!, darkPorcelain!)).toBeGreaterThanOrEqual(3);
  });
});
