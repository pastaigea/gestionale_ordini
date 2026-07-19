# Backend Supabase del gestionale ordini IGEA

Questa cartella contiene il backend riproducibile del gestionale. GitHub Pages
ospita soltanto il frontend statico: utenti, dati aziendali, prezzi, ordini,
progressivi DDT e autorizzazioni risiedono in Supabase.

Il repository non contiene dati fiscali reali, password o token. `seed.sql`
usa esclusivamente valori dimostrativi e domini `example.invalid`.

## Contenuto

- `config.toml`: configurazione dello stack locale e delle Edge Functions.
- `migrations/20260719130000_initial_schema.sql`: schema, RLS, RPC, audit,
  outbox Telegram, bucket privato e numeratore DDT.
- `migrations/20260719170000_order_fulfillment.sql`: quantità effettivamente
  evase, rettifiche admin auditate e DDT sostitutivi progressivi.
- `migrations/20260719180000_transport_and_product_promotions.sql`: trasporto
  separato dai prodotti, promo percentuali autoritative e modifica auditata
  del prezzo di consegna.
- `seed.sql`: catalogo, listino, fornitore e cliente totalmente fittizi.
- `functions/admin-users`: invito/creazione, reset password e
  abilitazione/disabilitazione clienti.
- `functions/telegram-dispatch`: invia gli ordini pending al solo account/chat
  Telegram configurato.
- `functions/telegram-webhook`: applica Accetta/Rifiuta con token monouso.
- `functions/_shared`: autenticazione, CORS, Telegram e primitive crittografiche.

## Avvio locale

Servono Node.js, Supabase CLI e un runtime Docker compatibile.

```powershell
npm install supabase --save-dev
npx supabase start
npx supabase db reset
npx supabase status
```

`db reset` elimina e ricrea esclusivamente il database Supabase locale,
applica tutte le migrazioni e infine il seed. Non usare `db reset --linked` su
produzione.

Per le Functions, copiare `functions/.env.example` in un file locale ignorato
da Git e sostituire i placeholder. Le chiavi locali si ricavano da
`npx supabase status`.

```powershell
npx supabase functions serve --env-file supabase/functions/.env.local
```

Lo stack locale non va esposto direttamente su Internet. Per Telegram usare
preferibilmente un progetto Supabase di sviluppo separato; in alternativa
testare `telegram-dispatch` con un adapter/mock.

## Primo amministratore

La registrazione pubblica è disabilitata. Creare l'utente Auth da Supabase
Studio/Dashboard e assegnargli il ruolo con il suo UUID:

```sql
insert into public.profiles (user_id, display_name, role, active)
values ('UUID_AUTH_AMMINISTRATORE', 'Amministratore', 'admin', true);
```

Proteggere l'account amministratore con MFA. Gli utenti cliente vengono poi
creati dalla Edge Function `admin-users`; non inserire password in tabelle SQL.

Nel database il ruolo cliente si chiama `client`. Se il frontend usa il nome
`customer`, l'adapter deve effettuare una semplice mappatura, senza mai fidarsi
di un ruolo memorizzato in `sessionStorage` o `localStorage`.

## Contratto frontend

Tutte le chiamate RPC usano il JWT Supabase dell'utente. Gli importi Postgres
`numeric` arrivano normalmente come stringhe: non usare floating point per
ricalcolare valori autoritativi nel browser.

### Catalogo effettivo

```text
get_catalog(p_customer_id uuid = null)
```

Restituisce:

```text
id, sku, name, category, description, uom, package_label, package_size,
pricing_mode, unit_price_net, vat_rate, currency, promoted,
promo_percent_discount, promo_label
```

Il cliente omette `p_customer_id`; l'admin lo specifica. Il prezzo viene
risolto dal listino assegnato e dalla sua validità temporale. La migrazione crea
un `Listino base` neutro senza prodotti, così l'onboarding ha sempre un listino
valido ma non espone prezzi finché l'admin non li configura.

`pricing_mode` distingue `per_kg` e `per_unit`. `quantity` rappresenta sempre
il numero intero di confezioni/unità (da 1 a 999). Il totale riga è calcolato esclusivamente dal
backend come `quantity * package_size * unit_price_net` per `per_kg`, oppure
`quantity * unit_price_net` per `per_unit`; IVA e arrotondamenti vengono poi
applicati alla riga. Nel primo caso `unit_price_net` è quindi un prezzo netto
in EUR/kg e `package_size` è obbligatorio.

Per impostare un prezzo senza sovrascrivere la storia usare:

```text
admin_set_current_price(
  p_price_list_id uuid,
  p_product_id uuid,
  p_unit_price_net numeric,
  p_vat_rate numeric,
  p_effective_on date = oggi
) -> price_list_items
```

