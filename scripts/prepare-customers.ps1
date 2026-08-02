[CmdletBinding()]
param(
  [Parameter()]
  [string]$InputPath,

  [Parameter()]
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory '..'))
$privateDirectory = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'todosGestionale'))

function Assert-PathInsidePrivateDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $allowedPrefix = $privateDirectory.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  ) + [System.IO.Path]::DirectorySeparatorChar
  if (
    $resolved -ne $privateDirectory -and
    -not $resolved.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "$Label deve trovarsi dentro $privateDirectory."
  }
  return $resolved
}

if (-not (Test-Path -LiteralPath $privateDirectory -PathType Container)) {
  throw "Cartella privata non trovata: $privateDirectory"
}

if ([string]::IsNullOrWhiteSpace($InputPath)) {
  $workbooks = @(Get-ChildItem -LiteralPath $privateDirectory -File -Filter '*.xlsx')
  if ($workbooks.Count -ne 1) {
    throw "Specificare -InputPath: nella cartella privata devono esserci esattamente un file XLSX, trovati $($workbooks.Count)."
  }
  $InputPath = $workbooks[0].FullName
}

$InputPath = Assert-PathInsidePrivateDirectory -Path $InputPath -Label 'Il file di origine'
if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
  throw "File XLSX non trovato: $InputPath"
}
if ([System.IO.Path]::GetExtension($InputPath) -ne '.xlsx') {
  throw 'Il file di origine deve avere estensione .xlsx.'
}
if ((Get-Item -LiteralPath $InputPath).Length -gt 50MB) {
  throw 'Il file XLSX supera il limite di sicurezza di 50 MB.'
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = $privateDirectory
}
$OutputDirectory = Assert-PathInsidePrivateDirectory -Path $OutputDirectory -Label 'La cartella di output'
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
  [void](New-Item -ItemType Directory -Path $OutputDirectory)
}

function Read-ZipEntryText {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Compression.ZipArchive]$Archive,

    [Parameter(Mandatory = $true)]
    [string]$EntryName,

    [Parameter()]
    [switch]$Optional
  )

  $entry = $Archive.GetEntry($EntryName)
  if ($null -eq $entry) {
    if ($Optional) { return $null }
    throw "Voce XLSX mancante: $EntryName"
  }
  if ($entry.Length -gt 25MB) {
    throw "Voce XLSX troppo grande: $EntryName"
  }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

function ConvertFrom-SafeXml {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text
  )

  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $stringReader = New-Object System.IO.StringReader($Text)
  $xmlReader = [System.Xml.XmlReader]::Create($stringReader, $settings)
  try {
    $document = New-Object System.Xml.XmlDocument
    $document.XmlResolver = $null
    $document.Load($xmlReader)
    return $document
  } finally {
    $xmlReader.Dispose()
    $stringReader.Dispose()
  }
}

function Get-CellText {
  param(
    [Parameter(Mandatory = $true)]
    [System.Xml.XmlElement]$Cell,

    [Parameter(Mandatory = $true)]
    [System.Xml.XmlNamespaceManager]$NamespaceManager,

    [Parameter(Mandatory = $true)]
    [object[]]$SharedStrings
  )

  $cellType = [string]$Cell.GetAttribute('t')
  if ($cellType -eq 'inlineStr') {
    $inline = $Cell.SelectSingleNode('x:is', $NamespaceManager)
    return if ($null -eq $inline) { '' } else { [string]$inline.InnerText }
  }

  $valueNode = $Cell.SelectSingleNode('x:v', $NamespaceManager)
  if ($null -eq $valueNode) { return '' }
  $rawValue = [string]$valueNode.InnerText
  if ($cellType -eq 's') {
    $sharedIndex = 0
    if (-not [int]::TryParse($rawValue, [ref]$sharedIndex) -or $sharedIndex -lt 0 -or $sharedIndex -ge $SharedStrings.Count) {
      throw "Indice shared string XLSX non valido: $rawValue"
    }
    return [string]$SharedStrings[$sharedIndex]
  }
  if ($cellType -eq 'b') {
    return if ($rawValue -eq '1') { 'TRUE' } else { 'FALSE' }
  }
  return $rawValue
}

