# Understanding: Elenco puntato della dispensa per sottogruppi di categoria

## Obiettivo
Cambiare la lista degli ingredienti nella pagina `/pantry` (`PantryPage`) dall'attuale elenco orizzontale di chip (`flex flex-wrap gap-2`) a un elenco puntato verticale raggruppato per sottogruppi di categoria alimentare (tipo "Frutta, Verdura, Carne, Pesce, Pasta, etc."), con etichette dei sottogruppi in italiano.

## Perché
Oggi tutti gli ingredienti appaiono in una sequenza piatta difficile da scansionare quando la dispensa si popola. Raggruppare per categoria rende la dispensa più leggibile e veloce da consultare, senza cambiare come si aggiungono o rimuovono gli ingredienti.

## Definition of Done
- [ ] `understanding-pantry-list-grouped.md`, `plan-pantry-list-grouped.md`, `llm-choice-pantry-list-grouped.md` scritti nella radice del repo iKuck
- [ ] Card Kanban creata con task esecutivo e task review in board
- [ ] Test Vitest per il nuovo comportamento scritto PRIMA del codice (RED osservato, poi GREEN): `frontend/src/pages/PantryPage.test.tsx`
- [ ] Comportamenti esistenti preservati: aggiunta ingredienti, stato vuoto, caricamento, conflitti di persistenza, ruolo e label accessibili (`list` "La tua dispensa", input "Ingredienti presenti", link "Vai alle ricette", chip di rimozione, badge "Non ancora usato nelle ricette")
- [ ] `npm --prefix frontend run lint`, `npm --prefix frontend run build`, `npm --prefix frontend test -- PantryPage` verdi
- [ ] E2E `/pantry` non regressiate (core-flow, production-smoke, accessibility, pantry-candidates)
- [ ] Review indipendente GO ottenuta prima del Done
- [ ] Nessun deploy: il lavoro rimane su branch di feature fino ad autorizzazione esplicita

## Vincoli
- Tech stack: React 18, Vite, Tailwind, TypeScript strict, Zustand, vitest + @testing-library, Playwright
- Codice e commenti in inglese; copy utente in italiano
- Nessun cambio a `@ikuck/shared/contracts`, rotte API, store Zustand (`usePantryStore`), label/role accessibili esistenti
- Nessun secret/PII nel codice
- Nessun deploy senza autorizzazione esplicita dell'utente

## Rischi noti
- Cambiare il markup della lista potrebbe toccare selettori E2E/accessibilità: mitigato preservando `aria-label="La tua dispensa"` sul ruolo `list` esterno e i label esistenti
- L'elenco annidato (gruppo → elementi) moltiplica i ruoli `list`: solo l'elenco esterno mantiene il nome accessibile, i sottogruppi non ne hanno uno
- "Frutta" non esiste come categoria nel catalogo attuale (`shared/src/ingredients.ts`, il limone è classificato come verdura): nessun gruppo vuoto renderizzato, nessuna categoria inventata
