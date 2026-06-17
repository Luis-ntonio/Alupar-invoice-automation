"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlobStorageService = void 0;
const storage_blob_1 = require("@azure/storage-blob");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:stream/promises");
const config_1 = require("../config");
class BlobStorageService {
    blobServiceClient = null;
    constructor() {
        if (config_1.config.storageMode === "azure") {
            if (!config_1.config.azureStorageConnectionString) {
                throw new Error("AZURE_STORAGE_CONNECTION_STRING no esta configurado.");
            }
            this.blobServiceClient = storage_blob_1.BlobServiceClient.fromConnectionString(config_1.config.azureStorageConnectionString);
        }
    }
    async getContainerClient(containerName) {
        if (!this.blobServiceClient) {
            throw new Error("Cliente Azure Blob no inicializado.");
        }
        const container = this.blobServiceClient.getContainerClient(containerName);
        await container.createIfNotExists();
        return container;
    }
    async saveIncoming(buffer, requestId, fileName) {
        const target = `raw/${requestId}/${Date.now()}-${sanitizeFileName(fileName)}`;
        return this.saveAtPath(buffer, target);
    }
    async saveAtPath(buffer, storagePath) {
        if (config_1.config.storageMode === "azure") {
            const container = await this.getContainerClient(config_1.config.azureStorageContainerRaw);
            const blockBlob = container.getBlockBlobClient(storagePath);
            await blockBlob.uploadData(buffer);
            return storagePath;
        }
        const localTarget = node_path_1.default.join(config_1.config.localStorageDir, storagePath);
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(localTarget), { recursive: true });
        await node_fs_1.promises.writeFile(localTarget, buffer);
        return storagePath;
    }
    async exists(storagePath) {
        if (config_1.config.storageMode === "azure") {
            const container = await this.getContainerClient(config_1.config.azureStorageContainerRaw);
            const blockBlob = container.getBlockBlobClient(storagePath);
            return blockBlob.exists();
        }
        const localTarget = node_path_1.default.join(config_1.config.localStorageDir, storagePath);
        try {
            await node_fs_1.promises.access(localTarget);
            return true;
        }
        catch {
            return false;
        }
    }
    async saveCoesMonthlyExcel(buffer, year, month, fileName) {
        const monthPart = String(month).padStart(2, "0");
        const target = `coes/liquidaciones-vtea/${year}/${monthPart}/${sanitizeFileName(fileName)}`;
        return this.saveAtPath(buffer, target);
    }
    async openReadStream(storagePath) {
        if (config_1.config.storageMode === "azure") {
            const container = await this.getContainerClient(config_1.config.azureStorageContainerRaw);
            const blob = container.getBlobClient(storagePath);
            const download = await blob.download();
            if (!download.readableStreamBody) {
                throw new Error(`No se pudo abrir stream para blob ${storagePath}.`);
            }
            return download.readableStreamBody;
        }
        return (0, node_fs_1.createReadStream)(node_path_1.default.join(config_1.config.localStorageDir, storagePath));
    }
    async saveExport(localZipPath, requestId, concept) {
        const exportPath = `exports/${requestId}/${sanitizeFileName(concept)}.zip`;
        if (config_1.config.storageMode === "azure") {
            const container = await this.getContainerClient(config_1.config.azureStorageContainerExports);
            const blockBlob = container.getBlockBlobClient(exportPath);
            await blockBlob.uploadFile(localZipPath);
            return exportPath;
        }
        const localTarget = node_path_1.default.join(config_1.config.localStorageDir, exportPath);
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(localTarget), { recursive: true });
        await (0, promises_1.pipeline)((0, node_fs_1.createReadStream)(localZipPath), (0, node_fs_1.createWriteStream)(localTarget));
        return exportPath;
    }
}
exports.BlobStorageService = BlobStorageService;
function sanitizeFileName(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
