# Architettura e confini di sicurezza

## Componenti

```text
Browser cliente/admin
        |
        | HTTPS + sessione Supabase
        v
GitHub Pages (React) -----> Supabase Auth
        |                       |
        | API con JWT           v
        +----------------> PostgreSQL + RLS
                                |
                                +--> Edge Functions --> Telegram Bot API
                                |
                                +--> Storage privato DDT (fase pre-produzione)
```

GitHub Pages contiene solo HTML, CSS e JavaScript. Il repository e il bundle non contengono password, dati cliente, token Telegram o chiavi amministrative. Nascondere una pagina nel menu non e una misura di sicurezza: ogni lettura e scrittura reale e autorizzata da RLS o da una funzione server verificata.

## Ruoli e isolamento

- `client`: vede catalogo attivo, propria anagrafica, propri ordini, cronologia e DDT.
- `admin`: gestisce clienti, listini, prodotti, ordini, stati e dati del fornitore.
- `service_role`: usato soltanto nelle Edge Functions. Non viene inviato al browser.

Le registrazioni pubbliche sono disabilitate. Il primo amministratore viene creato dal pannello Supabase; i clienti successivi vengono invitati o creati dalla funzione amministrativa.

## Ordini e prezzi

Il browser invia soltanto identificativi prodotto e quantita. Una RPC nel database legge il listino assegnato, calcola imponibile, IVA e totale e salva uno snapshot. Un utente non puo alterare prezzo, aliquota, totale o stato costruendo manualmente una richiesta HTTP.

Una promo prodotto è una percentuale configurata dall'admin. Quando è attiva, il database applica la percentuale al prezzo di listino prima di creare lo snapshot dell'ordine; il frontend mostra listino barrato, prezzo scontato e badge coerente. Il trasporto non è un prodotto ordinabile: è una sola voce separata sull'ordine e sul DDT, normalmente pari a 3,50 € + IVA 22%. Gli SKU storici `TRASP`/`TRASP2` vengono disattivati e le API ne impediscono il reinserimento.

L'amministratore può inserire un ordine per conto di un cliente scegliendo prima il cliente: il catalogo viene caricato con il listino assegnato a quel cliente e il server ricalcola comunque tutti i prezzi. Per un'evasione parziale, `order_items.quantity` conserva quanto richiesto e `fulfilled_quantity` registra quanto effettivamente consegnato. La modifica richiede un motivo, usa optimistic locking ed è salvata nell'audit amministrativo.

La macchina stati e:

```text
bozza -> in ordine -> accettato -> in consegna -> consegnato
                    \-> rifiutato
```

Nel database i nomi sono `draft`, `submitted`, `accepted`, `rejected`, `in_delivery`, `delivered`. Ogni transizione e registrata nello storico.

## DDT

Il numero viene assegnato dal database quando l'ordine passa a `in_delivery`. Il contatore e bloccato e incrementato nella stessa transazione, per evitare duplicati anche con due operatori contemporanei. La numerazione e separata per serie e anno.

Anagrafiche, destinazione, righe e valori sono copiati nel DDT al momento dell'emissione: modifiche successive al cliente o al catalogo non cambiano lo storico. Un numero gia assegnato non viene riciclato se la generazione PDF fallisce.

Se l'amministratore rettifica le quantità dopo l'emissione, il DDT esistente passa a `void` e nella stessa transazione ne viene creato uno sostitutivo con un nuovo progressivo. Il documento precedente resta nello storico e non viene mostrato al cliente come documento valido. Report mensile e fattura usano esclusivamente lo snapshot del DDT valido. Una rettifica economica è bloccata quando il pagamento alla consegna è già stato confermato, perché richiede un flusso separato di rimborso o integrazione.

La serie, il reset annuale, i campi obbligatori e la presenza dei prezzi nel DDT devono essere validati con il commercialista prima dell'uso reale.

Nell'MVP il PDF viene generato nel browser dagli snapshot e non e ancora archiviato: un download futuro potrebbe quindi riflettere una nuova versione del template. Prima del go-live il PDF definitivo va salvato una sola volta nel bucket privato `ddt-pdf`, associato al record tramite percorso e hash, e servito solo dopo controllo dell'autorizzazione.

## Pagamenti e fatturazione

La modalita di pagamento viene scelta dal cliente sul singolo ordine: fatturazione a fine mese come default, oppure pagamento alla consegna. Il valore viene salvato sull'ordine, cosi una modifica successiva dell'anagrafica cliente non altera gli ordini gia ricevuti. Per il pagamento alla consegna, soltanto un amministratore puo registrare l'avvenuto pagamento. Data, operatore e modifica restano nel database e nell'audit.

L'eventuale integrazione con Fatture in Cloud deve passare da una Edge Function e usare esclusivamente segreti server. Creazione della fattura e invio allo SDI rimangono due azioni distinte; prenotazione univoca e riconciliazione degli esiti incerti evitano retry ciechi e duplicati. Dettagli e decisioni aperte sono in `docs/FATTURE_IN_CLOUD.md`.

## Telegram

La notifica contiene il minimo indispensabile e due pulsanti inline. Il webhook verifica il secret Telegram, chat e utente amministratore, token monouso, scadenza e versione dell'ordine. Un pulsante vecchio o gia usato non puo modificare nuovamente lo stato.

## Dati e privacy

Per la produzione scegliere una regione Supabase UE, configurare backup e retention, aggiornare l'informativa privacy e sottoscrivere gli accordi necessari con i fornitori. Telegram e un destinatario terzo: evitare indirizzi completi, P.IVA o note sensibili nei messaggi.

Per separare lo storage della sessione dagli altri progetti Pages usare un dominio dedicato. GitHub Pages resta il solo hosting statico; un eventuale proxy/CDN puo inoltre aggiungere gli header HTTP di sicurezza che Pages non rende configurabili.
