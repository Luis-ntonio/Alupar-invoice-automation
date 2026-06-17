# Azure Real Flow - Container Apps + Entra ID + Azure Files

Esta carpeta replica el flujo de `gcp-real` para Azure con scripts de setup y deploy.

## Contenido

- `setup-azure.ps1`: crea infraestructura base de Azure.
- `deploy-containerapps.ps1`: build/deploy del contenedor en Azure Container Apps.
- `setup-entra-auth.ps1`: crea App Registrations para login con Microsoft Entra ID y roles.
- `assign-entra-role-by-email.ps1`: asigna rol a usuarios por correo.
- `env.azure.example`: referencia de variables de entorno.

## 1) Prerrequisitos

- Azure CLI instalado (`az`).
- Sesion iniciada: `az login`.
- Suscripcion activa (Azure Free funciona para piloto).
- Permisos de `Owner` o equivalentes en la suscripcion.
- Permisos de administrador de Entra ID para consentimientos y asignacion de roles.

## 2) Provisionar infraestructura base

```powershell
./azure-real/setup-azure.ps1 -SubscriptionId "<subscription-id>" -ResourceGroup "rg-proyecto2" -Location "eastus" -Prefix "proyecto2" -CreateCosmos
```

Esto crea:

- Resource Group
- Log Analytics Workspace
- Container Apps Environment
- Azure Container Registry (ACR)
- Storage Account + Blob containers (`raw`, `exports`)
- Key Vault
- Cosmos DB SQL

## 3) Deploy de la app

```powershell
./azure-real/deploy-containerapps.ps1 -SubscriptionId "<subscription-id>" -ResourceGroup "rg-proyecto2" -Prefix "proyecto2" -ContainerAppName "proyecto2-facturas" -WorkatoSharedSecret "<secreto>"
```

El script:

- Construye imagen Docker en ACR (`az acr build`)
- Registra Azure Files en el Container Apps Environment
- Despliega/actualiza Container App
- Monta rutas persistentes:
  - `/app/storage`
  - `/app/data`
- Imprime URL publica y `health`.

## 4) Configurar login Entra ID + roles

### 4.1 Crear app registrations

```powershell
./azure-real/setup-entra-auth.ps1 -ApiAppName "proyecto2-api" -FrontendAppName "proyecto2-frontend" -FrontendRedirectUri "https://TU_FQDN/.auth/login/aad/callback"
```

### 4.2 Asignar roles por correo

```powershell
./azure-real/assign-entra-role-by-email.ps1 -ApiAppId "<api-app-id>" -RoleValue "Operaciones" -Emails "usuario1@dominio.com","usuario2@dominio.com"
```

Roles incluidos:

- `Admin`
- `Operaciones`
- `Revision`
- `SoloLectura`

## 5) Que debes hacer tu manualmente

1. Crear/activar la suscripcion Azure (si es Free, validar credito y cuotas).
2. Ejecutar `az login` con una cuenta con permisos suficientes.
3. Elegir region y naming final (`Prefix` globalmente unico para ACR/Storage).
4. Dar admin consent en Entra ID para permisos Graph si haras asignaciones por script.
5. Definir que correos o grupos tendran cada rol.
6. En Workato, apuntar a `https://<fqdn>/api/intake` y enviar `x-workato-secret`.
7. Probar flujo completo con XML/PDF/ZIP reales.

## 6) Notas importantes

- Esta version despliega la app en modo Azure nativo: `STORAGE_MODE=azure` y `DB_MODE=cosmos`.
- El deploy configura `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER_*`, `AZURE_COSMOS_ENDPOINT` y `AZURE_COSMOS_KEY` automaticamente en Container Apps.
- Si usas Azure Free, los limites alcanzan para PoC/piloto pequeno, no para produccion sostenida.
