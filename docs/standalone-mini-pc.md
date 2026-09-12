# iKuck standalone su mini PC

Questa modalità esegue iKuck dentro quattro container sulla rete locale: Caddy serve la PWA, l’API prepara il backend, PostgreSQL conserva i dati e Redis fornisce la cache. Solo Caddy è raggiungibile dalla LAN; PostgreSQL, Redis e API restano nella rete privata di Docker.

La modalità è pensata per un mini PC Linux Debian o Ubuntu con Docker Engine e Docker Compose plugin. Non richiede un dominio pubblico né port forwarding. Dal browser si accede a `http://IP_DEL_MINI_PC:8080`.

## 1. Preparare il mini PC

Installa Docker Engine e il plugin Compose seguendo la documentazione della distribuzione. Su Debian o Ubuntu puoi usare il pacchetto ufficiale Docker; verifica poi:

```bash
docker --version
docker compose version
```

Fai in modo che il mini PC abbia un indirizzo LAN stabile, preferibilmente con una prenotazione DHCP nel router. Nell’esempio seguente l’indirizzo è `192.168.1.50`.

## 2. Copiare il progetto

Trasferisci il repository nel mini PC, ad esempio con Git:

```bash
sudo mkdir -p /opt/ikuck
sudo chown "$USER":"$USER" /opt/ikuck
git clone <REPOSITORY_URL> /opt/ikuck
cd /opt/ikuck
```

Se il repository non è remoto, copia la cartella del progetto in `/opt/ikuck` con il metodo disponibile nella tua rete.

## 3. Creare la configurazione locale

Non modificare il file di esempio e non committare il file con i valori reali:

```bash
cp deploy/.env.standalone.example deploy/.env.standalone
nano deploy/.env.standalone
```

Modifica almeno:

- `APP_ORIGIN`: l’indirizzo che userai nel browser, per esempio `http://192.168.1.50:8080`;
- `POSTGRES_PASSWORD`: una password locale nuova, senza caratteri che rompano una URL (`@`, `:`, `/`, `?`, `#`);
- `SESSION_SECRET`: una stringa casuale di almeno 32 caratteri.

`IKUCK_PORT` può restare `8080`. Se la porta è già occupata, scegline un’altra, per esempio `8180`, e aggiorna anche `APP_ORIGIN`.

## 4. Avviare i container

Dal repository:

```bash
docker compose \
  --env-file deploy/.env.standalone \
  -f deploy/docker-compose.standalone.yml \
  up -d --build
```

La prima esecuzione scarica le immagini e costruisce API e frontend, quindi può richiedere alcuni minuti. Le migrazioni PostgreSQL vengono eseguite automaticamente prima dell’avvio dell’API.

Controlla lo stato:

```bash
docker compose \
  --env-file deploy/.env.standalone \
  -f deploy/docker-compose.standalone.yml \
  ps
```

Apri quindi `http://192.168.1.50:8080` sostituendo l’indirizzo con quello del tuo mini PC.

Per verificare l’health check dell’API senza esporla alla LAN:

```bash
docker compose \
  --env-file deploy/.env.standalone \
  -f deploy/docker-compose.standalone.yml \
  exec api node -e "fetch('http://127.0.0.1:3000/healthz').then(async (response) => { console.log(await response.text()); process.exit(response.ok ? 0 : 1); }).catch((error) => { console.error(error); process.exit(1); })"
```

## 5. Gestione ordinaria

Vedere i log:

```bash
docker compose --env-file deploy/.env.standalone -f deploy/docker-compose.standalone.yml logs -f --tail=100
```

Fermare i container mantenendo i dati:

```bash
docker compose --env-file deploy/.env.standalone -f deploy/docker-compose.standalone.yml down
```

Aggiornare una versione del progetto:

```bash
git pull
docker compose --env-file deploy/.env.standalone -f deploy/docker-compose.standalone.yml up -d --build
```

Non usare `down --volumes` durante la gestione normale: elimina i volumi PostgreSQL, Redis e Caddy insieme ai dati persistenti.

## 6. Backup e ripristino

I backup vanno conservati fuori dalla directory del repository, su un disco o NAS separato:

```bash
set -a
. deploy/.env.standalone
set +a
mkdir -p /var/backups/ikuck
COMPOSE_FILE=deploy/docker-compose.standalone.yml \
  BACKUP_DIR=/var/backups/ikuck \
  sh deploy/backup-postgres.sh
```

Per ripristinare un archivio verificato, fermati prima e assicurati di avere una copia dei dati correnti:

```bash
set -a
. deploy/.env.standalone
set +a
COMPOSE_FILE=deploy/docker-compose.standalone.yml \
  ARCHIVE_PATH=/var/backups/ikuck/ikuck-YYYYMMDDTHHMMSSZ.dump \
  sh deploy/restore-postgres.sh
```

Il ripristino sovrascrive i dati PostgreSQL con `pg_restore --clean --if-exists`. Non eseguirlo con un archivio non verificato.

## 7. Accesso dalla LAN

Se usi UFW, consenti la porta solo dalla rete locale, adattando la subnet:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
```

Non inoltrare la porta 8080 su Internet. Questa modalità usa HTTP locale; per l’accesso pubblico servirà la composizione di produzione con dominio, HTTPS e una configurazione di rete diversa.

## Stato funzionale attuale

Il frontend continua a funzionare come ospite e conserva la dispensa nel browser. Il backend containerizzato è la base tecnica per account, sincronizzazione e servizi remoti, ma la PWA non invia ancora dati all’API: queste funzioni appartengono ai piani successivi.
