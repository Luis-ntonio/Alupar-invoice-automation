import archiver from "archiver";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { config } from "../config";
import { BlobStorageService } from "./blobStorage";

export interface FileRef {
  fileName: string;
  sourcePath: string;
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
    const ext = path.extname(file.fileName);
    const base = path.basename(file.fileName, ext);
    const seen = (usedNames.get(file.fileName) ?? 0) + 1;
    usedNames.set(file.fileName, seen);
    const name = seen > 1 ? `${base}_${seen}${ext}` : file.fileName;

    const stream = await blobStorage.openReadStream(file.sourcePath);
    archive.append(stream, { name });
  }

  await archive.finalize();
  await done;
}

