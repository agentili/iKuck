# Plan: Elenco puntato dispensa per sottogruppi di categoria

## Scelta modello (FASE 2)
Vede `llm-choice-pantry-list-grouped.md`.

## Macro-attività
| # | Attività | Input | Output | Sforzo | Dipende da |
|---|----------|-------|--------|--------|------------|
| 1 | Understanding | richiesta utente, PantryPage esistente, shared/src/ingredients.ts, DESIGN.md | understanding.md | S | - |
| 2 | Piano + scelta modello | understanding.md | plan.md, llm-choice.md | S | 1 |
| 3 | Kanban board + task | plan.md | card + task esecutivo/review | S | 1 |
| 4 | Test RED (elenco puntato, sottogruppi italiani, item ancora rimovibili) | test esistenti PantryPage | PantryPage.test.tsx esteso (RED) | M | 3 |
| 5 | Implementazione (GREEN) | test RED, `getIngredient` di @ikuck/shared/ingredients | `PantryPage.tsx` modificato | M | 4 |
| 6 | Refactor + regressione | test verdi | lint/build/test verdi | S | 5 |
| 7 | Playwright /pantry (core-flow, production-smoke, accessibility, pantry-candidates) | build | E2E verdi | S | 6 |
| 8 | Review indipendente | diff completo + test | verdetto GO/NO-GO | S | 7 |
| 9 | Fix eventuali (se NO-GO) | findings review | task fix + riesecuzione gate | M | 8 |

## Decisioni architetturali (ADR)
- **ADR-001**: niente cambi a `usePantryStore`, contratti `@ikuck/shared`, rotte API, label/role accessibili. Solo markup di `PantryPage.tsx` più helper di raggruppamento locale.
- **ADR-002**: la categoria di ogni ingrediente deriva da `getIngredient(id)` in `@ikuck/shared/ingredients` (categorie: staple, grain, meat, fish, egg, legume, vegetable, dairy). Gli item personalizzati sconosciuti (id `custom:...`) finiscono in "Altri ingredienti".
- **ADR-003**: etichette sottogruppo in italiano — Ingredienti di base, Pasta e cereali, Carne, Pesce, Uova, Legumi, Verdura, Latticini e formaggi, Altri ingredienti. Ordine fisso: Verdura, Carne, Pesce, Pasta e cereali, Uova, Legumi, Latticini e formaggi, Ingredienti di base, Altri ingredienti (segue gli esempi dell'utente per le categorie esistenti). Gruppi vuoti non renderizzati. "Frutta" non è una categoria del catalogo attuale (il limone è verdura), quindi nessun gruppo dedicato.
- **ADR-004**: si riutilizza `IngredientChip` inalterato dentro ogni `<li>` del sottogruppo (rimozione e badge preservati).

## Task Kanban da creare
- Card principale: "iKuck: elenco puntato dispensa per sottogruppi di categoria" (assignee: hermes)
- Task esecutivo: "Implementa elenco puntato raggruppato + test PantryPage" (assignee: executor, dipende dalla card)
- Task review: "Review indipendente elenco puntato dispensa" (assignee: reviewer, dipende dal task esecutivo)
