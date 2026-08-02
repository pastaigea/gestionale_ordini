# Importazione clienti senza account

Le anagrafiche cliente e gli account di accesso sono separati. Un
amministratore può importare o creare un cliente, inserirgli ordini e gestire
le consegne senza creare un utente Auth e senza inviare email.

## Preparare il file locale

I dati reali devono restare nella cartella locale `todosGestionale/`, ignorata
da Git. Dalla radice del repository eseguire:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-customers.ps1
```

Lo script legge l'unico file XLSX presente nella cartella e genera, sempre
localmente:

- `clienti-import.tsv`, da scegliere nell'area **Admin > Clienti > Importa
  clienti**;
- `clienti-inviti.csv`, checklist modificabile per organizzare i contatti;
- `modello-email-invito.txt`, testo che l'amministratore può personalizzare e
  inviare in un secondo momento.

Lo script non crea password, non inventa email mancanti e non invia messaggi.
Blocca duplicati di P.IVA nel file e neutralizza celle CSV che potrebbero essere
interpretate come formule da un foglio di calcolo.

Lo script mostra a terminale il riepilogo dell'elaborazione. I conteggi e le
segnalazioni ricavati dal file reale restano nella checklist locale. I file
generati contengono dati reali e non devono essere aggiunti al repository.

## Importare in Supabase

Applicare prima tutte le migrazioni. La RPC `admin_upsert_customers`:

- è riservata a un amministratore attivo;
- accetta al massimo 500 righe in una transazione;
- inserisce o aggiorna per P.IVA normalizzata;
- su un cliente esistente conserva listino, pagamento, trasporto, stato attivo
  e i dati anagrafici assenti dal file;
- non crea righe in `auth.users` o `customer_users`;
- non chiama provider email;
- registra l'operazione nell'audit amministrativo.

Se nel database esistono già due clienti con la stessa P.IVA normalizzata, la
migrazione/importazione si interrompe senza fondere automaticamente i dati.
Risolvere il duplicato esplicitamente prima di riprovare.

Dopo l'importazione, controllare le righe segnalate nella checklist locale.
Tutte le anagrafiche attive sono immediatamente selezionabili in **Nuovo ordine
per un cliente**, anche quando mostrano il badge **Nessun account**.

## Collegare un account in seguito

Salvare o importare un cliente non invia mai un invito. Quando il titolare
decide di abilitarne l'accesso:

1. verificare e salvare un indirizzo email reale;
2. premere **Invita account** nella riga del cliente;
3. confermare esplicitamente l'invio;
4. il cliente riceve il link Supabase per impostare la password.

Il reset password compare soltanto dopo che l'account è stato collegato.
Il signup pubblico resta disabilitato: evita che identità non verificate si
associno autonomamente a un'anagrafica aziendale.
