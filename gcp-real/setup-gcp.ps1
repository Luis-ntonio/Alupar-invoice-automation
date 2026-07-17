param(
  [Parameter(Mandatory = $true)] [string]$ProjectId,
  [string]$Region = "us-central1",
  [string]$DocumentAiLocation = "us",
  [Parameter(Mandatory = $true)] [string]$RawBucket,
  [Parameter(Mandatory = $true)] [string]$ExportsBucket,
  # Debe coincidir con el default de deploy-cloudrun.ps1: si difieren, el deploy
  # apunta a una service account que este script nunca creo.
  [string]$ServiceAccountName = "proyecto2-facturas-sa",
  # Dominios extra habilitados para el login (ej. el host de Cloud Run o un
  # dominio propio). El login por email/contrasena funciona desde cualquier
  # origen; esto solo importa si a futuro se agregan proveedores OAuth.
  [string[]]$AuthorizedDomains = @()
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

function Get-FirebaseHeaders {
  $accessToken = gcloud auth print-access-token
  if (-not $accessToken) {
    throw "No se pudo obtener access token con gcloud auth print-access-token."
  }
  return @{
    Authorization         = "Bearer $accessToken"
    "x-goog-user-project" = $ProjectId
  }
}

function Wait-FirebaseOperation {
  param(
    [Parameter(Mandatory = $true)] [string]$OperationName,
    [Parameter(Mandatory = $true)] [hashtable]$Headers,
    [int]$MaxAttempts = 20,
    [int]$SleepSeconds = 4
  )

  for ($i = 1; $i -le $MaxAttempts; $i++) {
    $op = Invoke-RestMethod -Method GET -Uri "https://firebase.googleapis.com/v1beta1/$OperationName" -Headers $Headers
    if ($op.done) {
      if ($op.error) {
        throw "La operacion $OperationName fallo: $($op.error.message)"
      }
      return $op.response
    }
    Write-Host "Esperando operacion de Firebase ($i/$MaxAttempts)..."
    Start-Sleep -Seconds $SleepSeconds
  }

  throw "La operacion $OperationName no termino tras $MaxAttempts intentos."
}

function Initialize-FirebaseAuth {
  param([string[]]$ExtraAuthorizedDomains = @())

  # Reemplaza a setup-entra-auth.ps1 del lado Azure. Alli habia que registrar dos
  # app registrations, configurar la version del token, definir app roles y dar
  # consent a mano en el portal. Aca alcanza con: registrar Firebase, crear una
  # web app (de donde sale el apiKey) y prender el proveedor email/password.
  #
  # Todo por REST con el token de gcloud, igual que New-DocumentAiProcessor: no
  # hace falta la CLI de Firebase ni una service account key.
  $headers = Get-FirebaseHeaders

  # 1) Registrar Firebase en el proyecto GCP (idempotente: si ya estaba, la API
  #    devuelve ALREADY_EXISTS y se sigue de largo).
  try {
    $op = Invoke-RestMethod -Method POST -Uri "https://firebase.googleapis.com/v1beta1/projects/$ProjectId`:addFirebase" `
      -Headers $headers -ContentType "application/json" -Body "{}"
    if ($op.name) {
      Wait-FirebaseOperation -OperationName $op.name -Headers $headers | Out-Null
    }
    Write-Host "Firebase registrado en el proyecto."
  } catch {
    $detail = ""
    try { $detail = $_.ErrorDetails.Message } catch {}
    if ($detail -match "ALREADY_EXISTS" -or $detail -match "already") {
      Write-Host "El proyecto ya estaba registrado en Firebase. Se reutiliza."
    } else {
      throw "No se pudo registrar Firebase en el proyecto. Detalle: $detail $($_.Exception.Message)"
    }
  }

  # 2) Web app: su apiKey es lo que consume el frontend via /api/auth/config.
  $webApp = $null
  try {
    $apps = Invoke-RestMethod -Method GET -Uri "https://firebase.googleapis.com/v1beta1/projects/$ProjectId/webApps" -Headers $headers
    if ($apps.apps) {
      $webApp = $apps.apps | Select-Object -First 1
      Write-Host "Ya existia una web app ('$($webApp.displayName)'). Se reutiliza."
    }
  } catch {
    $webApp = $null
  }

  if (-not $webApp) {
    Write-Host "Creando web app 'proyecto2-facturas-web'..."
    $body = @{ displayName = "proyecto2-facturas-web" } | ConvertTo-Json
    $op = Invoke-RestMethod -Method POST -Uri "https://firebase.googleapis.com/v1beta1/projects/$ProjectId/webApps" `
      -Headers $headers -ContentType "application/json" -Body $body
    $webApp = Wait-FirebaseOperation -OperationName $op.name -Headers $headers
  }

  $sdkConfig = Invoke-RestMethod -Method GET `
    -Uri "https://firebase.googleapis.com/v1beta1/projects/$ProjectId/webApps/$($webApp.appId)/config" -Headers $headers

  # 3) Inicializar Identity Platform (no-op si ya lo estaba).
  try {
    Invoke-RestMethod -Method POST -Uri "https://identitytoolkit.googleapis.com/v2/projects/$ProjectId/identityPlatform:initializeAuth" `
      -Headers $headers -ContentType "application/json" -Body "{}" | Out-Null
  } catch {
    Write-Host "Identity Platform ya estaba inicializado."
  }

  # 4) Prender email/password y fijar los dominios habilitados.
  $domains = @("localhost", "$ProjectId.firebaseapp.com", "$ProjectId.web.app") + $ExtraAuthorizedDomains
  $domains = $domains | Where-Object { $_ } | Select-Object -Unique
  $configBody = @{
    signIn            = @{ email = @{ enabled = $true; passwordRequired = $true } }
    authorizedDomains = @($domains)
  } | ConvertTo-Json -Depth 5

  $mask = "signIn.email.enabled,signIn.email.passwordRequired,authorizedDomains"
  try {
    Invoke-RestMethod -Method PATCH -Uri "https://identitytoolkit.googleapis.com/admin/v2/projects/$ProjectId/config?updateMask=$mask" `
      -Headers $headers -ContentType "application/json" -Body $configBody | Out-Null
  } catch {
    $detail = ""
    try { $detail = $_.ErrorDetails.Message } catch {}
    throw "No se pudo habilitar el proveedor email/password. Detalle: $detail $($_.Exception.Message)"
  }

  return @{
    ApiKey     = $sdkConfig.apiKey
    AuthDomain = $sdkConfig.authDomain
  }
}

Write-Host "[1/9] Configurando proyecto..."
gcloud config set project $ProjectId | Out-Null

Write-Host "[2/9] Habilitando APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com storage.googleapis.com documentai.googleapis.com iamcredentials.googleapis.com identitytoolkit.googleapis.com firebase.googleapis.com

Write-Host "[3/9] Creando buckets si no existen..."
$rawExists = (gcloud storage ls "gs://$RawBucket" 2>$null)
if ($LASTEXITCODE -ne 0) {
  gcloud storage buckets create "gs://$RawBucket" --location $Region --uniform-bucket-level-access
}
$exportsExists = (gcloud storage ls "gs://$ExportsBucket" 2>$null)
if ($LASTEXITCODE -ne 0) {
  gcloud storage buckets create "gs://$ExportsBucket" --location $Region --uniform-bucket-level-access
}

Write-Host "[4/9] Creando service account si no existe..."
$saExists = (gcloud iam service-accounts list --project $ProjectId --filter "email:$ServiceAccountEmail" --format "value(email)")
if (-not $saExists) {
  gcloud iam service-accounts create $ServiceAccountName --display-name "Proyecto2 Facturas Cloud Run SA"
}
Wait-ServiceAccountReady -Email $ServiceAccountEmail

Write-Host "[5/9] Asignando roles IAM a service account..."
Add-ProjectBindingWithRetry -Role "roles/storage.objectAdmin"
Add-ProjectBindingWithRetry -Role "roles/datastore.user"
Add-ProjectBindingWithRetry -Role "roles/documentai.apiUser"

Write-Host "[6/9] Inicializando Firestore (si no existe)..."
& gcloud firestore databases create --location=$Region --type=firestore-native | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Firestore ya estaba inicializado o no se pudo crear automaticamente."
}

Write-Host "[7/9] Creando procesador Document AI (Invoice Processor)..."
$processor = New-DocumentAiProcessor -DisplayName "proyecto2-invoices" -Location $DocumentAiLocation -ProcessorType "INVOICE_PROCESSOR"
$processorName = $processor.name
$processorId = $processorName.Split("/")[-1]

Write-Host "[8/9] Configurando Firebase Authentication (email/contrasena)..."
$firebase = Initialize-FirebaseAuth -ExtraAuthorizedDomains $AuthorizedDomains

Write-Host "[9/9] Listo"
Write-Host "Service Account: $ServiceAccountEmail"
Write-Host "Raw Bucket: gs://$RawBucket"
Write-Host "Exports Bucket: gs://$ExportsBucket"
Write-Host "Document AI Location: $DocumentAiLocation"
Write-Host "Document AI Processor ID: $processorId"
Write-Host "Firebase API Key: $($firebase.ApiKey)"
Write-Host "Firebase Auth Domain: $($firebase.AuthDomain)"
Write-Host ""
Write-Host "Pasos siguientes:"
Write-Host "  1) Crear al menos un usuario:"
Write-Host "     .\add-user.ps1 -ProjectId $ProjectId -Email alguien@empresa.com"
Write-Host "  2) Desplegar pasando FIREBASE_API_KEY:"
Write-Host "     .\deploy-cloudrun.ps1 -ProjectId $ProjectId ... -FirebaseApiKey $($firebase.ApiKey)"
Write-Host ""
Write-Host "Sin FIREBASE_API_KEY el servicio NO levanta en produccion (falla cerrado a proposito)."
