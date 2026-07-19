# Integrazione Fatture in Cloud

L'API v2 di Fatture in Cloud permette di creare fatture, collegare o creare il cliente, impostare scadenze e stato dei pagamenti e gestire la fattura elettronica. La creazione del documento e l'invio allo SDI sono operazioni distinte.

Documentazione ufficiale:

- [creazione di una fattura](https://developers.fattureincloud.it/docs/guides/invoice-creation/);
- [attivazione e limiti del piano](https://developers.fattureincloud.it/docs/basics/activation/);
- [autenticazione](https://developers.fattureincloud.it/docs/basics/authentication/);
- [permessi OAuth](https://developers.fattureincloud.it/docs/basics/scopes/);
- [codici di errore e conflitti](https://developers.fattureincloud.it/docs/basics/errors/);
- [verifica e invio della fattura elettronica](https://developers.fattureincloud.it/docs/guides/e-invoice-management/).

## Architettura sicura prevista

GitHub Pages non deve chiamare direttamente Fatture in Cloud: token, client secret e refresh token non possono essere inseriti nel browser o in variabili `VITE_*`.

```text
Amministratore -> gestionale -> Supabase Edge Function -> API Fatture in Cloud
                                  |
                                  +-> segreti server e registro idempotente invii
```

Per questo gestionale interno, che usa un solo account Fatture in Cloud, la documentazione ufficiale indica come soluzione adatta l'autenticazione manuale: il token va conservato nei segreti Supabase, non scade e deve quindi avere permessi minimi ed essere revocato o ruotato periodicamente. OAuth 2.0 Authorization Code è l'alternativa più sicura se si preferiscono access token rinnovabili, automazione tramite refresh token o in futuro più account. Anche client secret e refresh token restano esclusivamente nei segreti server. I permessi vanno limitati a quelli necessari, indicativamente `issued_documents.invoices:a` e, solo se si sincronizzano le anagrafiche, `entity.clients:a`.

Ogni Edge Function Fatture in Cloud deve accettare soltanto l'origine configurata, verificare il JWT Supabase, controllare nel database che l'utente sia un amministratore attivo e autorizzare l'azione richiesta. La funzione riceve dal browser solo l'identificativo interno e ricostruisce importi e dati fiscali dagli snapshot nel database.

Salvare una chiave dopo la risposta esterna non basta a evitare duplicati: un timeout può arrivare dopo che Fatture in Cloud ha già creato la fattura. Prima della chiamata va quindi prenotata nel database una richiesta univoca per ordine o periodo; gli esiti dubbi passano allo stato `unknown` e non vengono ritentati alla cieca. La riconciliazione usa ID esterno, numero/sezionale deterministico o un riferimento gestionale stabile. Fatture in Cloud restituisce `409 Conflict` quando, tra gli altri casi, si tenta di creare una fattura con un numero già esistente: questa protezione va usata quando compatibile con la numerazione concordata. Solo dopo la riconciliazione la richiesta può essere conclusa o ripetuta.

## Flusso consigliato

1. Preparare la fattura dagli snapshot fiscali dell'ordine e dai DDT consegnati.
2. Crearla inizialmente come documento da controllare in Fatture in Cloud.
3. Registrare numero, ID esterno, stato, tentativi ed eventuale esito incerto nel gestionale.
4. Dopo il controllo, verificare l'XML e autorizzare separatamente l'invio allo SDI.
5. Per il pagamento alla consegna, riportare il pagamento come saldato solo dopo la conferma del venditore.

Prima di automatizzare servono decisioni fiscali e operative: una fattura per ordine oppure una fattura riepilogativa mensile per cliente, serie e numerazione, data di esigibilità, riferimenti DDT, conto di pagamento e se l'invio allo SDI debba restare manuale. Queste scelte vanno approvate con il commercialista.

Le API di base sono disponibili anche nel piano di prova, ma `Send E-Invoice` e il relativo `dry_run` richiedono un piano a pagamento; inoltre il servizio di fatturazione elettronica deve essere attivo sull'account.
