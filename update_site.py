#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
update_site.py — Atualiza o branch gh-pages com:
  1. Cópia de utilities/ → site/utilities/  (com injeção de nav badge)
  2. Injeção de metadados (SEO, Acessibilidade, HTTPS, CSS vars)
  3. Geração de site/search_index.json       (corpus BM25)
  4. Geração de site/main.html               (índice premium com Okapi BM25)
  5. Commit e push automático para gh-pages (opcional)

Autor: Rafael Passos Domingues (Refatorado para Python em 2026-06-27)
"""

import os
import sys
import re
import json
import shutil
import hashlib
import argparse
import subprocess
from datetime import datetime
from pathlib import Path

# Configurações globais padrão
BRANCH = "gh-pages"
SITE_URL = "https://passosdomingues.github.io/webappshowcase/site/main.html"
BASE_URL = SITE_URL.rsplit('/', 1)[0]  # → https://passosdomingues.github.io/webappshowcase/site

# Cores para terminal
COLOR_INFO = "\033[92m"     # Verde
COLOR_WARN = "\033[93m"     # Amarelo
COLOR_ERROR = "\033[91m"    # Vermelho
COLOR_SUCCESS = "\033[96m"  # Ciano
COLOR_RESET = "\033[0m"

# Argumentos globais (preenchidos no main)
args = None


def log(level, message):
    if args and args.quiet and level == "INFO":
        return
    
    timestamp = datetime.now().strftime("%H:%M:%S")
    if level == "INFO":
        color, sym = COLOR_INFO, "ℹ "
    elif level == "WARN":
        color, sym = COLOR_WARN, "⚠ "
    elif level == "ERROR":
        color, sym = COLOR_ERROR, "✖ "
    elif level == "SUCCESS":
        color, sym = COLOR_SUCCESS, "✔ "
    else:
        color, sym = "", "  "

    print(f"{color}[{timestamp}] {sym}{message}{COLOR_RESET}", file=sys.stderr if level == "ERROR" else sys.stdout)


def die(message):
    log("ERROR", message)
    sys.exit(1)


def verificar_dependencias():
    log("INFO", "Verificando dependências...")
    missing = []
    for dep in ["git"]:
        if not shutil.which(dep):
            missing.append(dep)
    if missing:
        die(f"Dependências ausentes: {', '.join(missing)}")
    log("SUCCESS", "Todas as dependências presentes.")


def extract_title(html_content, filepath):
    # 1. <title>...</title>
    title_match = re.search(r'<title>(.*?)</title>', html_content, re.IGNORECASE | re.DOTALL)
    if title_match:
        title = re.sub(r'<[^>]+>', '', title_match.group(1)).strip()
        if title:
            return title
            
    # 2. <meta name="description" content="...">
    desc_match = re.search(r'<meta\s+name=["\']description["\']\s+content=["\'](.*?)["\']', html_content, re.IGNORECASE)
    if desc_match:
        title = desc_match.group(1).strip()
        if title:
            return title

    # 3. <h1>...</h1>
    h1_match = re.search(r'<h1[^>]*>(.*?)</h1>', html_content, re.IGNORECASE | re.DOTALL)
    if h1_match:
        title = re.sub(r'<[^>]+>', '', h1_match.group(1)).strip()
        if title:
            return title

    # 4. Filename title-ized
    name = filepath.stem
    name = re.sub(r'[-_]+', ' ', name)
    return name.title().strip()


def extract_description(html_content):
    # 1. <meta name="description" content="...">
    desc_match = re.search(r'<meta\s+name=["\']description["\']\s+content=["\'](.*?)["\']', html_content, re.IGNORECASE)
    if desc_match:
        desc = desc_match.group(1).strip()
        if desc:
            return desc
            
    # 2. <!-- desc: ... -->
    desc_comment = re.search(r'<!--\s*desc:\s*(.*?)\s*-->', html_content, re.IGNORECASE)
    if desc_comment:
        desc = desc_comment.group(1).strip()
        if desc:
            return desc

    # 3. <p>...</p>
    p_match = re.search(r'<p[^>]*>(.*?)</p>', html_content, re.IGNORECASE | re.DOTALL)
    if p_match:
        desc = re.sub(r'<[^>]+>', '', p_match.group(1)).strip()
        desc = re.sub(r'\s+', ' ', desc)
        if desc:
            if len(desc) >= 120:
                desc = desc[:117] + "…"
            return desc
            
    return "Clique para visualizar este projeto."


def extract_category(html_content, filepath):
    # 1. <meta name="category" content="...">
    cat_match = re.search(r'<meta\s+name=["\']category["\']\s+content=["\'](.*?)["\']', html_content, re.IGNORECASE)
    if cat_match:
        cat = cat_match.group(1).strip()
        if cat:
            return cat
            
    # 2. <!-- category: ... -->
    cat_comment = re.search(r'<!--\s*category:\s*(.*?)\s*-->', html_content, re.IGNORECASE)
    if cat_comment:
        cat = cat_comment.group(1).strip()
        if cat:
            return cat

    # 3. <meta name="keywords" content="..."> (first keyword)
    kw_match = re.search(r'<meta\s+name=["\']keywords["\']\s+content=["\'](.*?)["\']', html_content, re.IGNORECASE)
    if kw_match:
        kws = kw_match.group(1).split(',')
        if kws and kws[0].strip():
            return kws[0].strip()

    # 4. Parent dir name if it's not "utilities"
    parent_name = filepath.parent.name
    if parent_name and parent_name not in ["utilities", "site"]:
        return parent_name.replace('_', ' ').replace('-', ' ').title()

    return "Outros"


def extract_body_text(html_content):
    truncated = html_content[:50000]
    truncated = re.sub(r'<script[^>]*>.*?</script>', '', truncated, flags=re.IGNORECASE | re.DOTALL)
    truncated = re.sub(r'<style[^>]*>.*?</style>', '', truncated, flags=re.IGNORECASE | re.DOTALL)
    truncated = re.sub(r'<[^>]+>', '', truncated)
    truncated = re.sub(r'\s+', ' ', truncated).strip()
    return truncated[:2000]


def get_file_hash(filepath):
    h = hashlib.sha512()
    try:
        with open(filepath, 'rb') as f:
            while chunk := f.read(8192):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""


def get_file_size_human(filepath):
    try:
        size = filepath.stat().st_size
        if size < 1024:
            return f"{size}B"
        elif size < 1048576:
            return f"{size // 1024}KB"
        else:
            return f"{size // 1048576}MB"
    except Exception:
        return "0B"


def get_file_mtime_human(filepath):
    try:
        mtime = filepath.stat().st_mtime
        return datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M')
    except Exception:
        return "N/A"


def choose_icon(filename, category):
    key = f"{filename} {category}".lower()
    if "barber" in key: return "💈"
    if "blueparking" in key or "parking" in key: return "🅿️"
    if any(x in key for x in ["pdf", "buscacontexto", "document"]): return "🔎📄"
    if any(x in key for x in ["bushour", "onibus", "bus", "hora"]): return "🔎🚌"
    if any(x in key for x in ["comanda", "espetinho"]): return "🍢"
    if "denta" in key: return "🦷"
    if any(x in key for x in ["doctor", "cras", "nurse"]): return "🩺"
    if any(x in key for x in ["dog", "dogguest"]): return "🐶"
    if any(x in key for x in ["pawgel", "patas"]): return "🐾🪽"
    if any(x in key for x in ["fit", "fitness", "motivation"]): return "🏋️"
    if "encomend" in key: return "🍞🧀"
    if any(x in key for x in ["meet", "motions", "evento"]): return "🎤"
    if "motoboy" in key: return "🛵"
    if "peregrin" in key: return "🗺️🚴"
    if any(x in key for x in ["pedreiro", "construc"]): return "🧱"
    if any(x in key for x in ["supermercado", "compras", "mercado", "planejamercado", "confere"]): return "🛒"
    if any(x in key for x in ["plant", "agricultura"]): return "🛰️🌱"
    if any(x in key for x in ["qr", "pix"]): return "🔒🔳"
    if any(x in key for x in ["revisao", "carro", "auto", "veiculo"]): return "🔎🚗"
    if any(x in key for x in ["ronda", "seguranca"]): return "👮📝"
    if "marmit" in key: return "🍱"
    if any(x in key for x in ["radio", "retro"]): return "📻"
    if "dengue" in key: return "🦟"
    if any(x in key for x in ["invest", "financ", "startup"]): return "📈"
    if any(x in key for x in ["algoritmo", "genoma", "ciencia"]): return "🧬"
    if any(x in key for x in ["orbita", "estrela", "via.lactea"]): return "⭐🌌"
    if any(x in key for x in ["braille", "touch"]): return "👆♿"
    if any(x in key for x in ["persona", "llm", "ai", "ia"]): return "🤖"
    if any(x in key for x in ["3d", "cnc", "escultor", "sculpt"]): return "🖨️"
    if any(x in key for x in ["git", "command", "dev", "horizon"]): return "💻"
    if "teleprompter" in key: return "🎬"
    if any(x in key for x in ["prevmax", "maturit", "plano"]): return "📋"
    if any(x in key for x in ["oraculo", "cerne"]): return "🏛️🤖"
    if any(x in key for x in ["juris", "juridico"]): return "⚖️"
    if any(x in key for x in ["imposto", "renda", "guia"]): return "🧾"
    if any(x in key for x in ["innova", "lens"]): return "🔭"
    if "radar" in key: return "📡🚨"
    if any(x in key for x in ["geracconvite", "convite"]): return "🎉"
    if any(x in key for x in ["horario", "ensino"]): return "📅"
    if "essence" in key: return "💎"
    return "🧑‍💻"


def run_git(args_list, cwd=None, capture=False):
    res = subprocess.run(args_list, cwd=cwd, text=True, capture_output=capture)
    if res.returncode != 0:
        err = res.stderr if capture else f"exit code {res.returncode}"
        raise RuntimeError(f"Git command {' '.join(args_list)} failed: {err}")
    return res.stdout if capture else None


def build_site(repo_path):
    src_dir = repo_path / "utilities"
    dest_dir = repo_path / "site"
    util_dir = dest_dir / "utilities"
    
    log("INFO", "Recriando pasta 'site'...")
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    util_dir.mkdir(parents=True, exist_ok=True)
    log("SUCCESS", "Pasta 'site' preparada.")

    # 1. Copiar utilities/ para site/utilities/
    log("INFO", f"Copiando '{src_dir}' → '{util_dir}'...")
    if not src_dir.exists():
        die(f"Diretório fonte '{src_dir}' não encontrado.")
    
    # Copiar todos os arquivos mantendo estrutura
    for item in src_dir.rglob("*"):
        if item.is_file():
            rel_path = item.relative_to(src_dir)
            dest_file = util_dir / rel_path
            dest_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, dest_file)
    log("SUCCESS", "Cópia concluída.")

    # 2. Injetar nav badge e aplicar melhorias nos HTMLs copiados
    log("INFO", "Injetando nav badges e melhorando metadados batch...")
    
    badge_style = '<style>.ag-nav-back{position:fixed;top:12px;left:12px;z-index:9999;background:rgba(79,70,229,.9);color:#fff;border:none;border-radius:50px;padding:.4rem .9rem;font-size:.8rem;font-family:system-ui,sans-serif;font-weight:600;cursor:pointer;text-decoration:none;display:flex;align-items:center;gap:.35rem;box-shadow:0 2px 10px rgba(0,0,0,.25);backdrop-filter:blur(4px);transition:background .2s,transform .2s}.ag-nav-back:hover{background:rgba(55,48,163,.95);transform:translateY(-1px)}</style>'
    badge_html = f'<a href="{BASE_URL}/main.html" class="ag-nav-back" aria-label="Voltar ao índice">&#8592; Índice</a>'
    inject = f"{badge_style}{badge_html}"

    fixed_meta = 0
    fixed_noopener = 0
    fixed_cssvars = 0
    badge_count = 0

    for file_path in util_dir.rglob("*.html"):
        if file_path.name == "main.html":
            continue

        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            changed = False

            # Injetar nav badge antes de </body> ou no final
            body_match = re.search(r'</body>', content, re.IGNORECASE)
            if body_match:
                start, end = body_match.span()
                content = content[:start] + inject + "\n" + content[start:]
            else:
                content = content + f"\n\n{inject}\n"
            badge_count += 1
            changed = True

            # SEO: Meta description se ausente
            if not re.search(r'<meta\s+name=["\']description["\']', content, re.IGNORECASE):
                desc = extract_description(content)
                meta_tag = f'\n  <meta name="description" content="{desc}"/>'
                
                # Injetar após viewport ou charset
                m_viewport = re.search(r'(<meta\s+name=["\']viewport["\'][^>]*>)', content, re.IGNORECASE)
                if m_viewport:
                    _, end = m_viewport.span()
                    content = content[:end] + meta_tag + content[end:]
                    fixed_meta += 1
                else:
                    m_charset = re.search(r'(<meta\s+charset[^>]*>)', content, re.IGNORECASE)
                    if m_charset:
                        _, end = m_charset.span()
                        content = content[:end] + meta_tag + content[end:]
                        fixed_meta += 1
                    else:
                        m_head = re.search(r'<head[^>]*>', content, re.IGNORECASE)
                        if m_head:
                            _, end = m_head.span()
                            content = content[:end] + meta_tag + content[end:]
                            fixed_meta += 1

            # Acessibilidade / Segurança: target="_blank" sem rel="noopener"
            # Vamos substituir links de forma precisa
            def link_replacer(match):
                nonlocal fixed_noopener, changed
                tag = match.group(0)
                if re.search(r'target=["\']_blank["\']', tag, re.IGNORECASE):
                    if not re.search(r'rel=["\']noopener', tag, re.IGNORECASE):
                        fixed_noopener += 1
                        changed = True
                        if tag.endswith('/>'):
                            return tag[:-2] + ' rel="noopener noreferrer"/>'
                        else:
                            return tag[:-1] + ' rel="noopener noreferrer">'
                return tag

            new_content = re.sub(r'<a\b[^>]*>', link_replacer, content, flags=re.IGNORECASE)
            if new_content != content:
                content = new_content
                changed = True

            # CSS vars fallback no :root se ausente e tiver <style>
            if ':root' not in content and '<style' in content:
                root_css = '\n  :root{--primary:#4f46e5;--accent:#f59e0b;--bg:#f1f5f9;--surface:#fff;--text:#1e293b;--text-2:#64748b;--border:#e2e8f0;font-family:system-ui,sans-serif}'
                m_style = re.search(r'(<style[^>]*>)', content, re.IGNORECASE)
                if m_style:
                    _, end = m_style.span()
                    content = content[:end] + root_css + content[end:]
                    fixed_cssvars += 1
                    changed = True

            # Forçar HTTPS em links comuns de CDN/fonts
            replacements = {
                'http://fonts.googleapis.com': 'https://fonts.googleapis.com',
                'http://fonts.gstatic.com': 'https://fonts.gstatic.com',
                'http://cdnjs.cloudflare.com': 'https://cdnjs.cloudflare.com',
                'http://cdn.jsdelivr.net': 'https://cdn.jsdelivr.net'
            }
            for http_url, https_url in replacements.items():
                if http_url in content:
                    content = content.replace(http_url, https_url)
                    changed = True

            if changed:
                with open(file_path, "w", encoding="utf-8") as f:
                    f.write(content)

        except Exception as e:
            log("WARN", f"Falha ao processar arquivo {file_path.name}: {e}")

    log("SUCCESS", f"Injeção de nav badges concluída em {badge_count} arquivo(s).")
    log("SUCCESS", f"Batch: +{fixed_meta} meta desc | +{fixed_noopener} noopener | +{fixed_cssvars} CSS vars")

    # 3. Gerar site/search_index.json
    log("INFO", "Gerando 'site/search_index.json'...")
    index_file = dest_dir / "search_index.json"
    projects_list = []

    # Encontrar e ordenar todos os HTMLs em site/utilities/
    html_files = sorted(list(util_dir.rglob("*.html")))

    for f_path in html_files:
        if f_path.name == "main.html":
            continue

        try:
            with open(f_path, "r", encoding="utf-8", errors="ignore") as f:
                html_data = f.read()

            rel_path = f_path.relative_to(dest_dir)
            p_id = f_path.stem
            title = extract_title(html_data, f_path)
            desc = extract_description(html_data)
            cat = extract_category(html_data, f_path)
            body = extract_body_text(html_data)
            href = f"{BASE_URL}/{rel_path.as_posix()}"
            sha_full = get_file_hash(f_path)
            sha_short = sha_full[:16]
            size_hum = get_file_size_human(f_path)

            projects_list.append({
                "id": p_id,
                "title": title,
                "description": desc,
                "category": cat,
                "path": href,
                "bodyText": body,
                "sha512": sha_full,
                "sha512Short": sha_short,
                "size": size_hum
            })
        except Exception as e:
            log("WARN", f"Falha ao indexar {f_path.name}: {e}")

    try:
        with open(index_file, "w", encoding="utf-8") as f:
            json.dump(projects_list, f, ensure_ascii=False, indent=2)
        log("SUCCESS", "'site/search_index.json' gerado com sucesso.")
    except Exception as e:
        die(f"Erro ao salvar arquivo de índice JSON: {e}")

    # 4. Gerar site/main.html (com BM25 inline)
    log("INFO", "Gerando 'site/main.html'...")
    main_file = dest_dir / "main.html"

    # Preparar a lista compactada dos projetos para inserir diretamente no Javascript
    projects_js_list = []
    for f_path in html_files:
        if f_path.name == "main.html":
            continue

        try:
            with open(f_path, "r", encoding="utf-8", errors="ignore") as f:
                html_data = f.read()

            rel_path = f_path.relative_to(dest_dir)
            p_id = f_path.stem
            title = extract_title(html_data, f_path)
            desc = extract_description(html_data)
            cat = extract_category(html_data, f_path)
            icon = choose_icon(rel_path.as_posix(), cat)
            lastmod = get_file_mtime_human(f_path)
            mtime = int(f_path.stat().st_mtime)
            href = f"{BASE_URL}/{rel_path.as_posix()}"
            sha_full = get_file_hash(f_path)
            sha_short = sha_full[:16]
            size_hum = get_file_size_human(f_path)

            projects_js_list.append({
                "id": p_id,
                "title": title,
                "description": desc,
                "category": cat,
                "icon": icon,
                "path": href,
                "lastModified": lastmod,
                "mtime": mtime,
                "sha512Short": sha_short,
                "sha512": sha_full,
                "size": size_hum
            })
        except Exception as e:
            log("WARN", f"Falha ao adicionar projeto no index HTML: {e}")

    # Escrever site/main.html usando template
    try:
        with open(main_file, "w", encoding="utf-8") as f:
            # Cabeçalho HTML + CSS
            f.write("""<!DOCTYPE html>
