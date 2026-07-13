// --- State -----------------------------------------------------------------
let failedDocuments = [];

const fallidasStatus = document.getElementById("fallidasStatus");
const fallidasList = document.getElementById("fallidasList");

const DOCUMENT_TYPE_OPTIONS = ["factura", "comprobante", "nota", "desconocido"];
// Centros de costo oficiales (ver "centro de costos.jpeg"). Se guarda el codigo;
// el dropdown muestra "codigo — concepto".
const COST_CENTER_OPTIONS = [
  { code: "004.1.6", concepto: "Ingreso Tarifario Red MAT SST & SCT" },
  { code: "004.1.7", concepto: "Compensación por Ingreso Tarifario" },
  { code: "004.1.8", concepto: "Liquidación del Peaje de Conexión SPT" },
  { code: "004.1.9", concepto: "Valorización de Transferencias de Potencia" },
  { code: "004.1.11", concepto: "Liquidación de SCIO" },
  { code: "004.1.12", concepto: "Pagos SST GD REP" },
  { code: "004.1.15", concepto: "Peaje por Área Demanda" },
  { code: "004.1.16", concepto: "Peaje por Distribución" },
  { code: "004.2.1", concepto: "Comercialización de Energía Activa" },
  { code: "004.2.3", concepto: "Transferencia de Potencia Firme" },
];

function costCenterOptionsHtml(current) {
  return COST_CENTER_OPTIONS.map(
    (opt) => `<option value="${escHtml(opt.code)}" ${opt.code === current ? "selected" : ""}>${escHtml(opt.code + " — " + opt.concepto)}</option>`
  ).join("");
}

function formatDateTime(raw) {
  if (!raw) return "-";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("es-PE");
}

