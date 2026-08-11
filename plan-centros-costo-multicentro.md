# Centros de costo COES: SCIO, exclusión VTEA, informe COES en export, y split automático de facturas multi-centro

## Contexto

El cliente entregó en `observaciones/` (docx + 3 excels reales de informes COES de junio 2026) y `ejemplos/` (2 excels de control de pagos reales) la metodología para obtener 5 de los 10 centros de costo. Comparando esto contra el estado actual del código (`CENTRO_COSTO_COES_SOURCES` en `src/services/centroCostosService.ts`) se encontraron 3 cosas que hay que corregir/ampliar:

1. **Falta un centro de costo**: el doc/plantilla del cliente documenta el método completo para `004.1.11` (Liquidación de SCIO, informe `COES/D/DO/SME-INF-125-2026`, archivo `Cuadro de Liquidación {mm}-{aa}.xlsx`, hoja `Cuadro 1`) — hoy listado como "pendiente" en `centros-de-costo-coes.md`, pero ya resuelto en la práctica por el cliente. Verificado abriendo el excel real: layout de la hoja, fila de RUC, celda del código de informe (`U4`), y que Alupar/La Virgen aparece como fila (paga), igual patrón que VTP.
2. **`004.2.1` (Energía Activa/VTEA) mal mapeado**: el cliente indica que la fuente COES asignada hoy (`dataset: vtea`) no es la correcta para ese centro de costo. Se retira solo la validación automática (`CENTRO_COSTO_COES_SOURCES["004.2.1"]`); el catálogo, los dropdowns del dashboard y la vista `/coes` (para verificación manual) quedan intactos — decisión explícita del usuario, alcance acotado.
3. **Facturas que pagan más de un centro de costo**: cuando el monto de una factura no calza (o no se encuentra) contra la fuente COES de su centro de costo asignado, hay que buscar el RUC del proveedor en las demás fuentes ya mapeadas y sumar montos hasta calzar con el total de la factura. El usuario decidió que esto **genere automáticamente un registro (`EmailRecord`) por cada centro de costo involucrado**, cada uno con su monto proporcional — no un multi-select ni un array de códigos en un solo registro. El vínculo visual entre los registros divididos es simplemente que comparten el mismo "Código de Factura" (numeroDocumento), que ya existe como columna tanto en el dashboard como en el Excel de exportación — no hace falta ninguna columna nueva para esto.

Adicionalmente, el cliente pidió agregar al Excel de exportación (`src/services/excelExportService.ts`) el nombre del informe COES de donde se obtuvo la validación de cada centro de costo (ej. `COES/D/DO/SME-INF-123-2026`), inmediatamente después de las columnas "Centro de Costo".

## 1. `src/services/coesService.ts` — nuevo dataset `scio`

- `export type CoesDataset = "vtea" | "vtp" | "sst" | "scio";`
- Nueva función de nombre de archivo (confirmado en `observaciones/Informes_COES.docx`, informe `INF-125-2026`):
  ```ts
  function coesScioFileName(year: number, month: number): string {
    const mm = String(month).padStart(2, "0");
    const yy = String(year).slice(-2);
    return `Cuadro de Liquidación ${mm}-${yy}.xlsx`;
  }
  ```
- Nueva entrada en `DATASETS`:
  ```ts
  {
    dataset: "scio",
    // TODO: basePath sin confirmar contra el portal COES real -- por analogia
    // con Liquidaciones VTP/VTEA. Si esta mal, syncCoesMonthlyDataset devuelve
    // "not_available" (no rompe nada); 004.1.11 sigue asignable manualmente.
    basePath: "Mercado Mayorista/Liquidaciones del MME/01 Mercado de Corto Plazo/Liquidaciones SCIO",
    fileName: coesScioFileName,
    storageFolder: "liquidaciones-scio",
  },
  ```
