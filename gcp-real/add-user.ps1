param(
  [Parameter(Mandatory = $true)] [string]$ProjectId,
  [Parameter(Mandatory = $true)] [string]$Email,
  [string]$Password,
  [switch]$ResetPassword
)

$ErrorActionPreference = "Stop"

# Crea (o actualiza) un usuario de Firebase Authentication con email/contrasena.
#
# Equivalente al azure-real/add-user.ps1, pero mucho mas simple: en Azure habia
# que invitar guests de Entra, mantener una allow-list ALLOWED_EMAILS y asignar
# app roles. Aca no: estar en Firebase ES la autorizacion (el backend solo valida
# el ID token en middleware/auth.ts) y el backend nunca uso roles.
#
# Usa la REST admin de Identity Toolkit con el token de gcloud, igual que
# setup-gcp.ps1 hace con Document AI: sin dependencias extra (no requiere la CLI
# de Firebase ni una service account key).
#
# Ejemplos:
#   .\add-user.ps1 -ProjectId invoice-automation-497420 -Email alguien@empresa.com
#   .\add-user.ps1 -ProjectId invoice-automation-497420 -Email alguien@empresa.com -Password "..." -ResetPassword

function New-RandomPassword {
  param([int]$Length = 20)

  # Charset sin caracteres ambiguos (0/O, 1/l/I) para que se pueda dictar o
  # copiar a mano sin errores.
  $chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789#%+=?@".ToCharArray()
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }

  $sb = New-Object System.Text.StringBuilder
  foreach ($b in $bytes) {
    [void]$sb.Append($chars[$b % $chars.Length])
  }
  return $sb.ToString()
}

function Get-AuthHeaders {
  $accessToken = gcloud auth print-access-token
  if (-not $accessToken) {
    throw "No se pudo obtener access token con gcloud auth print-access-token."
  }
  return @{
    Authorization        = "Bearer $accessToken"
    "x-goog-user-project" = $ProjectId
  }
}

function Get-ErrorDetail {
  param($ErrorRecord)
  try { return $ErrorRecord.ErrorDetails.Message } catch { return $ErrorRecord.Exception.Message }
}

$generated = $false
if (-not $Password) {
  $Password = New-RandomPassword
  $generated = $true
}

if ($Password.Length -lt 6) {
  throw "Firebase exige contrasenas de al menos 6 caracteres."
}

$headers = Get-AuthHeaders
$baseUri = "https://identitytoolkit.googleapis.com/v1/projects/$ProjectId"

Write-Host "[1/3] Buscando usuario existente ($Email)..."
$existingId = $null
try {
  $lookup = Invoke-RestMethod -Method POST -Uri "$baseUri/accounts:lookup" -Headers $headers `
    -ContentType "application/json" -Body (@{ email = @($Email) } | ConvertTo-Json)
  if ($lookup.users) {
    $existingId = $lookup.users[0].localId
  }
} catch {
  # accounts:lookup responde error cuando el proyecto aun no tiene usuarios;
  # se trata como "no existe" y se sigue.
  $existingId = $null
}

if ($existingId -and -not $ResetPassword) {
  Write-Host ""
  Write-Host "El usuario $Email YA EXISTE (uid: $existingId). No se toco su contrasena."
  Write-Host "Para cambiarsela, volve a correr con -ResetPassword."
  return
}

if ($existingId) {
  Write-Host "[2/3] Usuario existente. Actualizando contrasena..."
  $body = @{ localId = $existingId; password = $Password } | ConvertTo-Json
  try {
    Invoke-RestMethod -Method POST -Uri "$baseUri/accounts:update" -Headers $headers `
      -ContentType "application/json" -Body $body | Out-Null
  } catch {
    throw "No se pudo actualizar la contrasena de $Email. Detalle: $(Get-ErrorDetail $_)"
  }
  $uid = $existingId
} else {
  Write-Host "[2/3] Creando usuario..."
  # emailVerified=true: el alta la hace un admin a mano, no hay flujo de
  # verificacion por correo en la app.
  $body = @{ email = $Email; password = $Password; emailVerified = $true } | ConvertTo-Json
  try {
    $created = Invoke-RestMethod -Method POST -Uri "$baseUri/accounts" -Headers $headers `
      -ContentType "application/json" -Body $body
    $uid = $created.localId
  } catch {
    throw "No se pudo crear el usuario $Email. Detalle: $(Get-ErrorDetail $_)"
  }
}

Write-Host "[3/3] Listo"
Write-Host ""
Write-Host "Usuario : $Email"
Write-Host "uid     : $uid"
if ($generated) {
  Write-Host "Password: $Password"
  Write-Host ""
  Write-Host "Contrasena generada al azar. Guardala ahora: no vuelve a mostrarse"
  Write-Host "y Firebase almacena solo el hash."
}
Write-Host ""
Write-Host "Ya puede iniciar sesion en el dashboard con ese email y contrasena."
