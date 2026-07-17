param(
  [Parameter(Mandatory = $true)] [string]$ProjectId,
  [string]$Region = "us-central1",
  [string]$DocumentAiLocation = "us",
  [string]$ServiceName = "proyecto2-facturas",
  [Parameter(Mandatory = $true)] [string]$RawBucket,
  [Parameter(Mandatory = $true)] [string]$ExportsBucket,
  [Parameter(Mandatory = $true)] [string]$DocumentAiProcessorId,
  [Parameter(Mandatory = $true)] [string]$WorkatoSharedSecret,
  # Obligatoria: sin ella el backend no levanta en produccion (falla cerrado en
  # services/firebaseAuth.ts). La imprime setup-gcp.ps1.
  [Parameter(Mandatory = $true)] [string]$FirebaseApiKey,
  [string]$FirebaseAuthDomain,
  [string]$ServiceAccountName = "proyecto2-facturas-sa"
)

$ErrorActionPreference = "Stop"

if (-not $FirebaseAuthDomain) {
  $FirebaseAuthDomain = "$ProjectId.firebaseapp.com"
}

$ServiceAccountEmail = "$ServiceAccountName@$ProjectId.iam.gserviceaccount.com"
$Image = "gcr.io/$ProjectId/$ServiceName"

Write-Host "[1/4] Configurando proyecto..."
gcloud config set project $ProjectId | Out-Null

Write-Host "[1b/4] Otorgando permisos de Storage a service account de Cloud Build..."
$ProjectNumber = gcloud projects describe $ProjectId --format "value(projectNumber)"
$ComputeSa = "$ProjectNumber-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding $ProjectId --member "serviceAccount:$ComputeSa" --role "roles/storage.objectAdmin" | Out-Null
gcloud projects add-iam-policy-binding $ProjectId --member "serviceAccount:$ComputeSa" --role "roles/cloudbuild.builds.builder" | Out-Null

Write-Host "[2/4] Build de imagen..."
gcloud builds submit --tag $Image

Write-Host "[3/4] Deploy Cloud Run..."
# --allow-unauthenticated es intencional: es una web publica y el login lo
# resuelve la app (requireAuth + Firebase ID token), no el gate de plataforma.
gcloud run deploy $ServiceName `
  --image $Image `
  --region $Region `
  --platform managed `
  --allow-unauthenticated `
  --service-account $ServiceAccountEmail `
  --set-env-vars "NODE_ENV=production,STORAGE_MODE=gcp,DB_MODE=firestore,GOOGLE_CLOUD_PROJECT=$ProjectId,GOOGLE_CLOUD_LOCATION=$Region,DOCUMENT_AI_LOCATION=$DocumentAiLocation,GCS_BUCKET_RAW=$RawBucket,GCS_BUCKET_EXPORTS=$ExportsBucket,FIRESTORE_COLLECTION=documents,USE_DOCUMENT_AI=true,DOCUMENT_AI_PROCESSOR_ID=$DocumentAiProcessorId,WORKATO_SHARED_SECRET=$WorkatoSharedSecret,FIREBASE_API_KEY=$FirebaseApiKey,FIREBASE_AUTH_DOMAIN=$FirebaseAuthDomain"

Write-Host "[4/4] URL del servicio"
$url = gcloud run services describe $ServiceName --region $Region --format "value(status.url)"
Write-Host $url
Write-Host ""
Write-Host "Verificacion rapida: sin token debe responder 401."
Write-Host "  curl -s -o /dev/null -w '%{http_code}' $url/api/documents"
