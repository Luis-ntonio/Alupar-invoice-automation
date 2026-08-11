// --- State -----------------------------------------------------------------
let eligibleCodes = [];
let currentUpload = null; // { storagePath, fileName, sheetNames }

const manualFileInput = document.getElementById("manualFileInput");
const manualUploadBtn = document.getElementById("manualUploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const mappingRows = document.getElementById("mappingRows");
const manualAssignBtn = document.getElementById("manualAssignBtn");
const assignStatus = document.getElementById("assignStatus");
const assignSummary = document.getElementById("assignSummary");
const activeRows = document.getElementById("activeRows");

// Las columnas se ingresan como letra (A, B, C...) porque es como el admin
// las ve en Excel -- se convierten a indice 1-based (A=1) antes de mandarlas
// al backend, que ya trabaja con indices (ver SheetLayout en centroCostosService.ts).
function colLetterToIndex(letter) {
  const clean = String(letter || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(clean)) return null;
  let n = 0;
  for (const ch of clean) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function formatDate(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function renderMappingRows() {
  mappingRows.innerHTML = eligibleCodes
    .map((c) => {
      const sheetOptions = currentUpload
        ? `<option value="">Sin cambios</option>` + currentUpload.sheetNames.map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join("")
        : `<option value="">Sube un archivo primero</option>`;
      return `
        <tr data-code="${escHtml(c.code)}">
          <td>${escHtml(c.code)} — ${escHtml(c.concepto)}</td>
          <td><select class="mapping-sheet" ${currentUpload ? "" : "disabled"}>${sheetOptions}</select></td>
          <td><input class="mapping-col mapping-col-name" type="text" maxlength="2" placeholder="A" /></td>
          <td><input class="mapping-col mapping-col-ruc" type="text" maxlength="2" placeholder="B" /></td>
          <td><input class="mapping-col mapping-col-data" type="text" maxlength="2" placeholder="C" /></td>
        </tr>`;
    })
    .join("");
}

function renderActiveTable(active) {
  const byCode = new Map(active.map((a) => [a.centroCostoCode, a]));
  activeRows.innerHTML = eligibleCodes
    .map((c) => {
      const source = byCode.get(c.code);
      if (!source) {
        return `<tr><td>${escHtml(c.code)} — ${escHtml(c.concepto)}</td><td colspan="3"><span class="badge badge-no_encontrado">SIN FUENTE MANUAL</span></td></tr>`;
      }
      return `
        <tr>
          <td>${escHtml(c.code)} — ${escHtml(c.concepto)}</td>
          <td>${escHtml(source.sheet)}</td>
          <td>${escHtml(source.fileName)}</td>
          <td>${formatDate(source.uploadedAt)}</td>
        </tr>`;
    })
    .join("");
}

async function loadManualData() {
  try {
    const res = await authFetch("/api/coes/manual");
    const data = await res.json();
    eligibleCodes = data.eligibleCodes || [];
    renderMappingRows();
    renderActiveTable(data.active || []);
  } catch (err) {
    uploadStatus.textContent = "No se pudo cargar la lista de centros de costo elegibles.";
  }
}

manualUploadBtn.addEventListener("click", async () => {
  const file = manualFileInput.files[0];
  if (!file) {
    uploadStatus.textContent = "Selecciona un archivo .xlsx primero.";
    return;
  }
  uploadStatus.textContent = "Subiendo...";
  manualUploadBtn.disabled = true;
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await authFetch("/api/coes/manual/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) {
      uploadStatus.textContent = data.error || "No se pudo subir el archivo.";
      return;
    }
    currentUpload = data;
    uploadStatus.textContent = `Archivo "${data.fileName}" cargado (${data.sheetNames.length} hoja(s) encontradas). Asigna las hojas abajo.`;
    renderMappingRows();
  } catch (err) {
    uploadStatus.textContent = "Error subiendo el archivo.";
  } finally {
    manualUploadBtn.disabled = false;
  }
});

function collectMappings() {
  const mappings = [];
  const errors = [];
  for (const row of mappingRows.querySelectorAll("tr")) {
    const code = row.dataset.code;
    const sheet = row.querySelector(".mapping-sheet").value;
    if (!sheet) continue;

    const nameColumn = colLetterToIndex(row.querySelector(".mapping-col-name").value);
    const supplierColumn = colLetterToIndex(row.querySelector(".mapping-col-ruc").value);
    const dataStartColumn = colLetterToIndex(row.querySelector(".mapping-col-data").value);
    if (!nameColumn || !supplierColumn || !dataStartColumn) {
      errors.push(`${code}: indica las 3 columnas (letras, ej. "A") para la hoja elegida.`);
      continue;
    }
    mappings.push({ centroCostoCode: code, sheet, nameColumn, supplierColumn, dataStartColumn });
  }
  return { mappings, errors };
}

manualAssignBtn.addEventListener("click", async () => {
  if (!currentUpload) {
    assignStatus.textContent = "Sube un archivo primero.";
    return;
  }
  const { mappings, errors } = collectMappings();
  if (errors.length) {
    assignStatus.innerHTML = errors.map((e) => escHtml(e)).join("<br/>");
    return;
  }
  if (!mappings.length) {
    assignStatus.textContent = "Elige al menos una hoja para asignar.";
    return;
  }

  assignStatus.textContent = "Guardando asignaciones y revalidando facturas pendientes...";
  assignSummary.innerHTML = "";
  manualAssignBtn.disabled = true;
  try {
    const res = await authFetch("/api/coes/manual/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storagePath: currentUpload.storagePath, fileName: currentUpload.fileName, mappings }),
    });
    const data = await res.json();
    if (!res.ok) {
      assignStatus.textContent = data.error || "No se pudieron guardar las asignaciones.";
      return;
    }

    assignStatus.textContent = `${data.saved.length} centro(s) de costo actualizados.`;
    const warningsHtml = (data.warnings || [])
      .map((w) => `<div class="status-line">⚠ ${escHtml(w.centroCostoCode)}: ${escHtml(w.message)}</div>`)
      .join("");
    const revalidationHtml = Object.entries(data.revalidation || {})
      .map(([code, r]) => `<div class="status-line">${escHtml(code)}: ${r.checked} revisada(s), ${r.updated} actualizada(s), ${r.split} dividida(s).</div>`)
      .join("");
    assignSummary.innerHTML = warningsHtml + revalidationHtml;

    await loadManualData();
  } catch (err) {
    assignStatus.textContent = "Error guardando las asignaciones.";
  } finally {
    manualAssignBtn.disabled = false;
  }
});

initAuth().then((ok) => {
  if (ok !== false) loadManualData();
});
