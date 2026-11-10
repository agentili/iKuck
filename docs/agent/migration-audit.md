# Audit della migrazione `ikuck-project-context`

## Baseline e decisione

La skill originale conteneva circa 92 KB nel corpo principale oltre a dieci riferimenti tematici. Il suo trigger copriva prodotto, codice, test e deploy: anche un task circoscritto caricava molte istruzioni non pertinenti. Non tutto quel testo era errato, ma era un misto di contesto durevole, runbook, stato di singoli task e diagnosi storiche. La skill e la copia storica sono state successivamente rimosse su richiesta; questa mappa conserva solo la classificazione dei contenuti.

Nuova struttura: `AGENTS.md` è il punto d'ingresso breve; `docs/agent/README.md` seleziona i riferimenti per task. La skill globale non esiste più. I dettagli storici non sono autorità e sono fuori dal percorso predefinito.

## Smistamento dei contenuti

| Sezioni della skill precedente | Destinazione / trattamento |
| --- | --- |
| Obiettivo prodotto, Chef, UX, chat differita, palette e navigazione | `product.md`, `DESIGN.md` e, solo per workflow UX, `references/frontend-ux.md`; mappe e classi storiche non conservate |
| T06, scope casa, migrazione, recovery, contratti condivisi | `data.md`, `docs/shared-households.md`, `shared/src/contracts.ts`; finding e fix puntuali non conservati |
| Ricette AI, provider, consenso, quota e duplicati | `ai.md`, codice/limiti condivisi; procedure puntuali non conservate |
| Test, progress reporting, worktree audit, integrazioni disposable | `verification.md`, `references/worktree-audit.md`; snapshot e comandi riferiti a task specifici non conservati |
| Casa/staging/produzione, S2S, Google auth, versioning e release | `operations.md`, documenti di release e `deploy/`; indirizzi e versioni storici non conservati |
| Workaround Kanban e archiviazione di catene rinunciate | Non sono policy del prodotto; consultare i tool correnti |

## Conflitti verificati da risolvere alla fonte

1. La skill contiene matrici scope incompatibili (pantry-only e casa estesa). `shared/src/contracts.ts` distingue esplicitamente `HOUSE_SYNC_ENTITY_TYPES` e `PERSONAL_SYNC_ENTITY_TYPES`; `docs/shared-households.md` descrive il contratto di prodotto. Non duplicare la matrice in AGENTS.
2. La skill descrive sia una TabBar a cinque voci con redirect `/`→`/pantry`, sia un ingresso Chef su `/`; il codice in `frontend/src/App.tsx` monta `ChatPage` a `/` e `frontend/src/components/layout/BottomNav.tsx` definisce la navigazione. Le mappe della skill non sono affidabili.
3. La skill riporta release/tag dopo il merge, mentre `docs/git-release-policy.md` prescrive il tag prima del merge: serve una decisione esplicita prima della prossima release.
4. La skill riporta versioni staging, commit e IP come se fossero correnti; richiedono verifica live, non vanno copiati in istruzioni permanenti.
5. La skill presenta sia tema unico dark-first sia palette selezionabili. `DESIGN.md` e i token frontend devono essere esaminati per la singola modifica UX.

## Verifica della migrazione

- La skill globale e la copia storica nel progetto sono state rimosse su richiesta. Restano solo due guide specialistiche nel progetto (`references/frontend-ux.md` e `references/worktree-audit.md`) da verificare contro il checkout prima dell'uso.
- `AGENTS.md` rimane sotto 100 righe e rimanda soltanto a una mappa; i documenti tematici non vengono caricati tutti automaticamente. Tutti i link locali della mappa sono stati verificati.
- Nessun cambiamento ad applicazione, servizi o produzione. Prima di intervenire su una delle contraddizioni, aprire una decisione specifica e confrontare codice, documenti e build effettiva.

## Misura successiva, senza cambiare la produzione

1. Scegliere cinque task rappresentativi (una modifica UI, una sync, un problema provider, una review e una diagnosi deploy) con lo stesso checkout e modello/provider. Registrare per ciascuno documenti aperti, rilevanza, errori, token e tempo (`/context all`, `/usage`).
2. Confrontare gli esiti con la baseline pre-migrazione già registrata, se disponibile; non ricreare la skill eliminata solo per un test. Considerare riuscita la migrazione solo se correttezza e rispetto dei vincoli non peggiorano, e il contesto caricato scende per i task circoscritti.
3. Se un caso fallisce per contesto mancante, aggiungere una **breve** nota nel solo documento tematico pertinente con fonte e test; non ripristinare la skill monolitica.
