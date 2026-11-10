# Ricette AI e consenso

- Separare **generazione privata**, **anteprima sul dispositivo** e **salvataggio esplicito**: generare non deve scrivere automaticamente una ricetta persistente. Verifica route e test correnti prima di cambiare questo contratto.
- Per ogni invio al provider, preservare sessione verificata, origine/CSRF, consenso valido per il provider e il flusso interessato, quota e revoca. Il consenso Dinner non si deduce da quello Home. Una revoca riconosciuta deve impedire nuovi invii privati, incluse le retry.
- Per incidenti del provider, seguire la richiesta dal pannello alla route e all'adapter effettivi; classificare prima i rifiuti locali, poi gli errori di rete/provider. Una risposta di `/healthz` non prova il funzionamento del provider. Non stampare segreti o dati dell'utente.
- Limiti e tipi condivisi sono definiti in `shared/src/limits.ts` e `shared/src/contracts.ts`. Non trasferire valori numerici hardcoded o nomi di modello dalla skill storica.
- Prima di dichiarare funzionante una modifica di consenso o provider, verificare anche la copia utente, i test delle route, i test con PostgreSQL/Redis disposable e il percorso browser effettivo. Un test saltato non è un gate verde.

Per i casi limite, consulta i test e le route correnti: l'archivio della skill precedente è stato rimosso.
