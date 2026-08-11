import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { ExtractedFields, CoesValidacion, EmailRecord } from "../types";
import { normalizeText } from "../utils/classifier";
import { BlobStorageService } from "./blobStorage";
import { RecordRepository } from "./repository";
import { broadcastDocumentUpdated, broadcastNewDocument } from "./realtime";
import {
	CoesDataset,
	CoesSyncPeriod,
	extractInformeCode,
	extractPeriodFromText,
	findCoesIndexEntryForPeriod,
	getExpectedStoragePath,
	shiftPeriod,
	syncCoesMonthlyDataset,
} from "./coesService";
import { getActiveManualSource, listActiveManualSources } from "./manualCentroCostoService";

// TODO: completar con el RUC real de Alupar antes de confiar en produccion.
const ALUPAR_RUC = "20492925030";

// Los centros de costo sin fuente COES automatica pueden tener una fuente
// cargada manualmente (ver manualCentroCostoService.ts) -- "manual" se usa
// como etiqueta de dataset en esos casos (informativa, nunca dispara
// sync remoto ni busca layout en SHEET_LAYOUT_OVERRIDES).
export type CentroCostoSourceDataset = CoesDataset | "manual";

interface CentroCostoCoesSource {
	dataset: CoesDataset;
	sheet: string;
}

// Clave = codigo de CENTRO_COSTOS_CATALOG (centroCostosCatalog.ts). Cada
// centro de costo con validacion COES tiene su propia fuente (dataset+hoja):
// varios centros de costo pueden compartir el mismo dataset/excel (ej. LVTP)
// pero leer hojas distintas. Agregar un centro de costo nuevo es solo agregar
// una entrada aqui, una vez se conozca su fuente/hoja.
// 004.2.1 (VTEA/Energia Activa) fue retirado deliberadamente el 2026-08-04: la
// fuente "vtea" asignada no es la correcta para ese centro de costo (indicado
// por el cliente). Sigue siendo asignable manualmente desde el dashboard y
// navegable en /coes para verificacion manual; solo se quito de aqui para que
// deje de intentar auto-validarse contra un excel que no le corresponde.
const CENTRO_COSTO_COES_SOURCES: Record<string, CentroCostoCoesSource> = {
	"004.1.9": { dataset: "vtp", sheet: "C3" },
	"004.1.7": { dataset: "vtp", sheet: "C2" },
	"004.1.8": { dataset: "vtp", sheet: "C1" },
	"004.1.6": { dataset: "sst", sheet: "Cuadro 2" },
	"004.1.11": { dataset: "scio", sheet: "Cuadro 1" },
};

// Un codigo con fuente automatica no deberia poder ademas tener una carga
// manual (la automatica siempre gana) -- usado por routes.ts para filtrar los
// codigos elegibles para carga manual sin duplicar CENTRO_COSTO_COES_SOURCES.
export function hasAutoCoesSource(centroCostoCode: string): boolean {
	return centroCostoCode in CENTRO_COSTO_COES_SOURCES;
}

// Exportada para que manualCentroCostoService.ts pueda tipar el layout que el
// admin define al subir un excel manual (nombre/RUC/inicio de montos por columna).
export interface SheetLayout {
	nameColumn: number; // columna con el nombre del proveedor (filas)
	supplierColumn: number; // columna con el RUC del proveedor (filas)
	dataStartColumn: number; // primera columna con montos / RUCs de cabecera (columnas)
}

// Layout mas comun entre las hojas COES ya soportadas (VTEA CUADRO 1, VTP C3):
// columna B = nombre, columna C = RUC, columna D en adelante = montos.
const DEFAULT_SHEET_LAYOUT: SheetLayout = { nameColumn: 2, supplierColumn: 3, dataStartColumn: 4 };

// No todas las hojas siguen el layout por defecto -- diagnosticado el
// 2026-08-02 comparando el dump real de cada hoja: SST "Cuadro 2" tiene todo
// corrido una columna a la izquierda (nombre en A, RUC en B, montos desde C).
// Clave: "{dataset}::{sheetName}" (el mismo sheet name usado en
// CENTRO_COSTO_COES_SOURCES).
const SHEET_LAYOUT_OVERRIDES: Record<string, SheetLayout> = {
	"sst::Cuadro 2": { nameColumn: 1, supplierColumn: 2, dataStartColumn: 3 },
	// Verificado abriendo observaciones/2_Cuadro de Liquidacion 06-26 _inf
	// 125-2026.xlsx, hoja "Cuadro 1": mismo layout que SST (nombre en A, RUC en
	// B, montos desde C); fila de RUC de cabecera detectada en la fila 7.
	"scio::Cuadro 1": { nameColumn: 1, supplierColumn: 2, dataStartColumn: 3 },
};

