import ExcelJS from "exceljs";
import { BlobStorageService } from "./blobStorage";
import { SheetLayout, buildMatrixFromSheet, loadCoesMatrix } from "./centroCostosService";

// Indice de fuentes manuales (excel subidos a mano para centros de costo sin
// validacion automatica), en paralelo a coes/coes-index.json pero sin
// concepto de periodo: cada codigo tiene "la ultima carga vigente", no un
// archivo por mes. Se conserva historial completo (nunca se borra) para
// poder mostrarlo en la vista y para auditoria.
const MANUAL_INDEX_PATH = "coes/manual-index.json";

export interface ManualCentroCostoSource {
	centroCostoCode: string;
	sheet: string;
	layout: SheetLayout;
	storagePath: string;
	fileName: string;
	uploadedAt: string; // ISO
}

export interface ManualMappingInput {
	centroCostoCode: string;
	sheet: string;
	nameColumn: number;
	supplierColumn: number;
	dataStartColumn: number;
}

export interface ManualAssignWarning {
	centroCostoCode: string;
	message: string;
}

function sanitizeFileName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function loadManualIndex(blobStorage: BlobStorageService): Promise<ManualCentroCostoSource[]> {
	const exists = await blobStorage.exists(MANUAL_INDEX_PATH);
	if (!exists) return [];
	try {
		const buffer = await blobStorage.readBuffer(MANUAL_INDEX_PATH);
		const parsed = JSON.parse(buffer.toString("utf-8"));
		return Array.isArray(parsed) ? (parsed as ManualCentroCostoSource[]) : [];
	} catch (err) {
		console.warn("[centroCostosManual] No se pudo leer el indice manual:", err instanceof Error ? err.message : err);
		return [];
	}
}

async function appendManualSource(entry: ManualCentroCostoSource, blobStorage: BlobStorageService): Promise<void> {
	const entries = await loadManualIndex(blobStorage);
	entries.push(entry);
	await blobStorage.saveAtPath(Buffer.from(JSON.stringify(entries, null, 2)), MANUAL_INDEX_PATH);
}

export { loadManualIndex };

// La fuente "vigente" de un codigo es la de uploadedAt mas reciente entre
// todas sus cargas historicas -- mismo patron que findLatestStoredPeriod en
// coesService.ts, pero por codigo de centro de costo en vez de por dataset.
export async function getActiveManualSource(
	centroCostoCode: string,
	blobStorage: BlobStorageService
): Promise<ManualCentroCostoSource | undefined> {
	const entries = await loadManualIndex(blobStorage);
	let latest: ManualCentroCostoSource | undefined;
	for (const entry of entries) {
		if (entry.centroCostoCode !== centroCostoCode) continue;
		if (!latest || entry.uploadedAt > latest.uploadedAt) latest = entry;
	}
	return latest;
}

// Una entrada por codigo (la vigente de cada uno) -- para el resumen de la
// vista y para que la reconciliacion multi-centro recorra todos los codigos
// manuales activos sin tener que conocerlos de antemano.
export async function listActiveManualSources(blobStorage: BlobStorageService): Promise<ManualCentroCostoSource[]> {
	const entries = await loadManualIndex(blobStorage);
	const latestByCode = new Map<string, ManualCentroCostoSource>();
	for (const entry of entries) {
		const current = latestByCode.get(entry.centroCostoCode);
		if (!current || entry.uploadedAt > current.uploadedAt) latestByCode.set(entry.centroCostoCode, entry);
	}
	return Array.from(latestByCode.values());
}

// Paso 1 del flujo de carga: guarda el archivo crudo y devuelve los nombres
// de hoja disponibles, para que el admin elija cual hoja corresponde a cada
// centro de costo sin tener que adivinar el nombre exacto (sensible a
// mayusculas/espacios, igual que el resto de hojas COES).
export async function uploadManualWorkbook(
	buffer: Buffer,
	fileName: string,
	blobStorage: BlobStorageService
): Promise<{ storagePath: string; fileName: string; sheetNames: string[] }> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer as any);
	const sheetNames = workbook.worksheets.map((s) => s.name);

	const storagePath = `coes/manual/${Date.now()}-${sanitizeFileName(fileName)}`;
	await blobStorage.saveAtPath(buffer, storagePath);

	return { storagePath, fileName, sheetNames };
}

// Paso 2: por cada mapping, valida que la hoja exista y que la matriz se
// pueda construir; si Alupar no aparece (ni fila ni columna) igual se
// persiste la fuente (no bloquea la carga -- mismo criterio que el basePath
// sin confirmar de SCIO: mejor una fuente con warning que ninguna), pero se
// devuelve un warning para que el admin revise las columnas indicadas.
export async function assignManualMappings(
	storagePath: string,
	fileName: string,
	mappings: ManualMappingInput[],
	blobStorage: BlobStorageService
): Promise<{ saved: ManualCentroCostoSource[]; warnings: ManualAssignWarning[] }> {
	const buffer = await blobStorage.readBuffer(storagePath);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer as any);

	const saved: ManualCentroCostoSource[] = [];
	const warnings: ManualAssignWarning[] = [];
	const uploadedAt = new Date().toISOString();

	for (const mapping of mappings) {
		const sheet = workbook.getWorksheet(mapping.sheet);
		if (!sheet) {
			warnings.push({ centroCostoCode: mapping.centroCostoCode, message: `No se encontro la hoja "${mapping.sheet}" en el excel.` });
			continue;
		}

		const layout: SheetLayout = {
			nameColumn: mapping.nameColumn,
			supplierColumn: mapping.supplierColumn,
			dataStartColumn: mapping.dataStartColumn,
		};
		const matrix = buildMatrixFromSheet(sheet, "manual", layout);
		if (matrix.aluparColumn === undefined && matrix.aluparRow === undefined) {
			warnings.push({
				centroCostoCode: mapping.centroCostoCode,
				message: `No se encontro el RUC de Alupar en la hoja "${mapping.sheet}" con las columnas indicadas -- revisa nombre/RUC/inicio de montos.`,
			});
		}

		const entry: ManualCentroCostoSource = {
			centroCostoCode: mapping.centroCostoCode,
			sheet: mapping.sheet,
			layout,
			storagePath,
			fileName,
			uploadedAt,
		};
		await appendManualSource(entry, blobStorage);
		saved.push(entry);
	}

	// loadCoesMatrix cachea por storagePath+hoja -- se precarga aqui con el
	// layout ya validado para que la primera resolucion/revalidacion contra
	// esta fuente (inmediatamente despues del assign) no vuelva a parsear el
	// workbook completo.
	for (const entry of saved) {
		await loadCoesMatrix("manual", entry.sheet, entry.storagePath, entry.layout, blobStorage).catch(() => undefined);
	}

	return { saved, warnings };
}