<html lang="pt-BR" data-theme="light">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="description" content="Coleção de utilitários e projetos HTML interativos — Rafael Passos Domingues"/>
  <meta name="author" content="Rafael Passos Domingues"/>
  <meta name="theme-color" content="#4f46e5"/>
  <title>Simple Utility App Suite</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root{
      --primary:#4f46e5;--primary-dark:#3730a3;--primary-light:#e0e7ff;
      --accent:#f59e0b;--bg:#f1f5f9;--surface:#fff;--surface-2:#f8fafc;
      --border:#e2e8f0;--text:#1e293b;--text-2:#64748b;
      --shadow-sm:0 1px 3px rgba(0,0,0,.08);
      --shadow-md:0 4px 14px rgba(0,0,0,.10);
      --shadow-lg:0 10px 32px rgba(0,0,0,.13);
      --radius-sm:8px;--radius-md:14px;--radius-lg:20px;
      --transition:.25s ease;
      --font:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    [data-theme=dark]{
      --primary:#818cf8;--primary-dark:#6366f1;--primary-light:#1e1b4b;
      --accent:#fbbf24;--bg:#0f172a;--surface:#1e293b;--surface-2:#162032;
      --border:#334155;--text:#e2e8f0;--text-2:#94a3b8;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html{scroll-behavior:smooth}
    body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;transition:background var(--transition),color var(--transition)}

    /* Header */
    header{background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:#fff;padding:2.2rem 1.5rem 3.2rem;text-align:center;position:relative}
    h1{font-size:clamp(1.6rem,4vw,2.6rem);font-weight:800;letter-spacing:-.03em;margin-bottom:.35rem}
    .subtitle{color:rgba(255,255,255,.82);font-size:1rem}
    .header-controls{position:absolute;top:1rem;right:1.25rem;display:flex;gap:.5rem}
    .icon-btn{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:50%;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.95rem;transition:background var(--transition)}
    .icon-btn:hover{background:rgba(255,255,255,.28)}

    /* Controls card */
    .controls{max-width:1100px;margin:-1.6rem auto 0;padding:1rem 1.25rem;background:var(--surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-md);border:1px solid var(--border);display:flex;gap:.75rem;flex-wrap:wrap;position:relative;z-index:10}
    .search-wrap{position:relative;flex:1;min-width:200px}
    .search-wrap input{width:100%;padding:.65rem 2.2rem .65rem 2.5rem;border:1.5px solid var(--border);border-radius:50px;font-size:.95rem;font-family:var(--font);background:var(--surface-2);color:var(--text);transition:border-color var(--transition),box-shadow var(--transition)}
    .search-wrap input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
    .search-icon{position:absolute;left:.85rem;top:50%;transform:translateY(-50%);color:var(--text-2);font-size:.9rem;pointer-events:none}
    .clear-btn{position:absolute;right:.75rem;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-2);cursor:pointer;display:none;font-size:.85rem}
    .search-wrap input:not(:placeholder-shown)~.clear-btn{display:block}
    select{padding:.65rem 1rem;border:1.5px solid var(--border);border-radius:50px;font-size:.9rem;font-family:var(--font);background:var(--surface-2);color:var(--text);cursor:pointer;transition:border-color var(--transition)}
    select:focus{outline:none;border-color:var(--primary)}

    /* Stats bar */
    .stats-bar{max-width:1100px;margin:.9rem auto .2rem;padding:0 1.25rem;display:flex;align-items:center;justify-content:space-between;font-size:.83rem;color:var(--text-2);gap:.5rem;flex-wrap:wrap}
    .bm25-badge{background:var(--primary-light);color:var(--primary);font-weight:600;padding:.15rem .55rem;border-radius:50px;font-size:.75rem}

    /* Container */
    .container{max-width:1100px;margin:0 auto;padding:1.2rem 1.25rem 3rem;flex:1}

    /* Category section */
    .category-section{margin-bottom:2.5rem}
    .category-title{font-size:1.1rem;font-weight:700;color:var(--text);margin:0 0 1rem;padding-bottom:.5rem;border-bottom:2px solid var(--primary);display:flex;align-items:center;gap:.5rem}
    .cat-count{background:var(--primary-light);color:var(--primary);font-size:.75rem;font-weight:600;padding:.15rem .5rem;border-radius:50px}

    /* Grid */
    .cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:1.1rem}

    /* Card */
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);text-decoration:none;color:var(--text);display:flex;flex-direction:column;transition:transform var(--transition),box-shadow var(--transition),border-color var(--transition);overflow:hidden}
    .card:hover,.card:focus{transform:translateY(-4px);box-shadow:var(--shadow-lg);border-color:var(--primary);outline:none}
    .card:focus-visible{outline:3px solid var(--primary);outline-offset:2px}
    .card-header{padding:1.1rem 1.1rem .6rem;display:flex;align-items:center;gap:.65rem}
    .card-icon{font-size:2rem;user-select:none;line-height:1}
    .card-title{font-weight:700;font-size:.97rem;color:var(--text);line-height:1.3}
    .card-body{padding:.1rem 1.1rem 1.1rem;flex:1;display:flex;flex-direction:column;gap:.5rem}
    .card-desc{font-size:.83rem;color:var(--text-2);line-height:1.4;flex:1}
    mark{background:#fef08a;color:#713f12;border-radius:2px;padding:0 1px}
    [data-theme=dark] mark{background:#854d0e;color:#fef08a}
    .card-meta{display:flex;align-items:center;justify-content:space-between;gap:.4rem;flex-wrap:wrap}
    .card-cat{background:var(--primary-light);color:var(--primary);padding:.18rem .55rem;border-radius:50px;font-weight:600;font-size:.73rem;white-space:nowrap}
    .card-date{font-size:.72rem;color:var(--text-2)}
    .score-bar{height:3px;border-radius:2px;background:linear-gradient(90deg,var(--primary),var(--accent));opacity:.7;margin-top:.3rem;transition:width .3s}

    /* SHA-512 fingerprint badge */
    .card-fingerprint{
      display:flex;align-items:center;gap:.3rem;
      font-size:.68rem;color:var(--text-2);
      font-family:'Courier New',monospace;
      background:var(--surface-2);border:1px solid var(--border);
      border-radius:6px;padding:.15rem .45rem;
      cursor:pointer;transition:background var(--transition),color var(--transition);
      user-select:none;
    }
    .card-fingerprint:hover{background:var(--primary-light);color:var(--primary)}
    .card-fingerprint .fp-icon{font-size:.75rem;flex-shrink:0}
    .card-size{font-size:.69rem;color:var(--text-2);font-weight:500}

    /* Pill tabs for categories */
    .pill-tabs{max-width:1100px;margin:.6rem auto .1rem;padding:0 1.25rem;
      display:flex;gap:.4rem;flex-wrap:wrap;overflow-x:auto}
    .pill{background:var(--surface);border:1.5px solid var(--border);color:var(--text-2);
      padding:.3rem .8rem;border-radius:50px;font-size:.78rem;font-weight:600;
      cursor:pointer;transition:all var(--transition);white-space:nowrap;flex-shrink:0}
    .pill:hover{border-color:var(--primary);color:var(--primary)}
    .pill.active{background:var(--primary);border-color:var(--primary);color:#fff}

    /* Hover glow per card */
    .card:hover{box-shadow:0 8px 32px rgba(79,70,229,.18),var(--shadow-lg)}

    /* No results */
    .no-results{text-align:center;padding:4rem 1rem;color:var(--text-2)}
    .no-results svg{margin-bottom:1rem;opacity:.35}

    /* Back to top */
    #btt{position:fixed;bottom:1.75rem;right:1.75rem;width:48px;height:48px;border-radius:50%;background:var(--primary);color:#fff;border:none;cursor:pointer;font-size:1.3rem;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-md);opacity:0;visibility:hidden;transition:all var(--transition)}
    #btt.show{opacity:1;visibility:visible}
    #btt:hover{background:var(--primary-dark);transform:translateY(-3px)}

    /* Footer */
    footer{background:var(--surface);border-top:1px solid var(--border);text-align:center;padding:1.25rem;font-size:.82rem;color:var(--text-2)}
    footer a{color:var(--primary);text-decoration:none}

    /* SR-only */
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

    @media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
    @media(max-width:640px){
      header{padding:1.75rem 1rem 2.8rem}
      .controls{flex-direction:column}
      .header-controls{top:.75rem;right:.75rem}
    }
  </style>
</head>
<body>
<header>
  <div class="header-controls">
    <button class="icon-btn" id="darkToggle" aria-pressed="false" aria-label="Alternar modo escuro">🌙</button>
  </div>
  <h1>🚀 Simple Utility App Suite</h1>
  <p class="subtitle">Vitrine tecnológica de Rafael Passos Domingues</p>
  <div class="hero-stats" id="heroStats" style="display:flex;gap:1.8rem;justify-content:center;margin-top:1.1rem;flex-wrap:wrap">
    <div style="text-align:center">
      <div style="font-size:1.8rem;font-weight:800" id="countProjects">—</div>
      <div style="font-size:.78rem;opacity:.8">projetos</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:1.8rem;font-weight:800" id="countCategories">—</div>
      <div style="font-size:.78rem;opacity:.8">categorias</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:1.8rem;font-weight:800" id="buildDate">—</div>
      <div style="font-size:.78rem;opacity:.8">build</div>
    </div>
  </div>
</header>

<div class="controls">
  <div class="search-wrap" role="search">
    <span class="search-icon" aria-hidden="true">🔍</span>
    <input type="search" id="searchInput" placeholder="Buscar projetos… (Okapi BM25)" aria-label="Buscar projetos">
    <button class="clear-btn" id="clearSearch" aria-label="Limpar busca">✕</button>
  </div>
  <select id="sortSelect" aria-label="Ordenar por">
    <option value="relevance">Relevância BM25</option>
    <option value="date">Data de modificação</option>
    <option value="name">Nome A→Z</option>
    <option value="size">Tamanho</option>
  </select>
</div>

<div class="pill-tabs" id="pillTabs" role="tablist" aria-label="Filtrar por categoria">
  <button class="pill active" data-cat="" role="tab" aria-selected="true">Todos</button>
</div>

<div class="stats-bar" id="statsBar" aria-live="polite">
  <span id="statsText"></span>
  <span class="bm25-badge">Okapi BM25</span>
</div>

<main class="container" id="projectsContainer" aria-label="Projetos"></main>

<button id="btt" aria-label="Voltar ao topo" title="Voltar ao topo">↑</button>

<footer>
  <p>© 2026 <a href="https://github.com/passosdomingues" target="_blank" rel="noopener">Rafael Passos Domingues</a> — Simple Utility App Suite</p>
</footer>

<script>
""")
            # Injetar BASE_URL e array projects formatado
            f.write(f"  const BASE_URL = '{BASE_URL}';\n")
            f.write("  const projects = ")
            json.dump(projects_js_list, f, ensure_ascii=False, indent=2)
            f.write(";\n\n")

            # Javascript BM25 + UI
            f.write(r"""  /* ── BM25 ENGINE ─────────────────────────────────────────── */
  const BM25 = (() => {
    const K1 = 1.5, B = 0.75;
    const SW = new Set("de a o que e do da em um para com uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha foram essa num nem suas meu às minha têm numa pelos pelas este del te lo".split(" "));

    function tok(t) {
      return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
        .replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w => w.length > 2 && !SW.has(w));
    }

    const N = projects.length;
    const tfs = [], lens = [];
    const df = {};

    projects.forEach((p, i) => {
      const tokens = tok([p.title, p.description, p.category].join(" "));
      lens.push(tokens.length);
      const freq = {};
      tokens.forEach(w => { freq[w] = (freq[w]||0)+1; });
      tfs.push(freq);
      Object.keys(freq).forEach(w => { df[w] = (df[w]||0)+1; });
    });
    const avgdl = lens.reduce((a,b)=>a+b,0) / N;

    function score(qTokens, i) {
      let s = 0;
      const freq = tfs[i], dl = lens[i];
      qTokens.forEach(w => {
        if (!freq[w]) return;
        const idf = Math.log((N-(df[w]||0)+0.5)/((df[w]||0)+0.5)+1);
        const tf = freq[w]*(K1+1)/(freq[w]+K1*(1-B+B*dl/avgdl));
        s += idf * tf;
      });
      return s;
    }

    function search(query) {
      const qt = tok(query);
      if (!qt.length) return projects.map((p,i)=>({...p,score:0,idx:i}));
      return projects
        .map((p,i) => ({...p, score: score(qt,i), idx:i}))
        .filter(r => r.score > 0)
        .sort((a,b) => b.score - a.score);
    }

    return { search, tok };
  })();

  /* ── HIGHLIGHT ────────────────────────────────────────────── */
  function hl(text, tokens) {
    if (!tokens.length) return text;
    const re = new RegExp(`(${tokens.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})`, "gi");
    return text.replace(re,"<mark>$1</mark>");
  }

  /* ── INIT ────────────────────────────────────────────────── */
  const allCats = [...new Set(projects.map(p=>p.category))].sort();
  const pillTabs = document.getElementById("pillTabs");
  let activeCat = "";

  allCats.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "pill";
    btn.dataset.cat = c;
    btn.setAttribute("role","tab");
    btn.setAttribute("aria-selected","false");
    btn.textContent = c;
    pillTabs.appendChild(btn);
  });

  pillTabs.addEventListener("click", e => {
    const pill = e.target.closest(".pill");
    if (!pill) return;
    activeCat = pill.dataset.cat;
    pillTabs.querySelectorAll(".pill").forEach(p => {
      p.classList.toggle("active", p.dataset.cat === activeCat);
      p.setAttribute("aria-selected", String(p.dataset.cat === activeCat));
    });
    render(allResults);
  });

  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("clearSearch");
  const sortSelect = document.getElementById("sortSelect");
  const container = document.getElementById("projectsContainer");
  const statsText = document.getElementById("statsText");
  const btt = document.getElementById("btt");
  const darkToggle = document.getElementById("darkToggle");

  function applyTheme() {
    const dark = localStorage.getItem("agDark") === "1";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    darkToggle.textContent = dark ? "☀️" : "🌙";
    darkToggle.setAttribute("aria-pressed", String(dark));
    darkToggle.setAttribute("aria-label", dark ? "Alternar para modo claro" : "Alternar para modo escuro");
  }
  applyTheme();
  darkToggle.addEventListener("click", () => {
    localStorage.setItem("agDark", document.documentElement.getAttribute("data-theme")==="dark" ? "0" : "1");
    applyTheme();
  });

  /* Hero stats */
  document.getElementById("countProjects").textContent = projects.length;
  document.getElementById("countCategories").textContent = allCats.length;
  document.getElementById("buildDate").textContent = new Date().toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});

  function maxScore(results) { return results.reduce((m,r)=>Math.max(m,r.score),0)||1; }

  function render(results) {
    container.innerHTML = "";
    const query = searchInput.value.trim();
    const qTokens = query.length >= 2 ? BM25.tok(query) : [];
    const sort = sortSelect.value;

    let filtered = activeCat ? results.filter(r=>r.category===activeCat) : results;

    if (sort === "date")  filtered = [...filtered].sort((a,b) => b.mtime - a.mtime);
    else if (sort === "name") filtered = [...filtered].sort((a,b) => a.title.localeCompare(b.title));
    else if (sort === "size") filtered = [...filtered].sort((a,b) => {
      const parseSize = s => { if(!s) return 0; const n=parseInt(s); return s.includes("MB")?n*1e6:s.includes("KB")?n*1e3:n; };
      return parseSize(b.size) - parseSize(a.size);
    });

    statsText.textContent = `${filtered.length} de ${projects.length} projetos • ${allCats.length} categorias${query ? ` • busca: "${query}"` : ""}`;

    if (!filtered.length) {
      container.innerHTML = `<div class="no-results">
        <svg width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <p>Nenhum projeto encontrado para <strong>"${query}"</strong>.</p>
        <p style="font-size:.85rem;margin-top:.5rem">Tente outros termos ou limpe a busca.</p>
      </div>`;
      return;
    }

    const maxS = query ? maxScore(filtered) : 1;
    const byCategory = {};
    filtered.forEach(p => { (byCategory[p.category]??=[]).push(p); });

    Object.keys(byCategory).sort().forEach(cat => {
      const sec = document.createElement("section");
      sec.className = "category-section";
      const h2 = document.createElement("h2");
      h2.className = "category-title";
      h2.innerHTML = `${cat}<span class="cat-count">${byCategory[cat].length}</span>`;
      sec.appendChild(h2);
      const grid = document.createElement("div");
      grid.className = "cards-grid";

      byCategory[cat].forEach(proj => {
        const a = document.createElement("a");
        a.className = "card";
        a.href = proj.path;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", `${proj.title} — abre em nova aba`);
        a.setAttribute("data-id", proj.id);

        const hlTitle = hl(proj.title, qTokens);
        const hlDesc  = hl(proj.description, qTokens);
        const scoreWidth = query && proj.score > 0 ? Math.round((proj.score/maxS)*100) : 0;
        const sha = proj.sha512Short || "";
        const size = proj.size || "";

        a.innerHTML = `
          <div class="card-header">
            <div class="card-icon" aria-hidden="true">${proj.icon}</div>
            <div class="card-title">${hlTitle}</div>
          </div>
          <div class="card-body">
            <div class="card-desc">${hlDesc}</div>
            ${scoreWidth > 0 ? `<div class="score-bar" style="width:${scoreWidth}%" title="Relevância BM25: ${proj.score.toFixed(2)}"></div>` : ""}
            <div class="card-meta">
              <span class="card-cat">${proj.category}</span>
              <span class="card-size">${size}</span>
              <span class="card-date">${proj.lastModified}</span>
            </div>
            ${sha ? `<button class="card-fingerprint" title="SHA-512: ${proj.sha512||sha}\nClique para copiar" onclick="event.preventDefault();navigator.clipboard&&navigator.clipboard.writeText('${proj.sha512||sha}').then(()=>{this.textContent='\\u2714 copiado!';setTimeout(()=>{this.innerHTML='<span class=fp-icon>\\uD83D\\uDD0F</span>${sha}'},1200)})" aria-label="Copiar SHA-512"><span class=fp-icon>\\uD83D\\uDD0F</span>${sha}</button>` : ""}
          </div>`;
        grid.appendChild(a);
      });

      sec.appendChild(grid);
      container.appendChild(sec);
    });
  }

  let allResults = projects.map((p,i) => ({...p, score:0, idx:i}));
  render(allResults);

  let debounce;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const q = searchInput.value.trim();
      allResults = q.length >= 2 ? BM25.search(q) : projects.map((p,i)=>({...p,score:0,idx:i}));
      render(allResults);
    }, 180);
  });

  clearBtn.addEventListener("click", () => { searchInput.value = ""; allResults = projects.map((p,i)=>({...p,score:0,idx:i})); render(allResults); searchInput.focus(); });
  sortSelect.addEventListener("change", () => render(allResults));
  statsText.textContent = `${projects.length} de ${projects.length} projetos \u2022 ${allCats.length} categorias`;

  window.addEventListener("scroll", () => { btt.classList.toggle("show", window.scrollY > 350); });
  btt.addEventListener("click", () => window.scrollTo({top:0,behavior:"smooth"}));

  if (!localStorage.getItem("agDark")) {
    localStorage.setItem("agDark", window.matchMedia("(prefers-color-scheme:dark)").matches ? "1" : "0");
    applyTheme();
  }
