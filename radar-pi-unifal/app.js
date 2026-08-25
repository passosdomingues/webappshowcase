"use strict";

/* =========================================================================
   Estado e carregamento de dados
   ========================================================================= */

const state = {
  docentes: [],
  portfolio: null,
  filtered: [],
  filters: { campus: "", unidade: "", titulacao: "", somentePatente: false },
  query: "",
  semantic: { on: false, ready: false, loading: false, embeddings: null, extractor: null },
  sort: {
    patentes: { key: "", asc: true },
    softwares: { key: "", asc: true },
    marcas: { key: "", asc: true }
  },
  charts: {}
};

async function loadData() {
  if (window.DOCENTES_DATA && window.PORTFOLIO_DATA) {
    state.docentes = window.DOCENTES_DATA;
    state.portfolio = window.PORTFOLIO_DATA;
    return;
  }
  const [docRes, pfRes] = await Promise.all([
    fetch("docentes.json"),
    fetch("portfolio.json"),
  ]);
  state.docentes = await docRes.json();
  state.portfolio = await pfRes.json();
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
    if (Object.keys(state.charts).length) renderAnalyticsCharts();
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
  fillSelect("f-unidade", unidades, "Unidade — todas");
  fillSelect("f-titulacao", titulacoes, "Titulação — todas");
}

function fillSelect(id, values, placeholder) {
  const sel = document.getElementById(id);
  const sorted = Array.from(values).sort((a, b) => a.localeCompare(b, "pt-BR"));
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    sorted.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("");
}

function applyFilters(list) {
  const { campus, unidade, titulacao, somentePatente } = state.filters;
  return list.filter((p) => {
    if (campus && p.campus !== campus) return false;
    if (unidade && p.unidade !== unidade) return false;
    if (titulacao && p.titulacao !== titulacao) return false;
    if (somentePatente && !((p.patentes && p.patentes.length) || (p.patentes_pi && p.patentes_pi.length))) return false;
    return true;
  });
}

function keywordSearch(list, query) {
  const q = normalize(query).trim();
  if (!q) return list.map((p) => ({ item: p, score: null }));
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const p of list) {
    const hay = normalize(corpusText(p));
    let ok = true;
    for (const t of terms) {
      if (!hay.includes(t)) { ok = false; break; }
    }
    if (ok) scored.push({ item: p, score: null });
  }
  return scored;
}

/* =========================================================================
   Active Filter Pills
   ========================================================================= */

function updateActivePills() {
  const container = document.getElementById("active-pills");
  const pills = [];

  if (state.filters.campus) {
    pills.push({ label: `Campus: ${state.filters.campus}`, type: "campus" });
  }
  if (state.filters.unidade) {
    pills.push({ label: `Unidade: ${state.filters.unidade}`, type: "unidade" });
  }
  if (state.filters.titulacao) {
    pills.push({ label: `Titulação: ${state.filters.titulacao}`, type: "titulacao" });
  }
  if (state.filters.somentePatente) {
    pills.push({ label: `Somente PI Sinalizada`, type: "somentePatente" });
  }
  if (state.query.trim()) {
    pills.push({ label: `Busca: "${state.query.trim()}"`, type: "query" });
  }

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
      else if (type === "somentePatente") { state.filters.somentePatente = false; document.getElementById("f-patente").checked = false; }
      else if (type === "query") { state.query = ""; document.getElementById("q").value = ""; }
      runSearchAndRender();
    });
  });
}

/* =========================================================================
   Busca Semântica
   ========================================================================= */

const SEMANTIC_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const CACHE_KEY = "radarpi_embeddings_v1";

function setSemanticStatus(msg) {
  const el = document.getElementById("semantic-status");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = msg;
}