function sheetLayoutFor(dataset: CoesDataset, sheetName: string): SheetLayout {
	return SHEET_LAYOUT_OVERRIDES[`${dataset}::${sheetName}`] ?? DEFAULT_SHEET_LAYOUT;
}

const AMOUNT_TOLERANCE = 0.01;
const IGV_RATE = 0.18; // el monto de la factura incluye IGV; el excel COES reporta montos sin IGV

// Resultado de buscar el RUC de un proveedor en una fuente COES concreta
// (usado tanto para el cruce simple como para la reconciliacion multi-fuente).
export interface CentroCostoMatch {
	centroCostoCode: string;
	dataset: CentroCostoSourceDataset;
	sheet: string;
	informeCode?: string;
	montoEsperadoSinIgv: number;
}

export interface CentroCostosResult {
	coesValidacion?: CoesValidacion;
	// La reconciliacion encontro una unica fuente distinta a la asignada
	// originalmente que calza con el monto completo -- se reasigna sin dividir.
	reassignedCentroCostoCode?: string;
	// La reconciliacion encontro 2+ fuentes cuyos montos suman el total de la
	// factura -- el llamador (routes.ts) debe generar un EmailRecord por match.
	splitMatches?: CentroCostoMatch[];
}

export interface CoesMatrixColumn {
	col: number;
	ruc: string;
	name: string;
}

export interface CoesMatrixRow {
	row: number;
	ruc: string;
	name: string;
	values: Record<number, number | undefined>;
}

export interface CoesMatrix {
	dataset: CentroCostoSourceDataset;
	sheetName: string;
	columns: CoesMatrixColumn[];
	rows: CoesMatrixRow[];
	// Alupar puede aparecer como "PARA" (columna, cobra) o como "DE" (fila, paga)
	// segun el dataset y el periodo -- ej. en VTEA Alupar factura (cobra, columna);
	// en VTP a Alupar le facturan (paga, fila). Por eso se exponen ambas posiciones.
	aluparColumn?: number;
	aluparRow?: number;
}

function cellToString(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "object") {
		const text = (value as any).text ?? (value as any).result;
		return text != null ? String(text).trim() : "";
	}
	return String(value).trim();
}

const RUC_PATTERN = /^\d{11}$/;

function isValidRuc(value: string): boolean {
	return RUC_PATTERN.test(value);
}

function formatMonto(value: number): string {
	return value.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// El informe COES de un periodo (ej. abril) se publica/liquida recien al mes
// siguiente, por lo que la fecha de emision de la factura suele caer un mes
// despues del periodo que realmente hay que validar (factura emitida en mayo
// -> informe de abril). Se parsea fechaEmision (ISO o DD/MM/YYYY) y se resta 1 mes.
function parseFechaEmisionPeriod(fechaEmision: string | undefined | null): CoesSyncPeriod | undefined {
	if (!fechaEmision) return undefined;

	const isoMatch = fechaEmision.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (isoMatch) {
		const year = Number(isoMatch[1]);
		const month = Number(isoMatch[2]);
		if (Number.isFinite(year) && month >= 1 && month <= 12) {
			return shiftPeriod({ year, month }, -1);
		}
	}

	const dmyMatch = fechaEmision.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/);
	if (dmyMatch) {
		const month = Number(dmyMatch[2]);
		let year = Number(dmyMatch[3]);
		if (year < 100) year += 2000;
		if (Number.isFinite(year) && month >= 1 && month <= 12) {
			return shiftPeriod({ year, month }, -1);
		}
	}

	return undefined;
}

function cellToNumber(value: unknown): number | undefined {
	if (value == null) return undefined;
	if (typeof value === "number") return value;
	const text = cellToString(value).replace(/[^\d.,-]/g, "").replace(",", ".");
	const num = Number(text);
	return Number.isFinite(num) ? num : undefined;
}

