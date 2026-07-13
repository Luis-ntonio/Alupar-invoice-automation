/**
 * Harness de regresion del parser de comprobantes UBL.
 *
 * Corre `extractFields` + `classifyDocument` sobre cada XML de `./sample` y
 * compara contra los valores esperados. Sirve para validar el soporte de
 * CreditNote y prevenir regresiones futuras en la extraccion de campos.
 *
 * Uso:  npx tsx scripts/test-parser.ts   (o  npm run test:parser)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractFields } from "../src/services/parser";
import { classifyDocument } from "../src/utils/classifier";
import type { DocumentType } from "../src/types";

interface Expected {
  documentType: DocumentType;
  ruc: string;
  monto: number;
  fechaEmision: string;
  moneda: string;
  emisor?: string; // se valida solo si se especifica
}

const MONTO_TOLERANCE = 0.01;

const EXPECTED: Record<string, Expected> = {
  "20352427081-01-F210-8253.xml": { documentType: "factura", ruc: "20352427081", monto: 8445.94, fechaEmision: "2026-07-11", moneda: "PEN" },
  "20383316473-01-F001-131370.xml": { documentType: "factura", ruc: "20383316473", monto: 5649.92, fechaEmision: "2026-07-02", moneda: "PEN", emisor: "CONSORCIO TRANSMANTARO S.A." },
  "20383316473-01-F001-132576.xml": { documentType: "factura", ruc: "20383316473", monto: 25130.44, fechaEmision: "2026-07-11", moneda: "PEN", emisor: "CONSORCIO TRANSMANTARO S.A." },
  "20383316473-07-FC01-4976.xml": { documentType: "nota", ruc: "20383316473", monto: 5649.91, fechaEmision: "2026-07-02", moneda: "PEN", emisor: "CONSORCIO TRANSMANTARO S.A." },
  "20504645046-01-F001-85268.xml": { documentType: "factura", ruc: "20504645046", monto: 184.73, fechaEmision: "2026-07-11", moneda: "PEN", emisor: "RED DE ENERGIA DEL PERU S.A." },
  "20552721668-01-F001-0004507.xml": { documentType: "factura", ruc: "20552721668", monto: 4907.55, fechaEmision: "2026-07-10", moneda: "PEN" },
  "20600217721-08-FD01-1106.xml": { documentType: "nota", ruc: "20600217721", monto: 29.15, fechaEmision: "2026-07-10", moneda: "PEN" },
  "20600217721-08-FD01-1106 (1).xml": { documentType: "nota", ruc: "20600217721", monto: 29.15, fechaEmision: "2026-07-10", moneda: "PEN" },
  "20600217721-08-FD01-1110.xml": { documentType: "nota", ruc: "20600217721", monto: 54.91, fechaEmision: "2026-07-10", moneda: "PEN" },
  "20601053391-01-FF02-1523.xml": { documentType: "factura", ruc: "20601053391", monto: 991.55, fechaEmision: "2026-07-10", moneda: "PEN" },
  "20608552171-01-F111-4145.xml": { documentType: "factura", ruc: "20608552171", monto: 7080.0, fechaEmision: "2026-07-09", moneda: "USD", emisor: "UNACEM PERU SA" },
};

async function main(): Promise<void> {
  const sampleDir = path.resolve("sample");
  let files: string[];
  try {
    files = (await fs.readdir(sampleDir)).filter((f) => f.toLowerCase().endsWith(".xml")).sort();
  } catch {
    console.error(`No se encontro el directorio de muestras: ${sampleDir}`);
    process.exitCode = 1;
    return;
  }

  let passed = 0;
  let failed = 0;
  const missingExpected: string[] = [];

  for (const file of files) {
    const expected = EXPECTED[file];
    if (!expected) {
      missingExpected.push(file);
      continue;
    }

    const buffer = await fs.readFile(path.join(sampleDir, file));
    const extracted = await extractFields("xml", buffer);
    const documentType = classifyDocument(extracted);

    const errors: string[] = [];
    if (documentType !== expected.documentType) errors.push(`documentType: ${documentType} != ${expected.documentType}`);
    if ((extracted.ruc ?? "") !== expected.ruc) errors.push(`ruc: "${extracted.ruc ?? ""}" != "${expected.ruc}"`);
    if (extracted.monto === undefined || Math.abs(extracted.monto - expected.monto) > MONTO_TOLERANCE) {
      errors.push(`monto: ${extracted.monto} != ${expected.monto}`);
    }
    if ((extracted.fechaEmision ?? "") !== expected.fechaEmision) errors.push(`fechaEmision: "${extracted.fechaEmision ?? ""}" != "${expected.fechaEmision}"`);
    if ((extracted.moneda ?? "") !== expected.moneda) errors.push(`moneda: "${extracted.moneda ?? ""}" != "${expected.moneda}"`);
    if (expected.emisor !== undefined && (extracted.emisor ?? "") !== expected.emisor) {
      errors.push(`emisor: "${extracted.emisor ?? ""}" != "${expected.emisor}"`);
    }

    if (errors.length === 0) {
      passed++;
      console.log(`PASS  ${file}`);
    } else {
      failed++;
      console.log(`FAIL  ${file}`);
      for (const e of errors) console.log(`        - ${e}`);
    }
  }

  console.log("");
  console.log(`Resultado: ${passed} pass, ${failed} fail (${files.length} XML en ./sample).`);
  if (missingExpected.length) {
    console.log(`Sin valores esperados definidos (ignorados): ${missingExpected.join(", ")}`);
  }
  if (failed > 0) process.exitCode = 1;
}

void main();
