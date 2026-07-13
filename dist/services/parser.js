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
function detectFileType(fileName, mimeType, buffer) {
    // Magic bytes take priority when available — more reliable than metadata from Workato.
    // ZIP = PK\x03\x04 (0x504B0304), PDF = %PDF (0x25504446)
    if (buffer && buffer.length >= 4) {
        if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04)
            return "zip";
        if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46)
            return "pdf";
    }
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".pdf") || mimeType.includes("pdf"))
        return "pdf";
    if (lower.endsWith(".xml") || mimeType.includes("xml") || mimeType.includes("text/plain"))
        return "xml";
    if (lower.endsWith(".zip") || mimeType.includes("zip"))
        return "zip";
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
    // Detectar encoding desde la declaración XML antes de convertir a string.
    // Los primeros 200 bytes son siempre ASCII (la declaración XML usa solo ASCII).
    const xmlHeader = buffer.slice(0, 200).toString("ascii");
    const encodingMatch = xmlHeader.match(/encoding=["']([^"']+)["']/i);
    const encodingRaw = (encodingMatch?.[1] ?? "utf-8").toLowerCase();
    // Node.js no reconoce "iso-8859-1" directamente; se usa "latin1" que es equivalente.
    const nodeEncoding = encodingRaw === "iso-8859-1" || encodingRaw === "iso8859-1" || encodingRaw === "latin-1"
        ? "latin1"
        : "utf-8";
    const xml = buffer.toString(nodeEncoding).replace(/^\uFEFF/, "");
    const parsed = await (0, xml2js_1.parseStringPromise)(xml, { explicitArray: false, mergeAttrs: true, trim: true });
    // CDR (SUNAT ApplicationResponse) — confirmación de recepción, sin datos financieros
    if (parsed["ar:ApplicationResponse"] != null) {
        return { rawTextSnippet: xml.slice(0, 500) };
    }
    const document = getBusinessDocument(parsed);
    const supplierParty = getPath(document, ["cac:AccountingSupplierParty", "cac:Party"]);
    const firstLine = getFirstDocumentLine(document);
    const emisor = getStringValue(getPath(supplierParty, ["cac:PartyName", "cbc:Name"])) ??
        getStringValue(getPath(supplierParty, ["cac:PartyLegalEntity", "cbc:RegistrationName"]));
    const ruc = getStringValue(getPath(supplierParty, ["cac:PartyIdentification", "cbc:ID"]));
    const concepto = getStringValue(getPath(firstLine, ["cac:Item", "cbc:Description"]));
    const monto = parseAmount(getStringValue(getPath(document, ["cac:LegalMonetaryTotal", "cbc:PayableAmount"])) ??
        getStringValue(getPath(document, ["cac:RequestedMonetaryTotal", "cbc:PayableAmount"])) ??
        findNodeValue(parsed, ["PayableAmount", "cbc:PayableAmount"]));
    return {
        numeroDocumento: getStringValue(findChild(document, "ID")) ?? findNodeValue(parsed, ["ID", "cbc:ID"]),
        fechaEmision: getStringValue(findChild(document, "IssueDate")) ?? findNodeValue(parsed, ["IssueDate", "cbc:IssueDate"]),
        fechaVencimiento: getStringValue(findChild(document, "DueDate")) ?? findNodeValue(parsed, ["DueDate", "cbc:DueDate"]),
        moneda: findNodeValue(parsed, ["DocumentCurrencyCode", "cbc:DocumentCurrencyCode", "moneda"]),
        monto,
        emisor,
        ruc,
        concepto,
        tipoDocumento: getStringValue(findChild(document, "InvoiceTypeCode")) ??
            getDocumentTypeFallback(parsed, document) ??
            findNodeValue(parsed, ["InvoiceTypeCode", "cbc:InvoiceTypeCode"]),
        receptor: findNodeValue(parsed, ["CustomerAssignedAccountID", "receptor", "CustomerParty"]),
        rawTextSnippet: xml.slice(0, 1000)
    };
}
function getBusinessDocument(parsed) {
    const document = parsed["Invoice"] ?? parsed["DebitNote"] ?? parsed["CreditNote"] ?? parsed;
    return (document ?? parsed);
}
// Algunos emisores (ej. generadoras electricas) declaran namespaces UBL con
// prefijos alternativos (n1:/n2:) en vez de cac:/cbc: para los mismos elementos.
// findChild compara solo el nombre local, ignorando el prefijo usado.
function localName(key) {
    const idx = key.indexOf(":");
    return idx >= 0 ? key.slice(idx + 1) : key;
}
function findChild(obj, name) {
    if (obj === null || obj === undefined || typeof obj !== "object")
        return undefined;
    const rec = obj;
    if (name in rec)
        return rec[name];
    for (const key of Object.keys(rec)) {
        if (localName(key) === name)
            return rec[key];
    }
    return undefined;
}
function getFirstDocumentLine(document) {
    const line = findChild(document, "InvoiceLine") ??
        findChild(document, "DebitNoteLine") ??
        findChild(document, "CreditNoteLine");
    return Array.isArray(line) ? line[0] : line;
}
function getDocumentTypeFallback(parsed, document) {
    if (parsed["DebitNote"] != null) {
        return "08";
    }
    // Las notas de credito UBL rara vez traen cbc:CreditNoteTypeCode; el tipo lo
    // determina el elemento raiz <CreditNote>. Se mapea a "07" (nota de credito).
    if (parsed["CreditNote"] != null) {
        return "07";
    }
    return (getStringValue(findChild(document, "CreditNoteTypeCode")) ??
        getStringValue(findChild(document, "DebitNoteTypeCode")) ??
        findNodeValue(parsed, ["CreditNoteTypeCode", "cbc:CreditNoteTypeCode", "DebitNoteTypeCode", "cbc:DebitNoteTypeCode"]));
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
function getPath(obj, path) {
    let current = obj;
    for (const key of path) {
        current = findChild(current, localName(key));
        if (current === undefined)
            return undefined;
    }
    return current;
}
function getStringValue(value) {
    if (value === null || value === undefined)
        return undefined;
    if (Array.isArray(value)) {
        const values = value
            .map((item) => getStringValue(item)?.replace(/&#10;|\r?\n/g, " ").trim())
            .filter((item) => Boolean(item));
        if (values.length === 0)
            return undefined;
        return values.join(" | ");
    }
    if (typeof value === "string")
        return value || undefined;
    if (typeof value === "number")
        return String(value);
    if (typeof value === "object") {
        const textNode = value._;
        if (typeof textNode === "string")
            return textNode || undefined;
        if (typeof textNode === "number")
            return String(textNode);
    }
    return undefined;
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
        if (keys.has(key) || keys.has(localName(key))) {
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
