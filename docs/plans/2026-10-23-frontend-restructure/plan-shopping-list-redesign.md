# Plan: Redesign ShoppingListPanel (lista della spesa)

## Scelta modello (FASE 2)
- Planning ed esecuzione: diretta sul profilo @fdev (senza subagent), modello impostato dal team su `nvidia/nemotron-3.5-super-vl:free` (provider openrouter), come deciso in room.
- Review indipendente: @reviewer (GPT 6.1 Sol / codice non scritto da chi implementa), come da skill sviluppo-strutturato FASE 6.

## Macro-attività
| # | Attività | Input | Output | Sforzo | Dipende da |
|---|----------|-------|--------|--------|------------|
| 1 | Understanding | richiesta utente, prototipo @architect, DESIGN.md, componente esistente | understanding.md | S | - |
| 2 | Piano + scelta modello | understanding.md | plan.md, llm-choice.md | S | 1 |
| 3 | Kanban card + task | plan.md | card t_a256f340 (già creata) | S | 1 |
| 4 | Test RED (count chip, sezione Acquistati toggle, editor al click, stato vuoto, clear-bar, undo toast) | DESIGN.md, test esistenti | ShoppingListPanel.test.tsx aggiornato | M | 3 |
| 5 | Implementazione redesign (GREEN) | test RED, token --ik-*, prototipo | ShoppingListPanel.tsx riscritto | M | 4 |
| 6 | Refactor + verifica regressioni | test verdi | componenti puliti, lint/build/test verdi | S | 5 |
| 7 | Playwright su /shopping-list (core-flow + accessibility) | build | E2E verdi | S | 6 |
| 8 | Request review indipendente | consegna completa | card in Review | S | 7 |

## Decisioni architetturali (ADR)
- **ADR-001**: nessuna modifica a `ShoppingListPanelProps`, a `ShoppingListPage`, a `@ikuck/shared/contracts` e agli label accessibili — il redesign è solo markup/Tailwind/stati interni del componente.
- **ADR-002**: i token visuali usano le CSS custom property esistenti (`--ik-basil`, `--ik-sage`, `--ik-porcelain`, `--ik-ink`, `--ik-ink-muted`, `--ik-border`, `--ik-border-strong`, `--ik-surface`, radii `--ik-radius-*`) invece di colori hardcoded; nulla di nuovo entra in DESIGN.md.
- **ADR-003**: lo stato aperto/chiuso della sezione "Acquistati" è stato UI locale (`useState`), non persistenza — la semantica di acquisto resta nello store Zustand/IndexedDB.

## Task Kanban da creare
- Nessuna task ulteriore: implementazione eseguita direttamente da @fdev su questa card; review richiesta via `kanban_request_review` al completamento.
