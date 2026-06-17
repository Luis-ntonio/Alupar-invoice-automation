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
    storageMode: readEnum(process.env.STORAGE_MODE, ["azure", "local"], "local"),
    dbMode: readEnum(process.env.DB_MODE, ["cosmos", "local"], "local"),
    gcpProject: process.env.GOOGLE_CLOUD_PROJECT,
    gcpLocation: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    documentAiLocation: process.env.DOCUMENT_AI_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us",
    azureStorageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    azureStorageContainerRaw: process.env.AZURE_STORAGE_CONTAINER_RAW ?? "raw",
    azureStorageContainerExports: process.env.AZURE_STORAGE_CONTAINER_EXPORTS ?? "exports",
    azureCosmosEndpoint: process.env.AZURE_COSMOS_ENDPOINT,
    azureCosmosKey: process.env.AZURE_COSMOS_KEY,
    azureCosmosDatabase: process.env.AZURE_COSMOS_DATABASE ?? "facturasdb",
    azureCosmosContainer: process.env.AZURE_COSMOS_CONTAINER ?? "documents",
    useDocumentAi: process.env.USE_DOCUMENT_AI === "true",
    documentAiProcessorId: process.env.DOCUMENT_AI_PROCESSOR_ID,
    documentAiProcessorVersion: process.env.DOCUMENT_AI_PROCESSOR_VERSION,
    workatoSharedSecret: process.env.WORKATO_SHARED_SECRET,
    enableWorkatoRemoteUrlsByDefault: process.env.ENABLE_WORKATO_REMOTE_URLS === "true",
    coesValidationAutoSync: process.env.COES_VALIDATION_AUTO_SYNC !== "false",
    localDataDir: node_path_1.default.resolve(process.env.LOCAL_DATA_DIR ?? "./data"),
    localStorageDir: node_path_1.default.resolve(process.env.LOCAL_STORAGE_DIR ?? "./storage"),
    azureAdTenantId: process.env.AZURE_AD_TENANT_ID,
    azureAdClientId: process.env.AZURE_AD_CLIENT_ID,
    azureAdFrontendClientId: process.env.AZURE_AD_FRONTEND_CLIENT_ID,
    allowedDomains: process.env.ALLOWED_DOMAINS,
    allowedEmails: process.env.ALLOWED_EMAILS,
};
