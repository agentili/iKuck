# iKuck — piano sync e isolamento account

> **Status:** completed on `plan-1-complete` at commit `09be163`; see the [remediation index](2026-09-14-remediation-index.md).

> **Per l'agente esecutore:** completa un task e un commit alla volta. Scrivi prima il test rosso. Se il disegno dei dati esistenti non coincide con questo piano, fermati e documenta la differenza invece di improvvisare una migrazione che carichi dati.

**Obiettivo:** impedire contaminazioni tra guest/account, rendere la sincronizzazione iniziale e completa, e mostrare errori di persistenza reali.

**Architettura:** ogni record della coda e ogni cursore hanno uno `SyncScope`: `guest` oppure `account:<userId>`. Il device ID può restare legato all'installazione; lock e stato sync sono per account. La coda legacy resta locale finché l'utente non usa l'import esplicito.

**Spec:** rilievi SYNC-01…05 e SYNC-09 in `docs/audits/2026-09-14-repository-audit.md`. SYNC-06…08 sono nel piano API/provider.

**Rilievi coperti:** SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-09.

---

## Task 1: introdurre lo scope senza caricare la coda legacy

**Files:**

- Modify: `frontend/src/storage/indexedDb.ts`
- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/sync/syncQueue.test.ts`

**Contratto:**

```ts
export type SyncScope = 'guest' | `account:${string}`;

export interface QueuedMutation {
  id: string;
  scope: SyncScope;
  entity: SyncEntity;
  entityId: string;
  operation: 'upsert' | 'delete';
  payload: unknown;
  clientUpdatedAt: string;
}
```

- [ ] Scrivere test che inseriscono mutation guest, account A, account B e verificano lettura/cancellazione isolate.
- [ ] Scrivere un test di upgrade IndexedDB: i record legacy senza scope diventano `guest`; non diventano account mutation.
- [ ] Incrementare la versione DB e creare l'indice `scope` nella migration `onupgradeneeded`.
- [ ] Aggiornare enqueue/read/delete per richiedere sempre lo scope.
- [ ] Eseguire `cd frontend; npm test -- syncQueue indexedDb`.
- [ ] Commit: `fix(sync): isolate queued mutations by data scope`.

**Accettazione:** nessuna API può leggere “tutta la coda” senza uno scope esplicito.

## Task 2: separare cursori e lock per utente

**Files:**

- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/sync/syncQueue.test.ts`

**Contratto:**

```ts
const cursorKey = (userId: string): string => `syncCursor:${userId}`;
const syncPromises = new Map<string, Promise<SyncChangeSet>>();
```

- [ ] Testare cursori indipendenti per due utenti sullo stesso IndexedDB.
- [ ] Testare due sync concorrenti dello stesso utente: una sola richiesta.
- [ ] Testare due sync concorrenti di utenti diversi: due richieste e risposte applicate solo al proprio scope.
- [ ] Sostituire cursor key e promise globali.
- [ ] Prima di applicare la risposta, ricontrollare che la sessione attesa sia ancora quella attiva; in caso contrario non applicare e non cancellare la coda.
- [ ] Eseguire i test sync completi.
- [ ] Commit: `fix(sync): scope cursors and in-flight work per account`.

## Task 3: sincronizzare su restore/login e reconnect

**Files:**

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/sync/syncQueue.ts`
- Create: `frontend/src/App.test.tsx`
- Modify: `frontend/src/sync/syncQueue.test.ts`

- [ ] Testare che una sessione verificata già online avvii una sync iniziale una sola volta.
- [ ] Testare che guest, sessione non verificata e sessione assente non sincronizzino.
- [ ] Testare un evento `online` successivo e la rimozione del listener all'unmount.
- [ ] Separare `syncVerifiedSession(session)` da `listenForReconnect(getSession)`.
- [ ] Catturare gli errori nel nuovo stato sync, non con catch vuoto.
- [ ] Eseguire `cd frontend; npm test -- App syncQueue`.
- [ ] Commit: `fix(sync): run verified sync on session restore and reconnect`.

## Task 4: svuotare tutti i batch e tutte le pagine

**Files:**

- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/sync/syncQueue.test.ts`
- Modify: `frontend/src/pages/ProfilePage.tsx`
- Modify: `frontend/src/pages/ProfilePage.test.tsx`

