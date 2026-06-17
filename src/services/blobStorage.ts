import { BlobServiceClient } from "@azure/storage-blob";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config";

export class BlobStorageService {
  private blobServiceClient: BlobServiceClient | null = null;

  constructor() {
    if (config.storageMode === "azure") {
      if (!config.azureStorageConnectionString) {
        throw new Error("AZURE_STORAGE_CONNECTION_STRING no esta configurado.");
      }
      this.blobServiceClient = BlobServiceClient.fromConnectionString(config.azureStorageConnectionString);
    }
  }

  private async getContainerClient(containerName: string) {
    if (!this.blobServiceClient) {
      throw new Error("Cliente Azure Blob no inicializado.");
    }
    const container = this.blobServiceClient.getContainerClient(containerName);
    await container.createIfNotExists();
    return container;
  }

  async saveIncoming(buffer: Buffer, requestId: string, fileName: string): Promise<string> {
    const target = `raw/${requestId}/${Date.now()}-${sanitizeFileName(fileName)}`;
    return this.saveAtPath(buffer, target);
  }

  async saveAtPath(buffer: Buffer, storagePath: string): Promise<string> {
    if (config.storageMode === "azure") {
      const container = await this.getContainerClient(config.azureStorageContainerRaw);
      const blockBlob = container.getBlockBlobClient(storagePath);
      await blockBlob.uploadData(buffer);
      return storagePath;
    }

    const localTarget = path.join(config.localStorageDir, storagePath);
    await fs.mkdir(path.dirname(localTarget), { recursive: true });
    await fs.writeFile(localTarget, buffer);
    return storagePath;
  }

  async exists(storagePath: string): Promise<boolean> {
    if (config.storageMode === "azure") {
      const container = await this.getContainerClient(config.azureStorageContainerRaw);
      const blockBlob = container.getBlockBlobClient(storagePath);
      return blockBlob.exists();
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

  async openReadStream(storagePath: string): Promise<Readable> {
    if (config.storageMode === "azure") {
      const container = await this.getContainerClient(config.azureStorageContainerRaw);
      const blob = container.getBlobClient(storagePath);
      const download = await blob.download();
      if (!download.readableStreamBody) {
        throw new Error(`No se pudo abrir stream para blob ${storagePath}.`);
      }
      return download.readableStreamBody as Readable;
    }

    return createReadStream(path.join(config.localStorageDir, storagePath));
  }

  async saveExport(localZipPath: string, requestId: string, concept: string): Promise<string> {
    const exportPath = `exports/${requestId}/${sanitizeFileName(concept)}.zip`;

    if (config.storageMode === "azure") {
      const container = await this.getContainerClient(config.azureStorageContainerExports);
      const blockBlob = container.getBlockBlobClient(exportPath);
      await blockBlob.uploadFile(localZipPath);
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
