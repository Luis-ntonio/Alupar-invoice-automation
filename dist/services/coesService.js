"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractInformeCode = extractInformeCode;
exports.findCoesIndexEntry = findCoesIndexEntry;
exports.listCoesIndex = listCoesIndex;
exports.getExpectedStoragePath = getExpectedStoragePath;
exports.extractPeriodFromText = extractPeriodFromText;
exports.syncCoesMonthlyDataset = syncCoesMonthlyDataset;
exports.syncCoesMonthlyExcel = syncCoesMonthlyExcel;
exports.syncCoesMonthlyVtpReport = syncCoesMonthlyVtpReport;
exports.shiftPeriod = shiftPeriod;
exports.syncCoesMonthlyRequiredFiles = syncCoesMonthlyRequiredFiles;
exports.runCoesAutoSync = runCoesAutoSync;
const exceljs_1 = __importDefault(require("exceljs"));
const classifier_1 = require("../utils/classifier");
const blobStorage_1 = require("./blobStorage");
const COES_INDEX_PATH = "coes/coes-index.json";
const INFORME_CODE_REGEX = /COES\/D\/DO\/SME-INF-\d+-\d{4}/i;
const INFORME_CELL = {
    vtea: { sheet: "CUADRO 1", address: "D3" },
    vtp: { sheet: "C3", address: "B4" },
};
function extractInformeCode(text) {
    if (!text)
        return undefined;
    const match = text.match(INFORME_CODE_REGEX);
    return match?.[0]?.toUpperCase();
}
async function loadCoesIndex(blobStorage) {
    const exists = await blobStorage.exists(COES_INDEX_PATH);
    if (!exists)
        return [];
    try {
        const buffer = await blobStorage.readBuffer(COES_INDEX_PATH);
        const parsed = JSON.parse(buffer.toString("utf-8"));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
        console.warn("[COES] No se pudo leer el indice de informes:", err instanceof Error ? err.message : err);
        return [];
    }
}
async function saveCoesIndexEntry(entry, blobStorage) {
    const entries = await loadCoesIndex(blobStorage);
    const filtered = entries.filter((e) => !(e.dataset === entry.dataset && e.informeCode === entry.informeCode));
    filtered.push(entry);
    await blobStorage.saveAtPath(Buffer.from(JSON.stringify(filtered, null, 2)), COES_INDEX_PATH);
}
async function findCoesIndexEntry(dataset, informeCode, blobStorage) {
    const entries = await loadCoesIndex(blobStorage);
    const normalizedCode = informeCode.toUpperCase();
    return entries.find((e) => e.dataset === dataset && e.informeCode === normalizedCode);
}
async function listCoesIndex(blobStorage) {
    return loadCoesIndex(blobStorage);
}
function getExpectedStoragePath(dataset, period) {
    const cfg = datasetConfig(dataset);
    const fileName = cfg.fileName(period.year, period.month);
    return `coes/${cfg.storageFolder}/${period.year}/${String(period.month).padStart(2, "0")}/${fileName}`;
}
async function indexCoesFile(dataset, period, storagePath, buffer, blobStorage) {
    try {
        const cell = INFORME_CELL[dataset];
        const workbook = new exceljs_1.default.Workbook();
        await workbook.xlsx.load(buffer);
        const sheet = workbook.getWorksheet(cell.sheet);
        const rawValue = sheet?.getCell(cell.address).value;
        const cellText = rawValue == null
            ? ""
            : String(typeof rawValue === "object" ? rawValue.text ?? rawValue.result ?? "" : rawValue);
        const informeCode = extractInformeCode(cellText);
        if (!informeCode) {
            console.warn(`[COES] No se encontro codigo de informe en ${cell.sheet}!${cell.address} para ${storagePath}.`);
            return;
        }
        await saveCoesIndexEntry({ dataset, informeCode, period, storagePath }, blobStorage);
    }
    catch (err) {
        console.warn(`[COES] Fallo al indexar ${storagePath}:`, err instanceof Error ? err.message : err);
    }
}
const COES_DOWNLOAD_BASE = "https://www.coes.org.pe/Portal/browser/download?url=";
const COES_VTEA_BASE_PATH = "Mercado Mayorista/Liquidaciones del MME/01 Mercado de Corto Plazo/Liquidaciones VTEA";
const COES_VTP_BASE_PATH = "Mercado Mayorista/Liquidaciones del MME/01 Mercado de Corto Plazo/Liquidaciones VTP";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
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
function monthNameEs(month) {
    return MONTH_NAMES_ES[month - 1] ?? "";
}
// El concepto de la factura COES suele traer el mes y año en texto explicito
// (ej. "INFORME COES/D/DO/SME-INF-090-2026 - ABRIL 2026"). Permite resolver el
// periodo exacto de una factura sin depender de que ya este sincronizado/indexado
// localmente, para poder ir a buscarlo a COES on-demand cuando llega una factura
// de un mes distinto al ultimo sincronizado (ej. facturas tardias o de migracion).
function extractPeriodFromText(text) {
    if (!text)
        return undefined;
    const normalized = (0, classifier_1.normalizeText)(text);
    const monthsPattern = MONTH_NAMES_ES.map((name) => name.toLowerCase()).join("|");
    const match = normalized.match(new RegExp(`\\b(${monthsPattern})\\s+(\\d{4})\\b`));
    if (!match)
        return undefined;
    const month = MONTH_NAMES_ES.findIndex((name) => name.toLowerCase() === match[1]) + 1;
    const year = Number(match[2]);
    if (!month || !Number.isFinite(year))
        return undefined;
    return { year, month };
}
function monthFolderName(month) {
    const padded = String(month).padStart(2, "0");
    return `${padded}_${monthNameEs(month)}`;
}
function coesFileName(year, month) {
    const mm = String(month).padStart(2, "0");
    const yy = String(year).slice(-2);
    return `Resumen_cuadros-${mm}${yy}.xlsx`;
}
function coesVtpFileName(year, month) {
    const mm = String(month).padStart(2, "0");
    const yy = String(year).slice(-2);
    return `ReportesLVTP-${mm}${yy}.xlsx`;
}
const DATASETS = [
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
function datasetConfig(dataset) {
    const found = DATASETS.find((item) => item.dataset === dataset);
    if (!found) {
        throw new Error(`Dataset COES no soportado: ${dataset}`);
    }
    return found;
}
// COES no es consistente con la subcarpeta "Mensual": algunos periodos publican
// el archivo en ".../06_Junio/Mensual/archivo.xlsx" y otros directamente en
// ".../06_Junio/archivo.xlsx" (visto en el VTP de junio 2026). Se devuelven ambas
// variantes como candidatas y la descarga usa la primera que exista.
function buildRemotePaths(basePath, period, fileName) {
    const monthFolder = `${basePath}/${period.year}/${monthFolderName(period.month)}`;
    return [
        `${monthFolder}/Mensual/${fileName}`,
        `${monthFolder}/${fileName}`,
    ];
}
function buildRemoteUrl(remotePath) {
    return `${COES_DOWNLOAD_BASE}${encodeURIComponent(remotePath)}`;
}
async function fetchCoesFile(remoteUrl) {
    const response = await fetch(remoteUrl, {
        method: "GET",
        headers: {
            "User-Agent": UA,
            Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,text/html;q=0.8,*/*;q=0.5",
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
async function syncCoesMonthlyDataset(dataset, period, blobStorage = new blobStorage_1.BlobStorageService()) {
    const cfg = datasetConfig(dataset);
    const fileName = cfg.fileName(period.year, period.month);
    const candidatePaths = buildRemotePaths(cfg.basePath, period, fileName);
    // La primera candidata (con "Mensual/") se usa como representativa para los
    // resultados already_exists / not_available.
    const remotePath = candidatePaths[0];
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
    // Se prueba cada variante de ruta (con y sin "Mensual/") y se usa la primera
    // que devuelva un archivo valido.
    let buffer = null;
    let resolvedRemotePath = remotePath;
    let resolvedRemoteUrl = remoteUrl;
    for (const candidate of candidatePaths) {
        const candidateUrl = buildRemoteUrl(candidate);
        const candidateBuffer = await fetchCoesFile(candidateUrl);
        if (candidateBuffer) {
            buffer = candidateBuffer;
            resolvedRemotePath = candidate;
            resolvedRemoteUrl = candidateUrl;
            break;
        }
    }
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
        remotePath: resolvedRemotePath,
        remoteUrl: resolvedRemoteUrl,
        storagePath,
    };
}
async function syncCoesMonthlyExcel(period, blobStorage = new blobStorage_1.BlobStorageService()) {
    return syncCoesMonthlyDataset("vtea", period, blobStorage);
}
async function syncCoesMonthlyVtpReport(period, blobStorage = new blobStorage_1.BlobStorageService()) {
    return syncCoesMonthlyDataset("vtp", period, blobStorage);
}
function toPeriod(date) {
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
    };
}
function shiftMonths(date, delta) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}
const MAX_LOOKBACK_MONTHS = 12;
function periodKey(period) {
    return `${period.year}-${period.month}`;
}
function shiftPeriod(period, delta) {
    return toPeriod(shiftMonths(new Date(Date.UTC(period.year, period.month - 1, 1)), delta));
}
async function findLatestStoredPeriod(dataset, blobStorage) {
    const entries = await loadCoesIndex(blobStorage);
    let latest;
    for (const entry of entries) {
        if (entry.dataset !== dataset)
            continue;
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
async function syncDatasetWithFallback(dataset, now, blobStorage) {
    const attempts = [];
    const tried = new Set();
    const tryPeriod = async (period) => {
        tried.add(periodKey(period));
        const result = await syncCoesMonthlyDataset(dataset, period, blobStorage);
        attempts.push(result);
        return result;
    };
    const currentPeriod = toPeriod(now);
    const latestStored = await findLatestStoredPeriod(dataset, blobStorage);
    // Se recorre mes a mes hacia atras desde el mes actual y se toma el primer
    // periodo disponible en COES (el mas reciente). Antes se saltaba directo del mes
    // actual al ultimo mes ya almacenado, lo que dejaba sin descargar los meses
    // publicados en el medio (ej. tener mayo guardado y no bajar junio porque julio
    // aun no esta publicado). El recorrido se detiene al llegar al ultimo periodo ya
    // almacenado (no hay nada mas nuevo que buscar por debajo) o en MAX_LOOKBACK_MONTHS.
    let cursor = currentPeriod;
    for (let i = 0; i <= MAX_LOOKBACK_MONTHS; i++) {
        if (!tried.has(periodKey(cursor))) {
            const result = await tryPeriod(cursor);
            if (result.status === "downloaded" || result.status === "already_exists") {
                return { attempts, selected: result };
            }
        }
        if (latestStored && periodKey(cursor) === periodKey(latestStored)) {
            break;
        }
        cursor = shiftPeriod(cursor, -1);
    }
    return { attempts, selected: undefined };
}
function summarizeStatus(selectedByDataset) {
    const selected = Object.values(selectedByDataset);
    if (selected.length === 0)
        return "not_available";
    if (selected.length < DATASETS.length)
        return "partial";
    const allAlready = selected.every((item) => item.status === "already_exists");
    return allAlready ? "already_exists" : "downloaded";
}
async function syncCoesMonthlyRequiredFiles(period, blobStorage = new blobStorage_1.BlobStorageService()) {
    const attempts = [];
    const selectedByDataset = {};
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
async function runCoesAutoSync(now = new Date(), blobStorage = new blobStorage_1.BlobStorageService()) {
    const attempts = [];
    const selectedByDataset = {};
    for (const cfg of DATASETS) {
        const { attempts: datasetAttempts, selected } = await syncDatasetWithFallback(cfg.dataset, now, blobStorage);
        attempts.push(...datasetAttempts);
        if (selected)
            selectedByDataset[cfg.dataset] = selected;
    }
    return {
        status: summarizeStatus(selectedByDataset),
        attempts,
        selectedByDataset,
        selected: attempts.find((item) => item.status === "downloaded" || item.status === "already_exists"),
    };
}
