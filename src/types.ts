export type SupportedFileType = "pdf" | "xml" | "zip" | "unknown";
export type DocumentType = "factura" | "comprobante" | "nota" | "desconocido";
export type ProcessStatus = "pendiente" | "procesado" | "error";

export interface IncomingMetadata {
  messageId?: string;
  sender?: string;
  subject?: string;
  receivedAt?: string;
  bodyHtml?: string;
  bodyText?: string;
  body?: string;
  html?: string;
  emailBodyHtml?: string;
}

/** One file attachment that arrived with an email. */
export interface AttachedFile {
  fileName: string;
  fileType: SupportedFileType;
  mimeType: string;
  sourcePath: string;
  hash: string;
}

export interface ExtractedFields {
  numeroDocumento?: string;
  fechaEmision?: string;
  fechaVencimiento?: string;
  monto?: number;
  moneda?: string;
  emisor?: string;
  ruc?: string;
  concepto?: string;
  receptor?: string;
  tipoDocumento?: string;
  rawTextSnippet?: string;
}

export interface SunatValidacion {
  estadoComprobante: string;
  estadoContribuyente: string;
  condicionDomicilio: string;
  validadoEn: string;
}

export type CoesValidacionStatus = "validado" | "no_coincide" | "no_encontrado";

export interface CoesValidacion {
  dataset: "vtea" | "vtp";
  informeCode?: string;
  montoFactura: number;
  montoEsperado?: number;
  status: CoesValidacionStatus;
  detalle: string;
}

/** One registro = all files that arrived in a single email. */
export interface EmailRecord {
  id: string;
  metadata: IncomingMetadata;
  files: AttachedFile[];
  extracted: ExtractedFields;
  documentType: DocumentType;
  concept: string;
  empresa: string;
  centroCostos?: string;
  fideicomiso?: boolean;
  ruc: string;
  sunatValidacion?: SunatValidacion;
  coesValidacion?: CoesValidacion;
  status: ProcessStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
