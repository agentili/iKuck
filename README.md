# iKuck

iKuck suggerisce ricette semplici usando gli ingredienti presenti in dispensa. Puoi usarlo come ospite, senza account e anche offline: la dispensa resta sul dispositivo. Se registri un account, verifichi l’email e accedi, puoi importare esplicitamente la dispensa e sincronizzarla tra i tuoi dispositivi.

## Come funziona

1. Inserisci gli alimenti presenti, separandoli con una virgola o premendo Invio.
2. Conferma gli ingredienti base che tieni normalmente in casa.
3. Richiedi fino a sei proposte dal catalogo incluso di 20 ricette.
4. Se vuoi, includi anche ricette per cui manca un solo ingrediente facile da reperire.
5. Apri la lista della spesa per aggiungere elementi manualmente o i mancanti di una ricetta.

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

I test end-to-end avviano la build di produzione e verificano il percorso principale con Chromium in formato mobile e desktop, compreso il funzionamento offline e il percorso account. I test d’integrazione API richiedono invece servizi dedicati configurati con `INTEGRATION_DATABASE_URL` e `INTEGRATION_REDIS_URL`; senza queste variabili vengono saltati intenzionalmente.

## Operazioni VPS

La configurazione di produzione è in `deploy/docker-compose.production.yml` e usa Caddy per HTTPS, frontend statico e proxy esclusivamente verso `/v1/*`.

Per una prova standalone su un mini PC Linux nella rete locale, usa la guida [deploy standalone su mini PC](docs/standalone-mini-pc.md) e la composizione `deploy/docker-compose.standalone.yml`. L’accesso avviene via HTTP su `http://IP_DEL_MINI_PC:8080`, senza esporre direttamente API, PostgreSQL o Redis.

1. Copia `deploy/.env.example` in un file `.env` nella directory `deploy` sul VPS e sostituisci tutti i valori di esempio con segreti univoci.
2. Avvia la piattaforma da `deploy` con `docker compose -f docker-compose.production.yml up -d --build`.
3. Le migrazioni vengono eseguite dall’API prima dell’avvio del server. Per eseguirle manualmente: `docker compose -f docker-compose.production.yml exec api node dist/db/migrate.js`.

Per creare un backup PostgreSQL in formato compresso, imposta `COMPOSE_FILE`, `POSTGRES_DB`, `POSTGRES_USER` e `BACKUP_DIR`, poi esegui `sh deploy/backup-postgres.sh`. Per ripristinare un archivio, imposta anche `ARCHIVE_PATH` ed esegui `sh deploy/restore-postgres.sh`. Il ripristino è distruttivo: usa `pg_restore --clean --if-exists` e deve essere eseguito solo con un archivio verificato.

Le chiavi di provider esterni e i segreti di sessione non devono mai essere inseriti nel frontend, nei file committati o nei log.

## Dati

La dispensa ospite è salvata in IndexedDB nel database locale `ikuck-local-v2`; le versioni precedenti con le chiavi `ikuck-pantry-v1` o `iricetto-pantry-v1` vengono migrate automaticamente. Le modifiche dell’ospite possono restare in una coda locale, ma non vengono mai inviate senza un account verificato. L’importazione verso un account è sempre un’azione esplicita dalla pagina Profilo. Password, cookie di sessione e token non vengono salvati nel browser. Disinstallare l’app o cancellare i dati del sito elimina la dispensa locale.

Ogni ingrediente può avere più lotti. Per ogni lotto puoi indicare opzionalmente quantità, unità (`g`, `kg`, `ml`, `l`, `piece` o `pack`) e data di scadenza; se lasci vuota la quantità, il lotto significa semplicemente “presente”. Le unità compatibili vengono aggregate nella dispensa, mentre quantità non confrontabili restano separate. Le ricette continuano a basarsi sulla presenza dell’ingrediente: quando la quantità nota potrebbe non bastare viene mostrato solo un avviso, senza escludere la ricetta. Le scadenze sono mostrate nell’app e non generano notifiche esterne.

La lista della spesa è salvata nello stesso database locale, funziona anche senza rete e distingue gli elementi da acquistare da quelli già acquistati. Puoi inserire un alimento o un prodotto libero, aggiungere quantità, unità e una nota, oppure usare il pulsante della pagina ricetta per inserire solo gli ingredienti non presenti. L’aggiunta è sempre esplicita e non consuma automaticamente la dispensa.
