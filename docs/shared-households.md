# Condivisione della casa — scope e import account

Questo documento descrive il contratto applicativo corrente per la condivisione della casa.

## Matrice degli scope

### Casa — sincronizzati e condivisi con tutti i membri

- `pantry_item`
- `pantry_lot`
- `staple_preference`
- `shopping_list_item`
- `cook_event`
- `recipe_preference`
- `diet_profile`
- `generated_recipe`
- `dinner_entry`
- `saved_recipe`

`diet_profile` è un unico profilo della casa: l'import conserva l'unione degli allergeni esclusi, la dieta più restrittiva e i vincoli nutrizionali più cautelativi. Le ricette generate diventano dati condivisi soltanto con il salvataggio esplicito.

### Account — personali

- `ai_consent`
- identità e profilo account;
- autenticazione, sessioni, credenziali;
- bozze e anteprime AI non salvate.

### Guest

I dati guest sono dati locali del dispositivo, non prova di proprietà dell'account o della casa. L'import guest resta esplicito; per la dispensa usa il merge semantico e conserva i dati locali finché il server non conferma l'operazione.

## Import della coda account pendente

Una mutazione offline creata prima dell'ingresso in casa conserva il suo scope originario `account:<userId>`. Non viene ricollocata nella coda `house:<houseId>` e non viene inviata come normale upsert house-scoped: il replay LWW diretto potrebbe sovrascrivere restrizioni del profilo o sostituire un lotto appartenente a un altro membro.

Il client invia batch di massimo 100 mutazioni condivise a `POST /v1/house/account-queue/import`. La route richiede stessa origine, sessione verificata, CSRF valido, membership attuale e scope esatto `account:<session.userId>`; rifiuta entità personali, scope di un altro account e richieste senza una casa attiva. La route non autorizza il client a scegliere la casa.

Il repository, nella stessa transazione PostgreSQL:

1. valida e registra le mutazioni pendenti nello scope account originale;
2. applica la migrazione semantica di tutti i dati funzionali eleggibili;
3. trasferisce o risolve i conflitti house-side e rimuove le sorgenti account solo dopo la risoluzione;
4. commit del batch oppure rollback completo in caso di errore.

Una risposta `204` è l'acknowledgement: soltanto allora il client elimina dalla coda account le mutazioni del batch. Se la richiesta fallisce o la risposta si perde, il client conserva la coda e riprova; ricevute mutation e marker semantici rendono sicuro il replay. Il consenso AI resta account-scoped.

`/v1/sync` mantiene il confine di sicurezza ordinario: dopo l'ingresso in casa una mutazione funzionale con scope account stale è rifiutata dal repository/route; non viene rimappata silenziosamente alla casa. Il solo percorso ammesso per la coda già esistente è l'import autenticato sopra.

## Lotti della dispensa: collisioni, revisioni e delete

Gli ID dei lotti sono locali alla sorgente. Membri e dispositivi diversi possono usare lo stesso ID. Prima del merge le collisioni sono re-keyed, poi i lotti semanticamente equivalenti vengono aggregati; non si usa l'ID grezzo come identità globale della casa.

I marker di deduplica sono namespaced per account e sorgente, così un marker di un altro membro sullo stesso dispositivo non nasconde una quantità distinta. Per un lotto account già migrato, un marker stabile per account e ID del lotto conserva la revisione sorgente anche se una revisione successiva arriva da un altro dispositivo. Una revisione sostituisce soltanto il precedente contributo di quella sorgente; un delete rimuove quel contributo e conserva quelli degli altri membri. I retry non sommano di nuovo il medesimo lotto.

I confronti delle revisioni usano tempi come istanti e l'ordinamento deterministico della mutazione; non il confronto lessicografico delle stringhe ISO.

## Autorizzazione

La membership attuale viene risolta lato server per ogni lettura e scrittura e ricontrollata sotto il lock della casa. `houseId` fornito dal client non è prova di appartenenza. Tutti i membri possono creare, aggiornare ed eliminare record funzionali della casa; `authorId` è solo attribuzione, mai ACL.
