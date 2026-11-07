import { describe, expect, it } from 'vitest';

const SOURCE_FILES = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;
const THEME_COLOR_HASH = String.fromCharCode(35);
const LIGHT_THEME_COLOR = `${THEME_COLOR_HASH}191512`;
const DARK_THEME_COLOR = `${THEME_COLOR_HASH}191512`;
const ALLOWED_THEME_COLOR_LINES = [
  {
    path: /(?:^|[/\\])colorTheme\.ts$/,
    lines: new Set([
      `/* Autumn warm palette — dark-first. Both light/dark use the same bg until light theme is approved. */`,
      `const LIGHT_THEME_COLOR = '${LIGHT_THEME_COLOR}';`,
      `const DARK_THEME_COLOR = '${DARK_THEME_COLOR}';`,
    ]),
  },
  {
    path: /(?:^|[/\\])colorTheme\.test\.ts$/,
    lines: new Set([
      `themeColorMeta.content = '${LIGHT_THEME_COLOR}';`,
      `themeColorMeta.content = '#247A4A';`,
      `expect(meta?.content).toBe('${DARK_THEME_COLOR}');`,
      `expect(meta?.content).toBe('${LIGHT_THEME_COLOR}');`,
      `expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('${DARK_THEME_COLOR}');`,
    ]),
  },
  {
    path: /(?:^|[/\\])theme[/\\]tokens\.ts$/,
    lines: new Set([
      `bg: '#191512',`,
      `surface: '#261f1a',`,
      `border: '#4c4540',`,
      `primary: '#c76b43',`,
      `primaryAction: '#d98a63',`,
      `onPrimaryAction: '#191512',`,
      `accent: '#e3a857',`,
      `warning: '#ec8a3c',`,
      `danger: '#e0604f',`,
      `text: '#f6f2e9',`,
      `textMuted: '#9c9188',`,
      `focus: '#e3a857',`,
      `card: '0 4px 12px rgb(0 0 0 / 0.35)',`,
      `surface: '0 12px 30px rgb(0 0 0 / 0.45)',`,
      `lift: '0 16px 32px rgb(0 0 0 / 0.55)',`,
    ]),
  },
];
const HARDCODED_COLOR = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|color)\s*\(/gi;

const findColorViolations = (filePath: string, source: string): string[] => source
  .split(/\r?\n/)
  .flatMap((line, index) => {
    const trimmedLine = line.trim();
    const allowedFile = ALLOWED_THEME_COLOR_LINES.find(({ path }) => path.test(filePath));
    if (allowedFile?.lines.has(trimmedLine)) return [];
    return [...line.matchAll(HARDCODED_COLOR)].map((match) => `${filePath}:${index + 1}: ${match[0]}`);
  });

const scanSource = (): string[] => Object.entries(SOURCE_FILES)
  .flatMap(([path, source]) => findColorViolations(path.replace(/^(?:\.\.\/|\.\/)/, ''), source));

describe('hardcoded color guard', () => {
  it('detects arbitrary hardcoded colors while allowing token references', () => {
    const hex = String.fromCharCode(35, 102, 48, 48, 48, 48);
    const rgb = ['r', 'gb(24 48 40 / 0.5)'].join('');

    expect(findColorViolations('example.tsx', `const markup = \`<div className="bg-[${hex}]" />\`;`)).toHaveLength(1);
    expect(findColorViolations('example.tsx', `const style = { boxShadow: '${rgb}' };`)).toHaveLength(1);
    expect(findColorViolations('example.tsx', 'const className = "bg-[var(--ik-surface)]";')).toEqual([]);
  });

  it('scans the layout and dialog component sources', () => {
    const sourcePaths = Object.keys(SOURCE_FILES);

    expect(sourcePaths.some((path) => path.endsWith('AppHeader.tsx'))).toBe(true);
    expect(sourcePaths.some((path) => path.endsWith('QuickAddIngredientsDialog.tsx'))).toBe(true);
  });

  it('keeps UI source free of hardcoded colors and arbitrary color values', () => {
    expect(scanSource()).toEqual([]);
  });
});