# iKuck — piano home, navigazione e flussi UX

> **Status:** completed on `plan-4-complete` at commit `85bb8d3`; see the [remediation index](2026-09-14-remediation-index.md).

> **Per l'agente esecutore:** mantenere la UI in italiano e il codice in inglese. Dopo ogni task eseguire test component e una verifica a 390×844 e 1440×900. Non introdurre nuove feature di prodotto.

**Obiettivo:** rendere immediata la ricerca ricette, ridurre il carico della home e correggere flussi/messaggi ingannevoli.

**Direzione UX:** la home parte da ingredienti e ricerca. Dieta, lotti e staples sono dettagli correlati chiusi inizialmente. Un header compatto espone Home, Lista, Attività e Profilo. Il pannello account esteso vive nel Profilo.

**Spec:** UX-01…08 e UX-10…12 nell'audit.

**Rilievi coperti:** UX-01, UX-02, UX-03, UX-04, UX-05, UX-06, UX-07, UX-08, UX-10, UX-11, UX-12.

---

## Task 1: fissare con test l'ordine della home

**Files:**

- Modify: `frontend/src/test/HomePage.test.tsx`
- Modify: test Playwright home in `frontend/e2e/`

- [ ] Scrivere un test DOM: titolo/input/suggerimenti → CTA ricerca → risultati → controlli secondari.
- [ ] Scrivere un test keyboard a 390×844: “Trova ricette” raggiungibile entro 10 Tab dall'inizio.
- [ ] Scrivere un test visual/position: CTA dentro la prima viewport con contenuto iniziale normale.
- [ ] Confermare che i nuovi test falliscano sull'ordine attuale.
- [ ] Commit: `test(home): define primary search hierarchy`.

## Task 2: portare CTA e ricerca all'inizio

**Files:**

- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/components/suggestions/SuggestionControls.tsx`
- Modify: `frontend/src/test/HomePage.test.tsx`

- [ ] Spostare `SuggestionControls` subito dopo input/suggerimenti e prima di dieta, link, lotti e staples.
- [ ] Conservare il comportamento disabled senza ingredienti e il controllo “un ingrediente mancante”.
- [ ] Mostrare i risultati subito dopo il CTA, senza saltare il focus.
- [ ] Aggiungere focus programmatico al titolo risultati solo dopo azione esplicita e con `tabIndex={-1}`.
- [ ] Eseguire test home e browser mobile.
- [ ] Commit: `fix(home): place recipe search before secondary controls`.

## Task 3: chiudere di default i pannelli correlati

**Files:**

- Modify: `frontend/src/components/diet/DietFiltersPanel.tsx`
- Modify: `frontend/src/components/diet/DietFiltersPanel.test.tsx`
- Modify: `frontend/src/components/pantry/PantryLotsPanel.tsx`
- Modify: `frontend/src/components/pantry/PantryLotsPanel.test.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`

- [ ] Usare `details/summary` nativi con nomi “Filtri alimentari” e “Dettagli lotti”.
- [ ] Lasciarli chiusi al primo render; aprirli nei test prima di cercare controlli interni.
- [ ] Nel summary mostrare un conteggio sintetico di filtri/lotti attivi.
- [ ] Conservare focus, tastiera e form state durante apertura/chiusura.
- [ ] Verificare che l'altezza iniziale mobile diminuisca e che il CTA resti visibile.
- [ ] Commit: `fix(home): collapse secondary pantry and diet details`.

## Task 4: introdurre una navigazione primaria compatta

**Files:**

- Create: `frontend/src/components/layout/AppHeader.tsx`
- Create: `frontend/src/components/layout/AppHeader.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/pages/ShoppingListPage.tsx`
- Modify: `frontend/src/pages/ActivityPage.tsx`
- Modify: `frontend/src/pages/ProfilePage.tsx`

- [ ] Implementare link Home, Lista, Attività e Profilo con current page via `aria-current="page"`.
- [ ] Su mobile usare una riga compatta che non copra contenuto; niente menu nascosto se quattro link entrano a 320 px.
- [ ] Rimuovere dalla home i link duplicati se non aggiungono contesto.
- [ ] Conservare un solo `h1` per pagina e un link “Salta al contenuto”.
- [ ] Testare navigazione keyboard e route attiva.
- [ ] Commit: `feat(navigation): add a compact persistent app header`.

## Task 5: spostare il pannello account completo nel profilo

**Files:**

- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/pages/ProfilePage.tsx`
- Modify: `frontend/src/components/account/AccountPanel.tsx`
- Modify: test home/account/profile pertinenti

