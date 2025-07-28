#!/bin/bash

################################################################################
# Script para atualizar o branch gh-pages com:
#   1. Cópia de todo o conteúdo de utilities/ para site/utilities/
#   2. Geração de site/main.html contendo um índice responsivo de todos os HTMLs
#      em cards (links para GitHub Pages), com dark mode e acessibilidade habilitados
#   3. Commit e push automático para o GitHub no branch gh-pages
#
# Autor: Rafael Passos Domingues
# Last Update: 2025-06-08
################################################################################

# ------------------------------------------------------------------------------
# Configurações iniciais
# ------------------------------------------------------------------------------
REPO_PATH="$HOME/github/insights"                                    # Caminho local do repositório
SRC_DIR="utilities"                                                   # Diretório fonte contendo HTML/CSS/JS/etc.
DEST_DIR="site"                                                       # Diretório de destino para publicação
UTIL_DIR="$DEST_DIR/utilities"                                        # Subpasta dentro de site/ para copiar utilities/
MAIN_FILE="$DEST_DIR/main.html"                                       # Arquivo índice a ser gerado
BRANCH="gh-pages"                                                     # Branch para publicação

# URL completo do arquivo main.html hospedado no GitHub Pages
SITE_URL="https://rpassosdomingues.github.io/insights/site/main.html"

# CORREÇÃO: BASE_URL deve ser exatamente até “/site”, sem repetir “site” depois
BASE_URL="${SITE_URL%/main.html}"   # → "https://rpassosdomingues.github.io/insights/site"

BACKUP_DIR="$HOME/github/insights_backup_$(date +%Y%m%d_%H%M%S)"      # Diretório para backup

# Configurações de execução
VERBOSE=true      # Modo verboso (true/false)
SKIP_BACKUP=true # Pular backup (true/false)

# ------------------------------------------------------------------------------
# Função: Exibir mensagens de log com cores
# ------------------------------------------------------------------------------
log() {
  local level="$1"
  local message="$2"
  local color=""
  local prefix=""

  if ! $VERBOSE && [ "$level" = "INFO" ]; then
    return 0
  fi

  case "$level" in
    "INFO")
      color="\033[0;32m"  # Verde
      prefix="ℹ️ "
      ;;
    "WARN")
      color="\033[0;33m"  # Amarelo
      prefix="⚠️ "
      ;;
    "ERROR")
      color="\033[0;31m"  # Vermelho
      prefix="❌ "
      ;;
    "SUCCESS")
      color="\033[0;36m"  # Ciano
      prefix="✅ "
      ;;
    *)
      color="\033[0m"
      prefix=""
      ;;
  esac

  echo -e "${color}${prefix}${message}\033[0m"
}

# ------------------------------------------------------------------------------
# Função: Verificar dependências necessárias
# ------------------------------------------------------------------------------
verificar_dependencias() {
  log "INFO" "Verificando dependências necessárias..."

  local deps=("git" "grep" "sed" "find" "rsync")
  local missing=()

  for dep in "${deps[@]}"; do
    if ! command -v "$dep" &> /dev/null; then
      missing+=("$dep")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    log "ERROR" "Dependências não encontradas: ${missing[*]}"
    log "ERROR" "Por favor, instale as dependências faltantes e tente novamente."
    exit 1
  fi

  log "SUCCESS" "Todas as dependências estão instaladas."
}

# ------------------------------------------------------------------------------
# Função: Criar backup do repositório
# ------------------------------------------------------------------------------
criar_backup() {
  if $SKIP_BACKUP; then
    log "WARN" "Backup ignorado conforme configuração."
    return 0
  fi

  log "INFO" "Criando backup do repositório em '$BACKUP_DIR'..."

  if [ -d "$REPO_PATH" ]; then
    mkdir -p "$BACKUP_DIR"
    cp -r "$REPO_PATH/." "$BACKUP_DIR/"

    if [ $? -eq 0 ]; then
      log "SUCCESS" "Backup criado com sucesso em '$BACKUP_DIR'."
    else
      log "ERROR" "Falha ao criar backup. Continuando sem backup..."
    fi
  else
    log "ERROR" "Diretório do repositório não encontrado. Continuando sem backup..."
  fi
}

