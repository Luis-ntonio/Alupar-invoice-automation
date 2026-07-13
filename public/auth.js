// --- Auth (MSAL) ------------------------------------------------------------
let _msalApp = null;
let _msalAccount = null;
let _msalScope = null;
let _authEnabled = false;

async function initAuth() {
  let cfg;
  try {
    cfg = await fetch("/api/auth/config").then((r) => r.json());
  } catch {
    return true;
  }
  if (!cfg.enabled) return true;

  _authEnabled = true;
  _msalScope = cfg.scope;

  _msalApp = new msal.PublicClientApplication({
    auth: {
      clientId: cfg.frontendClientId,
      authority: "https://login.microsoftonline.com/" + cfg.tenantId,
      redirectUri: window.location.origin + "/login.html",
    },
    cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false },
  });

  await _msalApp.handleRedirectPromise();

  const accounts = _msalApp.getAllAccounts();
  if (!accounts.length) {
    window.location.replace("/login.html");
    return false;
  }

  _msalAccount = accounts[0];
  showUserBadge(_msalAccount);
  return true;
}

async function getToken() {
  if (!_authEnabled || !_msalApp || !_msalAccount) return null;
  try {
    const r = await _msalApp.acquireTokenSilent({ scopes: [_msalScope], account: _msalAccount });
    return r.accessToken;
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

function showUserBadge(account) {
  const nav = document.querySelector(".menu");
  if (!nav) return;
  const div = document.createElement("div");
  div.style.cssText = "display:flex;align-items:center;gap:12px;font-size:13px;color:#8ab4d4;margin-left:8px";
  div.innerHTML =
    '<span>' + escHtml(account.name || account.username || "") + "</span>" +
    '<button id="logoutBtn" style="padding:5px 12px;background:transparent;border:1px solid rgba(79,215,255,0.3);border-radius:6px;color:#4fd7ff;font-size:12px;cursor:pointer;font-family:inherit">Salir</button>';
  nav.after(div);
  document.getElementById("logoutBtn").addEventListener("click", () => {
    _msalApp.logoutRedirect({ account: _msalAccount, postLogoutRedirectUri: "/login.html" });
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
