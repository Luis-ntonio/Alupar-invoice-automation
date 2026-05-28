param(
  [Parameter(Mandatory = $true)] [string]$ProjectId,
  [string]$Region = "us-central1",
  [string]$DocumentAiLocation = "us",
  [Parameter(Mandatory = $true)] [string]$RawBucket,
  [Parameter(Mandatory = $true)] [string]$ExportsBucket,
  [string]$ServiceAccountName = "facturas-sa"
)

$ErrorActionPreference = "Stop"

$ServiceAccountEmail = "$ServiceAccountName@$ProjectId.iam.gserviceaccount.com"

function Wait-ServiceAccountReady {
  param(
    [Parameter(Mandatory = $true)] [string]$Email,
    [int]$MaxAttempts = 12,
    [int]$SleepSeconds = 5
  )

  for ($i = 1; $i -le $MaxAttempts; $i++) {
    $exists = gcloud iam service-accounts list --project $ProjectId --filter "email:$Email" --format "value(email)"
    if ($exists) {
      return
    }
    Write-Host "Esperando propagacion de service account ($i/$MaxAttempts)..."
    Start-Sleep -Seconds $SleepSeconds
  }

  throw "La service account $Email no aparece tras esperar propagacion IAM."
}

function Add-ProjectBindingWithRetry {
  param(
    [Parameter(Mandatory = $true)] [string]$Role,
    [int]$MaxAttempts = 8,
    [int]$SleepSeconds = 4
  )

  for ($i = 1; $i -le $MaxAttempts; $i++) {
    & gcloud projects add-iam-policy-binding $ProjectId --member "serviceAccount:$ServiceAccountEmail" --role $Role | Out-Null
    if ($LASTEXITCODE -eq 0) {
      return
    }

    Write-Host "No se pudo asignar $Role en intento $i/$MaxAttempts. Reintentando..."
    Start-Sleep -Seconds $SleepSeconds
  }

  throw "No se pudo asignar el rol $Role a $ServiceAccountEmail tras varios intentos."
}

function New-DocumentAiProcessor {
  param(
    [Parameter(Mandatory = $true)] [string]$DisplayName,
    [Parameter(Mandatory = $true)] [string]$Location,
    [Parameter(Mandatory = $true)] [string]$ProcessorType
  )

  $accessToken = gcloud auth print-access-token
  if (-not $accessToken) {
    throw "No se pudo obtener access token con gcloud auth print-access-token."
  }

  $parent = "projects/$ProjectId/locations/$Location"
  $existingUri = "https://documentai.googleapis.com/v1/$parent/processors"
  try {
    $existing = Invoke-RestMethod -Method GET -Uri $existingUri -Headers @{ Authorization = "Bearer $accessToken" }
  } catch {
    throw "No se pudo consultar processors de Document AI en location '$Location'. Usa una location valida (normalmente 'us' o 'eu'). Error: $($_.Exception.Message)"
  }

  $match = $existing.processors | Where-Object { $_.displayName -eq $DisplayName } | Select-Object -First 1
  if ($match) {
    Write-Host "Ya existia un processor con displayName '$DisplayName'. Se reutiliza."
    return $match
  }

  $uri = "https://documentai.googleapis.com/v1/$parent/processors"
  $body = @{ displayName = $DisplayName; type = $ProcessorType } | ConvertTo-Json
  try {
    return Invoke-RestMethod -Method POST -Uri $uri -Headers @{ Authorization = "Bearer $accessToken" } -ContentType "application/json" -Body $body
  } catch {
    $detail = ""
    try { $detail = $_.ErrorDetails.Message } catch {}
    throw "No se pudo crear processor en Document AI location '$Location'. Error HTTP: $($_.Exception.Message). Detalle: $detail"
  }
}

Write-Host "[1/8] Configurando proyecto..."
gcloud config set project $ProjectId | Out-Null

Write-Host "[2/8] Habilitando APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com storage.googleapis.com documentai.googleapis.com iamcredentials.googleapis.com

Write-Host "[3/8] Creando buckets si no existen..."
$rawExists = (gcloud storage ls "gs://$RawBucket" 2>$null)
if ($LASTEXITCODE -ne 0) {
  gcloud storage buckets create "gs://$RawBucket" --location $Region --uniform-bucket-level-access
}
$exportsExists = (gcloud storage ls "gs://$ExportsBucket" 2>$null)
if ($LASTEXITCODE -ne 0) {
  gcloud storage buckets create "gs://$ExportsBucket" --location $Region --uniform-bucket-level-access
}

Write-Host "[4/8] Creando service account si no existe..."
$saExists = (gcloud iam service-accounts list --project $ProjectId --filter "email:$ServiceAccountEmail" --format "value(email)")
if (-not $saExists) {
  gcloud iam service-accounts create $ServiceAccountName --display-name "Proyecto2 Facturas Cloud Run SA"
}
Wait-ServiceAccountReady -Email $ServiceAccountEmail

Write-Host "[5/8] Asignando roles IAM a service account..."
Add-ProjectBindingWithRetry -Role "roles/storage.objectAdmin"
Add-ProjectBindingWithRetry -Role "roles/datastore.user"
Add-ProjectBindingWithRetry -Role "roles/documentai.apiUser"

Write-Host "[6/8] Inicializando Firestore (si no existe)..."
& gcloud firestore databases create --location=$Region --type=firestore-native | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Firestore ya estaba inicializado o no se pudo crear automaticamente."
}

Write-Host "[7/8] Creando procesador Document AI (Invoice Processor)..."
$processor = New-DocumentAiProcessor -DisplayName "proyecto2-invoices" -Location $DocumentAiLocation -ProcessorType "INVOICE_PROCESSOR"
$processorName = $processor.name
$processorId = $processorName.Split("/")[-1]

Write-Host "[8/8] Listo"
Write-Host "Service Account: $ServiceAccountEmail"
Write-Host "Raw Bucket: gs://$RawBucket"
Write-Host "Exports Bucket: gs://$ExportsBucket"
Write-Host "Document AI Location: $DocumentAiLocation"
Write-Host "Document AI Processor ID: $processorId"
