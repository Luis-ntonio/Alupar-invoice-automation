"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const config_1 = require("./config");
const blobStorage_1 = require("./services/blobStorage");
const parser_1 = require("./services/parser");
const repository_1 = require("./services/repository");
const coesService_1 = require("./services/coesService");
const centroCostosService_1 = require("./services/centroCostosService");
const centroCostosCatalog_1 = require("./services/centroCostosCatalog");
const sunatService_1 = require("./services/sunatService");
const zipService_1 = require("./services/zipService");
const classifier_1 = require("./utils/classifier");
const hash_1 = require("./utils/hash");
const auth_1 = require("./middleware/auth");
const realtime_1 = require("./services/realtime");
// fieldSize de 100MB: Workato envía archivos como hex en campos de texto
// (1 byte → 2 chars hex), por lo que un PDF ocupa ~2x como texto. Con 100MB
// caben PDFs de ~50MB antes de que multer trunque el campo silenciosamente.
// Trade-off: memoryStorage retiene todo el payload en RAM del Container App,
// asi que subir mucho mas este limite presiona la memoria de la instancia.
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fieldSize: 100 * 1024 * 1024 } });
const router = express_1.default.Router();
const repository = (0, repository_1.createRepository)();
const blobStorage = new blobStorage_1.BlobStorageService();
const metadataSchema = zod_1.z.object({
    messageId: zod_1.z.string().optional(),
    sender: zod_1.z.string().optional(),
    subject: zod_1.z.string().optional(),
    receivedAt: zod_1.z.string().optional(),
    bodyHtml: zod_1.z.string().optional(),
    bodyText: zod_1.z.string().optional(),
    body: zod_1.z.string().optional(),
    html: zod_1.z.string().optional(),
    emailBodyHtml: zod_1.z.string().optional()
});
function parseBooleanFlag(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    if (typeof value !== "string")
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "si";
}
// ── Workato hex-binary helpers ───────────────────────────────────────────────
function hexToBuffer(hex) {
    const raw = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
    // Decodifica solo el tramo hex contiguo desde el inicio.
    // Evita "rescatar" dígitos sueltos de sufijos tipo "...(5333 bytes more)",
    // que corrompen el binario.
    let i = 0;
    let out = "";
    while (i < raw.length) {
        const ch = raw[i];
        if (/[0-9a-fA-F]/.test(ch)) {
            out += ch;
            i++;
            continue;
        }
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        break;
    }
    if (out.length === 0)
        return Buffer.alloc(0);
    const even = out.length % 2 === 0 ? out : out.slice(0, -1);
    if (i < raw.length) {
        console.warn(`[hexToBuffer] Payload hex truncado en índice ${i}; se ignoró sufijo no-hex.`);
    }
    if (even.length !== out.length) {
        console.warn("[hexToBuffer] Longitud hex impar detectada, se recorta el último nibble.");
    }
    return Buffer.from(even, "hex");
}
function makeWorkatoFile(originalname, mimetype, buffer) {
    return {
        fieldname: "files",
        originalname,
        encoding: "7bit",
        mimetype,
        buffer,
        size: buffer.length,
        stream: null,
        destination: "",
        filename: originalname,
        path: "",
    };
}
function normalizeWorkatoFileEntry(dataObj) {
    return {
        value: typeof dataObj["value"] === "string" ? dataObj["value"] : undefined,
        content_type: typeof dataObj["content_type"] === "string"
            ? dataObj["content_type"]
            : typeof dataObj["contentType"] === "string"
                ? dataObj["contentType"]
                : undefined,
        original_filename: typeof dataObj["original_filename"] === "string"
            ? dataObj["original_filename"]
            : typeof dataObj["originalFilename"] === "string"
                ? dataObj["originalFilename"]
                : undefined,
        url: typeof dataObj["url"] === "string"
            ? dataObj["url"]
            : typeof dataObj["download_url"] === "string"
                ? dataObj["download_url"]
                : typeof dataObj["downloadUrl"] === "string"
                    ? dataObj["downloadUrl"]
                    : undefined,
    };
}
function inferFilenameFromUrl(fileUrl) {
    try {
        const pathname = new URL(fileUrl).pathname;
        const name = node_path_1.default.basename(pathname);
        return name || "file";
    }
    catch {
        return "file";
    }
}
// Extrae el filename de un header Content-Disposition (soporta filename*= y filename=).
// Los portales (ej. efacturacion.pe) mandan aqui un nombre limpio como
// "20600217721-01-FF02-5353.pdf", mucho mejor que el original_filename de Workato.
function parseContentDispositionFilename(cd) {
    if (!cd)
        return undefined;
    const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    if (star) {
        try {
            return decodeURIComponent(star[1].replace(/["']/g, "").trim());
        }
        catch { /* ignore */ }
    }
    const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (plain)
        return plain[1].trim();
    return undefined;
}
// Sanitiza un nombre de archivo para que sea seguro como ruta de Blob y como
// segmento de URL. Critico: los separadores de ruta (/ y \) rompen la ruta de
// descarga /documents/:id/files/:filename (el request cae al catch-all y se
// devuelve el index.html del dashboard en vez del archivo). Tambien elimina los
// caracteres ilegales en Windows/Blob. Ademas fuerza una extension coherente con
// el tipo real detectado por magic bytes.
function sanitizeStoredFileName(name, fileType) {
    let clean = (name || "file")
        .replace(/[/\\]+/g, "_") // separadores de ruta
        .replace(/[:*?"<>|]/g, "_") // ilegales en Windows
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f]/g, "") // caracteres de control
        .replace(/\s+/g, " ")
        .replace(/_+/g, "_")
        .trim();
    if (!clean)
        clean = "file";
    const ext = fileType === "pdf" ? ".pdf" : fileType === "xml" ? ".xml" : fileType === "zip" ? ".zip" : "";
    if (ext && !clean.toLowerCase().endsWith(ext)) {
        // Quitar cualquier "seudo-extension" basura al final (ej. ".application_pdf;charset=...").
        clean = clean.replace(/\.[^.\s]{0,40}$/i, "");
        clean = (clean.trim() || "file") + ext;
    }
    return clean;
}
// Detecta respuestas que NO son el archivo esperado sino una pagina HTML: el
// login/redireccion de un portal, o el propio SPA del dashboard servido por el
// fallback catch-all (app.get("*") -> index.html) cuando la URL apunta a este
// mismo servicio. Sin esto, ese HTML se guardaba como .pdf y se abria en blanco.
// Devuelve un mensaje de error si el contenido es invalido, o null si es valido.
function validateRemoteFileContent(buffer, contentType, originalname) {
    const head = buffer.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
    const isXmlHead = head.startsWith("<?xml") || head.startsWith("<invoice") || head.startsWith("<creditnote") || head.startsWith("<debitnote");
    const looksHtml = head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<head") || head.includes("<body");
    const htmlByHeader = contentType.toLowerCase().includes("text/html") && !isXmlHead;
    if (looksHtml || htmlByHeader) {
        return "la URL devolvio una pagina HTML (login/redireccion del portal o el SPA del dashboard), no el archivo binario";
    }
    // Si el archivo dice ser PDF (por nombre o content-type), exigir la firma %PDF.
    const claimsPdf = originalname.toLowerCase().endsWith(".pdf") || contentType.toLowerCase().includes("pdf");
    const isPdf = buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
    if (claimsPdf && !isPdf) {
        return "el contenido no empieza con la firma %PDF (PDF invalido o truncado)";
    }
    return null;
}
async function downloadWorkatoRemoteFile(ref) {
    const timeoutMs = 30000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(ref.url, { signal: controller.signal, redirect: "follow" });
        if (!response.ok) {
            console.warn(`[downloadWorkatoRemoteFile] ${response.status} al descargar ${ref.url}`);
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length === 0) {
            console.warn(`[downloadWorkatoRemoteFile] Archivo vacío descargado desde ${ref.url}`);
            return null;
        }
        const responseContentType = response.headers.get("content-type") ?? "";
        const mimeType = ref.mimetype || responseContentType.split(";")[0] || "application/octet-stream";
        // Preferencia de nombre: Content-Disposition del portal (limpio, ej.
        // "20600217721-01-FF02-5353.pdf") > original_filename de Workato (que puede
        // venir basura, ej. "...TicketID:[...].application/pdf;charset=ISO-8859-1") >
        // inferido de la URL. Luego se sanitiza para que sea seguro como ruta/URL.
        const dispositionName = parseContentDispositionFilename(response.headers.get("content-disposition"));
        const rawName = dispositionName || ref.originalname || inferFilenameFromUrl(response.url || ref.url);
        const contentError = validateRemoteFileContent(buffer, responseContentType, rawName);
        if (contentError) {
            const snippet = buffer.subarray(0, 200).toString("latin1").replace(/\s+/g, " ").trim();
            console.warn(`[downloadWorkatoRemoteFile] Descarga rechazada (${rawName}): ${contentError}. ` +
                `url=${ref.url} urlFinal=${response.url} status=${response.status} content-type="${responseContentType}" inicio="${snippet}"`);
            return null;
        }
        const fileType = (0, parser_1.detectFileType)(rawName, mimeType, buffer);
        const originalname = sanitizeStoredFileName(rawName, fileType);
        console.log(`[downloadWorkatoRemoteFile] OK ${originalname} (${mimeType}, ${buffer.length}B)`);
        return makeWorkatoFile(originalname, mimeType, buffer);
    }
    catch (err) {
        console.warn(`[downloadWorkatoRemoteFile] Error descargando ${ref.url}: ${err}`);
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function downloadWorkatoRemoteFiles(refs) {
    const files = [];
    for (const ref of refs) {
        const file = await downloadWorkatoRemoteFile(ref);
        if (file)
            files.push(file);
    }
    return files;
}
/** Convierte un valor (hex 0x…, texto ASCII/UTF-8, o string decodificado de Ruby inspect) a Buffer. */
function valueToBuffer(val) {
    if (val.startsWith("0x") || val.startsWith("0X"))
        return hexToBuffer(val);
    // latin1 (= binary) preserva bytes 0x00–0xFF sin alteración.
    // Es correcto tanto para strings decodificados de Ruby inspect (\xNN → char)
    // como para texto ASCII puro (XML, CSV, etc.).
    return Buffer.from(val, "latin1");
}
/**
 * Parser mínimo para el formato Ruby Hash#inspect.
 *
 * Workato serializa arrays de objetos con binarios usando este formato
 * cuando el campo está marcado como no-binario en el esquema HTTP connector.
 * Ejemplo: [{"data"=>{"content_type"=>"application/pdf", "value"=>"%PDF...", "original_filename"=>"file.pdf"}}]
 *
 * Soporta: strings con \xNN, \", \\, \r, \n, \t; arrays []; hashes {}; nil/true/false; números.
 */
function parseRubyValue(input, pos) {
    // skip whitespace
    while (pos.i < input.length && (input[pos.i] === " " || input[pos.i] === "\t" || input[pos.i] === "\r" || input[pos.i] === "\n"))
        pos.i++;
    if (pos.i >= input.length)
        return undefined;
    const ch = input[pos.i];
    if (ch === '"') {
        pos.i++; // skip opening "
        const parts = [];
        while (pos.i < input.length) {
            const c = input[pos.i];
            if (c === '"') {
                pos.i++;
                return parts.join("");
            } // closing "
            if (c === '\\' && pos.i + 1 < input.length) {
                pos.i++;
                const e = input[pos.i];
                if (e === 'x' && pos.i + 2 < input.length) {
                    // \xNN — byte en hex, puede ser no-ASCII
                    pos.i++;
                    const hex = input.slice(pos.i, pos.i + 2);
                    pos.i += 2;
                    parts.push(String.fromCharCode(parseInt(hex, 16)));
                }
                else {
                    const ESC = { n: "\n", r: "\r", t: "\t", '"': '"', '\\': '\\', '0': "\0" };
                    parts.push(ESC[e] ?? e);
                    pos.i++;
                }
            }
            else {
                parts.push(c);
                pos.i++;
            }
        }
        return parts.join("");
    }
    if (ch === '[') {
        pos.i++;
        const arr = [];
        while (pos.i < input.length) {
            while (pos.i < input.length && (input[pos.i] === " " || input[pos.i] === "\t" || input[pos.i] === "\r" || input[pos.i] === "\n"))
                pos.i++;
            if (input[pos.i] === ']') {
                pos.i++;
                break;
            }
            arr.push(parseRubyValue(input, pos));
            while (pos.i < input.length && (input[pos.i] === " " || input[pos.i] === "\t" || input[pos.i] === "\r" || input[pos.i] === "\n"))
                pos.i++;
            if (pos.i < input.length && input[pos.i] === ',')
                pos.i++;
        }
        return arr;
    }
    if (ch === '{') {
        pos.i++;
        const obj = {};
        while (pos.i < input.length) {
            while (pos.i < input.length && (input[pos.i] === " " || input[pos.i] === "\t" || input[pos.i] === "\r" || input[pos.i] === "\n"))
                pos.i++;
            if (input[pos.i] === '}') {
                pos.i++;
                break;
            }
            const key = parseRubyValue(input, pos);
            while (pos.i < input.length && (input[pos.i] === " " || input[pos.i] === "\t" || input[pos.i] === "\r" || input[pos.i] === "\n"))
                pos.i++;
            if (pos.i < input.length && input[pos.i] === '=')
                pos.i += 2; // skip =>
            while (pos.i < input.length && (input[pos.i] === " " || input[pos.i] === "\t" || input[pos.i] === "\r" || input[pos.i] === "\n"))
                pos.i++;
            obj[key] = parseRubyValue(input, pos);
            while (pos.i < input.length && (input[pos.i] === " " || input[pos.i] === "\t" || input[pos.i] === "\r" || input[pos.i] === "\n"))
                pos.i++;
            if (pos.i < input.length && input[pos.i] === ',')
                pos.i++;
        }
        return obj;
    }
    if (input.startsWith("nil", pos.i)) {
        pos.i += 3;
        return null;
    }
    if (input.startsWith("true", pos.i)) {
        pos.i += 4;
        return true;
    }
    if (input.startsWith("false", pos.i)) {
        pos.i += 5;
        return false;
    }
    // Número
    const numStart = pos.i;
    if (input[pos.i] === '-')
        pos.i++;
    while (pos.i < input.length && ((input[pos.i] >= '0' && input[pos.i] <= '9') || input[pos.i] === '.'))
        pos.i++;
    if (pos.i > numStart)
        return parseFloat(input.slice(numStart, pos.i));
    pos.i++; // skip carácter desconocido
    return undefined;
}
/**
 * Extrae archivos del body de una request Workato (multipart/form-data).
 *
 * Workato puede enviar el array `files` de varias formas:
 *
 *   A) body["files"] es un ARRAY pre-parseado por express.urlencoded/qs
 *      (ocurre cuando Workato serializa el array como campos anidados).
 *      Cada elemento: { data: { value: "0x…", content_type: "…", original_filename: "…" } }
 *
 *   B) body["files"] es un JSON string que se puede parsear a array.
 *      Mismo formato interior que A.
 *
 *   C) Campos planos con bracket notation:
 *      body["files[0][data][value]"] = "0x…"
 *      body["files[0][data][content_type]"] = "application/pdf"
 *      body["files[0][data][original_filename]"] = "file.pdf"
 *
 *   D) body["files[0][data]"] = objeto ya parseado o JSON string con { value, content_type, original_filename }
 *
 * En todos los casos `value` puede ser "0x…" (binario hex) o texto plano UTF-8.
 */
function extractWorkatoFiles(body) {
    const result = [];
    const tag = "[extractWorkatoFiles]";
    // Dump de claves del body para diagnóstico
    const bodyKeysSummary = Object.keys(body).map(k => {
        const v = body[k];
        const typeStr = Array.isArray(v) ? `Array(${v.length})` : typeof v;
        return `${k}:${typeStr}`;
    });
    console.log(tag, "bodyKeys:", JSON.stringify(bodyKeysSummary));
    // ── Formatos A y B: body["files"] como array o JSON string ────────────────
    let filesField = body["files"];
    console.log(tag, "body.files type:", Array.isArray(filesField) ? `Array(${filesField.length})` : typeof filesField);
    if (typeof filesField === "string") {
        const filesStr = filesField;
        console.log(tag, "body.files es string, prefijo:", filesStr.substring(0, 80));
        try {
            filesField = JSON.parse(filesStr);
            console.log(tag, "JSON.parse OK, tipo:", Array.isArray(filesField) ? `Array(${filesField.length})` : typeof filesField);
        }
        catch {
            if (filesStr.includes("=>")) {
                // Formato Ruby Hash inspect: Workato serializa el array con =>, \xNN para binarios
                console.log(tag, "Formato Ruby Hash detectado (contiene =>), parseando con parseRubyValue...");
                try {
                    const pos = { i: 0 };
                    filesField = parseRubyValue(filesStr, pos);
                    console.log(tag, "parseRubyValue OK, tipo:", Array.isArray(filesField) ? `Array(${filesField.length})` : typeof filesField);
                }
                catch (e2) {
                    console.log(tag, "parseRubyValue fall\u00f3:", e2.message);
                    filesField = undefined;
                }
            }
            else {
                console.log(tag, "JSON.parse fall\u00f3 y no es Ruby hash.");
                filesField = undefined;
            }
        }
    }
    if (Array.isArray(filesField)) {
        console.log(tag, `Formato A/B: procesando ${filesField.length} items`);
        for (let i = 0; i < filesField.length; i++) {
            const item = filesField[i];
            const d = item?.data ?? item;
            console.log(tag, `  item[${i}]: tipo d=${typeof d}, keys=${d && typeof d === "object" ? JSON.stringify(Object.keys(d)) : String(d).substring(0, 80)}`);
            let dataObj;
            if (typeof d === "string") {
                try {
                    dataObj = JSON.parse(d);
                }
                catch (e) {
                    console.log(tag, `  item[${i}] d es string pero JSON.parse falló:`, e.message);
                    continue;
                }
            }
            else if (d && typeof d === "object") {
                dataObj = d;
            }
            else {
                console.log(tag, `  item[${i}] d no es string ni objeto, skip`);
                continue;
            }
            const rawValue = dataObj["value"];
            console.log(tag, `  item[${i}] value type=${typeof rawValue}, hasValue=${!!rawValue}, ` +
                `prefix=${typeof rawValue === "string" ? rawValue.substring(0, 10) : "N/A"}`);
            if (!rawValue || typeof rawValue !== "string") {
                console.log(tag, `  item[${i}] sin value, skip`);
                continue;
            }
            const buffer = valueToBuffer(rawValue);
            console.log(tag, `  item[${i}] buffer.length=${buffer.length}`);
            if (buffer.length === 0) {
                console.log(tag, `  item[${i}] buffer vacío, skip`);
                continue;
            }
            const fileName = (dataObj["original_filename"] ?? dataObj["originalFilename"] ?? "file");
            const mimeType = (dataObj["content_type"] ?? dataObj["contentType"] ?? "application/octet-stream");
            console.log(tag, `  item[${i}] OK → ${fileName} (${mimeType}, ${buffer.length}B)`);
            result.push(makeWorkatoFile(fileName, mimeType, buffer));
        }
        console.log(tag, `Formato A/B terminó con ${result.length} archivos`);
        if (result.length)
            return result;
    }
    else {
        console.log(tag, "body.files no es array, probando formatos C/D...");
    }
    const fileMapD = new Map();
    for (const [key, val] of Object.entries(body)) {
        const m = key.match(/^files\[(\d+)\]\[data\]$/);
        if (!m)
            continue;
        console.log(tag, `Formato D: encontrado key="${key}" tipo=${typeof val}`);
        const idx = Number(m[1]);
        let parsed = val;
        if (typeof val === "string") {
            try {
                parsed = JSON.parse(val);
            }
            catch {
                console.log(tag, `  Formato D key ${key} JSON.parse falló`);
                continue;
            }
        }
        if (parsed && typeof parsed === "object") {
            fileMapD.set(idx, parsed);
        }
    }
    if (fileMapD.size > 0) {
        console.log(tag, `Formato D: ${fileMapD.size} entradas`);
        for (const [, entry] of [...fileMapD.entries()].sort((a, b) => a[0] - b[0])) {
            if (!entry.value) {
                console.log(tag, "  Formato D entry sin value, skip");
                continue;
            }
            const buffer = valueToBuffer(entry.value);
            if (buffer.length === 0)
                continue;
            result.push(makeWorkatoFile(entry.original_filename ?? "file", entry.content_type ?? "application/octet-stream", buffer));
        }
        if (result.length)
            return result;
    }
    // ── Formato C: bracket notation files[N][data][prop] como campos planos ───
    const fileMapC = new Map();
    for (const [key, val] of Object.entries(body)) {
        const m = key.match(/^files\[(\d+)\]\[data\]\[(.+)\]$/);
        if (!m || typeof val !== "string")
            continue;
        console.log(tag, `Formato C: key="${key}"`);
        const idx = Number(m[1]);
        const prop = m[2];
        if (!fileMapC.has(idx))
            fileMapC.set(idx, {});
        const entry = fileMapC.get(idx);
        if (prop === "value")
            entry.value = val;
        else if (prop === "content_type")
            entry.content_type = val;
        else if (prop === "original_filename")
            entry.original_filename = val;
    }
    if (fileMapC.size > 0) {
        console.log(tag, `Formato C: ${fileMapC.size} entradas`);
    }
    for (const [, entry] of [...fileMapC.entries()].sort((a, b) => a[0] - b[0])) {
        if (!entry.value)
            continue;
        const buffer = valueToBuffer(entry.value);
        if (buffer.length === 0)
            continue;
        result.push(makeWorkatoFile(entry.original_filename ?? "file", entry.content_type ?? "application/octet-stream", buffer));
    }
    console.log(tag, `Total extraídos: ${result.length}`);
    return result;
}
function extractWorkatoRemoteFileRefs(body) {
    const result = [];
    const tag = "[extractWorkatoRemoteFileRefs]";
    const pushRef = (entry, source) => {
        if (!entry.url)
            return;
        const originalname = entry.original_filename ?? inferFilenameFromUrl(entry.url);
        const mimetype = entry.content_type ?? "application/octet-stream";
        console.log(tag, `${source} OK → ${originalname} (${mimetype}) ${entry.url}`);
        result.push({ url: entry.url, originalname, mimetype });
    };
    let filesField = body["files"];
    if (typeof filesField === "string") {
        const filesStr = filesField;
        try {
            filesField = JSON.parse(filesStr);
        }
        catch {
            if (filesStr.includes("=>")) {
                try {
                    const pos = { i: 0 };
                    filesField = parseRubyValue(filesStr, pos);
                }
                catch {
                    filesField = undefined;
                }
            }
            else {
                filesField = undefined;
            }
        }
    }
    if (Array.isArray(filesField)) {
        for (let i = 0; i < filesField.length; i++) {
            const item = filesField[i];
            const d = item?.data ?? item;
            let dataObj;
            if (typeof d === "string") {
                try {
                    dataObj = JSON.parse(d);
                }
                catch {
                    continue;
                }
            }
            else if (d && typeof d === "object") {
                dataObj = d;
            }
            if (!dataObj)
                continue;
            pushRef(normalizeWorkatoFileEntry(dataObj), `item[${i}]`);
        }
        if (result.length)
            return result;
    }
    const fileMapD = new Map();
    for (const [key, val] of Object.entries(body)) {
        const m = key.match(/^files\[(\d+)\]\[data\]$/);
        if (!m)
            continue;
        let parsed = val;
        if (typeof val === "string") {
            try {
                parsed = JSON.parse(val);
            }
            catch {
                continue;
            }
        }
        if (parsed && typeof parsed === "object") {
            fileMapD.set(Number(m[1]), normalizeWorkatoFileEntry(parsed));
        }
    }
    for (const [idx, entry] of [...fileMapD.entries()].sort((a, b) => a[0] - b[0])) {
        pushRef(entry, `Formato D[${idx}]`);
    }
    if (result.length)
        return result;
    const fileMapC = new Map();
    for (const [key, val] of Object.entries(body)) {
        const m = key.match(/^files\[(\d+)\]\[data\]\[(.+)\]$/);
        if (!m || typeof val !== "string")
            continue;
        const idx = Number(m[1]);
        const prop = m[2];
        if (!fileMapC.has(idx))
            fileMapC.set(idx, {});
        const entry = fileMapC.get(idx);
        if (prop === "value")
            entry.value = val;
        else if (prop === "content_type")
            entry.content_type = val;
        else if (prop === "original_filename")
            entry.original_filename = val;
        else if (prop === "url" || prop === "download_url" || prop === "downloadUrl")
            entry.url = val;
    }
    for (const [idx, entry] of [...fileMapC.entries()].sort((a, b) => a[0] - b[0])) {
        pushRef(entry, `Formato C[${idx}]`);
    }
    return result;
}
function ensureAuthorized(req, options) {
    if (!config_1.config.workatoSharedSecret) {
        return { authorized: true };
    }
    const token = req.header("x-workato-secret");
    if (options?.allowWhenSecretMissingInRequest && !token) {
        return { authorized: true };
    }
    if (token !== config_1.config.workatoSharedSecret) {
        return { authorized: false, response: { statusCode: 401, body: { error: "No autorizado: x-workato-secret invalido." } } };
    }
    return { authorized: true };
}
function pickStringField(value) {
    if (typeof value === "string" && value.trim())
        return value.trim();
    return undefined;
}
function normalizeIncomingMetadata(body) {
    const bodyNorm = { ...body, receivedAt: body.receivedAt ?? body.recievedAt };
    const metadataResult = metadataSchema.safeParse(bodyNorm);
    if (!metadataResult.success)
        return {};
    const data = metadataResult.data;
    const emailBodyHtml = data.bodyHtml ?? data.emailBodyHtml ?? data.html ?? data.body;
    const bodyText = data.bodyText;
    const sender = pickStringField(data.sender) ??
        pickStringField(body.from) ??
        pickStringField(body.From) ??
        pickStringField(body.emailFrom) ??
        pickStringField(body.remitente) ??
        pickStringField(body.senderEmail);
    if (!sender) {
        console.warn("[intake] metadata.sender no llego en el body. Campos recibidos:", Object.keys(body));
    }
    return {
        ...data,
        sender,
        bodyHtml: emailBodyHtml,
        bodyText,
        body: data.body,
        html: data.html,
        emailBodyHtml: data.emailBodyHtml,
    };
}
async function collectIncomingFiles(req) {
    const useRemoteFiles = parseBooleanFlag(req.body?.useRemoteFiles) ||
        parseBooleanFlag(req.body?.useRemoteUrls) ||
        parseBooleanFlag(req.body?.downloadRemoteFiles) ||
        config_1.config.enableWorkatoRemoteUrlsByDefault;
    const multerFiles = req.files ?? [];
    const workatoFiles = extractWorkatoFiles(req.body);
    const workatoRemoteRefs = extractWorkatoRemoteFileRefs(req.body);
    const downloadedRemoteFiles = useRemoteFiles ? await downloadWorkatoRemoteFiles(workatoRemoteRefs) : [];
    if (workatoRemoteRefs.length > 0 && !useRemoteFiles) {
        console.log("[intake] Se recibieron URLs remotas, pero useRemoteFiles=false; se ignoran para preservar el flujo actual.");
    }
    return {
        files: [...multerFiles, ...workatoFiles, ...downloadedRemoteFiles],
        useRemoteFiles,
        workatoRemoteRefs,
    };
}
function buildNoFilesResponse(req, useRemoteFiles, workatoRemoteRefs) {
    const multerFiles = req.files ?? [];
    const bodyKeys = Object.keys(req.body ?? {});
    const bodyDebug = bodyKeys.map((k) => {
        const v = req.body[k];
        const typeStr = Array.isArray(v) ? `Array(${v.length})` : typeof v;
        const preview = typeof v === "string" ? v.substring(0, 60) : JSON.stringify(v).substring(0, 60);
        return { key: k.substring(0, 80), type: typeStr, preview };
    });
    console.error("[intake] 0 archivos recibidos.", JSON.stringify({
        contentType: req.headers["content-type"]?.substring(0, 200),
        multerFileFields: multerFiles.map((f) => f.fieldname),
        bodyKeyCount: bodyKeys.length,
        bodyDebug,
    }));
    return {
        error: "No se recibieron archivos en el campo files.",
        debug: {
            contentType: req.headers["content-type"]?.substring(0, 200),
            multerFileCount: multerFiles.length,
            useRemoteFiles,
            workatoRemoteRefCount: workatoRemoteRefs.length,
            bodyKeyCount: bodyKeys.length,
            bodyKeys: bodyKeys.map((k) => k.substring(0, 80)),
            bodySample: bodyDebug.slice(0, 10),
        },
    };
}
async function expandSupportedFiles(files) {
    const expandedFiles = [];
    for (const file of files) {
        if ((0, parser_1.detectFileType)(file.originalname, file.mimetype, file.buffer) === "zip") {
            try {
                const extracted = await (0, zipService_1.extractZipContents)(file.buffer);
                if (extracted.length === 0) {
                    console.warn(`[intake] ZIP vacío o sin XML/PDF: ${file.originalname}, se trata como archivo directo.`);
                    expandedFiles.push(file);
                }
                else {
                    for (const inner of extracted) {
                        expandedFiles.push(makeWorkatoFile(inner.fileName, inner.mimeType, inner.buffer));
                    }
                }
            }
            catch (zipErr) {
                console.warn(`[intake] Fallo al extraer ZIP "${file.originalname}": ${zipErr}. Se trata como archivo directo.`);
                expandedFiles.push(file);
            }
        }
        else {
            expandedFiles.push(file);
        }
    }
    return expandedFiles;
}
// Detecta si un XML es un CDR de SUNAT (<ApplicationResponse>, a veces con
// prefijo ar:). El nombre del elemento raiz es ASCII y aparece al inicio del
// documento, asi que basta inspeccionar el encabezado sin parsear todo el XML.
function isSunatCdr(buffer) {
    const head = buffer.toString("latin1", 0, 2048);
    return /<(?:\w+:)?ApplicationResponse[\s>]/.test(head);
}
async function processIntakeFiles(files, metadata) {
    if (metadata.messageId) {
        const existing = await repository.findByMessageId(metadata.messageId);
        if (existing) {
            return {
                statusCode: 202,
                body: { requestId: existing.id, accepted: 0, rejected: 0, duplicate: true, record: existing },
            };
        }
    }
    const requestId = (0, node_crypto_1.randomUUID)();
    const now = new Date().toISOString();
    const expandedFiles = await expandSupportedFiles(files);
    const attachedFiles = [];
    let rejected = 0;
    for (const file of expandedFiles) {
        const fileType = (0, parser_1.detectFileType)(file.originalname, file.mimetype, file.buffer);
        if (fileType === "unknown") {
            rejected++;
            continue;
        }
        const hash = (0, hash_1.createSha256)(file.buffer);
        // Sanitizar el nombre antes de guardarlo: un "/" u otro caracter raro en el
        // nombre rompe la ruta de descarga /documents/:id/files/:filename (cae al
        // catch-all y devuelve el HTML del dashboard -> "PDF en blanco"). Se aplica a
        // TODOS los origenes (adjunto hex, descarga remota, ZIP) como red de seguridad.
        const safeName = sanitizeStoredFileName(file.originalname, fileType);
        const sourcePath = await blobStorage.saveIncoming(file.buffer, requestId, safeName);
        attachedFiles.push({ fileName: safeName, fileType, mimeType: file.mimetype, sourcePath, hash });
    }
    if (!attachedFiles.length) {
        return { statusCode: 400, body: { error: "No se recibieron archivos PDF o XML válidos." } };
    }
    let extracted = {};
    let extractionError;
    try {
        const xmlFiles = expandedFiles.filter((f) => (0, parser_1.detectFileType)(f.originalname, f.mimetype, f.buffer) === "xml");
        // El CDR (ApplicationResponse de SUNAT) no trae datos financieros y solo
        // devuelve rawTextSnippet; se excluye del merge para no pisar el snippet de
        // la factura real. El archivo del CDR se guarda igual como adjunto.
        const invoiceXmlFiles = xmlFiles.filter((f) => !isSunatCdr(f.buffer));
        const pdfFile = expandedFiles.find((f) => (0, parser_1.detectFileType)(f.originalname, f.mimetype, f.buffer) === "pdf");
        if (invoiceXmlFiles.length > 0) {
            for (const xmlFile of invoiceXmlFiles) {
                const result = await (0, parser_1.extractFields)("xml", xmlFile.buffer, xmlFile.mimetype);
                for (const [k, v] of Object.entries(result)) {
                    if (v !== undefined && v !== null && v !== "") {
                        extracted[k] = v;
                    }
                }
            }
        }
        else if (pdfFile) {
            extracted = await (0, parser_1.extractFields)("pdf", pdfFile.buffer, pdfFile.mimetype);
        }
    }
    catch (err) {
        extractionError = err instanceof Error ? err.message : "Error de extracción";
    }
    const documentType = (0, classifier_1.classifyDocument)(extracted);
    const concept = extracted.concepto ?? (0, classifier_1.inferConcept)(extracted);
    // resolveCentroCostos se conserva por la validacion de monto COES (coesValidacion).
    // El valor de centroCostos ya NO se toma de aqui: ahora se deriva del concepto
    // via catalogo por keywords y solo aplica a facturas (ver mas abajo).
    const centroCostosResult = await (0, centroCostosService_1.resolveCentroCostos)(extracted, blobStorage).catch((err) => {
        console.warn("[centroCostos] Resolucion fallo:", err instanceof Error ? err.message : err);
        return {};
    });
    // Centro de costos: dependiente del concepto y solo para facturas. Se usa el
    // texto del concepto (+ snippet como respaldo) para el match best-effort; si no
    // hay coincidencia queda vacio para asignacion manual desde el dashboard.
    const centroCostos = documentType === "factura"
        ? (0, centroCostosCatalog_1.resolveCentroCostosCode)([extracted.concepto, extracted.rawTextSnippet].filter(Boolean).join(" "))
        : undefined;
    let sunatValidacion;
    const numDoc = extracted.numeroDocumento;
    const rucExtracted = extracted.ruc;
    const tipoDocumento = extracted.tipoDocumento;
    const fechaE = extracted.fechaEmision;
    const montoE = extracted.monto;
    if (rucExtracted && numDoc && tipoDocumento && fechaE) {
        const partes = numDoc.split("-");
        if (partes.length >= 2) {
            try {
                sunatValidacion = await (0, sunatService_1.validarEnSunat)({
                    numRuc: rucExtracted,
                    codComp: tipoDocumento,
                    numeroSerie: partes[0],
                    numero: partes.slice(1).join("-"),
                    fechaEmision: fechaE,
                    monto: montoE != null ? montoE.toFixed(2) : "",
                    codDocRecep: "6",
                    numDocRecep: "",
                });
            }
            catch (err) {
                console.warn("[SUNAT] Validación falló:", err instanceof Error ? err.message : err);
            }
        }
    }
    const record = {
        id: requestId,
        metadata,
        files: attachedFiles,
        extracted,
        documentType,
        concept,
        empresa: extracted.emisor ?? "",
        centroCostos,
        ruc: extracted.ruc ?? "",
        sunatValidacion,
        coesValidacion: centroCostosResult.coesValidacion,
        status: extractionError ? "error" : "pendiente",
        error: extractionError,
        createdAt: now,
        updatedAt: now,
    };
    await repository.save(record);
    (0, realtime_1.broadcastNewDocument)(record);
    return {
        statusCode: 202,
        body: { requestId, accepted: attachedFiles.length, rejected, record },
    };
}
function buildMassiveImportMetadata(metadata, groupName) {
    return {
        ...metadata,
        messageId: metadata.messageId ? `${metadata.messageId}::${groupName}` : undefined,
        subject: metadata.subject ? `${metadata.subject} [${groupName}]` : groupName,
    };
}
function groupFilesForMassiveImport(entries, sourceName) {
    const groups = new Map();
    const fallbackGroup = node_path_1.default.parse(sourceName).name || "root";
    for (const entry of entries) {
        const normalizedPath = entry.entryPath.replace(/^\/+/, "");
        const parts = normalizedPath.split("/").filter(Boolean);
        const groupName = parts.length > 1 ? parts[0] : fallbackGroup;
        const fileName = parts[parts.length - 1] ?? entry.entryPath;
        const current = groups.get(groupName) ?? [];
        current.push(makeWorkatoFile(fileName, entry.mimeType, entry.buffer));
        groups.set(groupName, current);
    }
    return groups;
}
function slugify(value) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "sin-empresa";
}
function folderName(value) {
    const raw = value.trim();
    if (!raw)
        return "SIN_DATO";
    const normalized = raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "_")
        .replace(/-+/g, "-")
        .replace(/^[-_.]+|[-_.]+$/g, "");
    return (normalized || "SIN_DATO").toUpperCase();
}
const BUILD_TIME = new Date().toISOString();
router.get("/auth/config", (_req, res) => {
    if (!config_1.config.azureAdTenantId || !config_1.config.azureAdClientId || !config_1.config.azureAdFrontendClientId) {
        return res.json({ enabled: false });
    }
    return res.json({
        enabled: true,
        tenantId: config_1.config.azureAdTenantId,
        frontendClientId: config_1.config.azureAdFrontendClientId,
        apiClientId: config_1.config.azureAdClientId,
        scope: `api://${config_1.config.azureAdClientId}/access_as_user`,
    });
});
router.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        service: "proyecto2-gcp-facturas",
        timestamp: new Date().toISOString(),
        buildTime: BUILD_TIME,
        zipParser: "yauzl",
        remoteUrlsDefault: config_1.config.enableWorkatoRemoteUrlsByDefault,
    });
});
router.post("/coes/sync", auth_1.requireAuth, async (req, res) => {
    const yearRaw = req.body?.year;
    const monthRaw = req.body?.month;
    if (yearRaw != null || monthRaw != null) {
        const year = Number(yearRaw);
        const month = Number(monthRaw);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({
                error: "Si envias year/month, deben ser enteros validos (month entre 1 y 12).",
            });
        }
        const result = await (0, coesService_1.syncCoesMonthlyRequiredFiles)({ year, month }, blobStorage);
        return res.status(result.status === "not_available" ? 404 : 200).json(result);
    }
    const result = await (0, coesService_1.runCoesAutoSync)(new Date(), blobStorage);
    return res.status(result.status === "not_available" ? 404 : 200).json(result);
});
router.get("/coes/periods", auth_1.requireAuth, async (_req, res) => {
    const entries = await (0, coesService_1.listCoesIndex)(blobStorage);
    const periods = entries
        .map((e) => ({ dataset: e.dataset, year: e.period.year, month: e.period.month, informeCode: e.informeCode }))
        .sort((a, b) => b.year - a.year || b.month - a.month || a.dataset.localeCompare(b.dataset));
    return res.json({ periods });
});
const coesMatrixQuerySchema = zod_1.z.object({
    dataset: zod_1.z.enum(["vtea", "vtp"]),
    year: zod_1.z.coerce.number().int(),
    month: zod_1.z.coerce.number().int().min(1).max(12),
});
router.get("/coes/matrix", auth_1.requireAuth, async (req, res) => {
    const parsed = coesMatrixQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: "Parametros invalidos. Se requiere dataset (vtea|vtp), year y month." });
    }
    const { dataset, year, month } = parsed.data;
    const matrix = await (0, centroCostosService_1.getCoesMatrixForPeriod)(dataset, { year, month }, blobStorage);
    if (!matrix) {
        return res.status(404).json({ error: `No se encontro el excel COES ${dataset.toUpperCase()} para ${month}/${year}.` });
    }
    return res.json(matrix);
});
const coesVerifyBodySchema = zod_1.z.object({
    dataset: zod_1.z.enum(["vtea", "vtp"]),
    year: zod_1.z.number().int(),
    month: zod_1.z.number().int().min(1).max(12),
    supplierRuc: zod_1.z.string().trim().min(1),
    monto: zod_1.z.number().finite(),
});
router.post("/coes/verify", auth_1.requireAuth, async (req, res) => {
    const parsed = coesVerifyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.status(400).json({ error: "Payload invalido. Se requiere dataset, year, month, supplierRuc y monto." });
    }
    const { dataset, year, month, supplierRuc, monto } = parsed.data;
    const result = await (0, centroCostosService_1.verifyCoesAmountForPeriod)(dataset, { year, month }, supplierRuc, monto, blobStorage);
    return res.json(result);
});
router.post("/intake", upload.any(), async (req, res) => {
    const auth = ensureAuthorized(req);
    if (!auth.authorized) {
        return res.status(auth.response.statusCode).json(auth.response.body);
    }
    const metadata = normalizeIncomingMetadata(req.body);
    const { files, useRemoteFiles, workatoRemoteRefs } = await collectIncomingFiles(req);
    if (files.length === 0) {
        return res.status(400).json(buildNoFilesResponse(req, useRemoteFiles, workatoRemoteRefs));
    }
    const result = await processIntakeFiles(files, metadata);
    return res.status(result.statusCode).json(result.body);
});
router.post("/intake/massive", auth_1.requireAuth, upload.any(), async (req, res) => {
    const auth = ensureAuthorized(req, { allowWhenSecretMissingInRequest: true });
    if (!auth.authorized) {
        return res.status(auth.response.statusCode).json(auth.response.body);
    }
    const metadata = normalizeIncomingMetadata(req.body);
    const { files, useRemoteFiles, workatoRemoteRefs } = await collectIncomingFiles(req);
    if (files.length === 0) {
        return res.status(400).json(buildNoFilesResponse(req, useRemoteFiles, workatoRemoteRefs));
    }
    const zipFiles = files.filter((file) => (0, parser_1.detectFileType)(file.originalname, file.mimetype, file.buffer) === "zip");
    if (zipFiles.length === 0) {
        return res.status(400).json({ error: "Massive import requiere al menos un archivo ZIP." });
    }
    const groupedRecords = new Map();
    for (const zipFile of zipFiles) {
        const entries = await (0, zipService_1.extractSupportedZipEntries)(zipFile.buffer);
        const groups = groupFilesForMassiveImport(entries, zipFile.originalname);
        for (const [groupName, groupFiles] of groups.entries()) {
            const current = groupedRecords.get(groupName) ?? [];
            current.push(...groupFiles);
            groupedRecords.set(groupName, current);
        }
    }
    if (groupedRecords.size === 0) {
        return res.status(400).json({ error: "El ZIP no contiene carpetas con archivos XML, PDF o ZIP válidos." });
    }
    const items = [];
    for (const [groupName, groupFiles] of groupedRecords.entries()) {
        const result = await processIntakeFiles(groupFiles, buildMassiveImportMetadata(metadata, groupName));
        items.push({
            group: groupName,
            statusCode: result.statusCode,
            requestId: "requestId" in result.body ? result.body.requestId : undefined,
            accepted: "accepted" in result.body ? result.body.accepted : undefined,
            rejected: "rejected" in result.body ? result.body.rejected : undefined,
            duplicate: "duplicate" in result.body ? result.body.duplicate : undefined,
            error: "error" in result.body ? result.body.error : undefined,
            record: "record" in result.body ? result.body.record : undefined,
        });
    }
    const created = items.filter((item) => item.statusCode === 202).length;
    const failed = items.filter((item) => item.statusCode !== 202).length;
    return res.status(failed > 0 ? 207 : 202).json({
        imported: created,
        failed,
        totalGroups: groupedRecords.size,
        items,
    });
});
router.get("/documents", auth_1.requireAuth, async (req, res) => {
    const filters = {
        documentType: typeof req.query.documentType === "string" ? req.query.documentType : undefined,
        concept: typeof req.query.concept === "string" ? req.query.concept : undefined,
        status: typeof req.query.status === "string" ? req.query.status : undefined
    };
    const docs = await repository.list(filters);
    docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ items: docs, count: docs.length });
});
router.get("/documents/:id", auth_1.requireAuth, async (req, res) => {
    const item = await repository.findById(req.params.id);
    if (!item) {
        return res.status(404).json({ error: "Documento no encontrado." });
    }
    return res.json(item);
});
router.delete("/documents/:id", auth_1.requireAuth, async (req, res) => {
    const item = await repository.findById(req.params.id);
    if (!item) {
        return res.status(404).json({ error: "Documento no encontrado." });
    }
    for (const file of item.files) {
        try {
            await blobStorage.delete(file.sourcePath);
        }
        catch (err) {
            console.warn(`[documents] No se pudo borrar el archivo ${file.sourcePath}:`, err instanceof Error ? err.message : err);
        }
    }
    await repository.delete(item.id, item.empresa);
    (0, realtime_1.broadcastDocumentDeleted)(item.id);
    return res.status(204).end();
});
const updateDocumentSchema = zod_1.z.object({
    empresa: zod_1.z.string().trim().min(1).optional(),
    documentType: zod_1.z.enum(["factura", "comprobante", "nota", "desconocido"]).optional(),
    centroCostos: zod_1.z.string().trim().min(1).optional(),
    monto: zod_1.z.number().finite().nonnegative().nullable().optional(),
    ruc: zod_1.z.string().trim().optional(),
    concept: zod_1.z.string().trim().optional(),
    fechaEmision: zod_1.z.string().trim().optional(),
    fechaVencimiento: zod_1.z.string().trim().optional(),
    numeroDocumento: zod_1.z.string().trim().optional(),
    resolveError: zod_1.z.boolean().optional(),
});
router.patch("/documents/:id", auth_1.requireAuth, async (req, res) => {
    const parsed = updateDocumentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.status(400).json({ error: "Payload invalido para actualizar documento." });
    }
    const current = await repository.findById(req.params.id);
    if (!current) {
        return res.status(404).json({ error: "Documento no encontrado." });
    }
    const payload = parsed.data;
    const updated = {
        ...current,
        empresa: payload.empresa ?? current.empresa,
        documentType: payload.documentType ?? current.documentType,
        centroCostos: payload.centroCostos ?? current.centroCostos,
        ruc: payload.ruc ?? current.ruc,
        concept: payload.concept ?? current.concept,
        extracted: {
            ...current.extracted,
            monto: payload.monto === undefined ? current.extracted?.monto : payload.monto ?? undefined,
            ruc: payload.ruc ?? current.extracted?.ruc,
            concepto: payload.concept ?? current.extracted?.concepto,
            fechaEmision: payload.fechaEmision ?? current.extracted?.fechaEmision,
            fechaVencimiento: payload.fechaVencimiento ?? current.extracted?.fechaVencimiento,
            numeroDocumento: payload.numeroDocumento ?? current.extracted?.numeroDocumento,
        },
        status: payload.resolveError ? "pendiente" : current.status,
        error: payload.resolveError ? undefined : current.error,
        updatedAt: new Date().toISOString(),
    };
    await repository.save(updated);
    (0, realtime_1.broadcastDocumentUpdated)(updated);
    return res.json({ item: updated });
});
// Download individual file (opens PDF inline, downloads XML)
router.get("/documents/:id/files/:filename", async (req, res) => {
    try {
        const item = await repository.findById(req.params.id);
        if (!item)
            return res.status(404).json({ error: "Registro no encontrado." });
        const file = item.files.find(f => f.fileName === req.params.filename);
        if (!file)
            return res.status(404).json({ error: "Archivo no encontrado." });
        // PDF inline (preview en el navegador); el resto se descarga. Se usa includes
        // para tolerar mimeType con sufijo, ej. "application/pdf;charset=ISO-8859-1".
        const isPdf = (file.mimeType || "").toLowerCase().includes("pdf") || file.fileName.toLowerCase().endsWith(".pdf");
        const disposition = isPdf ? "inline" : "attachment";
        res.setHeader("Content-Type", isPdf ? "application/pdf" : (file.mimeType || "application/octet-stream"));
        res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(file.fileName)}"`);
        const stream = await blobStorage.openReadStream(file.sourcePath);
        stream.pipe(res);
    }
    catch {
        if (!res.headersSent)
            res.status(500).json({ error: "No se pudo obtener el archivo." });
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
        }
        else {
            const allRefs = item.files.map(f => ({ fileName: f.fileName, sourcePath: f.sourcePath }));
            const accessible = await (0, zipService_1.filterAccessibleFiles)(allRefs);
            if (!accessible.length)
                return res.status(422).json({ error: "Ningún archivo físico encontrado." });
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(item.id)}.zip"`);
            await (0, zipService_1.streamZipToWritable)(accessible, res, blobStorage);
        }
    }
    catch {
        if (!res.headersSent)
            res.status(500).json({ error: "No se pudo obtener el archivo." });
    }
});
const exportSelectionSchema = zod_1.z.object({
    id: zod_1.z.string(),
    fileNames: zod_1.z.array(zod_1.z.string()).optional(),
});
router.post("/exports", auth_1.requireAuth, async (req, res) => {
    let selections;
    if (Array.isArray(req.body.items)) {
        const parsed = zod_1.z.array(exportSelectionSchema).safeParse(req.body.items);
        if (!parsed.success) {
            return res.status(400).json({ error: "Payload invalido en el campo items." });
        }
        selections = parsed.data;
    }
    else if (Array.isArray(req.body.ids)) {
        selections = req.body.ids.filter((id) => typeof id === "string").map((id) => ({ id }));
    }
    else {
        return res.status(400).json({ error: "Se requiere un array de items (o ids) para exportar." });
    }
    if (!selections.length) {
        return res.status(400).json({ error: "Se requiere al menos un documento para exportar." });
    }
    const records = [];
    for (const sel of selections) {
        const rec = await repository.findById(sel.id);
        if (rec)
            records.push({ record: rec, fileNames: sel.fileNames });
    }
    if (!records.length) {
        return res.status(404).json({ error: "No se encontraron registros para los IDs indicados." });
    }
    const usedRecordFolders = new Map();
    const allRefs = records.flatMap(({ record, fileNames }) => {
        const empresaFolder = folderName(record.empresa || "SIN EMPRESA");
        const recordBase = folderName(record.extracted?.numeroDocumento || record.id || "registro");
        const recordKey = `${empresaFolder}/${recordBase}`;
        const seen = (usedRecordFolders.get(recordKey) ?? 0) + 1;
        usedRecordFolders.set(recordKey, seen);
        const recordFolder = seen > 1 ? `${recordBase}_${seen}` : recordBase;
        const filesToInclude = fileNames ? record.files.filter((file) => fileNames.includes(file.fileName)) : record.files;
        return filesToInclude.map((file) => ({
            fileName: file.fileName,
            sourcePath: file.sourcePath,
            zipPath: `${empresaFolder}/${recordFolder}/${file.fileName}`,
        }));
    });
    const accessible = await (0, zipService_1.filterAccessibleFiles)(allRefs);
    const skipped = allRefs.length - accessible.length;
    if (!accessible.length) {
        return res.status(422).json({ error: "Ningún archivo físico encontrado." });
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="export-documentos-${dateStr}.zip"`);
    if (skipped > 0)
        res.setHeader("X-Skipped-Count", String(skipped));
    try {
        await (0, zipService_1.streamZipToWritable)(accessible, res, blobStorage);
    }
    catch (error) {
        console.error("Error streaming ZIP:", error);
        return;
    }
    const now = new Date().toISOString();
    for (const { record } of records) {
        await repository.save({ ...record, status: "procesado", updatedAt: now });
    }
});
exports.default = router;
