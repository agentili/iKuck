# Prompt: riscrittura completa del frontend iKuck

Questo prompt è una specifica completa per rifare da zero il frontend di iKuck, un'app locale-first (PWA) che aiuta a decidere cosa cucinare con gli ingredienti già presenti in dispensa. Puoi usarlo così com'è con un LLM o uno sviluppatore per generare il nuovo codice frontend.

---

## 1. Contesto e obiettivo

**Prodotto:** iKuck — un sistema domestico locale-first per pianificare ricette a partire da ciò che si ha già in casa.  
**Obiettivo della riscrittura:** rendere il frontend più moderno, facile da usare e intuitivo, riducendo al contempo le feature superflue e introducendo paginazione, notifiche in-app e una schermata di apertura che propone subito una ricetta.

**Stato attuale:** il frontend esiste già (React 18 + Vite + Zustand + Tailwind + PWA). Deve essere riscritto completamente, riutilizzando il backend attuale e i contratti TypeScript condivisi in `shared/`.

**Lingua:** la copia visibile all'utente è in italiano. Codice, identificatori, commenti e nomi di file in inglese.

---

## 2. Tech stack attuale (da mantenere o sostituire con equivalenti moderni)

- **React 18** + **React Router v7** (routing lato client)
- **Zustand** (state management, persistenza IndexedDB)
- **Tailwind CSS** (styling, design system basato su CSS variabili)
- **Vite** (build tool, dev server, PWA plugin)
- **vite-plugin-pwa** (Service Worker, offline-first, `version.json`)
- **idb** / IndexedDB (persistenza locale)
- **lucide-react** (icone)
- **TypeScript** (strict)
- **Vitest** + **Testing Library** (unit test)
- **Playwright** (E2E e accessibilità)

**Backend da preservare:** Fastify su `http://127.0.0.1:3000`, esposto tramite Caddy solo sotto `/v1/*`. Il frontend chiama le API con path relativi (es. `/v1/shopping-list`), con cookie HttpOnly, CSRF header `x-csrf-token` e `credentials: 'include'`.

---

## 3. Architettura e flussi dati

### 3.1 Local-first
Tutti i dati principali vivono in IndexedDB sul dispositivo e funzionano offline. Il backend sincronizza solo per account verificati.

### 3.2 Scope di dati
Tre ambiti mutualmente esclusivi:
- `guest` — dati puramente locali, nessun account, nessuna sincronizzazione
- `account:<userId>` — account verificato, sincronizzazione personale
- `house:<houseId>` — casa condivisa, dati della famiglia/coinquilini

### 3.3 Contratti dati condivisi (`shared/src/contracts.ts`)
Entità di sincronizzazione (`SYNC_ENTITY_TYPES`):
`pantry_item`, `pantry_lot`, `staple_preference`, `shopping_list_item`, `cook_event`, `recipe_preference`, `diet_profile`, `ai_consent`, `generated_recipe`, `dinner_entry`, `saved_recipe`

Tipi chiave da conoscere:
- `DietType = 'omnivore' | 'vegetarian' | 'pescatarian' | 'vegan'`
- `EuAllergen` (14 allergeni UE)
- `DietProfilePayload { diet, excludedAllergens, nutrition }`
- `AiConsent { enabled, homeProvider?, dinnerProvider? }`
- `GeneratedRecipe { id, source: 'ai', title, description, ingredients, steps, diets, allergens, createdAt, updatedAt }`
- `PantryLot { id, ingredientId, label, known, quantity, unit, expiresAt, createdAt, updatedAt }`
- `ShoppingListItem { id, ingredientId, label, quantity, unit, note, purchased, sourceRecipeId, createdAt, updatedAt }`
- `CookEvent { id, recipeId, recipeTitle, servings, cookedAt, note, createdAt, updatedAt }`
- `RecipePreference { recipeId, favorite, rating, note, createdAt, updatedAt }`
- `PantryUnit = 'g' | 'kg' | 'ml' | 'l' | 'piece' | 'pack'`

### 3.4 Store attuali (da reimplementare o sostituire)
- `localPantryStore` — ingredienti, lotti, scadenze, ingredienti di base (staples)
- `shoppingListStore` — lista della spesa, acquisto, ricette da aggiungere
- `activityStore` — eventi di cottura, preferenze ricette (favorito, valutazione, nota)
- `dietProfileStore` — profilo alimentare e allergeni esclusi

