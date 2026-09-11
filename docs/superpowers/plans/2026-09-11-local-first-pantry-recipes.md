# iRicetto Local-First Pantry Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare iRicetto in una PWA senza login che salva localmente la presenza degli ingredienti e propone, solo su richiesta, ricette complete o con un solo ingrediente facile da reperire.

**Architecture:** Conservare il frontend React/Vite e sostituire tutte le dipendenze server con un dominio TypeScript puro: catalogo ingredienti, 20 ricette statiche, matcher e store Zustand persistito in `localStorage`. La home orchestra inserimento, ingredienti di base e suggerimenti; il dettaglio ricetta legge direttamente il catalogo, quindi funziona anche dopo un refresh.

**Tech Stack:** React 18, TypeScript, Vite, React Router, Zustand persist, Tailwind CSS, Vitest, Testing Library, Playwright, vite-plugin-pwa.

**Spec:** `docs/superpowers/specs/2026-09-11-local-first-pantry-recipes-design.md`

## Global Constraints

- L'MVP non deve richiedere account, backend, database, Redis, servizi esterni o variabili segrete.
- La dispensa registra solo la presenza degli ingredienti; quantità, unità e scadenze non fanno parte del modello persistito.
- `acqua`, `sale`, `pepe` e `olio extravergine di oliva` sono ingredienti di base attivi alla prima apertura e modificabili.
- I suggerimenti vengono prodotti soltanto dopo un'azione esplicita dell'utente.
- La modalità standard ammette zero ingredienti obbligatori mancanti.
- La modalità estesa ammette al massimo un ingrediente mancante e soltanto se `easyToFind` è `true`.
- Il catalogo deve contenere esattamente 20 ricette: quattro per `meat`, `fish`, `eggs`, `legumes` e `vegetables`.
- Ogni richiesta mostra al massimo sei risultati; le corrispondenze complete precedono sempre quelle con un mancante.
- Tutto il codice, i nomi tecnici e i commenti nel codice devono essere in inglese; il testo dell'interfaccia resta in italiano.
- L'interfaccia deve funzionare da 320px in su, con focus visibile, target minimi di 44px e rispetto di `prefers-reduced-motion`.
- Il file utente non tracciato `E2E_VERIFICATION.md` e il file locale `.env` non devono essere modificati o rimossi.
- Ogni task termina con test e commit autonomi; non iniziare il task successivo se quello corrente non è verde.

---

## Mappa finale dei file

### File conservati e modificati

- `frontend/package.json`: script e dipendenze della sola PWA.
- `frontend/package-lock.json`: lockfile aggiornato da npm.
- `frontend/vite.config.ts`: PWA locale, manifest iRicetto e assenza del proxy API.
- `frontend/tsconfig.json`: configurazione TypeScript usata anche dai test.
- `frontend/src/main.tsx`: import valido di `App`.
- `frontend/src/App.tsx`: due route pubbliche, home e dettaglio ricetta.
- `frontend/src/index.css`: token visivi, tipografia, focus e movimento ridotto.
- `frontend/src/types/index.ts`: tipi del dominio locale.
- `frontend/src/store/pantryStore.ts`: stato persistente della dispensa.
- `frontend/src/pages/RecipeDetailPage.tsx`: dettaglio letto dal catalogo statico.
- `frontend/public/icons/*`: icone PWA esistenti, rigenerate solo se la verifica visiva ne mostra la necessità.
- `README.md`: setup, test, build e descrizione corretta dell'MVP.
- `.gitignore`: output Playwright e coverage.

### File creati

- `frontend/src/domain/ingredients.ts`: definizioni canoniche, alias e parser.
- `frontend/src/domain/recipes.ts`: catalogo delle 20 ricette.
- `frontend/src/domain/suggestions.ts`: matcher e selezione casuale.
- `frontend/src/domain/__tests__/ingredients.test.ts`: test parser e normalizzazione.
- `frontend/src/domain/__tests__/recipes.test.ts`: test integrità catalogo.
- `frontend/src/domain/__tests__/suggestions.test.ts`: test regole di matching.
- `frontend/src/store/__tests__/pantryStore.test.ts`: test persistenza e operazioni.
- `frontend/src/components/pantry/IngredientInput.tsx`: inserimento multiplo e suggerimenti.
- `frontend/src/components/pantry/IngredientChip.tsx`: ingrediente rimovibile e stato noto/sconosciuto.
- `frontend/src/components/pantry/StaplesPanel.tsx`: gestione ingredienti di base.
- `frontend/src/components/suggestions/SuggestionControls.tsx`: ricerca e modalità con un mancante.
- `frontend/src/components/suggestions/RecipeCard.tsx`: risultato e stato di disponibilità.
- `frontend/src/pages/HomePage.tsx`: esperienza principale in una schermata.
- `frontend/src/pages/NotFoundPage.tsx`: errore ricetta/route con recupero.
- `frontend/src/test/setup.ts`: matcher DOM e pulizia storage.
- `frontend/src/test/HomePage.test.tsx`: flusso utente a livello componente.
- `frontend/playwright.config.ts`: configurazione end-to-end.
- `frontend/e2e/core-flow.spec.ts`: percorso reale senza login.

### File rimossi dopo la migrazione

- `backend/` completo.
- `docker/` completo.
- `docker-compose.yml`, `scripts/deploy.sh`, `supabase_schema.sql`, `.env.example`.
- `frontend/Dockerfile`, `frontend/nginx.conf`, `frontend/public/manifest.json`, `frontend/src/sw.ts`, `frontend/src/db/database.ts`, `frontend/src/utils/apiClient.ts`.
- pagine, store e componenti di autenticazione, cronologia, vecchia dispensa e vecchi suggerimenti non più importati.

---

### Task 1: Ripristinare la baseline frontend e installare il test harness

**Files:**

- Modify: `frontend/src/main.tsx`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/tsconfig.json`
- Create: `frontend/src/test/setup.ts`
- Create: `frontend/src/App.test.tsx`

**Interfaces:**

- Consumes: configurazione Vite e applicazione React esistenti.
- Produces: comandi `npm test`, `npm run test:coverage`, `npm run test:e2e`; ambiente `jsdom` con matcher Testing Library.

- [ ] **Step 1: Registrare la baseline rossa già osservata**

Run: `cd frontend && npm run build`

Expected: FAIL con `TS5097` riferito all'import `./App.tsx`. Annotare l'esito nel messaggio del commit, senza creare un nuovo file di report.

- [ ] **Step 2: Correggere l'import che blocca TypeScript**

Sostituire l'import in `frontend/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Installare le dipendenze di test e Fontsource**

Run:

```bash
cd frontend
npm install @fontsource-variable/bricolage-grotesque
npm install --save-dev vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom @vitest/coverage-v8 @playwright/test
```

Aggiornare gli script in `package.json`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 4: Configurare Vitest dentro Vite**

Integrare questa sezione in `frontend/vite.config.ts`, lasciando temporaneamente invariata la configurazione PWA esistente:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({ registerType: 'autoUpdate' })],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
```

Nota: il manifest completo e il caching saranno ripristinati nel Task 8; in questo task la priorità è una baseline compilabile.

- [ ] **Step 5: Creare il setup dei test**

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
```

- [ ] **Step 6: Scrivere uno smoke test dell'app esistente**

```tsx
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders without crashing', () => {
    render(<App />);
    expect(document.body).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Verificare baseline verde**

Run:

```bash
cd frontend
npm test
npm run build
```

Expected: tutti i test PASS e build completata. Se lo smoke test viene rediretto al login, è accettabile in questo task; la rimozione del login avviene nel Task 6.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/tsconfig.json frontend/src/main.tsx frontend/src/test/setup.ts frontend/src/App.test.tsx
git commit -m "test: establish frontend verification baseline"
```

---

### Task 2: Definire ingredienti canonici e parser con TDD

**Files:**

- Replace: `frontend/src/types/index.ts`
- Create: `frontend/src/domain/ingredients.ts`
- Create: `frontend/src/domain/__tests__/ingredients.test.ts`

**Interfaces:**

- Consumes: stringa inserita dall'utente.
- Produces: `normalizeIngredientName(value: string): string`, `parseIngredientInput(value: string): ParsedIngredient[]`, `getIngredient(id: string): IngredientDefinition | undefined`, `DEFAULT_STAPLE_IDS`.

- [ ] **Step 1: Scrivere i test fallenti del parser**

