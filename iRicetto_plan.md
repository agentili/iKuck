# iRicetto PWA — Piano Operativo per Agente LLM

## Metadati del Piano

| Campo | Valore |
|-------|--------|
| **Executor** | Agente LLM generico con accesso bash/filesystem |
| **Target** | Server remoto VPS (Ubuntu 22.04+) |
| **Punto di partenza** | Cartella vuota `/srv/meal-planner` |
| **Stack** | Node.js + Express (backend) · React + Vite (frontend) · PostgreSQL · Docker |
| **Stima totale** | 9 fasi · ~40 task atomici |

---

## Convenzioni del Piano

- Ogni **task** è atomico: un agente può eseguirlo senza leggere gli altri.
- Ogni task ha: **Contesto** (cosa esiste già), **Istruzione** (cosa fare), **Output atteso** (file/struttura creati), **Verifica** (comando o check per confermare il completamento).
- I task sono **strettamente sequenziali**: non passare al successivo se la verifica fallisce.
- Le **variabili d'ambiente** sono sempre referenziate come `${VAR}`, mai hardcoded.
- Il piano usa **Docker Compose** per tutti i servizi locali: nessuna dipendenza installata sul VPS direttamente tranne Docker e Node.

---

## Fase 0 — Bootstrap dell'Ambiente

### Task 0.1 — Verifica prerequisiti VPS

**Contesto:** VPS vergine, nessun software installato oltre al sistema operativo.

**Istruzione:**
```
Verifica che sul sistema siano presenti i seguenti strumenti. Per ognuno che manca, installalo:
- Docker (>= 24.x): installa via get.docker.com
- Docker Compose plugin (>= 2.x): incluso in Docker Desktop o installa separatamente
- Node.js (>= 20 LTS): installa via nvm
- npm (>= 10): incluso con Node.js
- git: installa via apt se mancante

Dopo l'installazione esegui i comandi di verifica.
```

**Output atteso:** Tutti i tool installati e funzionanti.

**Verifica:**
```bash
docker --version          # Docker version 24.x.x
docker compose version    # Docker Compose version v2.x.x
node --version            # v20.x.x
npm --version             # 10.x.x
git --version             # git version 2.x.x
```

---

### Task 0.2 — Inizializzazione struttura progetto

**Contesto:** Prerequisiti installati (Task 0.1 completato).

**Istruzione:**
```
Crea la seguente struttura di directory in /srv/meal-planner:

/srv/meal-planner/
├── backend/
├── frontend/
├── docker/
│   └── postgres/
│       └── init.sql       ← file vuoto per ora
├── .env.example
├── .gitignore
├── docker-compose.yml
└── README.md

Inizializza un repository git. Crea un .gitignore che escluda:
node_modules/, .env, dist/, .DS_Store, *.log, coverage/

Crea un README.md con titolo "Meal Planner PWA" e una riga di descrizione.
Crea un .env.example con le seguenti chiavi (valori placeholder):

DATABASE_URL=postgresql://mealplanner:password@localhost:5432/mealplanner
JWT_SECRET=change_me_in_production
JWT_EXPIRES_IN=7d
REDIS_URL=redis://localhost:6379
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

**Output atteso:**
```
/srv/meal-planner/
├── backend/               (cartella vuota)
├── frontend/              (cartella vuota)
├── docker/postgres/init.sql
├── .env.example
├── .gitignore
├── docker-compose.yml     (vuoto per ora)
└── README.md
```

**Verifica:**
```bash
cd /srv/meal-planner && ls -la
git status   # deve mostrare repo inizializzato
cat .env.example   # deve contenere tutte le chiavi
```

---

## Fase 1 — Infrastruttura Docker

### Task 1.1 — Docker Compose: PostgreSQL + Redis

**Contesto:** Struttura progetto creata (Task 0.2). File `docker-compose.yml` esiste ma è vuoto.

**Istruzione:**
```
Scrivi il contenuto completo di /srv/meal-planner/docker-compose.yml.

Deve definire i seguenti servizi:

1. postgres:
   - image: postgres:16-alpine
   - env: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB letti da variabili d'ambiente
   - porta: 5432:5432
   - volume: ./docker/postgres/data:/var/lib/postgresql/data (persistenza)
   - volume: ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
   - healthcheck: pg_isready ogni 10s

2. redis:
   - image: redis:7-alpine
   - porta: 6379:6379
   - volume: ./docker/redis/data:/data (persistenza)
   - comando: redis-server --appendonly yes

Usa network "meal-planner-network" di tipo bridge per tutti i servizi.
Usa un file .env alla root del progetto per le variabili (env_file: .env).
```

**Output atteso:** `docker-compose.yml` completo e valido.

**Verifica:**
```bash
cd /srv/meal-planner
cp .env.example .env
# Edita .env con valori reali (POSTGRES_USER=mealplanner, POSTGRES_PASSWORD=securepass123, POSTGRES_DB=mealplanner)
docker compose config   # deve stampare la config senza errori
docker compose up -d postgres redis
docker compose ps       # postgres e redis devono essere "healthy"
```

---

### Task 1.2 — Schema PostgreSQL iniziale

**Contesto:** PostgreSQL in esecuzione via Docker (Task 1.1). File `docker/postgres/init.sql` esiste ed è vuoto.

**Istruzione:**
```
Scrivi il contenuto completo di /srv/meal-planner/docker/postgres/init.sql.

Deve creare le seguenti tabelle in ordine (rispettando i foreign key):

