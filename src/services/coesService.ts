import { BlobStorageService } from "./blobStorage";

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

async function syncCoesMonthlyDataset(
	dataset: CoesDataset,
	period: CoesSyncPeriod,
	blobStorage = new BlobStorageService()
): Promise<CoesDownloadResult> {
	const cfg = datasetConfig(dataset);
	const fileName = cfg.fileName(period.year, period.month);
	const remotePath = buildRemotePath(cfg.basePath, period, fileName);
	const remoteUrl = buildRemoteUrl(remotePath);

	const expectedStoragePath = `coes/${cfg.storageFolder}/${period.year}/${String(period.month).padStart(2, "0")}/${fileName}`;
	const alreadyExists = await blobStorage.exists(expectedStoragePath);
	if (alreadyExists) {
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

/**
 * Rule requested by business:
 * - Try for the current month starting on day 25 of previous month.
 * - Keep previous month as fallback in case publication is delayed.
 */
export function buildCoesSyncCandidates(now = new Date()): CoesSyncPeriod[] {
	const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const previousMonthDate = shiftMonths(currentMonthStart, -1);
	const startTryCurrent = new Date(Date.UTC(previousMonthDate.getUTCFullYear(), previousMonthDate.getUTCMonth(), 25));

	const candidates: CoesSyncPeriod[] = [];
	if (now >= startTryCurrent) {
		candidates.push(toPeriod(currentMonthStart));
	}

	candidates.push(toPeriod(previousMonthDate));

	const unique = new Map<string, CoesSyncPeriod>();
	for (const item of candidates) {
		unique.set(`${item.year}-${item.month}`, item);
	}

	return Array.from(unique.values());
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
	const candidates = buildCoesSyncCandidates(now);

	for (const cfg of DATASETS) {
		for (const period of candidates) {
			const result = await syncCoesMonthlyDataset(cfg.dataset, period, blobStorage);
			attempts.push(result);
			if (result.status === "downloaded" || result.status === "already_exists") {
				selectedByDataset[cfg.dataset] = result;
				break;
			}
		}
	}

	return {
		status: summarizeStatus(selectedByDataset),
		attempts,
		selectedByDataset,
		selected: attempts.find((item) => item.status === "downloaded" || item.status === "already_exists"),
	};
}