// Algunas hojas (ej. "CUADRO 1" de VTEA) son una sola tabla gigante partida en
// varios bloques apilados verticalmente (cada uno con su propio header "DE"/"RUC")
// para que entre en una pagina impresa -- no son periodos ni conceptos distintos.
// Cada bloque repite la misma lista de proveedores (filas) pero con un tramo
// distinto de empresas en las columnas, asi que hay que unir todos los bloques:
// las columnas se concatenan (con un id global propio, no el numero de columna
// de la hoja, que se repite entre bloques) y las filas se combinan por RUC.
// La fila "RUC" de etiqueta puede estar en la misma fila que los RUCs de
// cabecera (VTEA) o una fila arriba (VTP) -- en vez de buscar ese texto literal,
// se detecta el patron: una fila que NO es una fila de datos (su columna de RUC
// no es un RUC valido) pero que tiene varios RUCs validos en las columnas de
// datos. Se escanea desde la fila 1 (no una fila fija) porque esa fila de
// cabecera cambia de posicion segun la hoja (ej. VTP C2 la tiene en la fila 8,
// no la 9).
function findBlockHeaderRows(sheet: ExcelJS.Worksheet, lastRow: number, lastCol: number, layout: SheetLayout): number[] {
	const { supplierColumn, dataStartColumn } = layout;
	const headerRows: number[] = [];
	for (let r = 1; r <= lastRow; r++) {
		const supplierCell = cellToString(sheet.getRow(r).getCell(supplierColumn).value);
		if (isValidRuc(supplierCell)) continue;
		let validCount = 0;
		for (let c = dataStartColumn; c <= lastCol; c++) {
			if (isValidRuc(cellToString(sheet.getRow(r).getCell(c).value))) validCount++;
		}
		if (validCount >= 2) headerRows.push(r);
	}
	return headerRows;
}

export function buildMatrixFromSheet(sheet: ExcelJS.Worksheet, dataset: CentroCostoSourceDataset, layout: SheetLayout): CoesMatrix {
	const { nameColumn, supplierColumn, dataStartColumn } = layout;
	const lastCol = sheet.columnCount;
	const lastRow = sheet.rowCount;
	const headerRows = findBlockHeaderRows(sheet, lastRow, lastCol, layout);

	const columns: CoesMatrixColumn[] = [];
	const rowsByRuc = new Map<string, CoesMatrixRow>();
	let nextColumnId = 0;

	for (let i = 0; i < headerRows.length; i++) {
		const headerRow = headerRows[i];
		// El bloque termina donde empieza el siguiente header (si lo hay) -- evita
		// que la busqueda de filas de datos se cuele en el bloque siguiente.
		const blockEnd = i + 1 < headerRows.length ? headerRows[i + 1] - 1 : lastRow;

		const blockColumns: Array<{ sheetCol: number; id: number }> = [];
		for (let c = dataStartColumn; c <= lastCol; c++) {
			const ruc = cellToString(sheet.getRow(headerRow).getCell(c).value);
			if (!isValidRuc(ruc)) continue;
			const name = cellToString(sheet.getRow(headerRow - 1).getCell(c).value);
			const id = nextColumnId++;
			columns.push({ col: id, ruc, name });
			blockColumns.push({ sheetCol: c, id });
		}

		// Entre la fila de cabecera y los datos reales puede haber filas de
		// subcategoria (ej. VTP C1/C2 traen 2 filas de sub-etiquetas antes de la
		// primera fila de datos) -- se saltan mientras los datos aun no
		// empezaron. Una vez que empiezan, se asume contiguos como antes: la
		// primera fila sin RUC valido despues de haber leido datos cierra el
		// bloque.
		let dataStarted = false;
		for (let r = headerRow + 1; r <= blockEnd; r++) {
			const ruc = cellToString(sheet.getRow(r).getCell(supplierColumn).value);
			if (!isValidRuc(ruc)) {
				if (dataStarted) break;
				continue;
			}
			dataStarted = true;
			const name = cellToString(sheet.getRow(r).getCell(nameColumn).value);
			let rowRecord = rowsByRuc.get(ruc);
			if (!rowRecord) {
				rowRecord = { row: r, ruc, name, values: {} };
				rowsByRuc.set(ruc, rowRecord);
			}
			for (const bc of blockColumns) {
				rowRecord.values[bc.id] = cellToNumber(sheet.getRow(r).getCell(bc.sheetCol).value);
			}
		}
	}

	const rows = Array.from(rowsByRuc.values());
	const aluparColumn = columns.find((c) => c.ruc === ALUPAR_RUC)?.col;
	const aluparRow = rows.find((r) => r.ruc === ALUPAR_RUC)?.row;

	return { dataset, sheetName: sheet.name, columns, rows, aluparColumn, aluparRow };
}

