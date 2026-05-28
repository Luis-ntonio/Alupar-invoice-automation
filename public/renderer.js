let allDocuments = [];
let chartInstance = null;

const bodyEl = document.getElementById("documentsBody");
const summaryEl = document.getElementById("summary");
const chartPanel = document.getElementById("chartPanel");
const checkAll = document.getElementById("checkAll");
const exportResult = document.getElementById("exportResult");

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadDocuments() {
  const documentType = document.getElementById("documentType").value;
  const status = document.getElementById("status").value;

  const params = new URLSearchParams();
  if (documentType) params.set("documentType", documentType);
  if (status) params.set("status", status);

  const res = await fetch(`/api/documents?${params.toString()}`);
  const data = await res.json();
  allDocuments = data.items || [];
  applyAndRender();
}

function applyAndRender() {
  const empresa = document.getElementById("empresaFilter").value;
  const displayed = empresa
    ? allDocuments.filter((d) => d.empresa === empresa)
    : allDocuments;

  populateEmpresaFilter();
  renderSummary(displayed);
  renderRows(displayed);
  renderChart(allDocuments);
}

function populateEmpresaFilter() {
  const select = document.getElementById("empresaFilter");
  const current = select.value;
  const empresas = [...new Set(allDocuments.map((d) => d.empresa).filter(Boolean))].sort();
  select.innerHTML =
    '<option value="">Todas las empresas</option>' +
    empresas
      .map(
        (e) =>
          `<option value="${escHtml(e)}"${e === current ? " selected" : ""}>${escHtml(e)}</option>`
      )
      .join("");
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

  summaryEl.innerHTML = cards
    .map(
      ([label, value]) =>
        `<article class="card"><p>${label}</p><strong>${value}</strong></article>`
    )
    .join("");
}

function renderRows(items) {
  if (!items.length) {
    bodyEl.innerHTML = `<tr><td colspan="10" class="muted">No hay documentos para el filtro actual.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = items
    .map((item) => {
      const fileLinks = (item.files || [])
        .map((f) => {
          const url = `/api/documents/${item.id}/files/${encodeURIComponent(f.fileName)}`;
          return `<a class="badge-file badge-file-${f.fileType}" href="${url}" target="_blank" rel="noopener">${f.fileType.toUpperCase()}</a>`;
        })
        .join(" ");
      const downloadAll = item.files?.length
        ? `<a class="btn-link" href="/api/documents/${item.id}/file" title="Descargar todos">↓</a>`
        : "";
      return `
        <tr>
          <td class="col-check"><input type="checkbox" class="doc-check" data-id="${item.id}" /></td>
          <td>${new Date(item.createdAt).toLocaleString()}</td>
          <td>${escHtml(item.empresa || "—")}</td>
          <td class="mono">${escHtml(item.ruc || "—")}</td>
          <td class="file-name">${escHtml(item.metadata?.subject || "—")}</td>
          <td>${item.documentType}</td>
          <td>${escHtml(item.concept)}</td>
          <td class="mono">${item.extracted?.monto != null ? item.extracted.monto.toFixed(2) + " " + (item.extracted.moneda || "") : "—"}</td>
          <td><span class="badge badge-${item.status}">${item.status}</span></td>
          <td class="file-links">${fileLinks} ${downloadAll}</td>
        </tr>`;
    })
    .join("");
}

async function generateExport() {
  const checked = [...document.querySelectorAll(".doc-check:checked")].map(
    (cb) => cb.dataset.id
  );
  if (!checked.length) {
    exportResult.textContent = "Selecciona al menos un documento para exportar.";
    return;
  }

  exportResult.textContent = "Generando ZIP…";
  const res = await fetch("/api/exports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: checked }),
  });

  if (!res.ok) {
    const payload = await res.json();
    exportResult.textContent = payload.error || "No se pudo generar el ZIP.";
    return;
  }

  // Trigger browser download
  const blob = await res.blob();
  const skipped = Number(res.headers.get("X-Skipped-Count") ?? 0);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `export-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  exportResult.textContent = `Descarga iniciada${skipped ? ` (${skipped} sin archivo omitidos)` : ""}.`;
  loadDocuments();
}

function renderChart(items) {
  const canvas = document.getElementById("montoChart");
  if (!canvas) return;

  const withData = items.filter((d) => d.extracted?.monto != null && d.empresa);

  if (!withData.length) {
    chartPanel.style.display = "none";
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    return;
  }

  chartPanel.style.display = "";

  // Group by empresa
  const byEmpresa = {};
  for (const doc of withData) {
    const emp = doc.empresa;
    if (!byEmpresa[emp]) byEmpresa[emp] = [];
    byEmpresa[emp].push({ date: doc.createdAt, monto: doc.extracted.monto });
  }

  // Unified sorted x-axis (day precision)
  const fmt = (iso) => new Date(iso).toLocaleDateString("es-PE");
  const allDates = [
    ...new Set(withData.map((d) => fmt(d.createdAt))),
  ].sort((a, b) => new Date(a) - new Date(b));

  const palette = [
    "#ff5a2a", "#1f6fff", "#22c55e", "#f59e0b",
    "#a855f7", "#06b6d4", "#ec4899", "#84cc16",
  ];

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
      tension: 0.35,
      pointRadius: 5,
      spanGaps: false,
    };
  });

  if (chartInstance) {
    chartInstance.destroy();
  }
  chartInstance = new Chart(canvas, {
    type: "line",
    data: { labels: allDates, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "top" },
        title: { display: false },
      },
      scales: {
        x: { title: { display: true, text: "Fecha" } },
        y: { title: { display: true, text: "Monto" }, beginAtZero: true },
      },
    },
  });
}

// Header checkbox — select/deselect all visible rows
checkAll.addEventListener("change", () => {
  document.querySelectorAll(".doc-check").forEach((cb) => (cb.checked = checkAll.checked));
});

document.getElementById("selectAllBtn").addEventListener("click", () => {
  document.querySelectorAll(".doc-check").forEach((cb) => (cb.checked = true));
  checkAll.checked = true;
});

document.getElementById("deselectAllBtn").addEventListener("click", () => {
  document.querySelectorAll(".doc-check").forEach((cb) => (cb.checked = false));
  checkAll.checked = false;
});

document.getElementById("refreshBtn").addEventListener("click", loadDocuments);
document.getElementById("exportBtn").addEventListener("click", generateExport);
document.getElementById("documentType").addEventListener("change", loadDocuments);
document.getElementById("status").addEventListener("change", loadDocuments);
document.getElementById("empresaFilter").addEventListener("change", applyAndRender);

loadDocuments();


loadDocuments();
