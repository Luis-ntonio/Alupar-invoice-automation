import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { isAuthEnabled, verifyIdToken } from "./firebaseAuth";
import type { EmailRecord } from "../types";

const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

// WS de notificacion en tiempo real para el dashboard (nuevo documento procesado
// por /api/intake). Broadcast en memoria: solo funciona correctamente con una
// sola instancia de Cloud Run. Si se sube --max-instances, este enfoque deja de
// avisar a clientes conectados a otra instancia y habria que migrar el fan-out a
// Pub/Sub (compartido entre instancias).
export function attachWebSocketServer(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? "";

    // El token viaja por query string porque el navegador no permite enviar
    // headers en `new WebSocket()`. Estar en Firebase es la autorizacion: no hay
    // allow-list local que chequear.
    if (isAuthEnabled()) {
      if (!token) {
        socket.close(4401, "Token requerido");
        return;
      }
      try {
        await verifyIdToken(token);
      } catch {
        socket.close(4401, "Token invalido o expirado");
        return;
      }
    }

    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
}

function broadcast(message: unknown): void {
  if (!clients.size) return;
  const payload = JSON.stringify(message);
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

export function broadcastNewDocument(record: EmailRecord): void {
  broadcast({ type: "new_document", record });
}

export function broadcastDocumentUpdated(record: EmailRecord): void {
  broadcast({ type: "document_updated", record });
}

export function broadcastDocumentDeleted(id: string): void {
  broadcast({ type: "document_deleted", id });
}
