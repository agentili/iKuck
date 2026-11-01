# Migrazione API v1: `sync_scope_invalid` da HTTP 400 a 409

## Modifica del contratto

La risposta `SyncScopeInvalidError` cambia da **HTTP 400 Bad Request** a **HTTP 409 Conflict**. Il cambiamento riguarda tutte le route che espongono questa stessa classe:

| Endpoint | Condizione | Prima | Ora | Codice JSON |
|---|---|---:|---:|---|
| `POST /v1/sync` | Mutation o `supportedEntityTypes` incompatibili con account/house scope | 400 | 409 | `sync_scope_invalid` |
| `POST /v1/house/account-queue/import` | Entità non house-condivisa o scope diverso da `account:<session.userId>` | 400 | 409 | `sync_scope_invalid` |
| `POST /v1/house/diet-profile/import` | Mutation non valida come import guest di `diet_profile/profile` upsert senza scope | 400 | 409 | `sync_scope_invalid` |

Il body JSON e il valore di `code` non cambiano. Per `/v1/sync`, le richieste legacy che omettono `supportedEntityTypes` mantengono il comportamento di default: lettura filtrata secondo lo scope server-side. Le richieste esplicite con tipi incompatibili restano rifiutate. Le verifiche di same-origin, sessione verificata, CSRF, membership e allowlist di scope non vengono indebolite.

## Impatto e compatibilità

È una modifica breaking per un consumer che decide il comportamento esclusivamente da `status === 400` o che considera un `409` sconosciuto. Non è una modifica puramente additiva e non va descritta come tale.

La versione web inclusa nel candidato è compatibile con entrambi gli status: `apiRequest` conserva `status` e `code`; `syncVerifiedSession` non usa il 400 per gestire `sync_scope_invalid`; la coda non elimina le mutation e non avanza il cursore dopo un errore, e il codice non innesca il purge riservato alla perdita di membership. Dopo la correzione del problema di scope, una nuova sync può ritentare e svuotare la coda solo a risposta valida. Il comportamento è coperto da test per 400 e 409.

La compatibilità non si estende ai client esterni o alle vecchie build che richiedono espressamente 400. Per loro non esiste una risposta duale o un endpoint alternativo nel candidato.

## Azione richiesta ai consumer

1. Aggiornare il client prima di affidarsi a questo contratto; identificare l'errore dal JSON `code === "sync_scope_invalid"`, accettando `400` durante il rollout e `409` a regime.
2. Non classificare questo codice come perdita di membership. Non cambiare automaticamente `account:<id>` in `house:<id>`, non cancellare dati e non rimuovere mutation dalla coda.
3. Fermare il retry automatico dello stesso batch finché scope o contenuto non sono corretti; conservare cursore e outbox. Usare `GET /v1/house` per confermare la membership corrente.
4. Per mutation condivise account pendenti dopo l'ingresso in casa, usare l'import autenticato `POST /v1/house/account-queue/import`; non riprodurle come upsert house-scoped. Le entità personali restano account-scoped.
5. Se il consumer non può essere aggiornato prima del server, **non rilasciare** il candidato a quel consumer: mantenere il vecchio status `400` oppure pubblicare una nuova major API version prima di cambiare il contratto.

## Verifica

I test di route verificano status e codice JSON per `/v1/sync` e gli endpoint di import house. I test client verificano la decodifica del codice per HTTP 400/409 e che la coda/cursore restino invariati sull'errore, con replay riuscito solo dopo risposta valida. I gate e le prove saltate devono essere riportati separatamente nella review del candidato.

Contratto API versionato: [`../api/v1.md`](../api/v1.md).
