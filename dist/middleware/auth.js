"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEmailAllowed = isEmailAllowed;
exports.verifyAccessToken = verifyAccessToken;
exports.requireAuth = requireAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const jwks_rsa_1 = __importDefault(require("jwks-rsa"));
const config_1 = require("../config");
let client = null;
function getJwksClient() {
    if (!client) {
        client = (0, jwks_rsa_1.default)({
            jwksUri: `https://login.microsoftonline.com/${config_1.config.azureAdTenantId}/discovery/v2.0/keys`,
            cache: true,
            cacheMaxAge: 10 * 60 * 1000,
            rateLimit: true,
        });
    }
    return client;
}
function getKey(header, callback) {
    getJwksClient().getSigningKey(header.kid, (err, key) => {
        if (err)
            return callback(err);
        callback(null, key.getPublicKey());
    });
}
function isEmailAllowed(email) {
    if (!email)
        return false;
    const lower = email.toLowerCase();
    const domains = (config_1.config.allowedDomains ?? "")
        .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    const emails = (config_1.config.allowedEmails ?? "")
        .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (domains.some((d) => lower.endsWith("@" + d)))
        return true;
    if (emails.includes(lower))
        return true;
    return false;
}
// Reusable para requireAuth (HTTP) y para la autenticacion del WebSocket de
// tiempo real (src/services/realtime.ts), que no puede usar este middleware
// porque el handshake de WS no pasa por el pipeline de Express.
function verifyAccessToken(token) {
    return new Promise((resolve, reject) => {
        jsonwebtoken_1.default.verify(token, getKey, {
            // Azure AD puede emitir el aud como "api://{clientId}" o como el GUID
            // pelado, segun como se resuelva el recurso al momento de emitir el
            // token v2.0 (mismo App Registration, ambas formas son validas).
            audience: [`api://${config_1.config.azureAdClientId ?? ""}`, config_1.config.azureAdClientId ?? ""],
            issuer: `https://login.microsoftonline.com/${config_1.config.azureAdTenantId ?? ""}/v2.0`,
            algorithms: ["RS256"],
        }, (err, decoded) => {
            if (err || !decoded) {
                reject(err ?? new Error("Token invalido."));
                return;
            }
            resolve(decoded);
        });
    });
}
function requireAuth(req, res, next) {
    if (!config_1.config.azureAdTenantId || !config_1.config.azureAdClientId) {
        next();
        return;
    }
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Se requiere autenticacion." });
        return;
    }
    const token = auth.slice(7);
    verifyAccessToken(token)
        .then((payload) => {
        const email = (payload["email"] || payload["preferred_username"] || "");
        if ((config_1.config.allowedDomains || config_1.config.allowedEmails) && !isEmailAllowed(email)) {
            console.warn("Acceso denegado", {
                email,
                rawEmailClaim: payload["email"],
                preferred_username: payload["preferred_username"],
                upn: payload["upn"],
                unique_name: payload["unique_name"],
            });
            res.status(403).json({ error: "Acceso no autorizado para este usuario." });
            return;
        }
        req.user = payload;
        next();
    })
        .catch((err) => {
        const unverified = jsonwebtoken_1.default.decode(token);
        console.warn("[auth] jwt.verify fallo:", err?.name, err?.message, {
            expectedAudience: `api://${config_1.config.azureAdClientId}`,
            expectedIssuer: `https://login.microsoftonline.com/${config_1.config.azureAdTenantId}/v2.0`,
            actualAudience: unverified?.aud,
            actualIssuer: unverified?.iss,
            actualVersion: unverified?.ver,
            actualTid: unverified?.tid,
        });
        res.status(401).json({ error: "Token invalido o expirado." });
    });
}
