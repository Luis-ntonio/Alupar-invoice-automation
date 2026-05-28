import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "./config";
import { BlobStorageService } from "./services/blobStorage";
import { detectFileType, extractFields } from "./services/parser";
import { createRepository } from "./services/repository";
import { filterAccessibleFiles, streamZipToWritable } from "./services/zipService";
import { classifyDocument, inferConcept } from "./utils/classifier";
import { createSha256 } from "./utils/hash";
import { AttachedFile, EmailRecord, IncomingMetadata } from "./types";

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const repository = createRepository();
const blobStorage = new BlobStorageService();

const metadataSchema = z.object({
  messageId: z.string().optional(),
  sender: z.string().optional(),
  subject: z.string().optional(),
  receivedAt: z.string().optional()
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "proyecto2-gcp-facturas", timestamp: new Date().toISOString() });
});

router.post("/intake", upload.fields([{ name: "files" }, { name: "files[]" }]), async (req, res) => {
  if (config.workatoSharedSecret) {
    const token = req.header("x-workato-secret");
    if (token !== config.workatoSharedSecret) {
      return res.status(401).json({ error: "No autorizado: x-workato-secret invalido." });
    }
  }

  const requestId = randomUUID();
  const reqFiles = req.files as Record<string, Express.Multer.File[]> | undefined;
  const files = [...(reqFiles?.["files"] ?? []), ...(reqFiles?.["files[]"] ?? [])];
  const metadataResult = metadataSchema.safeParse(req.body);
  const metadata: IncomingMetadata = metadataResult.success ? metadataResult.data : {};

  if (files.length === 0) {
    return res.status(400).json({ error: "No se recibieron archivos en el campo files." });
  }

  // Dedup: same messageId = same email, return existing record
  if (metadata.messageId) {
    const existing = await repository.findByMessageId(metadata.messageId);
    if (existing) {
      return res.status(202).json({ requestId: existing.id, accepted: 0, duplicate: true, record: existing });
    }
  }

  const now = new Date().toISOString();
  const attachedFiles: AttachedFile[] = [];
  let rejected = 0;

  for (const file of files) {
    const fileType = detectFileType(file.originalname, file.mimetype);
    if (fileType === "unknown") { rejected++; continue; }
    const hash = createSha256(file.buffer);
    const sourcePath = await blobStorage.saveIncoming(file.buffer, requestId, file.originalname);
    attachedFiles.push({ fileName: file.originalname, fileType, mimeType: file.mimetype, sourcePath, hash });
  }

  if (!attachedFiles.length) {
    return res.status(400).json({ error: "No se recibieron archivos PDF o XML válidos." });
  }

  // Extract structured data: prefer XML (reliable), fall back to PDF
  let extracted = {};
  let extractionError: string | undefined;
  try {
    const xmlFile = files.find(f => detectFileType(f.originalname, f.mimetype) === "xml");
    const pdfFile = files.find(f => detectFileType(f.originalname, f.mimetype) === "pdf");
    const best = xmlFile ?? pdfFile;
    if (best) {
      extracted = await extractFields(detectFileType(best.originalname, best.mimetype), best.buffer, best.mimetype);
    }
  } catch (err) {
    extractionError = err instanceof Error ? err.message : "Error de extracción";
  }

  const documentType = classifyDocument(extracted);
  const concept = (extracted as any).concepto ?? inferConcept(extracted);

  const record: EmailRecord = {
    id: requestId,
    metadata,
    files: attachedFiles,
    extracted,
    documentType,
    concept,
    empresa: (extracted as any).emisor ?? "",
    ruc: (extracted as any).ruc ?? "",
    status: extractionError ? "error" : "pendiente",
    error: extractionError,
    createdAt: now,
    updatedAt: now
  };

  await repository.save(record);
  return res.status(202).json({ requestId, accepted: attachedFiles.length, rejected, record });
});

router.get("/documents", async (req, res) => {
  const filters = {
    documentType: typeof req.query.documentType === "string" ? req.query.documentType : undefined,
    concept: typeof req.query.concept === "string" ? req.query.concept : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined
  };

  const docs = await repository.list(filters as any);
  docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ items: docs, count: docs.length });
});

router.get("/documents/:id", async (req, res) => {
  const item = await repository.findById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: "Documento no encontrado." });
  }
  return res.json(item);
});

// Download individual file (opens PDF inline, downloads XML)
router.get("/documents/:id/files/:filename", async (req, res) => {
  try {
    const item = await repository.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Registro no encontrado." });
    const file = item.files.find(f => f.fileName === req.params.filename);
    if (!file) return res.status(404).json({ error: "Archivo no encontrado." });
    const disposition = file.mimeType === "application/pdf" ? "inline" : "attachment";
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(file.fileName)}"`);
    const stream = await blobStorage.openReadStream(file.sourcePath);
    stream.pipe(res);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "No se pudo obtener el archivo." });
  }
});

// Download all files of a record (single file attachment, or ZIP for multiple)
router.get("/documents/:id/file", async (req, res) => {
  try {
    const item = await repository.findById(req.params.id);
    if (!item || !item.files.length) {
      return res.status(404).json({ error: "Registro no encontrado." });
    }
    if (item.files.length === 1) {
      const f = item.files[0];
      res.setHeader("Content-Type", f.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(f.fileName)}"`);
      const stream = await blobStorage.openReadStream(f.sourcePath);
      stream.pipe(res);
    } else {
      const allRefs = item.files.map(f => ({ fileName: f.fileName, sourcePath: f.sourcePath }));
      const accessible = await filterAccessibleFiles(allRefs);
      if (!accessible.length) return res.status(422).json({ error: "Ningún archivo físico encontrado." });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(item.id)}.zip"`);
      await streamZipToWritable(accessible, res, blobStorage);
    }
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "No se pudo obtener el archivo." });
  }
});

router.post("/exports", async (req, res) => {
  const ids: unknown = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Se requiere un array de IDs en el campo ids." });
  }

  const records: EmailRecord[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const rec = await repository.findById(id);
    if (rec) records.push(rec);
  }

  if (!records.length) {
    return res.status(404).json({ error: "No se encontraron registros para los IDs indicados." });
  }

  // Collect all files from all selected records
  const allRefs = records.flatMap(r => r.files.map(f => ({ fileName: f.fileName, sourcePath: f.sourcePath })));
  const accessible = await filterAccessibleFiles(allRefs);
  const skipped = allRefs.length - accessible.length;

  if (!accessible.length) {
    return res.status(422).json({ error: "Ningún archivo físico encontrado." });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="export-${dateStr}.zip"`);
  if (skipped > 0) res.setHeader("X-Skipped-Count", String(skipped));

  try {
    await streamZipToWritable(accessible, res, blobStorage);
  } catch (error) {
    console.error("Error streaming ZIP:", error);
    return;
  }

  const now = new Date().toISOString();
  for (const rec of records) {
    await repository.save({ ...rec, status: "procesado", updatedAt: now });
  }
});

export default router;