# ------------------------------------------------------------------------------
# Função: Atualizar branch remoto e local do gh-pages
#
#   - Navega até REPO_PATH
#   - Garante existência de branch gh-pages (cria local se necessário)
#   - Faz checkout e pull --rebase para manter atualizado
# ------------------------------------------------------------------------------
atualizar_branch() {
  log "INFO" "Atualizando branch '$BRANCH'..."
  cd "$REPO_PATH" || { log "ERROR" "Diretório '$REPO_PATH' não encontrado."; exit 1; }

  # Verificar se há alterações não commitadas
  if [ -n "$(git status --porcelain)" ]; then
    log "WARN" "Existem alterações não commitadas no repositório."
    log "WARN" "Salvando alterações com git stash..."
    git stash save "Alterações automáticas antes de atualizar branch $BRANCH"
  fi

  git fetch origin || { log "ERROR" "Falha ao buscar atualizações do repositório remoto."; exit 1; }

  # Se não existir branch local gh-pages, cria a partir do remoto
  if ! git show-ref --quiet refs/heads/"$BRANCH"; then
    if git show-ref --quiet refs/remotes/origin/"$BRANCH"; then
      log "INFO" "Criando branch local '$BRANCH' a partir do remoto..."
      git checkout -b "$BRANCH" origin/"$BRANCH" || {
        log "ERROR" "Falha ao criar branch '$BRANCH' a partir do remoto."
        exit 1
      }
    else
      log "INFO" "Branch '$BRANCH' não existe no remoto. Criando branch órfão..."
      git checkout --orphan "$BRANCH" || {
        log "ERROR" "Falha ao criar branch órfão '$BRANCH'."
        exit 1
      }
      git rm -rf . || log "WARN" "Falha ao limpar diretório de trabalho."
      git commit --allow-empty -m "Inicialização do branch $BRANCH" || {
        log "ERROR" "Falha ao criar commit inicial no branch '$BRANCH'."
        exit 1
      }
    fi
  else
    log "INFO" "Trocando para branch '$BRANCH'..."
    git checkout "$BRANCH" || {
      log "ERROR" "Falha ao trocar para branch '$BRANCH'."
      exit 1
    }

    log "INFO" "Atualizando branch local com remoto..."
    git pull --rebase --autostash origin "$BRANCH" || {
      log "WARN" "Falha ao atualizar branch '$BRANCH'. Tentando resolver conflitos..."
      if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
        log "ERROR" "Conflitos de merge detectados. Resolva manualmente e execute novamente."
        exit 1
      fi
    }
  fi

  log "SUCCESS" "Branch '$BRANCH' atualizado com sucesso."
}

# ------------------------------------------------------------------------------
# Função: Limpar e preparar diretório destino
#
#   - Remove recursivamente DEST_DIR
#   - Recria DEST_DIR e a subpasta UTIL_DIR vazias
# ------------------------------------------------------------------------------
preparar_destino() {
  log "INFO" "Limpando e preparando diretório '$DEST_DIR'..."

  if [ -d "$REPO_PATH/$DEST_DIR" ]; then
    rm -rf "$REPO_PATH/$DEST_DIR" || {
      log "ERROR" "Falha ao remover diretório '$DEST_DIR'."
      exit 1
    }
  fi

  mkdir -p "$REPO_PATH/$UTIL_DIR" || {
    log "ERROR" "Falha ao criar diretório '$UTIL_DIR'."
    exit 1
  }

  log "SUCCESS" "Diretório '$DEST_DIR' preparado com sucesso."
}

# ------------------------------------------------------------------------------
# Função: Copiar tudo de utilities/ para site/utilities/ (preservando subpastas)
#
#   - Copia recursivamente o conteúdo de utilities/ para site/utilities/
# ------------------------------------------------------------------------------
copiar_html() {
  log "INFO" "Copiando conteúdo de '$SRC_DIR/' para '$UTIL_DIR/'..."

  if [ ! -d "$REPO_PATH/$SRC_DIR" ]; then
    log "ERROR" "Diretório fonte '$SRC_DIR' não encontrado."
    exit 1
  fi

  # Usar rsync se disponível para melhor tratamento de links simbólicos e permissões
  if command -v rsync &> /dev/null; then
    rsync -av --progress "$REPO_PATH/$SRC_DIR/" "$REPO_PATH/$UTIL_DIR/" || {
      log "ERROR" "Falha ao copiar arquivos com rsync."
      exit 1
    }
  else
    # Fallback para cp se rsync não estiver disponível
    cp -r "$REPO_PATH/$SRC_DIR/." "$REPO_PATH/$UTIL_DIR/" || {
      log "ERROR" "Falha ao copiar arquivos."
      exit 1
    }
  fi

  # Verificar se a cópia foi bem-sucedida
  if [ ! "$(ls -A "$REPO_PATH/$UTIL_DIR" 2>/dev/null)" ]; then
    log "WARN" "O diretório de destino '$UTIL_DIR' está vazio após a cópia. Verificando diretório fonte..."
    if [ ! "$(ls -A "$REPO_PATH/$SRC_DIR" 2>/dev/null)" ]; then
      log "WARN" "O diretório fonte '$SRC_DIR' também está vazio. Continuando..."
    else
      log "ERROR" "Falha na cópia: diretório fonte tem conteúdo, mas destino está vazio."
      exit 1
    fi
  fi

  log "SUCCESS" "Conteúdo copiado com sucesso para '$UTIL_DIR/'."
}

