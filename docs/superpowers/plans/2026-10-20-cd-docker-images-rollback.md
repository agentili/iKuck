# Piano: CD con immagini Docker e rollback via immagine (iKuck)

> **Stato:** da eseguire (prossimo progetto).  
> **Obiettivo:** costruire e pubblicare immagini Docker versioneate da GitHub Actions, deployarle su staging e produzione, e consentire rollback rapido ripristinando un'immagine precedente nota.  
> **Ambienti target:** staging LAN (`192.168.178.180`) e produzione LAN (`192.168.178.102`), entrambi già descritti in `docs/standalone-mini-pc.md` e `docs/production-readiness.md`.

---

## 1. Stato attuale (già presente)

| Elemento | Path | Note |
|---|---|---|
| CI esistente | `.github/workflows/ci.yml` | Lint, test, build, E2E offline, integration su servizi disposable |
| Deploy workflow (bozza) | `.github/workflows/deploy.yml` | `workflow_dispatch` staging/produzione, SSH remoto, smoke test dipendente |
| Smoke test | `scripts/smoke-test.sh` | Verifica homepage, `/v1/auth/session`, CSP senza `unsafe-eval` |
| Dockerfile API | `backend/Dockerfile` | Multi-stage build, utente `ikuck`, immagine base pinnata a digest |
| Dockerfile Caddy | `deploy/Caddy.Dockerfile` | Build frontend + immagine Caddy, arg `VITE_BUILD_ID` |
| Compose standalone | `deploy/docker-compose.standalone.yml` | API, Postgres, Redis, Caddy; immagini terze pinnate a digest |
| Compose production | `deploy/docker-compose.production.yml` | Stessa struttura, porte 80/443, `APP_DOMAIN` obbligatorio |
| Validazione env | `scripts/validate-production-config.ps1` | Rifiuta placeholder, domini non validi, password con caratteri URL-reserved |
| Backup/restore | `deploy/backup-postgres.sh`, `deploy/restore-postgres.sh` | Atomici, preflight, `--dry-run`, transazione singola |

**Gap da colmare:** nessuna pubblicazione automatica di immagini, nessun tag immutabile, nessun rollback via immagine, deploy ancora ricostruito da source sull'host target.

---

## 2. Strategia immagini

### 2.1 Registry
Usare **GitHub Container Registry (GHCR)** (`ghcr.io/<owner>/ikuck-<servizio>`).
- Vantaggio: autenticazione nativa con `GITHUB_TOKEN` nei workflow, nessun segreto aggiuntivo per il push.
- Alternativa accettabile: Docker Hub (richiede `DOCKERHUB_USERNAME` e `DOCKERHUB_TOKEN` come segreti).

### 2.2 Immagini da pubblicare
- `ikuck-api` (da `backend/Dockerfile`)
- `ikuck-caddy` (da `deploy/Caddy.Dockerfile`, include frontend buildato)

Postgres, Redis e Node base restano immagini terze pinnate a digest già nei compose (non si pubblicano).

### 2.3 Convention di tag
Ogni build pubblica **tre tag**:

| Tag | Significato | Uso |
|---|---|---|
| `ghcr.io/<owner>/ikuck-api:sha-<COMMIT_SHA>` | Immagine legata al commit esatto | Deploy e rollback deterministici |
| `ghcr.io/<owner>/ikuck-api:sha-<COMMIT_SHA>-digest` | Digest SHA-256 dell'immagine pubblicata | Riferimento immutabile nei compose override |
| `ghcr.io/<owner>/ikuck-api:latest-staging` / `:latest-production` | Puntatore mobile all'ultima immagine deployata in quell'ambiente | Facilita rollback con `docker compose pull` |

### 2.4 Digest
Dopo ogni push, estrarre il digest con `docker buildx imagetools inspect` o `skopeo` e salvarlo come artifact del workflow (file `.digest`). Questo consente di sapere esattamente cosa è girato in ogni ambiente.

---

## 3. Pipeline CD (GitHub Actions)

### 3.1 Workflow: `.github/workflows/cd.yml`

