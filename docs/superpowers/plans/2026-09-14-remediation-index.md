# iKuck — indice del piano di risanamento

> **Status:** current source of truth. Plans 1–5 are completed and tagged; plan 6 is in progress on `codex/plan6-dependencies-ci-docs`; plan 7 has not started.

> **Per l'agente esecutore:** usa `superpowers:test-driven-development` per ogni bug, `superpowers:systematic-debugging` se un test fallisce in modo inatteso e `superpowers:verification-before-completion` prima di spuntare un task. Esegui un solo task alla volta. Non iniziare il successivo finché test, diff e nota di avanzamento del corrente non sono completi.

**Obiettivo:** risolvere tutti i rilievi dell'[audit repository](../../audits/2026-09-14-repository-audit.md) con unità di lavoro abbastanza piccole per GPT-5.6 Luna.

**Architettura:** conservare la PWA guest-first, IndexedDB per l'uso locale, React/Vite nel frontend e Fastify/PostgreSQL/Redis nel backend. La sincronizzazione deve essere esplicitamente isolata per account; nessun dato guest viene caricato automaticamente.

**Stack:** TypeScript, React, Zustand, IndexedDB, Vitest, Playwright, Fastify, Drizzle, PostgreSQL, Redis, Docker Compose, Caddy.

**Spec:** `docs/audits/2026-09-14-repository-audit.md`.

## Regole operative

- Lavorare su un task alla volta e creare un commit dedicato per task.
- Non modificare file fuori dal task salvo dipendenze indispensabili documentate.
- Prima di iniziare: `git -c safe.directory=C:/Users/New/git/iRicetto status --short`.
- Non caricare automaticamente dati guest o code legacy verso un account.
- Codice, nomi e commenti in inglese; copy visibile in italiano.
- Non usare percentuali di coverage come unica prova: coprire gli scenari indicati.
- Non spuntare controlli VPS/provider/restore senza esecuzione reale e relativa evidenza.
- Dopo ogni task aggiornare la tabella seguente con data, commit e nota breve.

## Ordine vincolante

| Ordine | Piano | Rilievi | Dipendenze | Stato |
|---:|---|---|---|---|
| 1 | [Sync e isolamento account](2026-09-14-sync-and-account-isolation.md) | SYNC-01…05, SYNC-09 | nessuna | completato — [plan-1-complete](../../../../.git) (`09be163`) |
| 2 | [Auth e integrità](2026-09-14-auth-security-and-integrity.md) | AUTH-01…07, DEP-01 | task sync 1-2 consigliati | completato — [plan-2-complete](../../../../.git) (`511845c`) |
| 3 | [API, provider e resilienza I/O](2026-09-14-api-provider-resilience.md) | IO-01…04, SYNC-06…08 | contratti sync definiti | completato — [plan-3-complete](../../../../.git) (`c798920`) |
| 4 | [Home, navigazione e flussi UX](2026-09-14-home-navigation-and-ux.md) | UX-01…08, 10…12 | sync result API definita | completato — [plan-4-complete](../../../../.git) (`85bb8d3`) |
| 5 | [PWA, accessibilità e test frontend](2026-09-14-pwa-accessibility-and-frontend-tests.md) | UX-09, UX-13, TEST-01 | nuova gerarchia UI | completato — [plan-5-complete](../../../../.git) (`8395a3c`) |
| 6 | [Dipendenze, CI e documentazione](2026-09-14-dependencies-ci-and-docs.md) | DEP-02, OPS-04, DOC-01…02, TEST-02 | piani 1-5 | in corso — `codex/plan6-dependencies-ci-docs` |
| 7 | [Hardening e recovery](2026-09-14-deployment-and-recovery-hardening.md) | OPS-01…03, TEST-02 | CI verde e immagini finali | non iniziato |

## Gate dopo ogni piano

```powershell
cd frontend
npm run lint
npm test
npm run build
cd ../backend
npm run lint
npm test
npm run build
git -c safe.directory=C:/Users/New/git/iRicetto diff --check
git -c safe.directory=C:/Users/New/git/iRicetto status --short
```

Se un test di integrazione viene saltato, annotarlo come non verificato: non equivale a successo.

## Registro di avanzamento

| Data | Task | Commit | Verifiche | Note/blocchi |
|---|---|---|---|---|
| 2026-09-14 | Piano 1 — sync e isolamento account | `09be163` / `plan-1-complete` | evidenza registrata nel checkpoint del branch | completato |
| 2026-09-14 | Piano 2 — auth e integrità | `511845c` / `plan-2-complete` | evidenza registrata nel checkpoint del branch | completato |
| 2026-09-14 | Piano 3 — API, provider e resilienza I/O | `c798920` / `plan-3-complete` | evidenza registrata nel checkpoint del branch | completato |
| 2026-09-15 | Piano 4 — home, navigazione e UX | `85bb8d3` / `plan-4-complete` | evidenza registrata nel checkpoint del branch | completato |
| 2026-09-15 | Piano 5 — PWA, accessibilità e test frontend | `8395a3c` / `plan-5-complete` | Docker standalone verificato su LAN | completato |
| 2026-09-15 | Piano 6 — dipendenze, CI e documentazione | `64c7b2d`, `19167df`, `b05fb4a`, `a770487`, `eb0be9c` | suite locali e audit runtime verificati; production non verificata | in corso fino al tag finale |

## Definition of done globale

- [ ] Nessuna mutation/cursore/promise può attraversare il confine tra guest e account diversi.
- [ ] Sync iniziale, batching e paginazione sono verificati con dataset oltre i limiti di pagina.
- [ ] CSRF multi-tab e workflow auth concorrenti sono coperti e atomici.
- [ ] L'audit runtime non contiene vulnerability high/critical non accettate esplicitamente.
- [ ] Su 390×844 il CTA primario è nella prima schermata e raggiungibile entro 10 pressioni Tab dall'inizio.
- [ ] Logout, import, errori di persistenza e provider comunicano lo stato reale.
- [ ] 404, aggiornamento PWA, focus, zoom e reduced motion hanno prove automatiche/manuali.
- [ ] Esiste un comando CI riproducibile che verifica frontend e backend.
- [ ] Backup e restore sono provati su un database disposable; produzione resta non verificata finché non eseguita realmente.
- [ ] Documentazione agente e README descrivono solo l'architettura corrente.
