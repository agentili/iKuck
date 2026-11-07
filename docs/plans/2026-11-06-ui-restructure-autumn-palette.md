# Piano ristrutturazione UI iKuck – Palette autunnale, organizzazione per feature, navigazione mobile-first

**Data:** 2026-11-06  
**Branch:** `release/v1.15.5` (analisi) → nuovo branch per implementazione  
**Obiettivo:** Rifattorizzare SOLO il livello di presentazione (UI) senza toccare store, IndexedDB, sync, auth, API, backend, `@ikuck/shared`.

---

## Vincoli obbligatori
- **Solo UI:** niente store Zustand, IndexedDB, sync, auth, API, backend, shared contracts.
- **Nessuna nuova dipendenza** (Tailwind, UI kit, web font) senza approvazione.
- **Convenzioni esistenti:** naming, formattazione, inglese per codice/commenti, italiano per copy utente.
- **Un passo alla volta:** build, lint, test dopo ogni passo → stop e OK.
- **Aggiornare test** (Given/When/Then) e README.md.
- **Chiedere se ambiguo/rischioso.**

---

## PASSO 0 – Analisi (completata, nessuna modifica)

### Mappa schermate e rotte

| Rotta | Pagina Legacy | Pagina SOUS-CHEF | Note |
|-------|---------------|------------------|------|
| `/` | `HomePage` | `ChatPage` | Landing legacy vs chat-first |
| `/recipes` | `RecipesPage` | `RecipesPage` | Condivisa |
| `/recipes/:id` | `RecipeDetailPage` | `RecipeDetailModal` | Modal in SOUS-CHEF |
| `/pantry` | `PantryPage` | `PantryPage` | Condivisa |
| `/shopping-list` | `ShoppingListPage` | `ShoppingListPage` | Condivisa |
| `/activity` | `ActivityPage` | `ActivityPage` | Condivisa |
| `/dinner-diary` | `DinnerDiaryPage` | `DinnerDiaryPage` | Condivisa |
| `/profile` | `ProfilePage` | `ProfilePage` | Condivisa |
| `/house` | `HousePage` | `HousePage` | Condivisa |
| `/discover` | — | `DiscoverPage` | Solo SOUS-CHEF |
| `/saved` | — | `SavedPage` | Solo SOUS-CHEF |
| `/chat` | — | `ChatPage` | Solo SOUS-CHEF |
| `/verify-email` | `VerifyEmailPage` | `VerifyEmailPage` | Auth |
| `/forgot-password` | `ForgotPasswordPage` | `ForgotPasswordPage` | Auth |
| `/reset-password` | `ResetPasswordPage` | `ResetPasswordPage` | Auth |

### Navigazione attuale

| Sistema | Desktop | Mobile | Componenti |
|---------|---------|--------|------------|
| **Legacy** | Sidebar fissa sinistra (16rem) + header top | Bottom nav fissa (5 tab: Cucina, Ricette, Dispensa, Spesa, Diario) | `AppHeader`, `AppNavigation` (in `index.css`) |
| **SOUS-CHEF** | Header semplificato fisso top | Bottom nav fissa (4 tab: Chef, Cerca, Piano, Salvate) | `SimplifiedHeader`, `BottomNav` |

### Componenti UI condivisi (riutilizzabili)

| Componente | File | Note |
|------------|------|------|
| `PageSection` | `components/ui/PageSection.tsx` | Section con eyebrow, titolo, descrizione, action |
| `EmptyState` | `components/ui/EmptyState.tsx` | Stato vuoto con action opzionale |
| `ErrorBanner` | `components/ui/ErrorBanner.tsx` | Banner errore (usa rose hardcoded) |
| `RecipeCard` | `components/ui/RecipeCard.tsx` | Card ricetta con varianti (salvata/ai/catalogo) |
| `IngredientChip` | `components/pantry/IngredientChip.tsx` | Chip ingrediente con rimozione |
| `UndoToast` | `components/feedback/UndoToast.tsx` | Toast con undo |
| `PantryMergeNotice` | `components/feedback/PantryMergeNotice.tsx` | Notice conflitti dispensa |

