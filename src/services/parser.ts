import pdfParse from "pdf-parse";
import { parseStringPromise } from "xml2js";
import { config } from "../config";
import { extractPdfWithDocumentAi } from "./documentAi";
import { ExtractedFields, SupportedFileType } from "../types";

export function detectFileType(fileName: string, mimeType: string): SupportedFileType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf") || mimeType.includes("pdf")) {
    return "pdf";
  }
  if (lower.endsWith(".xml") || mimeType.includes("xml") || mimeType.includes("text/plain")) {
    return "xml";
  }
  return "unknown";
}

export async function extractFields(
  fileType: SupportedFileType,
  buffer: Buffer,
  mimeType = ""
): Promise<ExtractedFields> {
  if (fileType === "pdf") {
    if (config.useDocumentAi) {
      return extractPdfWithDocumentAi(buffer, mimeType);
    }
    return extractFromPdf(buffer);
  }
  if (fileType === "xml") {
    return extractFromXml(buffer);
  }
  return { rawTextSnippet: "" };
}

async function extractFromPdf(buffer: Buffer): Promise<ExtractedFields> {
  const parsed = await pdfParse(buffer);
  const text = parsed.text ?? "";

  return {
    numeroDocumento: matchValue(text, /(factura|boleta|comprobante|doc\.?)[^\n\r\d]{0,20}(\d{3,}-?\d{2,})/i, 2),
    fechaEmision: matchValue(text, /(fecha\s*(de)?\s*emisi[oó]n?)\s*[:\-]?\s*(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/i, 3),
    fechaVencimiento: matchValue(text, /(vencimiento|vence)\s*[:\-]?\s*(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/i, 2),
    monto: parseAmount(matchValue(text, /(total|importe|monto)\s*[:\-]?\s*([\d.,]+)/i, 2)),
    rawTextSnippet: text.slice(0, 1000)
  };
}

async function extractFromXml(buffer: Buffer): Promise<ExtractedFields> {
  const xml = buffer.toString("utf-8").replace(/^\uFEFF/, "");
  const parsed = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, trim: true });

  // CDR (SUNAT ApplicationResponse) — confirmación de recepción, sin datos financieros
  if (parsed["ar:ApplicationResponse"] != null) {
    return { rawTextSnippet: xml.slice(0, 500) };
  }

  // Navigate UBL structure directly for reliable extraction
  const invoice = (parsed["Invoice"] ?? parsed) as Record<string, unknown>;
  const supplierParty = getPath(invoice, ["cac:AccountingSupplierParty", "cac:Party"]);
  const invoiceLine = invoice["cac:InvoiceLine"];
  const firstLine = Array.isArray(invoiceLine) ? invoiceLine[0] : invoiceLine;

  const emisor =
    getStringValue(getPath(supplierParty, ["cac:PartyName", "cbc:Name"])) ??
    getStringValue(getPath(supplierParty, ["cac:PartyLegalEntity", "cbc:RegistrationName"]));

  const ruc = getStringValue(getPath(supplierParty, ["cac:PartyIdentification", "cbc:ID"]));

  const concepto = getStringValue(getPath(firstLine, ["cac:Item", "cbc:Description"]));

  const monto = parseAmount(
    getStringValue(getPath(invoice, ["cac:LegalMonetaryTotal", "cbc:PayableAmount"])) ??
    findNodeValue(parsed, ["PayableAmount", "cbc:PayableAmount"])
  );

  return {
    numeroDocumento:
      getStringValue(invoice["cbc:ID"]) ?? findNodeValue(parsed, ["ID", "cbc:ID"]),
    fechaEmision:
      getStringValue(invoice["cbc:IssueDate"]) ?? findNodeValue(parsed, ["IssueDate", "cbc:IssueDate"]),
    fechaVencimiento:
      getStringValue(invoice["cbc:DueDate"]) ?? findNodeValue(parsed, ["DueDate", "cbc:DueDate"]),
    moneda: findNodeValue(parsed, ["DocumentCurrencyCode", "cbc:DocumentCurrencyCode", "moneda"]),
    monto,
    emisor,
    ruc,
    concepto,
    receptor: findNodeValue(parsed, ["CustomerAssignedAccountID", "receptor", "CustomerParty"]),
    rawTextSnippet: xml.slice(0, 1000)
  };
}

function matchValue(input: string, regex: RegExp, group = 1): string | undefined {
  const found = input.match(regex);
  return found?.[group]?.trim();
}

function parseAmount(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/[^\d.,-]/g, "").replace(/\.(?=.*\.)/g, "").replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function getPath(obj: unknown, path: string[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function getStringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const textNode = (value as Record<string, unknown>)._;
    if (typeof textNode === "string") return textNode || undefined;
    if (typeof textNode === "number") return String(textNode);
  }
  return undefined;
}

function findNodeValue(value: unknown, keys: string[]): string | undefined {
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

function recursiveFind(value: unknown, keys: Set<string>): unknown {
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

  const obj = value as Record<string, unknown>;
  for (const [key, node] of Object.entries(obj)) {
    if (keys.has(key)) {
      if (typeof node === "string" || typeof node === "number") {
        return node;
      }
      if (typeof node === "object" && node !== null) {
        const textNode = (node as Record<string, unknown>)._;
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