# ------------------------------------------------------------------------------
# Função: Extrair título de um arquivo HTML com fallback
#
#   1) Conteúdo de <title>…</title>
#   2) meta name="description"
#   3) Primeira tag <h1>…</h1> (com ou sem atributos)
#   4) Nome do arquivo sem extensão (substitui - e _ por espaço + capitaliza)
#
# $1 = caminho completo para o arquivo HTML
# ------------------------------------------------------------------------------
extrair_titulo() {
  local file="$1"
  local titulo

  # 1) Tenta conteúdo dentro de <title>…</title>
  titulo=$(grep -oP '(?<=<title>).*?(?=</title>)' "$file" 2>/dev/null | head -n1)
  if [[ -n "$titulo" ]]; then
    echo "$titulo"
    return
  fi

  # 2) meta name="description"
  titulo=$(grep -oP '(?<=<meta name="description" content=").*?(?=")' "$file" 2>/dev/null | head -n1)
  if [[ -n "$titulo" ]]; then
    echo "$titulo"
    return
  fi

  # 3) Primeira tag <h1>…</h1>
  titulo=$(grep -oP '(?<=<h1>).*?(?=</h1>)' "$file" 2>/dev/null | head -n1)
  if [[ -n "$titulo" ]]; then
    echo "$titulo"
    return
  fi

  # 3.5) Tenta <h1> com atributos
  titulo=$(grep -oP '(?<=<h1[^>]*>).*?(?=</h1>)' "$file" 2>/dev/null | head -n1)
  if [[ -n "$titulo" ]]; then
    # Remover possíveis tags HTML dentro do h1
    titulo=$(echo "$titulo" | sed -E 's/<[^>]+>//g')
    echo "$titulo"
    return
  fi

  # 4) Fallback: nome do arquivo sem extensão, substituindo - e _ por espaço e capitalizando
  local base
  base=$(basename "$file" .html)
  echo "$base" | sed -E 's/[-_]+/ /g' | sed 's/\b(.)/\u\1/g'
}

