"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
    jsonwebtoken_1.default.verify(token, getKey, {
        audience: `api://${config_1.config.azureAdClientId}`,
        issuer: `https://login.microsoftonline.com/${config_1.config.azureAdTenantId}/v2.0`,
        algorithms: ["RS256"],
    }, (err, decoded) => {
        if (err) {
            res.status(401).json({ error: "Token invalido o expirado." });
            return;
        }
        const payload = decoded;
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
    });
}