- [ ] Rimuovere il pannello account completo dalla home.
- [ ] Se serve, mostrare nell'header solo stato/offline e link Profilo, senza form.
- [ ] Nel Profilo guest evitare doppio titolo/doppia spiegazione.
- [ ] Spiegare che login non importa dati e che l'import è un'azione separata.
- [ ] Nascondere o disabilitare chiaramente Google quando non configurato; non lasciare un CTA che fallisce al click.
- [ ] Commit: `fix(account-ui): keep account actions in the profile flow`.

## Task 6: correggere logout, import e messaggi offline

**Files:**

- Modify: `frontend/src/pages/ProfilePage.tsx`
- Modify: `frontend/src/pages/ProfilePage.test.tsx`
- Modify: `frontend/src/auth/authStore.test.ts`

- [ ] Testare logout con API riuscita e fallita: sessione locale pulita e navigazione home in entrambi i casi.
- [ ] Usare `try/catch/finally`; nessuna promise rejection non gestita.
- [ ] Sostituire “verrà riprovata” con un messaggio che non prometta automazioni inesistenti.
- [ ] Usare il `SyncResult` del piano sync per mostrare uploaded/downloaded/pending.
- [ ] Rinominare “Importa la dispensa” in “Importa i dati locali”.
- [ ] Commit: `fix(profile): make logout and sync feedback truthful`.

## Task 7: correggere struttura account e ARIA

**Files:**

- Modify: `frontend/src/components/account/AccountPanel.tsx`
- Modify: `frontend/src/components/account/AccountPanel.test.tsx`

- [ ] Scegliere il pattern più semplice: pulsanti normali senza `tablist`, oppure tabs completi.
- [ ] Se tabs: aggiungere `role="tab"`, `aria-selected`, roving tabindex e `aria-controls`/`tabpanel`.
- [ ] Testare cambio con frecce, Tab ed Enter.
- [ ] Associare errori ai campi con `aria-describedby` e portare focus sul riepilogo errore dopo submit.
- [ ] Commit: `fix(account-ui): implement valid accessible mode controls`.

## Task 8: riordinare il dettaglio ricetta e localizzare metadati

**Files:**

- Modify: `frontend/src/pages/RecipeDetailPage.tsx`
- Modify: `frontend/src/pages/RecipeDetailPage.test.tsx`
- Modify: `frontend/src/components/diet/RecipeNutritionSummary.tsx`
- Create: `frontend/src/components/diet/nutrientLabels.ts`

- [ ] Ordinare: titolo/sintesi → ingredienti → preparazione → esperienza → nutrizione/azioni secondarie.
- [ ] Mappare `sodium` a “sodio” e gli altri nutrienti supportati; fallback in italiano leggibile.
- [ ] Correggere `1 stella` / `n stelle`.
- [ ] Testare ordine dei landmark/heading, nutrienti mancanti e pluralizzazione.
- [ ] Commit: `fix(recipe-ui): prioritize cooking content and localize metadata`.

## Task 9: usare 404 esplicita

**Files:**

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/NotFoundPage.tsx`
- Modify: `frontend/src/App.test.tsx`

- [ ] Rendere la route `*` una pagina 404, senza redirect silenzioso.
- [ ] Distinguere “pagina non trovata” da “ricetta non trovata” tramite props/copy.
- [ ] Offrire link Home e, per ricetta mancante, ritorno ai risultati se disponibile.
- [ ] Testare URL preservata, heading e focus iniziale.
- [ ] Commit: `fix(routing): show recoverable not-found pages`.

## Task 10: aggiungere undo alle eliminazioni locali

**Files:**

- Create: `frontend/src/components/feedback/UndoToast.tsx`
- Create: `frontend/src/components/feedback/UndoToast.test.tsx`
- Modify: store/componenti lotti, shopping, attività e ricette AI interessati

- [ ] Implementare una singola azione undo con timeout e live region `polite`.
- [ ] Per ogni dominio testare delete, undo e scadenza timeout.
- [ ] Non usare dialog di conferma per azioni facilmente reversibili.
- [ ] Mantenere un dialog esplicito solo per cancellazione account/dati remoti irreversibili.
- [ ] Commit: `feat(ux): add undo for reversible local deletions`.

## Gate del piano

```powershell
cd frontend
npm run lint
npm test
npm run test:e2e
npm run build
```

- [ ] Verifica 390×844: CTA nella prima viewport e non oltre 10 Tab.
- [ ] Verifica 1440×900: nessun vuoto anomalo e ordine identico.
- [ ] Verifica 200% zoom e tastiera completa.
