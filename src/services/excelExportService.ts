import ExcelJS from "exceljs";
import { EmailRecord } from "../types";
import { CENTRO_COSTOS_CATALOG } from "./centroCostosCatalog";

// Replica el formato del control de pagos que maneja el cliente (ver
// ejemplos/lv 455.xlsx y ejemplos/lv 473.xlsx): cabecera verde, columnas
// Item/Periodo/Empresa/RUC/Concepto/Valor Sin-Con IGV/Factura/Fechas/Centro de
// Costo, un bloque de datos bancarios que el cliente completa a mano, y
// nuestras columnas propias (Moneda, Fideicomiso, estados) al final.
const HEADER_FILL = "FF009F4D";
const HEADER_FONT: Partial<ExcelJS.Font> = { name: "Segoe UI", size: 8, bold: true, color: { argb: "FFFFFFFF" } };
const DATA_FONT: Partial<ExcelJS.Font> = { name: "Segoe UI", size: 8 };
const HEADER_ALIGNMENT: Partial<ExcelJS.Alignment> = { horizontal: "center", vertical: "middle", wrapText: true };
const ACCOUNTING_FORMAT = '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)';
const DATE_FORMAT = "mm-dd-yy";
const PERIOD_FORMAT = "mmm-yy";

interface ColumnSpec {
	header: string;
	width: number;
}

const COLUMNS: ColumnSpec[] = [
	{ header: "Ítem", width: 4.18 },
	{ header: "Periodo", width: 7 },
	{ header: "Empresa", width: 21.18 },
	{ header: "RUC", width: 16.18 },
	{ header: "Concepto", width: 38.27 },
	{ header: "Valor S/.\nSin IGV", width: 13.54 },
	{ header: "Valor S/.\nCon IGV", width: 13.54 },
	{ header: "Factura", width: 18.82 },
	{ header: "Fecha de Recepción", width: 13.45 },
	{ header: "Fecha de Vencimiento", width: 11.45 },
	{ header: "Centro de Costo", width: 11.45 },
	{ header: "Centro de Costo", width: 11.18 },
	{ header: "Informe COES", width: 18 },
	{ header: "", width: 3.18 },
	{ header: "", width: 7.18 },
	{ header: "Nombre Comercial", width: 30.45 },
	{ header: "Empresa", width: 29.45 },
	{ header: "Ruc", width: 19 },
	{ header: "Banco", width: 13.45 },
	{ header: "Cuenta", width: 21 },
	{ header: "CCI", width: 19.45 },
	{ header: "Moneda", width: 12 },
	{ header: "Fideicomiso", width: 12 },
	{ header: "Tipo Doc", width: 14 },
	{ header: "Val. COES", width: 14 },
	{ header: "Estado", width: 12 },
	{ header: "Est. CP", width: 12 },
	{ header: "Est. RUC", width: 12 },
	{ header: "Domicilio", width: 14 },
];

function parseDate(value: string | undefined | null): Date | null {
	if (!value) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

function monthStart(value: string | undefined | null): Date | null {
	const d = parseDate(value);
	if (!d) return null;
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function rucValue(ruc: string | undefined | null): string | number {
	if (!ruc) return "";
	return /^\d+$/.test(ruc) ? Number(ruc) : ruc;
}

function centroCostoDescripcion(record: EmailRecord): string {
	const entry = CENTRO_COSTOS_CATALOG.find((e) => e.code === record.centroCostos);
	return entry?.concepto || record.concept || "";
}

export async function buildFacturasExcelBuffer(records: EmailRecord[]): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet("Facturas");

	sheet.columns = COLUMNS.map((col) => ({ width: col.width }));

	const headerRow = sheet.getRow(1);
	COLUMNS.forEach((col, i) => {
		const cell = headerRow.getCell(i + 1);
		cell.value = col.header || null;
		if (col.header) {
			cell.font = HEADER_FONT;
			cell.alignment = HEADER_ALIGNMENT;
			cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
		}
	});

	records.forEach((record, index) => {
		const row = sheet.getRow(index + 2);
		const monto = record.extracted?.monto ?? null;
		const montoSinIgv = monto != null ? Number((monto / 1.18).toFixed(2)) : null;
		const fechaRecepcion = parseDate(record.metadata?.receivedAt || record.createdAt);
		const fechaVencimiento = parseDate(record.extracted?.fechaVencimiento);
		const periodo = monthStart(record.extracted?.fechaEmision);

		const values: Array<string | number | Date | null> = [
			index + 1,
			periodo,
			record.empresa || "",
			rucValue(record.ruc),
			record.concept || "",
			montoSinIgv,
			monto,
			record.extracted?.numeroDocumento || "",
			fechaRecepcion,
			fechaVencimiento,
			record.centroCostos || "",
			centroCostoDescripcion(record),
			record.coesValidacion?.informeCode || "",
			null,
			null,
			"",
			"",
			"",
			"",
			"",
			"",
			record.extracted?.moneda || "",
			record.fideicomiso ? "Si" : "No",
			record.documentType || "",
			record.coesValidacion?.status || "",
			record.status || "",
			record.sunatValidacion?.estadoComprobante || "",
			record.sunatValidacion?.estadoContribuyente || "",
			record.sunatValidacion?.condicionDomicilio || "",
		];

		values.forEach((value, i) => {
			const cell = row.getCell(i + 1);
			cell.value = value;
			cell.font = DATA_FONT;
		});

		row.getCell(2).numFmt = PERIOD_FORMAT;
		row.getCell(6).numFmt = ACCOUNTING_FORMAT;
		row.getCell(7).numFmt = ACCOUNTING_FORMAT;
		row.getCell(9).numFmt = DATE_FORMAT;
		row.getCell(10).numFmt = DATE_FORMAT;
	});

	const buffer = await workbook.xlsx.writeBuffer();
	return Buffer.from(buffer);
}
