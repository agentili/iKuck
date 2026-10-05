# S2S amministrativo (locale)

Il CLI opera direttamente sul database configurato da `DATABASE_URL` (oppure `.env` in sviluppo), non espone endpoint HTTP e non stampa credenziali.

```sh
npm --prefix backend run build
npm --prefix backend run s2s-admin -- provision --service hermes-family-pantry-reader --house HOUSE_UUID --sponsor-user USER_UUID --sponsor-membership MEMBERSHIP_UUID --out /percorso/privato/dinner-credential.json
npm --prefix backend run s2s-admin -- rotate --grant GRANT_UUID --out /percorso/privato/dinner-credential-next.json --expires-in-days 30
npm --prefix backend run s2s-admin -- recover --file /percorso/privato/dinner-credential.json
npm --prefix backend run s2s-admin -- revoke --grant GRANT_UUID
```

`provision` richiede l'UUID della specifica membership admin dell'account sponsor verificato; non sceglie un utente. La cartella di destinazione deve appartenere all'utente corrente e non concedere accesso a gruppo/altri. Il file viene creato una sola volta con permessi 0600 e non viene sovrascritto. Conservare il file in un secret store protetto e rimuoverlo in modo sicuro secondo le procedure locali. Provisioning e rotazione scrivono prima un file privato `pending`; in caso di errore DB la CLI riconcilia il keyId con il digest segreto usando un advisory lock condiviso con la transazione. Se il commit è riuscito, aggiorna il file con grantId e scadenza effettiva; se il rollback è confermato rimuove il file; se il DB non è raggiungibile o l'esito resta incerto, conserva `outcome: unknown` senza dichiarare effettiva la scadenza richiesta. Dopo il ripristino del DB, riconciliare il file senza creare un nuovo grant con `npm --prefix backend run s2s-admin -- recover --file /percorso/privato/dinner-credential.json`. Il recupero accetta soltanto file privati `pending`/`unknown` e non stampa il token. Quando la riconciliazione dimostra che non esiste una riga di credenziale committata, conserva il file privato con `outcome: unknown`, segnala il recupero incompleto con un errore sanificato ed esce con codice diverso da zero: non dichiara il successo e non elimina il file. La CLI rimuove il file soltanto quando il rollback dell'operazione originaria è confermato. La creazione del grant consegna il `grantId` non segreto nel file e nell'output. Scadenza massima 90 giorni; la rotazione applica le regole di overlap e cardinalità nel repository. La revoca del grant è idempotente.

Non passare mai token come argomenti, variabili di shell visibili, log o chat. Il database conserva soltanto il digest del segreto. Non eseguire questo comando contro produzione senza la procedura e autorizzazione operative appropriate.
