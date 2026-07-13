import ExcelJS from "exceljs";
import { normalizeText } from "../utils/classifier";
import { BlobStorageService } from "./blobStorage";

const COES_INDEX_PATH = "coes/coes-index.json";
const INFORME_CODE_REGEX = /COES\/D\/DO\/SME-INF-\d+-\d{4}/i;

const INFORME_CELL: Record<CoesDataset, { sheet: string; address: string }> = {
	vtea: { sheet: "CUADRO 1", address: "D3" },
	vtp: { sheet: "C3", address: "B4" },
};

export interface CoesIndexEntry {
	dataset: CoesDataset;
	informeCode: string;
	period: CoesSyncPeriod;
	storagePath: string;
}

export function extractInformeCode(text: string | undefined | null): string | undefined {
	if (!text) return undefined;
	const match = text.match(INFORME_CODE_REGEX);
	return match?.[0]?.toUpperCase();
}

async function loadCoesIndex(blobStorage: BlobStorageService): Promise<CoesIndexEntry[]> {
	const exists = await blobStorage.exists(COES_INDEX_PATH);
	if (!exists) return [];
	try {
		const buffer = await blobStorage.readBuffer(COES_INDEX_PATH);
		const parsed = JSON.parse(buffer.toString("utf-8"));
		return Array.isArray(parsed) ? (parsed as CoesIndexEntry[]) : [];
	} catch (err) {
		console.warn("[COES] No se pudo leer el indice de informes:", err instanceof Error ? err.message : err);
		return [];
	}
}

async function saveCoesIndexEntry(entry: CoesIndexEntry, blobStorage: BlobStorageService): Promise<void> {
	const entries = await loadCoesIndex(blobStorage);
	const filtered = entries.filter((e) => !(e.dataset === entry.dataset && e.informeCode === entry.informeCode));
	filtered.push(entry);
	await blobStorage.saveAtPath(Buffer.from(JSON.stringify(filtered, null, 2)), COES_INDEX_PATH);
}

export async function findCoesIndexEntry(
	dataset: CoesDataset,
	informeCode: string,
	blobStorage: BlobStorageService
): Promise<CoesIndexEntry | undefined> {
	const entries = await loadCoesIndex(blobStorage);
	const normalizedCode = informeCode.toUpperCase();
	return entries.find((e) => e.dataset === dataset && e.informeCode === normalizedCode);
}

export async function listCoesIndex(blobStorage: BlobStorageService): Promise<CoesIndexEntry[]> {
	return loadCoesIndex(blobStorage);
}

export function getExpectedStoragePath(dataset: CoesDataset, period: CoesSyncPeriod): string {
	const cfg = datasetConfig(dataset);
	const fileName = cfg.fileName(period.year, period.month);
	return `coes/${cfg.storageFolder}/${period.year}/${String(period.month).padStart(2, "0")}/${fileName}`;
}

async function indexCoesFile(
	dataset: CoesDataset,
	period: CoesSyncPeriod,
	storagePath: string,
	buffer: Buffer,
	blobStorage: BlobStorageService
): Promise<void> {
	try {
		const cell = INFORME_CELL[dataset];
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(buffer as any);
		const sheet = workbook.getWorksheet(cell.sheet);
		const rawValue = sheet?.getCell(cell.address).value;
		const cellText =
			rawValue == null
				? ""
				: String(typeof rawValue === "object" ? (rawValue as any).text ?? (rawValue as any).result ?? "" : rawValue);
		const informeCode = extractInformeCode(cellText);
		if (!informeCode) {
			console.warn(`[COES] No se encontro codigo de informe en ${cell.sheet}!${cell.address} para ${storagePath}.`);
			return;
		}
		await saveCoesIndexEntry({ dataset, informeCode, period, storagePath }, blobStorage);
	} catch (err) {
		console.warn(`[COES] Fallo al indexar ${storagePath}:`, err instanceof Error ? err.message : err);
	}
}

const COES_DOWNLOAD_BASE = "https://www.coes.org.pe/Portal/browser/download?url=";
const COES_VTEA_BASE_PATH = "Mercado Mayorista/Liquidaciones del MME/01 Mercado de Corto Plazo/Liquidaciones VTEA";
const COES_VTP_BASE_PATH = "Mercado Mayorista/Liquidaciones del MME/01 Mercado de Corto Plazo/Liquidaciones VTP";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

