param(
  [Parameter(Mandatory = $true)] [string]$SubscriptionId,
  [Parameter(Mandatory = $true)] [string]$ResourceGroup,
  [Parameter(Mandatory = $true)] [string]$Prefix,
  [string]$Location = "eastus",
  [string]$ContainerAppName = "proyecto2-facturas",
  [string]$ImageTag = "latest",
  [Parameter(Mandatory = $true)] [string]$WorkatoSharedSecret,
  [switch]$EnableWorkatoRemoteUrls
)

$ErrorActionPreference = "Stop"

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

$storageShareRaw = "storage"
$storageShareData = "data"
$storageRefRaw = "storagefiles"
$storageRefData = "datafiles"

Write-Host "[1/8] Seleccionando suscripcion..."
az account set --subscription $SubscriptionId | Out-Null

Write-Host "[2/8] Validando recursos base..."
$acrLoginServer = az acr show --name $acrName --resource-group $ResourceGroup --query "loginServer" -o tsv
if (-not $acrLoginServer) { throw "No se encontro ACR '$acrName'. Ejecuta setup-azure.ps1 primero." }

$envId = az containerapp env show --name $acaEnvName --resource-group $ResourceGroup --query "id" -o tsv
if (-not $envId) { throw "No se encontro Container Apps Environment '$acaEnvName'. Ejecuta setup-azure.ps1 primero." }

$storageKey = az storage account keys list --account-name $storageName --resource-group $ResourceGroup --query "[0].value" -o tsv
if (-not $storageKey) { throw "No se encontro Storage Account '$storageName'. Ejecuta setup-azure.ps1 primero." }

Write-Host "[3/8] Build de imagen en ACR..."
$imageName = "$ContainerAppName`:$ImageTag"
az acr build --registry $acrName --image $imageName .
$imageRef = "$acrLoginServer/$imageName"

Write-Host "[4/8] Obteniendo credenciales ACR para Container App..."
$acrUser = az acr credential show --name $acrName --query "username" -o tsv
$acrPass = az acr credential show --name $acrName --query "passwords[0].value" -o tsv

Write-Host "[5/8] Registrando file shares en Container Apps Environment..."
az containerapp env storage set --name $acaEnvName --resource-group $ResourceGroup --storage-name $storageRefRaw --azure-file-account-name $storageName --azure-file-account-key $storageKey --azure-file-share-name $storageShareRaw --access-mode ReadWrite | Out-Null
az containerapp env storage set --name $acaEnvName --resource-group $ResourceGroup --storage-name $storageRefData --azure-file-account-name $storageName --azure-file-account-key $storageKey --azure-file-share-name $storageShareData --access-mode ReadWrite | Out-Null

Write-Host "[6/8] Generando manifiesto temporal de Container App..."
$enableRemote = if ($EnableWorkatoRemoteUrls) { "true" } else { "false" }
$revisionTag = ("rev-" + (($ImageTag.ToLower() -replace "[^a-z0-9-]", "-").Trim("-")))
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
            value: local
          - name: DB_MODE
            value: local
          - name: LOCAL_STORAGE_DIR
            value: /app/storage
          - name: LOCAL_DATA_DIR
            value: /app/data
          - name: WORKATO_SHARED_SECRET
            value: $WorkatoSharedSecret
          - name: ENABLE_WORKATO_REMOTE_URLS
            value: "$enableRemote"
        volumeMounts:
          - mountPath: /app/storage
            volumeName: storage-volume
          - mountPath: /app/data
            volumeName: data-volume
    volumes:
      - name: storage-volume
        storageType: AzureFile
        storageName: $storageRefRaw
      - name: data-volume
        storageType: AzureFile
        storageName: $storageRefData
    scale:
      minReplicas: 1
      maxReplicas: 1
"@

$yaml | Set-Content -Path $yamlPath -Encoding utf8

Write-Host "[7/8] Deploy de Container App..."
$exists = az containerapp show --name $ContainerAppName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
if ($exists) {
  az containerapp update --name $ContainerAppName --resource-group $ResourceGroup --yaml $yamlPath | Out-Null
} else {
  az containerapp create --name $ContainerAppName --resource-group $ResourceGroup --yaml $yamlPath | Out-Null
}

Write-Host "[8/8] URL publica..."
$fqdn = az containerapp show --name $ContainerAppName --resource-group $ResourceGroup --query "properties.configuration.ingress.fqdn" -o tsv
Write-Host "https://$fqdn"
Write-Host "Health: https://$fqdn/api/health"
