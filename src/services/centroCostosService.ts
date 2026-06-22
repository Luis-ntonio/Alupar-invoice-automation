import ExcelJS from "exceljs";
import { ExtractedFields, CoesValidacion } from "../types";
import { normalizeText } from "../utils/classifier";
import { BlobStorageService } from "./blobStorage";
import { CoesDataset, CoesSyncPeriod, extractInformeCode, findCoesIndexEntry, getExpectedStoragePath } from "./coesService";

// TODO: completar con el RUC real de Alupar antes de confiar en produccion.
const ALUPAR_RUC = "20492925030";

const DATASET_SHEET: Record<CoesDataset, string> = {
	vtea: "CUADRO 1",
	vtp: "C3",
};

const RUC_ROW = 9; // fila donde se busca el RUC de Alupar (a lo largo de las columnas)
const NAME_COLUMN = 2; // columna B: nombre del proveedor (filas)
const SUPPLIER_COLUMN = 3; // columna C: RUC del proveedor (filas)
const DATA_START_COLUMN = 4; // columna D: inicio de los montos
const AMOUNT_TOLERANCE = 0.01;

export interface CentroCostosResult {
	centroCostos?: string;
	coesValidacion?: CoesValidacion;
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
	dataset: CoesDataset;
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
// se detecta el patron: una fila que NO es una fila de datos (su columna C no es
// un RUC valido) pero que tiene varios RUCs validos en las columnas D+.
function findBlockHeaderRows(sheet: ExcelJS.Worksheet, lastRow: number, lastCol: number): number[] {
	const headerRows: number[] = [];
	for (let r = RUC_ROW; r <= lastRow; r++) {
		const supplierCell = cellToString(sheet.getRow(r).getCell(SUPPLIER_COLUMN).value);
		if (isValidRuc(supplierCell)) continue;
		let validCount = 0;
		for (let c = DATA_START_COLUMN; c <= lastCol; c++) {
			if (isValidRuc(cellToString(sheet.getRow(r).getCell(c).value))) validCount++;
		}
		if (validCount >= 2) headerRows.push(r);
	}
	return headerRows;
}

function buildMatrixFromSheet(sheet: ExcelJS.Worksheet, dataset: CoesDataset): CoesMatrix {
	const lastCol = sheet.columnCount;
	const lastRow = sheet.rowCount;
	const headerRows = findBlockHeaderRows(sheet, lastRow, lastCol);

	const columns: CoesMatrixColumn[] = [];
	const rowsByRuc = new Map<string, CoesMatrixRow>();
	let nextColumnId = 0;

	for (const headerRow of headerRows) {
		const blockColumns: Array<{ sheetCol: number; id: number }> = [];
		for (let c = DATA_START_COLUMN; c <= lastCol; c++) {
			const ruc = cellToString(sheet.getRow(headerRow).getCell(c).value);
			if (!isValidRuc(ruc)) continue;
			const name = cellToString(sheet.getRow(headerRow - 1).getCell(c).value);
			const id = nextColumnId++;
			columns.push({ col: id, ruc, name });
			blockColumns.push({ sheetCol: c, id });
		}

		for (let r = headerRow + 1; r <= lastRow; r++) {
			const ruc = cellToString(sheet.getRow(r).getCell(SUPPLIER_COLUMN).value);
			if (!isValidRuc(ruc)) break;
			const name = cellToString(sheet.getRow(r).getCell(NAME_COLUMN).value);
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

async function loadCoesMatrix(
	dataset: CoesDataset,
	storagePath: string,
	blobStorage: BlobStorageService
): Promise<CoesMatrix | undefined> {
	const cached = matrixCache.get(storagePath);
	if (cached) return cached;

	const sheetName = DATASET_SHEET[dataset];
	const buffer = await blobStorage.readBuffer(storagePath);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer as any);
	const sheet = workbook.getWorksheet(sheetName);
	if (!sheet) return undefined;
	const matrix = buildMatrixFromSheet(sheet, dataset);
	matrixCache.set(storagePath, matrix);
	return matrix;
}

function noEncontrado(dataset: CoesDataset, montoFactura: number, informeCode: string | undefined, detalle: string): CoesValidacion {
	return { dataset, informeCode, montoFactura, status: "no_encontrado", detalle };
}

async function crossCheckAmount(
	dataset: CoesDataset,
	storagePath: string,
	supplierRuc: string,
	montoFactura: number,
	informeCode: string | undefined,
	blobStorage: BlobStorageService
): Promise<CoesValidacion> {
	const matrix = await loadCoesMatrix(dataset, storagePath, blobStorage);
	if (!matrix) {
		return noEncontrado(dataset, montoFactura, informeCode, `No se encontro la hoja "${DATASET_SHEET[dataset]}" en el excel COES.`);
	}

	const buildResult = (montoEsperado: number): CoesValidacion => {
		const coincide = Math.abs(montoEsperado - montoFactura) <= AMOUNT_TOLERANCE;
		return {
			dataset,
			informeCode,
			montoFactura,
			montoEsperado,
			status: coincide ? "validado" : "no_coincide",
			detalle: coincide
				? `Monto coincide con el excel COES (${montoEsperado}).`
				: `Monto de factura (${montoFactura}) no coincide con el excel COES (${montoEsperado}).`,
		};
	};

	// Caso A: Alupar cobra (columna, fila 9) y el proveedor paga (fila, columna C)
	// -- ej. VTEA, donde Alupar factura.
	if (matrix.aluparColumn !== undefined) {
		const supplierRow = matrix.rows.find((r) => r.ruc === supplierRuc);
		const montoEsperado = supplierRow?.values[matrix.aluparColumn];
		if (montoEsperado !== undefined) {
			return buildResult(montoEsperado);
		}
	}

	// Caso B: el proveedor cobra (columna, fila 9) y Alupar paga (fila, columna C)
	// -- ej. VTP, donde a Alupar le facturan.
	if (matrix.aluparRow !== undefined) {
		const supplierColumn = matrix.columns.find((c) => c.ruc === supplierRuc);
		const aluparRowData = matrix.rows.find((r) => r.row === matrix.aluparRow);
		const montoEsperado = supplierColumn ? aluparRowData?.values[supplierColumn.col] : undefined;
		if (montoEsperado !== undefined) {
			return buildResult(montoEsperado);
		}
	}

	if (matrix.aluparColumn === undefined && matrix.aluparRow === undefined) {
		return noEncontrado(dataset, montoFactura, informeCode, `No se encontro el RUC de Alupar (ni como cobrador ni como pagador) en la hoja "${matrix.sheetName}".`);
	}

	return noEncontrado(dataset, montoFactura, informeCode, `No se encontro el RUC del proveedor (${supplierRuc}) cruzado con Alupar en la hoja "${matrix.sheetName}".`);
}

export async function resolveCentroCostos(
	extracted: ExtractedFields,
	blobStorage = new BlobStorageService()
): Promise<CentroCostosResult> {
	const text = normalizeText([extracted.concepto, extracted.rawTextSnippet].filter(Boolean).join(" "));

	if (text.includes("peaje")) {
		return { centroCostos: "Peajes" };
	}

	let dataset: CoesDataset | undefined;
	if (text.includes("transferencias de potencia")) {
		dataset = "vtp";
	} else if (text.includes("transferencias de energia")) {
		dataset = "vtea";
	}

	if (!dataset) {
		return {};
	}

	const centroCostos = dataset === "vtp" ? "COES-VTP" : "COES-VTEA";
	const montoFactura = extracted.monto ?? 0;
	const supplierRuc = extracted.ruc ?? "";
	const informeCode = extractInformeCode(extracted.concepto ?? extracted.rawTextSnippet);

	if (!informeCode) {
		return {
			centroCostos,
			coesValidacion: noEncontrado(dataset, montoFactura, undefined, "No se pudo extraer el codigo de informe COES del concepto de la factura."),
		};
	}

	const indexEntry = await findCoesIndexEntry(dataset, informeCode, blobStorage);
	if (!indexEntry) {
		return {
			centroCostos,
			coesValidacion: noEncontrado(dataset, montoFactura, informeCode, `No se encontro el excel COES para el informe ${informeCode}.`),
		};
	}

	try {
		const coesValidacion = await crossCheckAmount(dataset, indexEntry.storagePath, supplierRuc, montoFactura, informeCode, blobStorage);
		return { centroCostos, coesValidacion };
	} catch (err) {
		return {
			centroCostos,
			coesValidacion: noEncontrado(dataset, montoFactura, informeCode, `Error validando contra excel COES: ${err instanceof Error ? err.message : String(err)}`),
		};
	}
}

// --- Vista web: matriz completa + verificacion manual por periodo --------------

export async function getCoesMatrixForPeriod(
	dataset: CoesDataset,
	period: CoesSyncPeriod,
	blobStorage = new BlobStorageService()
): Promise<CoesMatrix | undefined> {
	const storagePath = getExpectedStoragePath(dataset, period);
	const exists = await blobStorage.exists(storagePath);
	if (!exists) return undefined;
	return loadCoesMatrix(dataset, storagePath, blobStorage);
}

export async function verifyCoesAmountForPeriod(
	dataset: CoesDataset,
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
	return crossCheckAmount(dataset, storagePath, supplierRuc, montoFactura, undefined, blobStorage);
}
