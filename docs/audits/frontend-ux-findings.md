# Rilievi UX/UI della PWA iKuck — audit parziale

## Esito
La migrazione visuale è stata avviata e alcune incoerenze centrali sono state corrette, ma non è dimostrato l’allineamento completo di tutte le viste. Questa nota registra i rilievi e distingue i controlli già eseguiti da quelli ancora aperti.

## Riferimento e copertura
- Riferimenti disponibili: `DESIGN.md`, schermate in `design/ux-ui-proposal/evidence/screenshots/` e `responsive-geometry.json`.
- La ricognizione iniziale ha individuato 99 file TSX e 19 specifiche Playwright; la review visiva non ha coperto singolarmente ogni componente e ogni stato.
- La comparazione pixel-perfect con un prototipo interattivo non è stata verificata: i controlli documentati si sono basati sui token e sulle schermate presenti nel repository.

## Rilievi e interventi

1. **Tipografia non uniforme.** La UI caricava Outfit e DM Sans oltre al font previsto dal sistema. Gli import CSS di quei font sono stati rimossi e le viste interessate riallineate a Bricolage Grotesque Variable.
2. **Palette parallela nella UI SOUS-CHEF.** Chat, navigazione, modali e filtri usavano colori caldi separati dalla palette iKuck, con variazioni tra temi. Sono stati portati componenti e alias legacy verso i token semantici condivisi; la verifica finale di contrasto resta aperta.
3. **Gerarchia dei raggi e delle superfici.** Pannelli standard e superfici principali condividevano raggi non sempre coerenti con `DESIGN.md`. Sono stati distinti i pannelli ordinari dalle superfici feature e aggiornate le classi dei componenti interessati.
4. **Overlay, stati interattivi e motion.** Chat e modali avevano stili specifici, alcuni colori inline e stati di focus non uniformi. Sono state introdotte classi condivise, overlay tematico e scroll compatibile con `prefers-reduced-motion`.
5. **Safe area e costo del caricamento iniziale.** Navigazione inferiore e contenuto non gestivano ovunque le safe area; le route caricavano più codice del necessario all’avvio. Sono stati aggiunti padding con `env(safe-area-inset-bottom)` e lazy loading delle pagine non-home.
6. **Route Piano non risolta.** `BottomNav` punta a `/plan`, ma nella route map controllata non risultano né una route corrispondente né `PlanPage`. Serve una decisione di prodotto/implementazione; non è stata aggiunta una pagina fittizia.

## File toccati durante il refactoring
`DESIGN.md`, `frontend/src/index.css`, `frontend/tailwind.config.js`, `frontend/src/App.tsx`, i componenti `chat/`, `layout/`, `recipe/` e le pagine `DiscoverPage.tsx`, `SavedPage.tsx`, `ShoppingListPage.tsx` e `ProfilePage.tsx`, oltre a `frontend/e2e/dark-mode.spec.ts`.

## Verifiche registrate e limiti
- Lint frontend: passato; test unitari: **86 file, 855 test passati**.
- Build frontend: passata durante il lavoro; un output intermedio riportava il chunk principale a **409.66 kB** (**127.67 kB gzip**) dopo il code splitting. Non è una misura certificata dopo ogni modifica successiva.
- Test Playwright dei token: **2/2** passati sui progetti desktop e mobile.
- Suite E2E completa: non verificata, terminata per timeout del runner.
- Il primo lint di `DESIGN.md` ha riportato **0 errori e 42 warning**, inclusi riferimenti componente non validi, contrasti e token orfani. Il documento è stato aggiornato dopo quel controllo, ma il lint non è stato ripetuto.
- Verifica visuale completa a 320/390/768/1440 px, zoom 200%, suite accessibilità/PWA, target live e produzione: non attestata.

## Passi necessari per chiudere l’audit
1. Rieseguire il lint di `DESIGN.md` e risolvere i warning residui.
2. Chiudere o documentare `/plan` con una route reale o una destinazione deliberata.
3. Completare la review visiva di tutte le route e degli stati empty/loading/error, confrontandoli con le schermate e le geometrie responsive.
4. Rilanciare lint, test unitari, build e suite Playwright completa dopo le ultime modifiche; registrare separatamente i test saltati.
5. Non dichiarare allineamento al 100% né verifica production finché questi controlli non sono passati.
