"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const node_path_1 = __importDefault(require("node:path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function readEnum(value, allowed, fallback) {
    if (!value) {
        return fallback;
    }
    if (allowed.includes(value)) {
        return value;
    }
    return fallback;
}
exports.config = {
    port: Number(process.env.PORT ?? 8080),
    nodeEnv: process.env.NODE_ENV ?? "development",
    storageMode: readEnum(process.env.STORAGE_MODE, ["gcp", "local"], "local"),
    dbMode: readEnum(process.env.DB_MODE, ["firestore", "local"], "local"),
    gcpProject: process.env.GOOGLE_CLOUD_PROJECT,
    gcpLocation: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    documentAiLocation: process.env.DOCUMENT_AI_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us",
    rawBucket: process.env.GCS_BUCKET_RAW,
    exportsBucket: process.env.GCS_BUCKET_EXPORTS,
    firestoreCollection: process.env.FIRESTORE_COLLECTION ?? "documents",
    useDocumentAi: process.env.USE_DOCUMENT_AI === "true",
    documentAiProcessorId: process.env.DOCUMENT_AI_PROCESSOR_ID,
    documentAiProcessorVersion: process.env.DOCUMENT_AI_PROCESSOR_VERSION,
    workatoSharedSecret: process.env.WORKATO_SHARED_SECRET,
    localDataDir: node_path_1.default.resolve(process.env.LOCAL_DATA_DIR ?? "./data"),
    localStorageDir: node_path_1.default.resolve(process.env.LOCAL_STORAGE_DIR ?? "./storage")
};
