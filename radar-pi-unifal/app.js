"use strict";

/* =========================================================================
   Estado e Carregamento de Dados
   ========================================================================= */

const state = {
  docentes: [],
  filtered: [],
  filters: { campus: "", unidade: "", titulacao: "" },
  query: ""
};

async function loadData() {
  if (window.DOCENTES_DATA) {
    state.docentes = window.DOCENTES_DATA;
    return;
  }
  const res = await fetch("docentes.json");
  state.docentes = await res.json();
}

/* =========================================================================
   Tema (Light / Dark)
   ========================================================================= */

function initTheme() {
  const toggleBtn = document.getElementById("themeToggle");
  const storedTheme = localStorage.getItem("radar_theme");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const currentTheme = storedTheme || (systemDark ? "dark" : "light");

  document.documentElement.setAttribute("data-theme", currentTheme);
  toggleBtn.textContent = currentTheme === "dark" ? "☀️" : "🌙";

  toggleBtn.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const newTheme = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("radar_theme", newTheme);
    toggleBtn.textContent = newTheme === "dark" ? "☀️" : "🌙";
  });
}

/* =========================================================================
   Normalização e Texto de Busca
   ========================================================================= */

function normalize(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function corpusText(p) {
  const vinc = (p.vinculos || [])
    .map((v) => `${v.curso} ${v.disciplinas}`)
    .join(" ");
  return [p.nome, p.unidade, p.campus, p.titulacao, vinc].join(" ");
}

/* =========================================================================
   Filtros e Busca por Palavra-chave
   ========================================================================= */

function populateFilterOptions() {
  const campi = new Set();
  const unidades = new Set();
  const titulacoes = new Set();
  for (const p of state.docentes) {
    if (p.campus) campi.add(p.campus);
    if (p.unidade) unidades.add(p.unidade);
    if (p.titulacao) titulacoes.add(p.titulacao);
  }
  fillSelect("f-campus", campi, "Campus — todos");
  fillSelect("f-unidade", unidades, "Unidade / Departamento — todas");
  fillSelect("f-titulacao", titulacoes, "Titulação — todas");

  document.getElementById("kpi-docentes").textContent = state.docentes.length;
  document.getElementById("kpi-campi").textContent = campi.size;
  document.getElementById("kpi-unidades").textContent = unidades.size;
}

function fillSelect(id, values, placeholder) {
  const sel = document.getElementById(id);
  const sorted = Array.from(values).sort((a, b) => a.localeCompare(b, "pt-BR"));
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    sorted.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("");
}

function applyFilters(list) {
  const { campus, unidade, titulacao } = state.filters;
  return list.filter((p) => {
    if (campus && p.campus !== campus) return false;
    if (unidade && p.unidade !== unidade) return false;
    if (titulacao && p.titulacao !== titulacao) return false;
    return true;
  });
}

function keywordSearch(list, query) {
  const q = normalize(query).trim();
  if (!q) return list;
  const terms = q.split(/\s+/).filter(Boolean);
  return list.filter((p) => {
    const hay = normalize(corpusText(p));
    return terms.every((t) => hay.includes(t));
  });
}

/* =========================================================================
   Active Filter Pills
   ========================================================================= */

function updateActivePills() {
  const container = document.getElementById("active-pills");
  const pills = [];

  if (state.filters.campus) pills.push({ label: `Campus: ${state.filters.campus}`, type: "campus" });
  if (state.filters.unidade) pills.push({ label: `Unidade: ${state.filters.unidade}`, type: "unidade" });
  if (state.filters.titulacao) pills.push({ label: `Titulação: ${state.filters.titulacao}`, type: "titulacao" });
  if (state.query.trim()) pills.push({ label: `Busca: "${state.query.trim()}"`, type: "query" });

  container.innerHTML = pills.map((p) => `
    <span class="pill-tag">
      ${escapeHtml(p.label)}
      <button data-clear="${p.type}" title="Remover filtro">✕</button>
    </span>
  `).join("");

  container.querySelectorAll("button[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.clear;
      if (type === "campus") { state.filters.campus = ""; document.getElementById("f-campus").value = ""; }
      else if (type === "unidade") { state.filters.unidade = ""; document.getElementById("f-unidade").value = ""; }
      else if (type === "titulacao") { state.filters.titulacao = ""; document.getElementById("f-titulacao").value = ""; }
      else if (type === "query") { state.query = ""; document.getElementById("q").value = ""; }
      runSearchAndRender();
    });
  });
}

