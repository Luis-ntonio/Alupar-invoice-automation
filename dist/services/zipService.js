"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractZipContents = extractZipContents;
exports.extractSupportedZipEntries = extractSupportedZipEntries;
exports.filterAccessibleFiles = filterAccessibleFiles;
exports.streamZipToWritable = streamZipToWritable;
const archiver_1 = __importDefault(require("archiver"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const yauzl_1 = __importDefault(require("yauzl"));
const config_1 = require("../config");
/**
 * Extrae XML/PDF de un ZIP en memoria usando yauzl (parser ZIP robusto).
 */
async function extractZipContents(zipBuffer) {
    return extractEntriesFromZip(zipBuffer, (name) => {
        if (name.endsWith(".xml"))
            return "application/xml";
        if (name.endsWith(".pdf"))
            return "application/pdf";
        return null;
    }, "extractZipContents");
}
/**
 * Extrae XML/PDF/ZIP de un ZIP en memoria preservando la ruta interna.
 */
async function extractSupportedZipEntries(zipBuffer) {
    return extractEntriesFromZip(zipBuffer, (name) => {
        if (name.endsWith(".xml"))
            return "application/xml";
        if (name.endsWith(".pdf"))
            return "application/pdf";
        if (name.endsWith(".zip"))
            return "application/zip";
        return null;
    }, "extractSupportedZipEntries");
}
async function extractEntriesFromZip(zipBuffer, resolveMimeType, logPrefix) {
    const entries = [];
    console.log(`[${logPrefix}] bufLen=${zipBuffer.length} magic=0x${zipBuffer.slice(0, 4).toString("hex")}`);
    const readStreamToBuffer = (stream) => new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (c) => {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        });
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
    return await new Promise((resolve) => {
        yauzl_1.default.fromBuffer(zipBuffer, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
            if (openErr || !zipfile) {
                console.warn(`[${logPrefix}] No se pudo abrir ZIP: ${openErr}`);
                return resolve(entries);
            }
            zipfile.on("error", (err) => {
                console.warn(`[${logPrefix}] Error global ZIP: ${err}`);
            });
            zipfile.on("entry", (entry) => {
                if (/\/$/.test(entry.fileName)) {
                    zipfile.readEntry();
                    return;
                }
                const name = entry.fileName.toLowerCase();
                const mimeType = resolveMimeType(name);
                if (!mimeType) {
                    zipfile.readEntry();
                    return;
                }
                zipfile.openReadStream(entry, async (streamErr, stream) => {
                    if (streamErr || !stream) {
                        console.warn(`[${logPrefix}] Error abriendo stream de "${entry.fileName}": ${streamErr}`);
                        zipfile.readEntry();
                        return;
                    }
                    try {
                        const buf = await readStreamToBuffer(stream);
                        if (buf.length === 0) {
                            console.warn(`[${logPrefix}] Entrada vacía: "${entry.fileName}"`);
                        }
                        else {
                            entries.push({
                                fileName: node_path_1.default.posix.basename(entry.fileName),
                                entryPath: entry.fileName,
                                buffer: buf,
                                mimeType,
                            });
                            console.log(`[${logPrefix}] OK "${entry.fileName}" → ${buf.length}B`);
                        }
                    }
                    catch (err) {
                        console.warn(`[${logPrefix}] Error leyendo "${entry.fileName}": ${err}`);
                    }
                    zipfile.readEntry();
                });
            });
            zipfile.on("end", () => {
                console.log(`[${logPrefix}] Total entradas extraídas: ${entries.length}`);
                resolve(entries);
            });
            zipfile.readEntry();
        });
    });
}
/** Filters down to files whose source path is accessible on disk (local mode only). */
async function filterAccessibleFiles(files) {
    if (config_1.config.storageMode !== "local")
        return [...files];
    const accessible = [];
    for (const file of files) {
        if (!file.sourcePath)
            continue;
        try {
            await node_fs_1.promises.access(node_path_1.default.join(config_1.config.localStorageDir, file.sourcePath));
            accessible.push(file);
        }
        catch {
            // file missing – skip
        }
    }
    return accessible;
}
/** Pipes a ZIP of the given files directly into `output` (e.g. an HTTP response). */
async function streamZipToWritable(files, output, blobStorage) {
    const archive = (0, archiver_1.default)("zip", { zlib: { level: 9 } });
    const done = new Promise((resolve, reject) => {
        output.on("finish", resolve);
        output.on("error", reject);
        archive.on("error", reject);
    });
    archive.pipe(output);
    const usedNames = new Map();
    for (const file of files) {
        const targetName = file.zipPath ?? file.fileName;
        const ext = node_path_1.default.extname(targetName);
        const base = targetName.slice(0, Math.max(0, targetName.length - ext.length));
        const seen = (usedNames.get(targetName) ?? 0) + 1;
        usedNames.set(targetName, seen);
        const name = seen > 1 ? `${base}_${seen}${ext}` : targetName;
        const stream = await blobStorage.openReadStream(file.sourcePath);
        archive.append(stream, { name });
    }
    await archive.finalize();
    await done;
}