function buildEmailPreviewSrcdoc(record) {
  const raw = record?.metadata?.bodyHtml || record?.metadata?.emailBodyHtml || record?.metadata?.html || record?.metadata?.body;
  const text = record?.metadata?.bodyText;
  if (raw) {
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:12px;font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;font-size:13px} img{max-width:100%;height:auto} table{max-width:100%;border-collapse:collapse}</style></head><body>${raw}</body></html>`;
  }
  if (text) {
    return `<!doctype html><html><body style="margin:0;padding:12px;font-family:'IBM Plex Mono',monospace;font-size:12px;white-space:pre-wrap;">${escHtml(text)}</body></html>`;
  }
  return null;
}

function optionsHtml(options, current) {
  return options.map((opt) => `<option value="${escHtml(opt)}" ${opt === current ? "selected" : ""}>${escHtml(opt)}</option>`).join("");
}

function renderCard(item) {
  const srcdoc = buildEmailPreviewSrcdoc(item);
  const preview = srcdoc
    ? `<iframe class="failed-preview-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${escHtml(srcdoc)}"></iframe>`
    : `<p class="muted">No se recibio el cuerpo del correo.</p>`;

  const ext = item.extracted || {};
  return `
    <article class="failed-card" data-failed-id="${item.id}">
      <div class="failed-card-main">
        <div class="failed-card-meta">
          <p><strong>De:</strong> ${escHtml(item.metadata?.sender || "-")}</p>
          <p><strong>Asunto:</strong> ${escHtml(item.metadata?.subject || "-")}</p>
          <p><strong>Recibido:</strong> ${formatDateTime(item.metadata?.receivedAt || item.createdAt)}</p>
          <p class="failed-card-error"><strong>Error:</strong> ${escHtml(item.error || "Error desconocido durante el procesamiento.")}</p>
        </div>
        ${preview}
      </div>

      <div class="failed-card-actions">
        <button class="btn-secondary btn-secondary-bright" type="button" data-toggle-form="${item.id}">Llenar datos manualmente</button>
      </div>

      <form class="failed-card-form" data-form-id="${item.id}" hidden>
        <label>Empresa (emisor)<input name="empresa" type="text" value="${escHtml(item.empresa || ext.emisor || "")}" /></label>
        <label>RUC<input name="ruc" type="text" value="${escHtml(item.ruc || ext.ruc || "")}" /></label>
        <label>Tipo de documento<select name="documentType">${optionsHtml(DOCUMENT_TYPE_OPTIONS, item.documentType || "desconocido")}</select></label>
        <label>Centro de costos<select name="centroCostos"><option value="">Seleccionar...</option>${costCenterOptionsHtml(item.centroCostos || "")}</select></label>
        <label>Numero de documento<input name="numeroDocumento" type="text" value="${escHtml(ext.numeroDocumento || "")}" /></label>
        <label>Fecha de emision<input name="fechaEmision" type="text" placeholder="YYYY-MM-DD" value="${escHtml(ext.fechaEmision || "")}" /></label>
        <label>Fecha de vencimiento<input name="fechaVencimiento" type="text" placeholder="YYYY-MM-DD" value="${escHtml(ext.fechaVencimiento || "")}" /></label>
        <label>Monto (con IGV)<input name="monto" type="number" step="0.01" min="0" value="${ext.monto != null ? ext.monto : ""}" /></label>
        <label class="failed-card-form-wide">Concepto<input name="concept" type="text" value="${escHtml(item.concept || "")}" /></label>
        <div class="failed-card-form-actions">
          <button class="btn-primary" type="submit">Guardar y enviar a dashboard</button>
          <button class="btn-secondary" type="button" data-cancel-form="${item.id}">Cancelar</button>
        </div>
        <p class="status-line" data-form-status="${item.id}"></p>
      </form>
    </article>`;
}

function render() {
  if (!failedDocuments.length) {
    fallidasList.innerHTML = '<p class="muted">No hay facturas con error de procesamiento.</p>';
    return;
  }
  fallidasList.innerHTML = failedDocuments.map(renderCard).join("");
}

async function loadFailed() {
  fallidasStatus.textContent = "Cargando...";
  try {
    const res = await authFetch("/api/documents?status=error");
    const data = await res.json();
    failedDocuments = data.items || [];
    fallidasStatus.textContent = `${failedDocuments.length} factura(s) con error.`;
    render();
  } catch (err) {
    fallidasStatus.textContent = "No se pudo cargar la lista de facturas fallidas.";
  }
}

fallidasList.addEventListener("click", (event) => {
  const toggleBtn = event.target.closest("[data-toggle-form]");
  if (toggleBtn) {
    const form = fallidasList.querySelector(`[data-form-id="${toggleBtn.dataset.toggleForm}"]`);
    if (form) form.hidden = !form.hidden;
    return;
  }
  const cancelBtn = event.target.closest("[data-cancel-form]");
  if (cancelBtn) {
    const form = fallidasList.querySelector(`[data-form-id="${cancelBtn.dataset.cancelForm}"]`);
    if (form) form.hidden = true;
  }
});

// El concepto queda anexado al centro de costos: al elegir un centro se
// autocompleta el concepto oficial de ese centro (ver COST_CENTER_OPTIONS).
fallidasList.addEventListener("change", (event) => {
  const select = event.target.closest('select[name="centroCostos"]');
  if (!select) return;
  const form = select.closest("[data-form-id]");
  const conceptInput = form && form.querySelector('input[name="concept"]');
  if (!conceptInput) return;
  const opt = COST_CENTER_OPTIONS.find((o) => o.code === select.value);
  if (opt) conceptInput.value = opt.concepto;
});

fallidasList.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form-id]");
  if (!form) return;
  event.preventDefault();
  const id = form.dataset.formId;
  const statusEl = fallidasList.querySelector(`[data-form-status="${id}"]`);
  const formData = new FormData(form);

  const payload = { resolveError: true };
  for (const key of ["empresa", "ruc", "documentType", "centroCostos", "numeroDocumento", "fechaEmision", "fechaVencimiento", "concept"]) {
    const value = (formData.get(key) || "").toString().trim();
    if (value) payload[key] = value;
  }
  const montoRaw = (formData.get("monto") || "").toString().trim();
  if (montoRaw) payload.monto = Number(montoRaw);

  statusEl.textContent = "Guardando...";
  try {
    const res = await authFetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = err.error || "No se pudo guardar.";
      return;
    }
    failedDocuments = failedDocuments.filter((doc) => doc.id !== id);
    fallidasStatus.textContent = `${failedDocuments.length} factura(s) con error.`;
    render();
  } catch (err) {
    statusEl.textContent = "No se pudo guardar.";
  }
});

initAuth().then((ok) => {
  if (ok !== false) loadFailed();
});
