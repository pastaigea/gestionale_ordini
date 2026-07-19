export const forbidden = [
  // Segreti/chiavi che non devono mai arrivare nel browser.
  { label: 'chiave Supabase service role', pattern: /SUPABASE_SERVICE_ROLE_KEY|sb_secret_[a-z0-9_-]{16,}/i },
  { label: 'token Telegram', pattern: /TELEGRAM_BOT_TOKEN|\b\d{8,12}:[a-z0-9_-]{30,}\b/i },
  {
    label: 'credenziale Fatture in Cloud',
    pattern: /(?:FATTURE_IN_CLOUD|FIC)_(?:(?:ACCESS|REFRESH|MANUAL)_TOKEN|TOKEN|CLIENT_SECRET)/i,
  },
  { label: 'chiave privata', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  // Marcatori che indicano dati reali inseriti per errore nel frontend.
  { label: 'marcatore dati reali', pattern: /REAL_(?:VAT|ADDRESS|EMAIL|PHONE)|DATI_REALI_IGEA/i },
]
