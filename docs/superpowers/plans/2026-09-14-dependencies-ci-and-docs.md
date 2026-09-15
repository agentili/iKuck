# iKuck — piano dipendenze, CI e documentazione

> **Status:** in progress on `codex/plan6-dependencies-ci-docs`; tasks 1–5 are implemented, tasks 6–7 are being recorded with dated evidence.

> **Per l'agente esecutore:** aggiornare una famiglia di dipendenze per task. Non usare `npm audit fix --force`. Conservare i lockfile e ispezionare ogni major change.

**Obiettivo:** ridurre gli advisory del tooling, creare un gate unico e impedire che documentazione obsoleta guidi modifiche errate.

**Spec:** DEP-02, OPS-04, DOC-01…02 e TEST-02 nell'audit.

**Rilievi coperti:** DEP-02, OPS-04, DOC-01, DOC-02, TEST-02.

---

## Task 1: aggiornare Vite/Vitest frontend

**Files:**

- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/playwright.config.ts`

- [ ] Salvare baseline `npm outdated` e `npm audit` nel messaggio commit, senza copiare rumore nel repository.
- [x] Aggiornare Vite, Vitest, coverage e plugin React a versioni compatibili non vulnerabili.
- [x] Leggere le migration note delle major e modificare solo config necessaria.
- [x] Eseguire lint, unit, coverage, E2E e build PWA.
- [x] Verificare `npm audit --omit=dev` pulito e registrare advisory dev residui.
- [ ] Commit: `chore(frontend): update vite and vitest toolchain`.

## Task 2: aggiornare tooling backend

**Files:**

- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify: config Vitest/TypeScript se richiesto

- [x] Aggiornare Vitest/esbuild/tooling in un gruppo compatibile.
- [ ] Non combinare con cambi applicativi.
- [x] Eseguire lint, unit, coverage, integration e build.
- [x] Registrare audit runtime e completo.
- [ ] Commit: `chore(backend): update test and build toolchain`.

## Task 3: aggiungere un orchestratore root minimo

**Files:**

- Create: `package.json`
- Create: `scripts/verify-repository.ps1`
- Create: `scripts/verify-repository.test.ps1`
- Modify: `README.md`

**Contratto comandi:**

```json
{
  "scripts": {
    "verify": "powershell -ExecutionPolicy Bypass -File scripts/verify-repository.ps1"
  }
}
```

- [x] Testare propagazione exit code e messaggio quando `node_modules` manca.
- [x] Eseguire in ordine frontend lint/test/build e backend lint/test/build.
- [x] Aggiungere flag espliciti per coverage, E2E offline e integration; niente skip nascosti.
- [ ] Non introdurre un workspace npm se non necessario.
- [ ] Commit: `build: add a repository-wide verification command`.

## Task 4: creare CI riproducibile

**Files:**

- Create: `.github/workflows/ci.yml`
- Modify: `README.md`

- [x] Pin action a commit SHA, non solo tag mobile.
- [x] Job frontend: `npm ci`, lint, unit, build, E2E offline.
- [x] Job backend: PostgreSQL/Redis service, `npm ci`, lint, unit, integration non saltata, build, audit runtime.
- [x] Cache basata sui due lockfile; nessun secret richiesto per test ordinari.
- [ ] Caricare report solo se privi di token/dati utente.
- [ ] Proteggere la branch usando i due job come required checks dopo il merge della CI.
- [ ] Commit: `ci: verify frontend backend and disposable integrations`.

## Task 5: sostituire le istruzioni agente obsolete

**Files:**

- Create: `AGENTS.md`
- Modify or Remove: `GEMINI.md`
- Modify: `README.md`

- [x] Descrivere architettura reale: React/Vite guest-first, Fastify, PostgreSQL, Redis, sync esplicita.
- [x] Elencare comandi esatti dalle directory corrette e i limiti Docker/provider.
- [x] Dichiarare codice/commenti inglesi e copy visibile italiano.
- [x] Rimuovere riferimenti a Supabase, TanStack Query, struttura e algoritmi non esistenti dalle istruzioni correnti.
- [x] Se `GEMINI.md` resta, renderlo un link corto ad `AGENTS.md` per evitare duplicazione.
- [ ] Commit: `docs: align agent guidance with the current platform`.

## Task 6: rendere l'indice la fonte di verità

**Files:**

- Modify: `docs/superpowers/plans/2026-09-14-remediation-index.md`
- Modify: piani storici solo nell'intestazione
- Modify: `README.md`

- [ ] Aggiungere ai piani superati una nota `Status: superseded/completed` con link al commit o al nuovo indice.
- [ ] Non riscrivere la storia e non spuntare retroattivamente task senza evidenza.
- [ ] Collegare audit, indice e production readiness dal README.
- [ ] Verificare tutti i link Markdown locali.
- [ ] Commit: `docs: establish the remediation index as current status`.

## Task 7: separare prove locali, integration e produzione

**Files:**

- Modify: `docs/production-readiness.md`
- Modify: `docs/superpowers/plans/2026-09-13-production-readiness-and-provider-smoke.md`
- Modify: `docs/superpowers/plans/2026-09-14-remediation-index.md`

- [x] Creare tre sezioni: verified locally, verified on disposable stack, verified in production.
- [x] Ogni prova contiene data, commit, comando/ambiente e risultato.
- [x] Gli skip restano “not verified”, mai “passed”.
- [x] Non salvare email reali, endpoint privati, token, prompt o output utenti.
- [ ] Commit: `docs: separate local staging and production evidence`.

## Gate del piano

```powershell
npm run verify
git -c safe.directory=C:/Users/New/git/iRicetto diff --check
```

- [ ] CI verde da clone pulito.
- [ ] Audit runtime senza high/critical non accettate.
- [ ] Ricerca repository senza riferimenti architetturali obsoleti.
