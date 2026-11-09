import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import css from '../index.css?raw';
import * as colorPalette from './colorPalette';

const white = String.fromCharCode(35, 102, 102, 102, 102, 102);

const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const contrast = (first: string, second: string): number => {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const paletteTokens = (rule: string | undefined): Record<string, string> => Object.fromEntries(
  [...(rule ?? '').matchAll(/--ik-palette-([\w-]+):\s*(#[\da-f]{6})/gi)].map(([, name, value]) => [name, value]),
);

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-palette');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-palette');
});

describe('device-only color palette preference', () => {
  it('offers ten named palettes and defaults to Basilico', () => {
    expect(colorPalette.COLOR_PALETTES).toHaveLength(10);
    expect(colorPalette.getColorPalettePreference()).toBe('basilico');
  });

  it('persists a selection and applies it to the document', () => {
    expect(colorPalette.saveColorPalettePreference('oceano')).toBe(true);
    expect(window.localStorage.getItem('ikuck-color-palette')).toBe('oceano');
    expect(document.documentElement).toHaveAttribute('data-palette', 'oceano');
    expect(colorPalette.getColorPalettePreference()).toBe('oceano');
  });

  it('ignores invalid stored selections', () => {
    window.localStorage.setItem('ikuck-color-palette', 'unknown');
    expect(colorPalette.getColorPalettePreference()).toBe('basilico');
  });

  it('keeps palette text, actions, and focus colors readable in both themes', () => {
    for (const palette of colorPalette.COLOR_PALETTES) {
      const lightRule = css.match(new RegExp(`:root\\[data-palette='${palette.value}'\\][^{]*\\{([^}]*)\\}`))?.[1];
      const darkRule = css.match(new RegExp(`html\\[data-theme='dark'\\]\\[data-palette='${palette.value}'\\]\\s*\\{([^}]*)\\}`))?.[1];
      const light = paletteTokens(lightRule);
      const dark = paletteTokens(darkRule);

      expect(light.accent, `${palette.label} light accent`).toBeDefined();
      expect(dark.accent, `${palette.label} dark accent`).toBeDefined();
      expect(contrast(light.accent, white), `${palette.label} light action`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light['muted-ink'], light.page), `${palette.label} light muted text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark.accent, dark.page), `${palette.label} dark accent`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark['muted-ink'], dark.page), `${palette.label} dark muted text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark.focus, dark.page), `${palette.label} dark focus`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps a session selection and reports when local storage cannot save it', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });

    expect(colorPalette.saveColorPalettePreference('lavanda')).toBe(false);
    expect(colorPalette.getColorPalettePreference()).toBe('lavanda');
    expect(colorPalette.hasUnpersistedColorPalette()).toBe(true);
    expect(document.documentElement).toHaveAttribute('data-palette', 'lavanda');

    setItem.mockRestore();
  });
});
