# iKuck — piano hardening deployment e recovery

> **Status:** completed on `codex/plan7-deployment-recovery` and tag `plan-7-complete`; production, public HTTPS and controlled OOM/restart remain not verified.

> **Per l'agente esecutore:** provare tutto prima su Compose disposable. Restore e rollback su produzione richiedono autorizzazione esplicita, finestra di manutenzione e backup verificato.

**Obiettivo:** aggiungere header web, least privilege dei container e procedure di backup/restore che non lascino artefatti parziali o dati non verificati.

**Spec:** OPS-01…03 e TEST-02 nell'audit. Integra, non sostituisce, `docs/production-readiness.md`.

**Rilievi coperti:** OPS-01, OPS-02, OPS-03, TEST-02.

---

## Task 1: testare gli header di sicurezza

**Files:**

- Create: `deploy/security-headers.test.ps1`
- Modify: `deploy/Caddyfile`
- Modify: `docs/production-readiness.md`

- [x] Avviare Compose disposable e scrivere test per `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, frame policy, referrer e permissions.
- [x] Definire CSP iniziale senza `unsafe-eval`; consentire solo origini realmente necessarie per Google se abilitato.
- [x] Attivare HSTS solo sul virtual host HTTPS, mai sull'ambiente HTTP locale.
- [x] Verificare login Google, PWA, font/assets e API dopo CSP.
- [ ] Commit: `fix(edge): add tested browser security headers`.

## Task 2: eseguire API come utente non-root

**Files:**

- Modify: Dockerfile backend effettivamente referenziato da `deploy/docker-compose.production.yml`
- Modify: `deploy/docker-compose.production.yml`
- Modify: `deploy/docker-compose.standalone.yml`
- Create: `deploy/container-hardening.test.ps1`

- [x] Testare UID/GID runtime, directory scrivibili e healthcheck.
- [x] Creare/copiarne gli artefatti con ownership corretta e dichiarare `USER` non-root.
- [x] Aggiungere `read_only`, `tmpfs` e `cap_drop: [ALL]` dove compatibile.
- [x] Non esporre PostgreSQL/Redis all'host pubblico.
- [x] Eseguire unit/integration e smoke Compose.
- [ ] Commit: `security(deploy): run application containers with least privilege`.

## Task 3: rendere il backup atomico e verificabile

**Files:**

- Modify: `deploy/backup-postgres.sh`
- Create: `deploy/backup-postgres.test.sh`
- Modify: `docs/production-readiness.md`

- [x] Scrivere in un file temporaneo nella stessa directory di destinazione.
- [x] Se `pg_dump` fallisce, cancellare solo il temp esatto e non creare il nome finale.
- [x] Verificare archivio con `pg_restore --list`.
- [x] Generare SHA-256 e rinominare archive/checksum atomicamente solo a verifica riuscita.
- [x] Applicare retention solo dopo il nuovo backup valido e con path convalidato.
- [ ] Commit: `fix(backup): create verified postgres archives atomically`.

## Task 4: aggiungere preflight e guardrail al restore

**Files:**

- Modify: `deploy/restore-postgres.sh`
- Create: `deploy/restore-postgres.test.sh`
- Modify: `docs/production-readiness.md`

- [x] Verificare file, checksum, formato, versione PostgreSQL, spazio e destinazione prima di cambiare dati.
- [x] Richiedere target esplicito e conferma digitata; offrire `--dry-run` non distruttivo.
- [x] Creare e verificare un backup pre-restore.
- [x] Fermare/drainare API durante restore; usare transazione dove compatibile.
- [x] Eseguire health, migration status e query sentinella dopo restore.
- [x] In caso di fallimento stampare istruzioni di recovery, senza cancellare backup.
- [ ] Commit: `fix(restore): add preflight backup and post-restore verification`.

## Task 5: provare backup e restore su database disposable

**Files:**

- Modify: `deploy/docker-compose.integration.yml`
- Create: `scripts/verify-backup-restore.ps1`
- Modify: `docs/production-readiness.md`

- [x] Caricare fixture sintetiche non sensibili e confrontare il contratto di recovery senza salvare dati reali.
- [x] Creare backup, distruggere solo il progetto/volume disposable risolto e ricrearlo.
- [x] Eseguire restore e confrontare conteggi/hash di fixture non sensibili.
- [x] Verificare health e query sentinella dopo restore; login/sync reale richiede un'API disposable configurata.
- [x] Registrare durata e dimensione senza salvare dati reali nel runner.
- [ ] Commit: `test(recovery): rehearse postgres backup and restore`.

## Task 6: pinning, limiti e osservabilità minima

**Files:**

- Modify: `deploy/docker-compose.production.yml`
- Modify: `deploy/docker-compose.standalone.yml`
- Modify: `docs/production-readiness.md`

- [x] Pin immagini terze a digest aggiornabile e documentare il processo di refresh.
- [x] Definire limiti CPU/memoria coerenti con mini-PC/VPS e documentare il test OOM/restart ancora richiesto in staging.
- [x] Aggiungere rotazione log, healthcheck e runbook/alert operativi per error rate, spazio DB e backup mancato.
- [x] Redigere runbook per rollback immagine e rollback migration; non promettere rollback schema automatico se non esiste.
- [ ] Commit: `ops: pin images and define runtime safeguards`.

## Task 7: verifica staging e produzione

**Files:**

- Modify: `docs/production-readiness.md`
- Modify: `docs/superpowers/plans/2026-09-14-remediation-index.md`

- [x] In staging LAN: deploy da branch esatto, HTTP, integration disposable, backup/restore e smoke endpoint verificati; HTTPS pubblico resta non verificato.
- [x] Con credenziali dedicate: provider smoke non eseguiti e registrati come non verificati.
- [x] In produzione: nessun accesso o autorizzazione production è stato usato.
- [x] Verificare e registrare DNS, HTTPS, PWA, auth, sync multi-device, monitoraggio e recovery point senza promuovere skip a pass.
- [x] Se un passaggio non è eseguito, marcarlo “non verificato”, non “completato”.
- [ ] Commit: `docs(ops): record staging and production evidence`.

## Gate del piano

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-production-config.test.ps1
powershell -ExecutionPolicy Bypass -File scripts/verify-backup-restore.ps1
docker compose -f deploy/docker-compose.integration.yml config
```

- [x] Nessun secret o backup è tracciato da Git.
- [x] Restore disposable riuscito da backup appena creato.
- [x] Prove staging/produzione separate e datate.
