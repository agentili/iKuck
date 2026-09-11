# iRicetto local-first: specifica di prodotto e architettura

## Obiettivo

Ristrutturare iRicetto come web app mobile-first, immediata e installabile. Una persona apre l'app, indica con testo libero quali ingredienti possiede e richiede ricette compatibili. Su richiesta esplicita, l'app può includere ricette che richiedono un solo ingrediente aggiuntivo facile da reperire.

L'MVP non richiede registrazione, login, server applicativo o connessione Internet. I dati personali restano nel browser del dispositivo.

## Stato di partenza verificato

Il repository contiene una PWA React/Vite/TypeScript, un backend Express/TypeScript, PostgreSQL, Redis e Docker. Sono già presenti schermate per autenticazione, dispensa, suggerimenti, dettaglio ricetta e cronologia.

La base non è pronta per essere evoluta senza interventi:

- la build frontend fallisce per l'import di `App.tsx` con estensione non ammessa;
- la build backend fallisce per incompatibilità con Zod, tipi data e parametri Express;
- i sei test unitari backend passano, ma verificano solo il vecchio algoritmo;
- la verifica end-to-end esistente è dichiaratamente simulata e non costituisce prova di funzionamento;
- le 200 ricette generate dal seed sono variazioni casuali di otto modelli, con quantità e istruzioni generiche;
- l'interfaccia richiede quantità, unità, categoria e opzionalmente scadenza, in contrasto con il nuovo flusso;
- i suggerimenti partono automaticamente e non espongono con precisione l'ingrediente mancante;
- il frontend utilizza uno stile Tailwind quasi predefinito, senza una direzione visiva propria.

Il file non tracciato `E2E_VERIFICATION.md` è preesistente e deve essere preservato durante il lavoro.

## Decisioni di prodotto

### Esperienza principale

L'app si apre direttamente sulla home, senza autenticazione. La home concentra il flusso completo:

1. inserimento rapido degli ingredienti;
2. visualizzazione e rimozione degli ingredienti come chip;
3. gestione separata degli ingredienti di base;
4. richiesta esplicita dei suggerimenti;
5. elenco delle ricette compatibili;
6. apertura del dettaglio di una ricetta.

Non sono previste navigazione inferiore, dashboard, cronologia o profilo nell'MVP. La semplicità della singola schermata è un requisito, non una limitazione temporanea dell'interfaccia.

### Inserimento della dispensa

L'utente può digitare più elementi separati da virgola, punto e virgola o invio, per esempio `pasta, pomodori, tonno`. Non inserisce quantità, unità o date di scadenza.

L'app normalizza maiuscole, spazi, accenti e alias comuni. Per esempio `pomodori` e `pomodoro` producono lo stesso ingrediente canonico. Un suggeritore mostra gli ingredienti noti mentre si digita. I termini non riconosciuti possono essere conservati come ingredienti personalizzati, ma l'interfaccia informa che non partecipano al catalogo finché non corrispondono a un ingrediente noto.

### Ingredienti di base

Alla prima apertura sono attivi `acqua`, `sale`, `pepe` e `olio extravergine di oliva`. La home li mostra in una sezione compatta chiamata “Ingredienti di base”, espandibile e modificabile. Le preferenze vengono conservate sul dispositivo.

### Richiesta di ricette

I risultati non vengono calcolati automaticamente. Il pulsante principale è `Trova ricette` e mostra solo ricette per cui tutti gli ingredienti obbligatori sono disponibili.

Un controllo secondario, inizialmente disattivato, è denominato `Anche con 1 ingrediente in più`. Quando viene attivato e l'utente richiede nuovamente i risultati, sono ammesse anche ricette con esattamente un ingrediente mancante, purché tale ingrediente sia marcato come facile da reperire nel catalogo.

Ogni scheda dichiara uno dei due stati:

- `Hai tutto` per una corrispondenza completa;
- `Ti manca solo: <ingrediente>` per una corrispondenza con un elemento aggiuntivo.

Il sistema non nasconde mai un ingrediente obbligatorio mancante e non usa percentuali di compatibilità, perché sarebbero meno comprensibili del dato concreto.

### Selezione casuale

Il catalogo è fisso e verificabile; sono casuali soltanto l'ordine e la selezione dei risultati. Ogni pressione di `Trova ricette` mescola le ricette idonee e ne mostra al massimo sei. `Altre idee` esegue un nuovo mescolamento con gli stessi criteri.

## Catalogo iniziale

Il catalogo contiene 20 ricette reali, semplici e divise in cinque gruppi da quattro. Ogni ricetta possiede titolo, breve descrizione, categoria, durata, difficoltà, porzioni, ingredienti con testo di dose, passaggi e tag.

