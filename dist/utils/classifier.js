"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeText = normalizeText;
exports.classifyDocument = classifyDocument;
exports.inferConcept = inferConcept;
const conceptRules = {
    peaje: ["peaje", "toll"],
    energia: ["energia", "electrico", "electricidad", "kwh"],
    transporte: ["transporte", "flete", "envio", "logistica"],
    servicios: ["servicio", "mantenimiento", "soporte"],
    otros: []
};
function normalizeText(input) {
    return input
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}
function classifyDocument(fields) {
    // Clasificación directa por código SUNAT (más confiable que buscar texto)
    if (fields.tipoDocumento) {
        const cod = fields.tipoDocumento.trim();
        if (cod === "01")
            return "factura";
        if (cod === "03")
            return "comprobante"; // Boleta
        if (cod === "07")
            return "nota"; // Nota de crédito
        if (cod === "08")
            return "nota"; // Nota de débito
    }
    const content = normalizeText([
        fields.rawTextSnippet,
        fields.numeroDocumento,
        fields.emisor,
        fields.receptor
    ]
        .filter(Boolean)
        .join(" "));
    if (content.includes("factura") || content.includes("invoice")) {
        return "factura";
    }
    if (content.includes("comprobante") || content.includes("boleta") || content.includes("receipt")) {
        return "comprobante";
    }
    if (content.includes("nota de credito") || content.includes("nota de debito") || content.includes("nota")) {
        return "nota";
    }
    return "desconocido";
}
function inferConcept(fields) {
    const content = normalizeText([fields.rawTextSnippet, fields.emisor, fields.receptor].filter(Boolean).join(" "));
    for (const [concept, keywords] of Object.entries(conceptRules)) {
        if (keywords.some((keyword) => content.includes(keyword))) {
            return concept;
        }
    }
    return "otros";
}