### Sistema colori attuale (`index.css`)

**Light theme (default):**
```css
--ik-porcelain: #FAF8F4;      /* bg */
--ik-ink: #28221C;            /* text primary */
--ik-ink-muted: #5A4E3E;      /* text muted */
--ik-apricot: #B87A54;        /* primary brand */
--ik-apricot-dark: #9A6240;   /* primary hover */
--ik-yolk: #E6AA3C;           /* accent/warning */
--ik-emerald-*: verde          /* PROBLEMA: verde in palette */
--ik-border: #E0D4C4;
--ik-surface: #FFFFFF;
```

**Dark theme:**
```css
--ik-porcelain: #28221C;
--ik-surface: #383028;
--ik-ink: #FAF0E6;
--ik-apricot: #D4B08C;
--ik-yolk: #F0D060;
--ik-emerald-*: verde          /* PROBLEMA: verde in palette */
```

**Token Tailwind compat (`--tk-*`)**: mapping completo per classi `bg-emerald-500`, `text-gray-900`, ecc.

### Colori hardcoded nei componenti (campione)

| Componente | Colori hardcoded (Tailwind/classi) |
|------------|-----------------------------------|
| `PantryPage` | `text-emerald-800`, `border-emerald-200`, `bg-emerald-50`, `text-gray-950`, `bg-white`, `accent-emerald-700`, `border-amber-*`, `bg-amber-*`, `text-amber-*` |
| `RecipesPage` | `text-emerald-800`, `border-emerald-200`, `bg-emerald-50`, `focus:border-emerald-700`, `text-gray-950`, `bg-white`, `border-gray-300`, `text-gray-900` |
| `ShoppingListPage` | `text-emerald-800`, `hover:bg-emerald-50`, `border-gray-300`, `bg-white` |
| `ActivityPage` | `border-emerald-200`, `bg-emerald-50`, `border-amber-200`, `bg-amber-50`, `text-gray-950` |
| `ProfilePage` | `text-emerald-800`, `border-emerald-200`, `bg-emerald-50`, `text-gray-950`, `bg-gray-50`, `border-gray-200`, `bg-gray-950`, `text-white`, `border-rose-300`, `bg-rose-700` |
| `HomePage` | `text-emerald-800`, `bg-emerald-50`, `border-emerald-200`, `text-gray-950`, `bg-white`, `text-emerald-900` |
| `RecipeCard` | `border-emerald-200`, `bg-emerald-50`, `text-emerald-900`, `border-gray-200`, `bg-gray-50`, `text-gray-900`, `text-gray-950`, `bg-white`, `border-gray-900` |
| `PageSection` | `text-emerald-800`, `text-gray-950`, `text-gray-700`, `border-[var(--ik-border)]` |
| `EmptyState` | `bg-gray-50`, `text-gray-700`, `border-gray-900` |
| `ErrorBanner` | `border-rose-200`, `bg-rose-50`, `text-rose-900` |
| `IngredientChip` | `text-ink`, `text-amber-800`, `text-emerald-800`, `hover:bg-emerald-100` |
| `PantryLotsPanel` | `text-red-700`, `text-amber-700`, `text-gray-600`, `border-red-200`, `bg-red-50`, `text-red-700`, `border-gray-200`, `bg-gray-50`, `border-gray-300`, `text-gray-800`, `hover:border-gray-900` |
| `StaplesPanel` | `border-gray-200`, `bg-white`, `bg-gray-50`, `accent-emerald-700` |
| `DietFiltersPanel` | `border-emerald-100`, `bg-emerald-50`, `text-emerald-900`, `border-emerald-200`, `accent-emerald-700`, `border-emerald-800` |
| `LocalRecipeCard` | `border-amber-200`, `bg-white`, `border-emerald-200`, `text-red-700`, `text-emerald-700`, `bg-amber-50`, `bg-amber-200`, `text-amber-950`, `bg-amber-400`, `text-gray-950`, `border-gray-900` |
| `AppHeader` | `border-gray-200`, `bg-white`, `text-gray-600`, `text-gray-800`, `text-gray-900`, `bg-gray-100`, `bg-emerald-100`, `text-emerald-950`, `bg-red-100`, `text-red-900`, `border-gray-300` |
| `BottomNav` | `bg-[var(--ik-sage)]`, `text-[var(--ik-basil-dark)]`, `bg-[var(--ik-mist)]` — **token NON ESISTONO** |
| `SimplifiedHeader` | `bg-[var(--ik-sage)]`, `text-[var(--ik-basil)]`, `bg-[var(--ik-mist)]`, `text-[var(--ik-tomato)]` — **token NON ESISTONO** |