- `INFORME_CELL.scio = { sheet: "Cuadro 1", address: "U4" }` — **verificado abriendo `observaciones/2_Cuadro de Liquidación 06-26 _inf 125-2026.xlsx`**, contiene el string plano `"COES/D/DO/SME-INF-125-2026"`.
- Nada más en este archivo requiere cambios: `runCoesAutoSync`/`syncCoesMonthlyRequiredFiles` iteran genéricamente sobre `DATASETS`, así que SCIO se suma solo al auto-sync mensual.
- Nueva función exportada para poblar `informeCode` correctamente (hoy se saca mal, ver sección 2):
  ```ts
  // A diferencia de findCoesIndexEntry (requiere ya conocer el informeCode),
  // esta busca por dataset+periodo -- caso de resolveCentroCostos, que conoce
  // el periodo pero no el codigo de informe hasta sincronizar.
  export async function findCoesIndexEntryForPeriod(
    dataset: CoesDataset,
    period: CoesSyncPeriod,
    blobStorage: BlobStorageService
  ): Promise<CoesIndexEntry | undefined> {
    const entries = await listCoesIndex(blobStorage);
    return entries.find(
      (e) => e.dataset === dataset && e.period.year === period.year && e.period.month === period.month
    );
  }
  ```

## 2. `src/services/centroCostosService.ts` — LVTEA, SCIO, informe COES, reconciliación multi-fuente

1. **LVTEA (alcance acotado)**: eliminar la línea `"004.2.1": { dataset: "vtea", sheet: "CUADRO 1" },` de `CENTRO_COSTO_COES_SOURCES`. No tocar catálogo ni dropdowns.
2. **SCIO**: agregar `"004.1.11": { dataset: "scio", sheet: "Cuadro 1" },` y en `SHEET_LAYOUT_OVERRIDES`:
   ```ts
   "scio::Cuadro 1": { nameColumn: 1, supplierColumn: 2, dataStartColumn: 3 }, // verificado contra el xlsx real
   ```
   (mismo layout que `sst::Cuadro 2`: nombre en A, RUC en B, montos desde C — confirmado con `findBlockHeaderRows` reproducido a mano contra el archivo real, detecta un único bloque en la fila 7).
3. **Refactor de `crossCheckAmount`**: extraer la búsqueda de monto cruzado (Alupar como columna o como fila) a una función pura reutilizable, para no duplicarla en la reconciliación:
   ```ts
   function findMontoEsperado(matrix: CoesMatrix, supplierRuc: string): number | undefined {
     if (matrix.aluparColumn !== undefined) {
       const supplierRow = matrix.rows.find((r) => r.ruc === supplierRuc);
       const monto = supplierRow?.values[matrix.aluparColumn];
       if (monto !== undefined) return monto;
     }
     if (matrix.aluparRow !== undefined) {
       const supplierColumn = matrix.columns.find((c) => c.ruc === supplierRuc);
       const aluparRowData = matrix.rows.find((r) => r.row === matrix.aluparRow);
       const monto = supplierColumn ? aluparRowData?.values[supplierColumn.col] : undefined;
       if (monto !== undefined) return monto;
     }
     return undefined;
   }
   ```
   `crossCheckAmount` pasa a usar esta función; comportamiento observable no cambia.
4. **Informe COES correcto**: hoy `resolveCentroCostos` saca `informeCode` con `extractInformeCode(extracted.concepto ?? extracted.rawTextSnippet)` — es decir, busca el patrón `COES/D/DO/SME-INF-...` **en el texto de la factura del proveedor**, que casi nunca lo trae. Cambiar para que, tras sincronizar el excel COES exitosamente, se resuelva desde el índice ya poblado por `indexCoesFile` durante el sync:
   ```ts
   const indexEntry = await findCoesIndexEntryForPeriod(dataset, period, blobStorage).catch(() => undefined);
   const informeCode = indexEntry?.informeCode ?? extractInformeCode(extracted.concepto ?? extracted.rawTextSnippet);
   ```
5. **Tipos nuevos para la reconciliación**:
   ```ts
   export interface CentroCostoMatch {
     centroCostoCode: string;
     dataset: CoesDataset;
     sheet: string;
     informeCode?: string;
     montoEsperadoSinIgv: number;
   }

   export interface CentroCostosResult {
     coesValidacion?: CoesValidacion;
     reassignedCentroCostoCode?: string; // 1 sola fuente distinta calzo -> reasignar sin dividir
     splitMatches?: CentroCostoMatch[];  // 2+ fuentes suman el total -> generar un registro por cada una
   }
   ```