### 3.5 Flusso principale (Home)
1. Utente apre l'app → si carica la dispensa da IndexedDB
2. Utente aggiunge ingredienti (o usa quelli di base predefiniti: acqua, sale, pepe, olio EVO)
3. Utente avvia la ricerca ricette → l'app filtra il catalogo locale in base agli ingredienti disponibili, al profilo dietetico e alle preferenze
4. Risultati divisi in "pronte da cucinare" (tutto disponibile) e "con un solo acquisto" (manca un ingrediente facile da trovare)
5. Utente apre una ricetta → vede ingredienti, procedimento, può segnalarla come cucinata

---

## 4. API backend disponibili (endpoint `/v1/*`)

Tutte le rotte richiedono sessione verificata tranne dove indicato. Stesso origine, CSRF richiesto per scritture.

| Metodo | Path | Scopo | Autenticazione |
|--------|------|-------|----------------|
| GET | `/v1/health` | Readiness | No |
| GET | `/v1/auth/session` | Sessione attiva | No |
| POST | `/v1/auth/login` | Login | No |
| POST | `/v1/auth/register` | Registrazione | No |
| POST | `/v1/auth/logout` | Logout | Sì (CSRF) |
| GET | `/v1/pantry-lots` | Lotti dispensa | Sì |
| POST | `/v1/pantry-lots` | Crea lotto | Sì (CSRF) |
| PATCH | `/v1/pantry-lots/:lotId` | Modifica lotto | Sì (CSRF) |
| DELETE | `/v1/pantry-lots/:lotId` | Elimina lotto | Sì (CSRF) |
| GET | `/v1/shopping-list` | Lista spesa | Sì |
| POST | `/v1/shopping-list` | Aggiungi item | Sì (CSRF) |
| PATCH | `/v1/shopping-list/:itemId` | Modifica item | Sì (CSRF) |
| DELETE | `/v1/shopping-list/:itemId` | Elimina item | Sì (CSRF) |
| GET | `/v1/activity` | Eventi cottura + preferenze | Sì |
| POST | `/v1/activity/cook-events` | Registra cottura | Sì (CSRF) |
| PUT | `/v1/recipes/preferences/:recipeId` | Preferenza ricetta | Sì (CSRF) |
| DELETE | `/v1/recipes/preferences/:recipeId` | Rimuovi preferenza | Sì (CSRF) |
| GET | `/v1/recipes/preferences` | Lista preferenze | Sì |
| GET | `/v1/diet-profile` | Profilo alimentare | Sì |
| PUT | `/v1/diet-profile` | Aggiorna profilo | Sì (CSRF) |
| GET | `/v1/house` | Dati casa condivisa | Sì |
| GET | `/v1/profile` | Profilo utente | Sì |
| GET | `/v1/ai-recipes` | Ricette AI salvate | Sì (account verificato) |
| GET | `/v1/sync/changes` | Cambiamenti sincronizzazione | Sì |
| POST | `/v1/sync/mutations` | Invia mutazioni | Sì (CSRF) |
| GET | `/v1/bring/status` | Stato connessione Bring | Sì |
| POST | `/v1/bring/import` | Importa lista Bring | Sì (CSRF) |
| GET | `/v1/recipe-nutrition` | Info nutrizionali | Sì |

---

## 5. Design system attuale (da evolvere, non buttare)

Fonte: `DESIGN.md` e `design-tokens.json`.

**Colori:**
- `primary` / ink: `#183028` (verde scuro, testo strutturale)
- `porcelain`: `#FAFBF7` (sfondo pagine, carta)
- `basil`: `#247A4A` (azione principale, progresso)
- `sage`: `#E1ECE4` (disponibilità, stato pronto)
- `mist`: `#F1F3ED` (separazione silenziosa)
- `tomato`: `#B9382A` (distruttivo/bloccante)
- `yolk`: `#F2BE3E` (attenzione senza allarme, focus ring)
- `inkMuted`: `#52665B` (testo secondario)
- Supporto tema scuro con valori dedicati (`darkPage`, `darkInk`, `darkSurface`, ecc.)

**Tipografia:** Bricolage Grotesque Variable (headline compatte, peso 800; body 450, interlinea 1.55).

**Dimensioni:**
- Radius: control 12px, panel 20px, feature 28px
- Spacing: xs 4px, sm 8px, md 16px, lg 24px, xl 32px
- Hit target minimo 44px mobile

**Regole di design (da rispettare o aggiornare con coerenza):**
- Azione prima dei controlli opzionali
- Nessun glassmorphism, gradienti decorativi, o ombre finte
- Una sola ombra controllata per superfici flottanti
- Border e cambio tonale per gerarchia, non carte dashboard
- Stati comunicati in italiano semplice: "Hai tutto", "Ti manca solo…"
- Focus ring visibile, reduced-motion rispettato, safe-area clearance

