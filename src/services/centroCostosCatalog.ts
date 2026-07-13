import { normalizeText } from "../utils/classifier";

// Catalogo oficial de centros de costo del cliente (ver "centro de costos.jpeg").
// Cada centro de costo es un codigo (004.x.y) asociado a un concepto COES.
// El centro de costo de una factura se deriva de su concepto por coincidencia de
// palabras clave; el concepto se muestra igual en su propia columna del dashboard.
export interface CentroCostoEntry {
	code: string;
	concepto: string;
	keywords: string[];
}

// El orden importa: las reglas mas especificas van primero para que "peaje" o
// "transferencia de potencia" no capturen antes que su variante mas precisa
// (ej. "potencia firme" antes que "transferencias de potencia").
export const CENTRO_COSTOS_CATALOG: CentroCostoEntry[] = [
	{ code: "004.1.7", concepto: "Compensación por Ingreso Tarifario", keywords: ["compensacion por ingreso tarifario", "compensacion ingreso tarifario"] },
	{ code: "004.2.3", concepto: "Transferencia de Potencia Firme", keywords: ["potencia firme"] },
	{ code: "004.1.9", concepto: "Valorización de Transferencias de Potencia", keywords: ["transferencias de potencia", "transferencia de potencia", "valorizacion de transferencias de potencia"] },
	{ code: "004.1.8", concepto: "Liquidación del Peaje de Conexión SPT", keywords: ["peaje de conexion", "conexion spt"] },
	{ code: "004.1.15", concepto: "Peaje por Área Demanda", keywords: ["area demanda", "area de demanda", "peaje por area"] },
	{ code: "004.1.16", concepto: "Peaje por Distribución", keywords: ["peaje por distribucion", "distribucion"] },
	{ code: "004.2.1", concepto: "Comercialización de Energía Activa", keywords: ["energia activa", "comercializacion de energia"] },
	{ code: "004.1.11", concepto: "Liquidación de SCIO", keywords: ["scio"] },
	{ code: "004.1.12", concepto: "Pagos SST GD REP", keywords: ["gd rep", "sst gd"] },
	{ code: "004.1.6", concepto: "Ingreso Tarifario Red MAT SST & SCT", keywords: ["ingreso tarifario"] },
];

/**
 * Deriva el codigo de centro de costo a partir del texto del concepto de una
 * factura (best-effort por palabras clave). Devuelve undefined si no hay match,
 * en cuyo caso el operador lo asigna manualmente desde el dashboard.
 */
export function resolveCentroCostosCode(text: string | undefined | null): string | undefined {
	if (!text) return undefined;
	const normalized = normalizeText(text);
	for (const entry of CENTRO_COSTOS_CATALOG) {
		if (entry.keywords.some((kw) => normalized.includes(kw))) {
			return entry.code;
		}
	}
	return undefined;
}
