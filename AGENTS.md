# AGENTS.md — PDV LH Company (Rodeghiero Tech)

Regras para humanos e agentes de IA. Em caso de conflito, a especificação original do projeto prevalece; depois, este arquivo; depois, `docs/ARQUITETURA.md`.

## Princípios inegociáveis

1. **Integridade primeiro**: vendas, pagamentos e estoque são append-only. Nada financeiro ou de estoque é apagado/sobrescrito; correções são movimentações compensatórias (`reverses_*`).
2. **Venda física prevalece** sobre o e-commerce em qualquer conflito. Nunca cancelar/estornar venda presencial automaticamente.
3. **Regras de negócio no backend** (`apps/api/src/modules/*`). Componentes React só apresentam e coletam dados.
4. **Dinheiro em centavos inteiros** (`number` inteiro, coluna `integer`/`bigint`). Nunca `float`.
5. **Idempotência** em toda escrita financeira/de estoque (`idempotency_key`/`operation_id` com constraint `UNIQUE`).
6. **Segredos só no backend**. Nada de credenciais no repositório; use `.env` (ignorado) e variáveis do Render.
7. **Não simular**: o que não está implementado é marcado como tal em `PLANO.md`.

## Estrutura

```
apps/api         Fastify + TypeScript (domínio, API REST, worker)
apps/web         React + Vite + Tailwind + shadcn/ui (PWA)
packages/shared  Schemas zod, tipos, permissões, utilitários de dinheiro
docs/            ARQUITETURA.md, DESIGN_SYSTEM.md
PLANO.md         Roadmap e progresso REAL
```

### Módulos da API (`apps/api/src/modules/<nome>`)

Cada módulo expõe `routes.ts` (HTTP/validação), `service.ts` (regras de negócio, transações) e `repo.ts` (SQL). Regras:

- `routes` → `service` → `repo`. Nunca o inverso.
- Módulos só dependem de outros módulos pela API pública (`service`) — nunca consultando tabelas alheias diretamente. Exceção documentada: leituras de relatório.
- Núcleo (`catalog`, `inventory`, `auth`, `audit`, futuramente `sales`, `cash`, `customers`, `sync`) **não importa** `integrations/*`. Integrações dependem do núcleo, via eventos/outbox.
- Código específico da LH Company vive em configuração (`store_settings`, env), não em `if (cliente === ...)`.

## Convenções de código

- TypeScript `strict`; sem `any` (use `unknown` + zod).
- ESM. Imports de tipo com `import type`.
- Validação de entrada com **zod** nos limites (HTTP, IndexedDB, webhooks). Schemas compartilhados ficam em `packages/shared`.
- Erros de domínio: `AppError(code, status, message)`; tratados centralmente. Respostas: `{ error: { code, message, details? } }`.
- SQL: sempre parametrizado (`$1`). Transações via `withTransaction(pool, fn)`. Bloqueios explícitos (`SELECT … FOR UPDATE`) em operações críticas.
- Nomes: banco/colunas em `snake_case` (português apenas para valores de domínio já definidos na especificação, ex.: `concluida`, `fiado`); código em inglês `camelCase`; UI em português (pt-BR).
- Logs estruturados (pino); nunca logar senha, token ou payload com dados sensíveis.
- Migrations: SQL puro, numeradas (`NNN_descricao.sql`), **forward-only**, nunca editar migration já aplicada.
- Sem novas dependências sem necessidade clara; registrar a justificativa em `docs/ARQUITETURA.md` (seção Decisões).

## Qualidade

Antes de concluir qualquer tarefa: `pnpm check` (typecheck + lint + format + testes + build). Testes de banco usam PostgreSQL real (`DATABASE_URL_TEST`), nunca mocks de SQL para regras de integridade.

Todo fluxo crítico precisa de teste de: sucesso, repetição (idempotência), falha no meio da transação e permissão negada.

## Documentação viva

Atualizar no mesmo commit da mudança: `PLANO.md` (status real), `docs/ARQUITETURA.md` (decisões/modelo), `docs/DESIGN_SYSTEM.md` (componentes/padrões).

## Proibido

- Reescrever componentes funcionais sem justificativa técnica.
- Implementar multi-tenancy (v1). Isolamento por cliente = outro banco + outro deploy.
- Implementar funcionalidades fora do escopo sem avaliação prévia registrada.
- Marcar venda como sincronizada antes da confirmação do servidor.
