import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export type StorageMode = "gcp" | "local";
export type DatabaseMode = "firestore" | "local";

function readEnum<T extends string>(
  value: string | undefined,
  allowed: T[],
  fallback: T
): T {
  if (!value) {
    return fallback;
  }
  if (allowed.includes(value as T)) {
    return value as T;
  }
  return fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  storageMode: readEnum<StorageMode>(process.env.STORAGE_MODE, ["gcp", "local"], "local"),
  dbMode: readEnum<DatabaseMode>(process.env.DB_MODE, ["firestore", "local"], "local"),
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
  enableWorkatoRemoteUrlsByDefault: process.env.ENABLE_WORKATO_REMOTE_URLS === "true",
  localDataDir: path.resolve(process.env.LOCAL_DATA_DIR ?? "./data"),
  localStorageDir: path.resolve(process.env.LOCAL_STORAGE_DIR ?? "./storage")
};
