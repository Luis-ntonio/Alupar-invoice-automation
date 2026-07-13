import { Container, CosmosClient, SqlQuerySpec } from "@azure/cosmos";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { EmailRecord } from "../types";

export interface RecordRepository {
  save(record: EmailRecord): Promise<void>;
  findById(id: string): Promise<EmailRecord | null>;
  findByMessageId(messageId: string): Promise<EmailRecord | null>;
  list(filters?: Partial<Pick<EmailRecord, "documentType" | "concept" | "status">>): Promise<EmailRecord[]>;
  delete(id: string, empresa: string): Promise<void>;
}

class LocalJsonRepository implements RecordRepository {
  private readonly filePath = path.join(config.localDataDir, "documents.json");

  private async ensureFile(): Promise<void> {
    await fs.mkdir(config.localDataDir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "[]", "utf-8");
    }
  }

  private async readAll(): Promise<EmailRecord[]> {
    await this.ensureFile();
    const raw = await fs.readFile(this.filePath, "utf-8");
    const cleaned = raw.replace(/^\uFEFF/, "").trim();
    return JSON.parse(cleaned || "[]") as EmailRecord[];
  }

  private async writeAll(records: EmailRecord[]): Promise<void> {
    await this.ensureFile();
    await fs.writeFile(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }

  async save(record: EmailRecord): Promise<void> {
    const current = await this.readAll();
    const index = current.findIndex((entry) => entry.id === record.id);
    if (index >= 0) {
      current[index] = record;
    } else {
      current.push(record);
    }
    await this.writeAll(current);
  }

  async findById(id: string): Promise<EmailRecord | null> {
    const current = await this.readAll();
    return current.find((entry) => entry.id === id) ?? null;
  }

  async findByMessageId(messageId: string): Promise<EmailRecord | null> {
    const current = await this.readAll();
    return current.find((entry) => entry.metadata?.messageId === messageId) ?? null;
  }

  async list(filters?: Partial<Pick<EmailRecord, "documentType" | "concept" | "status">>): Promise<EmailRecord[]> {
    const current = await this.readAll();
    if (!filters) return current;
    return current.filter((entry) => {
      if (filters.documentType && entry.documentType !== filters.documentType) return false;
      if (filters.concept && entry.concept !== filters.concept) return false;
      if (filters.status && entry.status !== filters.status) return false;
      return true;
    });
  }

  async delete(id: string): Promise<void> {
    const current = await this.readAll();
    await this.writeAll(current.filter((entry) => entry.id !== id));
  }
}

class CosmosRepository implements RecordRepository {
  private readonly client: CosmosClient;
  private containerPromise: Promise<Container> | null = null;

  constructor() {
    if (!config.azureCosmosEndpoint || !config.azureCosmosKey) {
      throw new Error("AZURE_COSMOS_ENDPOINT o AZURE_COSMOS_KEY no estan configurados.");
    }
    this.client = new CosmosClient({
      endpoint: config.azureCosmosEndpoint,
      key: config.azureCosmosKey
    });
  }

  private async getContainer(): Promise<Container> {
    if (!this.containerPromise) {
      this.containerPromise = (async () => {
        const { database } = await this.client.databases.createIfNotExists({
          id: config.azureCosmosDatabase
        });
        const { container } = await database.containers.createIfNotExists({
          id: config.azureCosmosContainer,
          partitionKey: { paths: ["/empresa"] }
        });
        return container;
      })();
    }
    return this.containerPromise;
  }

  async save(record: EmailRecord): Promise<void> {
    const container = await this.getContainer();
    await container.items.upsert(record);
  }

  async findById(id: string): Promise<EmailRecord | null> {
    const container = await this.getContainer();
    const querySpec: SqlQuerySpec = {
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }]
    };
    const { resources } = await container.items
      .query<EmailRecord>(querySpec)
      .fetchAll();
    return resources[0] ?? null;
  }

  async findByMessageId(messageId: string): Promise<EmailRecord | null> {
    const container = await this.getContainer();
    const querySpec: SqlQuerySpec = {
      query: "SELECT TOP 1 * FROM c WHERE c.metadata.messageId = @messageId",
      parameters: [{ name: "@messageId", value: messageId }]
    };
    const { resources } = await container.items
      .query<EmailRecord>(querySpec)
      .fetchAll();
    return resources[0] ?? null;
  }

  async list(filters?: Partial<Pick<EmailRecord, "documentType" | "concept" | "status">>): Promise<EmailRecord[]> {
    const container = await this.getContainer();
    const clauses: string[] = [];
    const parameters: { name: string; value: string }[] = [];

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
    const querySpec: SqlQuerySpec = {
      query: `SELECT * FROM c${where}`,
      parameters
    };

    const { resources } = await container.items
      .query<EmailRecord>(querySpec)
      .fetchAll();
    return resources;
  }

  async delete(id: string, empresa: string): Promise<void> {
    const container = await this.getContainer();
    await container.item(id, empresa).delete();
  }
}

export function createRepository(): RecordRepository {
  return config.dbMode === "cosmos" ? new CosmosRepository() : new LocalJsonRepository();
}