La RPC chiude al giorno precedente il prezzo valido, inserisce la nuova riga e
serializza aggiornamenti concorrenti sul listino. Una modifica ripetuta con la
stessa data aggiorna la riga di quel giorno ed è comunque registrata
nell'audit amministrativo. Il browser non ha DML diretto su
`price_list_items`.

Per creare o aggiornare prodotto e prezzo senza una fase intermedia usare la
RPC transazionale:

```text
admin_upsert_product_with_price(
  p_sku text, p_name text, p_category text, p_description text,
  p_uom text, p_package_label text, p_package_size numeric,
  p_pricing_mode product_pricing_mode, p_active boolean,
  p_price_list_id uuid, p_unit_price_net numeric,
  p_vat_rate numeric, p_effective_on date = oggi,
  p_product_id uuid = null
) -> {
  product_id, sku, name, category, description, uom, package_label,
  package_size, pricing_mode, active, price_list_id, unit_price_net, vat_rate,
  valid_from, valid_to
}
```

Con `p_product_id=null` crea il prodotto; altrimenti lo aggiorna. Se prodotto,
listino o prezzo non sono validi, tutta la transazione viene annullata e non
resta alcun prodotto privo di prezzo. Per disattivare un prodotto esistente si
usa invece l'update amministrativo RLS sulla sola tabella `products`.

Per importare un catalogo completo in una sola transazione usare:

```text
admin_import_catalog(
  p_products jsonb,
  p_replace boolean = false
) -> { imported_count, deactivated_count }
```

L'array accetta al massimo 500 oggetti con i campi `sku`, `name`, `category`,
`description`, `uom`, `package_label`, `package_size`, `pricing_mode`,
`unit_price_net`, `vat_rate` e `active`. SKU duplicati o una singola riga non
valida annullano l'intero import. Con `p_replace=true`, i prodotti non presenti
nel file vengono disattivati ma mai eliminati, conservando ordini e storico
prezzi. L'operazione e i conteggi sono registrati nell'audit.

`TRASP`, `TRASP2` e le corrispondenti descrizioni di trasporto sono riservati:
non possono essere importati o ordinati. Il trasporto è memorizzato una sola
volta nei campi economici dell'ordine e del DDT, separatamente da
`order_items`.

Cataloghi e prezzi reali non devono essere versionati in un repository
pubblico. Conservare il CSV temporaneo sotto `private/` alla radice (directory
ignorata da Git), importarlo dall'area admin e conservarne l'originale in un
sistema aziendale protetto.

### Inserimento o sostituzione atomica ordine

Usare preferibilmente una sola RPC:

```text
place_order(
  p_order_id uuid = null,
  p_requested_delivery_date date,
  p_notes text,
  p_items jsonb,
  p_expected_version integer = null,
  p_customer_id uuid = null,
  p_idempotency_key uuid = null
) -> orders
```

`p_items` deve essere un array non vuoto e senza duplicati:

```json
[
  { "product_id": "UUID_PRODOTTO", "quantity": 3 },
  { "product_id": "UUID_PRODOTTO_2", "quantity": 1 }
]
```

Per un ordine nuovo lasciare `p_order_id` e `p_expected_version` null. Un
cliente lascia sempre nullo anche `p_customer_id`; l'admin può specificarlo.
Il frontend deve generare un UUID `p_idempotency_key` quando l'utente inizia
l'invio e riutilizzare lo stesso UUID per ogni retry: richieste concorrenti con
la stessa coppia cliente/chiave restituiscono lo stesso ordine invece di
crearne due.
Per sostituire un ordine `draft` o `submitted`, passare UUID e `version`
corrente. Tutta l'operazione è una singola transazione: prezzi e IVA vengono
risolti dal backend, le righe precedenti vengono sostituite e lo stato finale è
`submitted`. Qualunque errore annulla l'intera chiamata.

Le RPC granulari restano disponibili per un editor a bozze:

```text
create_order(date, notes, customer_id = null) -> orders
update_order(order_id, date, notes, expected_version) -> orders
set_order_item(order_id, product_id, quantity, expected_version) -> orders
remove_order_item(order_id, product_id, expected_version) -> orders
submit_order(order_id, expected_version) -> orders
withdraw_order(order_id, expected_version) -> orders
```

`version` implementa optimistic locking; su conflitto il database restituisce
SQLSTATE `40001` e il frontend deve ricaricare l'ordine.

### Evasione parziale e rettifica amministrativa

`order_items.quantity` resta la quantità richiesta dal cliente. L'admin può
impostare la quantità effettivamente consegnata con:

