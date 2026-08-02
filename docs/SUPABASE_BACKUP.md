# Backup e mantenimento del progetto Supabase Free

Il workflow `Backup e mantenimento Supabase` esegue ogni giorno alle **04:23
Europe/Rome** due job indipendenti:

- un heartbeat minimo, che invoca la funzione database
  `public.keep_project_active()` e non legge dati applicativi;
- un backup logico cifrato del database.

La separazione evita che una configurazione mancante o un errore del backup
impedisca anche l'attivita giornaliera usata come keep-alive.

Supabase descrive alcune richieste al database ogni giorno come normalmente
sufficienti, ma non fornisce una garanzia anti-pausa sul piano Free. Solo un
piano a pagamento esclude contrattualmente la pausa automatica. Inoltre GitHub
puo disabilitare i workflow pianificati di un repository pubblico dopo 60
giorni senza attivita nel repository: controllare almeno una volta al mese che
le esecuzioni continuino ad arrivare.

## Contenuto e conservazione

Ogni esecuzione usa `pg_dump` PostgreSQL 17 dall'immagine Docker Official
Image `postgres:17.8-bookworm`, bloccata a un digest immutabile. La connection
string viene passata a libpq esclusivamente tramite la variabile d'ambiente
`PGDATABASE`: non compare negli argomenti di `docker` o `pg_dump`.

Il backup produce:

- `schema.sql` con le definizioni degli schemi applicativi `public` e
  `private`, senza proprietari ma con ACL, inclusi i permessi applicativi dei
  ruoli standard `anon`, `authenticated` e `service_role`;
- `data.sql` con i dati di `public`, `private`, `auth` e `storage` tramite
  `COPY`, esclusi i registri di migrazione gestiti
  `auth.schema_migrations` e `storage.migrations` e le tabelle
  `storage.buckets_vectors` e `storage.vector_indexes`;
- `history_schema.sql` e `history_data.sql` con il registro
  `supabase_migrations`, necessario per non riapplicare migrazioni gia
  presenti dopo un ripristino;
- `manifest.txt`, che registra anche immagine e versione effettiva di
  `pg_dump`, e `SHA256SUMS` per identificare e verificare i file.

La separazione e intenzionale: `auth` e `storage` sono schemi gestiti da
Supabase, quindi il backup conserva le loro righe ma non prova a ricrearne le
definizioni. Il progetto di destinazione deve avere servizi e schemi gestiti
gia inizializzati e compatibili.

