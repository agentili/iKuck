# Tech Spec: iKuck Dark Mode (ADR-004)

Branch: `feat/dark-mode` (workdir `/home/hermes/iKuck`) · Board: `ikuck-dark-mode`
Deadline: 2026-10-18 08:58 CEST · Scope: frontend-only, no backend/DB/contract changes.

## 1. Architecture (summary)

`<html data-theme="light|dark">` flips two variable sets declared in
`frontend/src/index.css`:

1. `--tk-*` channel triplets → consumed by `tailwind.config.js` via
   `'rgb(var(--tk-<name>) / <alpha-value>)'` (covers all 464 palette usages
   incl. opacity modifiers, light mode bit-identical).
2. `--ik-*` semantic tokens → consumed by `.ik-*` classes, `::selection`,
   focus ring, shadows (only light values change where noted).

No component TSX edits are required for color. Component edits are limited
to: theme switch UI (Profile + header), `main.tsx` boot call,
`index.html` pre-paint script + dynamic `theme-color`.

## 2. Data model / persistence

| Key | Values | Default | Notes |
|---|---|---|---|
| `localStorage['ikuck-color-theme']` | `light` \| `dark` \| `system` | `system` | Mirror of `ikuck-motion-preference`; never throws (storage-disabled → session-only `system`) |
| `html.dataset.theme` | `light` \| `dark` | resolved | Set pre-paint by inline script; `applyColorTheme()` re-applies on change |
| `<meta name="theme-color">` | `#247A4A` (light) / `#101613` (dark) | by theme | Updated at runtime with the theme |
| manifest `theme_color`/`background_color` | unchanged (`#247A4A` / `#FAFBF7`) | — | Splash is first-paint only; runtime chrome handled by meta |

## 3. API contracts

None. No endpoints, no `shared/src/contracts.ts` change, no `SyncEntityType`.

## 4. Token tables

### 4.1 `--tk-*` light values (copy exactly from Tailwind defaults → light unchanged)

```css
:root {
  --tk-white: 255 255 255;
  --tk-gray-50: 249 250 251;   --tk-gray-100: 243 244 246;  --tk-gray-200: 229 231 235;
  --tk-gray-300: 209 213 219;  --tk-gray-400: 156 163 175;  --tk-gray-500: 107 114 128;
  --tk-gray-600: 75 85 99;     --tk-gray-700: 55 65 81;     --tk-gray-800: 31 41 55;
  --tk-gray-900: 17 24 39;     --tk-gray-950: 3 7 18;
  --tk-emerald-50: 236 253 245; --tk-emerald-100: 209 250 229; --tk-emerald-200: 167 243 208;
  --tk-emerald-300: 110 231 183; --tk-emerald-500: 16 185 129; --tk-emerald-600: 5 150 105;
  --tk-emerald-700: 4 120 87;  --tk-emerald-800: 6 95 70;   --tk-emerald-900: 6 78 59;
  --tk-emerald-950: 2 44 34;
  --tk-amber-50: 255 251 235;  --tk-amber-100: 254 243 199; --tk-amber-200: 253 230 138;
  --tk-amber-300: 252 211 77;  --tk-amber-400: 251 191 36;  --tk-amber-500: 245 158 11;
  --tk-amber-700: 180 83 9;    --tk-amber-800: 146 64 14;   --tk-amber-900: 120 53 15;
  --tk-amber-950: 69 26 3;
  --tk-rose-50: 255 241 242;   --tk-rose-100: 255 228 230;  --tk-rose-200: 254 205 211;
  --tk-rose-300: 253 164 175;  --tk-rose-600: 225 29 72;    --tk-rose-700: 190 18 60;
  --tk-rose-800: 159 18 57;    --tk-rose-900: 136 19 55;    --tk-rose-950: 76 5 25;
  --tk-red-50: 254 242 242;    --tk-red-100: 254 226 226;   --tk-red-200: 254 202 202;
  --tk-red-300: 252 165 165;   --tk-red-700: 185 28 28;     --tk-red-800: 153 27 27;
  --tk-red-900: 127 29 29;     --tk-red-950: 69 10 10;
  --tk-porcelain: 250 251 247; --tk-ink: 24 48 40;          --tk-basil: 36 122 74;
  --tk-sage: 225 236 228;      --tk-tomato: 217 76 53;       --tk-yolk: 242 190 62;
}
```

### 4.2 `--tk-*` dark seed (HSL lightness inversion; **tune visually, axe is the arbiter**)

