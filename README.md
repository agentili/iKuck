# iKuck

iKuck suggerisce ricette semplici usando gli ingredienti presenti in dispensa. In questa prima fase continua a funzionare senza account, non richiede quantità e conserva i dati soltanto nel browser. Il backend è già predisposto per la futura sincronizzazione, ma non riceve dati dalla PWA finché non verrà completato il piano account e sync.

## Come funziona

1. Inserisci gli alimenti presenti, separandoli con una virgola o premendo Invio.
2. Conferma gli ingredienti base che tieni normalmente in casa.
3. Richiedi fino a sei proposte dal catalogo incluso di 20 ricette.
4. Se vuoi, includi anche ricette per cui manca un solo ingrediente facile da reperire.

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

Per avviare la piattaforma completa in container, incluse le migrazioni iniziali:

```bash
docker compose -f compose.dev.yml up --build
```

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

I test end-to-end avviano la build di produzione e verificano il percorso principale con Chromium in formato mobile e desktop, compreso il funzionamento offline.

## Operazioni VPS

La configurazione di produzione è in `deploy/docker-compose.production.yml` e usa Caddy per HTTPS, frontend statico e proxy esclusivamente verso `/v1/*`.

Per una prova standalone su un mini PC Linux nella rete locale, usa la guida [deploy standalone su mini PC](docs/standalone-mini-pc.md) e la composizione `deploy/docker-compose.standalone.yml`. L’accesso avviene via HTTP su `http://IP_DEL_MINI_PC:8080`, senza esporre direttamente API, PostgreSQL o Redis.

1. Copia `deploy/.env.example` in un file `.env` nella directory `deploy` sul VPS e sostituisci tutti i valori di esempio con segreti univoci.
2. Avvia la piattaforma da `deploy` con `docker compose -f docker-compose.production.yml up -d --build`.
3. Le migrazioni vengono eseguite dall’API prima dell’avvio del server. Per eseguirle manualmente: `docker compose -f docker-compose.production.yml exec api node dist/db/migrate.js`.

Per creare un backup PostgreSQL in formato compresso, imposta `COMPOSE_FILE`, `POSTGRES_DB`, `POSTGRES_USER` e `BACKUP_DIR`, poi esegui `sh deploy/backup-postgres.sh`. Per ripristinare un archivio, imposta anche `ARCHIVE_PATH` ed esegui `sh deploy/restore-postgres.sh`. Il ripristino è distruttivo: usa `pg_restore --clean --if-exists` e deve essere eseguito solo con un archivio verificato.

Le chiavi di provider esterni e i segreti di sessione non devono mai essere inseriti nel frontend, nei file committati o nei log.

## Dati

La dispensa è salvata in `localStorage` con la chiave `ikuck-pantry-v1`. Le dispense salvate nelle versioni precedenti con la chiave `iricetto-pantry-v1` vengono migrate automaticamente. Disinstallare l'app o cancellare i dati del sito elimina la dispensa. Nessun dato viene inviato a un server.
