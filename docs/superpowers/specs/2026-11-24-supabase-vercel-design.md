# Supabase + Vercel — Design de Infraestrutura

## Intenção

Corrigir o destino de infraestrutura do PDV LH Company: substituir Neon/Render por Supabase/Vercel sem reescrever o domínio, a autenticação própria, o ledger de estoque, os fatos financeiros ou a sincronização offline.

O Supabase será usado como PostgreSQL gerenciado. A Vercel hospedará dois projetos do mesmo monorepo: a PWA em `apps/web` e a API Fastify em `apps/api`.

## Objetivos

- Preservar Fastify, React, SQL puro, migrations forward-only e autenticação JWT existentes.
- Executar a API como uma Vercel Function Node.js.
- Usar o Supavisor em transaction mode para requisições serverless e conexão direta para migrations.
- Processar a integração Nuvemshop em ciclos limitados acionados pelo Supabase Cron.
- Impedir acesso às tabelas financeiras pela Data API pública do Supabase.
- Manter desenvolvimento, PostgreSQL local, CI e testes E2E funcionando.
- Atualizar toda a documentação que atualmente menciona Neon ou Render.

## Não objetivos

- Migrar para Supabase Auth, `supabase-js` ou Supabase Edge Functions.
- Expor regras de negócio diretamente pela Data API.
- Reescrever módulos de vendas, caixa, estoque, relatórios ou sincronização.
- Criar recursos ou inserir segredos nas contas Supabase/Vercel automaticamente.
- Homologar a Nuvemshop real nesta mudança.

## Restrições

- Fatos financeiros e de estoque continuam append-only.
- Escritas críticas continuam passando por Fastify e PostgreSQL.
- Valores monetários continuam em centavos inteiros.
- Nenhum segredo é versionado ou enviado ao navegador.
- Migrations continuam forward-only e não podem depender de recursos exclusivos do ambiente remoto para passar no PostgreSQL local.
- O primeiro deployment usará Vercel Hobby. Como esse plano não oferece a frequência necessária para o worker, o agendamento ficará no Supabase Cron.
- Haverá um único projeto Supabase remoto por enquanto. Desenvolvimento e testes usam PostgreSQL local e deployments de preview não recebem credenciais de produção.

## Abordagens consideradas

### 1. Supabase somente como PostgreSQL + Fastify na Vercel — escolhida

Preserva o código e as garantias já implementadas. Exige adaptar conexões, entrada serverless, cron, segurança do schema público e documentação.

### 2. Supabase Auth e Data API no frontend

Reduz parte da API, mas exigiria reescrever autenticação, permissões e diversas transações críticas como RPCs/policies. O risco de alterar o domínio financeiro é alto e não traz benefício necessário para esta migração.

### 3. Supabase Edge Functions para toda a API

Exigiria adaptar o runtime Node/Fastify, o driver `pg`, scripts e empacotamento. Foi descartada por ser uma reescrita sem necessidade.

## Arquitetura de execução

### Web

- Projeto Vercel com Root Directory `apps/web`.
- Build por Vite e publicação de `dist`.
- `VITE_API_URL` aponta para o domínio do projeto da API.
- Fallback SPA e política de não cachear respostas da API permanecem.

### API

- Projeto Vercel com Root Directory `apps/api` e acesso aos arquivos do workspace habilitado para consumir `packages/shared`.
- `src/server.ts` continua sendo a entrada local persistente.
- `src/server.ts` permanece como a única entrada Fastify reconhecível pela Vercel e chama `listen`, conforme o adaptador oficial zero-config da plataforma. O construtor da aplicação sai de `src/app.ts` para evitar que a detecção escolha o arquivo errado; `env`, pool e app continuam em escopo de módulo e são reutilizados quando a Function permanece aquecida.
- O build local/CI atual continua disponível; o deployment da Vercel usa o runtime Node.js.
- A API e o banco devem usar regiões próximas.

### Banco Supabase

- `DATABASE_URL`: URI do Supavisor em transaction mode, com SSL obrigatório.
- `DATABASE_URL_MIGRATIONS`: conexão direta do Supabase, usada somente em ambiente controlado para migration.
- O pool serverless usa `max: 1` por instância aquecida; local/teste mantém limite configurável maior.
- As operações usam queries sem prepared statements nomeados. Locks transacionais existentes continuam válidos dentro das transações.
- O lock de migration é de sessão e, portanto, migrations não usam transaction pooler.

### Segurança da Data API

- Uma nova migration habilita RLS nas tabelas existentes do aplicativo.
- A migration revoga privilégios dos papéis `anon` e `authenticated` quando esses papéis existirem, permanecendo compatível com PostgreSQL local.
- Nenhuma policy é criada: o frontend não acessa tabelas diretamente.
- A conexão backend permanece segredo exclusivo da Vercel.
- Novas tabelas deverão receber a mesma proteção na migration que as criar.