```text
admin_adjust_order_fulfillment(
  p_order_id uuid,
  p_items jsonb,
  p_expected_version integer,
  p_reason text
) -> orders
```

Ogni riga di `p_items` contiene `product_id` e `fulfilled_quantity`, compresa
tra zero e la quantità ordinata. Tutte le righe devono essere presenti e almeno
una deve restare positiva. La RPC conserva prezzi e richiesta originale,
ricalcola gli importi, registra operatore/motivo/audit e incrementa `version`.
Se esiste già un DDT valido, lo marca `void` e crea nella stessa transazione un
DDT sostitutivo con un nuovo progressivo. Un ordine con pagamento alla consegna
già confermato richiede invece un flusso separato di rimborso o integrazione.

### Modalita e conferma del pagamento

La modalita effettiva viene scelta dal cliente sul singolo ordine e salvata in
`orders.payment_method_snapshot`, con i valori:

```text
end_of_month   fatturazione a fine mese (default)
on_delivery    pagamento alla consegna
```

`customers.payment_method` resta solo come default legacy per dati esistenti.
Il browser invia `p_payment_method` quando crea o modifica l'ordine; il backend
accetta solo i valori dell'enum e conserva lo snapshot nell'ordine. Lo stesso
valore viene conservato nel DDT e nei payload dell'outbox.

Per registrare l'incasso di un ordine con pagamento alla consegna usare:
```text
admin_confirm_order_payment(
  p_order_id uuid,
  p_expected_version integer
) -> orders
```

La RPC è riservata a un profilo `admin` attivo, blocca la riga e controlla
`version`. È ammessa soltanto per ordini `accepted`, `in_delivery` o
`delivered` con snapshot `on_delivery`; salva `payment_confirmed_at` e
`payment_confirmed_by`, incrementa la versione e scrive audit/outbox. Un retry
della stessa conferma restituisce la prova già registrata senza cambiare di
nuovo timestamp o versione. Gli ordini `end_of_month` non richiedono questa
conferma.

### Stati e DDT

```text
admin_transition_order(order_id, new_status, expected_version, note = null)
prepare_delivery_document(
  order_id, expected_version, series = 'A', issued_on = null,
  transport_started_at = null, transport_reason = 'Vendita', carrier = {},
  destination = null, packages = null, notes = null
) -> delivery_documents
```

Transizioni ammesse:

```text
draft -> submitted
submitted -> draft                 (ritiro per modifica)
submitted -> accepted | rejected
accepted -> in_delivery            (solo prepare_delivery_document)
in_delivery -> delivered
draft | submitted | accepted -> cancelled   (solo se il pagamento non è già stato confermato)
```

Un ordine con incasso confermato non può essere annullato: richiede un workflow
separato di storno/rimborso, non ancora implementato nell'MVP.

`prepare_delivery_document` blocca ordine e contatore nella stessa
transazione, assegna un progressivo univoco per serie/anno, salva gli snapshot
— inclusa la modalità di pagamento — e porta l'ordine a `in_delivery`. Una ripetizione per lo stesso ordine restituisce
lo stesso DDT e non consuma un nuovo numero.

La consegna standard è 3,50 EUR netti con IVA fissa al 22%. L'admin può
rettificarla sul DDT con `admin_update_delivery_fee(document_id, fee_net)`;
la RPC aggiorna anche il totale ordine, incrementa la versione e registra
l'operazione nell'audit. Un ordine con pagamento già confermato non è
modificabile senza un flusso separato di rimborso o integrazione.

Nell'MVP `delivery_documents.status` nasce `ready`, mentre
`pdf_object_path/pdf_sha256` restano null: il frontend esporta il PDF dagli
snapshot e il file non è archiviato dal backend. `mark_delivery_document_ready`
è già disponibile per una futura archiviazione nel bucket privato `ddt-pdf`.
Campi, serie, arrotondamenti e conservazione vanno validati con il
commercialista prima della produzione.

## Gestione utenti

`admin-users` accetta solo `POST` autenticati da un profilo `admin` attivo.

Azioni:

- `invite`: `email`, `display_name`, `customer` oppure
  `existing_customer_id`;
- `create`: stessi campi più `password` di almeno 12 caratteri;
- `send_reset`: `email` e, opzionalmente, `redirect_to`;
- `set_password`: `user_id`, `password`;
- `update_email`: `user_id`, `email`; aggiorna sia Auth sia l'email
  dell'anagrafica cliente, con rollback compensativo se il secondo passaggio
  fallisce;
- `disable` / `enable`: `user_id`.

L'admin non riceve mai una password dal database. `disable` banna l'identità
Auth e imposta `profiles.active=false`; le policy richiedono un profilo attivo,
quindi anche un JWT emesso in precedenza perde accesso applicativo.

