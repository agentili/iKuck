# Understanding: Redesign ShoppingListPanel (lista della spesa)

## Obiettivo
Rendere la lista della spesa meno "piatta" e più user-friendly, partendo dal prototipo cliccabile definito da @architect (`/home/hermes/.hermes/profiles/architect/cache/scratch/shopping-list-redesign.html`, già verificato strutturalmente): superficie Operate con barra di aggiunta rapida, conteggio "X da acquistare" in header, sezioni "Da acquistare" / "Acquistati" (questa ultima toggle mostra/nascondi), editor dei dettagli aperto al click su "Modifica", toast con "Annulla" dopo rimozione, stato vuoto illustrato.

## Perché
Il componente attuale è funzionale ma visivamente generico (tinte grigie, editor sempre aperto, nessun conteggio in header). Il redesign allinea la pagina al sistema di design iKuck (DESIGN.md, token CSS `--ik-*`, Bricolage Grotesque, palette porcelain/ink/basil/sage/yolk/tomato) migliorando gerarchia, feedback e scansione rapida senza cambiare contratti, prop o label accessibili.

## Definition of Done
- [ ] `understanding.md`, `plan.md`, `llm-choice.md` nello workspace della Kanban card `t_a256f340`
- [ ] Test Vitest per i nuovi comportamenti scritti PRIMA del codice (RED osservato, poi GREEN)
- [ ] Comportamenti esistenti preservati: aggiunta, toggle acquistato, rimozione, ripristino undo, svuota acquistati, modifica dettagli, lista vuota
- [ ] Label accessibili e role invariati (nessuna regressione su E2E core-flow e accessibility di `/shopping-list`)
- [ ] `npm run lint`, `npm run build`, `npm test -- ShoppingListPanel` verdi
- [ ] Playwright `core-flow.spec.ts` (shopping list) e `accessibility.spec.ts` passano
- [ ] Card spostata in Review e indipendente GO/NO-GO ottenuto prima del Done

## Vincoli
- Tech stack: React 18, Vite, Tailwind, TypeScript strict, Zustand, vitest + @testing-library, Playwright
- Stesse prop di `ShoppingListPanelProps`; `ShoppingListPage` non cambia
- Nessun secret/PII nel codice; copy in italiano; codice e commenti in inglese
- Nessun deploy: lavoro rimane nel branch/workspace fino a autorizzazione

## Rischi noti
- Cambiare markup/classi potrebbe rompere selettori E2E e di accessibilità: mitigato preservando role e label accessibili
- Editor al click (invece di sempre aperto) cambia il flusso di interazione: coperto da nuovi test + E2E esistenti
