# iKuck — piano PWA, accessibilità e test frontend

> **Status:** completed on `plan-5-complete` at commit `8395a3c`; see the [remediation index](2026-09-14-remediation-index.md).

> **Per l'agente esecutore:** questo piano parte solo dopo il piano UX. Non aggiornare snapshot visivi senza ispezionare la differenza.

**Obiettivo:** evitare shell PWA silenziosamente obsolete e coprire i flussi di pagina/accessibilità oggi scoperti.

**Spec:** UX-09, UX-13 e TEST-01 nell'audit.

**Rilievi coperti:** UX-09, UX-13, TEST-01.

---

## Task 1: definire il contratto di aggiornamento PWA

**Files:**

- Modify: `frontend/vite.config.ts`
- Modify: `frontend/src/main.tsx`
- Create: `frontend/src/components/feedback/AppUpdatePrompt.tsx`
- Create: `frontend/src/components/feedback/AppUpdatePrompt.test.tsx`

- [ ] Simulare `needRefresh` e verificare un prompt non bloccante “Aggiornamento disponibile”.
- [ ] Implementare “Aggiorna ora” e “Più tardi”; non ricaricare durante un form senza scelta utente.
- [ ] Mostrare versione/build in una sezione diagnostica del profilo, non nell'header primario.
- [ ] Testare offline, update riuscito e update fallito.
- [ ] Commit: `fix(pwa): expose and control service worker updates`.

## Task 2: E2E dell'update service worker

**Files:**

- Create: `frontend/e2e/pwa-update.spec.ts`
- Modify: `frontend/playwright.config.ts`
- Modify: `frontend/package.json`

- [ ] Costruire/servire build A, poi build B con ID differente.
- [ ] Verificare che una pagina aperta riceva il prompt e resti utilizzabile.
- [ ] Cliccare update e verificare versione B senza perdita dei dati IndexedDB.
- [ ] Verificare offline reload della build attiva.
- [ ] Commit: `test(pwa): cover stale-shell update flow`.

## Task 3: integrare controlli axe mirati

**Files:**

- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/e2e/accessibility.spec.ts`

- [ ] Aggiungere una dipendenza axe compatibile con Playwright.
- [ ] Controllare home guest, home verificata, profilo, lista, attività e dettaglio ricetta.
- [ ] Escludere una regola solo con commento che cita una issue; nessuna esclusione globale.
- [ ] Fallire su violazioni critical/serious.
- [ ] Commit: `test(a11y): add axe gates for primary pages`.

## Task 4: focus, zoom e reduced motion

**Files:**

- Modify: `frontend/src/index.css`
- Modify: `frontend/e2e/accessibility.spec.ts`
- Modify: componenti con animazioni/focus interessati

- [ ] Verificare indicatore focus visibile su link, button, input, summary e dialog.
- [ ] Testare viewport 320 px e zoom equivalente 200% senza scroll orizzontale del documento.
- [ ] Rispettare `prefers-reduced-motion: reduce` per transizioni non essenziali.
- [ ] Testare ordine heading e nome accessibile dei controlli icon-only.
- [ ] Commit: `fix(a11y): harden focus zoom and reduced motion`.

## Task 5: coprire router e pagine sottili

**Files:**

- Create/Modify: `frontend/src/App.test.tsx`
- Create: `frontend/src/pages/ActivityPage.test.tsx`
- Create: `frontend/src/pages/ShoppingListPage.test.tsx`
- Modify: `frontend/src/pages/ProfilePage.test.tsx`
- Modify: `frontend/src/components/account/AccountPanel.test.tsx`

- [ ] Coprire ogni route, redirect autorizzato, 404 e cleanup listener.
- [ ] Coprire loading, empty, populated ed errore per attività/lista/profilo.
- [ ] Coprire session restore, logout fallito, Google non configurato e import parziale.
- [ ] Non testare soltanto testo statico: verificare effetti e chiamate.
- [ ] Commit: `test(frontend): cover routes and account page flows`.

## Task 6: rendere il timeout test backend non fragile sotto contesa

**Files:**

- Modify: `backend/src/deployment-contract.test.ts`

- [ ] Misurare la causa eseguendo il file isolato e insieme alla suite.
- [ ] Eliminare attese reali/network dal test o usare fake timer dove corretto.
- [ ] Aumentare timeout solo se l'operazione reale è legittimamente lunga e documentata.
- [ ] Eseguire la suite cinque volte senza flake.
- [ ] Commit: `test(backend): remove deployment contract timing flake`.

## Gate del piano

```powershell
cd frontend
npm run lint
npm test
npm run test:coverage
npm run test:e2e
npm run build
cd ../backend
npm test
```

- [ ] Allegare al registro risultati axe, viewport e update PWA.
