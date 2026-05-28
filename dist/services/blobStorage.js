"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlobStorageService = void 0;
const storage_1 = require("@google-cloud/storage");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:stream/promises");
const config_1 = require("../config");
class BlobStorageService {
    storage = null;
    constructor() {
        if (config_1.config.storageMode === "gcp") {
            this.storage = new storage_1.Storage();
        }
    }
    async saveIncoming(buffer, requestId, fileName) {
        const target = `raw/${requestId}/${Date.now()}-${sanitizeFileName(fileName)}`;
        if (config_1.config.storageMode === "gcp") {
            if (!config_1.config.rawBucket || !this.storage) {
                throw new Error("GCS_BUCKET_RAW no esta configurado.");
            }
            await this.storage.bucket(config_1.config.rawBucket).file(target).save(buffer);
            return target;
        }
        const localTarget = node_path_1.default.join(config_1.config.localStorageDir, target);
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(localTarget), { recursive: true });
        await node_fs_1.promises.writeFile(localTarget, buffer);
        return target;
    }
    async openReadStream(storagePath) {
        if (config_1.config.storageMode === "gcp") {
            if (!config_1.config.rawBucket || !this.storage) {
                throw new Error("GCS_BUCKET_RAW no esta configurado.");
            }
            return this.storage.bucket(config_1.config.rawBucket).file(storagePath).createReadStream();
        }
        return (0, node_fs_1.createReadStream)(node_path_1.default.join(config_1.config.localStorageDir, storagePath));
    }
    async saveExport(localZipPath, requestId, concept) {
        const exportPath = `exports/${requestId}/${sanitizeFileName(concept)}.zip`;
        if (config_1.config.storageMode === "gcp") {
            if (!config_1.config.exportsBucket || !this.storage) {
                throw new Error("GCS_BUCKET_EXPORTS no esta configurado.");
            }
            await (0, promises_1.pipeline)((0, node_fs_1.createReadStream)(localZipPath), this.storage.bucket(config_1.config.exportsBucket).file(exportPath).createWriteStream());
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
