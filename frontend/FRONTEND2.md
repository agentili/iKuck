# A tavola

This branch implements the approved editorial redesign of iKuck as **A tavola**. Its peach-cream and plum foundation now has brighter basil, berry, tomato, lemon, ocean and violet accents. Recipe cards get category-matched pastel surfaces, while shortcut panels, navigation and primary actions use high-contrast color. The compact desktop header, mobile bottom navigation, and recipe-first Home remain in place. On mobile the Home presents the recipe directly without the plate illustration. When the pantry is empty, one clear action takes the user to add an ingredient.

The existing React, Vite, Zustand, IndexedDB adapters, local-first scopes, shared contracts, and same-origin API client remain in place. No new dependency or shared-contract change was required. The backend now exposes the requested `/v1/health` readiness alias and continues to support `/healthz`. Home ranks local suggestions using available ingredients, dietary restrictions, and saved preferences. Pantry, lots, shopping groups, recipe results, and activity use explicit pagination, defaulting to 20 items with 10/20/40 page-size options. Recipe detail retains favorite, rating, and note controls; preferences affect Home ranking. In-app notices cover saved preferences, sync status, expiry, offline edits, network errors, and recovered pantry copies.

## Simplifications

- AI generation is kept out of Home and available from a secondary disclosure in Recipes, for verified accounts that have enabled consent.
- Bring is hidden behind an explicit section in Shopping. The app only loads Bring status when the user opens that section; the local shopping list remains the default and works offline.
- Pantry conflict recovery and import confirmations remain available in secondary sections rather than dominating the main pantry flow.
- Account, shared-house, recipe diary, saved recipes, and existing backend features remain available; their data contracts and stored data are preserved.

## Run locally

Use Node 24 or newer from the repository root:

```sh
npm ci --prefix frontend
npm run dev --prefix frontend
```

Vite proxies relative `/v1/*` requests to the API on port 3000. Requests keep the existing HttpOnly session cookie, same-origin CSRF header, and `credentials: 'include'`. The PWA keeps `version.json`, offline shell caching, theme support, and shortcuts for Pantry, Shopping, and Activity.

## Checks

```sh
npm run lint --prefix frontend
npm test --prefix frontend -- --run
npm run build --prefix frontend
npm run test:e2e --prefix frontend -- --workers=2
npm run test:e2e:pwa --prefix frontend -- --workers=2
npm run test:e2e:a11y --prefix frontend -- --workers=2
```

On a machine without Playwright's pinned Chromium, set `IKUCK_PLAYWRIGHT_EXECUTABLE_PATH` to an installed Chromium executable. The override is optional; default browser selection is unchanged.

## Final validation

- Frontend lint passed; Vitest passed **868 tests in 90 files**; Vite production build passed.
- Backend lint and build passed; Vitest passed **613 tests** with **89 existing skips**.
- Full desktop/mobile/accessibility E2E passed **204 tests**, with **one existing project-specific skip**. PWA update passed **1 test**.
- Final responsive/axe checks passed **22 tests**; dark-mode checks passed **13 tests**, with **one existing screenshot skip**. The test covered 320 px at 200% text, 390/768/1440 px layouts, theme persistence, CSS-backed browser theme color, and offline startup.
- `git diff --check` passed. The repository's `npm run verify` wrapper itself could not run because PowerShell is not installed in this environment; its lint, unit-test, and build steps were executed directly and passed.
- Live backend/account and external-provider smoke checks were not run because no API service or disposable account was available. Browser E2E uses isolated fixtures and mocked API responses.

The production build emits a Vite advisory because the minified application JavaScript chunk is about 575 kB (167 kB gzip). The build and PWA generation still complete successfully.

The final browser artifacts, screenshots, and detailed run results are under `/workspace/artifacts/implementation/` in `e2e-report/`, `e2e-dark-report/`, `e2e-responsive/`, and `e2e-results/`.
