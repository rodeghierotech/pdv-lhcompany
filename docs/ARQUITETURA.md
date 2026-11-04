# Arquitetura — PDV LH Company

## Visão geral

O sistema é uma PWA offline-first: o navegador permite continuar o atendimento, mas o backend é a fonte confirmada e auditável. A venda local só é protegida no dispositivo até sincronizar; a interface deve deixar isso inequívoco.

```text
PWA React/TypeScript
  ├─ UI + componentes Rodeghiero Tech
  ├─ IndexedDB: cache, operações locais e fila ordenada
  └─ Service Worker
          │ quando houver rede
          ▼
API Node/TypeScript no Render ── Neon PostgreSQL
          │                         ├─ livro de movimentos
          │                         ├─ saldos materializados
          │                         └─ outbox/auditoria/conflitos
          ▼
Worker no Render ─────────────── Nuvemshop API e webhooks
```

## Stack e implantação

- Frontend: React, TypeScript, Tailwind CSS, shadcn/ui e Lucide Icons, publicado pela Vercel como PWA estática.
- Backend: Supabase Auth, PostgreSQL, RLS, SQL migrations e, para operações críticas futuras, RPC ou Edge Functions. O projeto não mantém um servidor Fastify em produção.
- Dados: PostgreSQL gerenciado pelo Supabase; regras críticas continuam usando transações SQL explícitas.
- Migrações: arquivos SQL versionados em `supabase/migrations`, aplicados pelo Supabase CLI ou painel do projeto configurado. Nenhuma URL de banco é incluída no frontend.
- Integração: sincronização e Nuvemshop serão adicionadas em uma etapa posterior, através de execução gerenciada do Supabase e outbox persistente.
- Segredos: a Vercel recebe somente `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`; service-role, URLs de banco e tokens Nuvemshop permanecem em variáveis protegidas do Supabase.
- Organização: npm workspaces com `apps/web`, `apps/api` (legado, fora da implantação) e `packages/contracts`.
- Build do frontend: Vite. A escolha mantém um shell React estático compatível com Vercel e reduz configuração própria nesta base inicial.
- Testes: Vitest é adotado para testar regras TypeScript puras no frontend sem depender de navegador ou de uma instância remota do Supabase.

Planos gratuitos não são aceitáveis para API ou worker de produção devido à hibernação. Qualquer nova biblioteca, ORM ou serviço precisa de justificativa e registro nesta página antes de ser adotado.

## Organização por domínio

```text
apps/
  web/src/features/{pdv,produtos,estoque,clientes,caixa,despesas,relatorios,sincronizacao}/
  api/src/modules/{auth,produtos,estoque,vendas,financeiro,caixa,sincronizacao,nuvemshop}/
packages/
  contracts/        # DTOs, schemas Zod e tipos compartilhados
  domain/           # regras puras e cálculos reutilizáveis
```

Cada módulo separa interface/rotas, validação, serviço de domínio e repositório. Regras como saldo devedor, taxa de cartão, disponibilidade e estorno não vivem em componentes nem em handlers HTTP.

## Dados, auditoria e desempenho

- `inventory_movement` e `financial_movement` são livros imutáveis.
- Tabelas Supabase são vinculadas a uma organização, têm RLS habilitada e só recebem políticas explícitas. `audit_event` é somente de inserção: não há política de atualização ou exclusão.
- Tabelas de saldo/estoque atual aceleram consulta e são alteradas na mesma transação do respectivo movimento.
- Vendas, pagamentos, itens, lotes, caixa, despesas, auditoria, mapeamentos externos, outbox e conflitos são entidades independentes; nenhum histórico é apagado.
- Operações mutantes usam UUID idempotente. Uma transação no backend aplica a regra, cria movimento, atualiza saldo materializado e grava o evento de saída.
- Valores monetários são representados em centavos inteiros nos contratos e na persistência; nenhum cálculo financeiro usa ponto flutuante.
- A atualização de `inventory_balance` e a inserção de `inventory_movement` ocorrem na mesma transação PostgreSQL. A tabela de saldo acelera consulta; o movimento é a evidência auditável.

## Offline, dispositivos e autorização

- Uma operação offline contém `operationId`, `aggregateId`, `deviceId`, sequência local, dependências, horário local e `reversesOperationId` quando reversa.
- A fila respeita dependências: cancelamento antes da venda fica aguardando a venda original, e não é perdido nem aplicado antecipadamente.
- Uma transação IndexedDB persiste venda, pagamentos, movimentos locais e operação pendente como unidade. A UI só confirma a venda após `commit` local.
- O PWA solicita persistência, testa escrita real, trata abortos e monitora falhas/quota. Isso reduz risco, mas não substitui sincronização nem backup no servidor.
- Pendências pertencem ao dispositivo de origem. Outros dispositivos mostram apenas dados confirmados e não inferem vendas locais de um dispositivo desconectado.
- O backend emite autorização offline assinada com `deviceId`, prazo configurável, versão de credenciais e escopos. Proposta inicial: no máximo 8 horas.
- Offline permite somente registrar venda e pagamento expressamente autorizados. Preço, ajuste de estoque, despesas, configurações e cancelamentos antigos exigem conexão.
- Após reinício, alteração suspeita de tempo ou expiração, novas operações sensíveis exigem revalidação online; pendências continuam disponíveis apenas para sincronização.

## Sincronização e Nuvemshop

- A API recebe `POST /sync/operations` e devolve estado por operação: confirmada, aguardando dependência, falha recuperável ou conflito.
- Webhooks são sinais pelo menos uma vez: armazenar recebimento, deduplicar e consultar o pedido atual antes de processar transição.
- Pedido online só movimenta estoque ao pagamento aprovado. Edição posterior calcula delta; reembolso parcial sem redução de item não repõe estoque; devolução repõe somente após recebimento físico confirmado.
- Em disputa por última unidade, manter os dois movimentos. A venda física concluída tem prioridade comercial, enquanto pedido online já processado vira pendência humana; não existe reversão automática retroativa.
- Mapeamentos de variante guardam ID externo, SKU e atributos. Religar automaticamente só por SKU único; ambiguidade exige ação humana.
