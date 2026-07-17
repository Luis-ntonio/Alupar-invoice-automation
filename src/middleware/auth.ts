import type { Request, Response, NextFunction } from "express";
import { isAuthEnabled, verifyIdToken, type AuthUser } from "../services/firebaseAuth";

// Autenticacion con Firebase Authentication. El frontend inicia sesion con
// email/contrasena (SDK de Firebase) y envia el ID token como Bearer; aqui se
// verifica contra las claves publicas de Google via firebase-admin. La lista de
// usuarios permitidos es la propia lista de Firebase (no hay allow-list local).

export { verifyIdToken } from "../services/firebaseAuth";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Se requiere autenticacion." });
    return;
  }

  const token = auth.slice(7);
  verifyIdToken(token)
    .then((user: AuthUser) => {
      (req as any).user = user;
      next();
    })
    .catch((err) => {
      console.warn("[auth] verifyIdToken fallo:", err?.code || err?.name, err?.message);
      res.status(401).json({ error: "Token invalido o expirado." });
    });
}