// El excel de VTP trae ~19 hojas y exceljs parsea el libro completo aunque solo
// usemos una -- cachear la matriz ya resuelta evita volver a parsearlo cada vez
// que el usuario alterna entre dataset/periodo en la vista web.
const matrixCache = new Map<string, CoesMatrix>();

// El layout se pasa explicito (en vez de resolverse internamente via
// sheetLayoutFor) para poder reutilizar esta funcion tanto con datasets
// automaticos (layout fijo en SHEET_LAYOUT_OVERRIDES) como con fuentes
// manuales (layout definido por el admin al subir el excel, sin entrada en
// SHEET_LAYOUT_OVERRIDES) -- ver manualCentroCostoService.ts.
export async function loadCoesMatrix(
	dataset: CentroCostoSourceDataset,
	sheetName: string,
	storagePath: string,
	layout: SheetLayout,
	blobStorage: BlobStorageService
): Promise<CoesMatrix | undefined> {
	// Un mismo storagePath (ej. el excel LVTP) puede leerse con hojas distintas
	// (C1/C2/C3) segun el centro de costo -- la clave de cache debe incluir la
	// hoja para no devolver la matriz de otra hoja ya cacheada.
	const cacheKey = `${storagePath}::${sheetName}`;
	const cached = matrixCache.get(cacheKey);
	if (cached) return cached;

	const buffer = await blobStorage.readBuffer(storagePath);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer as any);
	const sheet = workbook.getWorksheet(sheetName);
	if (!sheet) return undefined;
	const matrix = buildMatrixFromSheet(sheet, dataset, layout);
	matrixCache.set(cacheKey, matrix);
	return matrix;
}

function noEncontrado(dataset: CentroCostoSourceDataset, montoFactura: number, informeCode: string | undefined, detalle: string): CoesValidacion {
	return { dataset, informeCode, montoFactura, status: "no_encontrado", detalle };
}

// Busca el monto cruzado Alupar x RUC proveedor en una matriz ya cargada.
// Extraida de crossCheckAmount para reutilizarla en la reconciliacion
// multi-fuente (collectReconciliationCandidates), que necesita el mismo cruce
// pero sobre varias matrices distintas sin construir un CoesValidacion cada vez.
export function findMontoEsperado(matrix: CoesMatrix, supplierRuc: string): number | undefined {
	// Caso A: Alupar cobra (columna) y el proveedor paga (fila) -- ej. VTP.
	if (matrix.aluparColumn !== undefined) {
		const supplierRow = matrix.rows.find((r) => r.ruc === supplierRuc);
		const monto = supplierRow?.values[matrix.aluparColumn];
		if (monto !== undefined) return monto;
	}

	// Caso B: el proveedor cobra (columna) y Alupar paga (fila) -- ej. SCIO/SST.
	if (matrix.aluparRow !== undefined) {
		const supplierColumn = matrix.columns.find((c) => c.ruc === supplierRuc);
		const aluparRowData = matrix.rows.find((r) => r.row === matrix.aluparRow);
		const monto = supplierColumn ? aluparRowData?.values[supplierColumn.col] : undefined;
		if (monto !== undefined) return monto;
	}

	return undefined;
}

async function crossCheckAmount(
	dataset: CoesDataset,
	sheetName: string,
	storagePath: string,
	supplierRuc: string,
	montoFactura: number,
	informeCode: string | undefined,
	blobStorage: BlobStorageService
): Promise<CoesValidacion> {
	return crossCheckAmountWithLayout(dataset, sheetName, storagePath, sheetLayoutFor(dataset, sheetName), supplierRuc, montoFactura, informeCode, blobStorage);
}