### Worker Nuvemshop e Supabase Cron

- `runCycle()` permanece a unidade idempotente de trabalho.
- O loop `startWorker()` continua disponível apenas para execução persistente/local, mas deixa de ser a estratégia de produção.
- Uma rota `POST /internal/cron/nuvemshop` executa um ciclo limitado.
- A rota exige `Authorization: Bearer <CRON_SECRET>` e não é registrada quando o segredo não está configurado.
- O Supabase Cron (`pg_cron`) agenda uma chamada HTTPS por minuto por meio de `pg_net`. Leases, locks e `skip locked` existentes protegem contra sobreposição.
- A URL da API e o segredo do cron ficam no Supabase Vault. A configuração é manual e específica do ambiente, não uma migration portátil.
- `vercel.json` não contém cron: a Vercel Hobby hospeda somente a Function que recebe a chamada.
- A reconciliação continua respeitando `RECONCILE_INTERVAL_MIN`; não ocorre em todo disparo.
- Falhas retornam status não-2xx e ficam visíveis nos logs da Vercel; as filas permanecem no banco para a próxima tentativa.

## Migrations e deploy

- Migrations não rodam automaticamente durante cold start da API.
- O comando `pnpm db:migrate` continua sendo o único aplicador.
- A documentação orienta executar migrations com `DATABASE_URL_MIGRATIONS` antes de promover um deployment que dependa delas.
- O deploy da aplicação não recebe permissão para apagar ou recriar schema.
- `render.yaml` é removido e substituído pelas configurações Vercel específicas de web e API.

## Configuração

Novas variáveis de backend:

- `DATABASE_POOL_MAX`: inteiro positivo; produção serverless usa `1`.
- `CRON_SECRET`: segredo aleatório compartilhado apenas entre a API na Vercel e o job no Supabase Vault.

O mesmo valor de `CRON_SECRET` é armazenado manualmente no Supabase Vault. A URL pública da API também é armazenada no Vault para o job construir a chamada sem versionar destino ou credencial.

Variáveis existentes preservadas:

- `DATABASE_URL`, `DATABASE_URL_MIGRATIONS`, `JWT_SECRET`, `CORS_ORIGINS`.
- Credenciais e URLs da Nuvemshop.
- `PUBLIC_API_URL` e `WEB_URL`.

## Testes e verificação

- Testes unitários cobrem configuração do pool e autenticação constante da rota de cron.
- Teste de API com PostgreSQL descartável cobre rota não registrada, não autorizada e execução autorizada.
- Migration de segurança entra na suíte real de migrations e integridade.
- `pnpm check` deve passar com `DATABASE_URL_TEST` apontando para banco descartável.
- E2E existente deve continuar passando sem depender do cron.
- O deployment só é considerado homologado após health check, login, venda, movimentação de estoque, sync offline e um ciclo controlado da Nuvemshop em ambiente de teste.

## Riscos e mitigação

- **Exaustão de conexões:** Supavisor transaction mode e pool local `max: 1` na Function.
- **Migration no pooler errado:** variável exclusiva de migrations e documentação explícita.
- **Exposição pela Data API:** RLS sem policies e revogação condicional de `anon`/`authenticated`.
- **Cron sobreposto:** operações e leases já idempotentes; cada chamada executa apenas um ciclo.
- **Segredo transitório no `pg_net`:** o Vault protege o valor em repouso, mas o header descriptografado existe brevemente na fila interna do `pg_net`; o acesso a objetos `net` fica restrito e o segredo pode ser rotacionado.
- **Supabase Free pausado por inatividade:** documentar a limitação; tráfego real e o cron normalmente mantêm atividade, mas o primeiro deployment não recebe garantia de disponibilidade ou backups automáticos.
- **Timeout do cron:** processamento já trabalha em lotes; limites precisam ser observados na homologação antes de aumentar carga.
- **Configuração incorreta do monorepo:** documentar os dois projetos Vercel e o acesso ao workspace compartilhado.

## Critérios de aceitação

- Nenhuma referência operacional a Neon ou Render permanece, exceto histórico explicitamente identificado.
- Builds local e Vercel têm entradas distintas e não iniciam listener persistente na Function.
- API usa pool configurável e o exemplo de produção define uma conexão por instância.
- Cron rejeita chamadas sem segredo e executa `runCycle` quando autenticado.
- Tabelas existentes não são acessíveis por `anon`/`authenticated` no Supabase.
- Configurações Vercel existem para web, API e SPA; o roteiro do Supabase documenta Vault, `pg_cron` e `pg_net` para o agendamento.
- Documentação descreve criação dos dois projetos, variáveis, migrations, RLS e homologação.
- Typecheck, lint, format, testes unitários, testes PostgreSQL e builds passam com evidência nova.
