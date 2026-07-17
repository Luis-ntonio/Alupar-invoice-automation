import admin from "firebase-admin";
import { config } from "../config";

// Verificacion de ID tokens de Firebase Authentication.
// En Cloud Run, initializeApp() sin args usa ADC (la service account del
// servicio) y GOOGLE_CLOUD_PROJECT. El backend NO guarda usuarios ni
// contrasenas: Firebase gestiona el login; aqui solo se valida el token.

let app: admin.app.App | null = null;

function getApp(): admin.app.App {
  if (!app) {
    app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ projectId: config.firebaseProjectId });
  }
  return app;
}

export interface AuthUser {
  uid: string;
  email?: string;
  name?: string;
}

export async function verifyIdToken(token: string): Promise<AuthUser> {
  const decoded = await getApp().auth().verifyIdToken(token);
  return {
    uid: decoded.uid,
    email: decoded.email,
    name: (decoded.name as string | undefined) ?? decoded.email,
  };
}

// En produccion la autenticacion es SIEMPRE obligatoria: si faltara alguna env
// var, verifyIdToken falla y requireAuth responde 401 en vez de dejar pasar. Es
// deliberado que una variable ausente cierre la app y no que la abra.
// Fuera de produccion (dev local sin Firebase) se corre sin exigir token.
export function isAuthEnabled(): boolean {
  if (config.nodeEnv === "production") {
    return true;
  }
  return Boolean(config.firebaseProjectId && config.firebaseApiKey);
}

// Se invoca al arrancar. En produccion, un servicio sin auth configurada no debe
// levantar: es preferible que Cloud Run marque la revision como fallida (y siga
// sirviendo la anterior) antes que exponer las facturas sin login.
export function assertAuthConfigured(): void {
  if (config.nodeEnv !== "production") {
    return;
  }
  const missing: string[] = [];
  if (!config.firebaseProjectId) missing.push("FIREBASE_PROJECT_ID (o GOOGLE_CLOUD_PROJECT)");
  if (!config.firebaseApiKey) missing.push("FIREBASE_API_KEY");
  if (missing.length) {
    throw new Error(
      `Autenticacion mal configurada en produccion. Faltan: ${missing.join(", ")}.`
    );
  }
}