// Variante con layout explicito (en vez de resuelto via sheetLayoutFor, que
// solo conoce los layouts fijos de SHEET_LAYOUT_OVERRIDES) -- la usan tanto
// crossCheckAmount (datasets automaticos) como resolveCentroCostos para
// fuentes manuales, cuyo layout lo define el admin al subir el excel.
export async function crossCheckAmountWithLayout(
	dataset: CentroCostoSourceDataset,
	sheetName: string,
	storagePath: string,
	layout: SheetLayout,
	supplierRuc: string,
	montoFactura: number,
	informeCode: string | undefined,
	blobStorage: BlobStorageService
): Promise<CoesValidacion> {
	const matrix = await loadCoesMatrix(dataset, sheetName, storagePath, layout, blobStorage);
	if (!matrix) {
		return noEncontrado(dataset, montoFactura, informeCode, `No se encontro la hoja "${sheetName}" en el excel COES.`);
	}

	const montoSinIgv = montoFactura / (1 + IGV_RATE);
	const montoEsperado = findMontoEsperado(matrix, supplierRuc);

	if (montoEsperado !== undefined) {
		const coincide = Math.abs(montoEsperado - montoSinIgv) <= AMOUNT_TOLERANCE;
		return {
			dataset,
			informeCode,
			montoFactura,
			montoEsperado,
			status: coincide ? "validado" : "no_coincide",
			detalle: coincide
				? `Monto sin IGV (${formatMonto(montoSinIgv)}) coincide con el excel COES (${formatMonto(montoEsperado)}).`
				: `Monto de factura sin IGV (${formatMonto(montoSinIgv)}) no coincide con el excel COES (${formatMonto(montoEsperado)}).`,
		};
	}

	if (matrix.aluparColumn === undefined && matrix.aluparRow === undefined) {
		return noEncontrado(dataset, montoFactura, informeCode, `No se encontro el RUC de Alupar (ni como cobrador ni como pagador) en la hoja "${matrix.sheetName}".`);
	}

	return noEncontrado(dataset, montoFactura, informeCode, `No se encontro el RUC del proveedor (${supplierRuc}) cruzado con Alupar en la hoja "${matrix.sheetName}".`);
}

// Recorre todas las fuentes COES mapeadas (automaticas + manuales vigentes)
// buscando el RUC del proveedor, para la reconciliacion multi-centro de costo
// (facturas que pagan mas de un centro de costo a la vez). Sincroniza cada
// dataset+periodo automatico bajo demanda (se apoya en el cache de
// syncCoesMonthlyDataset/loadCoesMatrix, asi que no repite trabajo si el
// cross-check original ya sincronizo la fuente principal); las fuentes
// manuales no se sincronizan (su storagePath ya esta resuelto).
async function collectReconciliationCandidates(
	supplierRuc: string,
	period: CoesSyncPeriod,
	blobStorage: BlobStorageService
): Promise<CentroCostoMatch[]> {
	const candidates: CentroCostoMatch[] = [];
	for (const [code, source] of Object.entries(CENTRO_COSTO_COES_SOURCES)) {
		const sync = await syncCoesMonthlyDataset(source.dataset, period, blobStorage).catch(() => undefined);
		if (!sync?.storagePath) continue;
		const matrix = await loadCoesMatrix(source.dataset, source.sheet, sync.storagePath, sheetLayoutFor(source.dataset, source.sheet), blobStorage);
		if (!matrix) continue;
		const monto = findMontoEsperado(matrix, supplierRuc);
		if (monto === undefined) continue;
		const indexEntry = await findCoesIndexEntryForPeriod(source.dataset, period, blobStorage).catch(() => undefined);
		candidates.push({
			centroCostoCode: code,
			dataset: source.dataset,
			sheet: source.sheet,
			informeCode: indexEntry?.informeCode,
			montoEsperadoSinIgv: monto,
		});
	}

	const manualSources = await listActiveManualSources(blobStorage);
	for (const manual of manualSources) {
		// Un codigo con fuente automatica no deberia tener tambien una manual
		// (assignManualMappings lo rechaza), pero por seguridad la automatica
		// gana si ambas existieran para el mismo codigo.
		if (CENTRO_COSTO_COES_SOURCES[manual.centroCostoCode]) continue;
		const matrix = await loadCoesMatrix("manual", manual.sheet, manual.storagePath, manual.layout, blobStorage);
		if (!matrix) continue;
		const monto = findMontoEsperado(matrix, supplierRuc);
		if (monto === undefined) continue;
		candidates.push({
			centroCostoCode: manual.centroCostoCode,
			dataset: "manual",
			sheet: manual.sheet,
			informeCode: undefined,
			montoEsperadoSinIgv: monto,
		});
	}

	return candidates;
}

