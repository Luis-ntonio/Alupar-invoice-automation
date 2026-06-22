import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { config } from "../config";

let client: jwksClient.JwksClient | null = null;

function getJwksClient(): jwksClient.JwksClient {
  if (!client) {
    client = jwksClient({
      jwksUri: `https://login.microsoftonline.com/${config.azureAdTenantId}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
    });
  }
  return client;
}

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  getJwksClient().getSigningKey(header.kid!, (err, key) => {
    if (err) return callback(err);
    callback(null, key!.getPublicKey());
  });
}

function isEmailAllowed(email: string): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();

  const domains = (config.allowedDomains ?? "")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const emails = (config.allowedEmails ?? "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

  if (domains.some((d) => lower.endsWith("@" + d))) return true;
  if (emails.includes(lower)) return true;
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.azureAdTenantId || !config.azureAdClientId) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Se requiere autenticacion." });
    return;
  }

  const token = auth.slice(7);
  jwt.verify(
    token,
    getKey,
    {
      // Azure AD puede emitir el aud como "api://{clientId}" o como el GUID
      // pelado, segun como se resuelva el recurso al momento de emitir el
      // token v2.0 (mismo App Registration, ambas formas son validas).
      audience: [`api://${config.azureAdClientId}`, config.azureAdClientId],
      issuer: `https://login.microsoftonline.com/${config.azureAdTenantId}/v2.0`,
      algorithms: ["RS256"],
    },
    (err, decoded) => {
      if (err) {
        const unverified = jwt.decode(token) as jwt.JwtPayload | null;
        console.warn("[auth] jwt.verify fallo:", err.name, err.message, {
          expectedAudience: `api://${config.azureAdClientId}`,
          expectedIssuer: `https://login.microsoftonline.com/${config.azureAdTenantId}/v2.0`,
          actualAudience: unverified?.aud,
          actualIssuer: unverified?.iss,
          actualVersion: (unverified as any)?.ver,
          actualTid: (unverified as any)?.tid,
        });
        res.status(401).json({ error: "Token invalido o expirado." });
        return;
      }
      const payload = decoded as jwt.JwtPayload;
      const email = (payload["email"] || payload["preferred_username"] || "") as string;

      if ((config.allowedDomains || config.allowedEmails) && !isEmailAllowed(email)) {
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

      (req as any).user = payload;
      next();
    }
  );
}
