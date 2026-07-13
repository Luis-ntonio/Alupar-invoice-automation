// --- State -----------------------------------------------------------------
let allDocuments = [];
let chartInstance = null;
let timePeriod = "all"; // all | today | week | month
let columnFilters = {}; // key -> Set<string> | null
let chartCompanyFilters = null; // Set<string> | null
let activeDropdown = null;
let activeDropdownCol = null;
let chartCompaniesMenuOpen = false;

// Centros de costo oficiales (ver "centro de costos.jpeg"). El valor guardado es
// el codigo; en el dropdown se muestra "codigo — concepto" para el operador.
// Solo aplican a facturas; el centro de costo se deriva del concepto.
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

const COLUMNS = [
  { key: "fechaRecepcion", label: "Fecha recepcion" },
  { key: "fechaEmision", label: "Fecha emision" },
  { key: "fechaVencimiento", label: "Fecha vencimiento" },
  { key: "empresa", label: "Empresa", editable: true },
  { key: "ruc", label: "RUC" },
  { key: "codigoFactura", label: "Codigo de Factura", title: "Serie-numero del comprobante (usado en la validacion SUNAT)" },
  { key: "documentType", label: "Tipo Doc", editable: true },
  { key: "fideicomiso", label: "Fideicomiso", editable: true, title: "Emisor tipo fideicomiso (detectado del XML)" },
  { key: "centroCostos", label: "Centro de costos", editable: true },
  { key: "coesValidacion", label: "Val. COES", title: "Validacion de monto COES (VTEA/VTP)" },
  { key: "concept", label: "Concepto" },
  { key: "monto", label: "Monto (IGV agregado 18%)", editable: true },
  { key: "montoSinIgv", label: "Monto sin IGV" },
  { key: "estadoComprobante", label: "Est. CP", title: "Estado del Comprobante (SUNAT)" },
  { key: "estadoContribuyente", label: "Est. RUC", title: "Estado del Contribuyente (SUNAT)" },
  { key: "condicionDomicilio", label: "Domicilio", title: "Condicion de Domicilio (SUNAT)" },
  { key: "status", label: "Estado" },
];

// --- DOM refs ---------------------------------------------------------------
const bodyEl = document.getElementById("documentsBody");
const summaryEl = document.getElementById("summary");
const chartPanel = document.getElementById("chartPanel");
const exportResult = document.getElementById("exportResult");
const importResult = document.getElementById("importResult");
const tableHeadRow = document.getElementById("tableHeadRow");
const timeBtns = document.querySelectorAll(".time-btn");
const massiveImportBtn = document.getElementById("massiveImportBtn");
const massiveImportInput = document.getElementById("massiveImportInput");
const chartCompaniesBtn = document.getElementById("chartCompaniesBtn");
const chartCompaniesMenu = document.getElementById("chartCompaniesMenu");
const chartCompaniesSearch = document.getElementById("chartCompaniesSearch");
const chartCompaniesAll = document.getElementById("chartCompaniesAll");
const chartCompaniesList = document.getElementById("chartCompaniesList");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");
const emailPreviewModal = document.getElementById("emailPreviewModal");
const emailPreviewFrame = document.getElementById("emailPreviewFrame");
const emailPreviewText = document.getElementById("emailPreviewText");
const emailPreviewMeta = document.getElementById("emailPreviewMeta");
const emailPreviewTitle = document.getElementById("emailPreviewTitle");
const closeEmailPreviewBtn = document.getElementById("closeEmailPreviewBtn");
const exportSelectionModal = document.getElementById("exportSelectionModal");
const exportSelectionList = document.getElementById("exportSelectionList");
const closeExportModalBtn = document.getElementById("closeExportModalBtn");
const exportSelectionConfirmBtn = document.getElementById("exportSelectionConfirmBtn");
const exportSelectionCancelBtn = document.getElementById("exportSelectionCancelBtn");

// --- Helpers ----------------------------------------------------------------
function parseDateOnly(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(raw + "T00:00:00");
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [d, m, y] = raw.split("/");
    return new Date(`${y}-${m}-${d}T00:00:00`);
  }
  return null;
}

function formatIsoDateTime(raw) {
  if (!raw) return "-";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("es-PE");
}

function formatDateOnly(raw) {
  const d = parseDateOnly(raw);
  if (!d) return "-";
  return d.toLocaleDateString("es-PE");
}

function getEmissionDate(doc) {
  return parseDateOnly(doc.extracted?.fechaEmision);
}

function getFilterValue(item, key) {
  switch (key) {
    case "fechaRecepcion": return formatIsoDateTime(item.metadata?.receivedAt || item.createdAt);
    case "fechaEmision": return formatDateOnly(item.extracted?.fechaEmision);
    case "fechaVencimiento": return formatDateOnly(item.extracted?.fechaVencimiento);
    case "empresa": return item.empresa || "-";
    case "ruc": return item.ruc || "-";
    case "codigoFactura": return item.extracted?.numeroDocumento || "-";
    case "documentType": return item.documentType || "-";
    case "fideicomiso": return item.fideicomiso ? "Sí" : "No";
    case "centroCostos": return item.centroCostos || "-";
    case "coesValidacion": return item.coesValidacion?.status || "-";
    case "concept": return item.concept || "-";
    case "monto": return item.extracted?.monto != null ? Number(item.extracted.monto).toFixed(2) : "-";
    case "montoSinIgv": return item.extracted?.monto != null ? (Number(item.extracted.monto) / 1.18).toFixed(2) : "-";
    case "estadoComprobante": return item.sunatValidacion?.estadoComprobante || "-";
    case "estadoContribuyente": return item.sunatValidacion?.estadoContribuyente || "-";
    case "condicionDomicilio": return item.sunatValidacion?.condicionDomicilio || "-";
    case "status": return item.status || "-";
    default: return "-";
  }
}