# ------------------------------------------------------------------------------
# Função: Extrair descrição de um arquivo HTML com fallback
#
#   1) meta name="description"
#   2) comentário especial <!-- desc: … -->
#   3) Primeiro parágrafo <p>…</p>
#   4) Retorna string genérica se nada for encontrado
#
# $1 = caminho completo para o arquivo HTML
# ------------------------------------------------------------------------------
extrair_descricao() {
  local file="$1"
  local desc

  # 1) meta name="description"
  desc=$(grep -oP '(?<=<meta name="description" content=").*?(?=")' "$file" 2>/dev/null | head -n1)
  if [[ -n "$desc" ]]; then
    echo "$desc"
    return
  fi

  # 2) comentário <!-- desc: … -->
  desc=$(grep -oP '(?<=<!-- desc: ).*?(?=-->)' "$file" 2>/dev/null | head -n1)
  if [[ -n "$desc" ]]; then
    echo "$desc"
    return
  fi

  # 3) Primeiro parágrafo <p>
  desc=$(grep -oP '(?<=<p>).*?(?=</p>)' "$file" 2>/dev/null | head -n1)
  if [[ -n "$desc" ]]; then
    # Limpar tags HTML e limitar tamanho
    desc=$(echo "$desc" | sed -E 's/<[^>]+>//g' | cut -c 1-100)
    if [ ${#desc} -eq 100 ]; then
      desc="${desc}..."
    fi
    echo "$desc"
    return
  fi

  # 4) fallback: string genérica
  echo "Clique para visualizar este projeto."
}

# ------------------------------------------------------------------------------
# Função: Extrair categoria do arquivo com base no conteúdo ou caminho
#
#   1) meta name="category" ou meta name="keywords"
#   2) Comentário especial <!-- category: ... -->
#   3) Baseado no diretório pai
#   4) Fallback para "Outros"
#
# $1 = caminho completo para o arquivo HTML
# ------------------------------------------------------------------------------
extrair_categoria() {
  local file="$1"
  local categoria

  # 1) meta name="category"
  categoria=$(grep -oP '(?<=<meta name="category" content=").*?(?=")' "$file" 2>/dev/null | head -n1)
  if [[ -n "$categoria" ]]; then
    echo "$categoria"
    return
  fi

  # 1b) meta name="keywords" (usa primeira keyword como categoria)
  categoria=$(grep -oP '(?<=<meta name="keywords" content=").*?(?=")' "$file" 2>/dev/null | head -n1)
  if [[ -n "$categoria" ]]; then
    echo "$categoria" | cut -d',' -f1 | xargs
    return
  fi

  # 2) Comentário <!-- category: ... -->
  categoria=$(grep -oP '(?<=<!-- category: ).*?(?=-->)' "$file" 2>/dev/null | head -n1)
  if [[ -n "$categoria" ]]; then
    echo "$categoria"
    return
  fi

  # 3) Baseado no diretório pai
  local dir_pai
  dir_pai=$(dirname "$file" | xargs basename)
  if [[ "$dir_pai" != "utilities" ]]; then
    echo "$dir_pai" | sed 's/\b(.)/\u\1/g'
    return
  fi

  # 4) Fallback
  echo "Outros"
}

# ------------------------------------------------------------------------------
# Função: Escolher ícone emoji baseado no nome do arquivo e categoria
#
#   Verifica palavras-chave no caminho relativo e categoria para retornar emoji
#
# $1 = caminho relativo dentro de site/utilities/, ex.: "utilities/exemplo.html"
# $2 = categoria do arquivo
# ------------------------------------------------------------------------------
escolher_icone() {
  local relname="$1"
  local categoria="$2"

  relname=$(echo "$relname $categoria" | tr '[:upper:]' '[:lower:]')

  if [[ "$relname" =~ barber ]]; then
    echo "💈"
  elif [[ "$relname" =~ blueParking ]]; then
    echo "🅿️🚗"
  elif [[ "$relname" =~ pdf|documento|document ]]; then
    echo "🔎📄"
  elif [[ "$relname" =~ busHour|onibus|bus ]]; then
    echo "🔎🚌"
  elif [[ "$relname" =~ comanda|espetinho ]]; then
    echo "🍢"
  elif [[ "$relname" =~ denta ]]; then
    echo "🦷"
  elif [[ "$relname" =~ doctor ]]; then
    echo "🩺"
  elif [[ "$relname" =~ dog|DogGuest|Cães|Hotel ]]; then
    echo "🐶"
  elif [[ "$relname" =~ pawgel|Pawgel|Anjo|Patas ]]; then
    echo "🔎🐾🪽"
  elif [[ "$relname" =~ fit|fitness|motivation ]]; then
    echo "🏋️‍♂️💪"
  elif [[ "$relname" =~ encomenduai ]]; then
    echo "🍞🧀"
  elif [[ "$relname" =~ Tracking|meet|MeetMotions|evento|online ]]; then
    echo "🎤"
  elif [[ "$relname" =~ motoboy ]]; then
    echo "⚠️🛵"
  elif [[ "$relname" =~ nurse ]]; then
    echo "🩹"
  elif [[ "$relname" =~ peregrin ]]; then
    echo "🔎🗺️🚴‍♂️"
  elif [[ "$relname" =~ pedreiro|construcao ]]; then
    echo "🧱"
  elif [[ "$relname" =~ supermercado|compras|mercado ]]; then
    echo "🛒"
  elif [[ "$relname" =~ plant|agricultura ]]; then
    echo "🛰️🌱"
  elif [[ "$relname" =~ qr|pix ]]; then
    echo "🔒🔳"
  elif [[ "$relname" =~ carro|auto|veiculo|inspecao ]]; then
    echo "🔎🚗"
  elif [[ "$relname" =~ ronda|seguranca ]]; then
    echo "⚠️👮‍♂️📝"
  elif [[ "$relname" =~ busca|search|finder|pesquisa ]]; then
    echo "🔍"
  elif [[ "$relname" =~ bot|automation|automacao ]]; then
    echo "🤖"
  elif [[ "$relname" =~ chart|grafico|graph|stats|analytics|analise|dashboard ]]; then
    echo "📊"
  elif [[ "$relname" =~ config|settings|option|preference|configuracao ]]; then
    echo "⚙️"
  elif [[ "$relname" =~ doc|document|text|note|texto|anotacao ]]; then
    echo "📝"
  elif [[ "$relname" =~ code|script|program|codigo|programacao|desenvolvimento ]]; then
    echo "💻"
  elif [[ "$relname" =~ [rR]adio|[rR]etro|music|audio|sound|musica|som ]]; then
    echo "📻"
  elif [[ "$relname" =~ video|movie|clip|filme ]]; then
    echo "🎬"
  elif [[ "$relname" =~ photo|image|picture|img|foto|imagem ]]; then
    echo "🖼️"
  elif [[ "$relname" =~ map|location|gps|mapa|localizacao ]]; then
    echo "🗺️"
  elif [[ "$relname" =~ mail|email|message|chat|mensagem|contato ]]; then
    echo "✉️"
  elif [[ "$relname" =~ calendar|schedule|agenda|calendario ]]; then
    echo "📅"
  elif [[ "$relname" =~ lock|secure|security|password|seguranca|senha ]]; then
    echo "🔒"
  elif [[ "$relname" =~ marmit ]]; then
    echo "🍱"
  elif [[ "$relname" =~ tool|ferramenta|utilitario ]]; then
    echo "🔧"
  elif [[ "$relname" =~ math|matematica|calculo|formula ]]; then
    echo "🧮"
  elif [[ "$relname" =~ [dD]engue|[dD]engueAI ]]; then
     echo "🔎🦟"
  else
    echo "🅿️🚗"
  fi
}

# ------------------------------------------------------------------------------
# Função: Escapar caracteres especiais para uso seguro no HTML (texto e atributos)
#
#   Substitui: & < > " ' pelas entidades HTML correspondentes
# $1 = texto bruto
# ------------------------------------------------------------------------------
escapar_html() {
  local text="$1"
  text="${text//&/&amp;}"
  text="${text//</&lt;}"
  text="${text//>/&gt;}"
  text="${text//\"/&quot;}"
  text="${text//\'/&#39;}"
  echo "$text"
}

# ------------------------------------------------------------------------------
# Função: Gerar hash MD5 do conteúdo do arquivo
#
# $1 = caminho completo para o arquivo
# ------------------------------------------------------------------------------
gerar_hash() {
  local file="$1"
  if command -v md5sum &> /dev/null; then
    md5sum "$file" | cut -d' ' -f1
  elif command -v md5 &> /dev/null; then
    md5 -q "$file"
  else
    # Fallback usando openssl se disponível
    if command -v openssl &> /dev/null; then
      openssl md5 "$file" | awk '{print $2}'
    else
      # Fallback usando stat para modificação se nenhum utilitário de hash estiver disponível
      stat -c %Y "$file"
    fi
  fi
}

# ------------------------------------------------------------------------------
# Função: Gerar o arquivo main.html dentro de site/
#
#   - Escreve o cabeçalho HTML com CSS responsivo
#   - Percorre todos os arquivos HTML em site/utilities/ (exceto main.html)
#   - Para cada arquivo, extrai título, descrição e ícone, e adiciona um card
#   - Usa BASE_URL para construir href absoluto apontando para GitHub Pages
#   - Insere script JavaScript para dark mode com persistência no localStorage
# ------------------------------------------------------------------------------
gerar_main_html() {
  log "INFO" "Gerando arquivo '$MAIN_FILE'..."

  # 1) Cabeçalho HTML e CSS responsivo
  cat > "$REPO_PATH/$MAIN_FILE" << 'EOF'
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Coleção de utilitários e projetos HTML interativos" />
  <meta name="keywords" content="utilitários, ferramentas, projetos, HTML, JavaScript" />
  <meta name="author" content="Rafael Passos Domingues" />
  <meta name="theme-color" content="#1976d2" />
  <title>Simple Utility App Suite</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    /* Reset e variáveis */
    :root {
      --color-primary: #1976d2;
      --color-primary-dark: #0d47a1;
      --color-primary-light: #bbdefb;
      --color-text: #333;
      --color-text-secondary: #555;
      --color-background: #f5f7fa;
      --color-card: #fff;
      --color-card-hover: #e8f0fe;
      --color-border: #e0e0e0;
      --shadow-sm: 0 2px 6px rgba(0,0,0,0.08);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.12);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.15);
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --transition: 0.3s ease;
      --font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
                   Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
    }

    /* Dark mode variables */
    [data-theme="dark"] {
      --color-primary: #90caf9;
      --color-primary-dark: #64b5f6;
      --color-primary-light: #1e3a5f;
      --color-text: #e0e0e0;
      --color-text-secondary: #aaa;
      --color-background: #121212;
      --color-card: #1e1e1e;
      --color-card-hover: #2c2c2c;
      --color-border: #333;
      --shadow-sm: 0 2px 6px rgba(0,0,0,0.3);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.5);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      font-family: var(--font-family);
      background-color: var(--color-background);
      color: var(--color-text);
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      padding: 0;
      transition: background-color var(--transition), color var(--transition);
      line-height: 1.6;
    }

    /* Header e navegação */
    header {
      background-color: var(--color-primary);
      color: white;
      padding: 1.5rem 1rem;
      text-align: center;
      position: relative;
      box-shadow: var(--shadow-sm);
    }

    .header-content {
      max-width: 1200px;
      margin: 0 auto;
      position: relative;
    }

    h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      font-weight: 700;
    }

    p.subtitle {
      color: rgba(255, 255, 255, 0.9);
      font-size: 1.1rem;
      margin-bottom: 1rem;
      font-weight: 400;
    }

    /* Controles */
    .controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 1200px;
      margin: 0 auto;
      padding: 1rem;
      background-color: var(--color-card);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-sm);
      margin-top: -1.5rem;
      position: relative;
      z-index: 10;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .search-container {
      position: relative;
      flex: 1;
      min-width: 200px;
    }

    #searchInput {
      width: 100%;
      padding: 0.75rem 1rem 0.75rem 2.5rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-size: 1rem;
      background-color: var(--color-card);
      color: var(--color-text);
      transition: all var(--transition);
    }

    #searchInput:focus {
      outline: none;
      border-color: var(--color-primary);
      box-shadow: 0 0 0 3px var(--color-primary-light);
    }

    .search-icon {
      position: absolute;
      left: 0.75rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--color-text-secondary);
      pointer-events: none;
    }

    .filter-container {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    #categoryFilter {
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-size: 1rem;
      background-color: var(--color-card);
      color: var(--color-text);
      cursor: pointer;
      transition: all var(--transition);
    }

    #categoryFilter:focus {
      outline: none;
      border-color: var(--color-primary);
    }

    #darkModeToggle {
      background: none;
      border: none;
      width: 40px;
      height: 40px;
      font-size: 1.5rem;
      line-height: 1;
      cursor: pointer;
      color: var(--color-text);
      transition: all var(--transition);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #darkModeToggle:hover {
      background-color: rgba(0,0,0,0.1);
    }

    #darkModeToggle:focus {
      outline: 3px solid var(--color-primary-light);
      outline-offset: 2px;
    }

    /* Conteúdo principal */
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1rem;
      width: 100%;
      flex-grow: 1;
    }

    .category-title {
      margin: 2rem 0 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--color-primary);
      color: var(--color-text);
      font-size: 1.5rem;
      font-weight: 600;
    }

    .category-title:first-of-type {
      margin-top: 0;
    }

    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .card {
      display: flex;
      flex-direction: column;
      background-color: var(--color-card);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-sm);
      text-decoration: none;
      color: var(--color-text);
      transition: all var(--transition);
      overflow: hidden;
      height: 100%;
      border: 1px solid var(--color-border);
    }

    .card:hover,
    .card:focus {
      transform: translateY(-4px);
      box-shadow: var(--shadow-md);
      border-color: var(--color-primary);
      outline: none;
    }

    .card:focus-visible {
      outline: 3px solid var(--color-primary);
      outline-offset: 2px;
    }

    .card-header {
      padding: 1.25rem 1.25rem 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .card-icon {
      font-size: 2.5rem;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card-title {
      font-weight: 600;
      font-size: 1.2rem;
      color: var(--color-text);
      flex-grow: 1;
    }

    .card-body {
      padding: 0 1.25rem 1.25rem;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
    }

    .card-desc {
      font-size: 0.95rem;
      color: var(--color-text-secondary);
      margin-bottom: 1rem;
      flex-grow: 1;
    }

    .card-meta {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--color-text-secondary);
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .card-category {
      background-color: var(--color-primary-light);
      color: var(--color-primary-dark);
      padding: 0.25rem 0.5rem;
      border-radius: var(--radius-sm);
      font-weight: 500;
      font-size: 0.8rem;
    }

    .card-hash {
      font-family: monospace;
      font-size: 0.7rem;
      opacity: 0.7;
      word-break: break-all;
    }

    .card-date {
      font-size: 0.8rem;
    }

    [data-theme="dark"] .card-category {
      background-color: var(--color-primary-dark);
      color: var(--color-primary-light);
    }

    /* Rodapé */
    footer {
      background-color: var(--color-card);
      color: var(--color-text-secondary);
      text-align: center;
      padding: 1.5rem;
      margin-top: auto;
      border-top: 1px solid var(--color-border);
    }

    .footer-content {
      max-width: 1200px;
      margin: 0 auto;
    }

    /* Mensagem de nenhum resultado */
    .no-results {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--color-text-secondary);
      font-size: 1.2rem;
    }

    /* Animações */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .card {
      animation: fadeIn 0.3s ease-out;
    }

    /* Responsividade */
    @media (max-width: 768px) {
      h1 {
        font-size: 2rem;
      }

      .controls {
        flex-direction: column;
        align-items: stretch;
      }

      .filter-container {
        justify-content: space-between;
      }

      .cards-grid {
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      }
    }

    @media (max-width: 480px) {
      h1 {
        font-size: 1.75rem;
      }

      .cards-grid {
        grid-template-columns: 1fr;
      }

      .card-header {
        flex-direction: column;
        text-align: center;
      }

      .card-title {
        margin-top: 0.5rem;
      }
    }

    /* Acessibilidade */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }

    /* Botão de voltar ao topo */
    #backToTop {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background-color: var(--color-primary);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      cursor: pointer;
      box-shadow: var(--shadow-md);
      opacity: 0;
      visibility: hidden;
      transition: all var(--transition);
      border: none;
    }

    #backToTop.visible {
      opacity: 1;
      visibility: visible;
    }

    #backToTop:hover {
      background-color: var(--color-primary-dark);
      transform: translateY(-4px);
    }

    /* Skeleton loading */
    .skeleton {
      background: linear-gradient(90deg, var(--color-card) 25%, var(--color-card-hover) 50%, var(--color-card) 75%);
      background-size: 200% 100%;
      animation: loading 1.5s infinite;
      border-radius: var(--radius-sm);
    }

    @keyframes loading {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-content">
      <h1>Simple Utility App Suite</h1>
      <p class="subtitle">by Rafael Passos Domingues</p>
    </div>
  </header>

  <div class="container">
    <div class="controls">
      <div class="search-container">
        <span class="search-icon" aria-hidden="true">🔍</span>
        <input type="text" id="searchInput" placeholder="Buscar projetos..." aria-label="Buscar projetos">
      </div>
      <div class="filter-container">
        <label for="categoryFilter" class="sr-only">Filtrar por categoria</label>
        <select id="categoryFilter" aria-label="Filtrar por categoria">
          <option value="all">Todas as categorias</option>
          <!-- Categorias serão adicionadas via JavaScript -->
        </select>
        <button id="darkModeToggle" aria-pressed="false" aria-label="Alternar modo escuro">🌙</button>
      </div>
    </div>

    <div id="projectsContainer">
      <!-- Conteúdo será gerado dinamicamente -->
    </div>
  </div>

  <button id="backToTop" aria-label="Voltar ao topo" title="Voltar ao topo">↑</button>

  <script>
    // Dados dos projetos
    const BASE_URL = "${BASE_URL}";  // Base URL para links diretos no GitHub Pages
    const projects = [
EOF

  # 2) Loop: para cada HTML em site/utilities/, exceto main.html
  local categorias=()

  find "$REPO_PATH/$UTIL_DIR" -type f -name '*.html' ! -name 'main.html' -print0 | sort -z | \
  while IFS= read -r -d '' file; do
    relpath="${file#$REPO_PATH/$DEST_DIR/}"
    titulo=$(extrair_titulo "$file")
    [[ -z "$titulo" ]] && titulo=$(basename "$file" .html)
    categoria=$(extrair_categoria "$file")
    icon=$(escolher_icone "$relpath" "$categoria")
    
    # Gerar hash MD5 do arquivo
    file_hash=$(gerar_hash "$file")
    
    # Data de modificação formatada
    lastMod=$(date -r "$file" "+%Y-%m-%d %H:%M")
    
    # URL absoluto
    href="${BASE_URL}/${relpath}"

    # Escapar strings para JSON
    titulo_esc=$(escapar_html "$titulo" | sed 's/"/\\"/g')
    categoria_esc=$(escapar_html "$categoria" | sed 's/"/\\"/g')

    # Adicionar ao array de categorias se não existir
    if [[ ! " ${categorias[*]} " =~ " ${categoria} " ]]; then
      categorias+=("$categoria")
    fi

    # Adicionar objeto JSON ao array de projetos
    cat >> "$REPO_PATH/$MAIN_FILE" << EOF
      {
        id: "$(basename "$file" .html)",
        title: "$titulo_esc",
        icon: "$icon",
        category: "$categoria_esc",
        path: "$href",
        lastModified: "$lastMod",
        fileHash: "$file_hash"
      },
EOF
  done

  # 3) Fechar array de projetos e adicionar script
  cat >> "$REPO_PATH/$MAIN_FILE" << 'EOF'
    ];

    // Função para aplicar tema escuro/claro
    function applyTheme() {
      const darkPref = localStorage.getItem('darkMode') === 'true';
      document.body.setAttribute('data-theme', darkPref ? 'dark' : 'light');
      const toggleBtn = document.getElementById('darkModeToggle');
      toggleBtn.setAttribute('aria-pressed', darkPref.toString());
      toggleBtn.textContent = darkPref ? '☀️' : '🌙';
    }

    // Aplicar tema inicial
    applyTheme();

    // Função para organizar projetos por categoria
    function organizeByCategory(projects) {
      const categories = {};
      projects.forEach(project => {
        if (!categories[project.category]) {
          categories[project.category] = [];
        }
        categories[project.category].push(project);
      });
      return categories;
    }

    // Função para renderizar projetos
    function renderProjects(filteredProjects) {
      const container = document.getElementById('projectsContainer');
      container.innerHTML = '';

      if (filteredProjects.length === 0) {
        container.innerHTML = `<div class="no-results">...</div>`;
        return;
      }

      const organizedProjects = organizeByCategory(filteredProjects);

      Object.keys(organizedProjects).sort().forEach(category => {
        const categoryProjects = organizedProjects[category];

        const section = document.createElement('section');
        section.innerHTML = `
          <h2 class="category-title">${category}</h2>
          <div class="cards-grid" id="grid-${category.toLowerCase().replace(/\s+/g, '-')}"></div>
        `;
        container.appendChild(section);

        const grid = section.querySelector('.cards-grid');

        categoryProjects.forEach(proj => {
          const card = document.createElement('a');
          card.className = 'card';
          card.href = proj.path;
          card.setAttribute('target', '_blank');
          card.setAttribute('rel', 'noopener');
          card.setAttribute('aria-label', `${proj.title} – abre em nova aba`);
          card.setAttribute('data-category', proj.category);
          card.setAttribute('data-id', proj.id);
          card.setAttribute('data-hash', proj.fileHash);

          card.innerHTML = `
            <div class="card-header">
              <div class="card-icon" aria-hidden="true">${proj.icon}</div>
              <div class="card-title">${proj.title}</div>
            </div>
            <div class="card-body">
              <div class="card-meta">
                <div class="meta-row">
                  <span class="card-category">${proj.category}</span>
                  <span class="card-date">${proj.lastModified}</span>
                </div>
                <div class="meta-row">
                  <span class="card-hash" title="Hash MD5 do arquivo">${proj.fileHash}</span>
                </div>
              </div>
            </div>
          `;

          grid.appendChild(card);
        });
      });
    }

    // Função para popular o filtro de categorias
    function populateCategoryFilter(projects) {
      const categories = [...new Set(projects.map(p => p.category))].sort();
      const select = document.getElementById('categoryFilter');
      categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        select.appendChild(option);
      });
    }

    // Função para filtrar projetos
    function filterProjects() {
      const term = document.getElementById('searchInput').value.toLowerCase();
      const catFilter = document.getElementById('categoryFilter').value;

      let filtered = projects;
      if (catFilter !== 'all') {
        filtered = filtered.filter(p => p.category === catFilter);
      }
      if (term) {
        filtered = filtered.filter(p =>
          p.title.toLowerCase().includes(term) ||
          p.description.toLowerCase().includes(term) ||
          p.category.toLowerCase().includes(term)
        );
      }

      renderProjects(filtered);
    }

    // Inicialização
    document.addEventListener('DOMContentLoaded', () => {
      renderProjects(projects);
      populateCategoryFilter(projects);
      document.getElementById('searchInput').addEventListener('input', filterProjects);
      document.getElementById('categoryFilter').addEventListener('change', filterProjects);

      const toggleBtn = document.getElementById('darkModeToggle');
      toggleBtn.addEventListener('click', () => {
        const isDark = localStorage.getItem('darkMode') === 'true';
        localStorage.setItem('darkMode', (!isDark).toString());
        applyTheme();
      });

      // Botão voltar ao topo
      const backToTop = document.getElementById('backToTop');
      window.addEventListener('scroll', () => {
        if (window.scrollY > 300) {
          backToTop.classList.add('visible');
        } else {
          backToTop.classList.remove('visible');
        }
      });
      backToTop.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });

      // Preferência de tema
      if (!localStorage.getItem('darkMode')) {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        localStorage.setItem('darkMode', prefersDark.toString());
        applyTheme();
      }
    });
  </script>
