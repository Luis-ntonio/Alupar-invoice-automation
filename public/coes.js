// --- State -----------------------------------------------------------------
let coesPeriods = [];
let currentMatrix = null;
let currentCounterparts = [];
let aluparChart = null;

const datasetSelect = document.getElementById("datasetSelect");
const periodSelect = document.getElementById("periodSelect");
const matrixStatus = document.getElementById("matrixStatus");
const aluparCards = document.getElementById("aluparCards");
const aluparChartCanvas = document.getElementById("aluparChart");
const verifyRuc = document.getElementById("verifyRuc");
const verifyResult = document.getElementById("verifyResult");
const historyPanel = document.getElementById("historyPanel");
const historyCompanyName = document.getElementById("historyCompanyName");
const historyDatasetLabel = document.getElementById("historyDatasetLabel");
const historyStatus = document.getElementById("historyStatus");
const historyChartCanvas = document.getElementById("historyChart");
const historyCloseBtn = document.getElementById("historyCloseBtn");

let historyChart = null;
const matrixByPeriodCache = new Map();

const MONTH_LABELS = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function formatMonto(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function periodKey(p) {
  return `${p.year}-${p.month}`;
}

function fillPeriodSelect() {
  const dataset = datasetSelect.value;
  const options = coesPeriods.filter((p) => p.dataset === dataset);
  periodSelect.innerHTML = options
    .map((p) => `<option value="${periodKey(p)}">${MONTH_LABELS[p.month]} ${p.year}</option>`)
    .join("");
  if (!options.length) {
    periodSelect.innerHTML = `<option value="">Sin periodos indexados</option>`;
  }
}

async function loadPeriods() {
  try {
    const res = await authFetch("/api/coes/periods");
    const data = await res.json();
    coesPeriods = data.periods || [];
  } catch (err) {
    coesPeriods = [];
  }
  fillPeriodSelect();
  await loadMatrix();
}

function selectedPeriod() {
  const value = periodSelect.value;
  if (!value) return null;
  const [year, month] = value.split("-").map(Number);
  return { year, month };
}

async function loadMatrix() {
  const dataset = datasetSelect.value;
  const period = selectedPeriod();
  aluparCards.innerHTML = "";
  currentMatrix = null;
  if (aluparChart) {
    aluparChart.destroy();
    aluparChart = null;
  }

  if (!period) {
    matrixStatus.textContent = "No hay periodos indexados todavia para este dataset.";
    return;
  }

  matrixStatus.textContent = "Cargando datos...";
  try {
    const res = await authFetch(`/api/coes/matrix?dataset=${dataset}&year=${period.year}&month=${period.month}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      matrixStatus.textContent = err.error || "No se encontro la matriz para este periodo.";
      return;
    }
    currentMatrix = await res.json();
    currentCounterparts = buildAluparCounterparts(currentMatrix);
    renderAluparCards(currentCounterparts);
    renderAluparChart(currentCounterparts);
    matrixStatus.textContent = currentCounterparts.length
      ? `Mostrando ${currentCounterparts.length} contrapartes de Alupar.`
      : `Alupar no aparece en este periodo.`;
    runVerify();
  } catch (err) {
    matrixStatus.textContent = "Error cargando los datos.";
  }
}

// Solo nos interesan las filas/columnas donde Alupar participa -- el resto de la
// matriz (empresa A le paga a empresa B, sin Alupar de por medio) se descarta.
function buildAluparCounterparts(matrix) {
  const items = [];

  if (matrix.aluparColumn !== undefined) {
    for (const row of matrix.rows) {
      const monto = row.values[matrix.aluparColumn];
      if (monto != null && monto !== 0) {
        items.push({ ruc: row.ruc, name: row.name, monto, direction: "cobra" });
      }
    }
  }

  if (matrix.aluparRow !== undefined) {
    const aluparRowData = matrix.rows.find((r) => r.row === matrix.aluparRow);
    if (aluparRowData) {
      for (const col of matrix.columns) {
        const monto = aluparRowData.values[col.col];
        if (monto != null && monto !== 0) {
          items.push({ ruc: col.ruc, name: col.name, monto, direction: "paga" });
        }
      }
    }
  }

  return items.sort((a, b) => b.monto - a.monto);
}

function directionLabel(direction) {
  return direction === "cobra" ? "Alupar emite factura" : "A Alupar recibe factura";
}

function sectionTitle(direction) {
  return direction === "cobra" ? "Alupar debe emitir factura" : "Alupar recibe factura";
}

function renderCardsGroup(direction, items) {
  if (!items.length) return "";
  const cards = items
    .map(
      (item) => `
        <div class="coes-card coes-card-clickable" data-history-ruc="${escHtml(item.ruc)}" data-history-name="${escHtml(item.name || item.ruc)}" title="Ver historico">
          <span class="badge badge-${item.direction}">${directionLabel(item.direction)}</span>
          <span class="coes-card-name">${escHtml(item.name)}</span>
          <span class="coes-card-ruc">${escHtml(item.ruc)}</span>
          <span class="coes-card-monto">${formatMonto(item.monto)}</span>
        </div>`
    )
    .join("");
  return `
    <div class="coes-cards-group">
      <h3 class="coes-cards-group-title badge-${direction}-text">${sectionTitle(direction)}</h3>
      <div class="coes-cards">${cards}</div>
    </div>`;
}

function renderAluparCards(counterparts) {
  if (!counterparts.length) {
    aluparCards.innerHTML = '<p class="muted">No hay contrapartes de Alupar para este periodo.</p>';
    return;
  }
  const cobra = counterparts.filter((item) => item.direction === "cobra");
  const paga = counterparts.filter((item) => item.direction === "paga");
  aluparCards.innerHTML = renderCardsGroup("cobra", cobra) + renderCardsGroup("paga", paga);
}

function renderAluparChart(counterparts) {
  if (!counterparts.length) return;
  const labels = counterparts.map((item) => item.name || item.ruc);
  const data = counterparts.map((item) => item.monto);
  const colors = counterparts.map((item) => (item.direction === "cobra" ? "#39e7c4" : "#ffbe55"));

  aluparChart = new Chart(aluparChartCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: "Monto", data, backgroundColor: colors, borderRadius: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_event, elements) => {
        if (!elements.length) return;
        const item = counterparts[elements[0].index];
        if (item) showHistory(item.ruc, item.name || item.ruc);
      },
      onHover: (event, elements) => {
        event.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
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
          ticks: { color: "#c7d8f7", font: { size: 11 } },
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

function runVerify() {
  const period = selectedPeriod();
  const supplierRuc = verifyRuc.value.trim();

  if (!period) {
    verifyResult.innerHTML = '<span class="badge badge-no_encontrado">SIN PERIODO</span> Selecciona un periodo valido.';
    return;
  }
  if (!supplierRuc) {
    verifyResult.innerHTML = "";
    return;
  }

  const matches = currentCounterparts.filter((item) => item.ruc.includes(supplierRuc));
  if (!matches.length) {
    verifyResult.innerHTML = `<span class="badge badge-no_encontrado">NO ENCONTRADO</span> El RUC ${escHtml(supplierRuc)} no aparece como contraparte de Alupar en este periodo.`;
    return;
  }

  // El excel COES reporta montos sin IGV; se muestra tambien el equivalente con
  // IGV (18%) ya que es como llega el monto en la factura del proveedor.
  verifyResult.innerHTML = matches
    .map((item) => {
      const conIgv = item.monto * 1.18;
      return `<span class="badge badge-${item.direction}">${directionLabel(item.direction)}</span> ${escHtml(item.name)} (${escHtml(item.ruc)}): <strong>${formatMonto(item.monto)}</strong> sin IGV / <strong>${formatMonto(conIgv)}</strong> con IGV`;
    })
    .join("<br/>");
}

async function fetchMatrixForPeriod(dataset, period) {
  const key = `${dataset}-${periodKey(period)}`;
  if (matrixByPeriodCache.has(key)) return matrixByPeriodCache.get(key);
  try {
    const res = await authFetch(`/api/coes/matrix?dataset=${dataset}&year=${period.year}&month=${period.month}`);
    const matrix = res.ok ? await res.json() : null;
    matrixByPeriodCache.set(key, matrix);
    return matrix;
  } catch (err) {
    matrixByPeriodCache.set(key, null);
    return null;
  }
}

function findCounterpartMonto(matrix, ruc) {
  if (!matrix) return undefined;
  if (matrix.aluparColumn !== undefined) {
    const row = matrix.rows.find((r) => r.ruc === ruc);
    const value = row?.values[matrix.aluparColumn];
    if (value != null) return value;
  }
  if (matrix.aluparRow !== undefined) {
    const aluparRowData = matrix.rows.find((r) => r.row === matrix.aluparRow);
    const col = matrix.columns.find((c) => c.ruc === ruc);
    const value = col ? aluparRowData?.values[col.col] : undefined;
    if (value != null) return value;
  }
  return undefined;
}

async function showHistory(ruc, name) {
  const dataset = datasetSelect.value;
  const periods = coesPeriods
    .filter((p) => p.dataset === dataset)
    .sort((a, b) => a.year - b.year || a.month - b.month);

  // VTEA (Alupar emite/cobra) usa el mismo verde de los badges "cobra"; VTP
  // (Alupar recibe/paga) usa el naranja de los badges "paga", para que el color
  // del historico siempre sea coherente con el dataset que se esta viendo.
  const datasetColor = dataset === "vtea" ? "#39e7c4" : "#ffbe55";
  const datasetColorSoft = dataset === "vtea" ? "rgba(57, 231, 196, 0.15)" : "rgba(255, 190, 85, 0.15)";
  const datasetTextClass = dataset === "vtea" ? "badge-cobra-text" : "badge-paga-text";

  historyPanel.hidden = false;
  historyCompanyName.textContent = `- ${name}`;
  historyCompanyName.className = datasetTextClass;
  historyDatasetLabel.textContent = dataset.toUpperCase();
  historyDatasetLabel.className = datasetTextClass;
  historyStatus.textContent = "Cargando historico...";
  historyPanel.scrollIntoView({ behavior: "smooth", block: "start" });

  const matrices = await Promise.all(periods.map((p) => fetchMatrixForPeriod(dataset, p)));
  const labels = periods.map((p) => `${MONTH_LABELS[p.month]} ${p.year}`);
  const values = matrices.map((matrix) => findCounterpartMonto(matrix, ruc) ?? null);

  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
  }

  // El historico se calcula solo para el dataset/periodos vigentes al momento del
  // click; si el usuario cambia de dataset/periodo despues, el panel se cierra
  // (ver listeners de datasetSelect/periodSelect) para evitar mostrar un grafico
  // que ya no corresponde a la seleccion actual.
  if (dataset !== datasetSelect.value) return;

  const presentCount = values.filter((v) => v != null).length;
  historyStatus.textContent = presentCount
    ? `${presentCount} periodo(s) con datos de ${name} (${ruc}).`
    : `No se encontraron montos historicos para ${name} (${ruc}) en este dataset.`;

  historyChart = new Chart(historyChartCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `Monto (${ruc})`,
          data: values,
          spanGaps: true,
          borderColor: datasetColor,
          backgroundColor: datasetColorSoft,
          fill: true,
          tension: 0.25,
          pointRadius: 4,
          pointBackgroundColor: datasetColor,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(8, 14, 28, 0.96)",
          titleColor: "#eef4ff",
          bodyColor: "#d6e8ff",
          borderColor: "rgba(79, 215, 255, 0.25)",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => (ctx.raw == null ? "Sin datos" : formatMonto(ctx.raw)),
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(79, 215, 255, 0.08)" },
          ticks: { color: "#c7d8f7", font: { size: 11 } },
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

aluparCards.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-history-ruc]");
  if (!trigger) return;
  showHistory(trigger.dataset.historyRuc, trigger.dataset.historyName);
});

function closeHistory() {
  historyPanel.hidden = true;
  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
  }
}

historyCloseBtn.addEventListener("click", closeHistory);

datasetSelect.addEventListener("change", async () => {
  fillPeriodSelect();
  matrixByPeriodCache.clear();
  closeHistory();
  await loadMatrix();
});
periodSelect.addEventListener("change", () => {
  closeHistory();
  loadMatrix();
});
verifyRuc.addEventListener("input", runVerify);

initAuth().then((ok) => {
  if (ok !== false) loadPeriods();
});