---

## 6. Pagine e flussi attuali (da mappare nel nuovo frontend)

- **Home** (`/`) — dispensa sintetica + ricerca ricette + pannello AI ricette (account verificati)
- **Recipes** (`/recipes`) — catalogo ricette, ricette salvate, ricette AI, ricerca per titolo/ingrediente
- **RecipeDetail** (`/recipes/:recipeId`) — dettaglio ricetta con ingredienti e procedimento
- **Pantry** (`/pantry`) — ingredienti per categoria, lotti, scadenze, staples, filtri dietetici, recupero conflitti dispensa
- **ShoppingList** (`/shopping-list`) — lista spesa con items, acquisto, rimozione
- **Activity** (`/activity`) — eventi di cottura, preferenze ricette, diario consumo
- **DinnerDiary** (`/dinner-diary`) — ricette cucinate nel tempo
- **Profile** (`/profile`) — account, email, verifica
- **House** (`/house`) — casa condivisa, membri, ruolo
- **Auth** — login, registrazione, recupero password, verifica email
- **NotFound** — pagina risorsa non trovata

Navigazione attuale: sidebar fissa mobile in alto + bottom navigation mobile con 5 tab (Cucina, Ricette, Dispensa, Spesa, Diario); desktop con sidebar a sinistra.

---

## 7. Requisiti di riscrittura (dall'utente)

Queste richieste vanno tutte inserite nel nuovo frontend:

1. **Nome più bello** — ripensare branding, titolo scheda browser, manifest PWA, intestazioni. "iKuck" può restare o cambiare; valutare un nome più caldo e memorabile in italiano o internazionale.
2. **Miglioramento UX generale** — meno clic, feedback immediato, stati di carica chiari, empty state significativi, errori comprensibili in italiano.
3. **Paginazione per ricette e dispensa** — niente scrolling infinito; pagine di dimensioni fisse (es. 20 elementi) con controlli prev/next o numerici. Si applica a: elenco ricette, elenco ingredienti dispensa, lotti, lista spesa, eventi attività.
4. **Home che propone subito una ricetta** — appena l'app si apre, se ci sono ingredienti sufficienti, mostrare in evidenza una ricetta "pronta da cucinare" invece di costringere l'utente a cercare. Se la dispensa è vuota, guidare all'aggiunta del primo ingrediente con una chiamata all'azione chiara.
5. **Preferenze delle ricette** — ogni ricetta può essere segnata come preferita, valutata (stelle o pollice) e annotata con una nota personale. Le preferenze influenzano l'ordine dei suggerimenti in Home.
6. **Riduzione delle feature** — individuare cosa togliere o nascondere per semplificare. Esempi candidati da valutare: import Bring, ricostruzione cena AI, debug avanzato, pannelli opzionali troppo numerosi. Mantenere solo: dispensa, lista spesa, ricette, preferenze, profilo dietetico, account/casa.
7. **Notifiche in-app** — toast o centro notifiche leggero per: sincronizzazione completata/fallita, ingrediente in scadenza, ricetta preferita, errore di rete, copia dispensa recuperata. Non sono push notification: sono avvisi visibili nell'app.

---

## 8. Vincoli e convenzioni (obbligatori)

- Codice, identificatori e commenti: **inglese**. Copy utente (etichette, messaggi, titoli): **italiano**.
- Non reintrodurre: Supabase, TanStack Query, API ricette pubblica, import automatico guest, struttura del vecchio `iRicetto_plan.md`.
- Session cookie HttpOnly; le richieste che modificano stato richiedono stessa origine e header CSRF `x-csrf-token`.
- Caddy serve il frontend e proxya solo `/v1/*` al backend.
- Path API relativi e same-origin (es. `fetch('/v1/shopping-list', { credentials: 'include' })`).
- PWA: Service Worker, `version.json` con `version` e `buildId`, offline-first, shortcuts PWA (Dispensa, Spesa, Attività).
- Tema chiaro/scuro rispettando `prefers-color-scheme` e preferenza salvata.
- Accessibilità: WCAG 2.1 AA, focus visible, hit target ≥44px, aria-label in italiano, skip-to-content, lang="it".
- Test: Vitest per unit test, Playwright per E2E e accessibilità. Il nuovo frontend deve superare lint (`eslint --max-warnings 0`) e build Vite senza errori.

---

## 9. Struttura suggerita per il nuovo frontend