1. users (id UUID PK, email UNIQUE NOT NULL, username NOT NULL, password_hash NOT NULL, created_at, updated_at)
2. pantries (id UUID PK, user_id UUID FK → users ON DELETE CASCADE, created_at, updated_at)
3. pantry_items (id UUID PK, pantry_id UUID FK → pantries ON DELETE CASCADE, name VARCHAR(100) NOT NULL, category VARCHAR(50), quantity NUMERIC NOT NULL DEFAULT 0, unit VARCHAR(20), expiry_date TIMESTAMP, added_at, updated_at, UNIQUE(pantry_id, name))
4. recipes (id UUID PK, title VARCHAR(255) NOT NULL, description TEXT, difficulty VARCHAR(20) CHECK IN ('easy','medium'), preparation_time INTEGER, servings INTEGER, ingredients JSONB NOT NULL DEFAULT '[]', instructions JSONB NOT NULL DEFAULT '[]', tags JSONB DEFAULT '[]', image_url VARCHAR(500), created_at)
5. recipe_history (id UUID PK, user_id UUID FK → users ON DELETE CASCADE, recipe_id UUID FK → recipes, meal_type VARCHAR(20) CHECK IN ('breakfast','lunch','dinner'), completed_date TIMESTAMP NOT NULL, rating INTEGER CHECK 1-5, notes TEXT, created_at, updated_at)

Usa gen_random_uuid() per gli UUID. Aggiungi gli indici:
- pantry_items(pantry_id)
- pantry_items(name)
- recipe_history(user_id)
- recipe_history(completed_date)
- recipes(difficulty)
- recipes usando GIN su tags e ingredients (per ricerca JSONB)
```

**Output atteso:** `docker/postgres/init.sql` con tutte le CREATE TABLE e CREATE INDEX.

**Verifica:**
```bash
# Ricrea il container postgres per eseguire l'init.sql
docker compose down postgres
docker volume rm meal-planner_postgres_data 2>/dev/null || true
docker compose up -d postgres
sleep 5
docker compose exec postgres psql -U mealplanner -d mealplanner -c "\dt"
# Deve listare: users, pantries, pantry_items, recipes, recipe_history
```

---

## Fase 2 — Backend: Setup e Auth

### Task 2.1 — Inizializzazione progetto Node.js backend

**Contesto:** Cartella `/srv/meal-planner/backend/` esiste ed è vuota. Node.js e npm installati.

**Istruzione:**
```
Inizializza il progetto Node.js in /srv/meal-planner/backend/.

1. Esegui: npm init -y
2. Installa le dipendenze di produzione:
   express, pg, bcryptjs, jsonwebtoken, zod, cors, helmet, express-rate-limit, dotenv, uuid
3. Installa le dipendenze di sviluppo:
   typescript, @types/node, @types/express, @types/pg, @types/bcryptjs, @types/jsonwebtoken, @types/uuid, ts-node-dev, vitest

4. Crea tsconfig.json con:
   - target: ES2022
   - module: commonjs
   - outDir: ./dist
   - rootDir: ./src
   - strict: true
   - esModuleInterop: true
   - resolveJsonModule: true

5. Crea la struttura di directory src/:
   src/
   ├── routes/
   ├── controllers/
   ├── services/
   ├── middleware/
   ├── db/
   ├── types/
   └── utils/

6. Aggiungi in package.json gli script:
   - "dev": "ts-node-dev --respawn --transpile-only src/server.ts"
   - "build": "tsc"
   - "start": "node dist/server.js"
   - "test": "vitest run"
```

**Output atteso:**
```
backend/
├── node_modules/
├── src/
│   ├── routes/ controllers/ services/ middleware/ db/ types/ utils/
├── package.json
├── package-lock.json
└── tsconfig.json
```

**Verifica:**
```bash
cd /srv/meal-planner/backend
node -e "require('./node_modules/express')" && echo "OK"
npx tsc --noEmit   # nessun errore (src/ è vuota, ok)
```

---

### Task 2.2 — Database connection e server entry point

**Contesto:** Progetto backend inizializzato (Task 2.1). PostgreSQL in esecuzione.

**Istruzione:**
```
Crea i seguenti file in /srv/meal-planner/backend/src/:

1. db/connection.ts
   - Crea un Pool pg con connection string da process.env.DATABASE_URL
   - Esporta una funzione query(text, params) che usa il pool
   - Esporta il pool stesso per transazioni
   - Al primo import, testa la connessione con pool.query('SELECT 1') e logga il risultato

2. utils/logger.ts
   - Logger minimale con prefisso timestamp
   - Esporta: logger.info(), logger.error(), logger.warn()

3. utils/jwt.ts
   - Funzione signToken(userId: string): string — firma con JWT_SECRET, scadenza JWT_EXPIRES_IN
   - Funzione verifyToken(token: string): { userId: string } — verifica e ritorna il payload

4. utils/password.ts
   - Funzione hashPassword(plain: string): Promise<string> — bcrypt con saltRounds=12
   - Funzione comparePassword(plain, hash): Promise<boolean>

5. types/index.ts
   - Interfacce TypeScript per: User, Pantry, PantryItem, Recipe, RecipeHistory
   - Tipo ApiResponse<T> = { success: boolean; data?: T; error?: string }

6. src/server.ts
   - Crea app Express con middleware: helmet(), cors({ origin: FRONTEND_URL }), express.json(), rate-limit (100 req/15min)
   - Route placeholder: GET /health → { status: 'ok', timestamp: new Date() }
   - Avvia il server sulla porta PORT
   - Gestione errori globale (middleware finale)