function Clean-CellText {
  param([AllowNull()][string]$Value)
  if ($null -eq $Value) { return '' }
  return (($Value -replace "[\r\n\t]+", ' ') -replace '\s{2,}', ' ').Trim()
}

function Get-FirstValue {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Row,

    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  foreach ($name in $Names) {
    if ($Row.ContainsKey($name)) {
      $candidate = Clean-CellText ([string]$Row[$name])
      if (-not [string]::IsNullOrWhiteSpace($candidate)) { return $candidate }
    }
  }
  return ''
}

function Normalize-VatNumber {
  param([Parameter(Mandatory = $true)][string]$Value)
  $normalized = ($Value.ToUpperInvariant() -replace '[^A-Z0-9]', '')
  if ($normalized -match '^IT[0-9]{11}$') { return $normalized.Substring(2) }
  return $normalized
}

function ConvertTo-TsvCell {
  param([AllowNull()][string]$Value)
  return Clean-CellText $Value
}

function ConvertTo-SafeCsvCell {
  param([AllowNull()][string]$Value)
  $clean = Clean-CellText $Value
  # Evita che un foglio di calcolo interpreti dati anagrafici come formule.
  if ($clean -match '^[=+@-]') { $clean = "'$clean" }
  return '"' + ($clean -replace '"', '""') + '"'
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($InputPath)
try {
  $workbookXml = ConvertFrom-SafeXml (Read-ZipEntryText -Archive $archive -EntryName 'xl/workbook.xml')
  $workbookNamespace = New-Object System.Xml.XmlNamespaceManager($workbookXml.NameTable)
  $workbookNamespace.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $workbookNamespace.AddNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  $firstSheet = $workbookXml.SelectSingleNode('//x:sheets/x:sheet[1]', $workbookNamespace)
  if ($null -eq $firstSheet) { throw 'Il file XLSX non contiene fogli.' }
  $relationshipId = $firstSheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')

  $relationshipsXml = ConvertFrom-SafeXml (Read-ZipEntryText -Archive $archive -EntryName 'xl/_rels/workbook.xml.rels')
  $relationshipsNamespace = New-Object System.Xml.XmlNamespaceManager($relationshipsXml.NameTable)
  $relationshipsNamespace.AddNamespace('r', 'http://schemas.openxmlformats.org/package/2006/relationships')
  $relationship = $relationshipsXml.SelectSingleNode("//r:Relationship[@Id='$relationshipId']", $relationshipsNamespace)
  if ($null -eq $relationship) { throw 'Relazione del primo foglio XLSX non trovata.' }
  $worksheetTarget = ([string]$relationship.GetAttribute('Target')).Replace('\', '/').TrimStart('/')
  $worksheetEntry = if ($worksheetTarget.StartsWith('xl/')) { $worksheetTarget } else { "xl/$worksheetTarget" }

  $sharedStrings = @()
  $sharedStringsText = Read-ZipEntryText -Archive $archive -EntryName 'xl/sharedStrings.xml' -Optional
  if ($null -ne $sharedStringsText) {
    $sharedStringsXml = ConvertFrom-SafeXml $sharedStringsText
    $sharedNamespace = New-Object System.Xml.XmlNamespaceManager($sharedStringsXml.NameTable)
    $sharedNamespace.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $sharedStrings = @($sharedStringsXml.SelectNodes('//x:si', $sharedNamespace) | ForEach-Object { [string]$_.InnerText })
  }

  $worksheetXml = ConvertFrom-SafeXml (Read-ZipEntryText -Archive $archive -EntryName $worksheetEntry)
  $worksheetNamespace = New-Object System.Xml.XmlNamespaceManager($worksheetXml.NameTable)
  $worksheetNamespace.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $rows = @($worksheetXml.SelectNodes('//x:sheetData/x:row', $worksheetNamespace))
  if ($rows.Count -lt 2) { throw 'Il foglio XLSX non contiene anagrafiche.' }

  $headersByColumn = @{}
  foreach ($cell in $rows[0].SelectNodes('x:c', $worksheetNamespace)) {
    $reference = [string]$cell.GetAttribute('r')
    $column = $reference -replace '[0-9]', ''
    $header = Clean-CellText (Get-CellText -Cell $cell -NamespaceManager $worksheetNamespace -SharedStrings $sharedStrings)
    if (-not [string]::IsNullOrWhiteSpace($header)) { $headersByColumn[$column] = $header }
  }

  $requiredHeaders = @('Denominazione', 'Indirizzo', 'Comune', 'CAP', 'Provincia', 'P.IVA/TAX ID')
  foreach ($requiredHeader in $requiredHeaders) {
    if (-not $headersByColumn.ContainsValue($requiredHeader)) {
      throw "Colonna XLSX obbligatoria mancante: $requiredHeader"
    }
  }

  $customers = New-Object System.Collections.Generic.List[object]
  $seenVatNumbers = @{}
  for ($rowIndex = 1; $rowIndex -lt $rows.Count; $rowIndex++) {
    $sourceRow = @{}
    foreach ($cell in $rows[$rowIndex].SelectNodes('x:c', $worksheetNamespace)) {
      $reference = [string]$cell.GetAttribute('r')
      $column = $reference -replace '[0-9]', ''
      if ($headersByColumn.ContainsKey($column)) {
        $sourceRow[$headersByColumn[$column]] = Clean-CellText (
          Get-CellText -Cell $cell -NamespaceManager $worksheetNamespace -SharedStrings $sharedStrings
        )
      }
    }

    $companyName = Get-FirstValue -Row $sourceRow -Names @('Denominazione')
    if ([string]::IsNullOrWhiteSpace($companyName)) {
      $hasAnyValue = @($sourceRow.Values | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0
      if ($hasAnyValue) { throw "Riga XLSX $($rowIndex + 1): denominazione mancante." }
      continue
    }

    $vatNumber = Get-FirstValue -Row $sourceRow -Names @('P.IVA/TAX ID')
    $vatKey = Normalize-VatNumber $vatNumber
    if ($vatKey.Length -lt 5) { throw "Riga XLSX $($rowIndex + 1): P.IVA/TAX ID mancante o non valida." }
    if ($seenVatNumbers.ContainsKey($vatKey)) {
      throw "Riga XLSX $($rowIndex + 1): P.IVA/TAX ID duplicata nel file."
    }
    $seenVatNumbers[$vatKey] = $true

    $email = Get-FirstValue -Row $sourceRow -Names @('Indirizzo e-mail', 'Email')
    if ($email -ne '' -and $email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
      throw "Riga XLSX $($rowIndex + 1): indirizzo email non valido."
    }
    $pec = Get-FirstValue -Row $sourceRow -Names @('Indirizzo PEC', 'PEC')
    if ($pec -ne '' -and $pec -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
      throw "Riga XLSX $($rowIndex + 1): indirizzo PEC non valido."
    }

    $country = Get-FirstValue -Row $sourceRow -Names @('Paese')
    if ($country -eq '') { $country = 'Italia' }
    $billingStreet = Get-FirstValue -Row $sourceRow -Names @('Indirizzo')
    $shippingStreet = Get-FirstValue -Row $sourceRow -Names @('Indirizzo spedizione')
    if ($shippingStreet -eq '') { $shippingStreet = $billingStreet }

    $customers.Add([pscustomobject][ordered]@{
      CompanyName = $companyName
      ContactName = Get-FirstValue -Row $sourceRow -Names @('Referente')
      BillingStreet = $billingStreet
      ShippingStreet = $shippingStreet
      PostalCode = Get-FirstValue -Row $sourceRow -Names @('CAP')
      City = Get-FirstValue -Row $sourceRow -Names @('Comune')
      Province = (Get-FirstValue -Row $sourceRow -Names @('Provincia')).ToUpperInvariant()
      Country = $country
      Email = $email.ToLowerInvariant()
      Phone = Get-FirstValue -Row $sourceRow -Names @('Telefono')
      VatNumber = $vatNumber
      FiscalCode = Get-FirstValue -Row $sourceRow -Names @('Codice Fiscale')
      Pec = $pec.ToLowerInvariant()
      SdiCode = Get-FirstValue -Row $sourceRow -Names @('Codice SDI')
    })
  }
} finally {
  $archive.Dispose()
}

if ($customers.Count -gt 500) {
  throw "Il file contiene $($customers.Count) clienti; il massimo supportato dalla RPC è 500."
}

$tsvHeaders = @(
  'ID Cliente', 'Ragione Sociale', 'Alias', 'Indirizzo', 'CAP', 'Comune',
  'Provincia', 'Paese', 'Indirizzo Consegna', 'Email', 'Telefono', 'P.IVA',
  'Codice Fiscale', 'PEC', 'SDI', 'Trasporto Default', 'Attivo'
)
$tsvLines = New-Object System.Collections.Generic.List[string]
$tsvLines.Add(($tsvHeaders -join "`t"))
foreach ($customer in $customers) {
  $values = @(
    '', $customer.CompanyName, $customer.ContactName, $customer.BillingStreet,
    $customer.PostalCode, $customer.City, $customer.Province, $customer.Country,
    $customer.ShippingStreet, $customer.Email, $customer.Phone, $customer.VatNumber,
    $customer.FiscalCode, $customer.Pec, $customer.SdiCode, 'SI', 'SI'
  ) | ForEach-Object { ConvertTo-TsvCell ([string]$_) }
  $tsvLines.Add(($values -join "`t"))
}

$checklistHeaders = @(
  'Ragione sociale', 'Partita IVA', 'Email', 'Stato dati',
  'Data contatto', 'Esito', 'Note'
)
$checklistLines = New-Object System.Collections.Generic.List[string]
$checklistLines.Add((@($checklistHeaders | ForEach-Object { ConvertTo-SafeCsvCell $_ }) -join ';'))
foreach ($customer in $customers) {
  $dataStatus = if ($customer.Email -eq '') { 'EMAIL MANCANTE' } else { 'PRONTO DA CONTATTARE' }
  $values = @(
    $customer.CompanyName, $customer.VatNumber, $customer.Email, $dataStatus,
    '', '', ''
  )
  $checklistLines.Add((@($values | ForEach-Object { ConvertTo-SafeCsvCell ([string]$_) }) -join ';'))
}

$emailTemplate = @'
Oggetto: richiesta attivazione accesso al portale ordini Pasta Igea

Buongiorno [REFERENTE / RAGIONE SOCIALE],

stiamo predisponendo l'accesso al portale ordini Pasta Igea.
Per richiederne l'attivazione, rispondete a questa email confermando:

- l'indirizzo email da associare all'account;
- il nome e cognome della persona autorizzata a utilizzare il portale.

Dopo la verifica riceverete separatamente l'invito tecnico per impostare la password.
Non inviate password o altre credenziali via email.

Cordiali saluti,
[FIRMA]
'@

$utf8ForLocalFiles = New-Object System.Text.UTF8Encoding($true)
$tsvPath = Join-Path $OutputDirectory 'clienti-import.tsv'
$checklistPath = Join-Path $OutputDirectory 'clienti-inviti.csv'
$templatePath = Join-Path $OutputDirectory 'modello-email-invito.txt'
[System.IO.File]::WriteAllLines($tsvPath, $tsvLines, $utf8ForLocalFiles)
[System.IO.File]::WriteAllLines($checklistPath, $checklistLines, $utf8ForLocalFiles)
[System.IO.File]::WriteAllText($templatePath, $emailTemplate.Trim() + [Environment]::NewLine, $utf8ForLocalFiles)

$emailCount = @($customers | Where-Object { $_.Email -ne '' }).Count
$missingAddressCount = @($customers | Where-Object { $_.BillingStreet -eq '' }).Count
Write-Output 'Preparazione clienti completata; nessuna email è stata inviata.'
Write-Output "Clienti: $($customers.Count)"
Write-Output "Email disponibili: $emailCount"
Write-Output "Email mancanti: $($customers.Count - $emailCount)"
Write-Output "Indirizzi da completare: $missingAddressCount"
Write-Output "File import: $([System.IO.Path]::GetFileName($tsvPath))"
Write-Output "Checklist inviti: $([System.IO.Path]::GetFileName($checklistPath))"
Write-Output "Modello email: $([System.IO.Path]::GetFileName($templatePath))"
