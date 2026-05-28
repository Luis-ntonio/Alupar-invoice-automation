"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractPdfWithDocumentAi = extractPdfWithDocumentAi;
const documentai_1 = require("@google-cloud/documentai");
const config_1 = require("../config");
let client = null;
function getClient() {
    if (!client) {
        client = new documentai_1.DocumentProcessorServiceClient();
    }
    return client;
}
function buildProcessorName() {
    if (!config_1.config.gcpProject || !config_1.config.documentAiLocation || !config_1.config.documentAiProcessorId) {
        throw new Error("Faltan variables de Document AI: GOOGLE_CLOUD_PROJECT, DOCUMENT_AI_LOCATION o DOCUMENT_AI_PROCESSOR_ID.");
    }
    const base = `projects/${config_1.config.gcpProject}/locations/${config_1.config.documentAiLocation}/processors/${config_1.config.documentAiProcessorId}`;
    if (config_1.config.documentAiProcessorVersion) {
        return `${base}/processorVersions/${config_1.config.documentAiProcessorVersion}`;
    }
    return base;
}
async function extractPdfWithDocumentAi(buffer, mimeType) {
    const docAiClient = getClient();
    const name = buildProcessorName();
    const [result] = await docAiClient.processDocument({
        name,
        rawDocument: {
            content: buffer.toString("base64"),
            mimeType: mimeType || "application/pdf"
        }
    });
    const document = result.document;
    const text = document?.text ?? "";
    const entities = document?.entities ?? [];
    const byType = new Map();
    for (const entity of entities) {
        if (!entity.type) {
            continue;
        }
        byType.set(entity.type.toLowerCase(), entity.mentionText ?? "");
    }
    const montoRaw = byType.get("total_amount") ??
        byType.get("amount_due") ??
        byType.get("invoice_total") ??
        undefined;
    return {
        numeroDocumento: byType.get("invoice_id") ??
            byType.get("invoice_number") ??
            byType.get("id") ??
            undefined,
        fechaEmision: byType.get("invoice_date") ??
            byType.get("issue_date") ??
            undefined,
        fechaVencimiento: byType.get("due_date") ??
            undefined,
        monto: parseAmount(montoRaw),
        moneda: byType.get("currency") ??
            byType.get("currency_code") ??
            undefined,
        emisor: byType.get("supplier_name") ??
            byType.get("vendor_name") ??
            undefined,
        receptor: byType.get("customer_name") ??
            byType.get("buyer_name") ??
            undefined,
        rawTextSnippet: text.slice(0, 1000)
    };
}
function parseAmount(raw) {
    if (!raw) {
        return undefined;
    }
    const normalized = raw.replace(/[^\d.,-]/g, "").replace(/\.(?=.*\.)/g, "").replace(",", ".");
    const value = Number(normalized);
    return Number.isFinite(value) ? value : undefined;
}
