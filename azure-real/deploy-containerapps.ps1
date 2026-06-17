param(
  [Parameter(Mandatory = $true)] [string]$SubscriptionId,
  [Parameter(Mandatory = $true)] [string]$ResourceGroup,
  [Parameter(Mandatory = $true)] [string]$Prefix,
  [string]$Location = "eastus",
  [string]$ContainerAppName = "proyecto2-facturas",
  [string]$ImageTag = "latest",
  [Parameter(Mandatory = $true)] [string]$WorkatoSharedSecret,
  [switch]$EnableWorkatoRemoteUrls,
  [string]$AzureAdTenantId = "",
  [string]$AzureAdClientId = "",
  [string]$AzureAdFrontendClientId = "",
  [string]$AllowedDomains = "",
  [string]$AllowedEmails = ""
)

$ErrorActionPreference = "Stop"

function Invoke-AzProbe {
  param([scriptblock]$Cmd)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $result = & $Cmd 2>$null
  $ErrorActionPreference = $prev
  if ($LASTEXITCODE -ne 0) { return $null }
  return $result
}

function Normalize-Name {
  param([Parameter(Mandatory = $true)] [string]$Value)
  return ($Value.ToLower() -replace "[^a-z0-9]", "")
}

$base = Normalize-Name -Value $Prefix
$acrName = ("{0}acr" -f $base)
if ($acrName.Length -gt 50) { $acrName = $acrName.Substring(0, 50) }
$storageName = ("{0}st" -f $base)
if ($storageName.Length -gt 24) { $storageName = $storageName.Substring(0, 24) }
$acaEnvName = "$Prefix-aca-env"

$cosmosName = ("{0}cosmos" -f $base)
if ($cosmosName.Length -gt 44) { $cosmosName = $cosmosName.Substring(0, 44) }

$storageContainerRaw = "raw"
$storageContainerExports = "exports"

Write-Host "[1/8] Seleccionando suscripcion..."
az account set --subscription $SubscriptionId
if ($LASTEXITCODE -ne 0) { throw "No se pudo seleccionar la suscripcion '$SubscriptionId'. Verifica con: az account list" }

Write-Host "[2/8] Validando recursos base..."
$acrLoginServer = az acr show --name $acrName --resource-group $ResourceGroup --query "loginServer" -o tsv
if (-not $acrLoginServer) { throw "No se encontro ACR '$acrName'. Ejecuta setup-azure.ps1 primero." }

$envId = az containerapp env show --name $acaEnvName --resource-group $ResourceGroup --query "id" -o tsv
if (-not $envId) { throw "No se encontro Container Apps Environment '$acaEnvName'. Ejecuta setup-azure.ps1 primero." }

$storageKey = az storage account keys list --account-name $storageName --resource-group $ResourceGroup --query "[0].value" -o tsv
if (-not $storageKey) { throw "No se encontro Storage Account '$storageName'. Ejecuta setup-azure.ps1 primero." }

$cosmosEndpoint = Invoke-AzProbe { az cosmosdb show --name $cosmosName --resource-group $ResourceGroup --query "documentEndpoint" -o tsv }
if (-not $cosmosEndpoint) { throw "No se encontro Cosmos DB '$cosmosName'. Re-ejecuta setup-azure.ps1 con -CreateCosmos." }

$cosmosKey = az cosmosdb keys list --name $cosmosName --resource-group $ResourceGroup --query "primaryMasterKey" -o tsv
if (-not $cosmosKey) { throw "No se pudo obtener la key de Cosmos DB '$cosmosName'." }

$storageConnectionString = "DefaultEndpointsProtocol=https;AccountName=$storageName;AccountKey=$storageKey;EndpointSuffix=core.windows.net"

Write-Host "[2.1/8] Creando contenedores blob requeridos..."
az storage container create --name $storageContainerRaw --account-name $storageName --account-key $storageKey --auth-mode key | Out-Null
az storage container create --name $storageContainerExports --account-name $storageName --account-key $storageKey --auth-mode key | Out-Null

Write-Host "[3/8] Build local de imagen y push a ACR..."
$imageName = "$ContainerAppName`:$ImageTag"
$imageRef = "$acrLoginServer/$imageName"

$acrUser = az acr credential show --name $acrName --query "username" -o tsv
$acrPass = az acr credential show --name $acrName --query "passwords[0].value" -o tsv

