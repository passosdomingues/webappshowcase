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
};

async function loadData() {
  const [docRes, pfRes] = await Promise.all([
    fetch("docentes.json"),
    fetch("portfolio.json"),
  ]);
  state.docentes = await docRes.json();
  state.portfolio = await pfRes.json();
}

/* =========================================================================
   Normalização e texto de busca
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
   Filtros e busca por palavra-chave
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
   Busca semântica (client-side, via transformers.js / WebAssembly)
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
    document.getElementById("semantic-toggle").textContent = "Busca semântica: desligada";
  } finally {
    state.semantic.loading = false;
  }
}

function loadEmbeddingCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveEmbeddingCache(embeddings) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(embeddings));
  } catch (e) {
    /* localStorage cheio ou indisponível — segue sem cache */
  }
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vetores já normalizados
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
   Renderização — Docentes
   ========================================================================= */

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function renderDocentes(scored) {
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

  ul.innerHTML = scored.map(({ item: p, score }) => {
    const badges = [];
    if ((p.patentes && p.patentes.length) || (p.patentes_pi && p.patentes_pi.length)) {
      badges.push(`<span class="badge warn">PI sinalizada</span>`);
    }
    if (p.laboratorios && p.laboratorios.length) {
      for (const sigla of p.laboratorios) badges.push(`<span class="badge">${escapeHtml(sigla)}</span>`);
    }

    const vinculos = (p.vinculos || []).map((v) => `
      <li>
        <div class="vinculo-curso">${escapeHtml(v.curso)}</div>
        ${v.disciplinas ? `<div class="vinculo-disc">${escapeHtml(v.disciplinas)}</div>` : ""}
      </li>`).join("");

    const links = [];
    if (p.email) links.push(`<a href="mailto:${escapeAttr(p.email)}">${escapeHtml(p.email)}</a>`);
    if (p.lattes) links.push(`<a href="${escapeAttr(p.lattes)}" target="_blank" rel="noopener">Currículo Lattes</a>`);
    (p.patentes || []).forEach((url, i) => {
      links.push(`<a class="patente" href="${escapeAttr(url)}" target="_blank" rel="noopener">Documento de PI ${p.patentes.length > 1 ? i + 1 : ""}</a>`);
    });

    const scoreTag = score != null ? `<span class="card-score">similaridade ${(score * 100).toFixed(0)}%</span>` : "";

    return `
      <li class="card">
        <div class="card-head">
          <p class="card-name">${escapeHtml(p.nome)}</p>
          ${scoreTag}
        </div>
        <p class="card-meta">
          <span>${escapeHtml(p.unidade || "Unidade não informada")}</span>
          <span>${escapeHtml(p.campus || "Campus não informado")}</span>
          <span>${escapeHtml(p.titulacao || "Titulação não informada")}</span>
        </p>
        ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
        <ul class="vinculos">${vinculos}</ul>
        ${links.length ? `<div class="card-links">${links.join("")}</div>` : ""}
      </li>`;
  }).join("");
}

async function runSearchAndRender() {
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
   Renderização — Portfólio institucional
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
  document.getElementById("tabela-softwares").querySelector("tbody").innerHTML = pf.softwares.map((s) => `
    <tr>
      <td>${escapeHtml(s.numero)}</td>
      <td>${escapeHtml(s.nome)}</td>
      <td>${escapeHtml(s.area)}</td>
      <td>${escapeHtml(s.diferencial)}</td>
      <td>${escapeHtml(s.maturidade)}</td>
    </tr>`).join("");

  document.getElementById("count-marcas").textContent = `(${pf.marcas.length})`;
  document.getElementById("tabela-marcas").querySelector("tbody").innerHTML = pf.marcas.map((m) => `
    <tr>
      <td>${escapeHtml(m.registro)}</td>
      <td>${escapeHtml(m.nome)}</td>
      <td>${escapeHtml(m.apresentacao)}</td>
      <td>${escapeHtml(m.deposito)}</td>
      <td>${escapeHtml(m.concessao)}</td>
    </tr>`).join("");
}

function renderPatentesTable(patentes) {
  document.getElementById("tabela-patentes").querySelector("tbody").innerHTML = patentes.map((p) => `
    <tr>
      <td>${escapeHtml(p.numero)}</td>
      <td>${escapeHtml(p.titulo)}</td>
      <td>${escapeHtml(p.trl)}</td>
      <td>${escapeHtml(p.parceria)}</td>
      <td>${escapeHtml(p.campo)}</td>
    </tr>`).join("");
}

/* =========================================================================
   Eventos
   ========================================================================= */

function wireTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
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

  const toggle = document.getElementById("semantic-toggle");
  toggle.addEventListener("click", async () => {
    state.semantic.on = !state.semantic.on;
    toggle.setAttribute("aria-pressed", String(state.semantic.on));
    toggle.textContent = `Busca semântica: ${state.semantic.on ? "ligada" : "desligada"}`;
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
      normalize(`${p.numero} ${p.titulo} ${p.campo} ${p.parceria}`).includes(term)
    );
    renderPatentesTable(filtered);
    document.getElementById("count-patentes").textContent = `(${filtered.length})`;
  });
}

/* =========================================================================
   Inicialização
   ========================================================================= */

async function init() {
  await loadData();
  populateFilterOptions();
  wireTabs();
  wireDocentesControls();
  wirePortfolioSearch();
  renderPortfolio();
  await runSearchAndRender();
}

init();