</body>
</html>
EOF

  log "SUCCESS" "Arquivo '$MAIN_FILE' gerado com sucesso."
}

# ------------------------------------------------------------------------------
# Função: Commit e push das alterações no branch gh-pages
#
#   - Adiciona site/utilities/ e site/main.html ao Git
#   - Cria commit com mensagem timestamped
#   - Push para origin/gh-pages
# ------------------------------------------------------------------------------
commit_e_push() {
  log "INFO" "Comitando e enviando alterações para o GitHub..."
  cd "$REPO_PATH" || { log "ERROR" "Falha ao acessar diretório do repositório."; exit 1; }

  # Verificar se há alterações para commitar
  if [ -z "$(git status --porcelain "$DEST_DIR")" ]; then
    log "INFO" "Nenhuma alteração detectada em '$DEST_DIR'. Nada a commitar."
    return 0
  fi

  # Adicionar arquivos ao Git
  git add "$DEST_DIR" || {
    log "ERROR" "Falha ao adicionar arquivos ao Git."
    exit 1
  }

  # Criar commit com mensagem timestamped
  local msg="Atualiza utilities e índice - $(date '+%Y-%m-%d %H:%M')"
  git commit -m "$msg" || {
    log "ERROR" "Falha ao criar commit."
    exit 1
  }

  # Push para origin/gh-pages
  log "INFO" "Enviando alterações para o repositório remoto..."
  git push origin "$BRANCH" || {
    log "ERROR" "Falha ao enviar alterações para o repositório remoto."
    exit 1
  }

  log "SUCCESS" "Deploy realizado com sucesso!"
  log "SUCCESS" "Site disponível em: $SITE_URL"
}

