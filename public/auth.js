// --- Auth (Firebase Authentication) -----------------------------------------
// El backend solo valida el ID token (middleware/auth.ts). apiKey y authDomain
// llegan desde /api/auth/config: son valores publicos, no secretos.
let _firebaseAuth = null;
let _authUser = null;
let _authEnabled = false;

function waitForAuthState() {
  // onAuthStateChanged dispara una vez que Firebase restauro (o descarto) la
  // sesion persistida; sin esperarlo, un reload redirige a login aunque la
  // sesion siga siendo valida.
  return new Promise((resolve) => {
    const unsubscribe = _firebaseAuth.onAuthStateChanged((user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

async function initAuth() {
  let cfg;
  try {
    cfg = await fetch("/api/auth/config").then((r) => r.json());
  } catch {
    // Falla cerrado: si no se puede saber si hay auth, se asume que si. Antes
    // esto devolvia true y la app corria sin login ante cualquier error de red.
    window.location.replace("/login.html");
    return false;
  }
  if (!cfg.enabled) return true;

  _authEnabled = true;

  if (!firebase.apps.length) {
    firebase.initializeApp({
      apiKey: cfg.apiKey,
      authDomain: cfg.authDomain,
      projectId: cfg.projectId,
    });
  }
  _firebaseAuth = firebase.auth();

  const user = await waitForAuthState();
  if (!user) {
    window.location.replace("/login.html");
    return false;
  }

  _authUser = user;
  showUserBadge(user);
  return true;
}

async function getToken() {
  if (!_authEnabled || !_firebaseAuth) return null;
  const user = _firebaseAuth.currentUser || _authUser;
  if (!user) {
    window.location.replace("/login.html");
    return null;
  }
  try {
    // getIdToken renueva solo si el token esta vencido (duran 1h).
    return await user.getIdToken();
  } catch {
    window.location.replace("/login.html");
    return null;
  }
}

async function authFetch(url, options = {}) {
  const token = await getToken();
  const headers = Object.assign({}, options.headers);
  if (token) headers["Authorization"] = "Bearer " + token;
  return fetch(url, Object.assign({}, options, { headers }));
}

function showUserBadge(user) {
  const nav = document.querySelector(".menu");
  if (!nav) return;
  const div = document.createElement("div");
  div.style.cssText = "display:flex;align-items:center;gap:12px;font-size:13px;color:#8ab4d4;margin-left:8px";
  div.innerHTML =
    '<span>' + escHtml(user.displayName || user.email || "") + "</span>" +
    '<button id="logoutBtn" style="padding:5px 12px;background:transparent;border:1px solid rgba(79,215,255,0.3);border-radius:6px;color:#4fd7ff;font-size:12px;cursor:pointer;font-family:inherit">Salir</button>';
  nav.after(div);
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await _firebaseAuth.signOut();
    } finally {
      window.location.replace("/login.html");
    }
  });
}

// --- Realtime (WebSocket) ----------------------------------------------------
// Reconexion con backoff exponencial (5s -> 10s -> 20s, tope 30s) ya que la
// app corre en una sola replica y cualquier redeploy/restart corta la conexion.
function openRealtime(onMessage) {
  let socket = null;
  let attempt = 0;
  let closedByUser = false;

  async function connect() {
    // El token va por query string porque el navegador no deja mandar headers
    // en `new WebSocket()`. Se pide en cada connect(), asi cada reconexion usa
    // uno fresco en vez de arrastrar el vencido.
    const token = await getToken();
    if (_authEnabled && !token) return; // getToken ya redirige a login si hace falta

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    socket = new WebSocket(wsUrl);

    socket.addEventListener("message", (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // ignorar mensajes no JSON
      }
    });

    socket.addEventListener("close", () => {
      if (closedByUser) return;
      attempt += 1;
      const delay = Math.min(30000, 5000 * attempt);
      setTimeout(connect, delay);
    });

    socket.addEventListener("open", () => {
      attempt = 0;
    });
  }

  connect();
  return {
    close() {
      closedByUser = true;
      socket?.close();
    },
  };
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}
