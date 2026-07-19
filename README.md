# Gestionale ordini Igea

Portale B2B per **Pasta Igea**: i clienti ordinano la pasta dal proprio account, vedono prezzi e stato, mentre l'amministratore gestisce ordini, clienti, catalogo e documenti di trasporto.

La versione locale include una modalita demo completa con dati esclusivamente fittizi. La modalita reale usa GitHub Pages soltanto per l'interfaccia e Supabase per autenticazione, database protetto, numerazione DDT e funzioni Telegram.

## Funzioni incluse

- accesso separato cliente/amministratore;
- isolamento dei dati cliente con PostgreSQL Row Level Security;
- catalogo importabile da CSV, confezioni, prezzi netti al kg/per unità, IVA configurabile e totale lordo;
- promo prodotto con percentuale scelta dall'admin, prezzo scontato calcolato dal server e priorità in cima al catalogo;
- una sola voce trasporto automatica per ordine, separata dai prodotti, con default 3,50 € + IVA 22%;
- inserimento ordine sia dal cliente sia dall'amministratore per conto del cliente;
- rettifica amministrativa delle quantità effettivamente consegnate, senza perdere la richiesta originale;
- stati “In ordine”, “Accettato”, “Rifiutato”, “In consegna” e “Consegnato”;
- dashboard amministrativa per ordini, clienti, prodotti e dati Igea;
- DDT progressivo annuale, snapshot dei dati, sostituzione tracciata in caso di rettifica ed esportazione PDF;
- notifica Telegram con pulsanti Accetta/Rifiuta;
- scelta della modalità di pagamento per ordine e conferma amministrativa del pagamento alla consegna;
- workflow pronto per `pastaigea/gestionale_ordini` su GitHub Pages.

## Avvio locale

Richiede Node.js 22.

```bash
npm install
npm run dev
```

Aprire l'indirizzo mostrato da Vite. La schermata di accesso espone due account **demo** chiaramente fittizi; non vengono usati nella modalita Supabase. Le modifiche demo restano nel `localStorage` del browser e possono essere azzerate dall'interfaccia.

```bash
npm test
npm run build
npm run preview
```

## Sicurezza

GitHub Pages e un hosting statico e pubblico: da solo non puo proteggere password o un database. Per questo il frontend non contiene dati reali o segreti. Supabase Auth conserva le password, le policy RLS limitano ogni cliente alle proprie righe e le operazioni sensibili passano da RPC/Edge Functions.

Nel frontend sono ammesse solo URL e publishable key Supabase. **Non inserire mai** `service_role`, token Telegram o Fatture in Cloud, password, PDF o esportazioni cliente in file Git o variabili `VITE_*`.

## Passaggio alla produzione

1. Leggere [configurazione completa](docs/CONFIGURAZIONE.md).
2. Creare il backend applicando le migrazioni in `supabase/`.
3. Completare e far verificare i [dati fiscali mancanti](docs/DATI_DA_CONFERMARE.md).
4. Importare il listino seguendo la guida al [catalogo CSV](docs/IMPORTAZIONE_CATALOGO.md).
5. Configurare il [bot Telegram](docs/TELEGRAM.md).
6. Impostare le variabili pubbliche Supabase nelle GitHub Actions Variables.
7. Abilitare GitHub Pages con sorgente **GitHub Actions**.
8. Prima di caricare dati reali, associare a Pages un dominio dedicato (per esempio `ordini.example.it`) e configurarlo anche tra le redirect URL di Supabase Auth.

Il deploy pubblico viene deliberatamente bloccato se le variabili Supabase mancano, cosi la modalita demo non finisce online per errore.

Nell'MVP il PDF DDT viene rigenerato nel browser a partire da snapshot protetti. Prima dell'uso fiscale va aggiunta l'archiviazione immutabile del PDF nel bucket privato gia predisposto, con hash del file e download autorizzato.

## Documentazione

- [Architettura e confini di sicurezza](docs/ARCHITETTURA.md)
- [Configurazione locale e produzione](docs/CONFIGURAZIONE.md)
- [Importazione privata del catalogo](docs/IMPORTAZIONE_CATALOGO.md)
- [Telegram](docs/TELEGRAM.md)
- [Integrazione Fatture in Cloud](docs/FATTURE_IN_CLOUD.md)
- [Dati da confermare](docs/DATI_DA_CONFERMARE.md)
- [Policy di sicurezza](SECURITY.md)

> La generazione tecnica del DDT non sostituisce il controllo fiscale. Serie, numerazione, aliquote, contenuto obbligatorio e conservazione devono essere approvati dal commercialista prima dell'uso reale.