I sei file vengono compressi e cifrati con
[age](https://github.com/FiloSottile/age) prima di lasciare il runner. GitHub
riceve soltanto un file `tar.gz.age`: SQL, archivio non cifrato e directory di
lavoro restano sotto `RUNNER_TEMP` e vengono eliminati anche in caso di errore.

La conservazione e:

- 14 giorni dal lunedi al sabato;
- 90 giorni la domenica, creando uno storico settimanale di circa tre mesi.

Il repository e pubblico e gli artifact sono leggibili da chi ha accesso al
repository. La cifratura non e quindi facoltativa. La quota GitHub Free per
artifact e Packages e limitata e condivisa: controllarne l'uso e, quando il
database cresce, trasferire gli archivi cifrati in uno storage off-site privato
con regole di conservazione.

## 1. Pubblicare l'heartbeat

Applicare prima le migrazioni Supabase, inclusa
`20260802113000_project_keepalive.sql`, e pubblicare il workflow sul branch
predefinito. La funzione e intenzionalmente limitata: aggiorna una sola riga al
massimo una volta all'ora, restituisce solo l'istante dell'ultimo heartbeat e
non espone tabelle del gestionale.

Il workflow usa l'URL e la publishable key gia pubblici del frontend. Se il
progetto viene sostituito, aggiornare le variabili Actions
`VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`. Questo job non richiede
la password del database, la `service_role` o i secret del backup.

## 2. Creare la chiave age fuori dal repository

Installare `age` da una fonte ufficiale e, in una cartella sicura esterna al
repository, eseguire:

```text
age-keygen -o supabase-backup-age-key.txt
age-keygen -y supabase-backup-age-key.txt
```

Il secondo comando stampa una chiave pubblica che inizia con `age1`. Conservare
`supabase-backup-age-key.txt`, che contiene la chiave privata, in almeno due
copie protette e separate, per esempio un password manager aziendale e un
supporto offline cifrato. La copia operativa puo restare nella cartella locale
`todosGestionale`, che e esclusa da Git, ma non deve mai essere aggiunta ai
file tracciati, ai log, alle issue o ai secret GitHub: il workflow deve poter
cifrare, non decifrare.

Se la chiave privata viene persa, i backup non possono essere recuperati.

## 3. Creare un ruolo database dedicato

Non usare la password del ruolo principale `postgres` per il backup e non
reimpostarla: una reimpostazione potrebbe interrompere connessioni esistenti.
Creare invece una password lunga e casuale riservata al ruolo
`gestionale_backup`, quindi eseguire una sola volta nel SQL Editor di Supabase:

```sql
create role gestionale_backup
  login
  password 'PASSWORD_LUNGA_E_CASUALE'
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  bypassrls
  connection limit 2;

grant connect on database postgres to gestionale_backup;
grant pg_read_all_data to gestionale_backup;
alter role gestionale_backup set default_transaction_read_only = on;
```

`pg_read_all_data` permette di leggere tabelle, viste e sequenze senza
concedere scritture; `BYPASSRLS` consente al dump di includere anche le righe
protette dalle policy RLS. `default_transaction_read_only` aggiunge una seconda
protezione contro modifiche accidentali. Il ruolo non deve essere proprietario
di oggetti e non deve ricevere privilegi di scrittura o amministrativi. La sua
password puo essere ruotata o il ruolo eliminato senza cambiare le credenziali
usate dall'applicazione.

## 4. Configurare GitHub Actions

In **Settings > Secrets and variables > Actions** configurare:

1. In **Secrets**, `SUPABASE_DB_URL` con la connection string **Session
   pooler** copiata da **Supabase Dashboard > Connect**, sostituendo l'utente
   con `gestionale_backup.PROJECT_REF` e usando la password dedicata,
   correttamente percent-encoded. Usare la Session pooler sulla porta `5432`
   perche i runner GitHub non garantiscono la connettivita IPv6 richiesta dalla
   connessione diretta.
2. In **Variables**, `BACKUP_AGE_RECIPIENT` con la sola chiave pubblica `age1...`
   ottenuta al punto precedente.

Esempio puramente descrittivo della prima variabile, senza valori reali:

```text
postgresql://gestionale_backup.PROJECT_REF:PASSWORD_DEDICATA@HOST_POOLER:5432/postgres?sslmode=require
```

`SUPABASE_DB_URL` e un secret sensibile, ma concede soltanto la lettura
necessaria al dump. Non usare nomi `VITE_*`, non commetterlo, non inserirvi la
password del ruolo `postgres` e non sostituirlo con una chiave `service_role`.
Il workflow non richiede `SUPABASE_ACCESS_TOKEN` e non usa la Supabase CLI per
il dump. Quest'ultima invoca `pg_dump` con il ruolo `postgres`; il ruolo
dedicato e volutamente non autorizzato ad assumerlo. L'esecuzione diretta di
`pg_dump` non emette `SET ROLE` e mantiene la connessione con
`gestionale_backup` per tutta l'operazione.

La identity privata `supabase-backup-age-key.txt` resta soltanto nelle copie
locali protette indicate al punto 2: non va aggiunta al repository e non va
salvata in GitHub Actions. Su GitHub viene configurata esclusivamente la chiave
pubblica `BACKUP_AGE_RECIPIENT`.

In **Settings > Actions > General** lasciare la retention massima degli artifact
ad almeno 90 giorni. Una policy inferiore farebbe fallire l'upload domenicale.

Il workflow opera soltanto sul branch predefinito. Se una configurazione manca,
non usa il ruolo `gestionale_backup` o non indica la Session pooler sulla porta
`5432`, termina prima di contattare il database e non carica alcun artifact.

## 5. Prima esecuzione e monitoraggio

1. Aprire **Actions > Backup e mantenimento Supabase**.
2. Selezionare **Run workflow** sul branch predefinito.
3. Verificare che la run sia verde e che sia disponibile un solo artifact con
   nome `supabase-db-...`.
4. Scaricarlo e controllare che contenga esclusivamente il file `.tar.gz.age`.
5. Controllare nei job che siano verdi sia `Heartbeat database` sia `Dump
   database cifrato`.
6. Attivare le notifiche GitHub per i workflow falliti e verificare mensilmente
   la data dell'ultimo heartbeat e dell'ultimo backup riusciti.

I due job non dipendono l'uno dall'altro: un backup fallito non annulla un
heartbeat riuscito e viceversa. Se arriva un avviso di pausa Supabase,
controllare subito il job heartbeat e l'Activity del progetto; per eliminare il
rischio residuo occorre passare a un piano che non preveda la pausa.

## 6. Decifrare e verificare un backup

Dopo aver scaricato e aperto lo ZIP dell'artifact, eseguire in un ambiente
fidato. Su Windows PowerShell:

```powershell
age.exe --decrypt --identity .\supabase-backup-age-key.txt --output .\supabase-db-backup.tar.gz .\gestionale-ordini-supabase-RUN_ID-ATTEMPT.tar.gz.age
tar.exe -xzf .\supabase-db-backup.tar.gz

Get-Content .\SHA256SUMS | ForEach-Object {
  $parts = $_ -split '\s+', 2
  $expected = $parts[0]
  $file = $parts[1].TrimStart('*')
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Checksum non valido: $file" }
}
```

In una shell Bash equivalente:

```text
age --decrypt \
  --identity supabase-backup-age-key.txt \
  --output supabase-db-backup.tar.gz \
  gestionale-ordini-supabase-RUN_ID-ATTEMPT.tar.gz.age

tar -xzf supabase-db-backup.tar.gz
sha256sum --check SHA256SUMS
```

Tutti i checksum devono risultare validi. Eliminare in modo sicuro le copie SQL
in chiaro appena terminata la verifica o il ripristino.

## 7. Prova di ripristino

Un backup non verificato tramite restore non e sufficiente. Almeno ogni tre
mesi creare un progetto Supabase di prova vuoto, attendere che Auth e Storage
abbiano inizializzato i rispettivi schemi, abilitarvi le estensioni usate dal
gestionale e recuperare la sua nuova Session pooler URL in `NEW_DB_URL`.
Ripristinare poi con `psql`:

```text
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file schema.sql \
  --command "SET session_replication_role = replica" \
  --file data.sql \
      --dbname "$NEW_DB_URL"
```

Ripristinare quindi anche lo storico delle migrazioni, come indicato dalla
procedura ufficiale Supabase:

```text
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file history_schema.sql \
  --file history_data.sql \
  --dbname "$NEW_DB_URL"
```

In PowerShell sostituire l'ultima opzione con
`--dbname "$env:NEW_DB_URL"`; non inserire la connection string direttamente
nel comando o nei log.

Eseguire questa prova soltanto su un database nuovo e sacrificabile. Prima di
un ripristino reale sul progetto di produzione concordare finestra di fermo,
punto di recupero e controlli successivi.

`pg_dump` grezzo non applica le trasformazioni di portabilita della Supabase
CLI. Il dump limita percio esplicitamente gli schemi, omette i proprietari e
separa le migrazioni, ma conserva le ACL necessarie all'applicazione. I ruoli
standard devono gia esistere nella destinazione. Resta comunque possibile un
errore di restore se il progetto di destinazione usa una versione
incompatibile delle tabelle gestite di Auth o Storage. La prova trimestrale
serve anche a rilevare questo tipo di deriva prima di un'emergenza.

Dopo il restore verificare almeno:

- presenza di clienti, ordini, righe, DDT, contatori e audit;
- presenza delle versioni applicate nello schema `supabase_migrations`;
- accesso di un amministratore e di un cliente di prova;
- isolamento RLS tra clienti;
- generazione di un nuovo progressivo DDT;
- configurazione delle estensioni, delle Edge Functions e dei relativi secret.

La guida Supabase completa segnala anche casi particolari per ruoli, Vault,
pubblicazioni Realtime e modifiche agli schemi `auth`/`storage`:
[Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
L'immagine usata dal workflow e la
[Docker Official Image di PostgreSQL](https://hub.docker.com/_/postgres).

## Dati non coperti dal dump

Il dump include i dati del database, compresi gli utenti Auth e i loro hash di
password, ma non costituisce una copia completa di ogni servizio Supabase. Non
include, tra gli altri:

- contenuto binario degli oggetti Supabase Storage; nel database rimangono solo
  i metadati;
- secret delle Edge Functions, chiavi API e impostazioni del Dashboard;
- una garanzia di conservazione fiscale immutabile dei PDF DDT.

Il bucket `ddt-pdf` esiste nello schema, ma al momento i PDF vengono rigenerati
dal browser. Quando il gestionale iniziera a salvarvi file reali, aggiungere un
backup separato degli oggetti tramite API S3 o Supabase CLI e includerlo nella
stessa politica di cifratura e verifica. Codice delle Functions e migrazioni
restano invece versionati nel repository.

Riferimenti ufficiali:

- [pausa dei progetti Free](https://supabase.com/docs/guides/platform/free-project-pausing);
- [backup Supabase](https://supabase.com/docs/guides/platform/backups);
- [limiti dei workflow pianificati GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule);
- [download e accesso agli artifact](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