```

**Output atteso:** 6 file creati, server avviabile.

**Verifica:**
```bash
cd /srv/meal-planner/backend
cp ../.env.example ../.env  # se non già fatto
DATABASE_URL=postgresql://mealplanner:securepass123@localhost:5432/mealplanner \
JWT_SECRET=test_secret \
npm run dev &
sleep 3
curl http://localhost:3000/health
# Risposta attesa: {"status":"ok","timestamp":"..."}
```

---

### Task 2.3 — Auth: Register e Login

**Contesto:** Server avviato e connesso a PostgreSQL (Task 2.2). Utilities jwt e password esistono.

**Istruzione:**
```
Implementa il sistema di autenticazione creando i seguenti file:

1. middleware/auth.ts
   - Middleware authenticateToken(req, res, next)
   - Legge header Authorization: Bearer <token>
   - Verifica il token con verifyToken()
   - Aggiunge req.userId = payload.userId
   - Ritorna 401 se il token manca o non è valido

2. controllers/authController.ts
   - register(req, res):
     * Valida body con Zod: { email: z.string().email(), password: z.string().min(8), username: z.string().min(3) }
     * Controlla che email non esista già in users
     * Crea utente: hashPassword, INSERT INTO users, INSERT INTO pantries (crea pantry vuota per l'utente)
     * Ritorna 201 con { userId, email, username, token }
   - login(req, res):
     * Valida body: { email, password }
     * Trova utente per email
     * comparePassword
     * Ritorna 200 con { userId, email, username, token }
     * Ritorna 401 se credenziali errate (messaggio generico)

3. routes/auth.ts
   - POST /auth/register → authController.register
   - POST /auth/login → authController.login

4. Registra routes/auth.ts in server.ts con prefisso /api
```

**Output atteso:** 3 file + aggiornamento server.ts. Endpoint auth funzionanti.

**Verifica:**
```bash
# Register
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123","username":"testuser"}' | jq .
# Atteso: { success: true, data: { userId, email, username, token } }

# Login
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}' | jq .
# Atteso: { success: true, data: { token, ... } }

# Verifica pantry creata
docker compose exec postgres psql -U mealplanner -d mealplanner \
  -c "SELECT u.email, p.id FROM users u JOIN pantries p ON p.user_id = u.id;"
```

---

## Fase 3 — Backend: Pantry e Recipe

### Task 3.1 — Pantry CRUD API

**Contesto:** Auth funzionante (Task 2.3). Tabelle pantries e pantry_items esistono.

**Istruzione:**
```
Implementa la gestione della dispensa:

1. services/pantryService.ts
   - getPantry(userId): ritorna pantry con tutti gli items
   - addItem(pantryId, item): INSERT INTO pantry_items, ritorna l'item creato
   - updateItem(pantryId, itemId, data): UPDATE pantry_items, ritorna l'item aggiornato
   - deleteItem(pantryId, itemId): DELETE, ritorna 204
   - getPantryIdForUser(userId): SELECT pantry id per userId

2. controllers/pantryController.ts
   - getPantry(req, res): usa req.userId (da middleware auth), chiama pantryService.getPantry
   - addItem(req, res): valida body Zod { name: string, quantity: number, unit: string, category?: string, expiryDate?: string }
   - updateItem(req, res): valida body Zod parziale
   - deleteItem(req, res): verifica che l'item appartenga alla pantry dell'utente prima di eliminare

3. routes/pantry.ts
   - Tutte le route protette da middleware authenticateToken
   - GET /pantry → getPantry
   - POST /pantry/items → addItem
   - PUT /pantry/items/:itemId → updateItem
   - DELETE /pantry/items/:itemId → deleteItem

4. Registra routes/pantry.ts in server.ts con prefisso /api
```

**Output atteso:** 3 file + aggiornamento server.ts. CRUD pantry funzionante.

**Verifica:**
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}' | jq -r '.data.token')

# Aggiungi ingrediente
curl -s -X POST http://localhost:3000/api/pantry/items \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"tomato","quantity":5,"unit":"piece","category":"produce"}' | jq .

# Leggi pantry
curl -s http://localhost:3000/api/pantry \
  -H "Authorization: Bearer $TOKEN" | jq .
# Atteso: pantry con 1 item (tomato)
```

---

### Task 3.2 — Recipe seeding (5000+ ricette)

**Contesto:** Tabella recipes esiste e vuota (Task 1.2). Connessione DB funzionante.

**Istruzione:**
```
Crea uno script di seeding per popolare la tabella recipes.

1. Crea src/db/seedRecipes.ts

   Lo script deve:
   - Generare 200 ricette di base (scalabile in seguito) con difficoltà easy/medium
   - Ogni ricetta deve avere ingredienti realistici in italiano
   - Creare almeno 8 categorie: pasta, riso, zuppe, insalate, carne, pesce, verdure, uova
   - Ogni categoria deve avere 25 ricette
   - Struttura di ogni ricetta:
     {
       title: string (es. "Pasta al Pomodoro"),
       description: string,
       difficulty: "easy" | "medium",
       preparation_time: number (10-45 minuti),
       servings: 2 | 4,
       ingredients: [{ name, quantity, unit, isOptional: boolean }],
       instructions: [{ step, description, duration? }],
       tags: string[],
       image_url: null
     }
   - Inserisci le ricette in batch da 50 con INSERT ... ON CONFLICT DO NOTHING

2. Aggiungi script package.json: "seed": "ts-node src/db/seedRecipes.ts"

NOTA: Gli ingredienti devono usare nomi italiani comuni (pomodoro, pasta, cipolla, aglio, olio d'oliva, ecc.) perché il matching avviene per nome con la pantry dell'utente.
```

