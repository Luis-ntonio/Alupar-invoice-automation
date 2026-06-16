"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validarEnSunat = validarEnSunat;
const BASE_URL = "https://ww1.sunat.gob.pe/ol-ti-itconsultaunificadalibre/consultaUnificadaLibre";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
// Mappings tomados del JS de la propia página de SUNAT
const ESTADO_CP = {
    "-": "-",
    "0": "NO EXISTE",
    "1": "ACEPTADO",
    "2": "ANULADO",
    "3": "AUTORIZADO",
    "4": "NO AUTORIZADO",
};
const ESTADO_RUC = {
    "-": "-",
    "00": "ACTIVO",
    "01": "BAJA PROVISIONAL",
    "02": "BAJA PROV. POR OFICIO",
    "03": "SUSPENSION TEMPORAL",
    "10": "BAJA DEFINITIVA",
    "11": "BAJA DE OFICIO",
    "12": "BAJA MULT.INSCR. Y OTROS",
    "20": "NUM. INTERNO IDENTIF.",
    "21": "OTROS OBLIGADOS",
    "22": "INHABILITADO-VENT.UNICA",
    "30": "ANULACION - ERROR SUNAT",
};
const CONDICION_DOMICILIO = {
    "-": "-",
    "00": "HABIDO",
    "01": "NO HALLADO - SE MUDO DE DOMICILIO",
    "02": "NO HALLADO - FALLECIO",
    "03": "NO HALLADO - NO EXISTE DOMICILIO",
    "04": "NO HALLADO - CERRADO",
    "05": "NO HALLADO - NRO. PUERTA NO EXISTE",
    "06": "NO HALLADO - DESTINATARIO DESCONOCIDO",
    "07": "NO HALLADO - RECHAZADO",
    "08": "NO HALLADO - OTROS MOTIVOS",
    "09": "PENDIENTE",
    "10": "NO APLICABLE",
    "11": "POR VERIFICAR",
    "12": "NO HABIDO",
    "20": "NO HALLADO",
    "21": "NO EXISTE LA DIRECCION DECLARADA",
    "22": "DOMICILIO CERRADO",
    "23": "NEGATIVA RECEPCION X PERSONA CAPAZ",
    "24": "AUSENCIA DE PERSONA CAPAZ",
    "25": "NO APLICABLE X TRAMITE DE REVERSION",
    "40": "DEVUELTO",
};
/**
 * Replica generateKey(52) de sunatrecaptcha3.js:
 * SUNAT reemplazó Google reCAPTCHA con una lib propia que genera
 * un string aleatorio base36 — no hay verificación real en el servidor.
 */
function generarToken(longitud = 52) {
    const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
    return Array.from({ length: longitud }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
/** Convierte "YYYY-MM-DD" → "DD/MM/YYYY". Si ya está en DD/MM/YYYY lo deja igual. */
function toSunatDate(fecha) {
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(fecha))
        return fecha;
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        const [y, m, d] = fecha.split("-");
        return `${d}/${m}/${y}`;
    }
    return fecha;
}
/**
 * Consulta la validez de un comprobante en el portal libre de SUNAT.
 *
 * Flujo:
 * 1. GET /consulta → obtiene cookies de sesión
 * 2. Genera token (reCAPTCHA falso local)
 * 3. POST /consultaIndividual con cookies + form-urlencoded
 * 4. Parsea respuesta doblemente serializada en JSON
 */
async function validarEnSunat(params) {
    const { numRuc, codComp, numeroSerie, numero, fechaEmision, monto = "", codDocRecep = "6", numDocRecep = "20492925030", } = params;
    // ── 1. GET /consulta → cookies ─────────────────────────────────────────────
    const getResp = await fetch(`${BASE_URL}/consulta`, {
        headers: {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-PE,es;q=0.9",
        },
    });
    if (!getResp.ok) {
        throw new Error(`SUNAT GET /consulta falló: ${getResp.status}`);
    }
    // Node 20 expone getSetCookie() en la clase Headers de undici
    const rawCookies = getResp.headers.getSetCookie?.() ?? [];
    const cookieString = rawCookies
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
    // ── 2. Token local ─────────────────────────────────────────────────────────
    const token = generarToken();
    // ── 3. POST /consultaIndividual ────────────────────────────────────────────
    const body = new URLSearchParams({
        numRuc,
        codComp,
        numeroSerie: numeroSerie.toUpperCase(),
        numero,
        codDocRecep,
        numDocRecep,
        fechaEmision: toSunatDate(fechaEmision),
        monto: String(monto),
        token,
    });
    const postResp = await fetch(`${BASE_URL}/consultaIndividual`, {
        method: "POST",
        body,
        headers: {
            "User-Agent": UA,
            Accept: "application/json, */*",
            "Accept-Language": "es-PE,es;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://ww1.sunat.gob.pe",
            Referer: `${BASE_URL}/consulta`,
            ...(cookieString ? { Cookie: cookieString } : {}),
        },
    });
    if (!postResp.ok) {
        throw new Error(`SUNAT POST /consultaIndividual falló: ${postResp.status}`);
    }
    // ── 4. Parsear respuesta (JSON doblemente serializado) ─────────────────────
    const text = await postResp.text();
    let parsed;
    try {
        const outer = JSON.parse(text);
        parsed = (typeof outer === "string" ? JSON.parse(outer) : outer);
    }
    catch {
        throw new Error(`SUNAT respuesta inesperada: ${text.slice(0, 200)}`);
    }
    const data = parsed?.data ?? {};
    return {
        estadoComprobante: ESTADO_CP[data.estadoCp] ?? data.estadoCp ?? "-",
        estadoContribuyente: ESTADO_RUC[data.estadoRuc] ?? data.estadoRuc ?? "-",
        condicionDomicilio: CONDICION_DOMICILIO[data.condDomiRuc] ?? data.condDomiRuc ?? "-",
        validadoEn: new Date().toISOString(),
    };
}
