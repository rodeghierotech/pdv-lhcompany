# Arquitetura — PDV LH Company

Base reutilizável da Rodeghiero Tech. Primeira implantação: LH Company. Sem multi-tenancy: um cliente = um banco + um deploy.

## 1. Visão geral

```
 Navegador (PWA)                 Render                         Externo
┌───────────────────┐    ┌──────────────────────────┐
│ React + shadcn    │    │ API Fastify (REST)       │
│ IndexedDB (fila)  │◄──►│  módulos de domínio      │──► Neon PostgreSQL
│ Service Worker    │    │ Worker (outbox/sync)     │──► API Nuvemshop
└───────────────────┘    │ Webhook receiver         │◄── Webhooks Nuvemshop
                         └──────────────────────────┘
```

Monorepo pnpm: `apps/web`, `apps/api`, `packages/shared` (schemas zod, tipos, permissões, dinheiro).

## 2. Módulos e fronteiras

| Módulo (`apps/api/src/modules`) | Responsabilidade                                    | Status |
| ------------------------------- | --------------------------------------------------- | ------ |
| `auth`                          | Usuários, login, JWT, papéis/permissões             | ✅ F2  |
| `audit`                         | Registro append-only de ações sensíveis             | ✅ F2  |
| `catalog`                       | Categorias, produtos, variantes (SKU, preço, custo) | ✅ F3  |
| `inventory`                     | Lotes, movimentações imutáveis, saldo               | ✅ F3  |
| `sales`                         | Vendas, itens, pagamentos, cancelamento/devolução   | ⬜ F5  |
| `customers`                     | Clientes, fiado, recebimentos                       | ⬜ F6  |
| `cash`                          | Sessões de caixa, movimentos, despesas              | ⬜ F6  |
| `reports`                       | Leituras agregadas (dashboard)                      | ⬜ F7  |
| `sync`                          | Fila offline: dedupe, dependências, resultado       | ⬜ F8  |
| `integrations/nuvemshop`        | Webhooks, outbox, vínculos, worker, reconciliação   | 🟡 F9  |

Regra de dependência: `integrations/*` → núcleo, nunca o contrário. O núcleo publica eventos na **outbox**; integrações consomem. O único ponto de contato é o trigger `enqueue_nuvemshop_stock` em `stock_movements` (outbox transacional). Sem conexão ativa o módulo fica inerte (workers retornam `sem_conexao_ativa`) e o PDV opera normalmente.

Camadas: `routes` (HTTP + zod) → `service` (regra + transação) → `repo` (SQL).

## 3. Modelo de dados

### Implementado (migration `001_init.sql`)

- `users` (papel por `CHECK`), `audit_log` (append-only por trigger)
- `categories`, `products`, `product_variants` (SKU único, código de barras único opcional, preço/custo em centavos, estoque mínimo)
- `stock_batches` (lotes de entrada com custo unitário)
- `stock_movements` — **imutável** (trigger bloqueia `UPDATE`/`DELETE`), `quantity_delta <> 0`, `idempotency_key` único, `reverses_movement_id` único (um estorno por movimento)
- `stock_levels` — saldo por variante, **derivado por trigger** a partir das movimentações (nunca escrito pela aplicação)

### Planejado

`customers`, `sales`, `sale_items`, `payments`, `receivables` (fiado) e `receivable_payments`, `cash_sessions`, `cash_movements`, `expenses`, `devices`, `sync_operations`, `nuvemshop_mappings`, `integration_events`, `outbox_events`, `store_settings`.

### Invariantes

1. Saldo = soma das movimentações (garantido por trigger na mesma transação).
2. Movimentação/auditoria nunca são alteradas; correção = nova movimentação com `reverses_movement_id`.
3. Dinheiro em centavos inteiros (`integer`/`bigint`).
4. Entrada de estoque: lote + movimentação na mesma transação.
5. Estoque negativo: **bloqueado** em ajuste manual/baixa de pedido online; **permitido** quando originado de venda física (a venda prevalece), sinalizando conflito (fase 5/8).

## 4. Autenticação e autorização

- Login e-mail/senha; hash `scrypt` (Node `crypto`, sem dependência extra) com salt por usuário.
- JWT de acesso (HS256, `ACCESS_TTL`, padrão 8 h) contendo `sub` e `role`. Papéis: `admin`, `gerente`, `vendedor`.
- Permissões declaradas em `packages/shared` (`ROLE_PERMISSIONS`) e verificadas no backend por rota; a UI apenas esconde o que o papel não pode usar.
- Rate limit em `/auth/login`. Usuário inativo não autentica (checado a cada requisição autenticada).

