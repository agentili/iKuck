# Audit completa della repository iKuck — 2026-09-14

## Scopo e attendibilità

Questa audit copre frontend, backend, persistenza locale, sincronizzazione, autenticazione, API, dipendenze, PWA, deployment, backup, test, organizzazione UI e flussi UX.

Le classificazioni usate sono:

- **Confermato**: riprodotto, osservato nell'interfaccia o dimostrato direttamente dal codice.
- **Rischio concreto**: il codice espone il problema, ma manca una riproduzione end-to-end nell'ambiente reale.
- **Lacuna di verifica**: non è corretto dichiarare il comportamento affidabile finché manca la prova indicata.

Non sono stati verificati un VPS reale, DNS/HTTPS pubblici, provider reali, restore di produzione, rollback reale o dispositivi multipli reali. Questi punti restano esplicitamente aperti.

## Baseline verificata

| Area | Comando | Risultato |
|---|---|---|
| Frontend unit/component | `cd frontend; npm test` | 173 test superati in 35 file |
| Frontend lint | `cd frontend; npm run lint` | superato |
| Frontend build/PWA | `cd frontend; npm run build` | superato |
| Frontend coverage | `cd frontend; npm run test:coverage` | 88,41% statements/lines; 82,01% branches |
| Frontend browser | `cd frontend; npm run test:e2e` | 30 superati; 2 production test saltati |
| Backend unit | `cd backend; npm test` | 79 superati; 3 integration test saltati |
| Backend lint | `cd backend; npm run lint` | superato |
| Backend build | `cd backend; npm run build` | superato |
| Backend coverage | `cd backend; npm run test:coverage` | 74,17% statements/lines; 83,43% branches |

La prima esecuzione backend in parallelo ha prodotto un timeout di 5 secondi in `deployment-contract.test.ts`; il test isolato e la suite coverage isolata sono poi passati. È fragilità della suite sotto contesa, non prova di un bug applicativo.

## Sintesi delle priorità

| Priorità | Significato | Quantità |
|---|---|---:|
| P0 | possibile perdita/corruzione dati, contaminazione tra account o vulnerabilità runtime alta | 8 |
| P1 | comportamento errato importante, sicurezza, affidabilità o UX primaria | 27 |
| P2 | qualità, accessibilità, manutenzione o UX secondaria | 8 |

L'ordine operativo vincolante è nel [piano indice](../superpowers/plans/2026-09-14-remediation-index.md).

## Rilievi dettagliati

### Sincronizzazione e persistenza locale

| ID | Priorità | Stato | Rilievo ed evidenza | Correzione prevista |
|---|---|---|---|---|
| SYNC-01 | P0 | Confermato dal codice | Coda e cursore non sono associati all'utente. `frontend/src/sync/syncQueue.ts` usa metadati globali e le mutation non contengono uno scope account/guest. Dati ospite possono quindi essere inviati all'account attivo dopo un evento `online`; un cursore di un utente può far saltare modifiche di un altro. | Migrazione IndexedDB con scope `guest` e `account:<userId>`; mai caricare automaticamente la coda legacy. |
| SYNC-02 | P0 | Confermato dal codice | `syncPromise` è globale: un cambio account durante una sincronizzazione può riutilizzare/applicare il risultato della sessione precedente. | Lock e promise per user ID, con verifica della sessione prima di applicare la risposta. |
| SYNC-03 | P0 | Confermato dal codice | `syncOnReconnect()` registra solo `online`; all'avvio già online o dopo il login non esegue la sincronizzazione iniziale. | Sincronizzazione esplicita su session restore/login e listener per i reconnect successivi. |
| SYNC-04 | P0 | Confermato dal codice | Viene inviato un solo batch da 100 mutation e letto un solo blocco da 200 change. `importLocalData()` può mostrare successo lasciando elementi in coda. | Ciclo bounded fino a coda e paginazione esaurite; risultato con conteggi e stato parziale. |
| SYNC-05 | P1 | Confermato dal codice | Molte scritture IndexedDB e sync terminano con `catch(() => undefined)`. L'interfaccia non distingue “salvato”, “solo in memoria” e “in attesa”. | Stato centralizzato di persistenza/sync, errore visibile e retry. |
| SYNC-06 | P1 | Rischio concreto | Il server accetta `clientUpdatedAt` per il last-write-wins. Un orologio molto avanti può rendere una mutation dominante a tempo indefinito. | Tolleranza allo skew, timestamp server e test multi-device. |
| SYNC-07 | P1 | Confermato dal codice | `syncSchema.parse()` e il mismatch `userId` producono errori generici; l'handler globale li può trasformare in 500 invece di 400. | `safeParse`, errore API tipizzato e test di contratto. |
| SYNC-08 | P1 | Rischio concreto | Alcuni payload di mutation vengono convertiti con cast non sicuri e gli upsert non hanno una validazione di dominio uniforme. | Schema discriminato condiviso e validazione prima di accodare/applicare. |
| SYNC-09 | P1 | Confermato dal codice | Le date di scadenza usano il giorno UTC, mentre l'utente inserisce una data locale. Vicino alla mezzanotte europea lo stato può slittare di un giorno. | Confronto su `LocalDate`/data civile e test con timezone esplicita. |