function formatMonto(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getDisplayValue(item, key) {
  switch (key) {
    case "fechaRecepcion": return formatIsoDateTime(item.metadata?.receivedAt || item.createdAt);
    case "fechaEmision": return formatDateOnly(item.extracted?.fechaEmision);
    case "fechaVencimiento": return formatDateOnly(item.extracted?.fechaVencimiento);
    case "monto": return item.extracted?.monto != null
      ? `${formatMonto(item.extracted.monto)} ${item.extracted?.moneda || ""}`.trim()
      : "-";
    case "montoSinIgv": return item.extracted?.monto != null
      ? `${formatMonto(item.extracted.monto / 1.18)} ${item.extracted?.moneda || ""}`.trim()
      : "-";
    default:
      return getFilterValue(item, key);
  }
}

function getUniqueValues(col) {
  return [...new Set(allDocuments.map((f) => getFilterValue(f, col)))].sort();
}

function isColFiltered(col) {
  const sel = columnFilters[col];
  if (!sel) return false;
  return sel.size < getUniqueValues(col).length;
}

function selectedIds() {
  return [...document.querySelectorAll(".doc-check:checked")].map((cb) => cb.dataset.id);
}

function getSelectedDocuments() {
  const ids = new Set(selectedIds());
  return allDocuments.filter((d) => ids.has(d.id));
}

function getSelectedCompanies() {
  const docs = getSelectedDocuments();
  return [...new Set(docs.map((d) => (d.empresa || "SIN EMPRESA").trim()))].filter(Boolean);
}

function clearAllFilters() {
  columnFilters = {};
  chartCompanyFilters = null;
  timePeriod = "all";
  timeBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.period === "all"));
  closeDropdown();
  toggleChartCompaniesMenu(false);
  applyAndRender();
}

