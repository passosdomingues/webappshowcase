# Radar PI — UNIFAL-MG

Ferramenta de busca e prospecção tecnológica sobre docentes, laboratórios,
patentes, softwares e marcas da UNIFAL-MG, para apoio à Agência I9 e à
NidusTec no mapeamento de propriedade intelectual e na transferência de
tecnologia.

Reescrita a partir do projeto original *Busca de Docentes Unifal*
(estraphael/Sistema-pesquisa), com dados corrigidos, consolidados e
cruzados com o mapeamento institucional de PI.

## Estrutura

```
index.html      página única (abas: Docentes / Portfólio de PI / Sobre os dados)
style.css       estilos (sem dependências externas)
app.js          busca, filtros, renderização e busca semântica
docentes.json   534 docentes consolidados (de 982 vínculos curso x docente)
portfolio.json  patentes, softwares, marcas, laboratórios e marcos institucionais
```

Sem build, sem framework, sem backend. Arquivos estáticos puros.

## Publicar no GitHub Pages

1. Suba estes 6 arquivos na raiz do seu repositório (ou em uma pasta e
   aponte o Pages para ela).
2. Em *Settings → Pages*, selecione a branch e a pasta.
3. Pronto — não há passo de build.

## Atualizar os dados

- **Docentes**: edite `docentes.json`. Cada registro tem `nome`, `unidade`,
  `campus`, `titulacao`, `email`, `lattes`, `patentes` (links para PDFs/
  páginas de PI), `laboratorios` (siglas), `patentes_pi` (títulos) e
  `vinculos` (lista de `{curso, disciplinas, unidade, campus}`).
- **Portfólio institucional**: edite `portfolio.json` (patentes, softwares,
  marcas, laboratórios, marcos).

## Busca semântica

Ativada por um botão na aba Docentes. Carrega, sob demanda e inteiramente
no navegador (via WebAssembly, biblioteca `@xenova/transformers` por CDN),
um modelo compacto de embeddings multilíngue
(`Xenova/paraphrase-multilingual-MiniLM-L12-v2`). Não depende de servidor,
chave de API ou serviço pago. Os embeddings calculados ficam em cache no
`localStorage` do navegador do usuário para não recalcular a cada visita.

## O que foi corrigido em relação à fonte original

- 982 registros de vínculo consolidados em 534 perfis únicos de docente.
- Nome de um docente que havia sido substituído por um título de disciplina
  na fonte original (erro de alinhamento de linhas).
- E-mails trocados entre dois registros adjacentes (erro de cópia na fonte
  original) — identificados por Lattes duplicado com e-mails divergentes.
- Rótulos inconsistentes padronizados (variações como "Discipinas" e
  "Email" sem hífen presentes no HTML original).
- Interface simplificada: sem ícones decorativos, sem emojis, sem alertas
  de bloqueio de acesso.

## Limitações conhecidas

- A base cobre os docentes vinculados aos cursos listados na fonte
  original — não é um diretório completo de todo o corpo docente da
  UNIFAL-MG.
- Oito docentes não tinham e-mail informado na fonte original; o campo foi
  deixado em branco em vez de inferido por padrão de nome, para evitar
  dados incorretos.
- O portfólio de PI reflete o mapeamento documental fornecido, não uma
  consulta em tempo real ao INPI ou à Vitrine Tecnológica da FAPEMIG.
