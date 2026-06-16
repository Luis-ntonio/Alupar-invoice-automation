"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRepository = createRepository;
const firestore_1 = require("@google-cloud/firestore");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("../config");
class LocalJsonRepository {
    filePath = node_path_1.default.join(config_1.config.localDataDir, "documents.json");
    async ensureFile() {
        await node_fs_1.promises.mkdir(config_1.config.localDataDir, { recursive: true });
        try {
            await node_fs_1.promises.access(this.filePath);
        }
        catch {
            await node_fs_1.promises.writeFile(this.filePath, "[]", "utf-8");
        }
    }
    async readAll() {
        await this.ensureFile();
        const raw = await node_fs_1.promises.readFile(this.filePath, "utf-8");
        const cleaned = raw.replace(/^\uFEFF/, "").trim();
        return JSON.parse(cleaned || "[]");
    }
    async writeAll(records) {
        await this.ensureFile();
        await node_fs_1.promises.writeFile(this.filePath, JSON.stringify(records, null, 2), "utf-8");
    }
    async save(record) {
        const current = await this.readAll();
        const index = current.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
            current[index] = record;
        }
        else {
            current.push(record);
        }
        await this.writeAll(current);
    }
    async findById(id) {
        const current = await this.readAll();
        return current.find((entry) => entry.id === id) ?? null;
    }
    async findByMessageId(messageId) {
        const current = await this.readAll();
        return current.find((entry) => entry.metadata?.messageId === messageId) ?? null;
    }
    async list(filters) {
        const current = await this.readAll();
        if (!filters)
            return current;
        return current.filter((entry) => {
            if (filters.documentType && entry.documentType !== filters.documentType)
                return false;
            if (filters.concept && entry.concept !== filters.concept)
                return false;
            if (filters.status && entry.status !== filters.status)
                return false;
            return true;
        });
    }
}
class FirestoreRepository {
    firestore = new firestore_1.Firestore({ ignoreUndefinedProperties: true });
    collection = this.firestore.collection(config_1.config.firestoreCollection);
    async save(record) {
        await this.collection.doc(record.id).set(record, { merge: true });
    }
    async findById(id) {
        const snap = await this.collection.doc(id).get();
        if (!snap.exists)
            return null;
        return snap.data();
    }
    async findByMessageId(messageId) {
        const result = await this.collection
            .where("metadata.messageId", "==", messageId)
            .limit(1)
            .get();
        if (result.empty)
            return null;
        return result.docs[0].data();
    }
    async list(filters) {
        let query = this.collection;
        if (filters?.documentType)
            query = query.where("documentType", "==", filters.documentType);
        if (filters?.concept)
            query = query.where("concept", "==", filters.concept);
        if (filters?.status)
            query = query.where("status", "==", filters.status);
        const result = await query.get();
        return result.docs.map((doc) => doc.data());
    }
}
function createRepository() {
    return config_1.config.dbMode === "firestore" ? new FirestoreRepository() : new LocalJsonRepository();
}
