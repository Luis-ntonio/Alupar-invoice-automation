# GCP Real Flow - Cloud Run + Workato + Firestore + Document AI

Esta carpeta contiene lo necesario para levantar el flujo real en GCP.

## Contenido

- `setup-gcp.ps1`: habilita APIs, crea buckets, service account y permisos IAM.
- `deploy-cloudrun.ps1`: build y deploy en Cloud Run con variables de entorno.
- `env.cloudrun.example`: variables de ejemplo para entorno real.
- `workato-http-intake.json`: ejemplo de contrato de request para Workato.

## 1) Prerrequisitos

- Tener `gcloud` instalado y autenticado.
- Proyecto GCP creado.
- Billing habilitado.
- Permisos de Owner o roles equivalentes.

## 2) Provisionar infraestructura base

```powershell
./gcp-real/setup-gcp.ps1 -ProjectId "tu-proyecto" -Region "us-central1" -DocumentAiLocation "us" -RawBucket "tu-proyecto-raw" -ExportsBucket "tu-proyecto-exports"
```

El script:
- Habilita APIs de Run, Build, Artifact Registry, Firestore, Storage y Document AI.
- Crea buckets raw/exports.
- Crea service account para Cloud Run.
- Asigna roles para Storage, Firestore y Document AI.
- Crea el procesador de Document AI (tipo INVOICE_PROCESSOR).

## 3) Deploy Cloud Run

```powershell
./gcp-real/deploy-cloudrun.ps1 -ProjectId "tu-proyecto" -Region "us-central1" -DocumentAiLocation "us" -ServiceName "proyecto2-facturas" -RawBucket "tu-proyecto-raw" -ExportsBucket "tu-proyecto-exports" -DocumentAiProcessorId "<processor-id>" -WorkatoSharedSecret "<secreto>"
```

## 4) Conectar Workato

- Endpoint: `https://<cloud-run-url>/api/intake`
- Method: `POST`
- Content-Type: `multipart/form-data`
- Header recomendado: `x-workato-secret: <secreto>`
- Adjuntos en campo repetible: `files`
- Metadatos: `messageId`, `sender`, `subject`, `receivedAt`

Ejemplo de payload en `workato-http-intake.json`.

## 5) MVP local - ubicacion de PDFs/XML

Para el MVP local no necesitas GCP.

1. Levanta app local con `.env` usando:
- `STORAGE_MODE=local`
- `DB_MODE=local`

2. Los archivos llegan por API `POST /api/intake` y se guardan automaticamente en:
- `Proyecto2/storage/raw/<requestId>/...` (originales PDF/XML)
- `Proyecto2/storage/exports/<requestId>/...` (ZIPs generados)

3. La data procesada se guarda en:
- `Proyecto2/data/documents.json`

No hace falta copiar archivos manualmente a una carpeta de entrada: Workato (o curl/Postman) los envía al endpoint.