$acrPass | docker login $acrLoginServer --username $acrUser --password-stdin
if ($LASTEXITCODE -ne 0) { throw "docker login en ACR fallo." }

docker build -t $imageRef .
if ($LASTEXITCODE -ne 0) { throw "docker build fallo." }

docker push $imageRef
if ($LASTEXITCODE -ne 0) { throw "docker push fallo." }

Write-Host "[4/8] Obteniendo credenciales ACR para Container App..."

Write-Host "[5/8] Preparando variables de runtime Azure..."

Write-Host "[6/8] Generando manifiesto temporal de Container App..."
$enableRemote = if ($EnableWorkatoRemoteUrls) { "true" } else { "false" }
$ts = (Get-Date -Format "yyyyMMddHHmmss")
$revisionTag = ("rev-" + (($ImageTag.ToLower() -replace "[^a-z0-9-]", "-").Trim("-")) + "-$ts")
if ([string]::IsNullOrWhiteSpace($revisionTag)) { $revisionTag = "rev-1" }
$yamlPath = Join-Path $env:TEMP "$ContainerAppName-aca.yaml"

$yaml = @"
location: $Location
name: $ContainerAppName
resourceGroup: $ResourceGroup
type: Microsoft.App/containerApps
properties:
  managedEnvironmentId: $envId
  configuration:
    ingress:
      external: true
      targetPort: 8080
      transport: auto
      allowInsecure: false
    secrets:
      - name: acr-pwd
        value: $acrPass
      - name: workato-secret
        value: $WorkatoSharedSecret
      - name: storage-connection
        value: $storageConnectionString
      - name: cosmos-key
        value: $cosmosKey
    registries:
      - server: $acrLoginServer
        username: $acrUser
        passwordSecretRef: acr-pwd
  template:
    revisionSuffix: $revisionTag
    containers:
      - name: app
        image: $imageRef
        resources:
          cpu: 0.5
          memory: 1Gi
        env:
          - name: NODE_ENV
            value: production
          - name: PORT
            value: "8080"
          - name: STORAGE_MODE
            value: azure
          - name: DB_MODE
            value: cosmos
          - name: AZURE_STORAGE_CONNECTION_STRING
            secretRef: storage-connection
          - name: AZURE_STORAGE_CONTAINER_RAW
            value: $storageContainerRaw
          - name: AZURE_STORAGE_CONTAINER_EXPORTS
            value: $storageContainerExports
          - name: AZURE_COSMOS_ENDPOINT
            value: $cosmosEndpoint
          - name: AZURE_COSMOS_KEY
            secretRef: cosmos-key
          - name: AZURE_COSMOS_DATABASE
            value: facturasdb
          - name: AZURE_COSMOS_CONTAINER
            value: documents
          - name: WORKATO_SHARED_SECRET
            secretRef: workato-secret
          - name: ENABLE_WORKATO_REMOTE_URLS
            value: "$enableRemote"
          - name: AZURE_AD_TENANT_ID
            value: $AzureAdTenantId
          - name: AZURE_AD_CLIENT_ID
            value: $AzureAdClientId
          - name: AZURE_AD_FRONTEND_CLIENT_ID
            value: $AzureAdFrontendClientId
          - name: ALLOWED_DOMAINS
            value: $AllowedDomains
          - name: ALLOWED_EMAILS
            value: $AllowedEmails
    scale:
      minReplicas: 1
      maxReplicas: 1
"@

$yaml | Set-Content -Path $yamlPath -Encoding utf8

Write-Host "[7/8] Deploy de Container App..."
$exists = Invoke-AzProbe { az containerapp show --name $ContainerAppName --resource-group $ResourceGroup --query "name" -o tsv }
if ($exists) {
  az containerapp update --name $ContainerAppName --resource-group $ResourceGroup --yaml $yamlPath | Out-Null
} else {
  az containerapp create --name $ContainerAppName --resource-group $ResourceGroup --yaml $yamlPath | Out-Null
}

Write-Host "[8/8] URL publica..."
$fqdn = az containerapp show --name $ContainerAppName --resource-group $ResourceGroup --query "properties.configuration.ingress.fqdn" -o tsv
Write-Host "https://$fqdn"
Write-Host "Health: https://$fqdn/api/health"