```ts
import {
  DEFAULT_STAPLE_IDS,
  getIngredient,
  normalizeIngredientName,
  parseIngredientInput,
} from '../ingredients';

describe('ingredient domain', () => {
  it('normalizes case, accents and extra spaces', () => {
    expect(normalizeIngredientName('  Olio   d’Oliva  ')).toBe('olio d oliva');
  });

  it('maps aliases to canonical ingredient ids', () => {
    expect(parseIngredientInput('pomodori, uova; ceci\ntonno')).toEqual([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'eggs', label: 'Uova', known: true },
      { id: 'chickpeas', label: 'Ceci', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);
  });

  it('deduplicates known aliases and preserves unknown ingredients', () => {
    expect(parseIngredientInput('pomodoro, pomodori, tempeh')).toEqual([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'custom:tempeh', label: 'tempeh', known: false },
    ]);
  });

  it('defines the four default staples', () => {
    expect(DEFAULT_STAPLE_IDS).toEqual(['water', 'salt', 'black_pepper', 'olive_oil']);
    expect(DEFAULT_STAPLE_IDS.every((id) => getIngredient(id)?.staple)).toBe(true);
  });
});
```

- [ ] **Step 2: Eseguire i test e confermare il fallimento**

Run: `cd frontend && npm test -- ingredients.test.ts`

Expected: FAIL perché `ingredients.ts` non esiste.

- [ ] **Step 3: Sostituire i vecchi tipi remoti con il dominio locale**

```ts
export type RecipeCategory = 'meat' | 'fish' | 'eggs' | 'legumes' | 'vegetables';

export interface IngredientDefinition {
  id: string;
  label: string;
  aliases: string[];
  category: 'staple' | 'grain' | 'meat' | 'fish' | 'egg' | 'legume' | 'vegetable' | 'dairy';
  easyToFind: boolean;
  staple: boolean;
}

export interface ParsedIngredient {
  id: string;
  label: string;
  known: boolean;
}

export interface RecipeIngredient {
  ingredientId: string;
  amount: string;
  optional?: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  description: string;
  category: RecipeCategory;
  durationMinutes: number;
  difficulty: 'easy' | 'medium';
  servings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
}

export interface RecipeSuggestion {
  recipe: Recipe;
  missingIngredientIds: string[];
}
```

- [ ] **Step 4: Implementare il catalogo ingredienti**

In `ingredients.ts`, creare definizioni per tutti questi ID:

```ts
const ingredientSeed = [
  ['water', 'Acqua', ['acqua'], 'staple', true, true],
  ['salt', 'Sale', ['sale'], 'staple', true, true],
  ['black_pepper', 'Pepe', ['pepe', 'pepe nero'], 'staple', true, true],
  ['olive_oil', 'Olio extravergine di oliva', ['olio', 'olio d oliva', 'olio extravergine', 'olio evo'], 'staple', true, true],
  ['pasta', 'Pasta', ['pasta', 'spaghetti', 'penne'], 'grain', true, false],
  ['rice', 'Riso', ['riso'], 'grain', true, false],
  ['couscous', 'Cous cous', ['cous cous', 'couscous'], 'grain', true, false],
  ['breadcrumbs', 'Pangrattato', ['pangrattato', 'pane grattugiato'], 'grain', true, false],
  ['chicken_breast', 'Petto di pollo', ['pollo', 'petto di pollo'], 'meat', false, false],
  ['beef_strips', 'Straccetti di manzo', ['manzo', 'straccetti', 'straccetti di manzo'], 'meat', false, false],
  ['ground_beef', 'Carne macinata', ['macinato', 'carne macinata', 'macinato di manzo'], 'meat', false, false],
  ['turkey_breast', 'Petto di tacchino', ['tacchino', 'petto di tacchino'], 'meat', false, false],
  ['pancetta', 'Pancetta', ['pancetta', 'guanciale'], 'meat', true, false],
  ['tuna', 'Tonno', ['tonno', 'tonno in scatola'], 'fish', true, false],
  ['cod', 'Merluzzo', ['merluzzo'], 'fish', false, false],
  ['salmon', 'Salmone', ['salmone'], 'fish', false, false],
  ['eggs', 'Uova', ['uovo', 'uova'], 'egg', true, false],
  ['chickpeas', 'Ceci', ['cece', 'ceci'], 'legume', true, false],
  ['lentils', 'Lenticchie', ['lenticchia', 'lenticchie'], 'legume', true, false],
  ['cannellini_beans', 'Fagioli cannellini', ['fagioli', 'cannellini', 'fagioli cannellini'], 'legume', true, false],
  ['peas', 'Piselli', ['pisello', 'piselli'], 'legume', true, false],
  ['lemon', 'Limone', ['limone', 'limoni'], 'vegetable', true, false],
  ['arugula', 'Rucola', ['rucola'], 'vegetable', true, false],
  ['tomato', 'Pomodoro', ['pomodoro', 'pomodori'], 'vegetable', true, false],
  ['tomato_sauce', 'Passata di pomodoro', ['passata', 'sugo', 'passata di pomodoro'], 'vegetable', true, false],
  ['cherry_tomatoes', 'Pomodorini', ['pomodorino', 'pomodorini'], 'vegetable', true, false],
  ['olives', 'Olive', ['oliva', 'olive'], 'vegetable', true, false],
  ['zucchini', 'Zucchine', ['zucchina', 'zucchine'], 'vegetable', true, false],
  ['bell_peppers', 'Peperoni', ['peperone', 'peperoni'], 'vegetable', true, false],
  ['spinach', 'Spinaci', ['spinacio', 'spinaci'], 'vegetable', true, false],
  ['eggplant', 'Melanzane', ['melanzana', 'melanzane'], 'vegetable', true, false],
  ['carrots', 'Carote', ['carota', 'carote'], 'vegetable', true, false],
  ['celery', 'Sedano', ['sedano'], 'vegetable', true, false],
  ['onion', 'Cipolla', ['cipolla', 'cipolle'], 'vegetable', true, false],
  ['garlic', 'Aglio', ['aglio'], 'vegetable', true, false],
  ['parsley', 'Prezzemolo', ['prezzemolo'], 'vegetable', true, false],
  ['basil', 'Basilico', ['basilico'], 'vegetable', true, false],
  ['potatoes', 'Patate', ['patata', 'patate'], 'vegetable', true, false],
  ['parmesan', 'Parmigiano', ['parmigiano', 'grana'], 'dairy', true, false],
  ['milk', 'Latte', ['latte'], 'dairy', true, false],
] as const;
```

Convertire il seed in `IngredientDefinition[]`, costruire una `Map` di ID e alias e implementare il parser. Per normalizzare, usare Unicode NFD, rimozione dei diacritici, sostituzione degli apostrofi con spazi, collasso degli spazi e lowercase.

- [ ] **Step 5: Verificare parser e tipi**

Run:

```bash
cd frontend
npm test -- ingredients.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/domain/ingredients.ts frontend/src/domain/__tests__/ingredients.test.ts
git commit -m "feat: add canonical ingredient parser"
```

---

### Task 3: Creare il catalogo curato di 20 ricette

**Files:**

- Create: `frontend/src/domain/recipes.ts`
- Create: `frontend/src/domain/__tests__/recipes.test.ts`

**Interfaces:**

- Consumes: `Recipe` e catalogo ingredienti del Task 2.
- Produces: `RECIPES: readonly Recipe[]`, `getRecipeById(id: string): Recipe | undefined`.

- [ ] **Step 1: Scrivere i test di integrità fallenti**

