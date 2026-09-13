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
| `SESSION_SECRET` | sì | almeno 32 caratteri casuali e unici |
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

Il validator rifiuta valori mancanti o placeholder, domini non validi, segreti di sessione corti, password non sicure per la URL PostgreSQL, chiavi provider presenti nei file `.example` e URL database/Redis esterni alla rete privata Compose.

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

## Backup, ripristino e rollback

Esegui un backup prima di migrazioni, modifiche ai provider o operazioni distruttive. Il percorso del backup deve essere fuori dal repository:

```bash
COMPOSE_FILE=deploy/docker-compose.production.yml \
  BACKUP_DIR=/var/backups/ikuck \
  sh deploy/backup-postgres.sh
```

Verifica checksum e contenuto dell'archivio con gli strumenti PostgreSQL prima di considerarlo valido. Per un ripristino usa solo un archivio verificato e una destinazione isolata; il ripristino production è distruttivo e richiede una copia di sicurezza aggiuntiva:

```bash
COMPOSE_FILE=deploy/docker-compose.production.yml \
  ARCHIVE_PATH=/var/backups/ikuck/ikuck-YYYYMMDDTHHMMSSZ.dump \
  sh deploy/restore-postgres.sh
```

Per il rollback applicativo, conserva il riferimento all'immagine o al commit precedente, esegui un backup, riporta il repository alla release nota e ricostruisci i servizi. Non eseguire downgrade dello schema senza una procedura di migrazione reversibile verificata.

## Provider e smoke test

Gli smoke test reali di Resend, USDA e OpenAI sono opt-in e non fanno parte di `npm test`. Devono usare un account, un indirizzo email e dati ricetta usa-e-getta. Non salvare nei report chiavi, token, link di verifica/reset, prompt o contenuti di ricette private.

Questa guida documenta il contratto e il deployment; il runner degli smoke test e la verifica contro servizi PostgreSQL/Redis usa-e-getta restano attività successive del piano production readiness.

## Stato e criteri di rilascio

Una release pubblica non è pronta finché non sono verificati DNS, HTTPS, health API, migrazioni, persistenza dopo riavvio, backup e ripristino, sincronizzazione account, fallback dei provider disabilitati e smoke test dei provider esplicitamente abilitati. I risultati devono riportare commit/tag, timestamp UTC, digest immagini, checksum backup e motivi degli eventuali test saltati, senza dati sensibili.