async function ensureSemanticReady() {
  if (state.semantic.ready || state.semantic.loading) return;
  state.semantic.loading = true;
  setSemanticStatus("Carregando modelo de busca semântica no navegador (primeira vez pode levar alguns segundos)…");
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
    mod.env.allowLocalModels = false;
    state.semantic.extractor = await mod.pipeline("feature-extraction", SEMANTIC_MODEL);

    const cached = loadEmbeddingCache();
    if (cached && cached.length === state.docentes.length) {
      state.semantic.embeddings = cached;
    } else {
      setSemanticStatus("Calculando embeddings dos docentes (uma única vez, ficam salvos no navegador)…");
      const embeddings = new Array(state.docentes.length);
      for (let i = 0; i < state.docentes.length; i++) {
        const text = corpusText(state.docentes[i]).slice(0, 512);
        const out = await state.semantic.extractor(text, { pooling: "mean", normalize: true });
        embeddings[i] = Array.from(out.data);
        if (i % 40 === 0) {
          setSemanticStatus(`Calculando embeddings dos docentes… ${i}/${state.docentes.length}`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      state.semantic.embeddings = embeddings;
      saveEmbeddingCache(embeddings);
    }
    state.semantic.ready = true;
    setSemanticStatus("Busca semântica ativa. Digite uma ideia ou tema — não precisa ser palavra exata.");
  } catch (err) {
    console.error(err);
    setSemanticStatus("Não foi possível carregar a busca semântica agora (verifique a conexão). A busca por palavra-chave continua funcionando normalmente.");
    state.semantic.on = false;
    document.getElementById("semantic-toggle").setAttribute("aria-pressed", "false");
    document.getElementById("semantic-toggle").textContent = "⚡ Busca semântica: desligada";
  } finally {
    state.semantic.loading = false;
  }
}

function loadEmbeddingCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function saveEmbeddingCache(embeddings) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(embeddings));
  } catch (e) {}
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function semanticSearch(list, query) {
  if (!query.trim()) return list.map((p) => ({ item: p, score: null }));
  const queryEmb = await state.semantic.extractor(query, { pooling: "mean", normalize: true });
  const qVec = Array.from(queryEmb.data);
  const allowed = new Set(list.map((p) => p.__idx));
  const scored = [];
  for (let i = 0; i < state.docentes.length; i++) {
    if (!allowed.has(i)) continue;
    const sim = cosineSim(qVec, state.semantic.embeddings[i]);
    scored.push({ item: state.docentes[i], score: sim });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 60).filter((s) => s.score > 0.28);
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

function renderDocentes(scored) {
  state.filtered = scored.map((s) => s.item);
  const ul = document.getElementById("lista");
  const empty = document.getElementById("empty");
  const count = document.getElementById("result-count");

  count.textContent = `${scored.length} docente${scored.length === 1 ? "" : "s"} encontrado${scored.length === 1 ? "" : "s"}`;

  if (scored.length === 0) {
    ul.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  ul.innerHTML = scored.map(({ item: p, score }, idx) => {
    const badges = [];
    if ((p.patentes && p.patentes.length) || (p.patentes_pi && p.patentes_pi.length)) {
      badges.push(`<span class="badge warn">PI Sinalizada</span>`);
    }
    if (p.laboratorios && p.laboratorios.length) {
      for (const sigla of p.laboratorios) badges.push(`<span class="badge">${escapeHtml(sigla)}</span>`);
    }

    const vinculos = (p.vinculos || []).slice(0, 2).map((v) => `
      <li>
        <div class="vinculo-curso">${escapeHtml(v.curso)}</div>
        ${v.disciplinas ? `<div class="vinculo-disc">${escapeHtml(v.disciplinas)}</div>` : ""}
      </li>`).join("");

    const hasMoreVinculos = (p.vinculos || []).length > 2;
    const scoreTag = score != null ? `<span class="card-score">similaridade ${(score * 100).toFixed(0)}%</span>` : "";

    return `
      <li class="card">
        <div class="card-head">
          <h3 class="card-name">${escapeHtml(p.nome)}</h3>
          ${scoreTag}
        </div>
        <div class="card-meta">
          <span>📍 ${escapeHtml(p.campus || "Campus N/A")}</span>
          <span>🏛️ ${escapeHtml(p.unidade || "Unidade N/A")}</span>
          <span>🎓 ${escapeHtml(p.titulacao || "Titulação N/A")}</span>
        </div>
        ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
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

  // Attach modal listeners
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

  const patentesHtml = (p.patentes || []).map((url, i) => `
    <a class="btn-sm patente" href="${escapeAttr(url)}" target="_blank" rel="noopener" style="margin-right:6px">🔗 Documento de PI ${p.patentes.length > 1 ? i + 1 : ""}</a>
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
    ${p.lattes ? `<p><strong>Currículo Lattes:</strong> <a href="${escapeAttr(p.lattes)}" target="_blank" rel="noopener">${escapeHtml(p.lattes)}</a></p>` : ""}
    ${patentesHtml ? `<div style="margin-bottom:16px"><strong>Documentos de PI:</strong><br>${patentesHtml}</div>` : ""}
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

async function runSearchAndRender() {
  updateActivePills();
  const base = applyFilters(state.docentes.map((p, i) => Object.assign({ __idx: i }, p)));
  let scored;
  if (state.semantic.on && state.semantic.ready && state.query.trim()) {
    scored = await semanticSearch(base, state.query);
  } else {
    scored = keywordSearch(base, state.query);
  }
  renderDocentes(scored);
}

/* =========================================================================
   Renderização — Portfólio Institucional
   ========================================================================= */

function renderPortfolio() {
  const pf = state.portfolio;

  document.getElementById("marcos").innerHTML = pf.marcos_institucionais.map((m) => `
    <div class="marco">
      <span class="periodo">${escapeHtml(m.periodo)}</span>
      <strong>${escapeHtml(m.indicador)}</strong>
      <p>${escapeHtml(m.descricao)}</p>
    </div>`).join("");

  document.getElementById("laboratorios").innerHTML = pf.laboratorios.map((l) => `
    <div class="card">
      <h3>${escapeHtml(l.sigla)} — ${escapeHtml(l.nome)}</h3>
      <p><strong>Vinculação:</strong> ${escapeHtml(l.vinculacao)}</p>
      <p><strong>Pesquisadores:</strong> ${escapeHtml(l.pesquisadores.join(", "))}</p>
      <p><strong>Linhas:</strong> ${escapeHtml(l.linhas)}</p>
    </div>`).join("");

  document.getElementById("patentes-destaque").innerHTML = pf.patentes_destaque.map((p) => `
    <div class="card">
      <h3>${escapeHtml(p.titulo)}</h3>
      <p><strong>Número:</strong> ${escapeHtml(p.numero)}</p>
      ${p.orientador && p.orientador !== "—" ? `<p><strong>Responsável:</strong> ${escapeHtml(p.orientador)}</p>` : ""}
      <p><strong>Situação:</strong> ${escapeHtml(p.situacao)}</p>
      <p><strong>Campo:</strong> ${escapeHtml(p.campo)}</p>
    </div>`).join("");

  renderPatentesTable(pf.patentes);
  document.getElementById("count-patentes").textContent = `(${pf.patentes.length})`;

  document.getElementById("count-softwares").textContent = `(${pf.softwares.length})`;
  renderSoftwaresTable(pf.softwares);

  document.getElementById("count-marcas").textContent = `(${pf.marcas.length})`;
  renderMarcasTable(pf.marcas);
}

function renderPatentesTable(patentes) {
  document.getElementById("tabela-patentes").querySelector("tbody").innerHTML = patentes.map((p) => `
    <tr>
      <td><code>${escapeHtml(p.numero)}</code></td>
      <td><strong>${escapeHtml(p.titulo)}</strong></td>
      <td><span class="badge warn">${escapeHtml(p.trl)}</span></td>
      <td>${escapeHtml(p.parceria)}</td>
      <td>${escapeHtml(p.campo)}</td>
    </tr>`).join("");
}

function renderSoftwaresTable(softwares) {
  document.getElementById("tabela-softwares").querySelector("tbody").innerHTML = softwares.map((s) => `
    <tr>
      <td><code>${escapeHtml(s.numero)}</code></td>
      <td><strong>${escapeHtml(s.nome)}</strong></td>
      <td>${escapeHtml(s.area)}</td>
      <td>${escapeHtml(s.diferencial)}</td>
      <td><span class="badge">${escapeHtml(s.maturidade)}</span></td>
    </tr>`).join("");
}

function renderMarcasTable(marcas) {
  document.getElementById("tabela-marcas").querySelector("tbody").innerHTML = marcas.map((m) => `
    <tr>
      <td><code>${escapeHtml(m.registro)}</code></td>
      <td><strong>${escapeHtml(m.nome)}</strong></td>
      <td>${escapeHtml(m.apresentacao)}</td>
      <td>${escapeHtml(m.deposito)}</td>
      <td>${escapeHtml(m.concessao)}</td>
    </tr>`).join("");
}

/* =========================================================================
   Analytics & Charts (Chart.js)
   ========================================================================= */

function renderAnalyticsCharts() {
  if (typeof Chart === "undefined" || !state.portfolio) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const textColor = isDark ? "#94a3b8" : "#475569";
  const gridColor = isDark ? "#263346" : "#e2e8f0";

  // Destruir gráficos anteriores
  Object.values(state.charts).forEach((c) => c.destroy());
  state.charts = {};

  // 1. TRL Patentes
  const trlCounts = {};
  state.portfolio.patentes.forEach((p) => {
    const trl = p.trl || "Outro";
    trlCounts[trl] = (trlCounts[trl] || 0) + 1;
  });

  const ctxTRL = document.getElementById("chartTRL");
  if (ctxTRL) {
    state.charts.trl = new Chart(ctxTRL, {
      type: "doughnut",
      data: {
        labels: Object.keys(trlCounts),
        datasets: [{
          data: Object.values(trlCounts),
          backgroundColor: ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"],
          borderWidth: 2,
          borderColor: isDark ? "#151d2a" : "#ffffff"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: textColor } }
        }
      }
    });
  }

  // 2. Softwares por Maturidade
  const softCounts = {};
  state.portfolio.softwares.forEach((s) => {
    const mat = s.maturidade || "Não inf.";
    softCounts[mat] = (softCounts[mat] || 0) + 1;
  });

  const ctxSoft = document.getElementById("chartSoftwares");
  if (ctxSoft) {
    state.charts.soft = new Chart(ctxSoft, {
      type: "bar",
      data: {
        labels: Object.keys(softCounts),
        datasets: [{
          label: "Quantidade de Softwares",
          data: Object.values(softCounts),
          backgroundColor: "#3b82f6",
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: textColor }, grid: { color: gridColor } },
          y: { ticks: { color: textColor, stepSize: 1 }, grid: { color: gridColor } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  // 3. Docentes por Campus
  const campusCounts = {};
  state.docentes.forEach((d) => {
    const c = d.campus || "Não informado";
    campusCounts[c] = (campusCounts[c] || 0) + 1;
  });

  const ctxCampus = document.getElementById("chartCampus");
  if (ctxCampus) {
    state.charts.campus = new Chart(ctxCampus, {
      type: "pie",
      data: {
        labels: Object.keys(campusCounts),
        datasets: [{
          data: Object.values(campusCounts),
          backgroundColor: ["#10b981", "#3b82f6", "#f59e0b", "#6366f1"],
          borderWidth: 2,
          borderColor: isDark ? "#151d2a" : "#ffffff"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { color: textColor } } }
      }
    });
  }

  // 4. Tipos de PI (Patentes vs Softwares vs Marcas)
  const ctxPI = document.getElementById("chartPIPortfolio");
  if (ctxPI) {
    state.charts.pi = new Chart(ctxPI, {
      type: "bar",
      data: {
        labels: ["Patentes INPI", "Softwares", "Marcas Registradas", "Laboratórios"],
        datasets: [{
          label: "Itens Registrados",
          data: [
            state.portfolio.patentes.length,
            state.portfolio.softwares.length,
            state.portfolio.marcas.length,
            state.portfolio.laboratorios.length
          ],
          backgroundColor: ["#f59e0b", "#3b82f6", "#10b981", "#8b5cf6"],
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: textColor }, grid: { color: gridColor } },
          y: { ticks: { color: textColor }, grid: { color: gridColor } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }
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
  const rows = [["Nome", "Campus", "Unidade", "Titulação", "E-mail", "Lattes", "Possui PI"]];
  state.filtered.forEach((d) => {
    const temPI = ((d.patentes && d.patentes.length) || (d.patentes_pi && d.patentes_pi.length)) ? "Sim" : "Não";
    rows.push([
      `"${(d.nome||"").replace(/"/g, '""')}"`,
      `"${(d.campus||"").replace(/"/g, '""')}"`,
      `"${(d.unidade||"").replace(/"/g, '""')}"`,
      `"${(d.titulacao||"").replace(/"/g, '""')}"`,
      `"${(d.email||"").replace(/"/g, '""')}"`,
      `"${(d.lattes||"").replace(/"/g, '""')}"`,
      `"${temPI}"`
    ]);
  });

  const csvContent = "\uFEFF" + rows.map((r) => r.join(",")).join("\n");
  downloadFile(csvContent, `docentes_unifal_${new Date().toISOString().slice(0,10)}.csv`, "text/csv;charset=utf-8;");
}

function exportDocentesJSON() {
  const jsonContent = JSON.stringify(state.filtered, null, 2);
  downloadFile(jsonContent, `docentes_unifal_${new Date().toISOString().slice(0,10)}.json`, "application/json");
}

function exportPatentesCSV() {
  if (!state.portfolio) return;
  const rows = [["Numero INPI", "Titulo", "TRL", "Parceria", "Campo"]];
  state.portfolio.patentes.forEach((p) => {
    rows.push([
      `"${(p.numero||"").replace(/"/g, '""')}"`,
      `"${(p.titulo||"").replace(/"/g, '""')}"`,
      `"${(p.trl||"").replace(/"/g, '""')}"`,
      `"${(p.parceria||"").replace(/"/g, '""')}"`,
      `"${(p.campo||"").replace(/"/g, '""')}"`
    ]);
  });

  const csvContent = "\uFEFF" + rows.map((r) => r.join(",")).join("\n");
  downloadFile(csvContent, `patentes_unifal_${new Date().toISOString().slice(0,10)}.csv`, "text/csv;charset=utf-8;");
}

/* =========================================================================
   Eventos & Atalhos de Teclado
   ========================================================================= */

function wireTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      
      const targetPanel = document.getElementById(`panel-${tab.dataset.tab}`);
      if (targetPanel) targetPanel.classList.add("active");

      if (tab.dataset.tab === "analytics") {
        setTimeout(renderAnalyticsCharts, 50);
      }
    });
  });
}

function wireDocentesControls() {
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
  document.getElementById("f-patente").addEventListener("change", (e) => { state.filters.somentePatente = e.target.checked; runSearchAndRender(); });

  document.getElementById("clear-filters").addEventListener("click", () => {
    state.filters = { campus: "", unidade: "", titulacao: "", somentePatente: false };
    state.query = "";
    document.getElementById("q").value = "";
    document.getElementById("f-campus").value = "";
    document.getElementById("f-unidade").value = "";
    document.getElementById("f-titulacao").value = "";
    document.getElementById("f-patente").checked = false;
    runSearchAndRender();
  });

  document.getElementById("export-csv").addEventListener("click", exportDocentesCSV);
  document.getElementById("export-json").addEventListener("click", exportDocentesJSON);
  document.getElementById("export-patentes-csv").addEventListener("click", exportPatentesCSV);

  const toggle = document.getElementById("semantic-toggle");
  toggle.addEventListener("click", async () => {
    state.semantic.on = !state.semantic.on;
    toggle.setAttribute("aria-pressed", String(state.semantic.on));
    toggle.textContent = `⚡ Busca semântica: ${state.semantic.on ? "ligada" : "desligada"}`;
    if (state.semantic.on) {
      await ensureSemanticReady();
    } else {
      setSemanticStatus("");
    }
    runSearchAndRender();
  });
}

function wirePortfolioSearch() {
  const input = document.getElementById("q-patentes");
  input.addEventListener("input", () => {
    const term = normalize(input.value);
    const filtered = state.portfolio.patentes.filter((p) =>
      normalize(`${p.numero} ${p.titulo} ${p.campo} ${p.parceria} ${p.trl}`).includes(term)
    );
    renderPatentesTable(filtered);
    document.getElementById("count-patentes").textContent = `(${filtered.length})`;
  });
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

function wireTableSorting() {
  document.querySelectorAll(".datatable th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const tableId = th.closest("table").id;
      const key = th.dataset.sort;
      let targetList = [];
      let renderFn = null;
      let tableKey = "";

      if (tableId === "tabela-patentes") {
        targetList = state.portfolio.patentes;
        renderFn = renderPatentesTable;
        tableKey = "patentes";
      } else if (tableId === "tabela-softwares") {
        targetList = state.portfolio.softwares;
        renderFn = renderSoftwaresTable;
        tableKey = "softwares";
      } else if (tableId === "tabela-marcas") {
        targetList = state.portfolio.marcas;
        renderFn = renderMarcasTable;
        tableKey = "marcas";
      }

      if (!targetList.length) return;

      const currentSort = state.sort[tableKey];
      const asc = currentSort.key === key ? !currentSort.asc : true;
      state.sort[tableKey] = { key, asc };

      targetList.sort((a, b) => {
        const valA = (a[key] || "").toString();
        const valB = (b[key] || "").toString();
        return asc ? valA.localeCompare(valB, "pt-BR") : valB.localeCompare(valA, "pt-BR");
      });

      renderFn(targetList);
    });
  });
}

/* =========================================================================
   Inicialização
   ========================================================================= */

async function init() {
  initTheme();
  await loadData();
  populateFilterOptions();
  wireTabs();
  wireDocentesControls();
  wirePortfolioSearch();
  wireModalEvents();
  wireShortcuts();
  wireTableSorting();
  renderPortfolio();
  await runSearchAndRender();
}

init();