const MONTH_NAMES_ES = [
	"Enero",
	"Febrero",
	"Marzo",
	"Abril",
	"Mayo",
	"Junio",
	"Julio",
	"Agosto",
	"Septiembre",
	"Octubre",
	"Noviembre",
	"Diciembre",
];

export interface CoesSyncPeriod {
	year: number;
	month: number;
}

export type CoesDataset = "vtea" | "vtp";

export type CoesDownloadStatus = "downloaded" | "already_exists" | "not_available";

export interface CoesDownloadResult {
	status: CoesDownloadStatus;
	dataset: CoesDataset;
	period: CoesSyncPeriod;
	storagePath?: string;
	fileName: string;
	remotePath: string;
	remoteUrl: string;
	reason?: string;
}

interface CoesDatasetConfig {
	dataset: CoesDataset;
	basePath: string;
	fileName: (year: number, month: number) => string;
	storageFolder: string;
}

function monthNameEs(month: number): string {
	return MONTH_NAMES_ES[month - 1] ?? "";
}

// El concepto de la factura COES suele traer el mes y año en texto explicito
// (ej. "INFORME COES/D/DO/SME-INF-090-2026 - ABRIL 2026"). Permite resolver el
// periodo exacto de una factura sin depender de que ya este sincronizado/indexado
// localmente, para poder ir a buscarlo a COES on-demand cuando llega una factura
// de un mes distinto al ultimo sincronizado (ej. facturas tardias o de migracion).
export function extractPeriodFromText(text: string | undefined | null): CoesSyncPeriod | undefined {
	if (!text) return undefined;
	const normalized = normalizeText(text);
	const monthsPattern = MONTH_NAMES_ES.map((name) => name.toLowerCase()).join("|");
	const match = normalized.match(new RegExp(`\\b(${monthsPattern})\\s+(\\d{4})\\b`));
	if (!match) return undefined;
	const month = MONTH_NAMES_ES.findIndex((name) => name.toLowerCase() === match[1]) + 1;
	const year = Number(match[2]);
	if (!month || !Number.isFinite(year)) return undefined;
	return { year, month };
}

function monthFolderName(month: number): string {
	const padded = String(month).padStart(2, "0");
	return `${padded}_${monthNameEs(month)}`;
}

function coesFileName(year: number, month: number): string {
	const mm = String(month).padStart(2, "0");
	const yy = String(year).slice(-2);
	return `Resumen_cuadros-${mm}${yy}.xlsx`;
}

function coesVtpFileName(year: number, month: number): string {
	const mm = String(month).padStart(2, "0");
	const yy = String(year).slice(-2);
	return `ReportesLVTP-${mm}${yy}.xlsx`;
}

const DATASETS: CoesDatasetConfig[] = [
	{
		dataset: "vtea",
		basePath: COES_VTEA_BASE_PATH,
		fileName: coesFileName,
		storageFolder: "liquidaciones-vtea",
	},
	{
		dataset: "vtp",
		basePath: COES_VTP_BASE_PATH,
		fileName: coesVtpFileName,
		storageFolder: "liquidaciones-vtp",
	},
];

function datasetConfig(dataset: CoesDataset): CoesDatasetConfig {
	const found = DATASETS.find((item) => item.dataset === dataset);
	if (!found) {
		throw new Error(`Dataset COES no soportado: ${dataset}`);
	}
	return found;
}

function buildRemotePath(basePath: string, period: CoesSyncPeriod, fileName: string): string {
	return `${basePath}/${period.year}/${monthFolderName(period.month)}/Mensual/${fileName}`;
}

function buildRemoteUrl(remotePath: string): string {
	return `${COES_DOWNLOAD_BASE}${encodeURIComponent(remotePath)}`;
}

