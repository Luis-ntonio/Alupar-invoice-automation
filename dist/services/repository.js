"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRepository = createRepository;
const cosmos_1 = require("@azure/cosmos");
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
    async delete(id) {
        const current = await this.readAll();
        await this.writeAll(current.filter((entry) => entry.id !== id));
    }
}
class CosmosRepository {
    client;
    containerPromise = null;
    constructor() {
        if (!config_1.config.azureCosmosEndpoint || !config_1.config.azureCosmosKey) {
            throw new Error("AZURE_COSMOS_ENDPOINT o AZURE_COSMOS_KEY no estan configurados.");
        }
        this.client = new cosmos_1.CosmosClient({
            endpoint: config_1.config.azureCosmosEndpoint,
            key: config_1.config.azureCosmosKey
        });
    }
    async getContainer() {
        if (!this.containerPromise) {
            this.containerPromise = (async () => {
                const { database } = await this.client.databases.createIfNotExists({
                    id: config_1.config.azureCosmosDatabase
                });
                const { container } = await database.containers.createIfNotExists({
                    id: config_1.config.azureCosmosContainer,
                    partitionKey: { paths: ["/empresa"] }
                });
                return container;
            })();
        }
        return this.containerPromise;
    }
    async save(record) {
        const container = await this.getContainer();
        await container.items.upsert(record);
    }
    async findById(id) {
        const container = await this.getContainer();
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: id }]
        };
        const { resources } = await container.items
            .query(querySpec)
            .fetchAll();
        return resources[0] ?? null;
    }
    async findByMessageId(messageId) {
        const container = await this.getContainer();
        const querySpec = {
            query: "SELECT TOP 1 * FROM c WHERE c.metadata.messageId = @messageId",
            parameters: [{ name: "@messageId", value: messageId }]
        };
        const { resources } = await container.items
            .query(querySpec)
            .fetchAll();
        return resources[0] ?? null;
    }
    async list(filters) {
        const container = await this.getContainer();
        const clauses = [];
        const parameters = [];
        if (filters?.documentType) {
            clauses.push("c.documentType = @documentType");
            parameters.push({ name: "@documentType", value: filters.documentType });
        }
        if (filters?.concept) {
            clauses.push("c.concept = @concept");
            parameters.push({ name: "@concept", value: filters.concept });
        }
        if (filters?.status) {
            clauses.push("c.status = @status");
            parameters.push({ name: "@status", value: filters.status });
        }
        const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
        const querySpec = {
            query: `SELECT * FROM c${where}`,
            parameters
        };
        const { resources } = await container.items
            .query(querySpec)
            .fetchAll();
        return resources;
    }
    async delete(id, empresa) {
        const container = await this.getContainer();
        await container.item(id, empresa).delete();
    }
}
function createRepository() {
    return config_1.config.dbMode === "cosmos" ? new CosmosRepository() : new LocalJsonRepository();
}