// --- Filter logic ------------------------------------------------------------
function applyFilters() {
  let result = [...allDocuments];

  if (timePeriod !== "all") {
    const now = new Date();
    let cutoff;
    if (timePeriod === "today") {
      cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (timePeriod === "week") {
      cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (timePeriod === "month") {
      cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    if (cutoff) {
      result = result.filter((d) => {
        const fecha = getEmissionDate(d) ?? new Date(d.createdAt);
        return fecha >= cutoff;
      });
    }
  }

  for (const [col, sel] of Object.entries(columnFilters)) {
    if (sel && sel.size > 0) {
      result = result.filter((item) => sel.has(getFilterValue(item, col)));
    }
  }

  return result;
}

// --- Table headers -----------------------------------------------------------
function buildTableHeaders() {
  const thCheck = document.createElement("th");
  thCheck.className = "col-check";
  const cbAll = document.createElement("input");
  cbAll.type = "checkbox";
  cbAll.id = "checkAll";
  cbAll.title = "Seleccionar todo";
  thCheck.appendChild(cbAll);
  tableHeadRow.appendChild(thCheck);

  for (const col of COLUMNS) {
    const th = document.createElement("th");
    if (col.title) th.title = col.title;
    th.dataset.col = col.key;

    const span = document.createElement("span");
    span.className = "th-text";
    span.textContent = col.label;

    const btn = document.createElement("button");
    btn.className = "filter-trigger";
    btn.dataset.col = col.key;
    btn.textContent = "▾";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      activeDropdownCol === col.key ? closeDropdown() : openDropdown(col.key, btn);
    });

    th.appendChild(span);
    th.appendChild(btn);
    tableHeadRow.appendChild(th);
  }

  const thFiles = document.createElement("th");
  thFiles.textContent = "Archivos";
  tableHeadRow.appendChild(thFiles);

  document.getElementById("checkAll").addEventListener("change", (e) => {
    document.querySelectorAll(".doc-check").forEach((cb) => {
      cb.checked = e.target.checked;
    });
  });
}

function refreshFilterIcons() {
  COLUMNS.forEach(({ key }) => {
    const btn = tableHeadRow.querySelector(`.filter-trigger[data-col="${key}"]`);
    if (btn) btn.classList.toggle("filter-active", isColFiltered(key));
  });
}

// --- Editable cells ----------------------------------------------------------
function cellForKey(item, key) {
  if (key === "empresa") {
    return `<span class="cell-display cell-truncate" data-edit-open="1" data-edit-field="empresa" data-id="${item.id}" title="${escHtml(item.empresa || "-")}">${escHtml(item.empresa || "-")}</span>`;
  }
  if (key === "documentType") {
    return `<span class="cell-display" data-edit-open="1" data-edit-field="documentType" data-id="${item.id}">${escHtml(item.documentType || "desconocido")}</span>`;
  }
  if (key === "fideicomiso") {
    return `<span class="cell-display" data-edit-open="1" data-edit-field="fideicomiso" data-id="${item.id}">${item.fideicomiso ? "Sí" : "No"}</span>`;
  }
  if (key === "centroCostos") {
    // El centro de costos solo aplica a facturas; en el resto no es editable.
    if (item.documentType !== "factura") {
      return `<span class="cell-display muted" title="El centro de costos solo aplica a facturas">N/A</span>`;
    }
    return `<span class="cell-display" data-edit-open="1" data-edit-field="centroCostos" data-id="${item.id}">${escHtml(item.centroCostos || "Seleccionar...")}</span>`;
  }
  if (key === "monto") {
    const value = item.extracted?.monto != null ? formatMonto(item.extracted.monto) : "-";
    return `<span class="cell-display mono" data-edit-open="1" data-edit-field="monto" data-id="${item.id}">${escHtml(value)}</span>`;
  }
  if (key === "concept") {
    const value = getDisplayValue(item, key);
    return `<span class="cell-truncate cell-expandable" data-expandable="1">${escHtml(value)}</span>`;
  }
  return escHtml(getDisplayValue(item, key));
}

function buildEditorControl(doc, field) {
  if (field === "empresa") {
    return `<input class="cell-input" data-edit-field="empresa" data-id="${doc.id}" value="${escHtml(doc.empresa || "")}" />`;
  }
  if (field === "documentType") {
    const options = ["factura", "comprobante", "nota", "desconocido"];
    const current = doc.documentType || "desconocido";
    const opts = options
      .map((opt) => `<option value="${opt}" ${opt === current ? "selected" : ""}>${opt}</option>`)
      .join("");
    return `<select class="cell-input" data-edit-field="documentType" data-id="${doc.id}">${opts}</select>`;
  }
  if (field === "fideicomiso") {
    const current = doc.fideicomiso ? "Sí" : "No";
    const opts = ["Sí", "No"]
      .map((opt) => `<option value="${opt}" ${opt === current ? "selected" : ""}>${opt}</option>`)
      .join("");
    return `<select class="cell-input" data-edit-field="fideicomiso" data-id="${doc.id}">${opts}</select>`;
  }
  if (field === "centroCostos") {
    const current = doc.centroCostos || "";
    const opts = [`<option value="" ${current ? "" : "selected"}>Seleccionar...</option>`]
      .concat(
        COST_CENTER_OPTIONS.map(
          (opt) =>
            `<option value="${escHtml(opt.code)}" ${opt.code === current ? "selected" : ""}>${escHtml(opt.code + " — " + opt.concepto)}</option>`
        )
      )
      .join("");
    return `<select class="cell-input" data-edit-field="centroCostos" data-id="${doc.id}">${opts}</select>`;
  }
  if (field === "monto") {
    const value = doc.extracted?.monto != null ? Number(doc.extracted.monto).toFixed(2) : "";
    return `<input class="cell-input mono" type="number" step="0.01" min="0" data-edit-field="monto" data-id="${doc.id}" value="${escHtml(value)}" />`;
  }
  return "";
}

function openCellEditor(buttonEl) {
  const id = buttonEl.dataset.id;
  const field = buttonEl.dataset.editField;
  if (!id || !field) return;
  const doc = allDocuments.find((item) => item.id === id);
  if (!doc) return;

  const td = buttonEl.closest("td");
  if (!td) return;

  td.innerHTML = buildEditorControl(doc, field);
  const editor = td.querySelector("[data-edit-field]");
  if (!editor) return;

  editor.focus();
  if (editor.tagName === "INPUT") {
    editor.select();
  }
}

async function deleteDocument(id) {
  const res = await authFetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || "No se pudo eliminar el documento.");
  }
}

