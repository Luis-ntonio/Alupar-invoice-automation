import { Storage } from "@google-cloud/storage";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config";

export class BlobStorageService {
  private storage: Storage | null = null;

  constructor() {
    if (config.storageMode === "gcp") {
      // ADC: en Cloud Run usa la service account del servicio.
      this.storage = new Storage();
    }
  }

  // En GCS los exports viven en su bucket; el resto (raw/, coes/) en el bucket raw.
  private gcsFile(storagePath: string) {
    if (!this.storage) {
      throw new Error("Cliente GCS no inicializado.");
    }
    const isExport = storagePath.startsWith("exports/");
    const bucketName = isExport ? config.exportsBucket : config.rawBucket;
    if (!bucketName) {
      throw new Error(
        isExport ? "GCS_BUCKET_EXPORTS no esta configurado." : "GCS_BUCKET_RAW no esta configurado."
      );
    }
    return this.storage.bucket(bucketName).file(storagePath);
  }

  async saveIncoming(buffer: Buffer, requestId: string, fileName: string): Promise<string> {
    const target = `raw/${requestId}/${Date.now()}-${sanitizeFileName(fileName)}`;
    return this.saveAtPath(buffer, target);
  }

  async saveAtPath(buffer: Buffer, storagePath: string): Promise<string> {
    if (config.storageMode === "gcp") {
      await this.gcsFile(storagePath).save(buffer);
      return storagePath;
    }

    const localTarget = path.join(config.localStorageDir, storagePath);
    await fs.mkdir(path.dirname(localTarget), { recursive: true });
    await fs.writeFile(localTarget, buffer);
    return storagePath;
  }

  async exists(storagePath: string): Promise<boolean> {
    if (config.storageMode === "gcp") {
      const [exists] = await this.gcsFile(storagePath).exists();
      return exists;
    }

    const localTarget = path.join(config.localStorageDir, storagePath);
    try {
      await fs.access(localTarget);
      return true;
    } catch {
      return false;
    }
  }

  async saveCoesMonthlyExcel(buffer: Buffer, year: number, month: number, fileName: string): Promise<string> {
    const monthPart = String(month).padStart(2, "0");
    const target = `coes/liquidaciones-vtea/${year}/${monthPart}/${sanitizeFileName(fileName)}`;
    return this.saveAtPath(buffer, target);
  }

  async readBuffer(storagePath: string): Promise<Buffer> {
    const stream = await this.openReadStream(storagePath);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async openReadStream(storagePath: string): Promise<Readable> {
    if (config.storageMode === "gcp") {
      return this.gcsFile(storagePath).createReadStream();
    }

    return createReadStream(path.join(config.localStorageDir, storagePath));
  }

  async delete(storagePath: string): Promise<void> {
    if (config.storageMode === "gcp") {
      await this.gcsFile(storagePath).delete({ ignoreNotFound: true });
      return;
    }

    const localTarget = path.join(config.localStorageDir, storagePath);
    await fs.rm(localTarget, { force: true });
  }

  async saveExport(localZipPath: string, requestId: string, concept: string): Promise<string> {
    const exportPath = `exports/${requestId}/${sanitizeFileName(concept)}.zip`;

    if (config.storageMode === "gcp") {
      await pipeline(createReadStream(localZipPath), this.gcsFile(exportPath).createWriteStream());
      return exportPath;
    }

    const localTarget = path.join(config.localStorageDir, exportPath);
    await fs.mkdir(path.dirname(localTarget), { recursive: true });
    await pipeline(createReadStream(localZipPath), createWriteStream(localTarget));
    return exportPath;
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