Trigger: `workflow_dispatch` con input `environment` (`staging`/`production`) e `ref` (branch/tag/SHA), oppure `push` su tag `v*`.

Job 1: `build-and-push`
- Checkout del `ref`
- Login a GHCR con `GITHUB_TOKEN`
- Buildx build-and-push di `ikuck-api` e `ikuck-caddy`
- Tag: `sha-<sha>`, `latest-<environment>`
- Esporta digest in artifact `image-digests-<environment>.txt`

Job 2: `deploy-staging` (dipende da `build-and-push`)
- Environment: `staging` (nessun reviewer richiesto)
- Scrive `deploy/.env.standalone` da segreto `STAGING_ENV_FILE`
- Crea `deploy/docker-compose.override.yml` con immagini a digest (o `latest-staging`)
- SSH sull'host staging (o runner self-hosted in LAN)
- `docker compose -f standalone.yml -f override.yml up -d`
- Esegue `scripts/smoke-test.sh` contro `STAGING_BASE_URL`

Job 3: `deploy-production` (dipende da `deploy-staging` riuscito)
- Environment: `production` con **required reviewers** (approvazione manuale)
- Scrive `deploy/.env` da segreto `PRODUCTION_ENV_FILE`
- Valida con `scripts/validate-production-config.ps1`
- Crea override con immagini a digest (o `latest-production`)
- SSH sull'host produzione
- `docker compose -f production.yml -f override.yml up -d`
- Esegue `scripts/smoke-test.sh` contro `PRODUCTION_BASE_URL`

### 3.2 File override immagine
Esempio `deploy/docker-compose.override.images.yml`:

```yaml
services:
  api:
    image: ghcr.io/<owner>/ikuck-api:sha-<COMMIT_SHA>@sha256:<DIGEST>
  caddy:
    image: ghcr.io/<owner>/ikuck-caddy:sha-<COMMIT_SHA>@sha256:<DIGEST>
```

Questo file viene generato dal workflow e copiato sull'host prima del `docker compose up`.

---

## 4. Rollback via immagine

### 4.1 Principio
Il rollback non ricostruisce da source, ma punta i servizi a un'immagine già pubblicata e nota come buona (es. `sha-<COMMIT_SHA_PRECEDENTE>`), poi fa `docker compose up -d` per ricreare i container con quell'immagine.

### 4.2 Cosa conservare
- Gli ultimi N tag `sha-<sha>` per `ikuck-api` e `ikuck-caddy` (suggerito: 10).
- I digest corrispondenti salvati come artifact dei workflow di deploy.
- Il mapping ambiente → tag attivo (può essere un file `deploy/last-deployed-<environment>.json` committato o un artifact).

### 4.3 Procedura di rollback (manuale o workflow `rollback.yml`)
1. Identificare l'immagine precedente nota buona (da artifact o da tag `latest-<environment>` prima del deploy fallito).
2. Generare override con quell'immagine e digest.
3. Eseguire `docker compose -f <env>.yml -f override.yml up -d` sull'host target.
4. Eseguire smoke test.
5. Se fallito, ripetere con l'immagine precedente ancora più vecchia.

Non si toca il database; se servisse rollback di schema, usare `restore-postgres.sh` da backup pre-deploy (già esistente).

---

## 5. Segreti e variabili GitHub necessari

| Segreto | Descrizione |
|---|---|
| `GHCR_TOKEN` (opzionale, se non si usa `GITHUB_TOKEN`) | Token con pacchetti:write per GHCR |
| `STAGING_ENV_FILE` | Contenuto intero di `deploy/.env.standalone` |
| `PRODUCTION_ENV_FILE` | Contenuto intero di `deploy/.env` |
| `SSH_STAGING_HOST` / `SSH_STAGING_USER` / `SSH_STAGING_KEY` | Host, utente e chiave privata per staging |
| `SSH_PRODUCTION_HOST` / `SSH_PRODUCTION_USER` / `SSH_PRODUCTION_KEY` | Host, utente e chiave privata per produzione |
| `STAGING_BASE_URL` | URL per smoke test staging |
| `PRODUCTION_BASE_URL` | URL per smoke test produzione |