```ts
import { INGREDIENTS } from '../ingredients';
import { RECIPES, getRecipeById } from '../recipes';

describe('recipe catalog', () => {
  it('contains exactly four recipes for each category', () => {
    expect(RECIPES).toHaveLength(20);
    for (const category of ['meat', 'fish', 'eggs', 'legumes', 'vegetables']) {
      expect(RECIPES.filter((recipe) => recipe.category === category)).toHaveLength(4);
    }
  });

  it('uses unique ids and only known ingredients', () => {
    expect(new Set(RECIPES.map((recipe) => recipe.id)).size).toBe(20);
    const ingredientIds = new Set(INGREDIENTS.map((ingredient) => ingredient.id));
    for (const recipe of RECIPES) {
      expect(recipe.ingredients.length).toBeGreaterThanOrEqual(3);
      expect(recipe.steps.length).toBeGreaterThanOrEqual(2);
      expect(recipe.ingredients.every((item) => ingredientIds.has(item.ingredientId))).toBe(true);
    }
  });

  it('retrieves a recipe by stable id', () => {
    expect(getRecipeById('pasta-tonno-pomodoro')?.title).toBe('Pasta tonno e pomodoro');
    expect(getRecipeById('missing')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Eseguire il test rosso**

Run: `cd frontend && npm test -- recipes.test.ts`

Expected: FAIL perché il catalogo non esiste.

- [ ] **Step 3: Implementare il catalogo con dati deterministici**

Creare ogni oggetto con `difficulty: 'easy'`, `servings: 2` e gli esatti dati della matrice seguente. Le dosi appartengono al dettaglio e non influenzano il matching.

| ID | Categoria | Min | Ingredienti obbligatori | Ingredienti opzionali | Passaggi |
|---|---:|---:|---|---|---|
| `pollo-al-limone` | meat | 25 | chicken_breast `300 g`; lemon `1`; garlic `1 spicchio`; olive_oil `2 cucchiai`; salt `q.b.`; black_pepper `q.b.` | — | Taglia il pollo a bocconcini; rosola aglio e pollo nell'olio; aggiungi succo di limone e cuoci 10 minuti; regola di sale e pepe. |
| `straccetti-manzo-rucola` | meat | 20 | beef_strips `300 g`; arugula `80 g`; lemon `1/2`; olive_oil `2 cucchiai`; salt `q.b.` | black_pepper `q.b.` | Rosola gli straccetti in padella calda; sala e aggiungi il limone; spegni e unisci la rucola; completa con olio e pepe. |
| `polpette-al-pomodoro` | meat | 40 | ground_beef `300 g`; eggs `1`; breadcrumbs `40 g`; parmesan `30 g`; tomato_sauce `350 ml`; olive_oil `1 cucchiaio`; salt `q.b.` | — | Impasta carne, uovo, pangrattato, parmigiano e sale; forma le polpette; rosolale nell'olio; aggiungi la passata e cuoci 25 minuti. |
| `tacchino-peperoni` | meat | 30 | turkey_breast `300 g`; bell_peppers `2`; onion `1/2`; olive_oil `2 cucchiai`; salt `q.b.` | black_pepper `q.b.` | Affetta tacchino, peperoni e cipolla; ammorbidisci cipolla e peperoni nell'olio; aggiungi il tacchino; cuoci 12 minuti e condisci. |
| `pasta-tonno-pomodoro` | fish | 20 | pasta `180 g`; tuna `120 g`; tomato_sauce `250 ml`; olive_oil `1 cucchiaio`; salt `q.b.` | garlic `1 spicchio` | Cuoci la pasta; scalda la passata nell'olio con l'eventuale aglio; unisci il tonno sgocciolato; scola e manteca la pasta nel sugo. |
| `merluzzo-olive-pomodorini` | fish | 30 | cod `300 g`; cherry_tomatoes `200 g`; olives `60 g`; garlic `1 spicchio`; olive_oil `2 cucchiai`; salt `q.b.` | parsley `1 ciuffo` | Rosola l'aglio nell'olio; aggiungi pomodorini e olive; adagia il merluzzo e copri; cuoci 15 minuti e completa con prezzemolo. |
| `salmone-al-limone` | fish | 20 | salmon `300 g`; lemon `1`; parsley `1 ciuffo`; olive_oil `1 cucchiaio`; salt `q.b.`; black_pepper `q.b.` | — | Scalda l'olio in padella; cuoci il salmone 4 minuti per lato; aggiungi succo di limone; condisci con sale, pepe e prezzemolo. |
| `insalata-ceci-tonno` | fish | 10 | chickpeas `240 g`; tuna `120 g`; tomato `2`; onion `1/4`; olive_oil `2 cucchiai`; lemon `1/2`; salt `q.b.` | parsley `1 ciuffo` | Scola ceci e tonno; taglia pomodoro e cipolla; riunisci tutto in una ciotola; condisci con olio, limone e sale. |
| `frittata-zucchine` | eggs | 25 | eggs `4`; zucchini `2`; parmesan `30 g`; olive_oil `1 cucchiaio`; salt `q.b.` | black_pepper `q.b.` | Affetta e rosola le zucchine; sbatti uova, parmigiano e sale; versa il composto sulle zucchine; cuoci coperto e gira la frittata. |
| `uova-al-pomodoro` | eggs | 20 | eggs `4`; tomato_sauce `300 ml`; garlic `1 spicchio`; olive_oil `1 cucchiaio`; salt `q.b.` | black_pepper `q.b.` | Scalda aglio e passata nell'olio; crea quattro incavi; rompi le uova negli incavi; copri e cuoci finché gli albumi sono sodi. |
| `omelette-spinaci` | eggs | 20 | eggs `4`; spinach `180 g`; milk `2 cucchiai`; parmesan `25 g`; olive_oil `1 cucchiaio`; salt `q.b.` | — | Salta gli spinaci; sbatti uova, latte, parmigiano e sale; versa in padella; ripiega l'omelette quando il centro è ancora morbido. |
| `carbonara-semplice` | eggs | 25 | pasta `180 g`; eggs `2`; pancetta `100 g`; parmesan `50 g`; black_pepper `q.b.`; salt `q.b.` | — | Cuoci la pasta; rosola la pancetta; mescola uova, parmigiano e pepe; manteca fuori dal fuoco con poca acqua di cottura. |
| `pasta-e-ceci` | legumes | 30 | pasta `160 g`; chickpeas `240 g`; tomato_sauce `150 ml`; garlic `1 spicchio`; olive_oil `1 cucchiaio`; water `400 ml`; salt `q.b.` | — | Rosola l'aglio nell'olio; unisci ceci, passata e acqua; porta a bollore e aggiungi la pasta; cuoci mescolando fino a consistenza cremosa. |
| `lenticchie-in-umido` | legumes | 40 | lentils `240 g`; tomato_sauce `200 ml`; carrots `1`; celery `1 costa`; onion `1/2`; olive_oil `2 cucchiai`; water `300 ml`; salt `q.b.` | — | Trita carota, sedano e cipolla; soffriggi nell'olio; unisci lenticchie, passata e acqua; cuoci 25 minuti e sala. |
| `insalata-fagioli-cipolla` | legumes | 10 | cannellini_beans `240 g`; onion `1/4`; tomato `2`; parsley `1 ciuffo`; olive_oil `2 cucchiai`; lemon `1/2`; salt `q.b.` | — | Scola i fagioli; affetta cipolla e pomodori; riunisci gli ingredienti; condisci con prezzemolo, olio, limone e sale. |
| `burger-di-ceci` | legumes | 30 | chickpeas `240 g`; breadcrumbs `50 g`; eggs `1`; onion `1/4`; parsley `1 ciuffo`; olive_oil `1 cucchiaio`; salt `q.b.` | black_pepper `q.b.` | Schiaccia i ceci; impasta con uovo, pangrattato, cipolla e prezzemolo; forma quattro burger; cuoci nell'olio 4 minuti per lato. |
| `pasta-alla-norma` | vegetables | 35 | pasta `180 g`; eggplant `1`; tomato_sauce `300 ml`; basil `6 foglie`; olive_oil `2 cucchiai`; salt `q.b.` | parmesan `30 g` | Taglia e rosola la melanzana; aggiungi la passata; cuoci la pasta; manteca nel sugo e completa con basilico. |
| `couscous-verdure` | vegetables | 25 | couscous `160 g`; zucchini `1`; bell_peppers `1`; peas `100 g`; water `180 ml`; olive_oil `2 cucchiai`; salt `q.b.` | — | Taglia e salta le verdure; versa acqua bollente salata sul cous cous; sgrana con l'olio; unisci verdure e piselli. |
| `zuppa-rustica-verdure` | vegetables | 45 | potatoes `2`; carrots `2`; celery `1 costa`; zucchini `1`; onion `1/2`; tomato `2`; water `800 ml`; olive_oil `1 cucchiaio`; salt `q.b.` | — | Taglia tutte le verdure; rosola la cipolla nell'olio; aggiungi verdure e acqua; cuoci 35 minuti e regola di sale. |
| `riso-zucchine-piselli` | vegetables | 30 | rice `160 g`; zucchini `2`; peas `120 g`; onion `1/2`; water `500 ml`; olive_oil `1 cucchiaio`; salt `q.b.` | parmesan `30 g` | Rosola la cipolla; aggiungi riso e zucchine; versa l'acqua poco per volta; unisci i piselli a metà cottura e completa a piacere con parmigiano. |

Usare queste descrizioni e questi tag, nello stesso ordine della matrice:

| ID | Descrizione | Tag |
|---|---|---|
| `pollo-al-limone` | Bocconcini teneri in una salsa fresca e veloce. | veloce, padella |
| `straccetti-manzo-rucola` | Manzo rosolato con rucola fresca e limone. | veloce, padella |
| `polpette-al-pomodoro` | Polpette morbide cotte lentamente nella passata. | tradizionale, sugo |
| `tacchino-peperoni` | Un secondo colorato preparato tutto in padella. | padella, verdure |
| `pasta-tonno-pomodoro` | Un primo rapido con ingredienti da dispensa. | veloce, pasta |
| `merluzzo-olive-pomodorini` | Filetti delicati con un condimento mediterraneo. | mediterranea, padella |
| `salmone-al-limone` | Salmone dorato con limone e prezzemolo. | veloce, padella |
| `insalata-ceci-tonno` | Un piatto unico fresco, saziante e senza cottura. | senza cottura, piatto unico |
| `frittata-zucchine` | Una frittata semplice, morbida e ricca di verdure. | padella, vegetariana |
| `uova-al-pomodoro` | Uova cotte direttamente in un sugo saporito. | padella, vegetariana |
| `omelette-spinaci` | Omelette cremosa con spinaci e parmigiano. | veloce, vegetariana |
| `carbonara-semplice` | Una versione casalinga e immediata della carbonara. | pasta, tradizionale |
| `pasta-e-ceci` | Pasta cremosa e confortante cotta in una sola pentola. | piatto unico, tradizionale |
| `lenticchie-in-umido` | Lenticchie morbide con un soffritto essenziale. | vegana, pentola |
| `insalata-fagioli-cipolla` | Fagioli freschi e saporiti con pomodoro e limone. | senza cottura, vegana |
| `burger-di-ceci` | Burger dorati fuori e morbidi dentro. | padella, vegetariana |
| `pasta-alla-norma` | Pasta al pomodoro con melanzane e basilico. | pasta, vegetariana |
| `couscous-verdure` | Cous cous leggero con ortaggi colorati. | veloce, vegana |
| `zuppa-rustica-verdure` | Una zuppa semplice per usare le verdure disponibili. | pentola, vegana |
| `riso-zucchine-piselli` | Riso morbido con zucchine e piselli. | pentola, vegetariana |

Usare questo schema per ogni elemento:

```ts
export const RECIPES: readonly Recipe[] = [
  {
    id: 'pollo-al-limone',
    title: 'Pollo al limone',
    description: 'Bocconcini teneri in una salsa fresca e veloce.',
    category: 'meat',
    durationMinutes: 25,
    difficulty: 'easy',
    servings: 2,
    ingredients: [
      { ingredientId: 'chicken_breast', amount: '300 g' },
      { ingredientId: 'lemon', amount: '1' },
      { ingredientId: 'garlic', amount: '1 spicchio' },
      { ingredientId: 'olive_oil', amount: '2 cucchiai' },
      { ingredientId: 'salt', amount: 'q.b.' },
      { ingredientId: 'black_pepper', amount: 'q.b.' },
    ],
    steps: [
      'Taglia il pollo a bocconcini.',
      'Rosola aglio e pollo nell’olio.',
      'Aggiungi il succo di limone e cuoci per 10 minuti.',
      'Regola di sale e pepe.',
    ],
    tags: ['veloce', 'padella'],
  },
];