```css
html[data-theme='dark'] {
  --tk-white: 19 26 22;
  --tk-gray-50: 17 20 23;    --tk-gray-100: 22 24 27;   --tk-gray-200: 33 35 39;
  --tk-gray-300: 48 51 57;   --tk-gray-400: 89 94 103;  --tk-gray-500: 132 137 146;
  --tk-gray-600: 158 165 175; --tk-gray-700: 174 181 193; --tk-gray-800: 197 205 216;
  --tk-gray-900: 210 216 229; --tk-gray-950: 226 231 245;
  --tk-emerald-50: 6 43 26;  --tk-emerald-100: 10 67 38; --tk-emerald-200: 18 102 64;
  --tk-emerald-300: 31 152 104; --tk-emerald-500: 76 232 181; --tk-emerald-600: 106 244 201;
  --tk-emerald-700: 132 246 213; --tk-emerald-800: 154 244 219; --tk-emerald-900: 169 245 225;
  --tk-emerald-950: 198 250 238;
  --tk-amber-50: 47 38 2;    --tk-amber-100: 77 63 5;   --tk-amber-200: 130 106 8;
  --tk-amber-300: 183 142 11; --tk-amber-400: 218 161 13; --tk-amber-500: 236 157 23;
  --tk-amber-700: 239 149 80; --tk-amber-800: 235 158 110; --tk-amber-900: 235 170 133;
  --tk-amber-950: 248 202 176;
  --tk-rose-50: 41 2 5;      --tk-rose-100: 53 2 6;     --tk-rose-200: 72 4 13;
  --tk-rose-300: 107 7 19;   --tk-rose-600: 219 42 81;  --tk-rose-700: 230 72 111;
  --tk-rose-800: 231 99 136; --tk-rose-900: 231 120 154; --tk-rose-950: 246 171 192;
  --tk-red-50: 39 5 5;       --tk-red-100: 54 4 4;      --tk-red-200: 75 5 5;
  --tk-red-300: 106 8 8;     --tk-red-700: 221 77 77;   --tk-red-800: 223 105 105;
  --tk-red-900: 221 128 128; --tk-red-950: 241 178 178;
  --tk-porcelain: 16 22 19;  --tk-ink: 232 239 233;     --tk-basil: 69 184 119;
  --tk-sage: 28 40 35;       --tk-tomato: 255 138 122;  --tk-yolk: 242 190 62;
}
```

Verified contrast on seed values (WCAG AA): body 15.7:1 · muted 7.5:1 ·
primary button 7.3:1 · selection 8.2:1 · warn pair 8.5:1 · chips 6.9–9.9:1 ·
hover rows 11.1:1.

### 4.3 `--ik-*` dark overrides (semantic layer)

```css
html[data-theme='dark'] {
  color-scheme: dark; /* native controls, scrollbars, form widgets */
  --ik-porcelain: #101613;   /* page bg */
  --ik-surface: #171e1a;     /* cards, inputs */
  --ik-ink: #e8efe9;         /* text AND flipped high-emphasis panels */
  --ik-ink-muted: #9fb0a7;
  --ik-basil: #45b877;       /* button bg with --ik-porcelain text = 7.3:1 */
  --ik-basil-dark: #3aa16a;  /* hover */
  --ik-sage: #1c2823;
  --ik-mist: #1a211d;
  --ik-yolk: #f2be3e;        /* unchanged */
  --ik-yolk-soft: #3a2f0e;
  --ik-tomato: #ff8a7a;
  --ik-tomato-soft: #3a1512;
  --ik-border: #2b3630;
  --ik-border-strong: #3f4d45;
  --ik-focus: #f5c451;
  --ik-shadow-surface: 0 12px 30px rgb(0 0 0 / 0.45);
  --ik-shadow-lift: 0 16px 32px rgb(0 0 0 / 0.55);
}
```

New tokens introduced (both modes defined in `:root`, dark overrides above):

| Token | light | dark | Replaces |
|---|---|---|---|
| `--ik-on-yolk` | `#183028` (constant) | (same) | `color:` on any yolk background |
| `--ik-yolk-hover` | `#f8cf69` | `#f6d47e` | hex literal in `.ik-action-panel button:hover` |
| `--ik-warn-ink` | `#8a5700` | `#f2ca7a` | hex literal on one-purchase cards (with `--ik-yolk-soft`) |
| `--ik-accent-border` | `#e0b348` | `#8a6a1e` | hex literal `.ik-results-group--one-purchase` |
| `--ik-accent-border-2` | `#dcae40` | `#8a6a1e` | hex literal `.ik-recipe-card[data-availability='one-missing']` |

## 5. Module contract: `src/domain/colorTheme.ts`

Mirror `motionPreference.ts` exactly (same error semantics, TDD):