### Autorização offline (fase 8)

Concessão assinada (**HMAC-SHA256**, chave derivada do `JWT_SECRET` por HKDF) com `{sub, role, did (deviceId), iat, exp ≤ 8 h, jti}`, emitida por `POST /auth/offline-grant` (exige sessão online). Só o servidor emite e verifica; o cliente a trata como opaca (usa as datas apenas para a interface) e **não pode forjar nem renovar** — a validade real é imposta no servidor. A sincronização é autenticada pelo próprio grant (o JWT pode ter expirado durante a queda); o papel e a ativação do usuário são lidos do banco no momento da sincronização. Cada operação precisa ter sido criada dentro da janela `[iat, exp]` (±5 min de tolerância de relógio), senão vira `conflito GRANT_EXPIRED`, não aprovável.

## 5. Offline-first e sincronização (fase 8 — implementado)

**Cliente (IndexedDB `pdv-offline`, lib `idb`):** `meta` (deviceId, sequência, sessão, grant, metadados do catálogo), `variants`, `customers`, `ops` (fila). Cada operação: `operationId` (UUID), `deviceId`, `sequence` monotônica (alocada na mesma transação que grava a venda e baixa o estoque local), `createdAt`, `dependsOn[]`, `reversesOperationId?`, `payload`, `grant` usado, `state` (`local` → `pendente` → `confirmada` | `falha_recuperavel` | `conflito`). O estado só vira `confirmada` com a resposta do servidor. Motor de envio único (Web Locks + promessa compartilhada); `pendente` interrompido por reinício é reenviado (idempotente). Catálogo não é substituído enquanto houver vendas não confirmadas.

**Servidor (`POST /sync/operations`, lote ordenado por sequência):**

1. Verifica a assinatura do grant e o `deviceId`; carrega o usuário (ativo, `sale:create`).
2. Por operação, em **uma transação**: `pg_advisory_xact_lock(operationId)`; consulta `sync_operations` — duplicata devolve o resultado anterior; hash diferente → `OPERATION_ID_REUSED`; `(device, sequence)` já usado → `SEQUENCE_REUSED`.
3. Janela do grant, permissão e dependências (`dependsOn` confirmadas; pendente → `falha_recuperavel`, em conflito → `conflito`).
4. Aplica com `createSaleTx` (mesmo serviço do online) dentro de um `SAVEPOINT`; o resultado é gravado na mesma transação. Erro inesperado (inclusive no COMMIT) → nada aplicado; resultado `falha_recuperavel` registrado em transação à parte.
5. `sales.created_at`, pagamentos e movimentação usam a data real da venda (limitada ao grant e a agora); `sales.origin = 'offline'`.

**Conflitos:** informativos (venda aplicada): `STOCK_NEGATIVE`, `PRICE_DIVERGED` (mantém o preço cobrado), `VARIANT_INACTIVE`. Bloqueantes (nada aplicado, estado `conflito`): desconto acima do limite/sem permissão, limite de crédito, variante inexistente, grant fora da janela, dependência bloqueada. Gerente/admin **aprovam** (só desconto/crédito) ou **descartam** com justificativa; auditado. Nunca estorno automático de venda física.

**Escopo offline:** somente venda paga integralmente e sem cliente. Fiado/parcial/cliente, cancelamento, devolução, estoque e configurações exigem o servidor.

## 6. Integração Nuvemshop (fase 9 — código implementado, testado com simulação, homologação pendente)

Módulo `apps/api/src/modules/nuvemshop/`: `client.ts` (adaptador HTTP, porta `NuvemshopApi`), `crypto.ts`, `connection.ts` (OAuth/estado), `events.ts` (webhooks), `orders.ts` (regras de pedido), `outbox.ts` (estoque → loja), `reconcile.ts`, `links.ts`, `worker.ts`, `routes.ts`. O adaptador é injetável (`makeApi`), por isso os testes usam uma loja falsa.

**Fonte da verdade por campo**

| Dado                                   | Fonte                            | Fluxo                                                                                      |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| Estoque disponível                     | Ledger local (`stock_movements`) | PDV → loja por **delta**; loja → PDV só por pedido pago ou decisão humana na reconciliação |
| Catálogo (nome, SKU, variantes)        | PDV                              | Não enviado; catálogo remoto é cópia somente leitura para sugerir vínculos                 |
| Preço                                  | PDV                              | Não enviado                                                                                |
| Pedido online (status/pagamento/itens) | Nuvemshop                        | Estado atual buscado na API; PDV só registra e baixa estoque                               |
| Credenciais                            | Banco (cifradas)                 | Nunca em env/log                                                                           |

