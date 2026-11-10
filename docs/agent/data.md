# Dati, sync e casa

## Autorità e confini

- `shared/src/contracts.ts` contiene gli esatti `SYNC_ENTITY_TYPES`, `HOUSE_SYNC_ENTITY_TYPES` e `PERSONAL_SYNC_ENTITY_TYPES`. Non derivare la matrice da vecchie skill o memoria. Verifica anche i consumer, i repository e le route prima di aggiungere o spostare un tipo.
- La condivisione della casa e l'import dei dati sono descritti in `docs/shared-households.md`; risolvi eventuali discrepanze con contratto, implementazione e decisione approvata, non con una lista copiata.
- `ai_consent` è personale nel contratto attuale. Identità, credenziali, sessione e cookie non diventano dati della casa. L'import dei dati guest richiede conferma esplicita; non reinterpretarlo come import automatico.
- Per la sync preserva il controllo della membership verificata sul server, gli scope account/casa, i cursori separati e le barriere di revoca e migrazione. Testa i casi di concorrenza contro PostgreSQL/Redis usa-e-getta, oltre ai test in memoria.
- Gli schemi backend richiedono la relativa migrazione Drizzle; compilare il TypeScript non applica una modifica al database. Le versioni client precedenti devono essere considerate durante i cambi di contratto e la paginazione.

La skill storica contiene una vecchia matrice pantry-only e una matrice casa estesa: **non selezionare una delle due per intuizione**. Il contratto corrente enumera esplicitamente i tipi della casa e quello personale.