</script>
</body>
</html>
""")
        log("SUCCESS", "'site/main.html' gerado com sucesso.")
    except Exception as e:
        die(f"Erro ao salvar arquivo index HTML: {e}")


def executar_deploy(repo_path):
    log("INFO", "Iniciando processo de deploy...")
    
    # 1. Obter branch atual
    current_branch = run_git(["git", "branch", "--show-current"], cwd=repo_path, capture=True).strip()
    log("INFO", f"Branch atual: '{current_branch}'")
    
    # 2. Verificar modificações pendentes no working tree
    status_output = run_git(["git", "status", "--porcelain"], cwd=repo_path, capture=True).strip()
    has_changes = len(status_output) > 0
    
    stashed = False
    try:
        if has_changes:
            log("WARN", "Alterações não commitadas detectadas — fazendo stash automático...")
            run_git(["git", "stash", "push", "-m", "auto-stash antes do deploy do site"], cwd=repo_path)
            stashed = True

        log("INFO", "Buscando atualizações do remoto (fetch)...")
        run_git(["git", "fetch", "origin"], cwd=repo_path)

        # 3. Mudar para a branch de deploy
        log("INFO", f"Fazendo checkout para a branch '{BRANCH}'...")
        # Verificar se a branch gh-pages existe localmente
        branches = run_git(["git", "branch", "--list", BRANCH], cwd=repo_path, capture=True).strip()
        
        if not branches:
            # Tentar criar a partir de origin/gh-pages ou criar órfã
            remote_branches = run_git(["git", "branch", "-r", "--list", f"origin/{BRANCH}"], cwd=repo_path, capture=True).strip()
            if remote_branches:
                log("INFO", f"Criando branch '{BRANCH}' a partir de 'origin/{BRANCH}'...")
                run_git(["git", "checkout", "-b", BRANCH, f"origin/{BRANCH}"], cwd=repo_path)
            else:
                log("WARN", f"Branch '{BRANCH}' não existe no remoto. Criando branch órfã...")
                run_git(["git", "checkout", "--orphan", BRANCH], cwd=repo_path)
                run_git(["git", "rm", "-rf", "."], cwd=repo_path)
                run_git(["git", "commit", "--allow-empty", "-m", f"Inicialização do branch {BRANCH}"], cwd=repo_path)
        else:
            run_git(["git", "checkout", BRANCH], cwd=repo_path)
            # Pull updates
            try:
                run_git(["git", "pull", "--rebase", "--autostash", "origin", BRANCH], cwd=repo_path)
            except Exception as e:
                log("WARN", f"Pull rebase falhou, continuando assim mesmo: {e}")

        # 4. Trazer a pasta utilities de main para a branch gh-pages
        log("INFO", "Atualizando a pasta 'utilities' a partir da branch main...")
        try:
            run_git(["git", "checkout", "main", "--", "utilities/"], cwd=repo_path)
        except Exception as e:
            log("WARN", f"Não foi possível fazer o checkout de utilities da branch main (talvez o repositório seja novo): {e}")

        # 5. Compilar o site na branch gh-pages
        build_site(repo_path)

        # 6. Commitar e fazer push das mudanças
        status_dest = run_git(["git", "status", "--porcelain", "site", "utilities"], cwd=repo_path, capture=True).strip()
        if not status_dest:
            log("SUCCESS", "Nenhuma alteração detectada na compilação do site. Nada a commitar.")
            return

        if args.dry_run:
            log("WARN", "Modo dry-run ativo — commit e push não realizados.")
            print(status_dest)
            return

        log("INFO", "Adicionando arquivos modificados ao Git...")
        run_git(["git", "add", "utilities/", "site/"], cwd=repo_path)
        
        msg = f"Atualiza site — {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        log("INFO", f"Criando commit: '{msg}'")
        run_git(["git", "commit", "-m", msg], cwd=repo_path)

        log("INFO", f"Enviando alterações para origin/{BRANCH}...")
        run_git(["git", "push", "origin", BRANCH], cwd=repo_path)

        log("SUCCESS", "Deploy realizado com sucesso!")
        log("SUCCESS", f"→ {SITE_URL}")

    finally:
        # Retornar para a branch de trabalho original
        log("INFO", f"Retornando para a branch original '{current_branch}'...")
        run_git(["git", "checkout", current_branch], cwd=repo_path)
        
        if stashed:
            log("INFO", "Restaurando alterações locais do stash...")
            try:
                run_git(["git", "stash", "pop"], cwd=repo_path)
            except Exception as e:
                log("WARN", f"Não foi possível fazer stash pop automaticamente (pode haver conflitos): {e}")


def main():
    global args
    parser = argparse.ArgumentParser(description="Compila e gerencia a vitrine WebApp Showcase.")
    parser.add_argument("-q", "--quiet", action="store_true", help="Modo silencioso (suprime mensagens de INFO)")
    parser.add_argument("--dry-run", action="store_true", help="Simula o deploy sem commitar ou enviar")
    
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--no-git", action="store_true", help="Realiza apenas a compilação local (sem comandos Git)")
    group.add_argument("--deploy", action="store_true", help="Executa o deploy automático na branch gh-pages")

    args = parser.parse_args()

    # Identificar diretório raiz do repositório (diretório pai deste script)
    repo_path = Path(__file__).resolve().parent
    
    log("INFO", "═══════════════════════════════════════════")
    log("INFO", f"  update_site.py — vitrine WebApp Showcase")
    log("INFO", "═══════════════════════════════════════════")

    verificar_dependencias()

    if args.deploy:
        executar_deploy(repo_path)
    else:
        # Padrão ou --no-git roda apenas build local
        if not args.no_git:
            log("INFO", "Dica: Use '--deploy' para publicar ou '--no-git' para rodar localmente.")
        build_site(repo_path)

    log("SUCCESS", "Processo concluído com sucesso! 🚀")


if __name__ == "__main__":
    main()
