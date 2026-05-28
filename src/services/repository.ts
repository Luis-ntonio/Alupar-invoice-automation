import { Firestore } from "@google-cloud/firestore";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { EmailRecord } from "../types";

export interface RecordRepository {
  save(record: EmailRecord): Promise<void>;
  findById(id: string): Promise<EmailRecord | null>;
  findByMessageId(messageId: string): Promise<EmailRecord | null>;
  list(filters?: Partial<Pick<EmailRecord, "documentType" | "concept" | "status">>): Promise<EmailRecord[]>;
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
}

class FirestoreRepository implements RecordRepository {
  private readonly firestore = new Firestore();
  private readonly collection = this.firestore.collection(config.firestoreCollection);

  async save(record: EmailRecord): Promise<void> {
    await this.collection.doc(record.id).set(record, { merge: true });
  }

  async findById(id: string): Promise<EmailRecord | null> {
    const snap = await this.collection.doc(id).get();
    if (!snap.exists) return null;
    return snap.data() as EmailRecord;
  }

  async findByMessageId(messageId: string): Promise<EmailRecord | null> {
    const result = await this.collection
      .where("metadata.messageId", "==", messageId)
      .limit(1)
      .get();
    if (result.empty) return null;
    return result.docs[0].data() as EmailRecord;
  }

  async list(filters?: Partial<Pick<EmailRecord, "documentType" | "concept" | "status">>): Promise<EmailRecord[]> {
    let query: FirebaseFirestore.Query = this.collection;
    if (filters?.documentType) query = query.where("documentType", "==", filters.documentType);
    if (filters?.concept) query = query.where("concept", "==", filters.concept);
    if (filters?.status) query = query.where("status", "==", filters.status);
    const result = await query.get();
    return result.docs.map((doc) => doc.data() as EmailRecord);
  }
}

export function createRepository(): RecordRepository {
  return config.dbMode === "firestore" ? new FirestoreRepository() : new LocalJsonRepository();
}
