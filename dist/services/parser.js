"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectFileType = detectFileType;
exports.extractFields = extractFields;
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const xml2js_1 = require("xml2js");
const config_1 = require("../config");
const documentAi_1 = require("./documentAi");
function detectFileType(fileName, mimeType) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".pdf") || mimeType.includes("pdf")) {
        return "pdf";
    }
    if (lower.endsWith(".xml") || mimeType.includes("xml") || mimeType.includes("text/plain")) {
        return "xml";
    }
    return "unknown";
}
async function extractFields(fileType, buffer, mimeType = "") {
    if (fileType === "pdf") {
        if (config_1.config.useDocumentAi) {
            return (0, documentAi_1.extractPdfWithDocumentAi)(buffer, mimeType);
        }
        return extractFromPdf(buffer);
    }
    if (fileType === "xml") {
        return extractFromXml(buffer);
    }
    return { rawTextSnippet: "" };
}
async function extractFromPdf(buffer) {
    const parsed = await (0, pdf_parse_1.default)(buffer);
    const text = parsed.text ?? "";
    return {
        numeroDocumento: matchValue(text, /(factura|boleta|comprobante|doc\.?)[^\n\r\d]{0,20}(\d{3,}-?\d{2,})/i, 2),
        fechaEmision: matchValue(text, /(fecha\s*(de)?\s*emisi[oó]n?)\s*[:\-]?\s*(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/i, 3),
        fechaVencimiento: matchValue(text, /(vencimiento|vence)\s*[:\-]?\s*(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/i, 2),
        monto: parseAmount(matchValue(text, /(total|importe|monto)\s*[:\-]?\s*([\d.,]+)/i, 2)),
        rawTextSnippet: text.slice(0, 1000)
    };
}
async function extractFromXml(buffer) {
    const xml = buffer.toString("utf-8");
    const parsed = await (0, xml2js_1.parseStringPromise)(xml, { explicitArray: false, mergeAttrs: true, trim: true });
    return {
        numeroDocumento: findNodeValue(parsed, ["ID", "cbc:ID", "numero", "Numero"]),
        fechaEmision: findNodeValue(parsed, ["IssueDate", "cbc:IssueDate", "fecha_emision", "FechaEmision"]),
        fechaVencimiento: findNodeValue(parsed, ["DueDate", "cbc:DueDate", "fecha_vencimiento", "FechaVencimiento"]),
        moneda: findNodeValue(parsed, ["DocumentCurrencyCode", "cbc:DocumentCurrencyCode", "moneda"]),
        monto: parseAmount(findNodeValue(parsed, [
            "PayableAmount",
            "cbc:PayableAmount",
            "LegalMonetaryTotal",
            "monto_total",
            "TotalAmount"
        ])),
        emisor: findNodeValue(parsed, ["RegistrationName", "cbc:RegistrationName", "emisor", "SupplierParty"]),
        receptor: findNodeValue(parsed, ["CustomerAssignedAccountID", "receptor", "CustomerParty"]),
        rawTextSnippet: xml.slice(0, 1000)
    };
}
function matchValue(input, regex, group = 1) {
    const found = input.match(regex);
    return found?.[group]?.trim();
}
function parseAmount(raw) {
    if (!raw) {
        return undefined;
    }
    const normalized = raw.replace(/[^\d.,-]/g, "").replace(/\.(?=.*\.)/g, "").replace(",", ".");
    const value = Number(normalized);
    return Number.isFinite(value) ? value : undefined;
}
function findNodeValue(value, keys) {
    const found = recursiveFind(value, new Set(keys));
    if (found === undefined || found === null) {
        return undefined;
    }
    if (typeof found === "string") {
        return found;
    }
    if (typeof found === "number") {
        return String(found);
    }
    return undefined;
}
function recursiveFind(value, keys) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "object") {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = recursiveFind(item, keys);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }
    const obj = value;
    for (const [key, node] of Object.entries(obj)) {
        if (keys.has(key)) {
            if (typeof node === "string" || typeof node === "number") {
                return node;
            }
            if (typeof node === "object" && node !== null) {
                const textNode = node._;
                if (typeof textNode === "string" || typeof textNode === "number") {
                    return textNode;
                }
            }
        }
        const nested = recursiveFind(node, keys);
        if (nested !== undefined) {
            return nested;
        }
    }
    return undefined;
}
