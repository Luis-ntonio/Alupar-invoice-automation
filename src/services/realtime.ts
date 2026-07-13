import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config";
import { isEmailAllowed, verifyAccessToken } from "../middleware/auth";
import type { EmailRecord } from "../types";

const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

// WS de notificacion en tiempo real para el dashboard (nuevo documento procesado
// por /api/intake). Broadcast en memoria: solo funciona correctamente con una
// sola replica del Container App (hoy fijo en minReplicas=maxReplicas=1 en
// deploy-containerapps.ps1). Si en el futuro se sube maxReplicas, este enfoque
// deja de avisar a clientes conectados a otra replica y habria que migrar a
// Azure Web PubSub (fan-out compartido entre replicas).
export function attachWebSocketServer(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? "";

    if (config.azureAdTenantId && config.azureAdClientId) {
      if (!token) {
        socket.close(4401, "Token requerido");
        return;
      }
      try {
        const payload = await verifyAccessToken(token);
        const email = (payload["email"] || payload["preferred_username"] || "") as string;
        if ((config.allowedDomains || config.allowedEmails) && !isEmailAllowed(email)) {
          socket.close(4403, "Acceso no autorizado");
          return;
        }
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