Variabili (non segreti):
- `REGISTRY_OWNER`: owner di GHCR (es. username o organization)

---

## 6. File da creare / modificare

### Da creare
- `.github/workflows/cd.yml` — pipeline build-push-deploy con rollback opzionale
- `.github/workflows/rollback.yml` — deploy di un'immagine precedente nota
- `scripts/generate-image-override.sh` — genera `docker-compose.override.images.yml` da digest
- `scripts/tag-previous-image.sh` — utility per identificare tag precedente da rollback

### Da modificare
- `.github/workflows/deploy.yml` — togliere build da source sull'host, usare immagini da GHCR
- `deploy/docker-compose.standalone.yml` — rimuovere `build:` da api/caddy, usare `image:` (override gestito da CD)
- `deploy/docker-compose.production.yml` — stesso cambiamento
- `docs/superpowers/plans/2026-10-20-cicd-github-actions.md` — collegare a questo piano come esecuzione CD

---

## 7. Passi di attuazione (fasi)

### Fase 1: Preparazione registry e segreti
1. Verificare che GHCR sia abilitato per l'owner del repository.
2. Aggiungere i segreti GitHub elencati al §5.
3. Creare l'ambiente GitHub `production` con required reviewer (se non esiste).

### Fase 2: Pipeline build-and-push
1. Creare `.github/workflows/cd.yml`.
2. Testare con `workflow_dispatch` su staging senza deploy (solo build e push, verifica digest).
3. Verificare che le immagini appaiano in GHCR con i tag attesi.

### Fase 3: Deploy da immagine su staging
1. Modificare `deploy.yml` per usare immagini GHCR invece di `build:` dall'host.
2. Aggiungere generazione override immagini e `docker compose up -d`.
3. Eseguire deploy su staging e smoke test.
4. Verificare che `latest-staging` punti all'immagine corretta.

### Fase 4: Deploy su produzione con approvazione
1. Configurare environment `production` con reviewer.
2. Eseguire deploy su produzione tramite approvazione manuale.
3. Verificare smoke test produzione.

### Fase 5: Rollback
1. Creare `.github/workflows/rollback.yml`.
2. Eseguire una prova di rollback su ambiente disposable o staging: deploy immagine A, deploy immagine B (rompente), rollback ad A, smoke test verde.
3. Documentare i comandi esatti in `docs/production-readiness.md` o in un nuovo ADR.

### Fase 6: Pulizia e hardening
1. Rimuovere `build:` dai compose di produzione/standalone (le immagini vengono solo pescate da GHCR).
2. Impostare retention immagini GHCR (es. ultima 10 versione `sha-*`).
3. Aggiungere controllo digest nell'override per evitare drift.

---

## 8. Criteri di successo

- Ogni push/tag produce immagini `ikuck-api` e `ikuck-caddy` su GHCR con tag `sha-<commit>` e digest verificabile.
- Deploy su staging e produzione avviene senza ricostruire da source sull'host remoto (solo `docker compose pull` + `up -d`).
- Smoke test verde dopo ogni deploy su entrambi gli ambienti.
- Rollback a immagine precedente eseguibile in meno di 5 minuti e verificato con smoke test.
- Nessun segreto o immagine con dati sensibili committato in Git.

---

## 9. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Drift tra tag `latest-staging` e immagine effettivamente deployata | Usare digest espliciti nell'override, non solo tag mobile |
| Immagine precedente rimossa da GHCR per retention | Mantenere almeno 10 versioni `sha-*`; non usare `:latest` come unico riferimento |
| Deploy fallito a metà su produzione | `docker compose up -d` è atomico per servizio; se fallisce, rollback immediato all'immagine precedente |
| Segreti env file esposti nei log | I segreti GitHub sono mascherati; non stampare mai il contenuto di `.env` |

---

## Collegamenti
- Piano CI/CD base: `docs/superpowers/plans/2026-10-20-cicd-github-actions.md`
- Runbook produzione: `docs/production-readiness.md`
- Deploy manuale attuale: `docs/standalone-mini-pc.md`
