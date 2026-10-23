# llm-choice: Elenco puntato dispensa per sottogruppi di categoria

Decisione documentata per trasparenza (skill sviluppo-strutturato FASE 2).

| Ruolo | Modello | Provider | Rationale |
|-------|---------|----------|-----------|
| Planning/architettura | nvidia/nemotron-3.5-super-vl:free | openrouter | Modello attivo della chat; task UI di complessità medio-bassa, nessun contratto nuovo |
| Esecuzione (codice, test, refactor) | diretta sull'agente Hermes (modello corrente: nvidia/nemotron-3.5-super-vl:free, openrouter) | openrouter | Task < 300 LOC, responsabilità singola, spec completa |
| Review indipendente | subagent separato via `delegate_task` (reviewer che non ha scritto il codice) | openrouter | FASE 6 skill sviluppo-strutturato; Go/No-Go richiesto prima del Done |

Nessun modello fuori lista.