export const getRecipeById = (id: string): Recipe | undefined =>
  RECIPES.find((recipe) => recipe.id === id);
```

La matrice sopra è la fonte completa per i restanti oggetti: ogni riga deve diventare un elemento dell'array con l'ID, la categoria, la durata, gli ingredienti, l'eventuale flag `optional` e tutti i passaggi indicati. I titoli sono quelli definiti nella specifica. Il test impedisce di omettere una riga, duplicare una categoria o introdurre ingredienti non definiti.

- [ ] **Step 4: Verificare catalogo e build**

Run:

```bash
cd frontend
npm test -- recipes.test.ts
npm run build
```

Expected: PASS; esattamente 20 ricette e nessun ID ingrediente sconosciuto.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/domain/recipes.ts frontend/src/domain/__tests__/recipes.test.ts
git commit -m "feat: add curated twenty-recipe catalog"
```

---

### Task 4: Implementare il motore di suggerimento puro

**Files:**

- Create: `frontend/src/domain/suggestions.ts`
- Create: `frontend/src/domain/__tests__/suggestions.test.ts`

**Interfaces:**

- Consumes: `Recipe[]`, ID disponibili, `allowOneMissing`, funzione casuale iniettabile.
- Produces: `findRecipeSuggestions(options: SuggestionOptions): RecipeSuggestion[]`, `findHelpfulIngredients(availableIds: string[], limit?: number): IngredientDefinition[]`.

- [ ] **Step 1: Scrivere i test fallenti delle regole**

```ts
import { findHelpfulIngredients, findRecipeSuggestions } from '../suggestions';
import type { Recipe } from '../../types';

const recipe = (id: string, ingredients: string[]): Recipe => ({
  id,
  title: id,
  description: id,
  category: 'vegetables',
  durationMinutes: 10,
  difficulty: 'easy',
  servings: 2,
  ingredients: ingredients.map((ingredientId) => ({ ingredientId, amount: '1' })),
  steps: ['Prepare.', 'Cook.'],
  tags: [],
});

describe('recipe suggestions', () => {
  const recipes = [
    recipe('exact', ['pasta', 'tomato', 'salt']),
    recipe('one-easy-missing', ['pasta', 'tomato', 'basil']),
    recipe('one-hard-missing', ['pasta', 'tomato', 'salmon']),
    recipe('two-missing', ['pasta', 'zucchini', 'peas']),
  ];

  it('returns only exact recipes in standard mode', () => {
    const result = findRecipeSuggestions({
      recipes,
      availableIds: ['pasta', 'tomato', 'salt'],
      allowOneMissing: false,
      random: () => 0.5,
    });
    expect(result.map((item) => item.recipe.id)).toEqual(['exact']);
  });

  it('adds only one easy-to-find missing ingredient in extended mode', () => {
    const result = findRecipeSuggestions({
      recipes,
      availableIds: ['pasta', 'tomato', 'salt'],
      allowOneMissing: true,
      random: () => 0.5,
    });
    expect(result.map((item) => item.recipe.id)).toEqual(['exact', 'one-easy-missing']);
    expect(result[1].missingIngredientIds).toEqual(['basil']);
  });

  it('keeps exact matches first and limits output to six', () => {
    const many = Array.from({ length: 10 }, (_, index) => recipe(`r-${index}`, ['salt']));
    const result = findRecipeSuggestions({
      recipes: many,
      availableIds: ['salt'],
      allowOneMissing: true,
      random: () => 0.25,
    });
    expect(result).toHaveLength(6);
    expect(result.every((item) => item.missingIngredientIds.length === 0)).toBe(true);
  });

  it('suggests the most useful missing ingredients for an empty result', () => {
    expect(findHelpfulIngredients(['salt', 'water'], 3)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Eseguire il test rosso**

Run: `cd frontend && npm test -- suggestions.test.ts`

Expected: FAIL perché il motore non esiste.

- [ ] **Step 3: Implementare matching e shuffle senza effetti collaterali**

```ts
import type { IngredientDefinition, Recipe, RecipeSuggestion } from '../types';
import { getIngredient, INGREDIENTS } from './ingredients';
import { RECIPES } from './recipes';

interface SuggestionOptions {
  recipes?: readonly Recipe[];
  availableIds: string[];
  allowOneMissing: boolean;
  limit?: number;
  random?: () => number;
}

const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
};

