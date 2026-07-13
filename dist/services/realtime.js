"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachWebSocketServer = attachWebSocketServer;
exports.broadcastNewDocument = broadcastNewDocument;
exports.broadcastDocumentUpdated = broadcastDocumentUpdated;
exports.broadcastDocumentDeleted = broadcastDocumentDeleted;
const ws_1 = require("ws");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const clients = new Set();
let wss = null;
// WS de notificacion en tiempo real para el dashboard (nuevo documento procesado
// por /api/intake). Broadcast en memoria: solo funciona correctamente con una
// sola replica del Container App (hoy fijo en minReplicas=maxReplicas=1 en
// deploy-containerapps.ps1). Si en el futuro se sube maxReplicas, este enfoque
// deja de avisar a clientes conectados a otra replica y habria que migrar a
// Azure Web PubSub (fan-out compartido entre replicas).
function attachWebSocketServer(server) {
    wss = new ws_1.WebSocketServer({ server, path: "/ws" });
    wss.on("connection", async (socket, request) => {
        const url = new URL(request.url ?? "", "http://localhost");
        const token = url.searchParams.get("token") ?? "";
        if (config_1.config.azureAdTenantId && config_1.config.azureAdClientId) {
            if (!token) {
                socket.close(4401, "Token requerido");
                return;
            }
            try {
                const payload = await (0, auth_1.verifyAccessToken)(token);
                const email = (payload["email"] || payload["preferred_username"] || "");
                if ((config_1.config.allowedDomains || config_1.config.allowedEmails) && !(0, auth_1.isEmailAllowed)(email)) {
                    socket.close(4403, "Acceso no autorizado");
                    return;
                }
            }
            catch {
                socket.close(4401, "Token invalido o expirado");
                return;
            }
        }
        clients.add(socket);
        socket.on("close", () => clients.delete(socket));
        socket.on("error", () => clients.delete(socket));
    });
}
function broadcast(message) {
    if (!clients.size)
        return;
    const payload = JSON.stringify(message);
    for (const socket of clients) {
        if (socket.readyState === ws_1.WebSocket.OPEN) {
            socket.send(payload);
        }
    }
}
function broadcastNewDocument(record) {
    broadcast({ type: "new_document", record });
}
function broadcastDocumentUpdated(record) {
    broadcast({ type: "document_updated", record });
}
function broadcastDocumentDeleted(id) {
    broadcast({ type: "document_deleted", id });
}
