# Makefile — WebApp Showcase Orchestrator
# Autor: Rafael Passos Domingues

.PHONY: build run deploy clean help

help:
	@echo "========================================================================"
	@echo "                Webapp Showcase — Comandos de Orquestração"
	@echo "========================================================================"
	@echo "  make build   - Executa a compilação local (cria a pasta site/)"
	@echo "  make run     - Inicia servidor web local em http://localhost:8000/site/main.html"
	@echo "  make deploy  - Executa a build e o deploy local para a branch gh-pages"
	@echo "  make clean   - Remove a pasta site/ compilada"
	@echo "========================================================================"

build:
	python3 update_site.py --no-git

run: build
	@echo "Iniciando servidor local de desenvolvimento..."
	@echo "Acesse: http://localhost:8000/site/main.html"
	python3 -m http.server 8000

deploy:
	python3 update_site.py --deploy

clean:
	rm -rf site/