// Fuerza bruta sobre subconjuntos de candidatos (<=6 fuentes hoy, 2^n trivial):
// busca la combinacion cuya suma calza con el monto objetivo dentro de
// tolerancia, priorizando la de menos fuentes y, entre empates, la de menor
// diferencia absoluta.
function findCombinationMatchingTotal(
	candidates: CentroCostoMatch[],
	target: number,
	tolerance: number
): CentroCostoMatch[] | undefined {
	let best: { combo: CentroCostoMatch[]; diff: number } | undefined;
	const n = candidates.length;
	for (let mask = 1; mask < 1 << n; mask++) {
		let sum = 0;
		const combo: CentroCostoMatch[] = [];
		for (let i = 0; i < n; i++) {
			if (mask & (1 << i)) {
				sum += candidates[i].montoEsperadoSinIgv;
				combo.push(candidates[i]);
			}
		}
		const diff = Math.abs(sum - target);
		if (diff > tolerance) continue;
		if (!best || combo.length < best.combo.length || (combo.length === best.combo.length && diff < best.diff)) {
			best = { combo, diff };
		}
	}
	return best?.combo;
}

// El codigo de centro de costo ya viene resuelto por el catalogo
// (resolveCentroCostosCode, via keywords sobre concepto/snippet) -- se reusa
// esa misma resolucion en vez de hacer un segundo matching de keywords
// independiente para decidir el dataset COES, que podia divergir del
// catalogo (ver CENTRO_COSTO_COES_SOURCES). Los codigos sin fuente
// configurada (peajes, SCIO, GD REP, potencia firme, mientras no se
// especifiquen) quedan sin coesValidacion, para asignacion/verificacion
// manual desde el dashboard.
export async function resolveCentroCostos(
	centroCostoCode: string | undefined,
	extracted: ExtractedFields,
	blobStorage = new BlobStorageService()
): Promise<CentroCostosResult> {
	if (!centroCostoCode) return {};

	const autoSource = CENTRO_COSTO_COES_SOURCES[centroCostoCode];
	// Un codigo sin fuente automatica puede tener una fuente cargada
	// manualmente (ver manualCentroCostoService.ts) -- se prueba solo si no hay
	// fuente automatica, que siempre tiene prioridad.
	const manualSource = autoSource ? undefined : await getActiveManualSource(centroCostoCode, blobStorage);
	if (!autoSource && !manualSource) return {};

	const montoFactura = extracted.monto ?? 0;
	const supplierRuc = extracted.ruc ?? "";

	// El periodo a validar se determina por la fecha de emision de la factura
	// (informe del mes anterior), no por el ultimo informe sincronizado: una
	// factura de mayo debe validarse contra el informe de abril aunque ya
	// tengamos sincronizado el de mayo. Si fechaEmision no es parseable, se cae
	// al periodo extraido del texto del concepto como respaldo. Las fuentes
	// manuales no usan el periodo para resolver su propio archivo (siempre es
	// "la ultima carga vigente"), pero igual se necesita para que reconcile()
	// pueda buscar en las fuentes automaticas si hace falta dividir la factura.
	const period = parseFechaEmisionPeriod(extracted.fechaEmision) ?? extractPeriodFromText(extracted.concepto ?? extracted.rawTextSnippet);

	if (!period) {
		return {
			coesValidacion: noEncontrado(
				autoSource ? autoSource.dataset : "manual",
				montoFactura,
				extractInformeCode(extracted.concepto ?? extracted.rawTextSnippet),
				"No se pudo determinar el periodo (mes/año) a validar a partir de la fecha de emision ni del concepto de la factura."
			),
		};
	}

	// Facturas que pagan mas de un centro de costo a la vez: si la fuente
	// principal no calza (o directamente no se encuentra), se busca el RUC del
	// proveedor en las demas fuentes ya mapeadas y se suman montos hasta calzar
	// con el total de la factura. 2+ fuentes que suman -> se pide al llamador
	// (routes.ts) que divida la factura en un EmailRecord por fuente. 1 sola
	// fuente distinta que calza sola -> se reasigna el centro de costo sin
	// dividir. Si no hay combinacion, se conserva el resultado original.
	const reconcile = async (fallback: CoesValidacion): Promise<CentroCostosResult> => {
		const candidates = await collectReconciliationCandidates(supplierRuc, period, blobStorage);
		const montoSinIgv = montoFactura / (1 + IGV_RATE);
		const combo = findCombinationMatchingTotal(candidates, montoSinIgv, AMOUNT_TOLERANCE);

		if (combo && combo.length >= 2) {
			return { splitMatches: combo };
		}

		if (combo && combo.length === 1 && combo[0].centroCostoCode !== centroCostoCode) {
			return {
				reassignedCentroCostoCode: combo[0].centroCostoCode,
				coesValidacion: {
					dataset: combo[0].dataset,
					informeCode: combo[0].informeCode,
					montoFactura,
					montoEsperado: combo[0].montoEsperadoSinIgv,
					status: "validado",
					detalle: `Reconciliado: el RUC del proveedor calzo en ${combo[0].centroCostoCode} en vez del centro de costo asignado originalmente (${centroCostoCode}).`,
				},
			};
		}

		return { coesValidacion: fallback };
	};

	// Fuente manual: no hay periodo/sync remoto que resolver, el storagePath ya
	// esta fijo en el indice manual ("la ultima carga es la vigente").
	if (manualSource) {
		try {
			const coesValidacion = await crossCheckAmountWithLayout(
				"manual",
				manualSource.sheet,
				manualSource.storagePath,
				manualSource.layout,
				supplierRuc,
				montoFactura,
				undefined,
				blobStorage
			);
			if (coesValidacion.status === "no_coincide" || coesValidacion.status === "no_encontrado") {
				return reconcile(coesValidacion);
			}
			return { coesValidacion };
		} catch (err) {
			return reconcile(noEncontrado("manual", montoFactura, undefined, `Error validando contra el excel manual (${manualSource.fileName}): ${err instanceof Error ? err.message : String(err)}`));
		}
	}

	const { dataset, sheet } = autoSource!;

	let storagePath: string | undefined;
	try {
		const result = await syncCoesMonthlyDataset(dataset, period, blobStorage);
		if (result.status === "not_available" || !result.storagePath) {
			return reconcile(noEncontrado(dataset, montoFactura, undefined, `No se encontro el excel COES para ${dataset.toUpperCase()} ${period.month}/${period.year}.`));
		}
		storagePath = result.storagePath;
	} catch (err) {
		return reconcile(noEncontrado(dataset, montoFactura, undefined, `Error buscando el excel COES en COES para ${period.month}/${period.year}: ${err instanceof Error ? err.message : String(err)}`));
	}

	// El informe COES se resuelve desde el indice ya poblado al sincronizar el
	// excel (indexCoesFile lee la celda del propio workbook), no del texto de la
	// factura del proveedor (que casi nunca trae el codigo interno de COES) --
	// se mantiene extractInformeCode como respaldo por si el excel no se pudo indexar.
	const indexEntry = await findCoesIndexEntryForPeriod(dataset, period, blobStorage).catch(() => undefined);
	const informeCode = indexEntry?.informeCode ?? extractInformeCode(extracted.concepto ?? extracted.rawTextSnippet);

	try {
		const coesValidacion = await crossCheckAmount(dataset, sheet, storagePath, supplierRuc, montoFactura, informeCode, blobStorage);
		if (coesValidacion.status === "no_coincide" || coesValidacion.status === "no_encontrado") {
			return reconcile(coesValidacion);
		}
		return { coesValidacion };
	} catch (err) {
		return reconcile(noEncontrado(dataset, montoFactura, informeCode, `Error validando contra excel COES: ${err instanceof Error ? err.message : String(err)}`));
	}
}

