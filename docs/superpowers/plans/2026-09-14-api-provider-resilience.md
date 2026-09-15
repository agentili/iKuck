# iKuck — piano API, provider e resilienza I/O

> **Status:** completed on `plan-3-complete` at commit `c798920`; see the [remediation index](2026-09-14-remediation-index.md).

> **Per l'agente esecutore:** non cambiare più contratti nello stesso task. Ogni errore esterno deve diventare un errore applicativo tipizzato, senza includere token, prompt o dati privati nei log.

**Obiettivo:** validare in modo uniforme la sync API, limitare lo skew temporale e rendere provider/quota prevedibili in caso di rete lenta o guasto.

**Spec:** SYNC-06…08 e IO-01…04 nell'audit.

**Rilievi coperti:** SYNC-06, SYNC-07, SYNC-08, IO-01, IO-02, IO-03, IO-04.

---

## Task 1: restituire 400 per payload sync invalidi

**Files:**

- Modify: `backend/src/routes/sync.ts`
- Modify: `backend/src/routes/sync.test.ts`
- Modify: `backend/src/app.ts`

- [ ] Aggiungere test per body malformato, entity sconosciuta, payload incompleto e user ID non coerente.
- [ ] Usare `safeParse` e un errore API con status 400 e codice stabile `INVALID_SYNC_PAYLOAD`.
- [ ] Non restituire dettagli interni Zod in produzione.
- [ ] Verificare che un errore repository resti 500 redatto.
- [ ] Commit: `fix(sync-api): map invalid sync payloads to client errors`.

## Task 2: schema discriminato condiviso per mutation

**Files:**

- Create: `backend/src/sync/validation.ts`
- Create: `backend/src/sync/validation.test.ts`
- Modify: `backend/src/routes/sync.ts`
- Modify: `backend/src/sync/repository.ts`
- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `backend/src/contracts/contracts.test.ts`

- [ ] Definire uno schema discriminato per ogni `entity` e `operation` con payload esatto.
- [ ] Aggiungere fixture contratto valide/non valide condivise come JSON, senza import TypeScript cross-package fragile.
- [ ] Validare sia prima dell'enqueue frontend sia all'ingresso backend.
- [ ] Rimuovere i cast `as` usati per aggirare il payload pantry.
- [ ] Testare compatibilità con mutation già persistite valide.
- [ ] Commit: `fix(sync): validate entity payloads end to end`.

## Task 3: gestire clock skew nel last-write-wins

**Files:**

- Modify: `backend/src/sync/repository.ts`
- Modify: `backend/src/sync/repository.test.ts`
- Modify: `backend/src/integration/auth-sync.integration.test.ts`
- Modify: `README.md`

- [ ] Aggiungere test con client 10 minuti nel futuro, due device e timestamp uguali.
- [ ] Definire una tolleranza configurabile; oltre soglia usare il tempo server e registrare solo un warning senza dati privati.
- [ ] Rendere il tie-break deterministico con revision/server timestamp e device ID.
- [ ] Documentare la semantica conflitti e il fatto che non esiste merge campo-per-campo.
- [ ] Commit: `fix(sync): bound client clock skew in conflict resolution`.

## Task 4: timeout e abort condivisi per provider

**Files:**

- Create: `backend/src/providers/fetchWithTimeout.ts`
- Create: `backend/src/providers/fetchWithTimeout.test.ts`
- Modify: `backend/src/providers/resend.ts`
- Modify: `backend/src/providers/usda.ts`
- Modify: `backend/src/providers/openaiRecipes.ts`
- Modify: `backend/src/providers/factory.ts`
- Modify: `backend/src/config.ts`

**Contratto:**

```ts
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response>;
```

- [ ] Testare risposta normale, abort per timeout, abort del chiamante e cleanup timer.
- [ ] Aggiungere timeout distinti/configurabili con limiti validati.
- [ ] Usare lo stesso `fetchImpl` iniettato anche per Resend.
- [ ] Mappare timeout in errore provider stabile; nessun retry automatico per richieste non idempotenti.
- [ ] Commit: `fix(providers): enforce timeouts and consistent fetch injection`.

## Task 5: non consumare quota AI su fallimento provider

**Files:**

- Modify: `backend/src/ai/rateLimit.ts`
- Modify: `backend/src/ai/rateLimit.test.ts`
- Modify: `backend/src/routes/aiRecipes.ts`
- Modify: `backend/src/routes/aiRecipes.test.ts`

- [ ] Testare provider success, timeout, 429, payload invalido e richiesta concorrente al limite.
- [ ] Implementare reservation atomica Redis con TTL; commit su successo e release su fallimento.
- [ ] Impedire che due richieste concorrenti superino il limite.
- [ ] Restituire conteggio coerente senza esporre chiavi Redis.
- [ ] Commit: `fix(ai): commit quota only after successful generation`.

## Task 6: separare E2E offline e live-stack

**Files:**

- Modify: `frontend/playwright.config.ts`
- Modify: `frontend/e2e/` test pertinenti
- Create: `frontend/e2e/helpers/backendMode.ts`
- Modify: `frontend/package.json`
- Modify: `README.md`

- [ ] In modalità offline intercettare esplicitamente `/v1/**` con risposte determinate; fallire su richieste non previste.
- [ ] Aggiungere comando `test:e2e:live` che richiede backend e dipendenze sane.
- [ ] Testare almeno register/verify/login/sync/logout contro stack disposable.
- [ ] Rendere gli skip visibili e non equivalenti a successo CI.
- [ ] Verificare che il log offline non contenga `ECONNREFUSED`.
- [ ] Commit: `test(e2e): split deterministic offline and live backend flows`.

## Gate del piano

```powershell
cd backend
npm run lint
npm test
npm run build
cd ../frontend
npm run lint
npm test
npm run test:e2e
npm run build
```

- [ ] Eseguire `test:e2e:live` su stack disposable.
- [ ] Lasciare provider reali come smoke opt-in, senza inventare risultati.