```
frontend/
├── index.html
├── vite.config.ts
├── tailwind.config.ts (o .js)
├── src/
│   ├── main.tsx
│   ├── App.tsx                 # Router, scope, sessione, layout shell
│   ├── routes.tsx              # Definizione rotte (react-router)
│   ├── pages/
│   │   ├── Home.tsx            # Apertura: proposta ricetta + dispensa sintetica
│   │   ├── Recipes.tsx         # Elenco ricette paginato + ricerca
│   │   ├── RecipeDetail.tsx    # Dettaglio ricetta
│   │   ├── Pantry.tsx          # Dispensa paginata (ingredienti, lotti, staples)
│   │   ├── ShoppingList.tsx    # Lista spesa
│   │   ├── Activity.tsx        # Eventi cottura + preferenze
│   │   ├── DinnerDiary.tsx     # Storico cotture
│   │   ├── Profile.tsx         # Account
│   │   ├── House.tsx           # Casa condivisa
│   │   ├── Login.tsx           # Auth
│   │   └── NotFound.tsx
│   ├── components/
│   │   ├── layout/             # Header, sidebar, bottom nav, shell
│   │   ├── recipe/             # RecipeCard, RecipeList, Pagination
│   │   ├── pantry/             # IngredientChip, PantryLotRow, StaplesToggle
│   │   ├── shopping/           # ShoppingItemRow, PurchasedToggle
│   │   ├── activity/           # CookEventRow, RecipePreferenceToggle, Rating
│   │   ├── ui/                 # Button, Input, Card, EmptyState, ErrorBanner, Toast
│   │   └── notifications/      # In-app toast / notification center
│   ├── stores/                 # Zustand store (pantry, shoppingList, activity, dietProfile, notifications)
│   ├── api/                    # apiClient (fetch con CSRF, credenziali, tipi risposte)
│   ├── domain/                 # Logica pura: suggerimenti ricette, paginazione, filtri dietetici
│   ├── sync/                   # Scope, sync queue, gestione guest vs account vs house
│   ├── storage/                # Adattatori IndexedDB per ogni dominio
│   ├── types/                  # Tipi locali non condivisi con shared/
│   └── theme/                  # CSS variabili, colori, tipografia, radius
├── shared/                     # Contratti TypeScript già esistenti (non modificare)
└── tests/
    ├── unit/                   # Vitest
    └── e2e/                    # Playwright
```

---

## 10. Criteri di accettazione

Il nuovo frontend è considerato completo quando:

- [ ] Build Vite e lint superati senza errori (`npm run build`, `npm run lint`)
- [ ] Home apre e, se la dispensa ha ingredienti, mostra subito almeno una ricetta proponibile ("pronta da cucinare" o "con un solo acquisto")
- [ ] Se la dispensa è vuota, la Home guida all'aggiunta del primo ingrediente con un'unica azione visibile
- [ ] Elenco ricette e elenco ingredienti dispensa usano paginazione (non scroll infinito); dimensione pagina configurabile (default 20)
- [ ] Ogni ricetta ha toggle preferito, valutazione e nota; le preferenze influenzano l'ordinamento suggerimenti
- [ ] Notifiche in-app visibili per almeno: sync ok/ko, ingrediente in scadenza, errore rete, preferenza salvata
- [ ] Copy utente in italiano; codice in inglese
- [ ] Funziona offline (IndexedDB + Service Worker) per le operazioni di lettura e scrittura locale
- [ ] Tema chiaro/scuro rispettato
- [ ] Accessibilità: focus visibile, hit target ≥44px, skip-to-content, aria-label, test a11y Playwright passano
- [ ] API chiamate su path relativi `/v1/*` con `credentials: 'include'` e CSFR header su scritture
- [ ] Unit test Vitest per store e logica di dominio; E2E Playwright per flussi principali

---

## 11. Output atteso da chi esegue questo prompt

Chi riceve questo prompt deve produrre:

1. Il codice sorgente completo del nuovo frontend (sostituisce `frontend/src`)
2. Eventuali aggiornamenti a `frontend/package.json` se servono nuove dipendenze (documentare quali e perché)
3. Aggiornamento a `frontend/vite.config.ts` se necessario (PWA, proxy, version.json)
4. Una breve nota su quali feature dell'originale sono state rimosse o nascoste (motivazione per ciascuna)
5. Istruzioni per avviare in dev (`npm run dev --prefix frontend`) e per i test

---

File sorgente: questo prompt è salvato in `docs/frontend-rewrite-prompt.md` nel repository iKuck. Può essere espanso o affinato man mano che la riscrittura procede.