// Arma un EmailRecord por cada fuente involucrada en una factura que paga mas
// de un centro de costo a la vez (splitMatches de CentroCostosResult). El
// primer match reusa el id de "base" (evita dejar un id huerfano); el resto
// recibe un id nuevo. Se reutiliza tanto en el intake (routes.ts, factura
// recien recibida) como en la revalidacion retroactiva (mas abajo, factura ya
// guardada que ahora si calza dividida al cargarse un excel manual nuevo).
export function buildSplitEmailRecords(base: EmailRecord, splitMatches: CentroCostoMatch[]): EmailRecord[] {
	return splitMatches.map((match, i) => {
		const montoConIgv = Number((match.montoEsperadoSinIgv * 1.18).toFixed(2));
		return {
			...base,
			id: i === 0 ? base.id : randomUUID(),
			extracted: { ...base.extracted, monto: montoConIgv },
			centroCostos: match.centroCostoCode,
			coesValidacion: {
				dataset: match.dataset,
				informeCode: match.informeCode,
				montoFactura: montoConIgv,
				montoEsperado: match.montoEsperadoSinIgv,
				status: "validado",
				detalle: `Factura dividida automaticamente entre ${splitMatches.length} centros de costo (mismo Codigo de Factura, RUC ${base.extracted.ruc ?? ""}); esta parte corresponde a ${match.centroCostoCode}${match.informeCode ? ` (informe ${match.informeCode})` : ""}.`,
			},
		};
	});
}