/* =========================================================================
   Renderização — Docentes & Modal
   ========================================================================= */

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function renderDocentes(filteredList) {
  state.filtered = filteredList;
  const ul = document.getElementById("lista");
  const empty = document.getElementById("empty");
  const count = document.getElementById("result-count");

  count.textContent = `${filteredList.length} docente${filteredList.length === 1 ? "" : "s"} encontrado${filteredList.length === 1 ? "" : "s"}`;

  if (filteredList.length === 0) {
    ul.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  ul.innerHTML = filteredList.map((p) => {
    const vinculos = (p.vinculos || []).slice(0, 2).map((v) => `
      <li>
        <div class="vinculo-curso">${escapeHtml(v.curso)}</div>
        ${v.disciplinas ? `<div class="vinculo-disc">${escapeHtml(v.disciplinas)}</div>` : ""}
      </li>`).join("");

    const hasMoreVinculos = (p.vinculos || []).length > 2;

    return `
      <li class="card">
        <div class="card-head">
          <h3 class="card-name">${escapeHtml(p.nome)}</h3>
        </div>
        <div class="card-meta">
          <span>📍 ${escapeHtml(p.campus || "Campus N/A")}</span>
          <span>🏛️ ${escapeHtml(p.unidade || "Unidade N/A")}</span>
          <span>🎓 ${escapeHtml(p.titulacao || "Titulação N/A")}</span>
        </div>
        <ul class="vinculos">
          ${vinculos}
          ${hasMoreVinculos ? `<li><em style="font-size:11.5px;color:var(--ink-soft)">+ ${(p.vinculos.length - 2)} outros cursos/disciplinas...</em></li>` : ""}
        </ul>
        <div class="card-foot">
          <button class="btn-sm btn-docente-detail" data-idx="${p.__idx}" type="button">📋 Ver Detalhes</button>
          <div class="card-links">
            ${p.email ? `<a class="btn-sm" href="mailto:${escapeAttr(p.email)}" title="Enviar e-mail">✉️ E-mail</a>` : ""}
            ${p.lattes ? `<a class="btn-sm" href="${escapeAttr(p.lattes)}" target="_blank" rel="noopener">📄 Lattes</a>` : ""}
          </div>
        </div>
      </li>`;
  }).join("");

  ul.querySelectorAll(".btn-docente-detail").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      openDocenteModal(state.docentes[idx]);
    });
  });
}

function openDocenteModal(p) {
  const modalBackdrop = document.getElementById("modal-docente");
  const modalBody = document.getElementById("modal-body");

  const vinculosHtml = (p.vinculos || []).map((v) => `
    <div style="margin-bottom:12px;padding:10px;background:var(--panel-hover);border-radius:8px">
      <div style="font-weight:700;color:var(--primary)">${escapeHtml(v.curso)}</div>
      ${v.disciplinas ? `<div style="font-size:12.5px;color:var(--ink-soft);margin-top:4px">${escapeHtml(v.disciplinas)}</div>` : ""}
    </div>
  `).join("");

  modalBody.innerHTML = `
    <h2 class="modal-title">${escapeHtml(p.nome)}</h2>
    <div class="modal-subtitle">
      🎓 ${escapeHtml(p.titulacao || "N/A")} &bull; 🏛️ ${escapeHtml(p.unidade || "N/A")} &bull; 📍 ${escapeHtml(p.campus || "N/A")}
    </div>
    ${p.email ? `
      <div style="margin-bottom:16px;display:flex;align-items:center;gap:10px">
        <strong>E-mail:</strong> <code style="background:var(--panel-hover);padding:3px 8px;border-radius:4px">${escapeHtml(p.email)}</code>
        <button id="copy-email-btn" class="btn-sm" type="button">📋 Copiar</button>
      </div>` : ""}
    ${p.lattes ? `<p style="margin-bottom:16px"><strong>Currículo Lattes:</strong> <a href="${escapeAttr(p.lattes)}" target="_blank" rel="noopener">${escapeHtml(p.lattes)}</a></p>` : ""}
    <h3 style="font-size:15px;font-weight:700;margin:16px 0 10px">Vínculos de Ensino e Disciplinas (${(p.vinculos||[]).length})</h3>
    <div>${vinculosHtml}</div>
  `;

  modalBackdrop.classList.add("active");
  modalBackdrop.setAttribute("aria-hidden", "false");

  const copyBtn = document.getElementById("copy-email-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(p.email).then(() => {
        copyBtn.textContent = "✔ Copiado!";
        setTimeout(() => { copyBtn.textContent = "📋 Copiar"; }, 1500);
      });
    });
  }
}

