# iKuck — piano hardening deployment e recovery

> **Status:** not started; scheduled after plan 6 and its CI/tooling baseline.

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

- [ ] Avviare Compose disposable e scrivere test per `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, frame policy, referrer e permissions.
- [ ] Definire CSP iniziale senza `unsafe-eval`; consentire solo origini realmente necessarie per Google se abilitato.
- [ ] Attivare HSTS solo sul virtual host HTTPS, mai sull'ambiente HTTP locale.
- [ ] Verificare login Google, PWA, font/assets e API dopo CSP.
- [ ] Commit: `fix(edge): add tested browser security headers`.

## Task 2: eseguire API come utente non-root

**Files:**

- Modify: Dockerfile backend effettivamente referenziato da `deploy/docker-compose.production.yml`
- Modify: `deploy/docker-compose.production.yml`
- Modify: `deploy/docker-compose.standalone.yml`
- Create: `deploy/container-hardening.test.ps1`

- [ ] Testare UID/GID runtime, directory scrivibili e healthcheck.
- [ ] Creare/copiarne gli artefatti con ownership corretta e dichiarare `USER` non-root.
- [ ] Aggiungere `read_only`, `tmpfs` e `cap_drop: [ALL]` dove compatibile.
- [ ] Non esporre PostgreSQL/Redis all'host pubblico.
- [ ] Eseguire unit/integration e smoke Compose.
- [ ] Commit: `security(deploy): run application containers with least privilege`.

## Task 3: rendere il backup atomico e verificabile

**Files:**

- Modify: `deploy/backup-postgres.sh`
- Create: `deploy/backup-postgres.test.sh`
- Modify: `docs/production-readiness.md`

- [ ] Scrivere in un file temporaneo nella stessa directory di destinazione.
- [ ] Se `pg_dump` fallisce, cancellare solo il temp esatto e non creare il nome finale.
- [ ] Verificare archivio con `pg_restore --list`.
- [ ] Generare SHA-256 e rinominare archive/checksum atomicamente solo a verifica riuscita.
- [ ] Applicare retention solo dopo il nuovo backup valido e con path convalidato.
- [ ] Commit: `fix(backup): create verified postgres archives atomically`.

## Task 4: aggiungere preflight e guardrail al restore

**Files:**

- Modify: `deploy/restore-postgres.sh`
- Create: `deploy/restore-postgres.test.sh`
- Modify: `docs/production-readiness.md`

- [ ] Verificare file, checksum, formato, versione PostgreSQL, spazio e destinazione prima di cambiare dati.
- [ ] Richiedere target esplicito e conferma digitata; offrire `--dry-run` non distruttivo.
- [ ] Creare e verificare un backup pre-restore.
- [ ] Fermare/drainare API durante restore; usare transazione dove compatibile.
- [ ] Eseguire health, migration status e query sentinella dopo restore.
- [ ] In caso di fallimento stampare istruzioni di recovery, senza cancellare backup.
- [ ] Commit: `fix(restore): add preflight backup and post-restore verification`.

## Task 5: provare backup e restore su database disposable

**Files:**

- Modify: `deploy/docker-compose.integration.yml`
- Create: `scripts/verify-backup-restore.ps1`
- Modify: `docs/production-readiness.md`

- [ ] Caricare fixture con utenti, profili, sessioni scadute, pantry e sync change.
- [ ] Creare backup, distruggere solo il container/volume disposable risolto e ricrearlo.
- [ ] Eseguire restore e confrontare conteggi/hash di fixture non sensibili.
- [ ] Verificare login/sync dopo restore.
- [ ] Registrare durata e dimensione senza salvare dati reali.
- [ ] Commit: `test(recovery): rehearse postgres backup and restore`.

## Task 6: pinning, limiti e osservabilità minima

**Files:**

- Modify: `deploy/docker-compose.production.yml`
- Modify: `deploy/docker-compose.standalone.yml`
- Modify: `docs/production-readiness.md`

- [ ] Pin immagini terze a digest aggiornabile e documentare il processo di refresh.
- [ ] Definire limiti CPU/memoria coerenti con mini-PC/VPS e testare OOM/restart in staging.
- [ ] Aggiungere rotazione log, healthcheck e alert per error rate, spazio DB e backup mancato.
- [ ] Redigere runbook per rollback immagine e rollback migration; non promettere rollback schema automatico se non esiste.
- [ ] Commit: `ops: pin images and define runtime safeguards`.

## Task 7: verifica staging e produzione

**Files:**

- Modify: `docs/production-readiness.md`
- Modify: `docs/superpowers/plans/2026-09-14-remediation-index.md`

- [ ] In staging: deploy da commit/tag esatto, HTTPS, integration non saltata, backup/restore e rollback.
- [ ] Con credenziali dedicate: smoke Resend, USDA e OpenAI; redigere solo esito e timestamp.
- [ ] In produzione: procedere solo con autorizzazione, backup valido e owner presente.
- [ ] Verificare DNS, HTTPS, PWA, auth, sync multi-device, monitoraggio e recovery point.
- [ ] Se un passaggio non è eseguito, marcarlo “non verificato”, non “completato”.
- [ ] Commit: `docs(ops): record staging and production evidence`.

## Gate del piano

```powershell
powershell -ExecutionPolicy Bypass -File scripts/validate-production-config.test.ps1
powershell -ExecutionPolicy Bypass -File scripts/verify-backup-restore.ps1
docker compose -f deploy/docker-compose.integration.yml config
```

- [ ] Nessun secret o backup è tracciato da Git.
- [ ] Restore disposable riuscito da backup appena creato.
- [ ] Prove staging/produzione separate e datate.