async function patchDocument(id, patch) {
  const res = await authFetch(`/api/documents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || "No se pudo actualizar el documento.");
  }
  return payload.item;
}

async function handleCellEditCommit(el) {
  if (el.dataset.saving === "1") return;

  const id = el.dataset.id;
  const field = el.dataset.editField;
  if (!id || !field) return;

  const doc = allDocuments.find((item) => item.id === id);
  if (!doc) return;

  let patch;
  if (field === "empresa") {
    const value = String(el.value || "").trim();
    if (!value || value === (doc.empresa || "")) {
      applyAndRender();
      return;
    }
    patch = { empresa: value };
  } else if (field === "documentType") {
    const value = String(el.value || "desconocido");
    if (value === (doc.documentType || "desconocido")) {
      applyAndRender();
      return;
    }
    patch = { documentType: value };
  } else if (field === "fideicomiso") {
    const value = String(el.value || "No") === "Sí";
    if (value === Boolean(doc.fideicomiso)) {
      applyAndRender();
      return;
    }
    patch = { fideicomiso: value };
  } else if (field === "centroCostos") {
    const value = String(el.value || "").trim();
    if (!value || value === (doc.centroCostos || "")) {
      applyAndRender();
      return;
    }
    // El concepto queda anexado al centro de costos: al elegir un centro, el
    // concepto se fija al concepto oficial de ese centro (ver COST_CENTER_OPTIONS
    // / "centro de costos.jpeg"), de modo que ambas columnas queden consistentes.
    const opt = COST_CENTER_OPTIONS.find((o) => o.code === value);
    patch = opt ? { centroCostos: value, concept: opt.concepto } : { centroCostos: value };
  } else if (field === "monto") {
    const raw = String(el.value || "").trim();
    if (!raw) {
      applyAndRender();
      return;
    }
    const monto = Number(raw);
    if (!Number.isFinite(monto) || monto < 0) {
      exportResult.textContent = "Monto invalido.";
      applyAndRender();
      return;
    }
    const current = doc.extracted?.monto;
    if (current != null && Math.abs(current - monto) < 1e-9) {
      applyAndRender();
      return;
    }
    patch = { monto };
  }

  if (!patch) return;

  const previousMessage = exportResult.textContent;
  exportResult.textContent = "Guardando cambios...";
  el.dataset.saving = "1";
  el.disabled = true;
  try {
    const updated = await patchDocument(id, patch);
    const idx = allDocuments.findIndex((item) => item.id === id);
    if (idx >= 0) allDocuments[idx] = updated;
    exportResult.textContent = "Cambios guardados.";
    applyAndRender();
  } catch (error) {
    exportResult.textContent = error.message || "No se pudo guardar el cambio.";
    applyAndRender();
  } finally {
    delete el.dataset.saving;
    el.disabled = false;
    setTimeout(() => {
      if (exportResult.textContent === "Cambios guardados.") {
        exportResult.textContent = previousMessage || "";
      }
    }, 1200);
  }
}

// --- Rows --------------------------------------------------------------------
function renderRows(items) {
  if (!items.length) {
    bodyEl.innerHTML = `<tr><td colspan="${COLUMNS.length + 2}" class="muted">No hay documentos para el filtro actual.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = items.map((item) => {
    const fileLinks = (item.files || [])
      .map((f) => {
        const url = `/api/documents/${item.id}/files/${encodeURIComponent(f.fileName)}`;
        return `<a class="badge-file badge-file-${f.fileType}" href="${url}" target="_blank" rel="noopener">${f.fileType.toUpperCase()}</a>`;
      })
      .join(" ");

    const hasEmailBody = Boolean(item.metadata?.bodyHtml || item.metadata?.emailBodyHtml || item.metadata?.html || item.metadata?.body || item.metadata?.bodyText);
    const emailPreviewButton = hasEmailBody
      ? `<button class="badge-file badge-file-email email-preview-btn" type="button" data-email-preview="${item.id}" title="Ver correo" aria-label="Ver correo">✉</button>`
      : "";
    const downloadAll = item.files?.length
      ? `<a class="btn-link" href="/api/documents/${item.id}/file" title="Descargar todos">↓</a>`
      : "";
    const deleteButton = `<button class="btn-link btn-delete" type="button" data-delete-id="${item.id}" title="Eliminar registro" aria-label="Eliminar registro">✕</button>`;

    return `
      <tr>
        <td class="col-check"><input type="checkbox" class="doc-check" data-id="${item.id}" /></td>
        <td>${cellForKey(item, "fechaRecepcion")}</td>
        <td>${cellForKey(item, "fechaEmision")}</td>
        <td>${cellForKey(item, "fechaVencimiento")}</td>
        <td>${cellForKey(item, "empresa")}</td>
        <td class="mono">${cellForKey(item, "ruc")}</td>
        <td class="mono">${cellForKey(item, "codigoFactura")}</td>
        <td>${cellForKey(item, "documentType")}</td>
        <td>${cellForKey(item, "fideicomiso")}</td>
        <td>${cellForKey(item, "centroCostos")}</td>
        <td title="${escHtml(item.coesValidacion?.detalle || "")}">${cellForKey(item, "coesValidacion")}</td>
        <td>${cellForKey(item, "concept")}</td>
        <td class="mono">${cellForKey(item, "monto")}</td>
        <td class="mono">${cellForKey(item, "montoSinIgv")}</td>
        <td class="sunat-cell">${cellForKey(item, "estadoComprobante")}</td>
        <td class="sunat-cell">${cellForKey(item, "estadoContribuyente")}</td>
        <td class="sunat-cell">${cellForKey(item, "condicionDomicilio")}</td>
        <td><span class="badge badge-${item.status}">${item.status}</span></td>
        <td class="file-links">${fileLinks} ${emailPreviewButton} ${downloadAll} ${deleteButton}</td>
      </tr>`;
  }).join("");
}

function buildEmailPreviewHtml(record) {
  const raw = record?.metadata?.bodyHtml || record?.metadata?.emailBodyHtml || record?.metadata?.html || record?.metadata?.body;
  const text = record?.metadata?.bodyText;
  if (raw) return { mode: "html", content: String(raw) };
  if (text) return { mode: "text", content: String(text) };
  return null;
}

function openEmailPreview(record) {
  const preview = buildEmailPreviewHtml(record);
  if (!preview) return;

  const metaParts = [];
  if (record?.metadata?.sender) metaParts.push(`De: ${record.metadata.sender}`);
  if (record?.metadata?.subject) metaParts.push(`Asunto: ${record.metadata.subject}`);
  if (record?.metadata?.receivedAt) metaParts.push(`Recibido: ${record.metadata.receivedAt}`);
  emailPreviewMeta.textContent = metaParts.join(" • ");
  emailPreviewTitle.textContent = record?.metadata?.subject || "Correo recibido";

  if (preview.mode === "html") {
    emailPreviewFrame.hidden = false;
    emailPreviewText.hidden = true;
    emailPreviewFrame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111} img{max-width:100%;height:auto} table{max-width:100%;border-collapse:collapse} hr{border:none;border-top:1px solid #ddd}</style></head><body>${preview.content}</body></html>`;
  } else {
    emailPreviewFrame.hidden = true;
    emailPreviewText.hidden = false;
    emailPreviewText.textContent = preview.content;
    emailPreviewFrame.srcdoc = "";
  }

  emailPreviewModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeEmailPreview() {
  emailPreviewModal.hidden = true;
  emailPreviewFrame.srcdoc = "";
  emailPreviewText.textContent = "";
  document.body.classList.remove("modal-open");
}

function renderSummary(items) {
  const counts = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.documentType] = (acc[item.documentType] || 0) + 1;
      return acc;
    },
    { total: 0 }
  );
  const cards = [
    ["Total", counts.total || 0],
    ["Facturas", counts.factura || 0],
    ["Comprobantes", counts.comprobante || 0],
    ["Notas", counts.nota || 0],
    ["Desconocido", counts.desconocido || 0],
  ];
  summaryEl.innerHTML = cards.map(([label, value]) => `<article class="card"><p>${label}</p><strong>${value}</strong></article>`).join("");
}

