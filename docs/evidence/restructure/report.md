# T8 — Verifica completa ristrutturazione frontend

## Stato
- Branch: `feat/frontend-ux-restructure` (HEAD `b50ef61`)
- Before: commit `59ff43b` (Merge feat/dark-mode — base della ristrutturazione)
- After: HEAD `b50ef61` (T2-T7 già integrati)
- Nessun bump di versione, nessun tag: solo branch.

## Esito gate completo (branch, dopo fix di verifica)

| Check | Esito | Note |
|---|---|---|
| Lint (`eslint`) | verde | `--max-warnings 0`, albero pulito |
| Unit (vitest) | 853 / 853 verdi | 86 file |
| Build PWA (`tsc` + `vite build`) | verde | 20 entry precache, `dist/sw.js` generato |
| `version.json` | OK | `{"name":"iKuck","version":"1.12.4","buildId":"b50ef61fa69b"}` (nessun bump) |
| E2E completa (`playwright test`) | 203 passati, 0 falliti, 3 skip | Chromium mobile + desktop, server di preview locale |
| Axe (accessibilità, entrambi i temi) | 35 / 35 verdi | `accessibility.spec.ts` estesa (v. sotto) |

## Screenshot before/after

Cartella: `docs/evidence/restructure/`
Convenzione: `<page>-<w>-<theme>-{before,after}.png`
Breakpoint: `320`, `390`, `768`, `1280` px
Temi: `light`, `dark` (forzati via `localStorage ikuck-color-theme` prima del caricamento)
Pagine: home, recipes-library, recipe-detail, pantry, shopping-list, dinner-diary, activity, profile, house, not-found

- Prima (59ff43b): 72 file — 9 pagine × 4 breakpoint × 2 temi
- Dopo (HEAD): 80 file — 10 pagine × 4 breakpoint × 2 temi
- Totale: 152 PNG

**Nota `recipes-library`:** la rotta `/recipes` non esiste a `59ff43b` (spunta con T2/T4), quindi non esiste uno screenshot "before" per questa pagina: è nuova e ha solo la coppia "after".

Esempi di coppie (tutte le 152 seguono lo stesso pattern):
- `home-320-light-before.png` / `home-320-light-after.png`
- `home-390-dark-before.png` / `home-390-dark-after.png`
- `home-768-light-before.png` / `home-768-light-after.png`
- `home-1280-dark-before.png` / `home-1280-dark-after.png`
- `pantry-1280-light-before.png` / `pantry-1280-light-after.png` (due colonne >=1024px introdotte da T5)
- `recipe-detail-1280-light-before.png` / `recipe-detail-1280-light-after.png` (Ingredienti/Preparazione in PageSection da T4)
- `profile-390-dark-before.png` / `profile-390-dark-after.png`
- `house-320-light-before.png` / `house-320-light-after.png`
- `not-found-1280-light-before.png` / `not-found-1280-light-after.png`

## Confronto visivo

Metodo: differenza pixel (PIL `ImageChops.difference`, soglia 12/canale) su tutte le 72 coppie before/after esistenti, più ispezione visiva guidata di coppie rappresentative.

Risultato: tutte le differenze sono cambiamenti **intenzionali della ristrutturazione** (PageSection con bordi/token, intestazioni di sezione, dispensa a due colonne sopra i 1024px, shell/layout globale da index.css, prompt install PWA su mobile). Non sono state trovate regressioni: nessun elemento mancante, sovrapposizione, testo tagliato o allineamento rotto.

Coppie ispezionate visivamente (BEFORE vs AFTER affiancati + mappa diff amplificata):
- `home-1280-light`, `home-390-light`, `home-768-light`
- `pantry-1280-light`, `pantry-768-light`, `pantry-1280-dark`
- `shopping-list-1280-light`, `shopping-list-1280-dark`, `shopping-list-768-light`
- `activity-320-light`, `activity-390-light`, `activity-1280-light`
- `house-390-light`, `house-1280-light`
- `recipe-detail-1280-light`
- `not-found-320-light`, `not-found-390-light` (solo variazioni globali trascurabili)

## Accessibilità (axe)

`frontend/e2e/accessibility.spec.ts` estesa:
- gate axe (violazioni critical/serious bloccanti) su home, recipes-library, pantry, shopping-list, dinner-diary, activity, profile, house e recipe-detail
- ogni pagina verificata in **entrambi i temi** (light/dark) → 18 test parametrizzati
- scenari pre-esistenti mantenuti (Bring form, touch target 44px, zoom 200%, navigazione fissa mobile, reduced motion, ordine heading)

Esito: **35 / 35 verdi** (`accessibility-chromium`). Nota a margine: durante la verifica è emerso che ProfilePage non rendeva più alcun `<h1>` (la ristrutturazione aveva sostituito il titolo con `PageSection`, che usa `<h2>`), violando la regola axe `page-has-heading-one` e facendo fallire `dark-mode.spec.ts` (zero tolleranza). Fix: prop `titleLevel` su `PageSection` (default `h2`, invariato per gli usi esistenti) e `titleLevel="h1"` sui due titoli di ProfilePage (ospite e verificato). `dark-mode.spec.ts` ora 13/13 verde.

## File modificati in questa verifica
- `frontend/e2e/accessibility.spec.ts` — copertura axe estesa (pagine + entrambi i temi)
- `frontend/src/components/ui/PageSection.tsx` — prop `titleLevel` (fix regressione h1)
- `frontend/src/pages/ProfilePage.tsx` — titoli del profilo resi `<h1>`
- `docs/evidence/restructure/` — 152 screenshot before/after + questo report

Sorgenti della ristrutturazione (T2-T7) già presenti nel worktree: non toccati da questa task.