### Autenticazione, sicurezza e integrità dati

| ID | Priorità | Stato | Rilievo ed evidenza | Correzione prevista |
|---|---|---|---|---|
| AUTH-01 | P0 | Confermato dal codice | Ogni restore di sessione ruota l'unico hash CSRF. Due tab che ripristinano la stessa sessione si invalidano a vicenda. | Token CSRF stabile per sessione o modello multi-token; test con due tab/token. |
| AUTH-02 | P0 | Confermato dal codice | Creazione utente+profilo, nuovo utente Google+identity e consumo reset password sono operazioni multi-step non atomiche. Il reset token può essere consumato due volte in concorrenza. | Transazioni e update condizionale con `RETURNING`. |
| AUTH-03 | P1 | Confermato dal codice | Login, registrazione, resend e reset non hanno rate limit dedicato. | Limiti Redis per IP e identità normalizzata, risposte non enumerabili. |
| AUTH-04 | P1 | Rischio concreto | La verifica e-mail modifica stato tramite GET; scanner e anteprime dei link possono consumare il token. | GET di landing più POST esplicito oppure flusso idempotente scanner-safe. |
| AUTH-05 | P1 | Confermato dal codice | Token di verifica/reset restano nella URL dopo la lettura. | Cattura e rimozione immediata con `history.replaceState`. |
| AUTH-06 | P1 | Confermato dal codice | `SESSION_SECRET` è obbligatorio e documentato ma non viene usato dal server. È una falsa garanzia operativa. | Usarlo con uno scopo crittografico dichiarato o rimuoverlo dal contratto. |
| AUTH-07 | P2 | Rischio concreto | Il cookie non espone `Max-Age`/`Expires` pur avendo una TTL server; inoltre token/sessioni scaduti non hanno una pulizia documentata. | Decisione di prodotto esplicita, test cookie e maintenance job. |
| DEP-01 | P0 | Confermato dall'audit dipendenze | Il runtime backend usa una versione di `drizzle-orm` coinvolta nell'advisory high GHSA-gpj5-g38j-94v9. Nel codice attuale non è stato provato uno sfruttamento, ma la dipendenza va aggiornata. | Upgrade controllato ad almeno 0.45.2 con test query/migrazioni. |
| DEP-02 | P1 | Confermato dall'audit dipendenze | Il tooling frontend/backend contiene advisory Vite/Vitest/esbuild, inclusi due critical nel solo albero dev frontend. Il runtime frontend con `--omit=dev` è pulito. | Upgrade major separato, lockfile review e suite completa. |

### API, provider e I/O di rete

| ID | Priorità | Stato | Rilievo ed evidenza | Correzione prevista |
|---|---|---|---|---|
| IO-01 | P1 | Confermato dal codice | Resend, USDA e OpenAI eseguono `fetch` senza timeout/abort comune. Una connessione bloccata può occupare richieste e risorse. | Wrapper fetch con timeout, AbortSignal e classificazione errori. |
| IO-02 | P1 | Confermato dal codice | La quota AI viene consumata prima della risposta provider; un errore esterno consuma comunque una generazione. | Reservation atomica con commit su successo e release su errore. |
| IO-03 | P2 | Confermato dal codice | La factory provider non inoltra il `fetch` iniettato a Resend, rendendo test e comportamento meno coerenti. | Iniezione uniforme per tutti gli adapter. |
| IO-04 | P2 | Confermato nei test browser | Gli E2E locali generano numerosi `ECONNREFUSED` attesi verso il backend non avviato. I test passano, ma il rumore può nascondere errori reali. | Stub espliciti per modalità offline e suite live-stack distinta. |

### UI, UX e accessibilità

