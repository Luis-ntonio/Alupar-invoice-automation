import { Storage } from "@google-cloud/storage";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "../config";

export class BlobStorageService {
  private storage: Storage | null = null;

  constructor() {
    if (config.storageMode === "gcp") {
      this.storage = new Storage();
    }
  }

  async saveIncoming(buffer: Buffer, requestId: string, fileName: string): Promise<string> {
    const target = `raw/${requestId}/${Date.now()}-${sanitizeFileName(fileName)}`;

    if (config.storageMode === "gcp") {
      if (!config.rawBucket || !this.storage) {
        throw new Error("GCS_BUCKET_RAW no esta configurado.");
      }
      await this.storage.bucket(config.rawBucket).file(target).save(buffer);
      return target;
    }

    const localTarget = path.join(config.localStorageDir, target);
    await fs.mkdir(path.dirname(localTarget), { recursive: true });
    await fs.writeFile(localTarget, buffer);
    return target;
  }

  async openReadStream(storagePath: string) {
    if (config.storageMode === "gcp") {
      if (!config.rawBucket || !this.storage) {
        throw new Error("GCS_BUCKET_RAW no esta configurado.");
      }
      return this.storage.bucket(config.rawBucket).file(storagePath).createReadStream();
    }

    return createReadStream(path.join(config.localStorageDir, storagePath));
  }

  async saveExport(localZipPath: string, requestId: string, concept: string): Promise<string> {
    const exportPath = `exports/${requestId}/${sanitizeFileName(concept)}.zip`;

    if (config.storageMode === "gcp") {
      if (!config.exportsBucket || !this.storage) {
        throw new Error("GCS_BUCKET_EXPORTS no esta configurado.");
      }
      await pipeline(
        createReadStream(localZipPath),
        this.storage.bucket(config.exportsBucket).file(exportPath).createWriteStream()
      );
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