6. **Funciones de reconciliación**:
   ```ts
   async function collectReconciliationCandidates(
     supplierRuc: string,
     period: CoesSyncPeriod,
     blobStorage: BlobStorageService
   ): Promise<CentroCostoMatch[]> {
     const candidates: CentroCostoMatch[] = [];
     for (const [code, source] of Object.entries(CENTRO_COSTO_COES_SOURCES)) {
       const sync = await syncCoesMonthlyDataset(source.dataset, period, blobStorage).catch(() => undefined);
       if (!sync?.storagePath) continue;
       const matrix = await loadCoesMatrix(source.dataset, source.sheet, sync.storagePath, blobStorage);
       if (!matrix) continue;
       const monto = findMontoEsperado(matrix, supplierRuc);
       if (monto === undefined) continue;
       const indexEntry = await findCoesIndexEntryForPeriod(source.dataset, period, blobStorage).catch(() => undefined);
       candidates.push({ centroCostoCode: code, dataset: source.dataset, sheet: source.sheet, informeCode: indexEntry?.informeCode, montoEsperadoSinIgv: monto });
     }
     return candidates;
   }

   // Fuerza bruta sobre subconjuntos (<=6 fuentes hoy, 2^n trivial). Prioriza
   // la combinacion con menos fuentes; entre empates, la de menor diferencia.
   function findCombinationMatchingTotal(
     candidates: CentroCostoMatch[],
     target: number,
     tolerance: number
   ): CentroCostoMatch[] | undefined { /* ... */ }
   ```
