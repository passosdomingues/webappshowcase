"use strict";

/* =========================================================================
   Estado e Carregamento de Dados
   ========================================================================= */

const state = {
  docentes: [],
  filtered: [],
  filters: { campus: "", unidade: "", titulacao: "", piOnly: false },
  query: "",
  bm25Index: null
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
   Normalizacao e Texto de Busca
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
   Okapi BM25 Ranking Engine
   ========================================================================= */

const BM25 = {
  k1: 1.5,
  b: 0.75,

  /** Build the inverted index over the corpus */
  buildIndex(docs) {
    const index = {
      N: docs.length,
      avgDl: 0,
      docLengths: [],
      df: {},         // term -> number of docs containing it
      tf: [],         // docIndex -> { term -> count }
      corpus: []      // raw normalized tokens per doc
    };

    let totalLen = 0;

    for (let i = 0; i < docs.length; i++) {
      const tokens = normalize(corpusText(docs[i]))
        .split(/\s+/)
        .filter(Boolean);
      index.docLengths[i] = tokens.length;
      totalLen += tokens.length;
      index.corpus[i] = tokens;

      const tfMap = {};
      const seen = new Set();
      for (const tok of tokens) {
        tfMap[tok] = (tfMap[tok] || 0) + 1;
        if (!seen.has(tok)) {
          seen.add(tok);
          index.df[tok] = (index.df[tok] || 0) + 1;
        }
      }
      index.tf[i] = tfMap;
    }

    index.avgDl = totalLen / (docs.length || 1);
    return index;
  },

  /** Score a single document against query terms */
  scoreDoc(index, docIdx, queryTerms) {
    let score = 0;
    const dl = index.docLengths[docIdx];
    const tfMap = index.tf[docIdx];

    for (const term of queryTerms) {
      // Prefix-match: find all indexed tokens that start with this term
      let termFreq = 0;
      let docFreq = 0;

      for (const indexedTerm of Object.keys(tfMap)) {
        if (indexedTerm.startsWith(term) || indexedTerm.includes(term)) {
          termFreq += tfMap[indexedTerm];
        }
      }
      // Estimate DF from prefix matches across corpus
      for (const t of Object.keys(index.df)) {
        if (t.startsWith(term) || t.includes(term)) {
          docFreq = Math.max(docFreq, index.df[t]);
        }
      }

      if (termFreq === 0) continue;

      const idf = Math.log(
        (index.N - docFreq + 0.5) / (docFreq + 0.5) + 1
      );
      const tfNorm =
        (termFreq * (this.k1 + 1)) /
        (termFreq + this.k1 * (1 - this.b + this.b * (dl / index.avgDl)));
      score += idf * tfNorm;
    }
    return score;
  },

  /** Rank a pre-filtered list of docs, returning those with score > 0 sorted desc */
  rank(index, docs, query) {
    const q = normalize(query).trim();
    if (!q) return docs;
    const terms = q.split(/\s+/).filter(Boolean);

    const scored = [];
    for (const doc of docs) {
      const idx = doc.__idx;
      const score = this.scoreDoc(index, idx, terms);
      if (score > 0) {
        scored.push({ doc, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
};

/* =========================================================================
   Term Highlighting
   ========================================================================= */

function highlightTerms(text, query) {
  if (!query || !text) return escapeHtml(text);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return escapeHtml(text);

  const escaped = escapeHtml(text);
  const normalizedEscaped = normalize(escaped);

  // Build ranges to highlight
  const ranges = [];
  for (const term of terms) {
    let pos = 0;
    while (pos < normalizedEscaped.length) {
      const idx = normalizedEscaped.indexOf(term, pos);
      if (idx === -1) break;
      ranges.push([idx, idx + term.length]);
      pos = idx + 1;
    }
  }

  if (!ranges.length) return escaped;

  // Merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }

  // Apply highlights from right to left to preserve indices
  let result = escaped;
  for (let i = merged.length - 1; i >= 0; i--) {
    const [start, end] = merged[i];
    result =
      result.slice(0, start) +
      '<mark class="bm25-hl">' +
      result.slice(start, end) +
      "</mark>" +
      result.slice(end);
  }
  return result;
}

/* =========================================================================
   Filtros
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
  fillSelect("f-titulacao", titulacoes, "Titulacao — todas");

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
  const { campus, unidade, titulacao, piOnly } = state.filters;
  return list.filter((p) => {
    if (campus && p.campus !== campus) return false;
    if (unidade && p.unidade !== unidade) return false;
    if (titulacao && p.titulacao !== titulacao) return false;
    if (piOnly && !(p.pi_registrada && p.pi_registrada.length > 0)) return false;
    return true;
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
  if (state.filters.titulacao) pills.push({ label: `Titulacao: ${state.filters.titulacao}`, type: "titulacao" });
  if (state.filters.piOnly) pills.push({ label: "Com PI / Programa registrado", type: "piOnly" });
  if (state.query.trim()) pills.push({ label: `Busca: "${state.query.trim()}"`, type: "query" });

  container.innerHTML = pills.map((p) => `
    <span class="pill-tag">
      ${escapeHtml(p.label)}
      <button data-clear="${p.type}" title="Remover filtro">&times;</button>
    </span>
  `).join("");

  container.querySelectorAll("button[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.clear;
      if (type === "campus") { state.filters.campus = ""; document.getElementById("f-campus").value = ""; }
      else if (type === "unidade") { state.filters.unidade = ""; document.getElementById("f-unidade").value = ""; }
      else if (type === "titulacao") { state.filters.titulacao = ""; document.getElementById("f-titulacao").value = ""; }
      else if (type === "piOnly") { state.filters.piOnly = false; document.getElementById("f-pi").checked = false; }
      else if (type === "query") { state.query = ""; document.getElementById("q").value = ""; }
      runSearchAndRender();
    });
  });
}

/* =========================================================================
   Renderizacao — Docentes & Modal
   ========================================================================= */

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function renderDocentes(results) {
  const isRanked = results.length > 0 && results[0] && typeof results[0].score === "number";
  const filteredList = isRanked ? results.map((r) => r.doc) : results;
  const scores = isRanked ? results.map((r) => r.score) : null;
  const maxScore = scores ? Math.max(...scores) : 0;

  state.filtered = filteredList;
  const ul = document.getElementById("lista");
  const empty = document.getElementById("empty");
  const count = document.getElementById("result-count");
  const q = state.query.trim();

  const method = q ? " (Okapi BM25)" : "";
  count.textContent = `${filteredList.length} docente${filteredList.length === 1 ? "" : "s"} encontrado${filteredList.length === 1 ? "" : "s"}${method}`;

  if (filteredList.length === 0) {
    ul.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  ul.innerHTML = filteredList.map((p, listIdx) => {
    const hl = (text) => q ? highlightTerms(text, q) : escapeHtml(text);

    const vinculos = (p.vinculos || []).slice(0, 2).map((v) => `
      <li>
        <div class="vinculo-curso">${hl(v.curso)}</div>
        ${v.disciplinas ? `<div class="vinculo-disc">${hl(v.disciplinas)}</div>` : ""}
      </li>`).join("");

    const hasMoreVinculos = (p.vinculos || []).length > 2;
    const hasPi = p.pi_registrada && p.pi_registrada.length > 0;
    const piBadge = hasPi
      ? `<span class="badge-pi" title="Possui patente ou programa de computador registrado no INPI">PI/Programa</span>`
      : "";

    const scoreBar = scores
      ? `<span class="bm25-score" title="BM25 score: ${scores[listIdx].toFixed(2)}">
           <span class="bm25-bar" style="width:${Math.max(8, (scores[listIdx] / maxScore) * 60)}px"></span>
           ${scores[listIdx].toFixed(1)}
         </span>`
      : "";

    return `
      <li class="card${hasPi ? ' card-has-pi' : ''}">
        <div class="card-head">
          <h3 class="card-name">${hl(p.nome)}</h3>
          ${piBadge}
          ${scoreBar}
        </div>
        <div class="card-meta">
          <span>${hl(p.campus || "Campus N/A")}</span>
          <span>${hl(p.unidade || "Unidade N/A")}</span>
          <span>${hl(p.titulacao || "Titulacao N/A")}</span>
        </div>
        <ul class="vinculos">
          ${vinculos}
          ${hasMoreVinculos ? `<li><em style="font-size:11.5px;color:var(--ink-soft)">+ ${(p.vinculos.length - 2)} outros cursos/disciplinas...</em></li>` : ""}
        </ul>
        <div class="card-foot">
          <button class="btn-sm btn-docente-detail" data-idx="${p.__idx}" type="button">Ver Detalhes</button>
          <div class="card-links">
            ${p.email ? `<a class="btn-sm" href="mailto:${escapeAttr(p.email)}" title="Enviar e-mail">E-mail</a>` : ""}
            ${p.lattes ? `<a class="btn-sm" href="${escapeAttr(p.lattes)}" target="_blank" rel="noopener">Lattes</a>` : ""}
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

  const piHtml = (p.pi_registrada && p.pi_registrada.length > 0)
    ? `<div class="modal-pi-section">
        <h3 class="modal-pi-title">Patentes e Programas Registrados (INPI)</h3>
        <p class="modal-pi-note">Informacao disponivel publicamente na <a href="https://www.unifal-mg.edu.br/i9unifal/vitrine-tecnologica/" target="_blank" rel="noopener">Vitrine Tecnologica</a> da UNIFAL-MG.</p>
        <ul class="modal-pi-list">
          ${p.pi_registrada.map(n => `<li><code>${escapeHtml(n)}</code></li>`).join("")}
        </ul>
      </div>`
    : "";

  modalBody.innerHTML = `
    <h2 class="modal-title">${escapeHtml(p.nome)}</h2>
    <div class="modal-subtitle">
      ${escapeHtml(p.titulacao || "N/A")} &bull; ${escapeHtml(p.unidade || "N/A")} &bull; ${escapeHtml(p.campus || "N/A")}
    </div>
    ${p.email ? `
      <div style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong>E-mail:</strong> <code style="background:var(--panel-hover);padding:3px 8px;border-radius:4px">${escapeHtml(p.email)}</code>
        <button id="copy-email-btn" class="btn-sm" type="button">Copiar</button>
      </div>` : ""}
    ${p.lattes ? `<p style="margin-bottom:16px"><strong>Curriculo Lattes:</strong> <a href="${escapeAttr(p.lattes)}" target="_blank" rel="noopener">${escapeHtml(p.lattes)}</a></p>` : ""}
    ${piHtml}
    <h3 style="font-size:15px;font-weight:700;margin:16px 0 10px">Vinculos de Ensino e Disciplinas (${(p.vinculos||[]).length})</h3>
    <div>${vinculosHtml}</div>
  `;

  modalBackdrop.classList.add("active");
  modalBackdrop.setAttribute("aria-hidden", "false");

  const copyBtn = document.getElementById("copy-email-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(p.email).then(() => {
        copyBtn.textContent = "Copiado!";
        setTimeout(() => { copyBtn.textContent = "Copiar"; }, 1500);
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

  const q = state.query.trim();
  if (q && state.bm25Index) {
    const ranked = BM25.rank(state.bm25Index, filteredBySelects, q);
    renderDocentes(ranked);
  } else {
    renderDocentes(filteredBySelects);
  }
}

/* =========================================================================
   Exportacao de Dados (CSV / JSON)
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
  const rows = [["Nome", "Campus", "Unidade", "Titulacao", "E-mail", "Lattes"]];
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
  document.getElementById("f-pi").addEventListener("change", (e) => { state.filters.piOnly = e.target.checked; runSearchAndRender(); });

  document.getElementById("clear-filters").addEventListener("click", () => {
    state.filters = { campus: "", unidade: "", titulacao: "", piOnly: false };
    state.query = "";
    document.getElementById("q").value = "";
    document.getElementById("f-campus").value = "";
    document.getElementById("f-unidade").value = "";
    document.getElementById("f-titulacao").value = "";
    document.getElementById("f-pi").checked = false;
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
   Inicializacao
   ========================================================================= */

async function init() {
  await loadData();
  state.bm25Index = BM25.buildIndex(state.docentes);
  populateFilterOptions();
  wireControls();
  wireModalEvents();
  wireShortcuts();
  runSearchAndRender();
}

init();