| Categoria | Ricette |
|---|---|
| Carne | Pollo al limone; Straccetti di manzo con rucola; Polpette al pomodoro; Tacchino con peperoni |
| Pesce | Pasta tonno e pomodoro; Merluzzo con olive e pomodorini; Salmone al limone; Insalata di ceci e tonno |
| Uova | Frittata di zucchine; Uova al pomodoro; Omelette agli spinaci; Carbonara semplice |
| Legumi | Pasta e ceci; Lenticchie in umido; Insalata di fagioli e cipolla; Burger di ceci |
| Verdure | Pasta alla norma; Cous cous alle verdure; Zuppa rustica di verdure; Riso con zucchine e piselli |

Le ricette sono curate e deterministiche: nessuna quantità o istruzione viene generata casualmente a runtime. Gli ingredienti e i passaggi devono essere plausibili e coerenti tra loro. Il matching ignora le dosi, ma il dettaglio ricetta le mostra come indicazione pratica.

## Approcci valutati

### A. PWA locale con catalogo statico — scelto

Si conserva il frontend React e si sostituiscono API, autenticazione e database remoto con moduli TypeScript puri e persistenza locale. È l'approccio più rapido, economico e affidabile per il prodotto descritto. Consente funzionamento offline e rende il motore completamente testabile.

### B. Backend anonimo senza login — scartato

Permetterebbe statistiche e aggiornamenti centralizzati, ma richiederebbe comunque hosting, identificativi anonimi, gestione privacy, sincronizzazione e fallback di rete. Non produce un vantaggio utile per un catalogo iniziale di 20 ricette.

### C. Servizio esterno o intelligenza artificiale — rinviato

Amplia il catalogo, ma introduce costi, latenza, dipendenza dalla rete e risultati meno verificabili. Potrà essere aggiunto dietro un'interfaccia `RecipeProvider` dopo la validazione dell'MVP, senza cambiare il modello della dispensa.

## Architettura proposta

### Struttura logica

```text
UI React
  -> pantry store persisted in localStorage
  -> pure ingredient parser and normalizer
  -> pure recipe matcher and shuffler
  -> static typed recipe catalog
```

Il progetto resta in `frontend/` durante la ristrutturazione per ridurre spostamenti non necessari. Dopo la migrazione, il repository contiene una sola applicazione eseguibile. Backend, Docker, schema PostgreSQL e script di deploy vengono rimossi in un'attività finale, quando il flusso locale è già coperto da test.

### Moduli

- `domain/ingredients.ts`: catalogo canonico, alias, categorie e indicazione `easyToFind`.
- `domain/recipes.ts`: venti ricette tipizzate e validate dai test.
- `domain/suggestions.ts`: matching puro, ordinamento per completezza e mescolamento.
- `store/pantryStore.ts`: ingredienti presenti, ingredienti di base e persistenza versionata.
- `pages/HomePage.tsx`: orchestrazione del flusso unico.
- `pages/RecipeDetailPage.tsx`: dettaglio accessibile anche dopo ricaricamento tramite ID del catalogo.
- componenti piccoli per input, chip, ingredienti di base, controlli e schede ricetta.

Non vengono mantenuti React Query, Axios, Supabase, Dexie o lo store di autenticazione. Zustand viene conservato esclusivamente per lo stato persistente della dispensa, tramite middleware `persist` e `localStorage`.

### Modello dati

```ts
export type RecipeCategory = 'meat' | 'fish' | 'eggs' | 'legumes' | 'vegetables';

export interface IngredientDefinition {
  id: string;
  label: string;
  aliases: string[];
  category: string;
  easyToFind: boolean;
  staple: boolean;
}

export interface RecipeIngredient {
  ingredientId: string;
  amount: string;
  optional?: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  description: string;
  category: RecipeCategory;
  durationMinutes: number;
  difficulty: 'easy' | 'medium';
  servings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
}

export interface RecipeSuggestion {
  recipe: Recipe;
  missingIngredientIds: string[];
}
```

### Regole di matching

1. L'insieme disponibile è l'unione tra dispensa e ingredienti di base attivi.
2. Gli ingredienti opzionali non influenzano l'idoneità.
3. In modalità standard sono idonee solo le ricette con zero mancanti.
4. In modalità estesa sono idonee le ricette con zero mancanti oppure un solo mancante con `easyToFind: true`.
5. Le corrispondenze complete precedono sempre quelle con un mancante.
6. L'ordine viene mescolato all'interno di ciascun gruppo e limitato a sei risultati.
7. Una ricetta con un ID ingrediente assente dal catalogo è un errore di sviluppo rilevato dai test.

## Direzione visiva

L'interfaccia richiama un piano da cucina luminoso, con ingredienti colorati e una gerarchia molto netta. Il tratto memorabile è il grande campo di inserimento, simile a una lista scritta sul banco, che trasforma immediatamente le parole in ingredienti tangibili.

### Palette

- `Porcelain` `#FAFBF7`: fondo principale;
- `Ink` `#183028`: testo e bordi forti;
- `Basil` `#247A4A`: azione primaria e stato completo;
- `Tomato` `#D94C35`: accento mirato e ingrediente mancante;
- `Yolk` `#F2BE3E`: evidenza secondaria;
- `Sage` `#E1ECE4`: superfici e stati selezionati.