function renderHeroStats(items) {
  const empresas = new Set(items.map((item) => item.empresa).filter(Boolean));
  const pendientes = items.filter((item) => item.status !== "procesado").length;
  document.getElementById("heroTotalDocs").textContent = String(items.length);
  document.getElementById("heroEmpresas").textContent = String(empresas.size);
  document.getElementById("heroPendientes").textContent = String(pendientes);
}

function applyAndRender() {
  const filtered = applyFilters();
  renderSummary(filtered);
  renderHeroStats(allDocuments);
  renderRows(filtered);
  refreshFilterIcons();
  syncChartCompaniesMenu(filtered);
  renderChart(filtered);
}

// --- Column filter dropdown --------------------------------------------------
function openDropdown(col, triggerEl) {
  closeDropdown();

  const uniq = getUniqueValues(col);
  const sel = columnFilters[col] ?? new Set(uniq);

  const panel = document.createElement("div");
  panel.className = "col-filter-panel";

  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Buscar...";
  search.className = "col-filter-search";
  panel.appendChild(search);

  const allWrap = document.createElement("label");
  allWrap.className = "col-filter-item col-filter-all";
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked = uniq.every((v) => sel.has(v));
  allCb.indeterminate = !allCb.checked && uniq.some((v) => sel.has(v));
  allWrap.appendChild(allCb);
  allWrap.appendChild(document.createTextNode(" Seleccionar todo"));
  panel.appendChild(allWrap);

  const divider = document.createElement("hr");
  divider.className = "col-filter-divider";
  panel.appendChild(divider);

  const listEl = document.createElement("div");
  listEl.className = "col-filter-list";
  for (const val of uniq) {
    const lbl = document.createElement("label");
    lbl.className = "col-filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = val;
    cb.checked = sel.has(val);
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(" " + (val || "(vacio)")));
    listEl.appendChild(lbl);
  }
  panel.appendChild(listEl);

  search.addEventListener("input", () => {
    const q = search.value.toLowerCase();
    listEl.querySelectorAll("label").forEach((lbl) => {
      lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  allCb.addEventListener("change", () => {
    listEl.querySelectorAll("label").forEach((lbl) => {
      if (lbl.style.display !== "none") lbl.querySelector("input").checked = allCb.checked;
    });
    commitFilter(col, panel, uniq);
  });

  listEl.addEventListener("change", () => {
    const all = [...listEl.querySelectorAll("input")];
    const n = all.filter((c) => c.checked).length;
    allCb.checked = n === all.length;
    allCb.indeterminate = n > 0 && n < all.length;
    commitFilter(col, panel, uniq);
  });

  const rect = triggerEl.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.top = rect.bottom + 4 + "px";
  panel.style.left = rect.left + "px";
  document.body.appendChild(panel);

  activeDropdown = panel;
  activeDropdownCol = col;
  search.focus();
  setTimeout(() => document.addEventListener("mousedown", handleOutside));
}

function commitFilter(col, panel, uniq) {
  const checkboxes = panel.querySelectorAll(".col-filter-list input");
  const selected = new Set([...checkboxes].filter((cb) => cb.checked).map((cb) => cb.value));
  columnFilters[col] = selected.size === uniq.length ? null : selected;
  applyAndRender();
}

function closeDropdown() {
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
    activeDropdownCol = null;
    document.removeEventListener("mousedown", handleOutside);
  }
}

function handleOutside(e) {
  if (activeDropdown && !activeDropdown.contains(e.target) && !e.target.closest(".filter-trigger")) {
    closeDropdown();
  }
}

function getChartCompanyNames(items) {
  return [...new Set(items.map((item) => item.empresa).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
}

function syncChartCompaniesMenu(items) {
  const companies = getChartCompanyNames(items);
  const selected = chartCompanyFilters ?? new Set(companies);

  chartCompaniesList.innerHTML = companies
    .map((company) => `
      <label class="chart-filter-option">
        <input type="checkbox" value="${escHtml(company)}" ${selected.has(company) ? "checked" : ""} />
        <span>${escHtml(company)}</span>
      </label>`)
    .join("");

  chartCompaniesAll.checked = companies.length > 0 && companies.every((company) => selected.has(company));
  chartCompaniesAll.indeterminate = !chartCompaniesAll.checked && companies.some((company) => selected.has(company));

  chartCompaniesBtn.textContent = companies.length === 0
    ? "Empresas"
    : chartCompanyFilters && chartCompanyFilters.size < companies.length
      ? `Empresas (${chartCompanyFilters.size})`
      : `Empresas (${companies.length})`;
}

function commitChartCompanyFilters(items) {
  const companies = getChartCompanyNames(items);
  const checkboxes = [...chartCompaniesList.querySelectorAll('input[type="checkbox"]')];
  const selected = new Set(checkboxes.filter((cb) => cb.checked).map((cb) => cb.value));
  chartCompanyFilters = selected.size === 0 || selected.size === companies.length ? null : selected;
  syncChartCompaniesMenu(items);
  renderChart(items);
}

function filterChartCompanyOptions() {
  const query = chartCompaniesSearch.value.trim().toLowerCase();
  chartCompaniesList.querySelectorAll(".chart-filter-option").forEach((option) => {
    const visible = option.textContent.toLowerCase().includes(query);
    option.style.display = visible ? "" : "none";
  });
}

function toggleChartCompaniesMenu(force, items = applyFilters()) {
  chartCompaniesMenuOpen = typeof force === "boolean" ? force : !chartCompaniesMenuOpen;
  chartCompaniesMenu.hidden = !chartCompaniesMenuOpen;
  chartCompaniesBtn.setAttribute("aria-expanded", chartCompaniesMenuOpen ? "true" : "false");
  if (chartCompaniesMenuOpen) {
    syncChartCompaniesMenu(items);
    chartCompaniesSearch.value = "";
    filterChartCompanyOptions();
  }
}

function handleChartCompaniesOutside(e) {
  if (chartCompaniesMenuOpen && !e.target.closest(".chart-filter-dropdown")) {
    toggleChartCompaniesMenu(false);
  }
}

function handleEmailPreviewClick(event) {
  const button = event.target.closest("[data-email-preview]");
  if (!button) return;
  const record = allDocuments.find((item) => item.id === button.dataset.emailPreview);
  if (record) openEmailPreview(record);
}

// --- Period filter -----------------------------------------------------------
timeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    timeBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    timePeriod = btn.dataset.period;
    applyAndRender();
  });
});