7. **Disparo dentro de `resolveCentroCostos`**: cuando el resultado de `crossCheckAmount` (o el fallo de sync/período) da `status === "no_coincide"` **o** `status === "no_encontrado"`:
   ```ts
   const candidates = await collectReconciliationCandidates(supplierRuc, period, blobStorage);
   const montoSinIgv = montoFactura / (1 + IGV_RATE);
   const combo = findCombinationMatchingTotal(candidates, montoSinIgv, AMOUNT_TOLERANCE);
   if (combo && combo.length >= 2) {
     return { splitMatches: combo };
   }
   if (combo && combo.length === 1 && combo[0].centroCostoCode !== centroCostoCode) {
     return {
       reassignedCentroCostoCode: combo[0].centroCostoCode,
       coesValidacion: { dataset: combo[0].dataset, informeCode: combo[0].informeCode, montoFactura, montoEsperado: combo[0].montoEsperadoSinIgv, status: "validado", detalle: `Reconciliado: el RUC calzo en ${combo[0].centroCostoCode} en vez del centro de costo asignado originalmente.` },
     };
   }
   return { coesValidacion }; // sin combinacion -> se conserva el resultado original (no_coincide/no_encontrado)
   ```
   VTEA queda fuera de la búsqueda porque ya no tiene entrada en `CENTRO_COSTO_COES_SOURCES` (decisión #1).

## 3. `src/types.ts`

```ts
export type CoesDataset = "vtea" | "vtp" | "sst" | "scio"; // ahora se importa de coesService, no se duplica aqui si ya existe alias

export interface CoesValidacion {
  dataset: "vtea" | "vtp" | "sst" | "scio"; // se agrega "scio"
  informeCode?: string;
  montoFactura: number;
  montoEsperado?: number;
  status: CoesValidacionStatus;
  detalle: string;
}
```
`EmailRecord` no cambia de forma (`centroCostos?: string` se mantiene escalar) — el split se resuelve creando **registros adicionales**, no ampliando este tipo.

## 4. `src/routes.ts` — split automático en `processIntakeFiles`

1. `coesMatrixQuerySchema` / `coesVerifyBodySchema` (`z.enum(["vtea","vtp","sst"])`): agregar `"scio"`, y actualizar los mensajes de error que listan datasets válidos.
2. `IntakeSuccessResult["body"]`: agregar `records?: EmailRecord[]` (mantiene `record` como el primero, para no romper consumidores existentes del campo singular).
3. Reemplazar el bloque de construcción de `record` (líneas ~848-918) para ramificar según `centroCostosResult`:
   ```ts
   const centroCostosResult = await resolveCentroCostos(centroCostos, extracted as ExtractedFields, blobStorage).catch((err) => {
     console.warn("[centroCostos] Resolucion fallo:", err instanceof Error ? err.message : err);
     return {} as CentroCostosResult;
   });

   const baseFields = {
     metadata, files: attachedFiles, extracted, documentType, concept,
     empresa: (extracted as any).emisor ?? "",
     fideicomiso: detectFideicomiso(extracted),
     ruc: (extracted as any).ruc ?? "",
     sunatValidacion,
     status: extractionError ? "error" as const : "pendiente" as const,
     error: extractionError, createdAt: now, updatedAt: now,
   };

   if (centroCostosResult.splitMatches && centroCostosResult.splitMatches.length >= 2) {
     const records: EmailRecord[] = centroCostosResult.splitMatches.map((match) => {
       const montoConIgv = Number((match.montoEsperadoSinIgv * 1.18).toFixed(2));
       return {
         id: randomUUID(),
         ...baseFields,
         extracted: { ...extracted, monto: montoConIgv },
         centroCostos: match.centroCostoCode,
         coesValidacion: {
           dataset: match.dataset, informeCode: match.informeCode,
           montoFactura: montoConIgv, montoEsperado: match.montoEsperadoSinIgv,
           status: "validado",
           detalle: `Factura dividida automaticamente entre ${centroCostosResult.splitMatches!.length} centros de costo (misma factura, RUC ${(extracted as any).ruc}); esta parte corresponde a ${match.centroCostoCode}${match.informeCode ? ` (informe ${match.informeCode})` : ""}.`,
         },
       };
     });
     for (const r of records) { await repository.save(r); broadcastNewDocument(r); }
     return { statusCode: 202, body: { requestId, accepted: attachedFiles.length, rejected, record: records[0], records } };
   }

   const record: EmailRecord = {
     id: requestId,
     ...baseFields,
     centroCostos: centroCostosResult.reassignedCentroCostoCode ?? centroCostos,
     coesValidacion: centroCostosResult.coesValidacion,
   };
   await repository.save(record);
   broadcastNewDocument(record);
   return { statusCode: 202, body: { requestId, accepted: attachedFiles.length, rejected, record } };
   ```
   Nota: los `files[].sourcePath` se calculan una sola vez (con el `requestId` original) y se **comparten sin cambios** entre los registros divididos — apuntan al mismo PDF/XML físico, solo cambian `id`, `centroCostos`, `extracted.monto` y `coesValidacion`. El "Código de Factura" (`extracted.numeroDocumento`) se conserva igual en todos, que es el vínculo visual pedido por el usuario.
4. Import: agregar `CentroCostosResult` desde `centroCostosService.ts` para tipar `centroCostosResult` explícitamente en vez de dejarlo inferido/`any`.

## 5. `src/services/excelExportService.ts` — columna "Informe COES"

1. Insertar en `COLUMNS`, inmediatamente después de las dos entradas `{ header: "Centro de Costo" }`:
   ```ts
   { header: "Centro de Costo", width: 11.45 },
   { header: "Centro de Costo", width: 11.18 },
   { header: "Informe COES", width: 18 }, // NUEVO
   { header: "", width: 3.18 },
   { header: "", width: 7.18 },
   ```
2. En el array `values` del `forEach`, insertar `record.coesValidacion?.informeCode || ""` en la misma posición (después de `centroCostoDescripcion(record)`, antes de los dos `null` espaciadores).
3. Los `row.getCell(N).numFmt` existentes (índices 2, 6, 7, 9, 10) están todos ANTES del punto de inserción — no cambian.
4. No hace falta lógica de concatenación multi-valor (a diferencia del diseño inicial): cada `EmailRecord` ya representa un solo centro de costo/fuente, incluso en el caso de facturas divididas.

## 6. `public/coes.html` / `public/coes.js`

- Agregar en `#datasetSelect`: `<option value="scio:Cuadro 1">SCIO — 004.1.11 Liquidación de SCIO</option>`.
- Dejar `vtea:CUADRO 1` tal cual (sigue disponible para verificación manual).
- `coes.js` no requiere cambios (`centroCostoSources()` deriva del DOM).

## 7. `centros-de-costo-coes.md`

- Tabla "con validación automática": pasa de 5 a 6, agregar fila de `004.1.11` (SCIO, informe `INF-125-2026`, hoja `Cuadro 1`, nota sobre el basePath remoto sin confirmar).
- Quitar `004.1.11` de la tabla "pendientes".
- Nota explícita: `004.2.1` (VTEA) fue retirado de la validación automática porque la fuente asignada no era la correcta; sigue asignable manualmente y visible en `/coes` para verificación manual sin auto-validación.
- Sección nueva: cómo funciona la reconciliación multi-centro y el split automático de facturas (un registro por centro de costo, mismo Código de Factura, monto proporcional).

## No tocar

- `ALUPAR_RUC` (TODO preexistente).
- La lógica de fallback `Mensual/` en `syncCoesMonthlyDataset`.
- `buildMatrixFromSheet`/`findBlockHeaderRows` (el layout de SCIO ya es compatible sin cambios ahí).
- Catálogo (`centroCostosCatalog.ts`) y dropdowns de centro de costo en `renderer.js`/`fallidas.js` (LVTEA es alcance acotado; no hay UI multi-select porque el split genera registros separados).

## Riesgo abierto (no bloqueante)

El `basePath` remoto exacto de SCIO en el portal COES no se pudo confirmar contra los archivos de `observaciones/` (solo se confirmó la URL de sección del portal, no la ruta de carpetas). Si está mal, el auto-sync de SCIO simplemente no encuentra archivo (`not_available`) sin romper nada; 004.1.11 sigue siendo asignable manualmente mientras tanto. Recomendado confirmarlo navegando el portal COES real en cuanto se pueda.

## Verificación

1. **Sync SCIO**: disparar `syncCoesMonthlyRequiredFiles`/`POST /coes/sync` para 2026-06 y confirmar si `scio` resuelve `storagePath` o cae a `not_available` (si cae, ajustar `basePath`); confirmar que `coes/coes-index.json` gana una entrada `dataset: "scio"` con `informeCode: "COES/D/DO/SME-INF-125-2026"`.
2. **Cross-check SCIO**: `POST /coes/verify` con `dataset=scio&sheet=Cuadro 1&year=2026&month=6&supplierRuc=<RUC de fila 8-67 del xlsx>&monto=<monto*1.18>` → `status: "validado"`.
3. **LVTEA**: una factura con concepto "energía activa" (004.2.1) se sigue asignando ese código (vía `resolveCentroCostosCode`, sin cambios), pero `resolveCentroCostos` ya no intenta sincronizar/validar contra `vtea` (sin entrada en `CENTRO_COSTO_COES_SOURCES`) — `coesValidacion` queda `undefined` para esos registros; `/coes` sigue permitiendo navegar `vtea:CUADRO 1` manualmente.
4. **Split multi-centro**: usar un caso conocido de `ejemplos/lv 455.xlsx`/`lv 473.xlsx` donde el RUC de una factura aparece repartido en 2+ centros de costo; simular el intake (o invocar `resolveCentroCostos` directo con un script) y confirmar que se crean 2+ `EmailRecord` con el mismo `extracted.numeroDocumento`, `centroCostos` distinto cada uno, y que la suma de `extracted.monto` (con IGV) coincide con el monto original de la factura dentro de tolerancia.
5. **Excel export**: generar `POST /exports/excel` sobre registros divididos y confirmar que aparecen como filas separadas con el mismo Código de Factura, cada una con su columna "Informe COES" poblada y sus columnas bancarias en blanco intactas (no se corrieron los `numFmt`).
6. **Informe COES en registros normales (no divididos)**: confirmar que una factura de VTP/SST/SCIO que sí calza a la primera trae `coesValidacion.informeCode` poblado (antes casi siempre quedaba vacío por el bug de `extractInformeCode` sobre el texto de la factura).
