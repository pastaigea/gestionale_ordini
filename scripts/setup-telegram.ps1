#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9]{8,40}$')]
  [string]$ProjectRef,

  [string]$AdminAppUrl = 'https://pastaigea.github.io/gestionale_ordini/#/admin/ordini',

  [ValidatePattern('^\d+$')]
  [string]$AdminUserId,

  [ValidatePattern('^-?\d+$')]
  [string]$AdminChatId,

  [switch]$SkipDatabasePush,
  [switch]$OverwriteLocalSecrets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-PlainText {
  param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function New-UrlSafeSecret {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }

  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Invoke-TelegramApi {
  param(
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Body = @{}
  )

  $json = $Body | ConvertTo-Json -Depth 10 -Compress
  try {
    $response = Invoke-RestMethod `
      -Method Post `
      -Uri ("https://api.telegram.org/bot{0}/{1}" -f $Token, $Method) `
      -ContentType 'application/json' `
      -Body $json
  }
  catch {
    throw "Chiamata Telegram '$Method' non riuscita. Controlla token e connessione; i dettagli sono stati omessi per non esporre il token."
  }

  if (-not $response.ok) {
    throw "Telegram ha rifiutato '$Method'. Controlla il token e riprova."
  }

  return $response.result
}

function Get-PrivateChatCandidates {
  param([Parameter(Mandatory = $true)][string]$Token)

  $updates = @(Invoke-TelegramApi -Token $Token -Method 'getUpdates' -Body @{
      limit = 100
      timeout = 0
      allowed_updates = @('message')
    })
  $byIdentity = [ordered]@{}

  foreach ($update in $updates) {
    $messageProperty = $update.PSObject.Properties['message']
    if ($null -eq $messageProperty -or $null -eq $messageProperty.Value) {
      continue
    }

    $message = $messageProperty.Value
    if ($null -eq $message.from -or $null -eq $message.chat -or $message.chat.type -ne 'private') {
      continue
    }

    $userId = [string]$message.from.id
    $chatId = [string]$message.chat.id
    if ($userId -notmatch '^\d+$' -or $chatId -notmatch '^-?\d+$') {
      continue
    }

    $firstName = if ($null -ne $message.from.PSObject.Properties['first_name']) {
      [string]$message.from.first_name
    }
    else { '' }
    $lastName = if ($null -ne $message.from.PSObject.Properties['last_name']) {
      [string]$message.from.last_name
    }
    else { '' }
    $username = if ($null -ne $message.from.PSObject.Properties['username']) {
      [string]$message.from.username
    }
    else { '' }
    $displayName = (@($firstName, $lastName) | Where-Object { $_ }) -join ' '
    $key = "$userId|$chatId"

    if (-not $byIdentity.Contains($key)) {
      $byIdentity[$key] = [PSCustomObject]@{
        UserId = $userId
        ChatId = $chatId
        Username = $username
        Name = $displayName
      }
    }
  }

  return @($byIdentity.Values)
}

function Invoke-SupabaseCli {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  & $script:SupabaseCli @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Comando Supabase non riuscito: supabase $($Arguments -join ' ')"
  }
}

