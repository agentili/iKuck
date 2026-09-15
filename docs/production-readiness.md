# Production readiness di iKuck

Questa guida è il runbook operativo per il deployment pubblico di iKuck. La composizione production usa Caddy per HTTPS, l'API Fastify, PostgreSQL e Redis su una rete Docker privata. Non inserire mai password, chiavi provider, token, backup o dati reali in Git.

## Contratto delle variabili

Copia `deploy/.env.example` in `deploy/.env` sul VPS e sostituisci tutti i placeholder.

| Variabile | Obbligatoria | Regola |
| --- | --- | --- |
| `APP_DOMAIN` | sì | hostname pubblico reale, senza `https://`, porta o path |
| `POSTGRES_DB` | sì | nome database |
| `POSTGRES_USER` | sì | utente database |
| `POSTGRES_PASSWORD` | sì | password nuova, senza caratteri riservati da URL (`@`, `:`, `/`, `?`, `#`) |
| `GOOGLE_CLIENT_ID` | no | client ID Web per Google Identity Services |
| `RESEND_API_KEY` | no | abilita l'invio email solo insieme a un mittente |
| `RESEND_FROM_EMAIL` | no | mittente verificato Resend; `RESEND_FROM` resta accettato per compatibilità |
| `USDA_API_KEY` | no | abilita l'arricchimento nutrizionale USDA |
| `OPENAI_API_KEY` | no | abilita le ricette AI private |
| `OPENAI_MODEL` | no | modello OpenAI, default `gpt-5.5` |

In assenza delle variabili provider, il provider corrispondente resta disabilitato e l'app deve continuare a funzionare per gli ospiti. Non inserire normalmente `DATABASE_URL` o `REDIS_URL` nell'env production: Compose li costruisce con gli host privati `postgres` e `redis`. Se vengono presenti in un file operativo, il validator accetta solo quegli host.

## Validazione prima del deploy

Da PowerShell nella root del repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-production-config.ps1 -EnvFile deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml config
```

Il validator rifiuta valori mancanti o placeholder, domini non validi, password non sicure per la URL PostgreSQL, chiavi provider presenti nei file `.example` e URL database/Redis esterni alla rete privata Compose.

## Header browser e CSP

Caddy applica `Content-Security-Policy` senza `unsafe-eval`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` e HSTS solo quando la richiesta usa HTTPS. La CSP consente esclusivamente l'origine dell'app, gli asset inline necessari al rendering corrente e Google Identity Services quando il client Google è configurato. Verifica lo stack avviato con:

```powershell
powershell -ExecutionPolicy Bypass -File deploy/security-headers.test.ps1 -BaseUrl https://app.example.test
```

Su standalone HTTP il test deve confermare che HSTS è assente; la validazione production HTTPS deve invece confermare la presenza di HSTS. Se login Google, PWA o asset vengono modificati, aggiorna la CSP e ripeti il test prima del deploy.

## Staging e produzione

Prima del deployment servono:

- VPS nell'UE con Docker Engine e Compose plugin;
- utente di deployment non root, aggiornamenti di sicurezza e sincronizzazione dell'orologio;
- DNS del dominio verso il VPS;
- firewall con SSH limitato alla rete operatore e solo TCP 80/443 pubblici;
- PostgreSQL, Redis e API non pubblicati sulla rete internet;
- volume persistente per PostgreSQL, Redis e certificati Caddy.

Il deployment production è:

```powershell
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml build --pull
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml up -d
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml logs --tail=200 api caddy
```

Le migrazioni vengono eseguite dall'API prima dell'avvio del server. Se l'API non diventa healthy, controlla prima i log dell'API e lo stato health di PostgreSQL e Redis; non cancellare i volumi come tentativo di diagnosi.

Il cookie di sessione non ha `Max-Age` per scelta: resta valido solo fino alla chiusura del browser, mentre il record server-side ha comunque una scadenza massima di 30 giorni. La pulizia dei record scaduti è idempotente e va eseguita con frequenza settimanale, dopo un backup:

```powershell
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml exec -e DRY_RUN=true api node dist/db/cleanupExpiredAuth.js
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml exec api node dist/db/cleanupExpiredAuth.js
```

Usa prima `DRY_RUN=true` per registrare i conteggi, poi esegui la cancellazione reale. Il dry-run non modifica il database; la cancellazione non è reversibile senza il backup precedente.

## Backup, ripristino e rollback

Esegui un backup prima di migrazioni, modifiche ai provider o operazioni distruttive. Il percorso del backup deve essere fuori dal repository:

```bash
COMPOSE_FILE=deploy/docker-compose.production.yml \
  BACKUP_DIR=/var/backups/ikuck \
  sh deploy/backup-postgres.sh
```

`backup-postgres.sh` scrive il dump in un file temporaneo nella stessa directory, verifica che non sia vuoto, esegue `pg_restore --list`, crea il file `.sha256` e pubblica archivio e checksum solo dopo la verifica. Applica la retention solo dopo un backup valido; imposta `BACKUP_RETENTION_COUNT` a un valore esplicito maggiore di zero. Verifica checksum e contenuto dell'archivio con gli strumenti PostgreSQL prima di considerarlo valido. Per un ripristino usa solo un archivio verificato e una destinazione isolata; il ripristino production è distruttivo e richiede una copia di sicurezza aggiuntiva:

```bash
COMPOSE_FILE=deploy/docker-compose.production.yml \
  ARCHIVE_PATH=/var/backups/ikuck/ikuck-YYYYMMDDTHHMMSSZ.dump \
  sh deploy/restore-postgres.sh
```