**Output atteso:** `src/db/seedRecipes.ts` con 200+ ricette realistiche.

**Verifica:**
```bash
cd /srv/meal-planner/backend
DATABASE_URL=postgresql://mealplanner:securepass123@localhost:5432/mealplanner npm run seed

docker compose exec postgres psql -U mealplanner -d mealplanner \
  -c "SELECT difficulty, COUNT(*) FROM recipes GROUP BY difficulty;"
# Atteso: easy ~100, medium ~100

docker compose exec postgres psql -U mealplanner -d mealplanner \
  -c "SELECT title, preparation_time FROM recipes LIMIT 5;"
```

---

### Task 3.3 — Recipe Suggestion Engine

**Contesto:** Ricette nel DB (Task 3.2). Pantry API funzionante (Task 3.1). Tabella recipe_history esiste.

**Istruzione:**
```
Implementa l'algoritmo di suggerimento ricette:

1. services/recipeSuggestionService.ts
   Implementa la funzione principale:

   suggest(userId, mealType):
     a) Carica la pantry dell'utente (getPantry)
     b) Carica tutte le ricette filtrate per difficulty IN ('easy','medium') e preparation_time <= 45
     c) Per ogni ricetta, calcola ingredientMatch:
        - required = ingredients dove isOptional = false
        - matched = required dove name (lowercase) è nella pantry E quantity <= pantry quantity
        - matchPct = (matched.length / required.length) * 100
        - isViable = matchPct >= 90
     d) Mantieni solo le ricette isViable
     e) Carica la history dell'utente (recipe_history dove user_id = userId)
     f) Separa le ricette viable in:
        - executed: recipe_id presente in history
        - newRecipes: recipe_id NON presente in history
     g) Ordina newRecipes per matchPct DESC
     h) Selezione finale:
        IF executed.length > 0:
          return [executed[0], newRecipes[0], newRecipes[1]].filter(Boolean)
        ELSE:
          return newRecipes.slice(0, 3)
     i) Aggiungi a ogni ricetta nel risultato: wasExecuted, ingredientMatch

2. services/recipeHistoryService.ts
   - addHistory(userId, recipeId, mealType): INSERT INTO recipe_history
   - updateRating(historyId, userId, rating, notes): UPDATE rating e notes
   - getUserHistory(userId): SELECT history con JOIN recipes

3. controllers/recipeController.ts
   - getSuggestions(req, res): query param mealType (default 'dinner'), chiama suggest()
   - addHistory(req, res): segna ricetta come completata
   - updateRating(req, res): aggiorna rating
   - getHistory(req, res): restituisce history utente

4. routes/recipes.ts
   - GET /recipes/suggest?mealType=lunch → getSuggestions (protetta)
   - POST /recipes/history → addHistory (protetta)
   - PUT /recipes/history/:historyId → updateRating (protetta)
   - GET /recipes/history → getHistory (protetta)

5. Registra routes/recipes.ts in server.ts
```

**Output atteso:** 4 file + aggiornamento server.ts. Suggestion engine funzionante.

**Verifica:**
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}' | jq -r '.data.token')

# Aggiungi più ingredienti alla pantry
for ing in "pomodoro:5:piece" "pasta:500:g" "cipolla:2:piece" "aglio:4:piece" "olio d olive:200:ml"; do
  NAME=$(echo $ing | cut -d: -f1)
  QTY=$(echo $ing | cut -d: -f2)
  UNIT=$(echo $ing | cut -d: -f3)
  curl -s -X POST http://localhost:3000/api/pantry/items \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$NAME\",\"quantity\":$QTY,\"unit\":\"$UNIT\"}" > /dev/null
done

# Richiedi suggerimenti
curl -s "http://localhost:3000/api/recipes/suggest?mealType=dinner" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.suggestions | length'
# Atteso: 3

curl -s "http://localhost:3000/api/recipes/suggest?mealType=dinner" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.suggestions[].title'
```

---

## Fase 4 — Backend: Test e Hardening

### Task 4.1 — Unit test: RecipeSuggestionService

**Contesto:** Suggestion engine implementato (Task 3.3). Vitest installato.

**Istruzione:**
```
Scrivi i test unitari per recipeSuggestionService.ts.

Crea src/services/__tests__/recipeSuggestionService.test.ts

Implementa i seguenti test usando l'approccio Given/When/Then:

1. "Given pantry with matching ingredients, When suggest is called, Then returns 3 viable recipes"
2. "Given no history, When suggest is called, Then all 3 suggestions are new recipes"
3. "Given 1 executed recipe matching pantry, When suggest is called, Then first suggestion is the executed recipe"
4. "Given ingredients match only 80%, When suggest is called, Then recipe is excluded (below 90% threshold)"
5. "Given empty pantry, When suggest is called, Then returns empty array"
6. "Given all recipes already executed, When suggest is called, Then returns executed recipes (up to 3)"

Mocka le chiamate al database usando vi.mock() — i test non devono connettersi a PostgreSQL.
Testa solo la logica pura del servizio estraendo le funzioni pure (calculateIngredientMatch, categorizeRecipes, selectBestThree) o refactorando il servizio per renderle testabili.
```

**Output atteso:** File di test con 6+ test case.

**Verifica:**
```bash
cd /srv/meal-planner/backend
npm test
# Atteso: 6/6 tests passed, 0 failed
```

---

## Fase 5 — Frontend: Setup e Auth

### Task 5.1 — Inizializzazione progetto React

**Contesto:** Cartella `/srv/meal-planner/frontend/` esiste ed è vuota.

**Istruzione:**
```
Inizializza il progetto React in /srv/meal-planner/frontend/.