### Font attuale
- **Unico font**: `Bricolage Grotesque Variable` (importato da `@fontsource-variable/bricolage-grotesque`)
- **Nessun font serif** per titoli

### Spaziature
- CSS custom properties: `--ik-space-1` (0.25rem) ... `--ik-space-6` (2rem)
- Radius: `--ik-radius-control` (12px), `--ik-radius-panel` (20px), `--ik-radius-feature` (28px), `--ik-radius-pill` (100px)
- Shadow: `--ik-shadow-card`, `--ik-shadow-surface`, `--ik-shadow-lift`, `--ik-shadow-navigation`

### Tema / Color Theme System
- `domain/colorTheme.ts`: gestisce preferenza `light | dark | system`
- Applica `data-theme="light|dark"` su `<html>`
- Aggiorna `meta[name="theme-color"]` con colori hardcoded (`LIGHT_THEME_COLOR = '#247A4A'` verde, `DARK_THEME_COLOR = '#101613'`)
- **Nessun token semantico per i nuovi colori autunnali**

---

## Piano implementazione

### PASSO 1 – Design Token (`src/theme/tokens.ts` + CSS variables)

| File | Modifica | Motivo |
|------|----------|--------|
| **NEW** `src/theme/tokens.ts` | Esporta token TypeScript + genera CSS custom properties per `:root` e `[data-theme='dark']` | Unica fonte di verità; niente hardcoded |
| `index.css` | Rimuovi `--tk-*`, `--ik-*` legacy; importa token da `tokens.ts` (o duplica in CSS); aggiungi font serif stack | Allineamento a palette autunnale, no verde |
| `domain/colorTheme.ts` | Aggiorna `LIGHT_THEME_COLOR`/`DARK_THEME_COLOR` a `#191512`; rimuovi riferimento a verde | Meta theme-color coerente |

**Nuova palette (dark-first come da requisiti):**
```css
:root {
  --color-bg: #191512;
  --color-surface: #261f1a;
  --color-border: #4c4540;
  --color-primary: #c76b43;
  --color-primary-action: #d98a63;
  --color-on-primary-action: #191512;
  --color-accent: #e3a857;
  --color-warning: #ec8a3c;
  --color-danger: #e0604f;
  --color-text: #f6f2e9;
  --color-text-muted: #9c9188;
  --font-serif: Georgia, 'Noto Serif', serif;
  --font-sans: 'Bricolage Grotesque Variable', system-ui, sans-serif;
  --radius-control: 12px;
  --radius-panel: 20px;
  --radius-feature: 28px;
  --radius-pill: 100px;
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem;
  --space-4: 1rem; --space-5: 1.5rem; --space-6: 2rem;
  --shadow-card: 0 4px 12px rgb(0 0 0 / 0.35);
  --shadow-surface: 0 12px 30px rgb(0 0 0 / 0.45);
  --shadow-lift: 0 16px 32px rgb(0 0 0 / 0.55);
  --focus: #e3a857;
}
```

