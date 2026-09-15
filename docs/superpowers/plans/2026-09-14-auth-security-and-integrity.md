# iKuck — piano autenticazione, sicurezza e integrità

> **Status:** completed on `plan-2-complete` at commit `511845c`; see the [remediation index](2026-09-14-remediation-index.md).

> **Per l'agente esecutore:** ogni task deve iniziare da un test fallente. Le migration devono essere compatibili con i dati esistenti e provate su PostgreSQL disposable prima del commit.

**Obiettivo:** rendere sessioni multi-tab affidabili, transazioni auth atomiche e endpoint sensibili resistenti ad abuso e link scanner.

**Architettura:** PostgreSQL conserva lo stato autorevole; Redis applica rate limit; cookie HttpOnly e CSRF restano separati. Le operazioni multi-tab non ruotano implicitamente il token CSRF condiviso.

**Spec:** AUTH-01…07 e DEP-01 nell'audit 2026-09-14.

**Rilievi coperti:** AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07, DEP-01.

---

## Task 1: aggiornare Drizzle senza cambiare comportamento

**Files:**

- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Verify: `backend/src/db/schema.ts`
- Verify: `backend/src/db/migrations/`

- [ ] Registrare `npm audit --omit=dev` e la versione corrente.
- [ ] Aggiornare `drizzle-orm` ad almeno 0.45.2 e una versione compatibile di `drizzle-kit` se necessaria.
- [ ] Non rigenerare migration storiche.
- [ ] Eseguire test repository, integration disposable, build e audit runtime.
- [ ] Confermare zero high/critical runtime oppure documentare e far approvare l'eccezione.
- [ ] Commit: `chore(backend): update drizzle runtime dependency`.

## Task 2: rendere CSRF compatibile con più tab

**Files:**

- Modify: `backend/src/auth/service.ts`
- Modify: `backend/src/auth/repository.ts`
- Modify: `backend/src/auth/service.test.ts`
- Modify: `backend/src/routes/auth.test.ts`

- [ ] Testare: stesso cookie, due restore, entrambe le risposte permettono una mutation CSRF protetta.
- [ ] Scegliere il contratto minimo: non ruotare CSRF su semplice GET di restore; ruotare solo alla creazione/rotazione esplicita della sessione.
- [ ] Rimuovere `rotateCsrfToken` dal restore e il metodo repository se non più usato.
- [ ] Testare logout/revoca e token errato.
- [ ] Eseguire test auth completi.
- [ ] Commit: `fix(auth): keep csrf valid across browser tabs`.

## Task 3: transazione atomica utente e profilo

**Files:**

- Modify: `backend/src/auth/repository.ts`
- Modify: `backend/src/auth/service.test.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`

- [ ] Test integration: forzare il fallimento del profilo e verificare che l'utente non esista.
- [ ] Incapsulare insert utente+profilo in `database.transaction`.
- [ ] Restituire il record solo dopo commit.
- [ ] Testare registrazione normale e conflitto email.
- [ ] Commit: `fix(auth): create users and profiles atomically`.

## Task 4: transazione atomica Google identity

**Files:**

- Modify: `backend/src/auth/repository.ts`
- Modify: `backend/src/auth/service.ts`
- Modify: `backend/src/auth/google.test.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`

- [ ] Testare fallimento identity dopo creazione nuovo utente: nessun utente orfano.
- [ ] Aggiungere un metodo repository transazionale `createGoogleUser`.
- [ ] Gestire race sul subject/provider con errore deterministico.
- [ ] Conservare la regola di linking esplicito per email già esistente.
- [ ] Commit: `fix(auth): create google users and identities atomically`.

## Task 5: consumo one-shot dei token

**Files:**

- Modify: `backend/src/auth/repository.ts`
- Modify: `backend/src/auth/service.test.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`

**Contratto SQL:** un solo `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING ...` può vincere.

- [ ] Lanciare due reset concorrenti con lo stesso token e verificare un solo successo.
- [ ] Implementare consumo condizionale atomico per reset e verifica email.
- [ ] Aggiornare password e consumo token nella stessa transazione.
- [ ] Verificare che replay e token scaduti abbiano la stessa risposta sicura prevista.
- [ ] Commit: `fix(auth): consume verification and reset tokens atomically`.

## Task 6: rate limit auth con Redis

**Files:**

- Create: `backend/src/auth/rateLimit.ts`
- Create: `backend/src/auth/rateLimit.test.ts`
- Modify: `backend/src/routes/auth.ts`
- Modify: `backend/src/config.ts`
- Modify: `backend/src/config.test.ts`
- Modify: `deploy/.env.example`

- [ ] Definire limiti separati per login, register, resend e forgot-password.
- [ ] Testare chiavi per IP e hash dell'email normalizzata; non mettere email in chiaro nelle chiavi/log.
- [ ] Testare finestra, reset, Redis non disponibile e header `Retry-After`.
- [ ] Configurare `trustProxy` solo per il proxy noto; non fidarsi liberamente di `X-Forwarded-For`.
- [ ] Conservare risposte generiche che non enumerano account.
- [ ] Commit: `feat(auth): add redis-backed abuse limits`.

## Task 7: rendere verifica e reset sicuri nella URL

**Files:**

- Modify: `backend/src/routes/auth.ts`
- Modify: `backend/src/routes/auth.test.ts`
- Modify: `frontend/src/pages/VerifyEmailPage.tsx`
- Modify: `frontend/src/pages/VerifyEmailPage.test.tsx`
- Modify: `frontend/src/pages/ResetPasswordPage.tsx`
- Modify: `frontend/src/pages/ResetPasswordPage.test.tsx`

- [ ] Definire GET come landing non mutante e POST come conferma, oppure documentare e testare un GET idempotente scanner-safe.
- [ ] Appena letto il token, rimuoverlo da address bar/history con `replaceState`.
- [ ] Testare che il token non compaia dopo render e non venga riutilizzato da refresh.
- [ ] Testare link scaduto, usato e invalido con copy non enumerabile.
- [ ] Commit: `fix(auth): protect email tokens from scanners and url leaks`.

## Task 8: allineare segreto, cookie e pulizia

**Files:**

- Modify: `backend/src/config.ts`
- Modify: `backend/src/auth/crypto.ts`
- Modify: `backend/src/routes/auth.ts`
- Create: `backend/src/db/cleanupExpiredAuth.ts`
- Create: `backend/src/db/cleanupExpiredAuth.test.ts`
- Modify: `README.md`
- Modify: `docs/production-readiness.md`

- [ ] Decidere e testare un solo uso reale di `SESSION_SECRET` come pepper/HMAC con rotazione documentata; se non serve, rimuoverlo ovunque.
- [ ] Definire se la sessione deve sopravvivere al browser; aggiungere `Max-Age` coerente con TTL solo se sì.
- [ ] Implementare cleanup idempotente di sessioni e token scaduti con modalità dry-run.
- [ ] Documentare frequenza e rollback.
- [ ] Commit: `fix(auth): align secret cookie ttl and expired-data cleanup`.

## Gate del piano

```powershell
cd backend
npm run lint
npm test
npm run test:coverage
npm run build
npm audit --omit=dev
```

- [ ] Eseguire i test integration con PostgreSQL/Redis disposable, senza skip.
- [ ] Annotare nel piano indice commit, versione Drizzle e risultato audit.