// Al subir/asignar un excel manual nuevo para un centro de costo, se revisan
// las facturas ya recibidas de ese codigo en las ultimas `lookbackWeeks`
// semanas que hayan quedado sin validar (no_encontrado/no_coincide/sin
// coesValidacion) y se reintenta la validacion contra la fuente recien
// activada -- asi no hace falta esperar a la proxima factura para que la
// carga manual "rescate" facturas ya pendientes.
export async function revalidatePendingManualCentroCosto(
	centroCostoCode: string,
	repository: RecordRepository,
	blobStorage: BlobStorageService,
	lookbackWeeks = 4
): Promise<{ checked: number; updated: number; split: number }> {
	const cutoff = new Date(Date.now() - lookbackWeeks * 7 * 24 * 60 * 60 * 1000);
	const all = await repository.list();
	const candidates = all.filter(
		(r) =>
			r.centroCostos === centroCostoCode &&
			(!r.coesValidacion || r.coesValidacion.status !== "validado") &&
			new Date(r.createdAt) >= cutoff
	);

	let updated = 0;
	let split = 0;
	for (const record of candidates) {
		const result = await resolveCentroCostos(record.centroCostos, record.extracted, blobStorage).catch(() => undefined);
		if (!result) continue;

		if (result.splitMatches && result.splitMatches.length >= 2) {
			for (const r of buildSplitEmailRecords(record, result.splitMatches)) {
				await repository.save(r);
				if (r.id === record.id) {
					broadcastDocumentUpdated(r);
				} else {
					broadcastNewDocument(r);
				}
			}
			split++;
			continue;
		}

		const nextCentroCostos = result.reassignedCentroCostoCode ?? record.centroCostos;
		if (result.coesValidacion && (result.coesValidacion.status !== record.coesValidacion?.status || nextCentroCostos !== record.centroCostos)) {
			const updatedRecord: EmailRecord = { ...record, centroCostos: nextCentroCostos, coesValidacion: result.coesValidacion };
			await repository.save(updatedRecord);
			broadcastDocumentUpdated(updatedRecord);
			updated++;
		}
	}

	return { checked: candidates.length, updated, split };
}

// --- Vista web: matriz completa + verificacion manual por periodo --------------

export async function getCoesMatrixForPeriod(
	dataset: CoesDataset,
	sheet: string,
	period: CoesSyncPeriod,
	blobStorage = new BlobStorageService()
): Promise<CoesMatrix | undefined> {
	const storagePath = getExpectedStoragePath(dataset, period);
	const exists = await blobStorage.exists(storagePath);
	if (!exists) return undefined;
	return loadCoesMatrix(dataset, sheet, storagePath, sheetLayoutFor(dataset, sheet), blobStorage);
}

export async function verifyCoesAmountForPeriod(
	dataset: CoesDataset,
	sheet: string,
	period: CoesSyncPeriod,
	supplierRuc: string,
	montoFactura: number,
	blobStorage = new BlobStorageService()
): Promise<CoesValidacion> {
	const storagePath = getExpectedStoragePath(dataset, period);
	const exists = await blobStorage.exists(storagePath);
	if (!exists) {
		return noEncontrado(dataset, montoFactura, undefined, `No se encontro el excel COES para ${dataset.toUpperCase()} ${period.month}/${period.year}.`);
	}
	return crossCheckAmount(dataset, sheet, storagePath, supplierRuc, montoFactura, undefined, blobStorage);
}