**Verifica contrasto WCAG AA** (da segnalare):
- `--color-text` (#f6f2e9) su `--color-bg` (#191512) → **15.8:1** ✅
- `--color-text-muted` (#9c9188) su `--color-bg` → **4.2:1** ✅ (large text), **3.0:1** ⚠️ (normal text) — usare solo per testo secondario ≥18px o bold
- `--color-on-primary-action` (#191512) su `--color-primary-action` (#d98a63) → **6.1:1** ✅
- `--color-primary` (#c76b43) su `--color-bg` → **4.8:1** ✅
- `--color-accent` (#e3a857) su `--color-bg` → **7.2:1** ✅
- `--color-warning` (#ec8a3c) su `--color-bg` → **5.1:1** ✅
- `--color-danger` (#e0604f) su `--color-bg` → **4.5:1** ✅ (limite AA)

**Stati ingrediente:**
- ok = neutro (`--color-text`)
- in scadenza = `--color-warning` + icona + etichetta testuale
- scaduto = `--color-danger` + icona + etichetta testuale
- **Mai solo il colore**

**Bottoni:**
- Primario pieno: `--color-primary-action` bg, `--color-on-primary-action` text
- Secondario: bordo `--color-border`, sfondo trasparente

**Titoli pagina:** font serif (`--font-serif`)  
**Corpo:** font sans (`--font-sans`)

---

### PASSO 2 – Organizzazione e Navigazione

| File | Modifica | Motivo |
|------|----------|--------|
| **NEW** `src/features/pantry/`, `src/features/recipes/`, `src/features/shopping/`, `src/features/activity/`, `src/features/profile/` | Cartelle per feature con componenti locali | Organizzazione per feature |
| `src/components/shared/` | Sposta componenti riutilizzabili qui (`PageSection`, `EmptyState`, `ErrorBanner`, `RecipeCard`, `IngredientChip`, `UndoToast`, `Button`, `Card`, `Badge`, `Input`, `Select`, `Checkbox`, `Radio`) | Condivisione esplicita |
| `App.tsx` | Aggiorna rotte per nuova tab bar (5 tab: Dispensa, Ricette, Spesa, Attività, Profilo); mantieni deep link validi | Navigazione mobile-first |
| **NEW** `src/components/layout/TabBar.tsx` | Bottom nav fissa 5 item con icone Lucide + label | Sostituisce `BottomNav` SOUS-CHEF e `AppNavigation` legacy |
| `config/features.ts` | Rimuovi flag SOUS-CHEF legacy o allinea a nuova struttura | Semplificazione |

**Mapping tab bar proposto:**

| Tab | Rotta | Icona Lucide | Label |
|-----|-------|--------------|-------|
| 1 | `/pantry` | `Package` / `Kitchen` | Dispensa |
| 2 | `/recipes` | `BookOpen` / `UtensilsCrossed` | Ricette |
| 3 | `/shopping-list` | `ShoppingBasket` | Spesa |
| 4 | `/activity` | `Clock` / `History` | Attività |
| 5 | `/profile` | `UserRound` | Profilo |

*HomePage (`/`) → redirect a `/pantry` o `/recipes` in base a contesto; Chat/Discover/Saved → valutare se servono o vanno in Profilo/Attività.*

---

### PASSO 3 – Schermate (una per volta, nell'ordine)

| Schermata | File principali | Componenti condivisi da usare |
|-----------|----------------|------------------------------|
| **Dispensa** | `PantryPage.tsx`, `PantryLotsPanel.tsx`, `StaplesPanel.tsx`, `IngredientChip.tsx`, `IngredientInput.tsx`, `IngredientSuggestions.tsx`, `CandidatesInbox.tsx` | `PageSection`, `EmptyState`, `Button` (primary/secondary), `Card`, `Chip`, `Badge` (stato lotto: ok/warning/danger), `Input`, `Select` |
| **Ricette** | `RecipesPage.tsx`, `RecipeDetailPage.tsx`, `LocalRecipeCard.tsx`, `RecipeCard.tsx`, `RecipeImage.tsx` | `PageSection`, `EmptyState`, `ErrorBanner`, `RecipeCard` (unificata), `Card`, `Button`, `Badge` (disponibilità), `Input` (search) |
| **Spesa** | `ShoppingListPage.tsx`, `ShoppingListPanel.tsx`, `BringIntegration.tsx` | `PageSection`, `EmptyState`, `Button`, `Card`, `Input`, `Checkbox`, `Badge` |
| **Attività** | `ActivityPage.tsx`, `ActivityPanel.tsx`, `DinnerDiaryPage.tsx`, `DinnerRecipePanel.tsx`, `DiaryNavigation.tsx` | `PageSection`, `EmptyState`, `Card`, `Button`, `Badge` (favorite/rating), `Tabs` (DiaryNavigation → Tab component) |
| **Profilo** | `ProfilePage.tsx`, `AccountPanel.tsx`, `ThemePreferenceControl`, `MotionPreferenceControl`, `GoogleSignInButton.tsx` | `PageSection`, `EmptyState`, `ErrorBanner`, `Button`, `Card`, `Input`, `Select`, `Radio`, `Checkbox`, `Tabs` |

**Per ogni schermata:**
- Applica token CSS (`var(--color-*)`, `var(--font-*)`, `var(--radius-*)`, `var(--space-*)`)
- Stati: empty, loading, offline, error gestiti con componenti condivisi
- Touch target ≥44px (`min-h-11` → `min-h-[44px]`)
- Focus visible: `outline: 3px solid var(--focus); outline-offset: 2px`
- Label accessibili (`aria-label`, `aria-labelledby`, `sr-only`)

---

### PASSO 4 – PWA e Verifica

| Azione | Note |
|--------|------|
| Proporre allineamento `manifest.json` `theme_color`/`background_color` = `#191512` | Attendere OK prima di applicare |
| `meta name="theme-color"` = `#191512` | Già gestito da `colorTheme.ts` da aggiornare |
| Eseguire `npm run verify` (lint + test + build) | Gate completo |
| Controllo manuale offline/online su viewport mobile (375px, 390px, 412px) | PWA installabile, service worker attivo |
| Aggiornare README.md sezione "Avvio locale" e "Versione PWA" se cambia qualcosa | Documentazione |

---

## Effetti collaterali attesi / Rischi

| Rischio | Mitigazione |
|---------|-------------|
| **Token CSS non supportati in vecchi browser** | Target: browser moderni (PWA); fallback via `@supports` non necessario |
| **Rottura classi Tailwind esistenti** | Non rimuovere Tailwind; i token CSS convivono; migrazione progressiva componente per componente |
| **BottomNav SOUS-CHEF vs Legacy conflitto** | Unificare in `TabBar` unico; feature flag `VITE_SOUS_CHEF` → deprecato |
| **Contrasto `--color-text-muted` su `--color-bg` borderline** | Usare solo per testo ≥18px o `font-weight: 600`; altrimenti `--color-text` |
| **Font serif non disponibile su tutti i sistemi** | Stack: `Georgia, 'Noto Serif', serif` — Georgia su Win/macOS/iOS, Noto Serif su Android/Linux, fallback generico |
| **Test esistenti che asseriscono classi Tailwind hardcoded** | Aggiornare test insieme ai componenti (Given/When/Then) |
| **Deep link `/discover`, `/saved`, `/chat`** | Mantenere rotte valide; se non in tab bar, accessibili da Profilo o header |

---

## Prossimo passo

Con OK utente → **PASSO 1 – Design Token**:
1. Creo `src/theme/tokens.ts` con token TypeScript + generazione CSS custom properties
2. Aggiorno `index.css` per usare i nuovi token (rimuovo `--tk-*`, `--ik-*` legacy, `--ik-emerald-*` verde)
3. Aggiorno `domain/colorTheme.ts` per `theme-color` meta tag
4. Eseguo `npm --prefix frontend run lint && npm --prefix frontend run test && npm --prefix frontend run build`
5. Riporto risultati e tabella modifiche