**Fluxos**

- **Webhook:** valida HMAC do corpo cru → grava em `integration_events` (dedupe por hash enquanto pendente) → `200`. O worker busca o estado atual do pedido e aplica `applyOrderSnapshot` (idempotente por item). Varredura periódica por `orders_cursor` cobre eventos perdidos.
- **Outbox:** trigger grava a linha na mesma transação do movimento; worker agrega por variante (um delta), com lease por vínculo, pré-leitura do remoto, backoff, classificação de erros e parada em 401/403. Movimentos de pedido online e chaves `nuvemshop:*` não voltam ao canal.
- **Reconciliação:** leitura periódica; divergência só vira pendência após 2 leituras iguais sem itens em trânsito; resolução humana relê o remoto.
- **Conflito de canais:** nunca sobrescreve estoque remoto com valor local antigo (delta, não absoluto). Venda física confirmada nunca é cancelada por pedido online; pedido pago sem saldo vira pendência de atendimento.
- Credenciais exclusivamente cifradas no banco (AES-256-GCM); app id/secret em variáveis de ambiente do backend e do worker.

## 7. Infraestrutura

- `render.yaml`: site estático (web), web service (api) e worker. **Verificar limites vigentes dos planos gratuitos**: serviços gratuitos hibernam por inatividade e workers dedicados podem exigir plano pago — alternativa: executar o loop do worker no processo da API (`WORKER_IN_PROCESS=true`), aceitando atrasos após hibernação. Neon free também pode "dormir" (cold start).
- Migrations: `pnpm db:migrate` (comando de pré-deploy), com lock consultivo para evitar corrida.
- Config por cliente: variáveis de ambiente + (futuro) `store_settings`; identidade visual por variáveis CSS/`VITE_*`.

## 8. Decisões (ADR resumido)

