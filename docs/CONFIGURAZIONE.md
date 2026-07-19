# Configurazione dalla demo alla produzione

## 1. Avvio locale della demo

Servono Node.js 22 e npm.

```bash
npm install
npm run dev
```

La demo usa soltanto aziende e credenziali fittizie e salva le modifiche in `localStorage`. Non usarla con dati reali: non e un database e non fornisce isolamento tra utenti.

## 2. Backend locale Supabase

Installare Docker e la Supabase CLI, quindi dalla radice del progetto:

```bash
npx supabase start
npx supabase db reset
```

Copiare `.env.example` in `.env.local`, usare URL e publishable/anon key stampati dalla CLI e impostare `VITE_APP_MODE=supabase`. I segreti delle funzioni vanno in un file separato ignorato da Git, mai in una variabile `VITE_*`.

## 3. Progetto Supabase di produzione

1. Creare un progetto in una regione UE.
2. Collegare la CLI con `npx supabase link --project-ref PROJECT_REF`.
3. Controllare e applicare le migrazioni:

   ```bash
   npx supabase db push --dry-run
   npx supabase db push
   ```

4. Disabilitare il signup pubblico in Authentication.
5. Impostare Site URL e redirect consentiti per localhost, per `https://pastaigea.github.io/gestionale_ordini/` durante il collaudo e per il dominio dedicato scelto. Inviti e reset usano la route `#/imposta-password`.
6. Creare il primo utente da Authentication, poi promuovere il relativo profilo a `admin` dal SQL Editor seguendo il README in `supabase/`.
7. Attivare MFA per l'amministratore e configurare un provider SMTP affidabile.
8. Pubblicare le Edge Functions e impostare i segreti descritti in `docs/TELEGRAM.md`.

Dopo aver creato l'amministratore, caricare prodotti e listino dall'area **Prodotti** seguendo `docs/IMPORTAZIONE_CATALOGO.md`. Il CSV reale va scelto dal computer dell'amministratore e non deve essere aggiunto al repository.

Tra i segreti/config delle Edge Functions impostare anche `ALLOWED_ORIGINS` con gli origin esatti e separati da virgola (localhost, Pages durante il collaudo e dominio dedicato) e `PASSWORD_REDIRECT_URL` con la pagina `#/imposta-password`. L'origin non include il percorso `/gestionale_ordini/`.

## 4. GitHub Pages

Nel repository GitHub aprire **Settings > Secrets and variables > Actions > Variables** e creare:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_BASE_PATH` (lasciare `/gestionale_ordini/` sul dominio Pages standard; impostare `/` quando il repository usa un dominio dedicato alla root)

Sono valori destinati al browser; la protezione dei dati dipende dalle policy RLS. Non creare mai una variabile `VITE_SUPABASE_SERVICE_ROLE_KEY`.

In **Settings > Pages**, scegliere **GitHub Actions** come sorgente. Il workflow pubblica solo dopo test e build e si interrompe se le variabili Supabase mancano, evitando di mettere online la demo per errore.

Prima di usare anagrafiche reali, configurare in **Settings > Pages > Custom domain** un sottodominio dedicato, impostare `VITE_BASE_PATH=/` e aggiornare le redirect URL Auth. Evitare di affidare una sessione reale al dominio condiviso `pastaigea.github.io`: altri progetti Pages dello stesso account condividono l'origine browser. Se serve hardening tramite header HTTP, anteporre un proxy/CDN al dominio dedicato.

## 5. Verifiche prima dell'uso

- Accedere come due clienti diversi e verificare che nessuno possa leggere ordini, anagrafica o DDT dell'altro.
- Provare end-to-end sia un invito sia un reset password da email reale: la Admin API Supabase usa callback implicit e l'app deve aprire `#/imposta-password` dopo aver acquisito la sessione.
- Provare richieste modificate manualmente: prezzo, IVA, totale e stato devono essere ignorati o rifiutati.
- Simulare due emissioni DDT contemporanee e verificare numeri distinti.
- Inserire un ordine dall'area admin scegliendo un cliente con listino personalizzato e verificare che il cliente lo veda nel proprio account.
- Ridurre una quantità prima e dopo l'emissione del DDT: la richiesta originale deve restare visibile e, nel secondo caso, il vecchio DDT deve risultare annullato con un nuovo progressivo sostitutivo.
- Verificare backup, ripristino e download dei soli documenti autorizzati.
- Far validare dati fiscali, aliquote, arrotondamenti e modello DDT dal commercialista.
- Provare su un nuovo ordine entrambe le modalita di pagamento e la conferma amministrativa degli ordini alla consegna.
- Far verificare informativa privacy, tempi di conservazione e uso di Telegram.
- Archiviare il PDF DDT definitivo nel bucket privato con hash e accesso autorizzato; nell'MVP il download viene ancora rigenerato nel browser dagli snapshot.
- Eseguire secret scanning/revisione del bundle: lo script locale intercetta solo indicatori noti e non sostituisce questi controlli.