1. Esegui: npm create vite@latest . -- --template react-ts
   (nella cartella frontend/)

2. Installa le dipendenze:
   - react-router-dom
   - zustand
   - @tanstack/react-query
   - react-hook-form
   - zod
   - @hookform/resolvers
   - dexie (IndexedDB)
   - axios

3. Installa dipendenze sviluppo:
   - @types/node
   - vite-plugin-pwa

4. Configura vite.config.ts:
   - Aggiungi VitePWA plugin con opzione registerType: 'autoUpdate'
   - Manifest: name "Meal Planner", short_name "Meal", theme_color "#0F6E56", background_color "#ffffff", display: "standalone"
   - server proxy: /api → http://localhost:3000

5. Crea la struttura src/:
   src/
   ├── components/
   │   ├── auth/
   │   ├── pantry/
   │   ├── suggestions/
   │   ├── recipe/
   │   ├── history/
   │   └── shared/
   ├── pages/
   ├── services/
   ├── store/
   ├── db/
   ├── types/
   └── utils/

6. Svuota App.tsx e App.css dai contenuti di esempio Vite.
```

**Output atteso:** Progetto Vite React funzionante con struttura cartelle.

**Verifica:**
```bash
cd /srv/meal-planner/frontend
npm run dev &
sleep 5
curl -s http://localhost:5173 | grep -o "<title>.*</title>"
# Atteso: <title>Vite + React + TS</title> (o simile)
```

---

### Task 5.2 — IndexedDB setup e API client

**Contesto:** Frontend inizializzato (Task 5.1).

**Istruzione:**
```
Crea i layer fondamentali del frontend:

1. src/db/database.ts (Dexie)
   Definisci lo schema IndexedDB con le seguenti tabelle:
   - users: ++id, userId, email, username
   - pantryItems: ++id, ingredientId, pantryId, name, category, quantity, unit, expiryDate, updatedAt
   - recipes: ++id, recipeId, title, difficulty, preparationTime, ingredients, instructions, tags
   - recipeHistory: ++id, historyId, userId, recipeId, mealType, completedDate, rating
   - syncQueue: ++id, operation, endpoint, payload, createdAt
   Esporta un'istanza db di Dexie.

2. src/utils/apiClient.ts
   - Crea un'istanza axios con baseURL='/api'
   - Interceptor request: aggiunge Authorization: Bearer <token> da localStorage ('meal_planner_token')
   - Interceptor response: gestisce 401 → rimuove token da localStorage e redirect a /login
   - Esporta: apiClient, e funzioni get<T>(), post<T>(), put<T>(), del<T>() tipizzate

3. src/types/index.ts
   - Copia/adatta le interfacce TypeScript dal backend: User, PantryItem, Recipe, RecipeHistory, Suggestion
   - Tipo AuthState: { user: User | null, token: string | null, isAuthenticated: boolean }
```

**Output atteso:** 3 file fondamentali del frontend.

**Verifica:**
```bash
cd /srv/meal-planner/frontend
npx tsc --noEmit
# Nessun errore TypeScript
```

---

### Task 5.3 — Auth store e pagine Login/Register

**Contesto:** API client e IndexedDB setup (Task 5.2). Backend auth funzionante (Task 2.3).

**Istruzione:**
```
Implementa l'autenticazione frontend:

1. src/store/authStore.ts (Zustand)
   State: { user, token, isAuthenticated }
   Actions:
   - login(email, password): chiama POST /api/auth/login, salva token in localStorage, aggiorna stato
   - register(email, password, username): chiama POST /api/auth/register, auto-login dopo
   - logout(): rimuove token localStorage, resetta stato
   - initAuth(): legge token da localStorage all'avvio, valida (se presente popola stato)

2. src/pages/LoginPage.tsx
   - Form con campi email e password
   - Validazione Zod via react-hook-form
   - Chiama authStore.login()
   - Mostra errori inline
   - Link a /register
   - Redirect a /suggest dopo login riuscito

3. src/pages/RegisterPage.tsx
   - Form con campi email, password, username
   - Validazione Zod: email valida, password min 8 caratteri, username min 3
   - Chiama authStore.register()
   - Redirect a /suggest dopo registrazione

4. src/components/shared/ProtectedRoute.tsx
   - HOC che verifica isAuthenticated
   - Se non autenticato: redirect a /login

5. src/App.tsx
   - Configura React Router: / → redirect /suggest, /login, /register, /suggest (protetta), /pantry (protetta), /history (protetta)
   - Chiama authStore.initAuth() all'avvio (useEffect)
   - Avvolgi tutto con QueryClientProvider (TanStack Query)
```

**Output atteso:** 5 file. Auth flow completo.

**Verifica:**
```bash
# Con frontend e backend entrambi in esecuzione:
# 1. Apri http://localhost:5173 → deve redirigere a /login
# 2. Vai su /register → registra nuovo utente → deve redirigere a /suggest
# 3. Logout → deve tornare a /login
# 4. Login con credenziali → deve redirigere a /suggest

# Oppure via curl (verifica solo la logica API, non il redirect):
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"frontend@test.com","password":"password123","username":"frontenduser"}' | jq .success
# Atteso: true
```

---

## Fase 6 — Frontend: Pantry e Suggestions

### Task 6.1 — Pantry UI

**Contesto:** Auth UI funzionante (Task 5.3). Backend pantry API funzionante (Task 3.1).

**Istruzione:**
```
Implementa la pagina Pantry:

1. src/store/pantryStore.ts (Zustand)
   State: { items: PantryItem[], isLoading, lastSync }
   Actions:
   - fetchPantry(): GET /api/pantry, salva in state e IndexedDB
   - addItem(item): ottimistico — aggiunge a state immediatamente, POST /api/pantry/items, salva in IndexedDB
   - updateItem(id, data): ottimistico — aggiorna state, PUT /api/pantry/items/:id
   - deleteItem(id): ottimistico — rimuove da state, DELETE /api/pantry/items/:id
   - loadFromCache(): carica da IndexedDB (per uso offline)

2. src/components/pantry/IngredientCard.tsx
   - Mostra: nome, quantità + unità, categoria (badge colorato), data scadenza se presente
   - Pulsanti: modifica (matita) e elimina (cestino)
   - Design: card compatta, mobile-first

3. src/components/pantry/AddIngredientModal.tsx
   - Form: name (required), quantity (number, required), unit (select: g/kg/ml/l/piece/tbsp/tsp), category (select), expiryDate (date, optional)
   - Validazione react-hook-form + Zod
   - Submit chiama pantryStore.addItem()

4. src/pages/PantryPage.tsx
   - Header con titolo "La mia dispensa" e pulsante "+ Aggiungi"
   - Lista ingredienti raggruppati per categoria
   - Empty state se pantry vuota
   - Floating action button per aggiungere su mobile
   - Chiama fetchPantry() al mount
```

**Output atteso:** 4 file. Pantry CRUD funzionante nell'UI.

**Verifica:**
```
Test manuale via browser http://localhost:5173/pantry:
1. Aggiungi 3 ingredienti → devono apparire nella lista senza refresh
2. Modifica quantità di un ingrediente → deve aggiornarsi
3. Elimina un ingrediente → deve sparire immediatamente (ottimistico)
4. Spegni il backend e ricarica la pagina → deve mostrare la lista dalla cache IndexedDB
```

---

### Task 6.2 — Suggestion UI

**Contesto:** Pantry UI funzionante (Task 6.1). Backend suggestion engine funzionante (Task 3.3).

**Istruzione:**
```
Implementa la pagina Suggerimenti:

1. src/store/suggestionStore.ts (Zustand)
   State: { suggestions: Suggestion[], mealType, isLoading }
   Actions:
   - fetchSuggestions(mealType): GET /api/recipes/suggest?mealType=X, aggiorna state

2. src/components/suggestions/MealTypeSelector.tsx
   - 3 pulsanti: Colazione | Pranzo | Cena
   - Il selezionato ha highlight visivo
   - Al click: aggiorna mealType nello store e ri-fetcha suggerimenti

3. src/components/suggestions/RecipeCard.tsx
   Props: recipe: Suggestion
   Mostra:
   - Titolo ricetta
   - Badge difficoltà (verde=easy, giallo=medium)
   - Tempo preparazione (icona orologio + minuti)
   - Badge "Già preparata" se wasExecuted = true (colore diverso)
   - Percentuale match ingredienti (progress bar o numero)
   - Pulsante "Cucina questa →"
   Al click su "Cucina questa": navigate a /recipe/:recipeId

4. src/pages/SuggestionPage.tsx
   - MealTypeSelector in cima
   - 3 RecipeCard in colonna (o griglia su tablet)
   - Empty state se pantry vuota (con link a /pantry)
   - Loading skeleton durante il fetch
   - Pulsante "Aggiorna suggerimenti" (re-fetch)
   - Chiama fetchSuggestions('dinner') al mount
```

**Output atteso:** 4 file. Pagina suggerimenti funzionante.

**Verifica:**
```
Test manuale via browser http://localhost:5173/suggest:
1. Con pantry vuota → deve mostrare empty state con link a /pantry
2. Aggiungi ingredienti alla pantry, poi torna a /suggest → devono apparire 3 ricette
3. Cambia meal type → le suggerimenti devono aggiornarsi
4. Il badge "Già preparata" non deve apparire (nessuna history ancora)
```

---

### Task 6.3 — Recipe Detail e Cooking Mode

**Contesto:** Suggestion UI funzionante (Task 6.2). Backend history API funzionante (Task 3.3).

**Istruzione:**
```
Implementa la pagina dettaglio ricetta e la modalità cottura:

1. src/components/recipe/TimerComponent.tsx
   Props: durationSeconds: number, label: string
   - Mostra countdown dal valore iniziale
   - Pulsanti: Start / Pausa / Reset
   - Quando arriva a 0: suono (Audio API) e mostra "Completato!"
   - Non richiede librerie esterne

2. src/components/recipe/InstructionsSection.tsx
   Props: instructions: Instruction[]
   - Lista numerata di step
   - Ogni step con descrizione e TimerComponent se duration è definita
   - Step corrente evidenziato
   - Pulsante "Step successivo"

3. src/pages/RecipeDetailPage.tsx
   - Carica la ricetta da state/IndexedDB per recipeId (dal param URL)
   - Mostra: titolo, difficoltà, tempo, porzioni
   - Lista ingredienti con spunta (checkbox) per ogni ingrediente
   - InstructionsSection
   - Pulsante "Segna come completata" in fondo
   - Al click: POST /api/recipes/history, mostra RatingModal

4. src/components/recipe/RatingModal.tsx
   - Overlay modale con 5 stelle cliccabili
   - Campo testo opzionale "Note"
   - Pulsante "Salva" → PUT /api/recipes/history/:id con rating e notes
   - Chiude il modal e redirect a /suggest