### Tipografia e layout

Si usa `Bricolage Grotesque Variable`, servito localmente tramite pacchetto Fontsource, per dare carattere senza sacrificare leggibilità. I contenuti sono allineati a sinistra; il contenitore misura al massimo 72rem su desktop e mantiene una colonna primaria leggibile su mobile. Le schede non sono una griglia SaaS uniforme: titolo e disponibilità dominano, mentre durata e categoria restano informazioni secondarie.

Il layout è responsive da 320px in su. Su mobile risultati e input sono in una colonna; da 768px i risultati usano due colonne; da 1100px tre colonne. Il dettaglio ricetta mantiene una singola colonna di lettura.

### Accessibilità e movimento

- contrasto conforme WCAG AA;
- focus visibile su tutti i controlli;
- area minima interattiva di 44x44px;
- etichette testuali oltre al colore;
- annunci `aria-live` quando ingredienti o risultati cambiano;
- animazione limitata alla trasformazione dell'input in chip e disattivata con `prefers-reduced-motion`.

## Stati ed errori

- Prima apertura: esempio compilabile e invito `Scrivi cosa hai in casa`.
- Dispensa vuota: `Aggiungi almeno un ingrediente per cercare una ricetta`.
- Nessuna ricetta completa: proposta esplicita di attivare la modalità con un ingrediente aggiuntivo.
- Nessun risultato anche in modalità estesa: elenco di tre ingredienti comuni che aumentano maggiormente le possibilità, calcolato dal catalogo.
- Termine sconosciuto: viene salvato, ma marcato `Non ancora usato nelle ricette`.
- Dati locali illeggibili: ripristino sicuro ai valori iniziali e messaggio non bloccante.
- ID ricetta inesistente: pagina `Ricetta non trovata` con ritorno alla home.

## Ambito

### Incluso nell'MVP

- home senza login;
- inserimento multiplo e suggerimenti automatici dei nomi;
- dispensa basata sulla sola presenza;
- ingredienti di base modificabili;
- persistenza locale;
- 20 ricette curate;
- ricerca su richiesta, modalità zero o un mancante;
- massimo sei risultati casuali per richiesta;
- dettaglio ricetta;
- PWA installabile e utilizzabile offline;
- test unitari, componenti e un flusso end-to-end reale;
- rimozione controllata dell'architettura server non più usata.

### Escluso dall'MVP

- account e sincronizzazione;
- quantità e scadenze;
- lista della spesa;
- cronologia, preferiti e valutazioni;
- comando vocale;
- generazione AI;
- importazione ricette da fonti esterne;
- filtri dietetici, allergeni e nutrizione;
- pannello amministrativo.

## Strategia di migrazione

1. Ripristinare una baseline frontend compilabile e introdurre i test.
2. Aggiungere dominio ingredienti e catalogo ricette senza collegarli alla vecchia UI.
3. Implementare il matcher puro con TDD.
4. Sostituire lo store remoto con persistenza locale versionata.
5. Costruire la nuova home e il dettaglio ricetta.
6. Verificare PWA, accessibilità e percorso end-to-end.
7. Rimuovere autenticazione, cronologia, backend e infrastruttura solo dopo la parità funzionale.
8. Aggiornare documentazione e comandi di sviluppo.

Ogni fase deve lasciare il progetto compilabile e testato; la rimozione finale non deve includere il file utente non tracciato `E2E_VERIFICATION.md`.

## Criteri di accettazione

1. Una nuova persona apre `/` e può usare l'app senza login.
2. Inserendo `pasta, pomodori, tonno` vengono creati tre ingredienti senza richieste di quantità.
3. Ricaricando la pagina, dispensa e ingredienti di base restano invariati.
4. `Trova ricette` non restituisce ricette con ingredienti obbligatori mancanti.
5. Attivando `Anche con 1 ingrediente in più`, nessun risultato richiede più di un acquisto.
6. Ogni risultato incompleto mostra il nome esatto dell'ingrediente mancante.
7. Il catalogo contiene esattamente 20 ricette, quattro per categoria prevista, con ingredienti validi e almeno due passaggi.
8. Ogni richiesta mostra al massimo sei risultati e `Altre idee` può cambiarne l'ordine.
9. Il dettaglio di una ricetta funziona anche dopo un refresh diretto dell'URL.
10. L'app è usabile da 320px a desktop, con tastiera e movimento ridotto.
11. L'app compilata funziona offline dopo la prima visita.
12. Test, build e flusso end-to-end terminano con esito positivo.
13. Il runtime finale non richiede backend, database, Redis o variabili segrete.

## Evoluzione prevista

L'architettura consente in seguito di introdurre un `RecipeProvider` remoto, sincronizzazione opzionale, voce o lista della spesa. Queste estensioni non fanno parte del piano MVP e non devono influenzarne struttura o interfaccia.
