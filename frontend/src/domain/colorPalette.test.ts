import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let colorPalette: typeof import('./colorPalette');
let paletteTokenStyle: HTMLStyleElement | null = null;
let addedThemeColorMeta = false;
const paletteIds = ['pistachio-lemon', 'peach-coral', 'lavender-blueberry', 'sea-terracotta'] as const;

beforeEach(async () => {
  vi.resetModules();
  colorPalette = await import('./colorPalette');
  window.localStorage.clear();
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.palette = colorPalette.DEFAULT_COLOR_PALETTE;

  paletteTokenStyle = document.createElement('style');
  paletteTokenStyle.textContent = `
    :root[data-palette='pistachio-lemon'] { --ik-browser-theme-color: light-pistachio; }
    :root[data-palette='peach-coral'] { --ik-browser-theme-color: light-peach; }
  `;
  document.head.append(paletteTokenStyle);

  let themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeColorMeta) {
    themeColorMeta = document.createElement('meta');
    themeColorMeta.name = 'theme-color';
    document.head.append(themeColorMeta);
    addedThemeColorMeta = true;
  }
});

afterEach(() => {
  paletteTokenStyle?.remove();
  paletteTokenStyle = null;
  if (addedThemeColorMeta) {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.remove();
    addedThemeColorMeta = false;
  }
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('data-theme');
});

describe('device-only color palette preference', () => {
  it('provides the four saved palettes and defaults to Pistacchio e limone', () => {
    expect(colorPalette.COLOR_PALETTES.map(({ id }) => id)).toEqual([
      'pistachio-lemon',
      'peach-coral',
      'lavender-blueberry',
      'sea-terracotta',
    ]);
    expect(colorPalette.getColorPalettePreference()).toBe('pistachio-lemon');
    expect(colorPalette.COLOR_PALETTES[0].label).toBe('Pistacchio e limone');
  });

  it.each(paletteIds)('persists and applies the %s palette', (paletteId) => {
    expect(colorPalette.saveColorPalettePreference(paletteId)).toBe(true);
    expect(window.localStorage.getItem('ikuck-color-palette')).toBe(paletteId);
    expect(colorPalette.getColorPalettePreference()).toBe(paletteId);
    expect(document.documentElement.dataset.palette).toBe(paletteId);
    expect(colorPalette.hasUnpersistedColorPalette()).toBe(false);
  });

  it('falls back to the default for an unknown saved palette', () => {
    window.localStorage.setItem('ikuck-color-palette', 'unknown');

    expect(colorPalette.getColorPalettePreference()).toBe('pistachio-lemon');
    colorPalette.applyColorPalette();
    expect(document.documentElement.dataset.palette).toBe('pistachio-lemon');
  });

  it('updates the browser theme color when a palette is applied', () => {
    const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    colorPalette.saveColorPalettePreference('peach-coral');

    expect(themeColorMeta?.content).toBe('light-peach');
  });

  it('applies a session-only palette if local storage cannot save', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });

    expect(colorPalette.saveColorPalettePreference('lavender-blueberry')).toBe(false);
    expect(colorPalette.getColorPalettePreference()).toBe('lavender-blueberry');
    expect(colorPalette.hasUnpersistedColorPalette()).toBe(true);
    expect(document.documentElement.dataset.palette).toBe('lavender-blueberry');

    setItem.mockRestore();
  });
});