**Contratto:**

```ts
export interface SyncResult {
  uploaded: number;
  downloaded: number;
  pending: number;
  complete: boolean;
}
```

- [ ] Testare 201 mutation: richieste 100/100/1 e cancellazione solo dopo ogni risposta valida.
- [ ] Testare più pagine server: continuare finché il cursore non avanza più o `hasMore` è false.
- [ ] Aggiungere un limite di sicurezza documentato contro loop infiniti e un errore tipizzato se il cursore non avanza.
- [ ] Fare restituire `SyncResult` a sync e import.
- [ ] Mostrare successo solo con `complete === true`; altrimenti mostrare quanti elementi restano.
- [ ] Eseguire test sync e profilo.
- [ ] Commit: `fix(sync): drain mutation batches and server change pages`.

## Task 5: rendere l'import guest esplicito e completo

**Files:**

- Modify: `frontend/src/sync/syncQueue.ts`
- Modify: `frontend/src/pages/ProfilePage.tsx`
- Modify: `frontend/src/pages/ProfilePage.test.tsx`
- Modify: `frontend/src/sync/syncQueue.test.ts`

- [ ] Testare che login/restore non trasferiscano alcun dato guest.
- [ ] Testare che “Importa dati locali” copi pantry, lotti, staples, dieta, lista e attività nello scope account.
- [ ] Testare retry idempotente dell'import senza duplicati.
- [ ] Rinominare CTA e messaggi per descrivere tutti i dati, non solo la dispensa.
- [ ] Richiedere conferma breve che spieghi merge e assenza di cancellazione locale.
- [ ] Eseguire test profilo, store e sync.
- [ ] Commit: `fix(sync): make guest data import explicit and idempotent`.

## Task 6: eliminare i fallimenti di persistenza silenziosi

**Files:**

- Create: `frontend/src/store/persistenceStatusStore.ts`
- Create: `frontend/src/store/__tests__/persistenceStatusStore.test.ts`
- Modify: `frontend/src/store/localPantryStore.ts`
- Modify: `frontend/src/store/shoppingListStore.ts`
- Modify: `frontend/src/store/activityStore.ts`
- Modify: `frontend/src/store/dietProfileStore.ts`
- Modify: `frontend/src/pages/HomePage.tsx`

**Contratto:**

```ts
type PersistenceState = 'saved' | 'saving' | 'memory-only' | 'sync-pending' | 'sync-error';
```

- [ ] Simulare rejection IndexedDB in ogni store e verificare lo stato `memory-only`.
- [ ] Implementare un helper condiviso che registra dominio, ultimo errore e retry.
- [ ] Mostrare un banner compatto e accessibile con “Riprova”, senza bloccare l'uso locale.
- [ ] Non promettere retry automatici dove non esistono.
- [ ] Verificare recupero dopo un retry riuscito.
- [ ] Eseguire tutte le suite frontend.
- [ ] Commit: `fix(storage): surface persistence and sync failures`.

## Task 7: correggere le date civili di scadenza

**Files:**

- Modify: `frontend/src/domain/pantryLots.ts`
- Modify: `frontend/src/domain/__tests__/pantryLots.test.ts`

- [ ] Aggiungere casi prima/dopo mezzanotte per `Europe/Rome` e un caso DST.
- [ ] Confrontare stringhe ISO `YYYY-MM-DD` o una struttura LocalDate; non convertire la data civile a UTC.
- [ ] Conservare le soglie “scaduto”, “oggi”, “in scadenza”.
- [ ] Eseguire `cd frontend; npm test -- pantryLots`.
- [ ] Commit: `fix(pantry): evaluate expiry as a local calendar date`.

## Gate del piano

```powershell
cd frontend
npm run lint
npm test
npm run test:e2e
npm run build
```

- [ ] Eseguire manualmente: guest → login A → import → logout → login B.
- [ ] Verificare che B non riceva dati/cursore di A e che i dati guest restino locali.
- [ ] Annotare nel piano indice commit e prove.
