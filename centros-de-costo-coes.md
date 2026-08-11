# Centros de costo — validación COES

Este documento resume el estado de la prevalidación automática de monto
(factura vs. excel oficial de COES) por centro de costo. El catálogo completo
de códigos vive en `src/services/centroCostosCatalog.ts` (fuente: `centro de
costos.jpeg`); la fuente COES de cada código validado vive en
`CENTRO_COSTO_COES_SOURCES` dentro de `src/services/centroCostosService.ts`.

## Cómo funciona la validación

1. Al llegar una factura, `resolveCentroCostosCode` deriva el código
   `004.x.y` por coincidencia de palabras clave en el concepto/texto.
2. Si ese código tiene una entrada en `CENTRO_COSTO_COES_SOURCES`, se
   descarga (o reusa, si ya está cacheado) el excel COES correspondiente para
   el período de la factura, se abre la hoja indicada y se busca a Alupar
   (RUC `20492925030`) como fila o columna en la matriz de proveedores.
3. El monto de la factura (que incluye IGV) se compara sin IGV (÷1.18) contra
   el monto del excel, con una tolerancia de 0.01. Resultado: `validado`,
   `no_coincide` o `no_encontrado`.
4. El período a validar es el mes anterior a la fecha de emisión (el informe
   de un mes se publica recién al mes siguiente), con el texto del concepto
   como respaldo si la fecha no es parseable.
5. Si el código **no** tiene entrada en `CENTRO_COSTO_COES_SOURCES`, no hay
   validación automática — el centro de costo se asigna igual (por keywords),
   pero la verificación de monto queda manual desde el dashboard (`/coes`).
6. **Facturas que pagan más de un centro de costo**: si el cruce contra la
   fuente asignada da `no_coincide` o `no_encontrado`, el sistema busca el
   mismo RUC del proveedor en todas las demás fuentes de
   `CENTRO_COSTO_COES_SOURCES` y suma los montos encontrados. Si 2+ fuentes
   suman el total de la factura (dentro de tolerancia), la factura se **divide
   automáticamente** en un `EmailRecord` por cada fuente involucrada — cada
   uno con el monto proporcional que le correspondió y su propio centro de
   costo, pero compartiendo el mismo "Código de Factura" (número de
   comprobante) y los mismos archivos adjuntos, que es como se identifican
   visualmente en el dashboard y en el Excel de exportación como partes de la
   misma factura original. Si solo 1 fuente distinta calza sola con el total,
   la factura se **reasigna** a ese centro de costo sin dividirse. Si no se
   encuentra ninguna combinación, se conserva el resultado original
   (`no_coincide`/`no_encontrado`) para revisión manual.

## `004.2.1` (VTEA / Comercialización de Energía Activa) — sin validación automática

Retirado de `CENTRO_COSTO_COES_SOURCES` el 2026-08-04: la fuente asignada
(dataset `vtea`, `Resumen_cuadros-{mm}{aa}.xlsx`) no es la correcta para este
centro de costo, según indicó el cliente. El código `004.2.1` sigue existiendo
en el catálogo y en los selectores del dashboard (asignación manual), y el
dataset `vtea` sigue siendo navegable manualmente en `/coes` para
verificación — solo se quitó la auto-validación de monto hasta que se
identifique la fuente correcta.

## Centros de costo con validación automática (6 de 10)

| Código | Concepto | Fuente (excel) | Hoja | Notas |
|---|---|---|---|---|
| `004.1.9` | Valorización de Transferencias de Potencia | LVTP (`ReportesLVTP-{mm}{aa}.xlsx`) | `C3` | Dataset `vtp` |
| `004.1.7` | Compensación por Ingreso Tarifario | LVTP (mismo archivo que 004.1.9) | `C2` | Dataset `vtp` — comparte descarga con 004.1.8/004.1.9, solo cambia la hoja |
| `004.1.8` | Liquidación del Peaje de Conexión SPT | LVTP (mismo archivo que 004.1.9) | `C1` | Dataset `vtp` — ídem |
| `004.1.6` | Ingreso Tarifario Red MAT SST & SCT | "Pagos SST y SCT" (`IT {mm}-{aa}.xlsx`) | `Cuadro 2` | Dataset `sst`; portal: `postoperacion/valorizaciontransferencias/pagosstysct` |
| `004.1.11` | Liquidación de SCIO | "Liquidaciones LSCIO" (`3. Liquidación/Cuadro de Liquidación {mm}-{aa}.xlsx`) | `Cuadro 1` | Dataset `scio` (nuevo, 2026-08-04). Alupar/La Virgen aparece como fila (paga), igual patrón que VTP. Informe: `COES/D/DO/SME-INF-125-2026` |

### De dónde sale cada excel (ruta remota en el portal COES)

- **VTP**: `Mercado Mayorista/Liquidaciones del MME/01 Mercado de Corto
  Plazo/Liquidaciones VTP/{AAAA}/{MM}_{MesNombre}/Mensual/{archivo}`
- **SST**: `Post Operación/Valorización de Transferencias/Asignación de
  Responsabilidades de Pago SST y SCT/{AAAA}/{MM} {MESNOMBRE}/Mensual/Ingreso
  Tarifario/IT {MM}-{AA}.xlsx` (carpeta de mes en mayúsculas, ej. `06 JUNIO`)
