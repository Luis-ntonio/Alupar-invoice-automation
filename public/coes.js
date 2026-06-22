// --- State -----------------------------------------------------------------
let coesPeriods = [];
let currentMatrix = null;
let aluparChart = null;

const datasetSelect = document.getElementById("datasetSelect");
const periodSelect = document.getElementById("periodSelect");
const matrixStatus = document.getElementById("matrixStatus");
const aluparCards = document.getElementById("aluparCards");
const aluparChartCanvas = document.getElementById("aluparChart");
const verifyRuc = document.getElementById("verifyRuc");
const verifyMonto = document.getElementById("verifyMonto");
const verifyBtn = document.getElementById("verifyBtn");
const verifyResult = document.getElementById("verifyResult");

const MONTH_LABELS = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

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
    const counterparts = buildAluparCounterparts(currentMatrix);
    renderAluparCards(counterparts);
    renderAluparChart(counterparts);
    matrixStatus.textContent = counterparts.length
      ? `Mostrando ${counterparts.length} contrapartes de Alupar.`
      : `Alupar no aparece en este periodo.`;
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
        <div class="coes-card">
          <span class="badge badge-${item.direction}">${directionLabel(item.direction)}</span>
          <span class="coes-card-name">${escHtml(item.name)}</span>
          <span class="coes-card-ruc">${escHtml(item.ruc)}</span>
          <span class="coes-card-monto">${item.monto.toFixed(2)}</span>
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

async function runVerify() {
  const dataset = datasetSelect.value;
  const period = selectedPeriod();
  const supplierRuc = verifyRuc.value.trim();
  const monto = Number(verifyMonto.value);

  if (!period) {
    verifyResult.innerHTML = '<span class="badge badge-no_encontrado">SIN PERIODO</span> Selecciona un periodo valido.';
    return;
  }
  if (!supplierRuc || !Number.isFinite(monto)) {
    verifyResult.innerHTML = '<span class="badge badge-no_encontrado">DATOS INCOMPLETOS</span> Ingresa RUC y monto validos.';
    return;
  }

  verifyResult.textContent = "Verificando...";
  try {
    const res = await authFetch("/api/coes/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, year: period.year, month: period.month, supplierRuc, monto }),
    });
    const result = await res.json();
    const label = (result.status || "no_encontrado").replace("_", " ").toUpperCase();
    verifyResult.innerHTML = `<span class="badge badge-${result.status}">${label}</span> ${escHtml(result.detalle || "")}`;
  } catch (err) {
    verifyResult.innerHTML = '<span class="badge badge-no_encontrado">ERROR</span> No se pudo verificar.';
  }
}

datasetSelect.addEventListener("change", async () => {
  fillPeriodSelect();
  await loadMatrix();
});
periodSelect.addEventListener("change", loadMatrix);
verifyBtn.addEventListener("click", runVerify);

initAuth().then((ok) => {
  if (ok !== false) loadPeriods();
});
