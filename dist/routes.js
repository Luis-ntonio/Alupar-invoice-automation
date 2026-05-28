"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const config_1 = require("./config");
const blobStorage_1 = require("./services/blobStorage");
const parser_1 = require("./services/parser");
const repository_1 = require("./services/repository");
const zipService_1 = require("./services/zipService");
const classifier_1 = require("./utils/classifier");
const hash_1 = require("./utils/hash");
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
const router = express_1.default.Router();
const repository = (0, repository_1.createRepository)();
const blobStorage = new blobStorage_1.BlobStorageService();
const metadataSchema = zod_1.z.object({
    messageId: zod_1.z.string().optional(),
    sender: zod_1.z.string().optional(),
    subject: zod_1.z.string().optional(),
    receivedAt: zod_1.z.string().optional()
});
router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "proyecto2-gcp-facturas", timestamp: new Date().toISOString() });
});
router.post("/intake", upload.array("files"), async (req, res) => {
    if (config_1.config.workatoSharedSecret) {
        const token = req.header("x-workato-secret");
        if (token !== config_1.config.workatoSharedSecret) {
            return res.status(401).json({ error: "No autorizado: x-workato-secret invalido." });
        }
    }
    const requestId = (0, node_crypto_1.randomUUID)();
    const files = req.files ?? [];
    const metadataResult = metadataSchema.safeParse(req.body);
    const metadata = metadataResult.success ? metadataResult.data : {};
    if (files.length === 0) {
        return res.status(400).json({ error: "No se recibieron archivos en el campo files." });
    }
    const response = {
        requestId,
        accepted: 0,
        rejected: 0,
        documents: []
    };
    for (const file of files) {
        const fileType = (0, parser_1.detectFileType)(file.originalname, file.mimetype);
        if (fileType === "unknown") {
            response.rejected += 1;
            continue;
        }
        const hash = (0, hash_1.createSha256)(file.buffer);
        const duplicated = await repository.findByHash(hash);
        if (duplicated) {
            response.documents.push(duplicated);
            continue;
        }
        const now = new Date().toISOString();
        const id = (0, node_crypto_1.randomUUID)();
        try {
            const sourcePath = await blobStorage.saveIncoming(file.buffer, requestId, file.originalname);
            const extracted = await (0, parser_1.extractFields)(fileType, file.buffer, file.mimetype);
            const documentType = (0, classifier_1.classifyDocument)(extracted);
            const concept = (0, classifier_1.inferConcept)(extracted);
            const document = {
                id,
                fileName: file.originalname,
                fileType,
                mimeType: file.mimetype,
                hash,
                sourcePath,
                metadata,
                extracted,
                documentType,
                concept,
                status: "procesado",
                createdAt: now,
                updatedAt: now
            };
            await repository.save(document);
            response.documents.push(document);
            response.accepted += 1;
        }
        catch (error) {
            const failed = {
                id,
                fileName: file.originalname,
                fileType,
                mimeType: file.mimetype,
                hash,
                sourcePath: "",
                metadata,
                extracted: {},
                documentType: "desconocido",
                concept: "otros",
                status: "error",
                error: error instanceof Error ? error.message : "Error desconocido",
                createdAt: now,
                updatedAt: now
            };
            await repository.save(failed);
            response.documents.push(failed);
            response.rejected += 1;
        }
    }
    return res.status(202).json(response);
});
router.get("/documents", async (req, res) => {
    const filters = {
        documentType: typeof req.query.documentType === "string" ? req.query.documentType : undefined,
        concept: typeof req.query.concept === "string" ? req.query.concept : undefined,
        status: typeof req.query.status === "string" ? req.query.status : undefined
    };
    const docs = await repository.list(filters);
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
router.post("/exports/:concept", async (req, res) => {
    const concept = req.params.concept;
    const requestId = (0, node_crypto_1.randomUUID)();
    const docs = await repository.list({ concept, status: "procesado" });
    if (!docs.length) {
        return res.status(404).json({ error: `No hay documentos procesados para el concepto ${concept}.` });
    }
    const exportPath = await (0, zipService_1.generateZipByConcept)(docs, concept, requestId, blobStorage);
    return res.status(201).json({ requestId, concept, count: docs.length, exportPath });
});
exports.default = router;
