export type SupportedFileType = "pdf" | "xml" | "unknown";
export type DocumentType = "factura" | "comprobante" | "nota" | "desconocido";
export type ProcessStatus = "pendiente" | "procesado" | "error";

export interface IncomingMetadata {
  messageId?: string;
  sender?: string;
  subject?: string;
  receivedAt?: string;
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
  rawTextSnippet?: string;
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
  ruc: string;
  status: ProcessStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