function closeModal() {
  const modalBackdrop = document.getElementById("modal-docente");
  modalBackdrop.classList.remove("active");
  modalBackdrop.setAttribute("aria-hidden", "true");
}

function runSearchAndRender() {
  updateActivePills();
  const indexed = state.docentes.map((p, i) => Object.assign({ __idx: i }, p));
  const filteredBySelects = applyFilters(indexed);
  const finalScored = keywordSearch(filteredBySelects, state.query);
  renderDocentes(finalScored);
}

/* =========================================================================
   Exportação de Dados (CSV / JSON)
   ========================================================================= */

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportDocentesCSV() {
  const rows = [["Nome", "Campus", "Unidade", "Titulação", "E-mail", "Lattes"]];
  state.filtered.forEach((d) => {
    rows.push([
      `"${(d.nome||"").replace(/"/g, '""')}"`,
      `"${(d.campus||"").replace(/"/g, '""')}"`,
      `"${(d.unidade||"").replace(/"/g, '""')}"`,
      `"${(d.titulacao||"").replace(/"/g, '""')}"`,
      `"${(d.email||"").replace(/"/g, '""')}"`,
      `"${(d.lattes||"").replace(/"/g, '""')}"`
    ]);
  });

  const csvContent = "\uFEFF" + rows.map((r) => r.join(",")).join("\n");
  downloadFile(csvContent, `docentes_unifal_${new Date().toISOString().slice(0,10)}.csv`, "text/csv;charset=utf-8;");
}

function exportDocentesJSON() {
  const jsonContent = JSON.stringify(state.filtered, null, 2);
  downloadFile(jsonContent, `docentes_unifal_${new Date().toISOString().slice(0,10)}.json`, "application/json");
}

/* =========================================================================
   Eventos & Atalhos
   ========================================================================= */

function wireControls() {
  const q = document.getElementById("q");
  let debounce;
  q.addEventListener("input", () => {
    state.query = q.value;
    clearTimeout(debounce);
    debounce = setTimeout(runSearchAndRender, 120);
  });

  document.getElementById("f-campus").addEventListener("change", (e) => { state.filters.campus = e.target.value; runSearchAndRender(); });
  document.getElementById("f-unidade").addEventListener("change", (e) => { state.filters.unidade = e.target.value; runSearchAndRender(); });
  document.getElementById("f-titulacao").addEventListener("change", (e) => { state.filters.titulacao = e.target.value; runSearchAndRender(); });

  document.getElementById("clear-filters").addEventListener("click", () => {
    state.filters = { campus: "", unidade: "", titulacao: "" };
    state.query = "";
    document.getElementById("q").value = "";
    document.getElementById("f-campus").value = "";
    document.getElementById("f-unidade").value = "";
    document.getElementById("f-titulacao").value = "";
    runSearchAndRender();
  });

  document.getElementById("export-csv").addEventListener("click", exportDocentesCSV);
  document.getElementById("export-json").addEventListener("click", exportDocentesJSON);
}

function wireModalEvents() {
  const backdrop = document.getElementById("modal-docente");
  const closeBtn = document.getElementById("modal-close");

  closeBtn.addEventListener("click", closeModal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
}

function wireShortcuts() {
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      document.getElementById("q").focus();
    } else if (e.key === "Escape") {
      closeModal();
    }
  });
}

/* =========================================================================
   Inicialização
   ========================================================================= */

async function init() {
  initTheme();
  await loadData();
  populateFilterOptions();
  wireControls();
  wireModalEvents();
  wireShortcuts();
  runSearchAndRender();
}

init();
