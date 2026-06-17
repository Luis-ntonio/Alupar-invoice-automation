param(
  [Parameter(Mandatory = $true)] [string]$SubscriptionId,
  [Parameter(Mandatory = $true)] [string]$ResourceGroup,
  [string]$Location = "eastus",
  [Parameter(Mandatory = $true)] [string]$Prefix,
  [switch]$CreateCosmos,
  [switch]$EnableCosmosFreeTier
)

$ErrorActionPreference = "Stop"

function Invoke-AzProbe {
  # Runs an az existence-check safely: non-zero exit returns $null instead of throwing.
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

$storageContainerRaw = "raw"
$storageContainerExports = "exports"

Write-Host "[1/9] Seleccionando suscripcion..."
az account set --subscription $SubscriptionId
if ($LASTEXITCODE -ne 0) { throw "No se pudo seleccionar la suscripcion '$SubscriptionId'. Verifica con: az account list" }

Write-Host "[2/9] Validando disponibilidad de nombres globales..."
$acrAvailable = az acr check-name --name $acrName --query "nameAvailable" -o tsv
if ($acrAvailable -ne "true") {
  $acrExists = Invoke-AzProbe { az acr show --name $acrName --resource-group $ResourceGroup --query "name" -o tsv }
  if (-not $acrExists) {
    throw "ACR '$acrName' no disponible globalmente. Cambia Prefix."
  }
}

$storageAvailable = Invoke-AzProbe { az storage account check-name --name $storageName --query "nameAvailable" -o tsv }
if ($storageAvailable -ne "true") {
  $storageExists = Invoke-AzProbe { az storage account show --name $storageName --resource-group $ResourceGroup --query "name" -o tsv }
  if (-not $storageExists) {
    if ($null -eq $storageAvailable) {
      Write-Warning "No se pudo verificar disponibilidad del nombre de Storage (proveedor registrandose). Continuando..."
    } else {
      throw "Storage account '$storageName' no disponible globalmente. Cambia Prefix."
    }
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
if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el Resource Group '$ResourceGroup'. Si se esta eliminando, espera con: az group wait --name '$ResourceGroup' --deleted" }

Write-Host "[5/9] Creando Log Analytics + Container Apps Environment..."
$lawExists = Invoke-AzProbe { az monitor log-analytics workspace show --resource-group $ResourceGroup --workspace-name $lawName --query "name" -o tsv }
if (-not $lawExists) {
  az monitor log-analytics workspace create --resource-group $ResourceGroup --workspace-name $lawName --location $Location --sku PerGB2018 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear Log Analytics workspace '$lawName'." }
}

$workspaceId = az monitor log-analytics workspace show --resource-group $ResourceGroup --workspace-name $lawName --query "customerId" -o tsv
if ($LASTEXITCODE -ne 0) { throw "No se pudo obtener ID del workspace '$lawName'." }
$workspaceKey = az monitor log-analytics workspace get-shared-keys --resource-group $ResourceGroup --workspace-name $lawName --query "primarySharedKey" -o tsv
if ($LASTEXITCODE -ne 0) { throw "No se pudo obtener key del workspace '$lawName'." }

$envExists = Invoke-AzProbe { az containerapp env show --name $acaEnvName --resource-group $ResourceGroup --query "name" -o tsv }
if (-not $envExists) {
  az containerapp env create --name $acaEnvName --resource-group $ResourceGroup --location $Location --logs-workspace-id $workspaceId --logs-workspace-key $workspaceKey | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear Container Apps Environment '$acaEnvName'. Prueba otra region con -Location." }
}

Write-Host "[6/9] Creando Azure Container Registry..."
$acrExistsNow = Invoke-AzProbe { az acr show --name $acrName --resource-group $ResourceGroup --query "name" -o tsv }
if (-not $acrExistsNow) {
  az acr create --name $acrName --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled true | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "No se pudo crear ACR '$acrName'." }
}

Write-Host "[7/9] Creando Storage Account + blob containers..."
$stExistsNow = Invoke-AzProbe { az storage account show --name $storageName --resource-group $ResourceGroup --query "name" -o tsv }
if (-not $stExistsNow) {
  az storage account create --name $storageName --resource-group $ResourceGroup --location $Location --sku Standard_LRS --kind StorageV2 | Out-Null
}

$storageKey = az storage account keys list --account-name $storageName --resource-group $ResourceGroup --query "[0].value" -o tsv
az storage container create --name $storageContainerRaw --account-name $storageName --account-key $storageKey --auth-mode key | Out-Null
az storage container create --name $storageContainerExports --account-name $storageName --account-key $storageKey --auth-mode key | Out-Null

Write-Host "[8/9] Creando Key Vault..."
$kvExists = Invoke-AzProbe { az keyvault show --name $keyVaultName --resource-group $ResourceGroup --query "name" -o tsv }
if (-not $kvExists) {
  az keyvault create --name $keyVaultName --resource-group $ResourceGroup --location $Location --enable-rbac-authorization true | Out-Null
}

if ($CreateCosmos) {
  Write-Host "[9/9] Creando Cosmos DB SQL (opcional)..."
  $cosmosExists = Invoke-AzProbe { az cosmosdb show --name $cosmosName --resource-group $ResourceGroup --query "name" -o tsv }
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
Write-Host "Blob Container raw  : $storageContainerRaw"
Write-Host "Blob Container exp  : $storageContainerExports"
Write-Host "Key Vault           : $keyVaultName"
if ($CreateCosmos) {
  Write-Host "Cosmos Account      : $cosmosName"
}
Write-Host ""
Write-Host "Siguiente paso: ejecutar deploy-containerapps.ps1 con el mismo Prefix."
