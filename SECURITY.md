# Sicurezza

Questo repository contiene esclusivamente codice applicativo e dati dimostrativi. Non deve contenere password, chiavi `service_role`, token Telegram o Fatture in Cloud, listini reali, esportazioni del database, PDF reali o dati personali dei clienti.

## Segnalazioni

Non aprire una issue pubblica con dati sensibili. Comunicare il problema direttamente al titolare del repository, indicando il comportamento osservato e i passaggi minimi per riprodurlo.

## Confini di sicurezza

- GitHub Pages serve file pubblici e non protegge dati o route.
- L'autorizzazione effettiva viene applicata nel database Supabase tramite Row Level Security e nelle Edge Functions.
- La chiave pubblicabile Supabase puo comparire nel browser; la chiave `service_role` non deve mai comparire nel frontend o nelle variabili `VITE_*`.
- Client secret, access token e refresh token di Fatture in Cloud devono risiedere soltanto nei segreti server Supabase e non nel browser.
- Le password sono gestite soltanto da Supabase Auth e non sono memorizzate nelle tabelle applicative.
- I PDF DDT reali devono risiedere in uno Storage bucket privato, mai in `public/` o nel repository.
- Per l'uso reale e fortemente consigliato un dominio dedicato al gestionale. I diversi progetti GitHub Pages sotto lo stesso host condividono la stessa origine browser e quindi anche il confine di sicurezza dello storage della sessione.
- Il controllo automatico del bundle e un guardrail euristico, non una prova matematica di assenza di dati: vanno mantenuti secret scanning, revisione delle modifiche e rotazione delle credenziali.
- GitHub Pages non permette di configurare tutti gli header di sicurezza. Con un dominio dedicato, usare un proxy/CDN che imposti almeno CSP via header, protezione anti-framing, HSTS, Referrer-Policy e Permissions-Policy.

## In caso di esposizione accidentale

1. Revocare e ruotare immediatamente la credenziale nel servizio interessato.
2. Rimuovere il dato dalla sorgente e dalla cronologia Git con una procedura concordata con il titolare.
3. Controllare log di accesso, audit degli ordini e webhook.
4. Valutare gli obblighi di notifica previsti dalla normativa privacy con un professionista.
