# iRicetto

iRicetto suggerisce ricette semplici usando gli ingredienti presenti in dispensa. Funziona senza account, non richiede quantità e conserva i dati soltanto nel browser.

## Come funziona

1. Inserisci gli alimenti presenti, separandoli con una virgola o premendo Invio.
2. Conferma gli ingredienti base che tieni normalmente in casa.
3. Richiedi fino a sei proposte dal catalogo incluso di 20 ricette.
4. Se vuoi, includi anche ricette per cui manca un solo ingrediente facile da reperire.

Il catalogo copre carne, pesce, uova, legumi e verdure. Ogni proposta indica chiaramente se è già realizzabile o quale unico ingrediente manca.

## Avvio locale

```bash
cd frontend
npm install
npm run dev
```

## Verifica

```bash
cd frontend
npm test
npm run test:coverage
npm run lint
npm run build
npm run test:e2e
```

I test end-to-end avviano la build di produzione e verificano il percorso principale con Chromium in formato mobile e desktop, compreso il funzionamento offline.

## Dati

La dispensa è salvata in `localStorage` con la chiave `iricetto-pantry-v1`. Disinstallare l'app o cancellare i dati del sito elimina la dispensa. Nessun dato viene inviato a un server.
