# llm-choice: Redesign ShoppingListPanel

Decisione documentata per trasparenza (skill sviluppo-strutturato FASE 2).

Contesto: in room il team ha concordato l'uso di `nvidia/nemotron-3.5-super-vl:free` su openrouter per tutti i partecipanti. Il redesign è un'attività di implementazione frontend guidata direttamente da @fdev (senza delega a subagent), quindi non si applica il modello di delega executor-flash/reviewer-sol della skill; la review indipendente spetta a @reviewer.

| Ruolo | Modello | Provider | Rationale |
|-------|---------|----------|-----------|
| Planning/architettura | nvidia/nemotron-3.5-super-vl:free | openrouter | Pin del team; complessità bassa (redesign componente esistente, nessun contratto nuovo) |
| Esecuzione (codice, test, refactor) | nvidia/nemotron-3.5-super-vl:free | openrouter | Pin del team; task < 200 LOC, responsabilità singola, spec completa |
| Review indipendente | @reviewer (stanza di gruppo) | — | Chi non ha scritto il codice, come da FASE 6; modello di review a discrezione del reviewer (pin review t_ae8f97b1: nemotron/openrouter, come concordato in room) |

Nessun modello fuori lista. Se il reviewer richiedesse un cambio di modello, si negozia in room prima di procedere.
