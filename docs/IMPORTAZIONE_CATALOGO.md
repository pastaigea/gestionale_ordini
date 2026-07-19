# Importazione privata del catalogo

Il listino reale non fa parte del sito GitHub Pages e non deve essere committato. Il file locale `private/catalogo-prodotti.csv` è già escluso da Git; conservarlo soltanto in una posizione protetta e con accesso limitato.

## Formato CSV

Usare UTF-8, separatore punto e virgola e questa intestazione:

```text
sku;name;price;vat_rate;active;category;package_size;package_label;pricing_mode;description
```

- `price` è il prezzo netto al kg quando `pricing_mode` vale `per_kg`, oppure il prezzo netto della singola unità quando vale `per_unit`;
- `package_size` è espresso in kg ed è obbligatorio per `per_kg`;
- `vat_rate` è una percentuale, per esempio `4` o `10`;
- `active` accetta `SI`, `NO`, `true`, `false`, `1` o `0`;
- `category` accetta `PASTA`, `RIPIENO`, `SPECIALE` o `SERVIZIO`;
- ogni variante di confezione deve avere uno SKU distinto;
- racchiudere tra virgolette un testo che contiene il punto e virgola.

Il trasporto non fa parte del catalogo: gli SKU `TRASP` e `TRASP2` sono riservati e vengono rifiutati sia dall'importatore sia dal database. Ogni ordine contiene automaticamente una sola voce separata “Spese di trasporto”, con valore standard 3,50 € + IVA 22%.

I decimali possono usare la virgola italiana o il punto. Il calcolo per i prodotti al kg è:

```text
quantità confezioni × kg per confezione × prezzo netto/kg
```

## Caricamento

1. Accedere come amministratore e aprire **Prodotti**.
2. Selezionare **Importa catalogo CSV** e scegliere il file dal computer.
3. Controllare il riepilogo e confermare l'importazione.

La validazione avviene prima dell'invio. Il database applica poi l'intero import in una sola transazione, aggiorna per SKU e disattiva i prodotti assenti dal nuovo file; non elimina ordini, snapshot o storico prezzi. Il limite è 500 righe per importazione.

L'importazione attuale scrive nel listino base. Prima della produzione va deciso se le voci in categoria `Speciale` sono comuni oppure riservate a uno specifico cliente; nel secondo caso occorre configurare un listino e una visibilità dedicati prima di caricarle.

In modalità demo l'importazione resta soltanto nel `localStorage` del browser. In modalità Supabase i dati vengono inviati direttamente al database protetto: il CSV non viene incluso nel bundle del sito e non transita da GitHub.

Per un controllo locale aggiuntivo:

```bash
node scripts/catalog-parser.mjs private/catalogo-prodotti.csv
```