| #   | Decisão                                                                                      | Motivo                                                                                                 |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | SQL puro + `pg` + migrations próprias (sem ORM)                                              | Controle fino de transações, bloqueios, triggers e constraints, centrais ao projeto                    |
| 2   | Estoque = movimentações imutáveis + saldo por trigger                                        | Auditoria e consistência garantidas no banco, não só na aplicação                                      |
| 3   | Dinheiro em centavos inteiros                                                                | Evita erros de ponto flutuante                                                                         |
| 4   | `scrypt` nativo para senhas                                                                  | Sem dependência nativa (bcrypt/argon2) para simplificar o deploy                                       |
| 5   | JWT HS256 online; grant offline HMAC (derivado do mesmo segredo, verificado só no servidor)  | Sem dependência extra; cliente não precisa verificar assinatura (UX apenas) — ver nota                 |
| 6   | Componentes shadcn/ui copiados manualmente (Radix + cva)                                     | Mesmo resultado do CLI sem depender de rede/registry                                                   |
| 7   | Tailwind v4 via plugin Vite                                                                  | Sem arquivo de config; padrão atual do shadcn                                                          |
| 8   | `packages/shared` consumido como TS fonte (API empacotada com tsup)                          | Evita etapa de build do pacote em dev                                                                  |
| 9   | Testes de integração em PostgreSQL real                                                      | Regras de integridade dependem de triggers/constraints                                                 |
| 10  | Fatos financeiros imutáveis; correção por registro compensatório                             | Auditoria; estorno/devolução nunca editam vendas, pagamentos ou movimentos                             |
| 11  | Status de pagamento, recebido e saldo derivados em views                                     | Nada denormalizado, sem divergência possível                                                           |
| 12  | Idempotência por chave única + advisory lock + hash do payload                               | Reenvio nunca duplica; mesma chave com dados diferentes → 409                                          |
| 13  | Locks: estoque ordenado por variante, cliente e venda `for update`                           | Sem deadlock; limite de crédito, devoluções e cancelamentos serializados                               |
| 14  | Constraint triggers deferidos validam a venda no COMMIT                                      | Última barreira contra inconsistência mesmo com bug na aplicação                                       |
| 15  | Desconto por item em centavos; limite por papel em `role_discount_limits`                    | Rateio exato; política alterável só pelo admin                                                         |
| 16  | Estoque insuficiente bloqueia a venda online                                                 | "Venda física prevalece" fica para a sincronização offline (fase 8)                                    |
| 17  | Devolução: abate débito primeiro, reembolsa o restante exato                                 | Sem diferença de caixa; arredondamento acumulado soma o total da linha                                 |
| 18  | Caixa não duplica dinheiro: `payments.cash_session_id` classifica                            | Uma só fonte financeira; relatórios por modalidade sem contagem dupla                                  |
| 19  | Operação financeira exige caixa aberto do próprio operador (trigger)                         | Rastreia responsável; nada entra em caixa fechado ou alheio                                            |
| 20  | Estorno lançado no caixa de quem o executa; original intocado                                | Caixas fechados permanecem imutáveis; correção por compensação                                         |
| 21  | `cash_session_expected()` única + constraint trigger no fechamento                           | O esperado gravado sempre é a fórmula (só dinheiro físico)                                             |
| 22  | Recebimento de fiado = `debt_receipts` + `payments` (kind recebimento)                       | Saldo derivado dos pagamentos; estorno reverte todos os pagamentos do original                         |
| 23  | Vencimento opcional em `sales.due_date`, sem juros nem bloqueio                              | Regra de negócio definida; bloqueio/juros exigiriam decisão expressa                                   |
| 24  | E2E Playwright em `e2e/` (workspace próprio, fora do `pnpm test`)                            | Depende de servidores e banco; roda via `pnpm e2e` e no CI                                             |
| 25  | Relatórios derivados (nenhum total gravado), leitura em snapshot repeatable read             | Números consistentes entre si e com o caixa; sem divergência possível                                  |
| 26  | Faturamento (competência) separado de recebimento (caixa) e fiado em aberto                  | Evita confundir venda com dinheiro entrado                                                             |
| 27  | Cancelamentos/devoluções abatem o faturamento na data do evento                              | Períodos fechados não mudam retroativamente; soma de períodos fecha                                    |
| 28  | CSV com BOM, `;`, vírgula decimal e neutralização de fórmulas; exportação auditada           | Abre no Excel pt-BR sem risco de injeção; rastreia quem exportou                                       |
| 29  | Datas reais do calendário validadas (`isRealDate`)                                           | 30/02 não pode virar 500 nem rolar para março                                                          |
| 30  | Sync autenticada pelo grant; operações idempotentes por `operationId` + lock                 | JWT pode expirar offline; reenvio/concorrência nunca duplicam venda                                    |
| 31  | Venda física offline sempre aplicada; divergências viram conflito informativo                | Regra central do negócio; bloqueio só para desconto/crédito/autorização                                |
| 32  | Offline só para venda paga integralmente e sem cliente                                       | Fiado/crédito exigem validação do servidor (spec: operações que exigem confirmação)                    |
| 33  | Mesma chave `op:<uuid>` no envio online e na fila offline                                    | Queda durante o envio não duplica a venda                                                              |
| 34  | Operação offline carrega o caixa de origem; regularização auditada em caixa fechado          | Venda nunca é reatribuída em silêncio; sem duplicidade financeira (`regularization`)                   |
| 35  | Estoque → Nuvemshop por delta, nunca absoluto (absoluto só por decisão humana)               | Preserva edições legítimas feitas na loja; substitui a ideia inicial de saldo absoluto                 |
| 36  | Outbox por trigger em `stock_movements`                                                      | Impossível haver movimento sem fila; núcleo não conhece a Nuvemshop                                    |
| 37  | Pedido: buscar estado atual na API, não confiar no evento                                    | Duplicados/fora de ordem/atrasados convergem; baixa idempotente por item                               |
| 38  | Reconciliação exige 2 leituras iguais e sem itens em trânsito                                | Evita falso conflito por pedido que a loja já reservou e o PDV ainda não processou                     |
| 39  | Registro de webhooks e OAuth só por ação explícita do admin                                  | Nenhuma alteração automática na loja real                                                              |
| 40  | Envio de estoque em lote com base/delta gravados antes da chamada; retry resolve por leitura | `variation` não é idempotente: resposta perdida nunca gera aplicação dupla (ambíguo → `envio_incerto`) |
| 41  | `sem_estoque` só é baixado por decisão humana                                                | Evita baixa em dobro quando o estoque local é acertado por outro caminho                               |
| 42  | Dedupe de webhook só contra evento `pendente`                                                | Reentrega durante o processamento gera nova leitura do pedido                                          |

## 9. Riscos conhecidos

- Duplicidade/ordem de eventos offline (mitigação: `operationId`, `seq`, `dependsOn`).
- Venda física offline × pedido online simultâneo → estoque negativo temporário (regra: venda prevalece; pendência para o operador).
- Limites/hibernação dos planos gratuitos (Render, Neon) afetando worker e webhooks.
- Limpeza de storage pelo navegador: mitigada com `navigator.storage.persist()`, mas sem garantia absoluta; operações pendentes devem ser sincronizadas o quanto antes.