export const findRecipeSuggestions = ({
  recipes = RECIPES,
  availableIds,
  allowOneMissing,
  limit = 6,
  random = Math.random,
}: SuggestionOptions): RecipeSuggestion[] => {
  const available = new Set(availableIds);
  const eligible = recipes.flatMap((recipe) => {
    const missingIngredientIds = recipe.ingredients
      .filter((item) => !item.optional && !available.has(item.ingredientId))
      .map((item) => item.ingredientId);

    if (missingIngredientIds.length === 0) {
      return [{ recipe, missingIngredientIds }];
    }
    if (
      allowOneMissing &&
      missingIngredientIds.length === 1 &&
      getIngredient(missingIngredientIds[0])?.easyToFind === true
    ) {
      return [{ recipe, missingIngredientIds }];
    }
    return [];
  });

  const exact = shuffle(eligible.filter((item) => item.missingIngredientIds.length === 0), random);
  const extended = shuffle(eligible.filter((item) => item.missingIngredientIds.length === 1), random);
  return [...exact, ...extended].slice(0, limit);
};

export const findHelpfulIngredients = (
  availableIds: string[],
  limit = 3,
): IngredientDefinition[] => {
  const available = new Set(availableIds);
  const counts = new Map<string, number>();
  for (const recipe of RECIPES) {
    for (const item of recipe.ingredients) {
      if (!item.optional && !available.has(item.ingredientId)) {
        counts.set(item.ingredientId, (counts.get(item.ingredientId) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => INGREDIENTS.find((ingredient) => ingredient.id === id))
    .filter((ingredient): ingredient is IngredientDefinition => Boolean(ingredient))
    .slice(0, limit);
};
```

- [ ] **Step 4: Verificare il dominio completo**

Run: `cd frontend && npm test -- src/domain`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/domain/suggestions.ts frontend/src/domain/__tests__/suggestions.test.ts
git commit -m "feat: add transparent recipe matching"
```

---

### Task 5: Sostituire lo store remoto con persistenza locale

**Files:**

- Replace: `frontend/src/store/pantryStore.ts`
- Create: `frontend/src/store/__tests__/pantryStore.test.ts`

**Interfaces:**

- Consumes: `ParsedIngredient[]`, `DEFAULT_STAPLE_IDS`, `localStorage`.
- Produces: `usePantryStore` con `pantryItems`, `stapleIds`, `addIngredients`, `removeIngredient`, `toggleStaple`, `resetPantry`, `getAvailableIngredientIds`.

- [ ] **Step 1: Scrivere i test fallenti dello store**

```ts
import { usePantryStore } from '../pantryStore';

describe('pantry store', () => {
  beforeEach(() => {
    usePantryStore.getState().resetPantry();
  });

  it('starts with default staples and no pantry items', () => {
    const state = usePantryStore.getState();
    expect(state.pantryItems).toEqual([]);
    expect(state.stapleIds).toEqual(['water', 'salt', 'black_pepper', 'olive_oil']);
  });

  it('adds unique ingredients and removes one by id', () => {
    const store = usePantryStore.getState();
    store.addIngredients([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'tomato', label: 'Pomodoro', known: true },
    ]);
    expect(usePantryStore.getState().pantryItems).toHaveLength(1);
    usePantryStore.getState().removeIngredient('tomato');
    expect(usePantryStore.getState().pantryItems).toEqual([]);
  });

  it('combines pantry items with enabled staples', () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);
    usePantryStore.getState().toggleStaple('salt');
    expect(usePantryStore.getState().getAvailableIngredientIds()).toEqual(
      expect.arrayContaining(['pasta', 'water', 'black_pepper', 'olive_oil']),
    );
    expect(usePantryStore.getState().getAvailableIngredientIds()).not.toContain('salt');
  });

  it('recovers from unreadable persisted data', async () => {
    window.localStorage.setItem('iricetto-pantry-v1', '{not-json');
    await usePantryStore.persist.rehydrate();
    expect(usePantryStore.getState().pantryItems).toEqual([]);
    expect(window.localStorage.getItem('iricetto-pantry-v1')).toBeNull();
  });
});
```

- [ ] **Step 2: Eseguire il test rosso**

Run: `cd frontend && npm test -- pantryStore.test.ts`

Expected: FAIL perché il vecchio store richiede API e Dexie.

- [ ] **Step 3: Implementare lo store locale versionato**

```ts
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import type { ParsedIngredient } from '../types';

interface PantryState {
  pantryItems: ParsedIngredient[];
  stapleIds: string[];
  addIngredients: (items: ParsedIngredient[]) => void;
  removeIngredient: (id: string) => void;
  toggleStaple: (id: string) => void;
  resetPantry: () => void;
  getAvailableIngredientIds: () => string[];
}

const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    const raw = window.localStorage.getItem(name);
    if (raw === null) return null;
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      window.localStorage.removeItem(name);
      return null;
    }
  },
  setItem: (name, value) => window.localStorage.setItem(name, value),
  removeItem: (name) => window.localStorage.removeItem(name),
};

export const usePantryStore = create<PantryState>()(
  persist(
    (set, get) => ({
      pantryItems: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
      addIngredients: (items) =>
        set((state) => ({
          pantryItems: [...new Map([...state.pantryItems, ...items].map((item) => [item.id, item])).values()],
        })),
      removeIngredient: (id) =>
        set((state) => ({ pantryItems: state.pantryItems.filter((item) => item.id !== id) })),
      toggleStaple: (id) =>
        set((state) => ({
          stapleIds: state.stapleIds.includes(id)
            ? state.stapleIds.filter((item) => item !== id)
            : [...state.stapleIds, id],
        })),
      resetPantry: () => set({ pantryItems: [], stapleIds: [...DEFAULT_STAPLE_IDS] }),
      getAvailableIngredientIds: () => [
        ...get().pantryItems.filter((item) => item.known).map((item) => item.id),
        ...get().stapleIds,
      ],
    }),
    {
      name: 'iricetto-pantry-v1',
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: ({ pantryItems, stapleIds }) => ({ pantryItems, stapleIds }),
    },
  ),
);
```

- [ ] **Step 4: Verificare store e dominio**

Run: `cd frontend && npm test -- src/store src/domain`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/pantryStore.ts frontend/src/store/__tests__/pantryStore.test.ts
git commit -m "feat: persist pantry locally"
```

---

### Task 6: Costruire la home a singolo flusso con test componente

**Files:**

- Create: `frontend/src/components/pantry/IngredientInput.tsx`
- Create: `frontend/src/components/pantry/IngredientChip.tsx`
- Create: `frontend/src/components/pantry/StaplesPanel.tsx`
- Create: `frontend/src/components/suggestions/SuggestionControls.tsx`
- Replace: `frontend/src/components/suggestions/RecipeCard.tsx`
- Create: `frontend/src/pages/HomePage.tsx`
- Create: `frontend/src/test/HomePage.test.tsx`
- Replace: `frontend/src/App.tsx`
- Delete: `frontend/src/App.test.tsx`

**Interfaces:**

- Consumes: parser, store, matcher, catalogo e `RecipeSuggestion`.
- Produces: route pubblica `/`, interazione completa accessibile senza login, route `/recipes/:recipeId` già riservata al Task 7.

- [ ] **Step 1: Scrivere il test fallente del percorso principale**

```tsx
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HomePage from '../pages/HomePage';
import { usePantryStore } from '../store/pantryStore';

describe('HomePage', () => {
  beforeEach(() => usePantryStore.getState().resetPantry());

  it('adds comma-separated ingredients and searches only on request', async () => {
    const user = userEvent.setup();
    render(<HomePage />, { wrapper: MemoryRouter });

    expect(screen.queryByRole('heading', { name: 'Ricette per te' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Ingredienti presenti'), 'pasta, tonno, passata');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    expect(screen.getByText('Pasta')).toBeInTheDocument();
    expect(screen.getByText('Tonno')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(screen.getByRole('heading', { name: 'Ricette per te' })).toBeInTheDocument();
    expect(screen.getByText('Pasta tonno e pomodoro')).toBeInTheDocument();
    expect(screen.getByText('Hai tutto')).toBeInTheDocument();
  });

  it('reveals one explicit missing ingredient only when enabled', async () => {
    const user = userEvent.setup();
    render(<HomePage />, { wrapper: MemoryRouter });
    await user.type(screen.getByLabelText('Ingredienti presenti'), 'pasta, uova, pancetta');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
    await user.click(screen.getByLabelText('Anche con 1 ingrediente in più'));
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(screen.getByText(/Ti manca solo:/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Eseguire il test rosso**

Run: `cd frontend && npm test -- HomePage.test.tsx`

Expected: FAIL perché `HomePage` e i nuovi componenti non esistono.

- [ ] **Step 3: Implementare `IngredientInput`**

Il componente mantiene soltanto il testo locale, usa `parseIngredientInput` al submit, chiama `onAdd` e svuota il campo. Sotto il campo mostra fino a cinque ingredienti noti che corrispondono all'ultimo termine digitato. Il placeholder deve essere `es. pasta, pomodori, tonno`.

```tsx
import { FormEvent, useState } from 'react';
import {
  INGREDIENTS,
  normalizeIngredientName,
  parseIngredientInput,
} from '../../domain/ingredients';
import type { ParsedIngredient } from '../../types';

interface IngredientInputProps {
  onAdd: (items: ParsedIngredient[]) => void;
}

export function IngredientInput({ onAdd }: IngredientInputProps) {
  const [value, setValue] = useState('');
  const currentToken = value.split(/[,;\n]/).at(-1)?.trim() ?? '';
  const normalizedToken = normalizeIngredientName(currentToken);
  const suggestions = normalizedToken.length < 2
    ? []
    : INGREDIENTS.filter((ingredient) =>
        !ingredient.staple &&
        [ingredient.label, ...ingredient.aliases].some((candidate) =>
          normalizeIngredientName(candidate).startsWith(normalizedToken),
        ),
      ).slice(0, 5);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const items = parseIngredientInput(value);
    if (items.length === 0) return;
    onAdd(items);
    setValue('');
  };

  const handleSuggestion = (label: string) => {
    const parts = value.split(/[,;\n]/);
    parts[parts.length - 1] = label;
    onAdd(parseIngredientInput(parts.join(',')));
    setValue('');
  };

  return (
    <form onSubmit={handleSubmit} className="ingredient-entry">
      <label htmlFor="pantry-input">Ingredienti presenti</label>
      <div className="ingredient-entry__controls">
        <input
          id="pantry-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="es. pasta, pomodori, tonno"
          autoComplete="off"
        />
        <button type="submit">Aggiungi ingredienti</button>
      </div>
      {suggestions.length > 0 && (
        <ul aria-label="Ingredienti suggeriti">
          {suggestions.map((ingredient) => (
            <li key={ingredient.id}>
              <button type="button" onClick={() => handleSuggestion(ingredient.label)}>
                {ingredient.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
```

- [ ] **Step 4: Implementare chip e ingredienti di base**

`IngredientChip` deve mostrare label, pulsante accessibile `Rimuovi <label>` e badge `Non ancora usato nelle ricette` quando `known` è falso. `StaplesPanel` usa `<details>` con summary `Ingredienti di base` e quattro checkbox collegate a `toggleStaple`.

```tsx
export function IngredientChip({ item, onRemove }: {
  item: ParsedIngredient;
  onRemove: (id: string) => void;
}) {
  return (
    <li className="ingredient-chip">
      <span>{item.label}</span>
      {!item.known && <small>Non ancora usato nelle ricette</small>}
      <button type="button" aria-label={`Rimuovi ${item.label}`} onClick={() => onRemove(item.id)}>
        ×
      </button>
    </li>
  );
}

export function StaplesPanel({ stapleIds, onToggle }: {
  stapleIds: string[];
  onToggle: (id: string) => void;
}) {
  const staples = INGREDIENTS.filter((ingredient) => ingredient.staple);
  return (
    <details>
      <summary>Ingredienti di base</summary>
      <fieldset>
        <legend className="sr-only">Ingredienti di base disponibili</legend>
        {staples.map((ingredient) => (
          <label key={ingredient.id}>
            <input
              type="checkbox"
              checked={stapleIds.includes(ingredient.id)}
              onChange={() => onToggle(ingredient.id)}
            />
            {ingredient.label}
          </label>
        ))}
      </fieldset>
    </details>
  );
}
```

- [ ] **Step 5: Implementare i controlli di ricerca**

```tsx
interface SuggestionControlsProps {
  allowOneMissing: boolean;
  disabled: boolean;
  onAllowOneMissingChange: (value: boolean) => void;
  onSearch: () => void;
}

export function SuggestionControls(props: SuggestionControlsProps) {
  return (
    <section aria-label="Opzioni ricette">
      <label>
        <input
          type="checkbox"
          checked={props.allowOneMissing}
          onChange={(event) => props.onAllowOneMissingChange(event.target.checked)}
        />
        Anche con 1 ingrediente in più
      </label>
      <button type="button" disabled={props.disabled} onClick={props.onSearch}>
        Trova ricette
      </button>
    </section>
  );
}
```

Il pulsante `Trova ricette` chiama solo `onSearch`; il checkbox non deve avviare automaticamente la ricerca. Il pulsante è disabilitato se non esistono ingredienti della dispensa oltre agli ingredienti di base.

- [ ] **Step 6: Implementare `RecipeCard`**

```tsx
const missing = suggestion.missingIngredientIds[0];
const status = missing
  ? `Ti manca solo: ${getIngredient(missing)?.label ?? missing}`
  : 'Hai tutto';

return (
  <article className="recipe-card">
    <p className={missing ? 'recipe-card__status--missing' : 'recipe-card__status--complete'}>
      {status}
    </p>
    <h3>{suggestion.recipe.title}</h3>
    <p>{suggestion.recipe.description}</p>
    <dl>
      <div><dt>Tempo</dt><dd>{suggestion.recipe.durationMinutes} min</dd></div>
      <div><dt>Categoria</dt><dd>{CATEGORY_LABELS[suggestion.recipe.category]}</dd></div>
    </dl>
    <Link to={`/recipes/${suggestion.recipe.id}`}>Apri ricetta</Link>
  </article>
);
```

La card deve contenere titolo, descrizione, durata, categoria in italiano, stato completo, link `Apri ricetta` e nessuna percentuale.

- [ ] **Step 7: Implementare `HomePage`**

Mantenere `hasSearched`, `allowOneMissing` e `suggestions` come stato locale. Al click, leggere `getAvailableIngredientIds()`, chiamare `findRecipeSuggestions` e salvare il risultato. `Altre idee` richiama la stessa funzione. Se il risultato è vuoto, mostrare `findHelpfulIngredients` e, quando la modalità estesa è spenta, il pulsante `Prova con 1 ingrediente in più` che abilita la modalità e rilancia la ricerca.

```tsx
const [hasSearched, setHasSearched] = useState(false);
const [allowOneMissing, setAllowOneMissing] = useState(false);
const [suggestions, setSuggestions] = useState<RecipeSuggestion[]>([]);
const pantry = usePantryStore();

const search = (extended = allowOneMissing) => {
  setSuggestions(findRecipeSuggestions({
    availableIds: pantry.getAvailableIngredientIds(),
    allowOneMissing: extended,
  }));
  setHasSearched(true);
};

const tryExtended = () => {
  setAllowOneMissing(true);
  search(true);
};

return (
  <main>
    <header>
      <p>La tua cucina, senza sprechi</p>
      <h1>Cosa c’è in dispensa?</h1>
      <p>Scrivi gli ingredienti che hai. Alle ricette pensiamo noi.</p>
    </header>
    <IngredientInput onAdd={pantry.addIngredients} />
    <ul aria-label="La tua dispensa">
      {pantry.pantryItems.map((item) => (
        <IngredientChip key={item.id} item={item} onRemove={pantry.removeIngredient} />
      ))}
    </ul>
    <StaplesPanel stapleIds={pantry.stapleIds} onToggle={pantry.toggleStaple} />
    <SuggestionControls
      allowOneMissing={allowOneMissing}
      disabled={pantry.pantryItems.length === 0}
      onAllowOneMissingChange={setAllowOneMissing}
      onSearch={() => search()}
    />
    <section aria-live="polite">
      {hasSearched && <h2>Ricette per te</h2>}
      {suggestions.map((suggestion) => (
        <RecipeCard key={suggestion.recipe.id} suggestion={suggestion} />
      ))}
      {hasSearched && suggestions.length === 0 && !allowOneMissing && (
        <button type="button" onClick={tryExtended}>Prova con 1 ingrediente in più</button>
      )}
    </section>
  </main>
);
```

Quando `hasSearched` è vero e non ci sono risultati anche in modalità estesa, renderizzare le tre label restituite da `findHelpfulIngredients` sotto il testo `Prova ad aggiungere uno di questi ingredienti comuni`.

- [ ] **Step 8: Semplificare il router pubblico**

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import RecipeDetailPage from './pages/RecipeDetailPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 9: Verificare comportamento e build**

Run:

```bash
cd frontend
npm test -- HomePage.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/HomePage.tsx frontend/src/components/pantry frontend/src/components/suggestions frontend/src/test/HomePage.test.tsx
git rm frontend/src/App.test.tsx
git commit -m "feat: build pantry-to-recipe home flow"
```

---

### Task 7: Ricostruire il dettaglio ricetta e applicare la direzione visiva

**Files:**

- Replace: `frontend/src/pages/RecipeDetailPage.tsx`
- Create: `frontend/src/pages/NotFoundPage.tsx`
- Modify: `frontend/src/App.tsx`
- Replace: `frontend/src/index.css`
- Modify: `frontend/tailwind.config.js`
- Modify: `frontend/src/test/HomePage.test.tsx`
- Create: `frontend/src/pages/RecipeDetailPage.test.tsx`

**Interfaces:**

- Consumes: parametro route `recipeId`, `getRecipeById`, `getIngredient`.
- Produces: dettaglio ricaricabile, stato not-found, design responsive e accessibile.

- [ ] **Step 1: Scrivere i test fallenti del dettaglio**

```tsx
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import RecipeDetailPage from './RecipeDetailPage';

const renderRoute = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
    </Routes>
  </MemoryRouter>,
);

describe('RecipeDetailPage', () => {
  it('loads a recipe directly from its url', () => {
    renderRoute('/recipes/pollo-al-limone');
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ingredienti' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preparazione' })).toBeInTheDocument();
  });

  it('shows a recoverable not-found state', () => {
    renderRoute('/recipes/not-real');
    expect(screen.getByText('Ricetta non trovata')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Torna alla dispensa' })).toHaveAttribute('href', '/');
  });
});
```

- [ ] **Step 2: Eseguire i test e confermare il fallimento**

Run: `cd frontend && npm test -- RecipeDetailPage.test.tsx`

Expected: FAIL perché la pagina usa ancora lo store remoto dei suggerimenti.

- [ ] **Step 3: Implementare il dettaglio locale**

Leggere `recipeId` con `useParams`, risolvere il dato tramite `getRecipeById` e mostrare `NotFoundPage` se assente. Renderizzare ingredienti con label canonica e dose; numerare i passaggi con `<ol>`. Il link indietro è sempre `Torna alla dispensa`, non `navigate(-1)`, così funziona dopo refresh.

```tsx
export default function RecipeDetailPage() {
  const { recipeId = '' } = useParams();
  const recipe = getRecipeById(recipeId);

  if (!recipe) return <NotFoundPage />;

  return (
    <main className="recipe-detail">
      <Link to="/">Torna alla dispensa</Link>
      <header>
        <p>{CATEGORY_LABELS[recipe.category]} · {recipe.durationMinutes} min</p>
        <h1>{recipe.title}</h1>
        <p>{recipe.description}</p>
      </header>
      <section>
        <h2>Ingredienti</h2>
        <ul>
          {recipe.ingredients.map((item) => (
            <li key={item.ingredientId}>
              <span>{getIngredient(item.ingredientId)?.label}</span>
              <span>{item.amount}{item.optional ? ' · facoltativo' : ''}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Preparazione</h2>
        <ol>
          {recipe.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </section>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main>
      <h1>Ricetta non trovata</h1>
      <p>Questa ricetta non è presente nel catalogo.</p>
      <Link to="/">Torna alla dispensa</Link>
    </main>
  );
}
```

- [ ] **Step 4: Applicare token e font**

Importare il font in cima a `index.css`:

```css
@import '@fontsource-variable/bricolage-grotesque';
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  font-family: 'Bricolage Grotesque Variable', system-ui, sans-serif;
  color: #183028;
  background: #fafbf7;
  font-synthesis: none;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background-color: #fafbf7;
  background-image: linear-gradient(rgba(36, 122, 74, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(36, 122, 74, 0.055) 1px, transparent 1px);
  background-size: 28px 28px;
}

:focus-visible {
  outline: 3px solid #f2be3e;
  outline-offset: 3px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Estendere Tailwind:

```js
colors: {
  porcelain: '#FAFBF7',
  ink: '#183028',
  basil: '#247A4A',
  tomato: '#D94C35',
  yolk: '#F2BE3E',
  sage: '#E1ECE4',
}
```

Usare bordi `ink`, superfici `porcelain`/`sage`, azione primaria `basil` e `tomato` solo per il mancante. Evitare shadow uniformi su ogni elemento, label tutte maiuscole e percentuali decorative.

- [ ] **Step 5: Verificare accessibilità di base nei test**

Estendere `HomePage.test.tsx` per verificare label dell'input, nomi accessibili dei pulsanti di rimozione, checkbox degli ingredienti di base e regione `aria-live` dei risultati.

- [ ] **Step 6: Verifica automatica**

Run:

```bash
cd frontend
npm test
npm run build
npm run lint
```

Expected: PASS senza warning ESLint.

- [ ] **Step 7: Verifica visiva manuale**

Run: `cd frontend && npm run dev -- --host 127.0.0.1`

Controllare a 320x568, 768x1024 e 1440x900:

- nessun overflow orizzontale;
- input e CTA visibili nella prima schermata mobile;
- una colonna mobile, due colonne da 768px, tre da 1100px;
- testo leggibile e righe sotto 80 caratteri nel dettaglio;
- focus tastiera sempre visibile;
- con movimento ridotto non avvengono transizioni percepibili.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/RecipeDetailPage.tsx frontend/src/pages/NotFoundPage.tsx frontend/src/pages/RecipeDetailPage.test.tsx frontend/src/App.tsx frontend/src/index.css frontend/tailwind.config.js frontend/src/test/HomePage.test.tsx
git commit -m "feat: add accessible recipe experience"
```

---

### Task 8: Rendere la PWA offline e verificare il flusso end-to-end

**Files:**

- Replace: `frontend/vite.config.ts`
- Create: `frontend/playwright.config.ts`
- Create: `frontend/e2e/core-flow.spec.ts`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: build statica Vite e flusso home/dettaglio.
- Produces: manifest iRicetto, service worker `generateSW`, test Playwright contro `vite preview`.

- [ ] **Step 1: Configurare manifest e precache senza API**

Usare questa configurazione PWA:

```ts
VitePWA({
  registerType: 'autoUpdate',
  strategies: 'generateSW',
  includeAssets: ['icons/icon-192x192.png', 'icons/icon-512x512.png'],
  manifest: {
    name: 'iRicetto',
    short_name: 'iRicetto',
    description: 'Ricette semplici con quello che hai in dispensa',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    theme_color: '#247A4A',
    background_color: '#FAFBF7',
    lang: 'it',
    icons: [
      { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
    navigateFallback: '/index.html',
  },
})
```

Non aggiungere cache runtime di API o Supabase.

- [ ] **Step 2: Configurare Playwright**

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
```

- [ ] **Step 3: Scrivere il test end-to-end**

```ts
import { expect, test } from '@playwright/test';

test('user adds pantry items, requests recipes and opens one', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Cosa c'è in dispensa/i })).toBeVisible();
  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  await expect(page.getByText('Hai tutto').first()).toBeVisible();
  await page.getByRole('link', { name: 'Apri ricetta' }).first().click();
  await expect(page.getByRole('heading', { name: 'Ingredienti' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
});

test('pantry survives reload and one-missing mode names the ingredient', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ingredienti presenti').fill('pasta, uova, pancetta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.reload();
  await expect(page.getByText('Pancetta', { exact: true })).toBeVisible();
  await page.getByLabel('Anche con 1 ingrediente in più').check();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText(/Ti manca solo: Parmigiano/)).toBeVisible();
});
```

- [ ] **Step 4: Ignorare solo gli artefatti di test**

Aggiungere a `.gitignore`:

```gitignore
frontend/coverage/
frontend/playwright-report/
frontend/test-results/
```

- [ ] **Step 5: Installare Chromium Playwright e verificare**

Run:

```bash
cd frontend
npx playwright install chromium
npm test
npm run test:e2e
npm run build
```

Expected: test unitari/componenti PASS, quattro esecuzioni E2E PASS (due casi per due viewport), build PASS. Dal pannello Application del browser verificare manifest senza errori e service worker attivo.

- [ ] **Step 6: Verificare offline**

Con la preview aperta, visitare l'app una volta, impostare il browser offline e ricaricare `/` e una route `/recipes/<id>`. Entrambe devono renderizzare senza richieste di rete fallite necessarie al contenuto.

- [ ] **Step 7: Commit**

```bash
git add frontend/vite.config.ts frontend/playwright.config.ts frontend/e2e/core-flow.spec.ts .gitignore
git commit -m "test: verify installable offline pantry flow"
```

---

### Task 9: Rimuovere il vecchio stack e ridurre le dipendenze

**Files:**

- Delete: `backend/`
- Delete: `docker/`
- Delete: `docker-compose.yml`
- Delete: `scripts/deploy.sh`
- Delete: `supabase_schema.sql`
- Delete: `.env.example`
- Delete: `frontend/Dockerfile`
- Delete: `frontend/nginx.conf`
- Delete: `frontend/public/manifest.json`
- Delete: `frontend/src/sw.ts`
- Delete: `frontend/src/db/database.ts`
- Delete: `frontend/src/utils/apiClient.ts`
- Delete: `frontend/src/store/authStore.ts`
- Delete: `frontend/src/store/suggestionStore.ts`
- Delete: old unused pages and components identified by `rg`.
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

**Interfaces:**

- Consumes: nuova applicazione locale già verde.
- Produces: repository con un solo runtime frontend e nessun import verso API, auth, history o Dexie.

- [ ] **Step 1: Dimostrare che i file legacy non sono importati**

Run:

```bash
rg -n "apiClient|authStore|suggestionStore|db/database|ProtectedRoute|LoginPage|RegisterPage|HistoryPage|SuggestionPage|PantryPage|BottomNavigation|Header|RatingModal|TimerComponent|InstructionsSection|MealTypeSelector" frontend/src
```

Expected: nessun match nei file raggiungibili da `main.tsx`. Se compare un match nella nuova app, rimuovere quell'accoppiamento prima di proseguire.

- [ ] **Step 2: Rimuovere pagine e componenti legacy esatti**

```bash
git rm frontend/src/pages/LoginPage.tsx frontend/src/pages/RegisterPage.tsx frontend/src/pages/HistoryPage.tsx frontend/src/pages/SuggestionPage.tsx frontend/src/pages/PantryPage.tsx
git rm frontend/src/components/shared/ProtectedRoute.tsx frontend/src/components/shared/Header.tsx frontend/src/components/shared/BottomNavigation.tsx
git rm frontend/src/components/pantry/AddIngredientModal.tsx frontend/src/components/pantry/IngredientCard.tsx
git rm frontend/src/components/suggestions/MealTypeSelector.tsx
git rm frontend/src/components/recipe/InstructionsSection.tsx frontend/src/components/recipe/RatingModal.tsx frontend/src/components/recipe/TimerComponent.tsx
git rm frontend/src/store/authStore.ts frontend/src/store/suggestionStore.ts frontend/src/db/database.ts frontend/src/utils/apiClient.ts frontend/src/sw.ts
```

- [ ] **Step 3: Rimuovere infrastruttura e backend tracciati**

Prima eseguire `git status --short` e verificare che `E2E_VERIFICATION.md` resti non tracciato. Poi:

```bash
git rm -r backend docker
git rm docker-compose.yml scripts/deploy.sh supabase_schema.sql .env.example
git rm frontend/Dockerfile frontend/nginx.conf frontend/public/manifest.json
```

Non eseguire comandi sul file `.env` e non aggiungere `E2E_VERIFICATION.md` allo staging.

- [ ] **Step 4: Disinstallare dipendenze non più usate**

Run:

```bash
cd frontend
npm uninstall @hookform/resolvers @supabase/supabase-js @tanstack/react-query axios dexie react-hook-form zod workbox-precaching workbox-routing workbox-strategies
```

Conservare `lucide-react`, `react`, `react-dom`, `react-router-dom`, `zustand`, Tailwind, Vite, vite-plugin-pwa, Fontsource e le dipendenze di test.

- [ ] **Step 5: Cercare riferimenti residui**

Run:

```bash
rg -n -i "login|register|authorization|bearer|axios|dexie|supabase|postgres|redis|/api|meal_planner" frontend README.md
```

Expected: nessun riferimento runtime o UI. Sono accettabili solo note storiche nei documenti sotto `docs/superpowers/`.

- [ ] **Step 6: Verificare dopo la rimozione**

Run:

```bash
cd frontend
npm test
npm run lint
npm run build
npm run test:e2e
```

Expected: PASS.

- [ ] **Step 7: Ispezionare lo staging**

Run:

```bash
git status --short
git diff --cached --stat
git diff --cached --name-status
```

Expected: soltanto file legacy rimossi e aggiornamenti `package.json`/lockfile. `E2E_VERIFICATION.md` deve restare `??` e non comparire nel diff staged.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "refactor: remove obsolete server architecture"
```

---

### Task 10: Aggiornare documentazione ed eseguire la verifica finale

**Files:**

- Replace: `README.md`
- Preserve: `iRicetto_plan.md`
- Preserve: `E2E_VERIFICATION.md`

**Interfaces:**

- Consumes: repository locale finale.
- Produces: istruzioni riproducibili e prove correnti di qualità.

- [ ] **Step 1: Riscrivere README con lo stato reale**

Il README deve contenere:

````markdown
# iRicetto

iRicetto suggerisce ricette semplici usando gli ingredienti presenti in dispensa. Funziona senza account e conserva i dati soltanto nel browser.

## Avvio locale

```bash
cd frontend
npm install
npm run dev
```

## Verifica

```bash
cd frontend
npm test
npm run lint
npm run build
npm run test:e2e
```

## Dati

La dispensa è salvata in `localStorage` con la chiave `iricetto-pantry-v1`. Disinstallare l'app o cancellare i dati del sito elimina la dispensa. Nessun dato viene inviato a un server.
````

- [ ] **Step 2: Verificare criteri quantitativi del catalogo**

Run: `cd frontend && npm test -- recipes.test.ts`

Expected: 20 ricette, quattro per categoria, ingredienti validi e ID univoci.

- [ ] **Step 3: Eseguire la suite completa da ambiente pulito**

Run:

```bash
cd frontend
npm ci
npm test
npm run test:coverage
npm run lint
npm run build
npm run test:e2e
```

Expected: tutti i comandi terminano con exit code 0. Il coverage deve essere almeno 90% per `src/domain/**` e `src/store/**`; se è inferiore, aggiungere casi mirati prima di procedere.

- [ ] **Step 4: Verifica manuale dei criteri utente**

Con una nuova sessione browser:

1. aprire `/` e confermare che non esista login;
2. inserire `pasta, pomodori, tonno` e verificare tre chip senza quantità;
3. ricaricare e confermare persistenza;
4. cercare ricette in modalità standard e verificare zero mancanti;
5. attivare la modalità estesa e verificare al massimo un mancante nominato;
6. aprire un dettaglio, ricaricarlo e tornare alla dispensa;
7. ripetere a 320px e con sola tastiera;
8. attivare offline e ricaricare home e dettaglio.

- [ ] **Step 5: Controllare assenza di segreti e riferimenti server**

Run:

```bash
rg -n -i "password|secret|jwt|postgres|redis|supabase|authorization|bearer" --glob '!docs/superpowers/**' --glob '!iRicetto_plan.md' --glob '!E2E_VERIFICATION.md'
```

Expected: nessun risultato nei file dell'app. Non stampare né aprire `.env`.

- [ ] **Step 6: Verificare il worktree finale**

Run:

```bash
git status --short
git diff --check
git log --oneline -10
```

Expected: nessun errore whitespace; soltanto `E2E_VERIFICATION.md` resta non tracciato se l'utente non lo ha modificato nel frattempo.

- [ ] **Step 7: Commit della documentazione**

```bash
git add README.md
git commit -m "docs: document local-first iRicetto workflow"
```

- [ ] **Step 8: Report finale di implementazione**

Riportare hash dei commit, comandi eseguiti con esito, eventuali limitazioni manuali e conferma esplicita che `E2E_VERIFICATION.md` e `.env` non sono stati inclusi né modificati.

---

## Ordine di esecuzione e checkpoint

I task sono strettamente sequenziali: `1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10`.

I checkpoint di revisione più importanti sono:

- dopo Task 4: dominio completo e indipendente dalla UI;
- dopo Task 6: percorso principale funzionante senza login;
- dopo Task 8: PWA reale, installabile e verificata end-to-end;
- prima del Task 9: autorizzazione già contenuta nella specifica a rimuovere il vecchio stack, ma staging da controllare file per file;
- dopo Task 10: repository finale riproducibile con `npm ci`.