- **SCIO**: `Mercado Mayorista/Liquidaciones del MME/02 Servicios
  Complementarios e Inflexibilidades Operativas/Liquidaciones
  LSCIO/{AAAA}/{MM} {MesNombre}/3. Liquidación/Cuadro de Liquidación
  {MM}-{AA}.xlsx` (carpeta de mes con mayúscula inicial, ej. `05 Mayo`;
  confirmado por el cliente el 2026-08-04, sin subcarpeta `Mensual/`)
- **VTEA** (dataset todavía sincronizable, sin auto-validación — ver arriba):
  `Mercado Mayorista/Liquidaciones del MME/01 Mercado de Corto
  Plazo/Liquidaciones VTEA/{AAAA}/{MM}_{MesNombre}/Mensual/{archivo}`

COES no siempre publica dentro de la subcarpeta `Mensual/`; el sistema
prueba automáticamente con y sin ella. El archivo descargado se guarda en
almacenamiento propio (`coes/{liquidaciones-vtea|liquidaciones-vtp|pagos-sst-sct|liquidaciones-scio}/{año}/{mes}/...`)
para no tener que volver a pedirlo a COES en cada factura.

## Centros de costo pendientes de validación automática (4 de 10)

Sin fuente/hoja fija en `CENTRO_COSTO_COES_SOURCES` todavía — hoy pueden
validarse igual si se les carga un excel manual (ver sección siguiente); si
no tienen ni fuente automática ni manual, se asignan sin cruce de monto:

| Código | Concepto |
|---|---|
| `004.2.3` | Transferencia de Potencia Firme |
| `004.1.15` | Peaje por Área Demanda |
| `004.1.16` | Peaje por Distribución |
| `004.1.12` | Pagos SST GD REP |

Para activar la validación **automática** (descarga mensual del portal COES)
de cualquiera de estos, hace falta indicar qué excel/hoja usar y agregar una
entrada en `CENTRO_COSTO_COES_SOURCES` (`src/services/centroCostosService.ts`)
— la arquitectura ya soporta que varios centros de costo compartan un mismo
excel leyendo hojas distintas. Mientras eso no exista, la vista de carga
manual (abajo) es la alternativa.

## Carga manual de centros de costo sin fuente automática

Vista `centros-manual.html` (`/api/coes/manual/*`, `src/services/manualCentroCostoService.ts`),
para cubrir con cruce de monto los centros de costo que **no** tienen entrada
en `CENTRO_COSTO_COES_SOURCES` — hoy los 4 de la tabla de arriba, más
`004.2.1` (VTEA, ver sección anterior): la lista de códigos elegibles se
deriva del catálogo en tiempo real (`hasAutoCoesSource`), no es una lista fija.

- **Qué se sube**: un único excel mensual con varias hojas (una por centro de
  costo). El admin sube el archivo, la vista lista las hojas encontradas, y
  por cada centro de costo elige la hoja correspondiente más las columnas de
  nombre de proveedor / RUC / inicio de montos (letras, ej. "A"/"B"/"C") — no
  se asume un layout fijo porque estos centros de costo probablemente vienen
  de reportes COES distintos entre sí. Se puede actualizar solo algunos
  códigos en una carga (los que no se tocan mantienen su última fuente).
- **"Última carga gana"**: a diferencia de las fuentes automáticas (que
  buscan el excel del período/mes de la factura), una fuente manual no tiene
  concepto de período — siempre es la última asignada para ese código
  (`getActiveManualSource`, por `uploadedAt` más reciente). Las facturas
  nuevas de ese centro de costo se validan contra ella desde que se asigna.
- **Revalidación retroactiva**: al asignar una fuente manual nueva, el
  sistema revisa automáticamente las facturas de ese centro de costo
  recibidas en las últimas 4 semanas que hayan quedado sin validar
  (`no_encontrado`/`no_coincide`/sin `coesValidacion`) y reintenta el cruce
  contra la fuente recién cargada (`revalidatePendingManualCentroCosto`) — así
  una carga tardía puede "rescatar" facturas que ya habían llegado.
- **Participan en el split multi-centro**: la reconciliación de facturas que
  pagan más de un centro de costo (regla 6 arriba) recorre también las
  fuentes manuales vigentes junto a las 6 automáticas — una factura puede
  dividirse entre una fuente automática y una manual.
- `coesValidacion.dataset` para estos casos vale `"manual"` (sin `informeCode`,
  ya que no hay concepto de informe COES para un excel cargado a mano).

## Informe COES en el Excel de exportación

El Excel de control de pagos (`POST /exports/excel`,
`src/services/excelExportService.ts`) incluye una columna "Informe COES"
justo después de las dos columnas "Centro de Costo", con el código del
informe (ej. `COES/D/DO/SME-INF-125-2026`) que respalda la validación de esa
fila. El código se lee del propio excel COES ya sincronizado (celda indexada
por `indexCoesFile`/`INFORME_CELL` en `coesService.ts`), no del texto de la
factura del proveedor.