# ------------------------------------------------------------------------------
# Função: Mostrar ajuda
# ------------------------------------------------------------------------------
mostrar_ajuda() {
  echo "Uso: $0 [opções]"
  echo ""
  echo "Opções:"
  echo "  -h, --help          Mostra esta mensagem de ajuda"
  echo "  -q, --quiet         Modo silencioso (menos mensagens)"
  echo "  --skip-backup       Pula a criação de backup"
  echo ""
  echo "Exemplo:"
  echo "  $0 --quiet          Executa o script em modo silencioso"
}

# ------------------------------------------------------------------------------
# Função: Processar argumentos da linha de comando
# ------------------------------------------------------------------------------
processar_argumentos() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        mostrar_ajuda
        exit 0
        ;;
      -q|--quiet)
        VERBOSE=false
        shift
        ;;
      --skip-backup)
        SKIP_BACKUP=true
        shift
        ;;
      *)
        log "ERROR" "Opção desconhecida: $1"
        mostrar_ajuda
        exit 1
        ;;
    esac
  done
}

# ------------------------------------------------------------------------------
# Execução principal
# ------------------------------------------------------------------------------
main() {
  # Processar argumentos da linha de comando
  processar_argumentos "$@"

  log "INFO" "Iniciando atualização do site em $BRANCH..."

  # Verificar dependências
  verificar_dependencias

  # Criar backup
  criar_backup

  # Atualizar branch
  atualizar_branch

  # Limpar e recriar pasta destino
  preparar_destino

  # Copiar todo o conteúdo de utilities/ para site/utilities/
  copiar_html

  # Gerar site/main.html
  gerar_main_html

  # Commit e push final
  commit_e_push

  log "SUCCESS" "Processo concluído com sucesso!"
}

# Iniciar execução
main "$@"
