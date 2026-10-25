# Procedura di rilascio iKuck — produzione

Questa procedura definisce il flusso completo per rilasciare una nuova versione di iKuck in produzione. È stata derivata dal rilascio della categorizzazione migliorata degli ingredienti in dispensa (feat/pantry-categorization).

## Prerequisiti

- Branch di lavoro pulito su `main` (nessuna modifica non committata non relativa al rilascio).
- Dipendenze installate: `npm ci --prefix frontend` e `npm ci --prefix backend`.
- Accesso SSH come `hermes` a:
  - Stage: `192.168.178.180` (Podman LXC, `~/.tools/podman-compose-1.3.0/bin/podman-compose`, `~/ikuck-staging/`).
  - Produzione: `192.168.178.102` (checkout `iKuck-main-01558fe`, env `deploy/.env.standalone`).
- Caddy produzione: `192.168.178.177` serve `https://94z8ppoemd4qoscr.myfritz.net:30443` → `192.168.178.102:8080`.
- `APP_ORIGIN` `:30443` e `TRUST_PROXY` devono restare coerenti con l'IP del proxy.
- Se si tocca `GOOGLE_CLIENT_ID`, occorre ricreare il container API e ricostruire Caddy; l'origine esatta deve essere registrata come Authorized JavaScript origin in Google Cloud.

## Fasi

### Fase 1 — Bump versione

1. Leggere la versione attuale da `frontend/package.json`.
2. Bumpare la versione (semver: patch/minor/major a seconda del contenuto).
3. Verificare che `VITE_BUILD_ID` sia presente e passato tramite i build arg di Caddy nei Compose standalone e produzione (convenzione di versioning PWA).
4. Aggiornare `deploy/.env.standalone.example` / `deploy/.env.example` solo se servono nuove variabili obbligatorie.

### Fase 2 — Commit

1. Verificare `git diff --check` e `git status --short`.
2. Commitare solo i file relativi al rilascio (nessun drive-by refactor).
3. Messaggio di convenzione: `chore(release): release v<versione>` oppure `feat(...): ...` se contiene funzionalità.
4. Non creare ancora tag (il tag viene creato dopo il merge della PR, per convenzione di release).

### Fase 3 — Test (gate di repository)

Eseguire, in quest'ordine:

1. `npm --prefix frontend run lint` — eslint, 0 warning.
2. `npm --prefix frontend test -- --run` — vitest frontend.
3. `npm --prefix frontend run build` — `tsc && vite build` (esposizione `/version.json`, Workbox precache).
4. `npm --prefix backend run lint` — eslint backend.
5. `npm --prefix backend test` — vitest backend.
6. `npm --prefix backend run build` — `tsc -p tsconfig.json`.

Se un passo fallisce: fermarsi, correggere, ricommettere e rientrare dalla Fase 3.

### Fase 4 — Push e PR

1. Creare un branch di release isolato (es. `release/v<versione>`).
2. Push su `origin`.
3. Aprire una PR verso `main` su GitHub.
4. Descrivere nelle note della PR cosa cambia e come è stato verificato.

### Fase 5 — Controllo CI su PR

1. Verificare che la pipeline CI su GitHub passi per la PR (tutti i workflow: lint, test, build frontend e backend).
2. Richiedere la code review se previsto dal flusso di squadra.
3. **Se la CI fallisce:** analizzare l'errore, creare il fix nel branch di release, ricommettere (rientro Fase 2), spingere l'aggiornamento della PR e rieseguire dalla Fase 5. Non procedere finché la CI non è verde.
4. Se ci sono richieste di modifica dalla review: applicarle, rientrare dalla Fase 2.

### Fase 6 — Deploy in stage e verifica stabilità

Solo se la Fase 5 (CI verde) è andata a buon fine.

1. Collegarsi in SSH come `hermes` a `192.168.178.180` (Podman LXC).
2. Sullo stage, portarsi nel checkout di iKuck e verificare di essere sul branch di release corretto.
3. Usare **podman** e **podman-compose** (non docker): `~/.tools/podman-compose-1.3.0/bin/podman-compose`.
4. Deploy con `deploy/docker-compose.standalone.yml` (simula la produzione) e un env file dedicato allo stage (`~/ikuck-staging/config/staging.env` o equivalente), mai l'env di produzione.
5. Usare un project name dedicato, porte e volumi unici per non collidere con altri ambienti.
6. Verificare:
   - Build immagini API e Caddy senza errori.
   - Container in esecuzione e healthcheck passanti.
   - Servizio raggiungibile (Caddy frontend :8081, API :3000).
   - `/version.json` espone la versione corretta.
   - Funzionalità oggetto del rilascio (es. categorizzazione ingredienti in dispensa) funziona come atteso.
7. Registrare come "stage verificato" solo se tutto è stabile.

### Fase 7 — Gestione problemi

Se emergono problemi in stage (o in produzione dopo il deploy):

1. Analizzare la causa radice (non il sintomo).
2. Creare il fix nel branch di release.
3. Recommitare, rientrare dalla Fase 3 (tutti i test) e dalla Fase 4 (nuova PR o aggiornamento della esistente).
4. Rieseguire Fase 5 (CI) e Fase 6 (stage) fino a stabilità.
5. Se la CI continua a fallire dopo più tentativi, bloccare e segnalare all'utente.

### Fase 8 — Deploy in produzione

Solo se la Fase 6 è andata a buon fine (stage verificato).

1. Effettuare backup di PostgreSQL prima di qualsiasi modifica a Compose (`deploy/backup-postgres.sh`).
2. Non usare mai `docker-compose down --volumes` su produzione.
3. Deploy su `192.168.178.102` con `docker-compose.standalone.yml` e `deploy/.env.standalone`.
4. Ricreare container API e ricostruire Caddy se sono cambiati `GOOGLE_CLIENT_ID`, `VITE_BUILD_ID` o variabili di build.
5. Verificare su `https://94z8ppoemd4qoscr.myfritz.net:30443`:
   - Servizio raggiungibile.
   - `/version.json` con versione e buildId corretti.
   - Funzionalità del rilascio operativa.
6. Creare il tag sulla release (es. `v<versione>`) dopo il merge e il deploy produzione.
7. Non fare push o tag automatici senza richiesta esplicita.

## Regole di sicurezza

- Non committare mai segreti (`.env`, credenziali, token).
- Non leggere né stampare file di credenziali.
- Non rimuovere volumi di produzione come passo di debug.
- Se una fase blocca, segnalare all'utente invece di forzare.
