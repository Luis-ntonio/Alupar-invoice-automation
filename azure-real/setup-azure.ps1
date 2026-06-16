param(
  [Parameter(Mandatory = $true)] [string]$SubscriptionId,
  [Parameter(Mandatory = $true)] [string]$ResourceGroup,
  [string]$Location = "eastus",
  [Parameter(Mandatory = $true)] [string]$Prefix,
  [switch]$CreateCosmos,
  [switch]$EnableCosmosFreeTier
)

$ErrorActionPreference = "Stop"

function Normalize-Name {
  param([Parameter(Mandatory = $true)] [string]$Value)
  return ($Value.ToLower() -replace "[^a-z0-9]", "")
}

$base = Normalize-Name -Value $Prefix
if ([string]::IsNullOrWhiteSpace($base)) {
  throw "Prefix invalido. Usa solo letras y numeros."
}

# Deterministic names so deploy script can derive them from Prefix.
$acrName = ("{0}acr" -f $base)
if ($acrName.Length -gt 50) { $acrName = $acrName.Substring(0, 50) }
if ($acrName.Length -lt 5) { throw "El nombre de ACR quedo muy corto. Usa un Prefix mas largo." }

$storageName = ("{0}st" -f $base)
if ($storageName.Length -gt 24) { $storageName = $storageName.Substring(0, 24) }
if ($storageName.Length -lt 3) { throw "El nombre de Storage quedo muy corto. Usa un Prefix mas largo." }

$acaEnvName = "$Prefix-aca-env"
$lawName = "$Prefix-law"
$keyVaultName = ("{0}kv" -f $base)
if ($keyVaultName.Length -gt 24) { $keyVaultName = $keyVaultName.Substring(0, 24) }

$cosmosName = ("{0}cosmos" -f $base)
if ($cosmosName.Length -gt 44) { $cosmosName = $cosmosName.Substring(0, 44) }

$storageShareRaw = "storage"
$storageShareData = "data"

Write-Host "[1/9] Seleccionando suscripcion..."
az account show
az account set --subscription $SubscriptionId | Out-Null

Write-Host "[2/9] Validando disponibilidad de nombres globales..."
$acrAvailable = az acr check-name --name $acrName --query "nameAvailable" -o tsv
if ($acrAvailable -ne "true") {
  $acrExists = az acr show --name $acrName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
  if (-not $acrExists) {
    throw "ACR '$acrName' no disponible globalmente. Cambia Prefix."
  }
}

$storageAvailable = az storage account check-name --name $storageName --query "nameAvailable" -o tsv
if ($storageAvailable -ne "true") {
  $storageExists = az storage account show --name $storageName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
  if (-not $storageExists) {
    throw "Storage account '$storageName' no disponible globalmente. Cambia Prefix."
  }
}

Write-Host "[3/9] Registrando providers (una sola vez por suscripcion)..."
az provider register --namespace Microsoft.App | Out-Null
az provider register --namespace Microsoft.OperationalInsights | Out-Null
az provider register --namespace Microsoft.ContainerRegistry | Out-Null
az provider register --namespace Microsoft.Storage | Out-Null
az provider register --namespace Microsoft.KeyVault | Out-Null
if ($CreateCosmos) {
  az provider register --namespace Microsoft.DocumentDB | Out-Null
}

Write-Host "[4/9] Creando Resource Group..."
az group create --name $ResourceGroup --location $Location | Out-Null

Write-Host "[5/9] Creando Log Analytics + Container Apps Environment..."
$lawExists = az monitor log-analytics workspace show --resource-group $ResourceGroup --workspace-name $lawName --query "name" -o tsv 2>$null
if (-not $lawExists) {
  az monitor log-analytics workspace create --resource-group $ResourceGroup --workspace-name $lawName --location $Location --sku PerGB2018 | Out-Null
}

$workspaceId = az monitor log-analytics workspace show --resource-group $ResourceGroup --workspace-name $lawName --query "customerId" -o tsv
$workspaceKey = az monitor log-analytics workspace get-shared-keys --resource-group $ResourceGroup --workspace-name $lawName --query "primarySharedKey" -o tsv

$envExists = az containerapp env show --name $acaEnvName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
if (-not $envExists) {
  az containerapp env create --name $acaEnvName --resource-group $ResourceGroup --location $Location --logs-workspace-id $workspaceId --logs-workspace-key $workspaceKey | Out-Null
}

Write-Host "[6/9] Creando Azure Container Registry..."
$acrExistsNow = az acr show --name $acrName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
if (-not $acrExistsNow) {
  az acr create --name $acrName --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled true | Out-Null
}

Write-Host "[7/9] Creando Storage Account + file shares..."
$stExistsNow = az storage account show --name $storageName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
if (-not $stExistsNow) {
  az storage account create --name $storageName --resource-group $ResourceGroup --location $Location --sku Standard_LRS --kind StorageV2 | Out-Null
}

$storageKey = az storage account keys list --account-name $storageName --resource-group $ResourceGroup --query "[0].value" -o tsv
az storage share-rm create --resource-group $ResourceGroup --storage-account $storageName --name $storageShareRaw --quota 100 | Out-Null
az storage share-rm create --resource-group $ResourceGroup --storage-account $storageName --name $storageShareData --quota 20 | Out-Null

Write-Host "[8/9] Creando Key Vault..."
$kvExists = az keyvault show --name $keyVaultName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
if (-not $kvExists) {
  az keyvault create --name $keyVaultName --resource-group $ResourceGroup --location $Location --enable-rbac-authorization true | Out-Null
}

if ($CreateCosmos) {
  Write-Host "[9/9] Creando Cosmos DB SQL (opcional)..."
  $cosmosExists = az cosmosdb show --name $cosmosName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
  if (-not $cosmosExists) {
    if ($EnableCosmosFreeTier) {
      az cosmosdb create --name $cosmosName --resource-group $ResourceGroup --locations regionName=$Location failoverPriority=0 isZoneRedundant=false --enable-free-tier true | Out-Null
    } else {
      az cosmosdb create --name $cosmosName --resource-group $ResourceGroup --locations regionName=$Location failoverPriority=0 isZoneRedundant=false | Out-Null
    }
  }
  az cosmosdb sql database create --account-name $cosmosName --resource-group $ResourceGroup --name facturasdb | Out-Null
  az cosmosdb sql container create --account-name $cosmosName --resource-group $ResourceGroup --database-name facturasdb --name documents --partition-key-path "/empresa" | Out-Null
} else {
  Write-Host "[9/9] Cosmos DB omitido (CreateCosmos=false)."
}

Write-Host ""
Write-Host "Listo. Recursos base creados/validados:"
Write-Host "Resource Group      : $ResourceGroup"
Write-Host "Location            : $Location"
Write-Host "Container Apps Env  : $acaEnvName"
Write-Host "ACR                 : $acrName"
Write-Host "Storage Account     : $storageName"
Write-Host "File Share /storage : $storageShareRaw"
Write-Host "File Share /data    : $storageShareData"
Write-Host "Key Vault           : $keyVaultName"
if ($CreateCosmos) {
  Write-Host "Cosmos Account      : $cosmosName"
}
Write-Host ""
Write-Host "Siguiente paso: ejecutar deploy-containerapps.ps1 con el mismo Prefix."
