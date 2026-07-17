# GCP Real Flow - Cloud Run + Workato + Firestore + Document AI + Firebase Auth

Esta carpeta contiene lo necesario para levantar el flujo real en GCP.

La app corre 100% en GCP: Cloud Storage, Firestore, Document AI y Firebase
Authentication. No hay dependencias de Azure. La implementación anterior sobre
Azure (Blob, Cosmos DB, Entra ID/MSAL) queda en la rama `legacy-azure`.

## Contenido

- `setup-gcp.ps1`: habilita APIs, crea buckets, service account, permisos IAM,
  Firestore, el procesador de Document AI y configura Firebase Auth.
- `add-user.ps1`: crea usuarios de Firebase Auth con email/contraseña.
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
- Habilita APIs de Run, Build, Artifact Registry, Firestore, Storage, Document AI,
  Identity Toolkit y Firebase.
- Crea buckets raw/exports.
- Crea service account para Cloud Run.
- Asigna roles para Storage, Firestore y Document AI.
- Inicializa Firestore en modo nativo.
- Crea el procesador de Document AI (tipo INVOICE_PROCESSOR).
- Registra Firebase, crea la web app y habilita el login por email/contraseña.

Al terminar imprime el **Document AI Processor ID** y la **Firebase API Key**:
los dos hacen falta para el deploy.

Es idempotente: se puede volver a correr sobre un proyecto ya provisionado y
reutiliza lo que exista (buckets, SA, processor, web app).

## 3) Crear usuarios

Estar en Firebase Authentication **es** la autorización: no hay allow-list ni
roles. Cualquier usuario que exista puede entrar al dashboard.

```powershell
./gcp-real/add-user.ps1 -ProjectId "tu-proyecto" -Email "alguien@empresa.com"
```

Genera una contraseña al azar y la imprime una sola vez (Firebase guarda solo el
hash). Para fijarla vos: `-Password "..."`. Para cambiar la de un usuario que ya
existe: `-Password "..." -ResetPassword`.

También se pueden administrar desde la consola de Firebase
(Authentication > Users) en https://console.firebase.google.com.

## 4) Deploy Cloud Run

```powershell
./gcp-real/deploy-cloudrun.ps1 -ProjectId "tu-proyecto" -Region "us-central1" -DocumentAiLocation "us" -ServiceName "proyecto2-facturas" -RawBucket "tu-proyecto-raw" -ExportsBucket "tu-proyecto-exports" -DocumentAiProcessorId "<processor-id>" -WorkatoSharedSecret "<secreto>" -FirebaseApiKey "<api-key>"
```

`-FirebaseApiKey` es obligatoria. Con `NODE_ENV=production`, si falta, el
servicio **no levanta**: es a propósito. La alternativa —arrancar sin exigir
login— dejaría las facturas accesibles sin token, así que una env var ausente
cierra la app en vez de abrirla.

El servicio se despliega con `--allow-unauthenticated`, que es lo correcto: es
una web pública y el login lo resuelve la app (Firebase ID token verificado en
`src/middleware/auth.ts`), no el gate de plataforma de Cloud Run.

Verificación después del deploy — sin token debe dar **401**:

```powershell
(Invoke-WebRequest "https://<cloud-run-url>/api/documents" -SkipHttpErrorCheck).StatusCode
```

## 5) Conectar Workato

- Endpoint: `https://<cloud-run-url>/api/intake`
- Method: `POST`
- Content-Type: `multipart/form-data`
- Header recomendado: `x-workato-secret: <secreto>`
- Adjuntos en campo repetible: `files`
- Metadatos: `messageId`, `sender`, `subject`, `receivedAt`

Ejemplo de payload en `workato-http-intake.json`.

## 6) MVP local - ubicacion de PDFs/XML

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
