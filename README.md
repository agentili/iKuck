# iKuck

iKuck suggerisce ricette semplici usando gli ingredienti presenti in dispensa. Puoi usarlo come ospite, senza account e anche offline: la dispensa resta sul dispositivo. Se registri un account, verifichi l’email e accedi, puoi importare esplicitamente la dispensa e sincronizzarla tra i tuoi dispositivi.

## Come funziona

1. Inserisci gli alimenti presenti, separandoli con una virgola o premendo Invio.
2. Conferma gli ingredienti base che tieni normalmente in casa.
3. Richiedi fino a sei proposte dal catalogo incluso di 20 ricette.
4. Se vuoi, includi anche ricette per cui manca un solo ingrediente facile da reperire.
5. Dopo la prima ricerca, le modifiche alla dispensa e alle preferenze aggiornano automaticamente le proposte locali; `Altre idee` cambia la varietà senza una nuova richiesta.
6. Apri la lista della spesa per aggiungere elementi manualmente o i mancanti di una ricetta.
7. Dalla ricetta puoi segnare la preparazione, salvarla tra i preferiti, assegnare da 1 a 5 stelle e aggiungere una nota privata.
8. Se hai un account verificato, puoi attivare il consenso e chiedere una ricetta AI privata usando la dispensa e i filtri alimentari correnti.

Il catalogo copre carne, pesce, uova, legumi e verdure. Ogni proposta indica chiaramente se è già realizzabile o quale unico ingrediente manca.

## Avvio locale

```bash
cd frontend
npm install
npm run dev
```

### Backend e servizi locali

Per sviluppare la sola API, con PostgreSQL e Redis disponibili sulla macchina:

```bash
cd backend
npm install
npm run dev
```

In sviluppo locale `NODE_ENV=development` verifica automaticamente i nuovi account, così il login email/password funziona anche senza configurare un provider email o un dominio. In produzione la verifica email resta obbligatoria e richiede `RESEND_API_KEY` e `RESEND_FROM`.

Il frontend inoltra automaticamente le richieste `/v1/*` al backend locale su `http://127.0.0.1:3000`; apri quindi l'app all'origine mostrata da Vite, normalmente `http://localhost:5173`.

Per avviare la piattaforma completa in container, incluse le migrazioni iniziali:

```bash
docker compose -f compose.dev.yml up --build
```

### Accesso con Google

Il login Google usa Google Identity Services solo per autenticare l'utente; la sessione iKuck resta un cookie HttpOnly gestito dal backend. Il backend verifica l'ID token Google e non salva token Google o credenziali nel browser.

Per abilitarlo in locale:

1. Crea un OAuth Client ID di tipo Web application in Google Cloud.
2. Aggiungi `http://localhost:5173` e l'origine usata dall'app tra le origini JavaScript autorizzate.
3. Copia il client ID in `backend/.env` come `GOOGLE_CLIENT_ID` e in `frontend/.env` come `VITE_GOOGLE_CLIENT_ID`.
4. Riavvia backend e frontend.

In produzione usa il client ID del progetto production, il dominio HTTPS reale e una homepage pubblica con privacy policy. Un account email/password già esistente può collegare Google dal profilo, usando lo stesso indirizzo email verificato.

