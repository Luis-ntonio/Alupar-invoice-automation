param(
  [Parameter(Mandatory = $true)] [string]$ApiAppName,
  [Parameter(Mandatory = $true)] [string]$FrontendAppName,
  [Parameter(Mandatory = $true)] [string]$FrontendRedirectUri,
  [string]$TenantId,
  [string]$ApiIdentifierUri
)

$ErrorActionPreference = "Stop"

if ($TenantId) {
  az login --tenant $TenantId | Out-Null
}

Write-Host "[1/6] Creando o reutilizando App Registration para API..."
$apiAppId = az ad app list --display-name $ApiAppName --query "[0].appId" -o tsv
if (-not $apiAppId) {
  $apiAppId = az ad app create --display-name $ApiAppName --sign-in-audience AzureADMyOrg --query "appId" -o tsv
}
$apiObjectId = az ad app show --id $apiAppId --query "id" -o tsv

if (-not $ApiIdentifierUri) {
  $ApiIdentifierUri = "api://$apiAppId"
}
az ad app update --id $apiObjectId --identifier-uris $ApiIdentifierUri | Out-Null

Write-Host "[2/6] Configurando app roles en API..."
$appRolesPath = Join-Path $env:TEMP "api-app-roles.json"
$appRolesJson = @"
[
  {
    "allowedMemberTypes": ["User"],
    "description": "Acceso total al panel y administracion",
    "displayName": "Admin",
    "id": "11111111-1111-1111-1111-111111111111",
    "isEnabled": true,
    "value": "Admin"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Carga, edicion y derivacion",
    "displayName": "Operaciones",
    "id": "22222222-2222-2222-2222-222222222222",
    "isEnabled": true,
    "value": "Operaciones"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Revision y validacion",
    "displayName": "Revision",
    "id": "33333333-3333-3333-3333-333333333333",
    "isEnabled": true,
    "value": "Revision"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Solo lectura",
    "displayName": "SoloLectura",
    "id": "44444444-4444-4444-4444-444444444444",
    "isEnabled": true,
    "value": "SoloLectura"
  }
]
"@
$appRolesJson | Set-Content -Path $appRolesPath -Encoding utf8
az ad app update --id $apiObjectId --app-roles @$appRolesPath | Out-Null

Write-Host "[3/6] Creando o reutilizando App Registration para Frontend..."
$frontendAppId = az ad app list --display-name $FrontendAppName --query "[0].appId" -o tsv
if (-not $frontendAppId) {
  $frontendAppId = az ad app create --display-name $FrontendAppName --sign-in-audience AzureADMyOrg --query "appId" -o tsv
}
$frontendObjectId = az ad app show --id $frontendAppId --query "id" -o tsv
az ad app update --id $frontendObjectId --web-redirect-uris $FrontendRedirectUri --enable-id-token-issuance true --enable-access-token-issuance true | Out-Null

Write-Host "[4/6] Creando Service Principals si no existen..."
$apiSp = az ad sp list --filter "appId eq '$apiAppId'" --query "[0].id" -o tsv
if (-not $apiSp) {
  az ad sp create --id $apiAppId | Out-Null
}
$frontendSp = az ad sp list --filter "appId eq '$frontendAppId'" --query "[0].id" -o tsv
if (-not $frontendSp) {
  az ad sp create --id $frontendAppId | Out-Null
}

Write-Host "[5/6] Validando objetos creados"
if (-not $apiSp) {
  $apiSp = az ad sp list --filter "appId eq '$apiAppId'" --query "[0].id" -o tsv
}

Write-Host "[6/6] Salida"
Write-Host "API AppId              : $apiAppId"
Write-Host "API Identifier URI     : $ApiIdentifierUri"
Write-Host "Frontend AppId         : $frontendAppId"
Write-Host "Frontend Redirect URI  : $FrontendRedirectUri"
Write-Host ""
Write-Host "Siguiente paso: usar assign-entra-role-by-email.ps1 para asignar roles por correo."
Write-Host "Nota: se requiere admin consent para permisos de Graph al asignar roles."