function ConvertTo-DotEnvValue {
  param([Parameter(Mandatory = $true)][string]$Value)

  if ($Value -match "[`r`n]") {
    throw 'Un valore di configurazione contiene un ritorno a capo non valido.'
  }
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:SupabaseCli = Join-Path $projectRoot 'node_modules\.bin\supabase.cmd'
$localSecretsPath = Join-Path $projectRoot 'supabase\functions\.env.telegram.local'
$token = $null
$locationPushed = $false

try {
  $appUri = $null
  if (-not [Uri]::TryCreate($AdminAppUrl, [UriKind]::Absolute, [ref]$appUri) -or $appUri.Scheme -ne 'https') {
    throw 'AdminAppUrl deve essere un URL HTTPS assoluto.'
  }
  if (-not (Test-Path -LiteralPath $script:SupabaseCli -PathType Leaf)) {
    throw 'Supabase CLI non trovata. Esegui prima: npm install'
  }
  if ((Test-Path -LiteralPath $localSecretsPath) -and -not $OverwriteLocalSecrets) {
    throw "Esiste gia $localSecretsPath. Per ruotare consapevolmente tutti i segreti usa -OverwriteLocalSecrets."
  }
  if ([string]::IsNullOrWhiteSpace($AdminUserId) -xor [string]::IsNullOrWhiteSpace($AdminChatId)) {
    throw 'AdminUserId e AdminChatId devono essere specificati insieme oppure entrambi omessi.'
  }

  Push-Location -LiteralPath $projectRoot
  $locationPushed = $true

  Write-Host 'Il token non verra mostrato. Non incollarlo in chat, issue o file Git.' -ForegroundColor Yellow
  $secureToken = Read-Host 'Token ricevuto da @BotFather' -AsSecureString
  $token = ConvertTo-PlainText -SecureValue $secureToken
  $secureToken.Dispose()
  if ($token -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') {
    throw 'Il token non ha il formato previsto per un bot Telegram.'
  }

  $bot = Invoke-TelegramApi -Token $token -Method 'getMe'
  Write-Host ("Bot verificato: @{0}" -f $bot.username) -ForegroundColor Green

  $webhookInfo = Invoke-TelegramApi -Token $token -Method 'getWebhookInfo'
  if (-not [string]::IsNullOrWhiteSpace([string]$webhookInfo.url) -and
      ([string]::IsNullOrWhiteSpace($AdminUserId) -or [string]::IsNullOrWhiteSpace($AdminChatId))) {
    throw "Questo bot ha gia un webhook ($($webhookInfo.url)). Per non interromperlo, indica -AdminUserId e -AdminChatId oppure rimuovi prima consapevolmente il vecchio webhook."
  }

  if ([string]::IsNullOrWhiteSpace($AdminUserId)) {
    $candidates = @()
    for ($attempt = 1; $attempt -le 3 -and $candidates.Count -eq 0; $attempt++) {
      [void](Read-Host 'Apri la chat privata con il bot, invia /start, poi premi Invio qui')
      $candidates = @(Get-PrivateChatCandidates -Token $token)
      if ($candidates.Count -eq 0) {
        Write-Warning 'Non vedo ancora messaggi privati inviati al bot.'
      }
    }
    if ($candidates.Count -eq 0) {
      throw 'Nessuna chat privata trovata. Invia /start al bot e riesegui il comando.'
    }

    for ($index = 0; $index -lt $candidates.Count; $index++) {
      $candidate = $candidates[$index]
      $handle = if ($candidate.Username) { "@$($candidate.Username)" } else { '(senza username)' }
      Write-Host ("[{0}] {1} {2} - user {3}, chat {4}" -f ($index + 1), $candidate.Name, $handle, $candidate.UserId, $candidate.ChatId)
    }

    if ($candidates.Count -eq 1) {
      $selectedIndex = 0
    }
    else {
      $selection = Read-Host 'Quale account deve poter Accettare/Rifiutare? Inserisci il numero'
      $selectedNumber = 0
      if (-not [int]::TryParse($selection, [ref]$selectedNumber) -or
          $selectedNumber -lt 1 -or $selectedNumber -gt $candidates.Count) {
        throw 'Selezione amministratore non valida.'
      }
      $selectedIndex = $selectedNumber - 1
    }

    $AdminUserId = $candidates[$selectedIndex].UserId
    $AdminChatId = $candidates[$selectedIndex].ChatId
  }

  $webhookSecret = New-UrlSafeSecret
  $dispatchSecret = New-UrlSafeSecret
  if ($webhookSecret -eq $dispatchSecret) {
    throw 'Generazione casuale dei segreti non riuscita. Riesegui il comando.'
  }

  $secretLines = @(
    '# File locale generato dallo script. Non commettere e non condividere.'
    "TELEGRAM_BOT_TOKEN=$(ConvertTo-DotEnvValue $token)"
    "TELEGRAM_WEBHOOK_SECRET=$(ConvertTo-DotEnvValue $webhookSecret)"
    "TELEGRAM_DISPATCH_SECRET=$(ConvertTo-DotEnvValue $dispatchSecret)"
    "TELEGRAM_ADMIN_USER_IDS=$(ConvertTo-DotEnvValue $AdminUserId)"
    "TELEGRAM_ADMIN_CHAT_ID=$(ConvertTo-DotEnvValue $AdminChatId)"
    "ADMIN_APP_URL=$(ConvertTo-DotEnvValue $AdminAppUrl)"
  )
  [IO.File]::WriteAllLines($localSecretsPath, $secretLines, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Creato il file locale ignorato da Git: $localSecretsPath"

  Write-Host 'Collegamento al progetto Supabase...'
  Invoke-SupabaseCli -Arguments @('link', '--project-ref', $ProjectRef)

  if (-not $SkipDatabasePush) {
    Write-Host 'Anteprima delle migrazioni da applicare al progetto remoto...'
    Invoke-SupabaseCli -Arguments @('db', 'push', '--dry-run')
    $confirmation = Read-Host 'Per applicare le migrazioni al progetto Supabase scrivi APPLICA'
    if ($confirmation -cne 'APPLICA') {
      throw 'Migrazioni non applicate. Nessun secret o webhook remoto e stato configurato.'
    }
    Invoke-SupabaseCli -Arguments @('db', 'push')
  }
  else {
    Write-Warning 'Migrazioni non applicate: assicurati che lo schema del gestionale sia gia presente nel progetto.'
  }

  Write-Host 'Caricamento dei soli sei segreti Telegram personalizzati...'
  Invoke-SupabaseCli -Arguments @('secrets', 'set', '--env-file', $localSecretsPath, '--project-ref', $ProjectRef)

  Write-Host 'Pubblicazione delle Edge Functions Telegram...'
  Invoke-SupabaseCli -Arguments @('functions', 'deploy', 'telegram-dispatch', '--no-verify-jwt', '--project-ref', $ProjectRef)
  Invoke-SupabaseCli -Arguments @('functions', 'deploy', 'telegram-webhook', '--no-verify-jwt', '--project-ref', $ProjectRef)

  $webhookUrl = "https://$ProjectRef.supabase.co/functions/v1/telegram-webhook"
  $dispatchUrl = "https://$ProjectRef.supabase.co/functions/v1/telegram-dispatch"
  [void](Invoke-TelegramApi -Token $token -Method 'setWebhook' -Body @{
      url = $webhookUrl
      secret_token = $webhookSecret
      allowed_updates = @('callback_query')
      drop_pending_updates = $true
    })

  $verifiedWebhook = Invoke-TelegramApi -Token $token -Method 'getWebhookInfo'
  if ([string]$verifiedWebhook.url -ne $webhookUrl) {
    throw 'Telegram non ha confermato l URL webhook previsto.'
  }

  [void](Invoke-TelegramApi -Token $token -Method 'sendMessage' -Body @{
      chat_id = $AdminChatId
      text = 'Bot IGEA collegato correttamente. Il prossimo passo e attivare il trigger ordini in Supabase.'
    })

  Write-Host ''
  Write-Host 'Webhook Telegram registrato e messaggio di prova inviato.' -ForegroundColor Green
  Write-Host 'Completa ora questi due elementi nel Dashboard Supabase:' -ForegroundColor Yellow
  Write-Host '1. Database > Webhooks: tabella public.notification_outbox, evento INSERT, metodo POST.'
  Write-Host "   URL: $dispatchUrl"
  Write-Host '   Header: X-IGEA-Dispatch-Secret (valore TELEGRAM_DISPATCH_SECRET dal file locale).'
  Write-Host '2. Cron: POST ogni 5 minuti allo stesso URL, stesso header, body JSON {"limit":5}.'
  Write-Host "Dopo aver copiato il secret nei due punti, elimina il file locale: $localSecretsPath"
  Write-Host 'Infine crea un ordine di prova e usa Accetta/Rifiuta dal messaggio Telegram.'
}
finally {
  $token = $null
  if ($locationPushed) {
    Pop-Location
  }
}
