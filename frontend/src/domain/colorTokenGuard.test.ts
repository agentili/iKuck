import { describe, expect, it } from 'vitest';

const SOURCE_FILES = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;
const THEME_COLOR_HASH = String.fromCharCode(35);
const LIGHT_THEME_COLOR = `${THEME_COLOR_HASH}247A4A`;
const DARK_THEME_COLOR = `${THEME_COLOR_HASH}101613`;
const ALLOWED_THEME_COLOR_LINES = [
  {
    path: /(?:^|\/)colorTheme\.ts$/,
    lines: new Set([
      `const LIGHT_THEME_COLOR = '${LIGHT_THEME_COLOR}';`,
      `const DARK_THEME_COLOR = '${DARK_THEME_COLOR}';`,
    ]),
  },
  {
    path: /(?:^|\/)colorTheme\.test\.ts$/,
    lines: new Set([
      `themeColorMeta.content = '${LIGHT_THEME_COLOR}';`,
      `expect(meta?.content).toBe('${DARK_THEME_COLOR}');`,
      `expect(meta?.content).toBe('${LIGHT_THEME_COLOR}');`,
      `expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('${DARK_THEME_COLOR}');`,
    ]),
  },
];
const HARDCODED_COLOR = /#[\da-f]{3,8}\b|(?:rgba?|hsla?|oklch|color)\s*\(/gi;

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