| ID | Priorità | Stato | Rilievo ed evidenza | Correzione prevista |
|---|---|---|---|---|
| UX-01 | P0 | Misurato a 390×844 | Il CTA primario “Trova ricette” è a circa 3613 px dall'alto, dopo 46 elementi focalizzabili; la sezione dispensa misura circa 3208 px. | Portare ricerca e CTA all'inizio della pagina. |
| UX-02 | P1 | Osservato | Il pannello account occupa circa 190 px prima dell'azione principale e ripete informazioni presenti nel profilo. | Header/nav compatto; account completo nella pagina profilo. |
| UX-03 | P1 | Osservato | Allergeni, dettagli lotti e altri controlli secondari sono tutti espansi, creando quasi quattro schermate prima della ricerca. | Pannelli correlati chiusi di default con stato e nomi accessibili. |
| UX-04 | P1 | Confermato dal codice | Il logout usa una catena senza `catch`: se la richiesta fallisce, lo store si pulisce ma la navigazione non avviene e resta una rejection non gestita. | `try/finally`, navigazione garantita e messaggio coerente. |
| UX-05 | P1 | Confermato dal testo | Il messaggio offline promette che l'operazione “verrà riprovata”, ma save/import/delete non hanno una retry queue. Il successo import parla solo di dispensa pur importando più domini. | Copy aderente al comportamento e risultato dettagliato. |
| UX-06 | P1 | Osservato | Nel dettaglio ricetta appare `Dati incompleti: mancano sodium`; l'identificatore inglese non è localizzato. | Dizionario di nutrienti e fallback leggibile. |
| UX-07 | P1 | Confermato dal layout | “La tua esperienza” interrompe il flusso tra introduzione e lista ingredienti, prima del contenuto necessario a cucinare. | Ordine: sintesi, ingredienti, preparazione, esperienza/nutrizione secondaria. |
| UX-08 | P1 | Confermato dal markup | `role="tablist"` è usato con normali button privi di `role="tab"`, `aria-selected` e relazione al pannello. | Implementare il pattern completo o rimuovere il ruolo. |
| UX-09 | P1 | Osservato | Al primo caricamento locale il service worker ha servito una shell precedente; un reload ha caricato la build corrente. | Prompt di aggiornamento PWA, versione visibile e test update. |
| UX-10 | P2 | Confermato dal router | Le route sconosciute vengono reindirizzate silenziosamente alla home, mentre `NotFoundPage` esiste ma è usata solo per ricette mancanti. | 404 esplicita con recupero. |
| UX-11 | P2 | Confermato dal comportamento | Eliminazioni di lotti, attività, lista e ricette AI sono immediate e senza undo. | Toast undo per azioni locali reversibili; dialog solo per azioni irreversibili. |
| UX-12 | P2 | Confermato dal rendering | Il pulsante rating usa anche `1 stelle` invece di `1 stella`. | Pluralizzazione italiana testata. |
| UX-13 | P2 | Rischio concreto | Mancano gate automatici axe/zoom/reduced-motion e diversi componenti non hanno test di pagina. | Audit WCAG mirata e test automatici dei flussi principali. |

### Deployment, operazioni e organizzazione repository

| ID | Priorità | Stato | Rilievo ed evidenza | Correzione prevista |
|---|---|---|---|---|
| OPS-01 | P1 | Confermato dalla configurazione | Caddy imposta alcuni header ma non CSP e HSTS. | Policy CSP compatibile, HSTS solo su HTTPS verificato e test header. |
| OPS-02 | P1 | Confermato dalla configurazione | Il container API non dichiara un utente non-root; hardening filesystem/capabilities non è esplicito. | Utente non-root, filesystem read-only dove possibile, tmpfs e cap drop. |
| OPS-03 | P1 | Confermato dagli script | Il backup scrive direttamente nel file finale e non produce checksum/verifica strutturale. Il restore non esegue backup preventivo, drain o verifica post-restore. | File temporaneo, verifica, rename atomico, checksum e restore rehearsal. |
| OPS-04 | P1 | Confermato dalla repository | Non esiste una pipeline CI né un comando root unico; frontend e backend possono essere verificati solo separatamente. | Script root/CI con lint, test, build, audit e integrazione disponibile. |
| DOC-01 | P1 | Confermato | `GEMINI.md` descrive Supabase, TanStack Query e una struttura non più esistente. Può guidare un agente verso modifiche errate. | Sostituirlo con istruzioni correnti e aggiungere `AGENTS.md`. |
| TEST-01 | P1 | Confermato dalla coverage | `App.tsx`, `main.tsx`, `ActivityPage.tsx` e `ShoppingListPage.tsx` risultano non coperti; auth/sync/repository hanno gap importanti. | Copertura basata sui rischi, non inseguimento percentuale cieco. |
| TEST-02 | P1 | Lacuna di verifica | Tre test backend di integrazione e due E2E production sono saltati; VPS/provider/restore/rollback non sono provati. | Ambiente disposable in CI e checklist staging separata. |
| DOC-02 | P2 | Confermato | Vecchi piani contengono checkbox aperte per lavoro che in parte è già presente. Senza un indice si rischia di rieseguire task obsoleti. | Usare il nuovo indice come fonte di verità e archiviare/annotare i piani superati. |

## Aspetti già buoni da preservare

- Il modello guest-first continua a funzionare senza backend.
- La separazione frontend/backend e i contratti di dominio sono leggibili.
- Le suite unit/component sono ampie e attualmente verdi.
- Il runtime frontend non presenta vulnerabilità note nell'audit npm corrente.
- PostgreSQL e Redis sono mantenuti nella rete interna Compose.
- Shopping list e stato vuoto attività risultano semplici e leggibili su mobile.

## Criterio di chiusura dell'audit

Un rilievo può essere marcato risolto solo quando:

1. esiste un test rosso che dimostra il difetto o il contratto mancante;
2. la modifica minima rende verde il test;
3. lint, test e build dell'area interessata passano;
4. per UI/UX è allegata una verifica mobile e desktop;
5. il piano indice contiene commit, comandi eseguiti e prove;
6. nessun limite esterno viene presentato come verificato senza evidenza reale.
