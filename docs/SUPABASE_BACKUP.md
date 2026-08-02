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

Ogni esecuzione produce, seguendo la procedura ufficiale Supabase:

- `roles.sql` con i ruoli PostgreSQL;
- `schema.sql` con lo schema;
- `data.sql` con i dati tramite `COPY`, esclusi
  `storage.buckets_vectors` e `storage.vector_indexes`;
- `history_schema.sql` e `history_data.sql` con il registro
  `supabase_migrations`, necessario per non riapplicare migrazioni gia
  presenti dopo un ripristino;
- `manifest.txt` e `SHA256SUMS` per identificare e verificare i file.

I sette file vengono compressi e cifrati con
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
supporto offline cifrato. Non copiarla nel repository, nei log, nelle issue o
nei secret GitHub: il workflow deve poter cifrare, non decifrare.

Se la chiave privata viene persa, i backup non possono essere recuperati.

## 3. Configurare GitHub Actions

In **Settings > Secrets and variables > Actions** configurare:

1. In **Secrets**, `SUPABASE_DB_URL` con la connection string **Session
   pooler** copiata da **Supabase Dashboard > Connect**. Deve includere la
   password database correttamente percent-encoded. Usare la Session pooler
   perche i runner GitHub non garantiscono la connettivita IPv6 richiesta dalla
   connessione diretta.
2. In **Variables**, `BACKUP_AGE_RECIPIENT` con la sola chiave pubblica `age1...`
   ottenuta al punto precedente.

Esempio puramente descrittivo della prima variabile, senza valori reali:

```text
postgresql://postgres.PROJECT_REF:PASSWORD@HOST_POOLER:5432/postgres?sslmode=require
```

`SUPABASE_DB_URL` e un secret privilegiato. Non usare nomi `VITE_*`, non
commetterlo e non sostituirlo con una chiave `service_role`. Il workflow non
richiede `SUPABASE_ACCESS_TOKEN`.

In **Settings > Actions > General** lasciare la retention massima degli artifact
ad almeno 90 giorni. Una policy inferiore farebbe fallire l'upload domenicale.

Il workflow opera soltanto sul branch predefinito. Se una configurazione manca
o non ha il formato atteso, termina prima di contattare il database e non carica
alcun artifact.

## 4. Prima esecuzione e monitoraggio

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

## 5. Decifrare e verificare un backup

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

## 6. Prova di ripristino

Un backup non verificato tramite restore non e sufficiente. Almeno ogni tre
mesi creare un progetto Supabase di prova vuoto, abilitarvi le estensioni usate
dal gestionale e recuperare la sua nuova Session pooler URL in `NEW_DB_URL`.
Ripristinare poi con `psql`:

```text
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file roles.sql \
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