Per il rollback applicativo, conserva il riferimento all'immagine o al commit precedente, esegui un backup, riporta il repository alla release nota e ricostruisci i servizi. Non eseguire downgrade dello schema senza una procedura di migrazione reversibile verificata.

## Provider e smoke test

Gli smoke test reali di Resend, USDA e OpenAI sono opt-in e non fanno parte di `npm test`. Devono usare un account, un indirizzo email e dati ricetta usa-e-getta. Non salvare nei report chiavi, token, link di verifica/reset, prompt o contenuti di ricette private.

Questa guida documenta il contratto e il deployment; il runner degli smoke test e la verifica contro servizi PostgreSQL/Redis usa-e-getta restano attività successive del piano production readiness.

## Verifica browser production

Il profilo locale resta quello predefinito di `npm --prefix frontend run test:e2e`. Per un target remoto usare esclusivamente un URL HTTPS e selezionare il profilo production:

```powershell
$env:E2E_BASE_URL = 'https://app.example.test'
$env:E2E_PRODUCTION = 'true'
npm --prefix frontend run test:e2e:production
```

Il profilo remoto non avvia il server Vite locale. Senza `E2E_BASE_URL` e `E2E_PRODUCTION=true` i test production vengono saltati con un messaggio esplicito; non inserire mai credenziali nei file di configurazione. Per il controllo facoltativo dell'account verificato usa soltanto un account usa-e-getta tramite `E2E_TEST_EMAIL` e `E2E_TEST_PASSWORD`.

## Verifica PostgreSQL e Redis

I test di integrazione usano solo servizi usa-e-getta indicati da `INTEGRATION_DATABASE_URL` e `INTEGRATION_REDIS_URL`. Senza entrambe le variabili restano saltati e non toccano il database locale o production:

```powershell
$env:COMPOSE_PROJECT_NAME = 'ikuck-integration'
docker compose -f deploy/docker-compose.integration.yml up -d
$env:INTEGRATION_DATABASE_URL = 'postgres://integration:integration@127.0.0.1:55432/ikuck_integration'
$env:INTEGRATION_REDIS_URL = 'redis://127.0.0.1:56379'
npm --prefix backend run test:integration
docker compose -p ikuck-integration -f deploy/docker-compose.integration.yml down -v
```

La suite verifica migrazioni ripetibili, cookie di sessione, blocco prima della verifica email, sincronizzazione last-write-wins, rollback della transazione e reset della quota Redis al cambio di giorno UTC. Avviare e rimuovere i container con un nome di progetto dedicato e non riutilizzare mai le URL production.

## Stato e criteri di rilascio

Una release pubblica non è pronta finché non sono verificati DNS, HTTPS, health API, migrazioni, persistenza dopo riavvio, backup e ripristino, sincronizzazione account, fallback dei provider disabilitati e smoke test dei provider esplicitamente abilitati. I risultati devono riportare commit/tag, timestamp UTC, digest immagini, checksum backup e motivi degli eventuali test saltati, senza dati sensibili.

## Evidenze verificate localmente

| Data | Commit/tag | Comando o ambiente | Risultato |
|---|---|---|---|
| 2026-09-15 | `64c7b2d` + `19167df` | `npm --prefix frontend run lint`, `npm --prefix frontend test -- --run`, `npm --prefix frontend run test:coverage`, `npm --prefix frontend run build`, `npm --prefix frontend run test:e2e` | Verificati: lint, 253 test unitari, coverage, build PWA, 40 test E2E passati e 2 skip production attesi. |
| 2026-09-15 | `19167df` | `npm --prefix backend run lint`, `npm --prefix backend test -- --run`, `npm --prefix backend run test:coverage`, `npm --prefix backend run build` | Verificati: lint, 127 test passati e 7 skip espliciti, coverage e build. |
| 2026-09-15 | `b05fb4a` + `a770487` | `npm run verify` dalla root | Verificato: orchestratore root completato con exit code 0; CI ispezionata staticamente, non eseguita da questo host. |
| 2026-09-15 | `64c7b2d` + `19167df` | `npm audit --omit=dev --json` in frontend e backend | Verificato: audit runtime senza vulnerabilità; l'audit completo backend conserva 4 advisory moderate dev-only nella toolchain Drizzle Kit e non è stato forzato. |

## Evidenze verificate su stack disposable

| Data | Commit/tag | Comando o ambiente | Risultato |
|---|---|---|---|
| 2026-09-15 | `plan-5-complete` (`8395a3c`) | Docker Compose standalone sulla LAN, `http://192.168.178.21:8080/` | Verificati: Caddy, API, PostgreSQL e Redis healthy; homepage e `/v1/auth/session` raggiungibili. Questa è evidenza del checkpoint precedente; il deploy del piano 6 viene ripetuto dopo il tag del piano. |
| 2026-09-15 | — | PostgreSQL/Redis integration senza URL usa-e-getta | Non verificato in questo checkpoint; senza `INTEGRATION_DATABASE_URL` e `INTEGRATION_REDIS_URL` i test restano intenzionalmente non verificati, mai “passed”. |

## Evidenze verificate in produzione

| Data | Commit/tag | Comando o ambiente | Risultato |
|---|---|---|---|
| 2026-09-15 | — | VPS autenticato, dominio HTTPS reale, DNS, provider smoke test | Non verificato: nessun accesso production, credenziale, dominio o provider reale è stato usato. |
