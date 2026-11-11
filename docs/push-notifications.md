# Promemoria push del piano settimanale

Le notifiche sono facoltative e disponibili agli account verificati. Ogni utente sceglie l'orario del venerdì (default 19:00); ogni browser deve essere abilitato esplicitamente dal Profilo. Il worker usa il fuso IANA della Casa, se configurato, altrimenti quello personale salvato nelle preferenze. Il server considera solo dati sincronizzati: il promemoria parte se manca almeno una ricetta dal lunedì alla domenica successivi. Non genera il piano.

Il clic apre `/plan?week=YYYY-MM-DD` (lunedì); in assenza di accesso il Profilo conserva la destinazione. La rotta del Piano funziona sia nella build Sous Chef sia nell’interfaccia originale. La finestra mobile dei prossimi sette giorni rimane la vista predefinita. Il comando Prossima settimana apre la vista di calendario anche senza una notifica.

## Configurazione

1. Applicare le migrazioni con la versione aggiornata dell'API (`npm run build` e `npm run db:migrate` nel backend). Compose production/standalone esegue già le migrazioni prima dell'API.
2. Generare una coppia VAPID con `webpush.generateVAPIDKeys()` in un flusso operativo fidato che scriva direttamente nel gestore dei segreti, senza stampare i valori nel terminale o nei log. Creare coppie distinte per staging e produzione; non riutilizzare le chiavi tra ambienti.
3. Conservare una copia di recupero della coppia e del `PUSH_VAPID_SUBJECT` nel gestore delle credenziali dell'operatore. Se non è disponibile, usare solo un file dedicato fuori dal checkout Git, leggibile dall'utente di deploy e con permessi restrittivi (`0600`); non inviare i valori in chat, ticket o log. La chiave privata va solo all'API e al worker; la chiave pubblica può essere restituita dall'API al browser.
4. Impostare per API e worker `PUSH_ENABLED=true`, `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY` e `PUSH_VAPID_SUBJECT` (`mailto:` con contatto operativo o URL HTTPS). La configurazione predefinita disabilita le push e non richiede chiavi.
5. Prima di modificare un deploy, identificare il progetto Compose effettivo, tutti i file Compose/override, l'env file operativo e i volumi. Validare la configurazione risolta senza stamparne l'output e preservare gli override attivi. Per l'attivazione, aggiornare solo `api` e `push-worker`, uno alla volta; non usare un `up` dell'intero stack come scorciatoia e non ricreare PostgreSQL/Redis. Il worker dipende dall'API pronta e dalle migrazioni completate. In sviluppo avviare `npm run push:worker` nel backend dopo il build, con le stesse variabili dell'API.
6. Servire la PWA su HTTPS. Localhost consente lo sviluppo, ma un indirizzo LAN HTTP non abilita le push. Su iPhone/iPad servono iOS/iPadOS 16.4+ e l'app aggiunta alla schermata Home. Chrome/Chromium, Firefox e Safari usano i servizi autorizzati FCM, Mozilla e Apple; altri endpoint vengono rifiutati.

La chiave VAPID pubblica viene letta dall'API; non serve ricompilare il frontend per configurarla. La privata resta sul server. Perdere o ruotare la coppia richiede la riattivazione delle iscrizioni esistenti sui dispositivi.

## API

Tutte le route richiedono una sessione verificata; le mutazioni richiedono anche origine valida e token CSRF. Le risposte non vengono memorizzate in cache.

| Metodo e percorso | Comportamento |
| --- | --- |
| `GET /v1/push` | Disponibilità del servizio, chiave VAPID pubblica, preferenze e fuso effettivo |
| `PUT /v1/push/preferences` | Salva `enabled`, `fridayTime` (`HH:mm`) e `timeZone` IANA |
| `GET /v1/push/subscriptions` | Elenca ID/endpoint associati alla sessione corrente, senza chiavi |
| `POST /v1/push/subscriptions` | Registra `endpoint` e `keys.p256dh/auth`; restituisce l'ID |
| `DELETE /v1/push/subscriptions/:id` | Revoca solo un'iscrizione della sessione e dell'utente correnti |
| `POST /v1/push/subscriptions/:id/test` | Invia una prova al dispositivo autorizzato, massimo cinque richieste/ora per utente |

Le iscrizioni sono limitate a venti per account. Le chiavi di cifratura non vengono restituite dalle API di lettura. I messaggi cifrati includono l'account destinatario: il service worker lo confronta con il consenso locale per scartare messaggi rimasti in transito dopo un cambio account.

## Invio e revoca

Il worker controlla ogni minuto. PostgreSQL conserva una consegna per iscrizione/settimana e usa blocchi con `SKIP LOCKED`: più worker possono operare insieme. Preferenze, sessione, ambito e completezza vengono ricontrollati prima dell'invio. Le migrazioni della Casa in corso sospendono i promemoria.

Gli errori temporanei vengono ritentati con attesa crescente entro due ore dall'orario scelto; gli eventi successivi vengono scartati. `404/410` rimuovono l'iscrizione; altri rifiuti permanenti chiudono la consegna. Una macchina ferma può recuperare solo dentro questa finestra. I risultati sono registrati come eventi `push_sent`, `push_skipped`, `push_retry`, `push_subscription_expired`, `push_provider_rejected` e `push_tick_failed`, senza endpoint o credenziali. Gli esiti vengono conservati per 90 giorni.

La consegna al provider non garantisce la ricezione sul dispositivo. Un crash tra l'accettazione del provider e il commit può causare un reinvio: il tag settimanale sostituisce la notifica già visibile. Non viene promessa una consegna esattamente una volta.

Disattivare il promemoria nelle preferenze sospende tutti i dispositivi; “Disattiva su questo dispositivo” rimuove soltanto l'iscrizione locale e remota. Logout, revoca/scadenza della sessione o eliminazione dell'account impediscono ulteriori invii collegati a quella sessione. Un nuovo accesso richiede di riattivare il dispositivo. Il browser conserva un consenso locale che viene cancellato al logout/cambio account; il service worker ignora i messaggi senza consenso e quelli scaduti.

Per fermare il servizio impostare `PUSH_ENABLED=false`, ricreare l'API e arrestare `push-worker`. Le tabelle possono restare: non occorre una migrazione distruttiva per tornare alla versione senza push.

## Verifiche

Test unitari: calendario/fusi/ora legale, payload, permessi, cambio account, validazione endpoint/chiavi e API con autenticazione/CSRF. Test PostgreSQL disposable: piano vuoto/parziale/completo, ambito Casa, concorrenza, retry, scadenza e revoca. Test browser: consenso esplicito, ricezione nel service worker via CDP, disattivazione, destinazione settimanale, offline e aggiornamento della PWA.

Prima dell'attivazione in produzione, eseguire una notifica di prova su staging HTTPS su desktop/Android e su una PWA iOS reale, verificando app chiusa, clic, ritorno al piano dopo il login, orario configurato e revoca. I test con provider simulato/CDP non verificano la consegna attraverso i servizi push pubblici.