// --- Load documents ----------------------------------------------------------
async function loadDocuments() {
  const res = await authFetch("/api/documents");
  const data = await res.json();
  allDocuments = (data.items || []).filter((item) => item.status !== "error");
  applyAndRender();
}

async function uploadMassiveImport(file) {
  if (!file) return;
  importResult.textContent = "Importando ZIP maestro...";
  massiveImportBtn.disabled = true;

  try {
    const formData = new FormData();
    formData.append("files", file, file.name);

    const res = await authFetch("/api/intake/massive", {
      method: "POST",
      body: formData,
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 207) {
      importResult.textContent = payload.error || "No se pudo completar la importacion masiva.";
      return;
    }

    const imported = Number(payload.imported ?? 0);
    const failed = Number(payload.failed ?? 0);
    importResult.textContent = failed > 0
      ? `Importacion parcial: ${imported} carpetas creadas, ${failed} con error.`
      : `Importacion completada: ${imported} carpetas procesadas.`;

    await loadDocuments();
  } catch (_error) {
    importResult.textContent = "No se pudo completar la importacion masiva.";
  } finally {
    massiveImportBtn.disabled = false;
    massiveImportInput.value = "";
  }
}

// --- ZIP export --------------------------------------------------------------
function openExportSelectionModal() {
  const checked = selectedIds();
  if (!checked.length) {
    exportResult.textContent = "Selecciona al menos un documento para exportar.";
    return;
  }

  const docs = allDocuments.filter((item) => checked.includes(item.id));
  exportSelectionList.innerHTML = docs
    .map((doc) => {
      const label = doc.empresa || doc.extracted?.numeroDocumento || doc.id;
      const files = (doc.files || [])
        .map(
          (f) => `
            <label>
              <input type="checkbox" data-export-file data-doc-id="${doc.id}" value="${escHtml(f.fileName)}" checked />
              ${escHtml(f.fileName)}
            </label>`
        )
        .join("");
      return `
        <div class="export-selection-item" data-export-doc="${doc.id}">
          <p class="export-selection-item-title">${escHtml(label)}</p>
          <div class="export-selection-files">${files || '<span class="muted">Sin archivos</span>'}</div>
        </div>`;
    })
    .join("");

  exportSelectionModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeExportSelectionModal() {
  exportSelectionModal.hidden = true;
  document.body.classList.remove("modal-open");
}

async function confirmExportSelection() {
  const checkboxes = [...exportSelectionList.querySelectorAll("[data-export-file]")];
  const byDoc = new Map();
  for (const cb of checkboxes) {
    if (!cb.checked) continue;
    const id = cb.dataset.docId;
    if (!byDoc.has(id)) byDoc.set(id, []);
    byDoc.get(id).push(cb.value);
  }

  const items = [...byDoc.entries()].map(([id, fileNames]) => ({ id, fileNames }));
  if (!items.length) {
    exportResult.textContent = "Selecciona al menos un archivo para exportar.";
    return;
  }

  closeExportSelectionModal();
  exportResult.textContent = "Generando ZIP consolidado...";
  const res = await authFetch("/api/exports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    exportResult.textContent = payload.error || "No se pudo generar el ZIP.";
    return;
  }

  const blob = await res.blob();
  const skipped = Number(res.headers.get("X-Skipped-Count") ?? 0);
  const disposition = res.headers.get("Content-Disposition") || "";
  const nameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  const fileName = nameMatch?.[1] || `export-${new Date().toISOString().slice(0, 10)}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  exportResult.textContent = `ZIP generado${skipped ? ` (${skipped} sin archivo omitidos)` : ""}.`;
}

// --- Excel export ------------------------------------------------------------
function exportExcel() {
  const checkedIds = new Set(selectedIds());
  if (!checkedIds.size) {
    exportResult.textContent = "Selecciona al menos un documento para exportar.";
    return;
  }

  const selected = allDocuments.filter((item) => checkedIds.has(item.id));
  const rows = selected.map((item) => ({
    "Fecha recepcion": getDisplayValue(item, "fechaRecepcion"),
    "Fecha emision": getDisplayValue(item, "fechaEmision"),
    "Fecha vencimiento": getDisplayValue(item, "fechaVencimiento"),
    Empresa: getDisplayValue(item, "empresa"),
    RUC: getDisplayValue(item, "ruc"),
    "Codigo de Factura": getDisplayValue(item, "codigoFactura"),
    "Tipo Doc": getDisplayValue(item, "documentType"),
    Fideicomiso: getDisplayValue(item, "fideicomiso"),
    "Centro de costos": getDisplayValue(item, "centroCostos"),
    "Val. COES": getDisplayValue(item, "coesValidacion"),
    Concepto: getDisplayValue(item, "concept"),
    Moneda: item.extracted?.moneda || "-",
    "Monto (IGV agregado 18%)": item.extracted?.monto != null ? Number(item.extracted.monto) : "",
    "Monto sin IGV": item.extracted?.monto != null ? Number((item.extracted.monto / 1.18).toFixed(2)) : "",
    "Est. CP": getDisplayValue(item, "estadoComprobante"),
    "Est. RUC": getDisplayValue(item, "estadoContribuyente"),
    Domicilio: getDisplayValue(item, "condicionDomicilio"),
    Estado: getDisplayValue(item, "status"),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Facturas");
  XLSX.writeFile(wb, `facturas-${new Date().toISOString().slice(0, 10)}.xlsx`);
  exportResult.textContent = `Excel descargado (${rows.length} registros).`;
}

// --- Chart -------------------------------------------------------------------
function renderChart(items) {
  const canvas = document.getElementById("montoChart");
  if (!canvas) return;

  const withData = items.filter((d) => {
    if (d.extracted?.monto == null || !d.empresa) return false;
    if (!getEmissionDate(d)) return false;
    if (!chartCompanyFilters) return true;
    return chartCompanyFilters.has(d.empresa);
  });

  if (!withData.length) {
    chartPanel.style.display = "none";
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    return;
  }

  chartPanel.style.display = "";
  const byEmpresa = {};
  for (const doc of withData) {
    const emp = doc.empresa;
    if (!byEmpresa[emp]) byEmpresa[emp] = [];
    byEmpresa[emp].push({ date: getEmissionDate(doc), monto: Number(doc.extracted.monto) });
  }

  const fmt = (dateObj) => dateObj.toLocaleDateString("es-PE");
  const allDates = [...new Set(withData.map((d) => fmt(getEmissionDate(d))))]
    .sort((a, b) => {
      const [da, ma, ya] = a.split("/").map(Number);
      const [db, mb, yb] = b.split("/").map(Number);
      return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
    });

  const palette = ["#ff5a2a", "#1f6fff", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];
  const datasets = Object.entries(byEmpresa).map(([empresa, docs], idx) => {
    const byDate = {};
    for (const d of docs) {
      const k = fmt(d.date);
      byDate[k] = (byDate[k] ?? 0) + d.monto;
    }
    return {
      label: empresa,
      data: allDates.map((d) => (byDate[d] != null ? byDate[d] : null)),
      borderColor: palette[idx % palette.length],
      backgroundColor: palette[idx % palette.length] + "33",
      pointBackgroundColor: palette[idx % palette.length],
      pointBorderColor: "#0f1830",
      borderWidth: 3,
      tension: 0.3,
      pointRadius: 6,
      pointHoverRadius: 8,
      spanGaps: false,
      fill: false,
    };
  });

  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(canvas, {
    type: "line",
    data: { labels: allDates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 8, right: 14, bottom: 8, left: 10 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(8, 14, 28, 0.96)",
          titleColor: "#eef4ff",
          bodyColor: "#d6e8ff",
          borderColor: "rgba(79, 215, 255, 0.25)",
          borderWidth: 1,
          padding: 12,
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(79, 215, 255, 0.08)" },
          ticks: { color: "#c7d8f7", font: { size: 12 } },
          title: { display: true, text: "Fecha de emision", color: "#dce8ff", font: { size: 12, weight: "600" } },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(79, 215, 255, 0.08)" },
          ticks: { color: "#c7d8f7", font: { size: 12 } },
          title: { display: true, text: "Monto", color: "#dce8ff", font: { size: 12, weight: "600" } },
        },
      },
    },
  });
}

// --- Event listeners ---------------------------------------------------------
document.getElementById("refreshBtn").addEventListener("click", loadDocuments);
document.getElementById("exportBtn").addEventListener("click", openExportSelectionModal);
document.getElementById("exportExcelBtn").addEventListener("click", exportExcel);
clearFiltersBtn.addEventListener("click", clearAllFilters);

massiveImportBtn.addEventListener("click", () => massiveImportInput.click());
massiveImportInput.addEventListener("change", (event) => {
  const [file] = event.target.files || [];
  uploadMassiveImport(file);
});

chartCompaniesBtn.addEventListener("click", () => toggleChartCompaniesMenu());
chartCompaniesSearch.addEventListener("input", filterChartCompanyOptions);
chartCompaniesAll.addEventListener("change", () => {
  const visibleOptions = [...chartCompaniesList.querySelectorAll(".chart-filter-option")].filter((option) => option.style.display !== "none");
  visibleOptions.forEach((option) => {
    const checkbox = option.querySelector('input[type="checkbox"]');
    checkbox.checked = chartCompaniesAll.checked;
  });
  commitChartCompanyFilters(applyFilters());
});
chartCompaniesList.addEventListener("change", () => {
  commitChartCompanyFilters(applyFilters());
});
document.addEventListener("mousedown", handleChartCompaniesOutside);

bodyEl.addEventListener("click", handleEmailPreviewClick);
bodyEl.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-edit-open='1']");
  if (!trigger) return;
  openCellEditor(trigger);
});
bodyEl.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-expandable='1']");
  if (!trigger) return;
  const wasExpanded = trigger.classList.contains("cell-expanded");
  document.querySelectorAll(".cell-expanded").forEach((el) => el.classList.remove("cell-expanded"));
  if (!wasExpanded) trigger.classList.add("cell-expanded");
});
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-expandable='1']")) return;
  document.querySelectorAll(".cell-expanded").forEach((el) => el.classList.remove("cell-expanded"));
});
bodyEl.addEventListener("click", async (event) => {
  const trigger = event.target.closest("[data-delete-id]");
  if (!trigger) return;
  const id = trigger.dataset.deleteId;
  const doc = allDocuments.find((item) => item.id === id);
  const label = doc?.empresa || doc?.metadata?.subject || id;
  if (!window.confirm(`Eliminar el registro de "${label}"? Esta accion no se puede deshacer.`)) return;

  trigger.disabled = true;
  try {
    await deleteDocument(id);
    allDocuments = allDocuments.filter((item) => item.id !== id);
    applyAndRender();
  } catch (err) {
    window.alert(err.message || "No se pudo eliminar el documento.");
    trigger.disabled = false;
  }
});
bodyEl.addEventListener("change", (event) => {
  const target = event.target;
  if (!target.matches("select[data-edit-field]")) return;
  handleCellEditCommit(target);
});
bodyEl.addEventListener("blur", (event) => {
  const target = event.target;
  if (!target.matches("[data-edit-field]")) return;
  handleCellEditCommit(target);
}, true);
bodyEl.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!target.matches("input[data-edit-field]")) return;
  if (event.key === "Enter") {
    event.preventDefault();
    target.blur();
  }
});

closeEmailPreviewBtn.addEventListener("click", closeEmailPreview);
emailPreviewModal.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-email-modal]")) closeEmailPreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !emailPreviewModal.hidden) closeEmailPreview();
  if (event.key === "Escape" && !exportSelectionModal.hidden) closeExportSelectionModal();
});

closeExportModalBtn.addEventListener("click", closeExportSelectionModal);
exportSelectionCancelBtn.addEventListener("click", closeExportSelectionModal);
exportSelectionConfirmBtn.addEventListener("click", confirmExportSelection);
exportSelectionModal.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-export-modal]")) closeExportSelectionModal();
});

// --- Realtime -----------------------------------------------------------------
function handleRealtimeMessage(message) {
  if (message.type === "new_document" || message.type === "document_updated") {
    const record = message.record;
    if (!record?.id) return;
    const idx = allDocuments.findIndex((doc) => doc.id === record.id);
    if (record.status === "error") {
      if (idx >= 0) allDocuments.splice(idx, 1);
    } else if (idx >= 0) {
      allDocuments[idx] = record;
    } else {
      allDocuments.unshift(record);
    }
    applyAndRender();
  } else if (message.type === "document_deleted") {
    if (!message.id) return;
    allDocuments = allDocuments.filter((doc) => doc.id !== message.id);
    applyAndRender();
  }
}

// --- Init --------------------------------------------------------------------
buildTableHeaders();
initAuth().then((ok) => {
  if (ok === false) return;
  loadDocuments();
  openRealtime(handleRealtimeMessage);
});
