# Proyecto2 - Backend GCP para Facturas PDF/XML

Servicio en Node.js + TypeScript preparado para Cloud Run.

Incluye:
- API de ingesta para Workato (`/api/intake`) con soporte PDF y XML.
- Extraccion inicial de campos clave.
- Clasificacion (`factura`, `comprobante`, `nota`).
- Inferencia de concepto para agrupacion.
- Persistencia en modo local o Firestore.
- Almacenamiento en modo local o Cloud Storage.
- Generacion de ZIP por concepto (`/api/exports/:concept`).
- Dashboard web simple en `public/`.

## 1) Ejecutar en local

```bash
npm install
cp .env.example .env
npm run dev
```

Servicio en `http://localhost:8080`.

## 2) Endpoints principales

- `GET /api/health`
- `POST /api/intake` (multipart/form-data, campo `files`)
- `GET /api/documents`
- `GET /api/documents/:id`
- `POST /api/exports/:concept`

### Ejemplo de intake con curl

```bash
curl -X POST http://localhost:8080/api/intake \
  -F "messageId=abc-123" \
  -F "sender=proveedor@empresa.com" \
  -F "subject=Factura mayo" \
  -F "receivedAt=2026-05-25T15:20:00Z" \
  -F "files=@./muestra.pdf" \
  -F "files=@./muestra.xml"
```

## 3) Despliegue Cloud Run

### Build y push de imagen

```bash
gcloud builds submit --tag gcr.io/$GOOGLE_CLOUD_PROJECT/proyecto2-facturas
```

### Deploy

```bash
gcloud run deploy proyecto2-facturas \
  --image gcr.io/$GOOGLE_CLOUD_PROJECT/proyecto2-facturas \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars STORAGE_MODE=gcp,DB_MODE=firestore,GCS_BUCKET_RAW=<raw-bucket>,GCS_BUCKET_EXPORTS=<exports-bucket>,FIRESTORE_COLLECTION=documents
```

## 4) Integracion con Workato

Configura receta para enviar `multipart/form-data` al endpoint `/api/intake` con:
- metadatos del correo (`messageId`, `sender`, `subject`, `receivedAt`)
- uno o varios archivos en el campo `files`

## 5) Notas

- En Cloud Run se recomienda usar autenticacion (IAM o API Gateway) antes de produccion.
- La extraccion PDF/XML implementada es base; puedes sustituirla por Document AI para mayor precision.
