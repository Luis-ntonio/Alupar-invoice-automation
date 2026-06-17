param(
  [Parameter(Mandatory = $true)] [string]$ApiAppName,
  [Parameter(Mandatory = $true)] [string]$FrontendAppName,
  [Parameter(Mandatory = $true)] [string]$FrontendRedirectUri,
  [string]$TenantId,
  [string]$ApiIdentifierUri
)

$ErrorActionPreference = "Stop"

if ($TenantId) {
  az login --tenant $TenantId
  if ($LASTEXITCODE -ne 0) { throw "az login fallo para el tenant '$TenantId'." }
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

Write-Host "[2/6] Configurando scope OAuth2 y app roles en API..."
$scopeBody = '{"api":{"oauth2PermissionScopes":[{"id":"55555555-5555-5555-5555-555555555555","adminConsentDescription":"Permite al frontend llamar la API en nombre del usuario","adminConsentDisplayName":"Llamar la API de facturas","isEnabled":true,"type":"User","userConsentDescription":"Permite acceder al panel de facturas","userConsentDisplayName":"Acceder al panel","value":"access_as_user"}]}}'
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$apiObjectId" --body $scopeBody --headers "Content-Type=application/json" | Out-Null

Write-Host "[2b/6] Configurando app roles en API..."
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
az ad app update --id $frontendObjectId --enable-id-token-issuance true --enable-access-token-issuance true | Out-Null
$spaBody = "{`"spa`":{`"redirectUris`":[`"$FrontendRedirectUri`"]}}"
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$frontendObjectId" --body $spaBody --headers "Content-Type=application/json" | Out-Null

Write-Host "[3b/6] Configurando permisos del frontend para llamar a la API..."
$reqBody = "{`"requiredResourceAccess`":[{`"resourceAppId`":`"$apiAppId`",`"resourceAccess`":[{`"id`":`"55555555-5555-5555-5555-555555555555`",`"type`":`"Scope`"}]}]}"
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$frontendObjectId" --body $reqBody --headers "Content-Type=application/json" | Out-Null

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
$tenantId = az account show --query "tenantId" -o tsv
Write-Host "API AppId (AZURE_AD_CLIENT_ID)              : $apiAppId"
Write-Host "API Identifier URI                          : $ApiIdentifierUri"
Write-Host "Frontend AppId (AZURE_AD_FRONTEND_CLIENT_ID): $frontendAppId"
Write-Host "Frontend Redirect URI                       : $FrontendRedirectUri"
Write-Host "Tenant ID (AZURE_AD_TENANT_ID)              : $tenantId"
Write-Host "Scope para MSAL                             : api://$apiAppId/access_as_user"
Write-Host ""
Write-Host "Siguiente paso: re-ejecutar deploy-containerapps.ps1 con los nuevos parametros:"
Write-Host "  -AzureAdTenantId `"$tenantId`""
Write-Host "  -AzureAdClientId `"$apiAppId`""
Write-Host "  -AzureAdFrontendClientId `"$frontendAppId`""
Write-Host ""
Write-Host "Nota: se requiere admin consent en Azure Portal para que los usuarios puedan consentir el scope."
Write-Host "Ir a: Azure AD > App Registrations > $FrontendAppName > API Permissions > Grant admin consent"