async function fetchCoesFile(remoteUrl: string): Promise<Buffer | null> {
	const response = await fetch(remoteUrl, {
		method: "GET",
		headers: {
			"User-Agent": UA,
			Accept:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,text/html;q=0.8,*/*;q=0.5",
			"Accept-Language": "es-PE,es;q=0.9",
			Referer: "https://www.coes.org.pe/Portal/mercadomayorista/liquidaciones",
		},
		redirect: "follow",
	});

	if (!response.ok) {
		return null;
	}

	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	const bytes = Buffer.from(await response.arrayBuffer());

	if (bytes.length === 0) {
		return null;
	}

	// XLSX is a ZIP container, so it should start with PK.
	const isZipSignature = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
	if (!isZipSignature) {
		return null;
	}

	// COES can return an HTML response for unavailable files.
	if (contentType.includes("text/html")) {
		return null;
	}

	return bytes;
}

export async function syncCoesMonthlyDataset(
	dataset: CoesDataset,
	period: CoesSyncPeriod,
	blobStorage = new BlobStorageService()
): Promise<CoesDownloadResult> {
	const cfg = datasetConfig(dataset);
	const fileName = cfg.fileName(period.year, period.month);
	const remotePath = buildRemotePath(cfg.basePath, period, fileName);
	const remoteUrl = buildRemoteUrl(remotePath);

	const expectedStoragePath = getExpectedStoragePath(dataset, period);
	const alreadyExists = await blobStorage.exists(expectedStoragePath);
	if (alreadyExists) {
		const existingBuffer = await blobStorage.readBuffer(expectedStoragePath);
		await indexCoesFile(dataset, period, expectedStoragePath, existingBuffer, blobStorage);
		return {
			status: "already_exists",
			dataset,
			period,
			fileName,
			remotePath,
			remoteUrl,
			storagePath: expectedStoragePath,
			reason: "Archivo ya presente en almacenamiento.",
		};
	}

	const buffer = await fetchCoesFile(remoteUrl);
	if (!buffer) {
		return {
			status: "not_available",
			dataset,
			period,
			fileName,
			remotePath,
			remoteUrl,
			reason: "COES aun no publica el archivo objetivo para el periodo.",
		};
	}

	const storagePath = await blobStorage.saveAtPath(buffer, expectedStoragePath);
	await indexCoesFile(dataset, period, storagePath, buffer, blobStorage);
	return {
		status: "downloaded",
		dataset,
		period,
		fileName,
		remotePath,
		remoteUrl,
		storagePath,
	};
}

export async function syncCoesMonthlyExcel(period: CoesSyncPeriod, blobStorage = new BlobStorageService()): Promise<CoesDownloadResult> {
	return syncCoesMonthlyDataset("vtea", period, blobStorage);
}

export async function syncCoesMonthlyVtpReport(period: CoesSyncPeriod, blobStorage = new BlobStorageService()): Promise<CoesDownloadResult> {
	return syncCoesMonthlyDataset("vtp", period, blobStorage);
}

function toPeriod(date: Date): CoesSyncPeriod {
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
	};
}

function shiftMonths(date: Date, delta: number): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}

const MAX_LOOKBACK_MONTHS = 12;

function periodKey(period: CoesSyncPeriod): string {
	return `${period.year}-${period.month}`;
}

export function shiftPeriod(period: CoesSyncPeriod, delta: number): CoesSyncPeriod {
	return toPeriod(shiftMonths(new Date(Date.UTC(period.year, period.month - 1, 1)), delta));
}

async function findLatestStoredPeriod(dataset: CoesDataset, blobStorage: BlobStorageService): Promise<CoesSyncPeriod | undefined> {
	const entries = await loadCoesIndex(blobStorage);
	let latest: CoesSyncPeriod | undefined;
	for (const entry of entries) {
		if (entry.dataset !== dataset) continue;
		if (!latest || entry.period.year > latest.year || (entry.period.year === latest.year && entry.period.month > latest.month)) {
			latest = entry.period;
		}
	}
	return latest;
}

/**
 * Regla de negocio:
 * 1. Intentar el mes actual contra COES.
 * 2. Si no esta publicado, usar el ultimo periodo ya almacenado localmente (no hace falta reintentar COES para eso).
 * 3. Si no hay nada almacenado localmente, retroceder mes a mes contra COES (hasta MAX_LOOKBACK_MONTHS) hasta encontrar el mas reciente publicado.
 */
async function syncDatasetWithFallback(
	dataset: CoesDataset,
	now: Date,
	blobStorage: BlobStorageService
): Promise<{ attempts: CoesDownloadResult[]; selected?: CoesDownloadResult }> {
	const attempts: CoesDownloadResult[] = [];
	const tried = new Set<string>();

	const tryPeriod = async (period: CoesSyncPeriod): Promise<CoesDownloadResult> => {
		tried.add(periodKey(period));
		const result = await syncCoesMonthlyDataset(dataset, period, blobStorage);
		attempts.push(result);
		return result;
	};

	const currentPeriod = toPeriod(now);
	const currentResult = await tryPeriod(currentPeriod);
	if (currentResult.status === "downloaded" || currentResult.status === "already_exists") {
		return { attempts, selected: currentResult };
	}

	const latestStored = await findLatestStoredPeriod(dataset, blobStorage);
	if (latestStored && !tried.has(periodKey(latestStored))) {
		const storedResult = await tryPeriod(latestStored);
		if (storedResult.status === "downloaded" || storedResult.status === "already_exists") {
			return { attempts, selected: storedResult };
		}
	}

	if (!latestStored) {
		let cursor = currentPeriod;
		for (let i = 0; i < MAX_LOOKBACK_MONTHS; i++) {
			cursor = shiftPeriod(cursor, -1);
			if (tried.has(periodKey(cursor))) continue;
			const result = await tryPeriod(cursor);
			if (result.status === "downloaded" || result.status === "already_exists") {
				return { attempts, selected: result };
			}
		}
	}

	return { attempts, selected: undefined };
}

export interface CoesAutoSyncResult {
	status: "downloaded" | "already_exists" | "partial" | "not_available";
	attempts: CoesDownloadResult[];
	selectedByDataset: Partial<Record<CoesDataset, CoesDownloadResult>>;
	selected?: CoesDownloadResult;
}

export interface CoesMonthlyRequiredFilesResult {
	status: "downloaded" | "already_exists" | "partial" | "not_available";
	attempts: CoesDownloadResult[];
	selectedByDataset: Partial<Record<CoesDataset, CoesDownloadResult>>;
	selected?: CoesDownloadResult;
}

function summarizeStatus(selectedByDataset: Partial<Record<CoesDataset, CoesDownloadResult>>):
	"downloaded" | "already_exists" | "partial" | "not_available" {
	const selected = Object.values(selectedByDataset);
	if (selected.length === 0) return "not_available";
	if (selected.length < DATASETS.length) return "partial";
	const allAlready = selected.every((item) => item.status === "already_exists");
	return allAlready ? "already_exists" : "downloaded";
}

export async function syncCoesMonthlyRequiredFiles(
	period: CoesSyncPeriod,
	blobStorage = new BlobStorageService()
): Promise<CoesMonthlyRequiredFilesResult> {
	const attempts: CoesDownloadResult[] = [];
	const selectedByDataset: Partial<Record<CoesDataset, CoesDownloadResult>> = {};

	for (const cfg of DATASETS) {
		const result = await syncCoesMonthlyDataset(cfg.dataset, period, blobStorage);
		attempts.push(result);
		if (result.status === "downloaded" || result.status === "already_exists") {
			selectedByDataset[cfg.dataset] = result;
		}
	}

	return {
		status: summarizeStatus(selectedByDataset),
		attempts,
		selectedByDataset,
		selected: attempts.find((item) => item.status === "downloaded" || item.status === "already_exists"),
	};
}

export async function runCoesAutoSync(now = new Date(), blobStorage = new BlobStorageService()): Promise<CoesAutoSyncResult> {
	const attempts: CoesDownloadResult[] = [];
	const selectedByDataset: Partial<Record<CoesDataset, CoesDownloadResult>> = {};

	for (const cfg of DATASETS) {
		const { attempts: datasetAttempts, selected } = await syncDatasetWithFallback(cfg.dataset, now, blobStorage);
		attempts.push(...datasetAttempts);
		if (selected) selectedByDataset[cfg.dataset] = selected;
	}

	return {
		status: summarizeStatus(selectedByDataset),
		attempts,
		selectedByDataset,
		selected: attempts.find((item) => item.status === "downloaded" || item.status === "already_exists"),
	};
}