```

**Output atteso:** 4 file. Cooking flow completo.

**Verifica:**
```
Test manuale:
1. Da /suggest, clicca "Cucina questa" → deve aprire /recipe/:id con dettagli
2. Avvia un timer → deve fare conto alla rovescia
3. Clicca "Segna come completata" → deve aprire il modal di rating
4. Salva rating → deve redirigere a /suggest
5. Richiedi nuovi suggerimenti → la ricetta appena cucinata deve avere badge "Già preparata"
```

---

## Fase 7 — Frontend: History e Layout

### Task 7.1 — History e navigazione

**Contesto:** Cooking flow funzionante (Task 6.3). Backend history API funzionante.

**Istruzione:**
```
Implementa la pagina storia e la navigazione principale:

1. src/pages/HistoryPage.tsx
   - Fetcha GET /api/recipes/history
   - Lista di ricette cucinate, ordinate per data decrescente
   - Ogni item mostra: titolo, data, meal type, rating (stelle), note
   - Empty state se nessuna ricetta cucinata ancora

2. src/components/shared/BottomNavigation.tsx
   - Barra di navigazione fissa in fondo (mobile-first)
   - 3 tab: Dispensa (/pantry) | Suggerimenti (/suggest) | Storico (/history)
   - Tab attivo evidenziato
   - Icone semplici (SVG inline o unicode)

3. src/components/shared/Header.tsx
   - Titolo della pagina corrente (dinamico)
   - Pulsante logout (icona) in alto a destra
   - Visibile solo nelle pagine protette

4. Aggiorna App.tsx:
   - Tutte le pagine protette devono mostrare Header e BottomNavigation
   - Layout: flex column, Header top, main content scroll, BottomNavigation fixed bottom
   - Padding bottom nel main per non nascondere contenuto sotto BottomNavigation
```

**Output atteso:** 4 file aggiornati. App navigabile da mobile.

**Verifica:**
```
Test manuale su mobile (DevTools → device emulation, es. iPhone 14):
1. BottomNavigation deve essere visibile e funzionante su tutte le pagine protette
2. Il contenuto non deve essere nascosto dalla BottomNavigation
3. La pagina /history deve mostrare le ricette cucinate nei task precedenti
4. Il logout deve funzionare e redirigere a /login
```

---

## Fase 8 — PWA, Build e Deploy

### Task 8.1 — PWA manifest e Service Worker

**Contesto:** App funzionante end-to-end (Task 7.1). vite-plugin-pwa installato (Task 5.1).

**Istruzione:**
```
Configura la PWA completa:

1. Crea public/manifest.json:
   {
     name: "Meal Planner",
     short_name: "Meal",
     description: "Pianifica i tuoi pasti in base alla dispensa",
     start_url: "/suggest",
     display: "standalone",
     background_color: "#ffffff",
     theme_color: "#0F6E56",
     icons: [
       { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
       { src: "/icon-512.png", sizes: "512x512", type: "image/png" }
     ]
   }

2. Crea le icone SVG programmaticamente (senza strumenti grafici):
   - Genera public/icon-192.png e public/icon-512.png usando Node.js canvas o
   - Crea icone SVG semplici (cerchio verde con lettera "M") e convertile in PNG con sharp:
     npm install --save-dev sharp
     Crea scripts/generateIcons.ts e eseguilo

3. Configura vite.config.ts con VitePWA:
   - workbox.globPatterns: ['**/*.{js,css,html,ico,png,svg}']
   - workbox.runtimeCaching per le API /api/recipes (NetworkFirst, 24h cache)
   - workbox.runtimeCaching per gli asset statici (CacheFirst)

4. Aggiorna index.html:
   - Aggiungi <link rel="manifest" href="/manifest.json">
   - Aggiungi <meta name="theme-color" content="#0F6E56">
   - Aggiungi <meta name="apple-mobile-web-app-capable" content="yes">
```

**Output atteso:** Manifest, icone e service worker configurati.

**Verifica:**
```bash
cd /srv/meal-planner/frontend
npm run build
npx serve dist &
# Apri http://localhost:3001
# Chrome DevTools → Application → Manifest: deve caricarsi senza errori
# Chrome DevTools → Application → Service Workers: deve mostrare SW attivo
# Lighthouse PWA audit: deve passare tutti i check PWA
```

---

### Task 8.2 — Docker Compose produzione e deploy

**Contesto:** Build frontend funzionante (Task 8.1). Backend testato (Task 4.1).

**Istruzione:**
```
Prepara il deploy completo su VPS:

1. Crea backend/Dockerfile:
   - Base: node:20-alpine
   - WORKDIR /app
   - Copia package*.json, npm ci --only=production
   - Copia src/, tsconfig.json
   - RUN npm run build
   - EXPOSE 3000
   - CMD ["node", "dist/server.js"]

2. Crea frontend/Dockerfile:
   - Stage 1 (build): node:20-alpine, npm ci, npm run build
   - Stage 2 (serve): nginx:alpine
   - Copia dist/ in /usr/share/nginx/html
   - Crea nginx.conf: serve su porta 80, tutte le route non-asset → index.html (SPA routing), proxy /api → backend:3000
   - EXPOSE 80

3. Aggiorna docker-compose.yml aggiungendo i servizi:
   - backend: build ./backend, depends_on postgres, env_file .env, networks
   - frontend: build ./frontend, depends_on backend, ports: 80:80, networks
   - Aggiungi healthcheck al backend: curl http://localhost:3000/health

4. Crea scripts/deploy.sh:
   #!/bin/bash
   set -e
   git pull origin main
   docker compose build --no-cache backend frontend
   docker compose up -d
   docker compose ps
   echo "Deploy completato"

5. Aggiorna README.md con istruzioni di deploy e variabili .env necessarie.
```

**Output atteso:** Dockerfile backend e frontend, docker-compose.yml aggiornato, script deploy.

**Verifica:**
```bash
cd /srv/meal-planner
docker compose build
docker compose up -d
docker compose ps
# Tutti i servizi (postgres, redis, backend, frontend) devono essere running/healthy

curl http://localhost/api/health
# Atteso: {"status":"ok",...}

curl http://localhost
# Atteso: HTML della React app
```

---

## Fase 9 — Verifica Finale End-to-End

### Task 9.1 — Test end-to-end completo

**Contesto:** Tutti i servizi in produzione (Task 8.2).

**Istruzione:**
```
Esegui la verifica completa del flusso utente eseguendo i seguenti step in ordine. Per ogni step, verifica che il risultato sia quello atteso. Se un qualsiasi step fallisce, identifica il componente responsabile e correggi prima di continuare.

STEP 1: Registrazione
  POST /api/auth/register con nuove credenziali
  Atteso: 201, token nel response

STEP 2: Login
  POST /api/auth/login con stesse credenziali
  Atteso: 200, token valido

STEP 3: Pantry vuota
  GET /api/pantry con token
  Atteso: pantry con items = []

STEP 4: Aggiungi ingredienti
  POST /api/pantry/items × 5 (es: pasta 500g, pomodoro 4 pezzi, cipolla 2 pezzi, aglio 6 pezzi, olio d olive 200ml)
  Atteso: 5 items creati, GET /api/pantry ritorna tutti e 5

STEP 5: Suggerimenti senza history
  GET /api/recipes/suggest?mealType=dinner
  Atteso: 3 ricette, wasExecuted = false per tutte

STEP 6: Segna ricetta come completata
  POST /api/recipes/history con recipeId della prima ricetta suggerita
  Atteso: 201, historyId creato

STEP 7: Aggiungi rating
  PUT /api/recipes/history/:historyId con { rating: 4, notes: "Ottima!" }
  Atteso: 200, rating aggiornato

STEP 8: Suggerimenti con history
  GET /api/recipes/suggest?mealType=dinner
  Atteso: 3 ricette, almeno 1 con wasExecuted = true

STEP 9: Storico
  GET /api/recipes/history
  Atteso: 1 ricetta nello storico con rating: 4

STEP 10: PWA installabile
  Apri http://<VPS_IP> in Chrome mobile
  Atteso: banner "Aggiungi alla schermata Home" oppure icona di installazione

Documenta ogni step con il comando curl e la risposta ottenuta.
```

**Output atteso:** Tutti i 10 step passano senza errori.

**Verifica finale:**
```bash
# Script di smoke test automatico
TOKEN=$(curl -s -X POST http://localhost/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e@test.com","password":"password123","username":"e2euser"}' | jq -r '.data.token')

echo "Token: ${TOKEN:0:20}..."

SUGGESTIONS=$(curl -s "http://localhost/api/recipes/suggest?mealType=dinner" \
  -H "Authorization: Bearer $TOKEN")

COUNT=$(echo $SUGGESTIONS | jq '.data.suggestions | length')
echo "Suggerimenti ricevuti: $COUNT"
[ "$COUNT" = "3" ] && echo "✓ PASS" || echo "✗ FAIL"

RECIPE_ID=$(echo $SUGGESTIONS | jq -r '.data.suggestions[0].recipeId')

HISTORY=$(curl -s -X POST http://localhost/api/recipes/history \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"recipeId\":\"$RECIPE_ID\",\"mealType\":\"dinner\",\"completedDate\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")

echo "History: $(echo $HISTORY | jq .success)"

SUGGESTIONS2=$(curl -s "http://localhost/api/recipes/suggest?mealType=dinner" \
  -H "Authorization: Bearer $TOKEN")
EXECUTED=$(echo $SUGGESTIONS2 | jq '[.data.suggestions[] | select(.wasExecuted == true)] | length')
echo "Ricette già eseguite nei suggerimenti: $EXECUTED"
[ "$EXECUTED" = "1" ] && echo "✓ PASS: algoritmo 2+1 funzionante" || echo "✗ FAIL"
```

---

## Appendice — Gestione Errori dell'Agente

Se durante l'esecuzione un task fallisce, l'agente deve:

1. **Leggere l'errore completo** (non troncare i log)
2. **Identificare il file e la riga** responsabile
3. **Correggere solo il problema specifico** senza riscrivere file non coinvolti
4. **Ri-eseguire la verifica** del task corrente prima di procedere
5. **Non saltare task**: ogni fase dipende dalla precedente

### Errori Comuni e Soluzioni

| Errore | Causa Probabile | Soluzione |
|--------|----------------|-----------|
| `ECONNREFUSED :5432` | PostgreSQL non partito | `docker compose up -d postgres` + attendi healthcheck |
| `JWT malformed` | Token non letto da localStorage | Verifica interceptor in apiClient.ts |
| `relation does not exist` | init.sql non eseguito | Ricrea container postgres |
| `TS2307: Cannot find module` | Import path errato | Verifica path relativi in tsconfig |
| `CORS error` | origin non whitelistato | Aggiorna FRONTEND_URL in .env e riavvia backend |
| `0 suggestions returned` | Nomi ingredienti non matchano | Verifica lowercase comparison in recipeSuggestionService |

---

**Fine del Piano Operativo**
**Versione**: 1.0 — Maggio 2026
