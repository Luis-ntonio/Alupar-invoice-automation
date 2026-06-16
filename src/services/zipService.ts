import archiver from "archiver";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import yauzl from "yauzl";
import { config } from "../config";
import { BlobStorageService } from "./blobStorage";

export interface ZipEntry {
  fileName: string;
  entryPath: string;
  buffer: Buffer;
  mimeType: string;
}

/**
 * Extrae XML/PDF de un ZIP en memoria usando yauzl (parser ZIP robusto).
 */
export async function extractZipContents(zipBuffer: Buffer): Promise<ZipEntry[]> {
  return extractEntriesFromZip(zipBuffer, (name) => {
    if (name.endsWith(".xml")) return "application/xml";
    if (name.endsWith(".pdf")) return "application/pdf";
    return null;
  }, "extractZipContents");
}

/**
 * Extrae XML/PDF/ZIP de un ZIP en memoria preservando la ruta interna.
 */
export async function extractSupportedZipEntries(zipBuffer: Buffer): Promise<ZipEntry[]> {
  return extractEntriesFromZip(zipBuffer, (name) => {
    if (name.endsWith(".xml")) return "application/xml";
    if (name.endsWith(".pdf")) return "application/pdf";
    if (name.endsWith(".zip")) return "application/zip";
    return null;
  }, "extractSupportedZipEntries");
}

async function extractEntriesFromZip(
  zipBuffer: Buffer,
  resolveMimeType: (name: string) => string | null,
  logPrefix: string
): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  console.log(`[${logPrefix}] bufLen=${zipBuffer.length} magic=0x${zipBuffer.slice(0, 4).toString("hex")}`);

  const readStreamToBuffer = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer | string) => {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });

  return await new Promise<ZipEntry[]>((resolve) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
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
            } else {
              entries.push({
                fileName: path.posix.basename(entry.fileName),
                entryPath: entry.fileName,
                buffer: buf,
                mimeType,
              });
              console.log(`[${logPrefix}] OK "${entry.fileName}" → ${buf.length}B`);
            }
          } catch (err) {
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

export interface FileRef {
  fileName: string;
  sourcePath: string;
  zipPath?: string;
}

/** Filters down to files whose source path is accessible on disk (local mode only). */
export async function filterAccessibleFiles(files: FileRef[]): Promise<FileRef[]> {
  if (config.storageMode !== "local") return [...files];
  const accessible: FileRef[] = [];
  for (const file of files) {
    if (!file.sourcePath) continue;
    try {
      await fs.access(path.join(config.localStorageDir, file.sourcePath));
      accessible.push(file);
    } catch {
      // file missing – skip
    }
  }
  return accessible;
}

/** Pipes a ZIP of the given files directly into `output` (e.g. an HTTP response). */
export async function streamZipToWritable(
  files: FileRef[],
  output: Writable,
  blobStorage: BlobStorageService
): Promise<void> {
  const archive = archiver("zip", { zlib: { level: 9 } });

  const done = new Promise<void>((resolve, reject) => {
    output.on("finish", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });

  archive.pipe(output);

  const usedNames = new Map<string, number>();
  for (const file of files) {
    const targetName = file.zipPath ?? file.fileName;
    const ext = path.extname(targetName);
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

