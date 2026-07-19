# Configurazione del bot Telegram

Il bot invia all'amministratore una notifica per ogni nuovo ordine e mostra i
pulsanti **Accetta** e **Rifiuta**. Token, segreti e chiavi amministrative
restano nelle Edge Functions Supabase e non entrano mai nel frontend o in Git.

> La modalità demo usa soltanto `localStorage` e non crea eventi nel database:
> Telegram funziona solo dopo aver collegato l'app a un vero progetto Supabase.
> Per ricevere i callback non è sufficiente lasciare tutto sul computer locale,
> perché Telegram deve raggiungere un URL HTTPS pubblico.

## 1. Creare il bot

1. Su Telegram aprire esclusivamente la chat verificata `@BotFather`.
2. Inviare `/newbot`, scegliere il nome e uno username che termini con `bot`.
3. Conservare il token ricevuto: non incollarlo in chat, issue, screenshot,
   file versionati o variabili `VITE_*`.
4. Aprire la chat privata con il nuovo bot e inviare `/start`. Il bot non può
   iniziare autonomamente una conversazione con l'amministratore.

Questa operazione va fatta prima di registrare il webhook, perché Telegram non
consente di usare `getUpdates` mentre un webhook è attivo.

## 2. Creare e collegare Supabase

Creare un progetto Supabase, preferibilmente in una regione UE, e copiare il
**Project ref** dalle impostazioni del progetto. Dalla radice del repository:

```powershell
npm install
npm exec supabase login
npm run telegram:setup -- -ProjectRef IL_PROJECT_REF
```

Lo script:

- legge il token senza mostrarlo;
- verifica il bot e ricava user ID e chat ID dal messaggio `/start`;
- genera due segreti casuali, lunghi e distinti;
- mostra l'anteprima delle migrazioni e le applica solo dopo la conferma
  testuale `APPLICA`;
- carica in Supabase soltanto i sei segreti personalizzati;
- pubblica `telegram-dispatch` e `telegram-webhook` senza verifica JWT, perché
  ciascuna funzione valida il proprio secret dedicato;
- registra il webhook Bot API limitandolo ai `callback_query`;
- verifica il webhook e invia un messaggio di prova nella chat scelta.

Il token non viene passato come argomento da riga di comando. Lo script crea
temporaneamente il file ignorato da Git
`supabase/functions/.env.telegram.local`, necessario per completare i due
passaggi nel Dashboard. Il file contiene esclusivamente:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_DISPATCH_SECRET
TELEGRAM_ADMIN_USER_IDS
TELEGRAM_ADMIN_CHAT_ID
ADMIN_APP_URL
```

Non usare l'intero `supabase/functions/.env.example` con `secrets set` sul
progetto remoto: include anche variabili `SUPABASE_*` che nell'ambiente hosted
sono già fornite da Supabase e non devono essere sovrascritte.

Se il database è già aggiornato, si può aggiungere `-SkipDatabasePush`. Se il
bot aveva già un webhook, lo script non lo interrompe automaticamente: occorre
fornire insieme `-AdminUserId` e `-AdminChatId`, oppure rimuovere
consapevolmente il vecchio webhook prima di ripetere l'identificazione.

## 3. Notifica immediata sui nuovi ordini

Nel Dashboard Supabase creare un **Database Webhook** con questi valori:

| Campo | Valore |
|---|---|
| Nome | `telegram_order_insert` |
| Schema / tabella | `public.notification_outbox` |
| Evento | solo `INSERT` |
| Metodo | `POST` |
| URL | `https://IL_PROJECT_REF.supabase.co/functions/v1/telegram-dispatch` |
| Header | `Content-Type: application/json` |
| Header privato | `X-IGEA-Dispatch-Secret: ...` |

Il valore dell'ultimo header è `TELEGRAM_DISPATCH_SECRET` nel file locale. Il
payload standard del Database Webhook va bene: il dispatcher cerca nell'outbox
gli eventi `order.submitted` ancora da inviare.

## 4. Retry automatico

Il dispatcher registra gli errori temporanei nell'outbox e risponde comunque
al trigger. Per questo il retry programmato è indispensabile.

Nel Dashboard aprire **Integrations > Cron**, abilitare Cron se necessario e
creare un job:

| Campo | Valore |
|---|---|
| Nome | `telegram_dispatch_retry` |
| Frequenza | `*/5 * * * *` |
| Tipo | richiesta HTTP / Edge Function |
| Metodo | `POST` |
| URL | lo stesso URL `telegram-dispatch` |
| Header | `Content-Type: application/json` |
| Header privato | lo stesso `X-IGEA-Dispatch-Secret` |
| Body | `{"limit":5}` |

Dopo aver copiato il secret sia nel Database Webhook sia nel job Cron,
eliminare `supabase/functions/.env.telegram.local`. I segreti caricati nelle
Edge Functions sono disponibili subito e non richiedono un nuovo deploy.

## 5. Collegare l'app reale e collaudare

La configurazione Telegram non trasforma automaticamente la demo nel portale
reale. Creare `.env.local` con la sola publishable key del progetto:

```dotenv
VITE_APP_MODE=supabase
VITE_BASE_PATH=/
VITE_SUPABASE_URL=https://IL_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

La publishable key è destinata al browser; non usare mai la secret key o la
legacy `service_role`. Avviare poi `npm run dev`, accedere come amministratore e
cliente reali e fare il collaudo completo:

1. inserire e inviare un ordine di prova;
2. verificare che arrivi un solo messaggio Telegram;
3. premere **Accetta** o **Rifiuta**;
4. verificare nell'app il nuovo stato e lo storico;
5. ripremere il vecchio pulsante e verificare che non possa applicare una
   seconda modifica;
6. controllare nel Dashboard lo storico del Database Webhook, del job Cron e i
   log delle due Edge Functions.

La notifica contiene soltanto ragione sociale, numero ordine, data di consegna,
modalità di pagamento e totale. Non contiene indirizzo o dati fiscali. L'uso di
Telegram come destinatario terzo va comunque riportato e valutato nella
documentazione privacy prima dell'uso con clienti reali.

Per WhatsApp Cloud API servono account Meta Business, template approvati e una
configurazione webhook separata. Può essere aggiunto in seguito come secondo
consumer dell'outbox senza cambiare il modello ordini.