L’API risponde a [http://127.0.0.1:3000/healthz](http://127.0.0.1:3000/healthz). PostgreSQL e Redis restano accessibili esclusivamente agli altri container.

## Verifica

```bash
cd frontend
npm test
npm run test:coverage
npm run lint
npm run build
npm run test:e2e
```

I test end-to-end avviano la build di produzione e verificano il percorso principale con Chromium in formato mobile e desktop, compreso il funzionamento offline e il percorso account. I test d’integrazione API richiedono invece servizi dedicati configurati con `INTEGRATION_DATABASE_URL` e `INTEGRATION_REDIS_URL`; senza queste variabili vengono saltati intenzionalmente.

## Operazioni VPS

La configurazione di produzione è in `deploy/docker-compose.production.yml` e usa Caddy per HTTPS, frontend statico e proxy esclusivamente verso `/v1/*`.

Il contratto delle variabili, la procedura di validazione, il deploy, il backup, il ripristino e il rollback sono raccolti nella guida [production readiness](docs/production-readiness.md). Prima di avviare una release esegui:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-production-config.ps1 -EnvFile deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml config
```

Le variabili `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `USDA_API_KEY` e `OPENAI_API_KEY` sono opzionali: ogni provider resta disabilitato finché non sono configurate le credenziali richieste. `GOOGLE_CLIENT_ID` è un identificativo pubblico ma deve comunque essere valorizzato solo nell'env locale del deployment o nel secret manager, mai insieme a chiavi provider o password nel repository.

Per una prova standalone su un mini PC Linux nella rete locale, usa la guida [deploy standalone su mini PC](docs/standalone-mini-pc.md) e la composizione `deploy/docker-compose.standalone.yml`. L’accesso avviene via HTTP su `http://IP_DEL_MINI_PC:8080`, senza esporre direttamente API, PostgreSQL o Redis.

1. Copia `deploy/.env.example` in un file `.env` nella directory `deploy` sul VPS e sostituisci tutti i valori di esempio con segreti univoci.
2. Avvia la piattaforma da `deploy` con `docker compose -f docker-compose.production.yml up -d --build`.
3. Le migrazioni vengono eseguite dall’API prima dell’avvio del server. Per eseguirle manualmente: `docker compose -f docker-compose.production.yml exec api node dist/db/migrate.js`.

Per creare un backup PostgreSQL in formato compresso, imposta `COMPOSE_FILE`, `POSTGRES_DB`, `POSTGRES_USER` e `BACKUP_DIR`, poi esegui `sh deploy/backup-postgres.sh`. Per ripristinare un archivio, imposta anche `ARCHIVE_PATH` ed esegui `sh deploy/restore-postgres.sh`. Il ripristino è distruttivo: usa `pg_restore --clean --if-exists` e deve essere eseguito solo con un archivio verificato.

Le chiavi dei provider esterni non devono mai essere inserite nel frontend, nei file committati o nei log.

Le sessioni usano un cookie volutamente non persistente: chiudere il browser richiede un nuovo accesso. Se il browser resta aperto, la sessione viene comunque rifiutata dal backend dopo la sua scadenza server-side.

## Dati

La dispensa ospite è salvata in IndexedDB nel database locale `ikuck-local-v2`; le versioni precedenti con le chiavi `ikuck-pantry-v1` o `iricetto-pantry-v1` vengono migrate automaticamente. Le modifiche dell’ospite possono restare in una coda locale, ma non vengono mai inviate senza un account verificato. L’importazione verso un account è sempre un’azione esplicita dalla pagina Profilo. Password, cookie di sessione e token non vengono salvati nel browser. Disinstallare l’app o cancellare i dati del sito elimina la dispensa locale.

Ogni ingrediente può avere più lotti. Per ogni lotto puoi indicare opzionalmente quantità, unità (`g`, `kg`, `ml`, `l`, `piece` o `pack`) e data di scadenza; se lasci vuota la quantità, il lotto significa semplicemente “presente”. Le unità compatibili vengono aggregate nella dispensa, mentre quantità non confrontabili restano separate. Le ricette continuano a basarsi sulla presenza dell’ingrediente: quando la quantità nota potrebbe non bastare viene mostrato solo un avviso, senza escludere la ricetta. Le scadenze sono mostrate nell’app e non generano notifiche esterne.

La lista della spesa è salvata nello stesso database locale, funziona anche senza rete e distingue gli elementi da acquistare da quelli già acquistati. Puoi inserire un alimento o un prodotto libero, aggiungere quantità, unità e una nota, oppure usare il pulsante della pagina ricetta per inserire solo gli ingredienti non presenti. L’aggiunta è sempre esplicita e non consuma automaticamente la dispensa.

La sezione Attività conserva la cronologia delle ricette segnate come cucinate, senza sottrarre ingredienti dalla dispensa. Preferiti, valutazioni da una a cinque stelle e note private sono salvati localmente per gli ospiti e inclusi nell’importazione esplicita per gli account verificati; non vengono pubblicati nel catalogo delle ricette.

Dopo la prima richiesta esplicita, le proposte del catalogo vengono ricalcolate direttamente nel browser quando cambiano dispensa, lotti, ingredienti di base, dieta, cronologia o preferenze. Il comportamento resta disponibile offline e non invia dati a un servizio esterno; `Altre idee` modifica solo l’ordine delle proposte compatibili.

Le ricette AI sono opzionali, richiedono un account con email verificata e un consenso esplicito salvato sul server. Sono limitate a cinque generazioni per giorno UTC, restano private dell’account e rispettano i filtri dieta/allergeni attivi; la revoca del consenso nasconde la generazione ma non elimina le ricette già salvate. Senza `OPENAI_API_KEY` il provider AI resta disabilitato. La chiave OpenAI resta esclusivamente nel backend e non viene mai salvata nel browser o nei log.

Gli smoke test reali di Resend, USDA e OpenAI non fanno parte della suite ordinaria: vengono eseguiti solo quando le rispettive chiavi sono fornite esplicitamente. I test PostgreSQL/Redis richiedono `INTEGRATION_DATABASE_URL` e `INTEGRATION_REDIS_URL`; senza queste variabili vengono saltati.
