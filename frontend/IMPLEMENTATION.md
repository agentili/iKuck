# A tavola implementation ledger

Approved baseline: existing frontend2 working tree, now with a more vivid peach-cream/plum/basil/berry/tomato/sunshine editorial palette and pastel recipe/category panels. Preserve existing edits and all local-first data contracts. Desktop horizontal navigation; mobile bottom navigation and recipe-first Home without plate illustration.

## Functional matrix and destinations

| Capability | Destination | Offline / access | Owner |
|---|---|---|---|
| Automatic personalized suggestions, saved scoped recipes, alternate ideas | Home | Local, all users | P3 |
| Session, offline and active scope visibility | Header | All users | P3 |
| Ingredients, lots, expiry, staples, dietary restrictions | Pantry | Local writes | P4 |
| Conflict recovery and import confirmations | Pantry secondary sections | Existing scope protections | P4 |
| Shopping CRUD, purchase and undo | Shopping | Local writes | P4 |
| Bring connection and lists | Shopping secondary explicit section | Verified account, online | P4 |
| Catalog, saved/generated recipes, search, preferences | Recipes/detail | Existing persistence contracts | P5 |
| AI generation and consent | Recipes secondary explicit section | Verified, online | P5 |
| Cooking history, diary, reconstruction | Activity/Diary | Local; AI explicit consent | P6 |
| Profile, auth, house roles/invites/import | Existing account routes | Existing session/scope protections | P7 |
| Pagination and scoped notifications | Shared components | Local/sync states distinguished | P2 |
| Theme, accessibility, reusable surfaces | Shared CSS and tokens | Light/dark | P1 |
| PWA/version/shortcuts and browser suites | Build/E2E | Offline shell and local data | P8 |

## Orchestration

Root owns integration, routing/build configuration, full gates, screenshots and final review. At most three implementation agents run simultaneously. Every file has one current owner. Agents run focused tests; root runs integrated gates after delivery. No commits, pushes or deployment are part of this task.

Wave 1: P1 design tokens/CSS and P2 pagination/notifications.
Wave 2: P3 shell/Home, P4 pantry/shopping, P5 recipes/detail.
Wave 3: P6 diary/activity, P7 account/auth, P8 browser/PWA/docs.

Baseline diff and status are retained outside checkout in /workspace/artifacts/implementation. No baseline test result is assumed valid for the completed implementation.

## Acceptance

Frontend lint/build/unit; repository verify; offline desktop/mobile E2E; PWA and accessibility suites; disposable live account/sync smoke; screenshots at 390x844 and 1440x1100 plus 320/768 layouts and dark mode. External provider calls are mocked in ordinary suites; real provider smoke requires disposable credentials. Never mark a blocked check passed or delete coverage merely to make tests pass.

## Results

Implementation complete on `frontend2` as **A tavola**. The redesign keeps existing local-first storage, scope and API contracts, while making the Home recipe-first, paginating large lists, showing scoped in-app notices, and deferring Bring/AI integrations behind explicit secondary sections. Mobile Home uses the direct recipe presentation without plate artwork.

Validation passed:

- Frontend lint, **868/868** Vitest tests, and Vite production build.
- Backend lint and build; **613 passed / 89 skipped** backend tests.
- Main desktop/mobile/accessibility E2E: **204 passed / 1 existing skip**; PWA update: **1 passed**.
- Responsive and axe checks: **22 passed**. Dark-mode checks: **13 passed / 1 existing screenshot skip**.
- `git diff --check`.

The `npm run verify` PowerShell wrapper could not start because PowerShell is absent from this environment. The wrapper's frontend/backend lint, unit-test, and build commands were run directly and passed. Live API/account and external-provider smoke checks remain unverified because no running API service or disposable account was available; standard browser runs use isolated fixtures and mocked API responses. Vite reports an advisory for the 575 kB minified application chunk; build succeeds.

Reports and screenshots are in `/workspace/artifacts/implementation/`: `e2e-report/index.html`, `e2e-dark-report/index.html`, `e2e-responsive/`, and `e2e-results/summary.md`.
