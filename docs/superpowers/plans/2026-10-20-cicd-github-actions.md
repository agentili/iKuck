# Piano: CI/CD da GitHub Actions per deploy iKuck (staging → produzione)

> **Stato:** da eseguire (prossimo progetto).  
> **Contesto:** repository iKuck, deploy attuale manuale via `docker compose` su host LAN (staging `192.168.178.180`, produzione `192.168.178.102`).  
> **Obiettivo:** deploy attivato da GitHub Actions con smoke test intermedi tra staging e produzione, approvazione manuale su produzione, e base per rollback e zero-downtime futuri.

---

## 1. Stato attuale (già presente)

| Elemento | Path | Note |
|---|---|---|
| CI esistente | `.github/workflows/ci.yml` | Frontend + backend: lint, test, build, E2E offline, integration su servizi disposable |
| Gate di verifica | `scripts/verify-repository.ps1` | Eseguito localmente e richiamabile da CI |
| Smoke test | `scripts/smoke-test.sh` | Controlla homepage, `/v1/auth/session`, CSP senza `unsafe-eval` |
| Workflow deploy (bozza) | `.github/workflows/deploy.yml` | `workflow_dispatch` su `staging` / `production`, SSH su host remoto, dipendenza `smoke-test` → `deploy` |
| Validazione env | `scripts/validate-production-config.ps1` | Rifiuta placeholder, domini non validi, password con caratteri riservati, URL DB esterni |
| Backup/restore | `deploy/backup-postgres.sh`, `deploy/restore-postgres.sh` | Atomici, verificati, con preflight e `--dry-run` |
| Runbook produzione | `docs/production-readiness.md` | Contratto env, procedure, evidenze |

---

## 2. Cosa manca per attivare la CI/CD

1. **Runner in grado di raggiungere la LAN**
   - I runner hosted di GitHub non vedono `192.168.x.x`.
   - Opzioni: self-hosted runner su macchina LAN (consigliato) oppure runner hosted + tunnel VPN (Tailscale/WireGuard).

2. **Segreti GitHub da configurare** (Settings → Secrets and variables → Actions)
   - `SSH_STAGING_HOST`, `SSH_STAGING_USER`, `SSH_STAGING_KEY`
   - `SSH_PRODUCTION_HOST`, `SSH_PRODUCTION_USER`, `SSH_PRODUCTION_KEY`
   - `STAGING_ENV_FILE` (contenuto intero di `deploy/.env.standalone`)
   - `PRODUCTION_ENV_FILE` (contenuto intero di `deploy/.env`)
   - `STAGING_BASE_URL` (es. `http://192.168.178.180:8081`)
   - `PRODUCTION_BASE_URL` (es. `https://94z8ppoemd4qoscr.myfritz.net:30443`)

3. **Ambienti GitHub** (Settings → Environments)
   - `staging`: nessun reviewer richiesto (deploy rapido).
   - `production`: richiedi almeno un approvatore (required reviewers) prima che il job parta.

4. **Adattamento di `deploy.yml`**
   - Se self-hosted runner: cambiare `runs-on: ubuntu-latest` in `runs-on: [self-hosted, ikuck-lan]` (etichetta da definire).
   - Se runner è sullo stesso host di staging: rimuovere SSH e lanciare `docker compose` direttamente in locale.
   - Aggiungere passo di validazione `validate-production-config.ps1` prima del build su produzione.

5. **Prove**
   - Deploy di prova su staging da Actions.
   - Verifica smoke test su staging.
   - Deploy su produzione con approvazione manuale.
   - Verifica smoke test su produzione.

---

## 3. Flusso target

```
Push su main / tag
    │
    ▼
CI (ci.yml): lint + test + build frontend/backend
    │
    ▼ (manuale, workflow_dispatch)
Deploy staging: git checkout  → docker compose up -d --build
    │
    ▼
Smoke test staging (scripts/smoke-test.sh)
    │
    ▼ (approvazione manuale se ambiente production)
Deploy produzione: stesso flusso, env di produzione
    │
    ▼
Smoke test produzione
```

---

## 4. Estensioni future (non parte del primo rilascio)

- Push immagini a container registry con digest SHA-256 e immutabilità.
- Rollback rapido: conservare immagine/commit precedente, procedura documentata e esercitata su disposable.
- Zero-downtime: blue/green con due stack Compose e switch via Caddy.
- Osservabilità: alert su backup mancato, OOM, error rate 5xx.
- Test E2E production remoti (`E2E_BASE_URL`, `E2E_PRODUCTION=true`) inclusi nella pipeline.

---

## 5. File da toccare / creare

- `.github/workflows/deploy.yml` (già creato, da adattare al runner scelto)
- `scripts/smoke-test.sh` (già creato)
- Segreti e ambienti GitHub (configurazione via interfaccia web, non file repo)
- Eventuale `docs/superpowers/plans/...` per evidenze post-esecuzione

---

## Note operative

- Non committare mai segreti né backup nel repository.
- Prima di ogni deploy production: backup PostgreSQL con `backup-postgres.sh`.
- Se un passaggio non è eseguito su produzione, marcarlo “non verificato” (convenzione già usata in `docs/production-readiness.md`).
- Il deploy su host LAN tramite runner self-hosted non richiede di esporre SSH su internet.