```ts
export type ColorThemePreference = 'light' | 'dark' | 'system';
export const hasUnpersistedColorTheme = (): boolean;      // storage-throw fallback
export const getColorThemePreference = (): ColorThemePreference;
export const resolveColorTheme = (): 'light' | 'dark';    // system → matchMedia
export const applyColorTheme = (): void;                  // sets data-theme + meta theme-color
export const saveColorThemePreference = (p): boolean;     // persist + apply, returns persisted
export const watchSystemColorTheme = (): void;            // matchMedia listener, 'system' only
```

- `index.html <head>` inline script (before any CSS/network):
  `try{var t=localStorage.getItem('ikuck-color-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}`
  (resolved value; `system` tracks changes via `watchSystemColorTheme`).
- `main.tsx`: `applyColorTheme(); watchSystemColorTheme();` next to
  `applyMotionPreference()`.
- Meta theme-color updated inside `applyColorTheme()`.

## 6. UI (copy in Italian)

- **Profile** (next to «Movimento ridotto»): group «Tema» with three options
  Chiaro / Scuro / Sistema, `role="radiogroup"`, 44px targets, persists via
  `saveColorThemePreference`.
- **Header quick toggle** (AppHeader desktop + mobile account row): button
  cycling light → dark → system? No — single binary quick toggle
  (dark ⇄ light, switching to the opposite of current resolved) with
  `aria-label` «Attiva tema scuro/ chiaro »; if preference is `system` the
  first press pins the opposite of resolved. Full three-way stays in Profile.
- No toast needed; state is immediately visible.

## 7. Error handling & security

- All storage access in `try/catch` (private-mode/quota) → fallback `system`,
  `saveColorThemePreference` returns `false` like motion does.
- No new secrets, no server calls, no CSP impact (inline script is
  same-origin, non-executing logic; keep it tiny and dependency-free).
- Guest data untouched; theme is device-local (consistent with motion).

## 8. Test strategy (TDD — RED first, evidence required)

1. **Unit** `colorTheme.test.ts` (mirror `motionPreference.test.ts`):
   default `system`; persist/restore each value; storage-throw fallback +
   `hasUnpersistedColorTheme`; `resolveColorTheme` with
   `matchMedia` mocked both ways; `applyColorTheme` sets `data-theme` and
   meta; `watchSystemColorTheme` reacts to change events.
2. **Guard test**: scan `src/**/*.{ts,tsx}` for hex literals / `bg-|#`-arbitrary
   colors → fail on any new occurrence (allowlist current 2 or fix them in
   this release so the list starts empty).
3. **Component test**: Profile theme group renders 3 options, click persists,
   header toggle flips `data-theme` (RED before implementation).
4. **E2E (Playwright)**: set «Scuro» → `html[data-theme=dark]`, reload → still
   dark; «Sistema» + `emulateMedia({colorScheme:'dark'})` → dark follows;
   screenshots for the report.
5. **axe**: run on home / shopping-list / recipe-detail / profile in BOTH
   themes; color-contrast violations = blocker.
6. **Regression**: full unit suite (≥761), lint, `npm run build`, full E2E
   gate — light mode must be unchanged (bit-identical `:root` guarantee).

## 9. Known traps (check every one before requesting review)

- Yolk + ink pairs must use `--ik-on-yolk`, never `var(--ik-ink)`
  (`::selection`, `.ik-action-panel button`).
- `#8a5700 / #f8cf69 / #e0b348 / #dcae40` literals in `index.css` → promoted
  to tokens (table §4.3); `.ik-recipe-card` `rgb(24 48 40 / …)` shadows →
  token shadows.
- `.ik-action-panel` inverts to a light panel in dark mode (full-inversion
  rule, consistent with `bg-gray-950` panels); verify yolk button readability
  against it (axe + visual); if it reads muddy, add a hairline border to the
  button in dark only — do NOT fork the ink token.
- `text-white` over any photo/overlay must be re-checked (expected: none —
  verified no gradients; hero uses solid panels).
- `disabled:opacity-*`, `* /70` opacity modifiers must still work → the
  `<alpha-value>` pattern is mandatory, plain `var()` colors are forbidden.
- PWA: keep the inline script tiny (it runs pre-paint on every load).

## 10. Definition of done (release gate)

Board `ikuck-dark-mode`: all cards done → reviewer GO/NO-GO → deployops
release (bump `frontend/package.json` → 1.11.0, tag, standalone deploy,
verify `https://94z8ppoemd4qoscr.myfritz.net:30443` serves dark theme, no
regressions) → resoconto decisioni al team in chat.