Creazione Auth e registrazione anagrafica non possono condividere una singola
transazione tra servizi: se la RPC SQL fallisce, la Function elimina l'utente
Auth appena creato come compensazione.

## Telegram

Impostare come secret delle Functions, mai nel frontend o nel repository:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_DISPATCH_SECRET
TELEGRAM_ADMIN_USER_IDS
TELEGRAM_ADMIN_CHAT_ID
ADMIN_APP_URL
```

`TELEGRAM_WEBHOOK_SECRET` e `TELEGRAM_DISPATCH_SECRET` devono essere casuali,
lunghi e diversi. Per produzione:

```powershell
npm run telegram:setup -- -ProjectRef IL_PROJECT_REF
```

In alternativa alla procedura guidata, creare un file ignorato che contenga
soltanto i sei secret personalizzati elencati sopra; non caricare le variabili
`SUPABASE_*` del file di esempio nell'ambiente hosted. Quindi eseguire:

```powershell
npx supabase secrets set --env-file supabase/functions/.env.telegram.local
npx supabase functions deploy admin-users
npx supabase functions deploy telegram-dispatch --no-verify-jwt
npx supabase functions deploy telegram-webhook --no-verify-jwt
```

Creare il bot con BotFather e registrare il webhook tramite la Bot API usando l'URL HTTPS della Function e
lo stesso `TELEGRAM_WEBHOOK_SECRET` come `secret_token`. Il webhook controlla:

1. header `X-Telegram-Bot-Api-Secret-Token` in tempo costante;
2. ID utente in `TELEGRAM_ADMIN_USER_IDS`;
3. chat esatta;
4. callback token casuale, hashato nel DB, monouso e con scadenza;
5. `order.version` e stato ancora `submitted`;
6. `update_id` Telegram contro i replay.

Configurare dal Dashboard un Database Webhook sull'`INSERT` di
`notification_outbox` verso `telegram-dispatch`, aggiungendo l'header
`X-IGEA-Dispatch-Secret`. Il payload del webhook può restare quello standard:
la Function consuma soltanto gli eventi pending `order.submitted`, senza
marcare come elaborati gli eventi destinati ad altri consumer. Per ritentare anche quando non arrivano
nuovi ordini, configurare una chiamata pianificata ogni pochi minuti con lo
stesso header. Non salvare il segreto direttamente in una migrazione SQL;
usare i Secrets/Vault del progetto. La chiamata pianificata deve essere `POST`
e deve includere un body JSON, per esempio `{"limit":5}`. La procedura completa,
con URL e campi del Dashboard, e in `docs/TELEGRAM.md`.

## RLS e privilegi

- `anon` non ha accesso a nessuna tabella o RPC applicativa.
- Ogni tabella pubblica ha RLS abilitata.
- Un cliente vede solo anagrafica, ordini, righe, storico e DDT del proprio
  `customer_id`, oltre al solo listino assegnato.
- Un utente disabilitato non può leggere neppure catalogo o dati fornitore.
- Il browser non ha `INSERT/UPDATE` diretto su ordini, righe, stati, contatori,
  outbox o documenti.
- Le funzioni `security definer` hanno `search_path=''`, controlli espliciti e
  grant minimi.
- La secret/service key è usata soltanto dalle Edge Functions e bypassa RLS:
  non deve mai comparire in variabili `VITE_*`.

## Deploy database

Da un clone pulito:

```powershell
npx supabase login
npx supabase link --project-ref PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Non applicare `seed.sql` alla produzione. Completare `supplier_settings`, creare
prodotti/listini, assegnare clienti e verificare le redirect URL Auth prima di
accettare ordini reali.

## Controlli consigliati

```powershell
npm run test:backend
npx supabase db reset
npx supabase db lint --local --level warning
npx --yes deno check --config supabase/functions/deno.json `
  supabase/functions/admin-users/index.ts `
  supabase/functions/telegram-dispatch/index.ts `
  supabase/functions/telegram-webhook/index.ts
```

`test:backend` esegue migrazione e seed in PostgreSQL/PGlite, verifica un
import bulk interamente fittizio, la modalità `replace`, gli snapshot delle
righe e i calcoli server sia `per_kg` sia `per_unit`. Verifica inoltre default
e snapshot del metodo di pagamento, autorizzazione/stato/versione della
conferma, audit/outbox, idempotenza del doppio click e snapshot nel DDT.

Test indispensabili prima del go-live: due clienti con tentativi cross-tenant,
account disabilitato, manomissione prezzi/stati, modifica concorrente tramite
`version`, doppio click Telegram, webhook con secret/utente/chat errati e più
allocazioni DDT simultanee nello stesso anno.
