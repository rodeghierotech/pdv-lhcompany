# PLANO — PDV LH Company

Legenda: ✅ implementado e verificado · 🟡 parcial · ⬜ não iniciado · 🔌 depende de credenciais/serviço externo

> Atualizado a cada fase com o estado **real**. Última atualização: 2026-11-20 (fases 0–3 e 5–8 concluídas; 4 parcial — falta validar instalação do PWA em dispositivo real; **fase 9: código implementado e testado com simulação, homologação pendente**; fase 10 não iniciada).

## Fase 0 — Documentação e fundação ✅

- [x] `AGENTS.md`, `PLANO.md`, `docs/ARQUITETURA.md`, `docs/DESIGN_SYSTEM.md`
- [x] Monorepo pnpm (`apps/web`, `apps/api`, `packages/shared`)
- [x] TypeScript strict, ESLint, Prettier, Vitest
- [x] `.env.example`, `render.yaml` (⚠️ não testado em deploy real — ver "Pendências")

**Verificado:** `pnpm check` (typecheck + lint + format + testes + build) passa.

## Fase 1 — Banco e acesso a dados ✅

- [x] Migrator SQL próprio (forward-only, transação por migration, lock consultivo)
- [x] Schema `001_init.sql`: usuários, auditoria, categorias, produtos, variantes, lotes, movimentações, saldo
- [x] Triggers: movimentações/lotes/auditoria imutáveis; saldo derivado e protegido contra escrita direta; estorno valida o original
- [x] Testes em PostgreSQL 16 real (9) provando imutabilidade, saldo, estorno único, rollback

## Fase 2 — Backend, autenticação e autorização ✅ (escopo da vertical)

- [x] Login, JWT HS256 (8 h), papéis `admin`/`gerente`/`vendedor`, permissões em `packages/shared`
- [x] Usuário recarregado do banco a cada requisição (desativação vale imediatamente)
- [x] Hash scrypt, resposta uniforme p/ credencial inválida, rate limit no login
- [x] Erros centralizados, logs estruturados (pino) com redação de `Authorization`
- [x] Auditoria transacional de ações sensíveis
- [ ] Gestão de usuários na UI (existe só `POST /users` e script `create-admin`)
- [x] Autorização offline assinada (HMAC, ≤ 8 h) → Fase 8

## Fase 3 — Produtos, variantes e estoque (vertical) ✅

- [x] API: categorias, produtos, variantes, entradas (lote), ajustes e estornos — todos idempotentes
- [x] Saldo negativo bloqueado em ajuste/estorno, inclusive sob concorrência (testado)
- [x] Web: login, lista/busca (nome, SKU, código de barras), cadastro, detalhe, edição de variante, entrada, ajuste, histórico + estorno, estoque baixo
- [x] 23 testes de API + 9 de integridade + 15 do pacote shared (47 no total)
- [x] Fluxo ponta a ponta validado no navegador (Playwright): login → cadastro → entrada → ajuste → estorno → busca → offline → logout
- [x] E2E Playwright versionado em `e2e/` (executado no CI; ver Fase 6). O E2E manual desta fase não foi versionado, mas o fluxo de login/cadastro/estoque ainda não tem spec própria

## Fase 4 — Interface principal e design system 🟡

- [x] Layout, navegação, componentes base shadcn-style, indicador online/offline, responsivo (sem overflow a 390 px)
- [x] PWA: manifest + service worker (apenas shell em cache; **API nunca é cacheada**)
- [x] Atalhos de teclado e tela de vendas (Fase 5: F2 busca, F9 finaliza)
- [ ] Validação de instalabilidade do PWA em dispositivo real

## Fase 5 — Vendas e pagamentos ✅

- [x] Migration `002_sales.sql`: vendas, itens, pagamentos (recebimento/estorno), devoluções, limites de desconto por papel, clientes; fatos imutáveis; views derivam status de pagamento/saldo; constraint triggers (`check_sale_integrity`) como última barreira no COMMIT
- [x] API: `/pos/variants`, `/sales` (criar/listar/detalhe), `/sales/:id/cancel`, `/sales/:id/returns[/preview]`, `/customers`, `/settings/discount-limits`
- [x] Baixa de estoque transacional e idempotente (chave + `request_hash`; locks ordenados, sem deadlock); estoque insuficiente bloqueia (422)
- [x] Pagamento misto, parcial e fiado (saldo vira débito do cliente, sem juros; cliente obrigatório; limite de crédito configurável, sem limite por padrão)
- [x] Desconto por item em centavos, limite por papel (admin/gerente 100%, vendedor 0%; só admin altera); preço desatualizado → 409 `PRICE_CHANGED`
- [x] Cancelamento total (estorna recebimentos + movimentos `estorno`) e devolução parcial/total (abate débito primeiro, reembolso do excedente = valor exato)
- [x] Frontend: PDV (`/vender`), histórico (`/vendas`), detalhe com cancelar/devolver, configurações (`/configuracoes`, admin)
- [x] Testes: shared 31, web 9 (carrinho), API 83 (51 de vendas: integridade, autorização, concorrência, idempotência). Mutation testing confirmou que os testes de concorrência detectam remoção dos locks
- [x] Validado no navegador (Playwright): login → busca → carrinho → desconto → pagamento misto/parcial → finalizar → detalhe → devolução → cancelamento → configurações; estoque e status consistentes no banco
- [ ] Sem testes de UI versionados no CI (E2E foi scriptado, fora do repositório)
- [ ] Recebimento posterior de fiado/parcial → Fase 6; "a venda física prevalece" (estoque negativo offline) → Fase 8 ✅
- [ ] Impressão de recibo e troco persistido (troco é só exibição na tela)

## Fase 6 — Caixa, clientes e fiado ✅

- [x] Migration `003_cash.sql`: `cash_sessions`, `cash_movements` (sangria/suprimento/despesa/estorno), `debt_receipts`; `payments`, `sales` e `sale_returns` ganham o vínculo ao caixa; vencimento opcional em `sales.due_date`
- [x] **Fonte única da verdade financeira = `payments`**: o caixa só classifica pagamentos (`cash_session_id`) e acrescenta movimentos próprios; nada é copiado, então nada é contado duas vezes
- [x] Um caixa aberto por operador; vender, receber, devolver, cancelar e movimentar exigem caixa aberto **do próprio operador** (trigger no banco + service). Estornos saem do caixa de quem os executa; o caixa original nunca é alterado
- [x] Dinheiro esperado = abertura + dinheiro líquido (recebido − estornado) + suprimentos − sangrias − despesas (função SQL única, conferida por constraint trigger no fechamento). PIX/débito/crédito aparecem por modalidade e não alteram a gaveta; saída maior que a gaveta é recusada
- [x] Fechamento com conferência (contado × esperado), justificativa obrigatória se houver diferença, responsável e horário; sessão fechada é imutável
- [x] Recebimento posterior (saldo geral do cliente, mais antigo primeiro, ou de uma venda): parcial/total, misto, nunca acima do saldo; idempotente; concorrência serializada (cliente e venda `for update`); estorno de recebimento compensatório (só gerente/admin)
- [x] Cancelar venda/devolver reaproveita os mesmos registros: estorna também recebimentos posteriores, abate dívida antes de reembolsar
- [x] Clientes: edição, conta-corrente, dívidas em aberto/vencidas, histórico de pagamentos e de compras, limite de crédito (só gerente/admin definem). Vencimento opcional, **não bloqueia vendas**; sem juros
- [x] Permissões: `cash:open/close/read` (vendedor inclusive), `cash:movement/manage`, `debt:receive` (vendedor inclusive), `debt:reverse` e vencimento (gerente/admin). Auditoria de abertura, movimentos, recebimentos, estornos e fechamento
- [x] Telas: `/caixa` (abertura, painel, sangria/suprimento/despesa, fechamento), `/caixa/historico`, `/caixa/sessoes/:id`, `/clientes`, `/clientes/:id` (conta-corrente), `/fiado`; PDV bloqueia sem caixa e aceita vencimento; detalhe da venda recebe saldo e altera vencimento
- [x] Testes: API 139 (56 de caixa/fiado: abertura/fechamento, modalidades, parcial/quitação, duplicidade, concorrência, sangria/suprimento, diferenças, estornos/devoluções, permissões, triggers), shared 35, web 9
- [x] E2E Playwright versionado (`e2e/`, `pnpm e2e`, job no `.github/workflows/ci.yml`): 2 fluxos completos (abertura → vendas → fiado parcial → recebimentos → sangria → fechamento com diferença; devolução/cancelamento/vendedor)
- [ ] Workflow de CI **nunca executado** (sem remoto); validado apenas localmente
- [ ] Despesas sem plano de contas/relatório próprio (categoria livre) → Fase 7
- [ ] Sem juros/multa, sem bloqueio por vencimento (por decisão), sem negociação/parcelamento de dívida
- [ ] Sem reabertura de caixa fechado e sem caixa compartilhado entre operadores (cada operador tem o seu)
- [ ] Vendas anteriores à 003 ficam "sem caixa" (apenas dados de desenvolvimento)
- [ ] Sem relatório consolidado do dia/loja (Fase 7); recibo para impressão inexistente

## Fase 7 — Dashboard e relatórios ✅

- [x] Módulo `reports` **somente leitura** (nada é gravado/denormalizado): derivado de `sales`, `payments`, `cash_movements`, `sale_summary`; resumo lido num snapshot `repeatable read` (números do mesmo relatório nunca divergem)
- [x] Definições explícitas: **faturamento** = vendas feitas no período (competência); **líquido** = bruto − cancelamentos − devoluções (pela data do evento, soma entre períodos fecha); **recebido** = `payments` por data (vendas + fiado − estornos); **em aberto** = posição atual do fiado (não depende do período); ticket médio = vendas não canceladas
- [x] Endpoints (`report:read`, só gerente/admin): `/reports/summary`, `/daily`, `/top-products`, `/sellers`, `/recent`, `/sales.csv`, `/payments.csv` (CSV pt-BR com BOM, proteção contra injeção de fórmula, limite de linhas, auditado, `no-store`)
- [x] Período por datas no fuso da loja (America/Sao_Paulo), máximo 366 dias; datas inexistentes (ex.: 30/02) rejeitadas com 400 — **corrigido bug de 500** que também afetava o vencimento do fiado
- [x] Painel `/painel`: períodos rápidos e personalizado, faturamento × recebido × fiado em aberto, gráfico por dia (SVG), recebimentos por modalidade, despesas por categoria (descontando estornos), mais vendidos (líquido de devoluções), vendedores, resumo de caixa (abertos, faltas/sobras), estoque baixo, movimentações recentes; exportação CSV; responsivo (sem overflow a 390 px)
- [x] Testes: API 19 de relatórios (fonte única: soma dos caixas = relatório da loja; estornos, cancelamento, devolução, fiado, despesas, fronteira do dia, validação, autorização, somente leitura, CSV, CORS), shared 39, web 12 (API total 158); E2E Playwright 4 specs (painel com deltas, CSV baixado, vendedor bloqueado)
- [ ] Sem comparação com período anterior, metas, margem/lucro (custo existe nos lotes, mas CMV não foi definido) nem fechamento contábil
- [ ] Despesas por categoria livre (sem cadastro de categorias)
- [ ] Gráfico simples (sem zoom/tooltip rico); sem relatório por cliente/categoria de produto
- [ ] Desempenho não medido com grande volume (consultas agregadas sem índice dedicado de período além dos existentes)

## Fase 8 — Offline real e sincronização ✅

- [x] Migration `004_sync.sql`: `devices`, `sync_operations` (PK `operation_id`, `UNIQUE(device_id, sequence)`, hash do conteúdo, `depends_on`, `reverses_operation_id`, estado, tentativas, erro, resolução), `sync_conflicts`; `sales.origin` (`online`/`offline`) e `sales.sync_operation_id`
- [x] **Autorização offline assinada** (HMAC-SHA256, chave derivada do `JWT_SECRET`; validade ≤ 8 h; só o servidor emite — `POST /auth/offline-grant` — e verifica; não é renovável offline). A sincronização é autenticada **pelo grant** (o JWT pode ter expirado durante a queda). Operação criada fora da janela do grant → `conflito GRANT_EXPIRED` (não aprovável)
- [x] `POST /sync/operations`: lote ordenado por sequência; cada operação em transação própria com `pg_advisory_xact_lock(operationId)`; deduplicação (mesmo `operationId` devolve o resultado anterior; conteúdo diferente → `OPERATION_ID_REUSED`; sequência reutilizada → `SEQUENCE_REUSED`); dependências (`DEPENDENCY_PENDING` recuperável / `DEPENDENCY_BLOCKED`); aplica pelo **mesmo** `createSaleTx` do fluxo online (venda, itens, pagamentos, baixa de estoque) com data real (`occurredAt`, limitada à janela do grant e a agora)
- [x] **Venda física prevalece**: estoque insuficiente → saldo negativo + conflito informativo `STOCK_NEGATIVE`; preço divergente → mantém o preço cobrado + `PRICE_DIVERGED`; produto inativo → `VARIANT_INACTIVE`. Nunca estorno automático
- [x] Conflitos bloqueantes (desconto acima do limite/sem permissão, limite de crédito, variante inexistente, grant expirado) → estado `conflito`, nada é aplicado. `POST /sync/operations/:id/resolve` (gerente/admin, `sync:resolve`, justificativa obrigatória): **aprovar** (só desconto/crédito; reaplica) ou **descartar**; `GET /sync/issues`; ciência de divergências informativas; tudo auditado
- [x] Falha recuperável (`CASH_NOT_OPEN`, erro inesperado no meio da transação/COMMIT): nada é aplicado, resultado e tentativas registrados; reenvio seguro
- [x] `GET /sync/catalog`: variantes ativas com estoque, clientes e limite de desconto do papel
- [x] Frontend: IndexedDB (`idb`) com catálogo, clientes, fila e metadados; `navigator.storage.persist()`; `deviceId` persistente; sequência alocada na mesma transação do enfileiramento (que também baixa o estoque **local**); motor de sync com Web Locks (um envio por vez); catálogo **não** é substituído enquanto houver vendas não confirmadas
- [x] Sessão retomada offline a partir do usuário salvo + grant válido (sem grant válido → login exige conexão); renovação do grant só online; reconexão (evento + sonda `/health`) dispara envio, grant e catálogo
- [x] PDV offline: busca no catálogo local; **somente venda paga integralmente e sem cliente** (fiado/parcial/cliente exigem o servidor); a chave da venda é `op:<uuid>` — se a conexão cai durante o envio online, a venda vai à fila com o MESMO operationId (sem duplicar)
- [x] UI: estados `local/pendente/confirmada/falha_recuperavel/conflito` (`SyncBadge`), "NÃO confirmada" até a resposta do servidor, indicador no cabeçalho, `/sincronizacao` (estado do aparelho, fila local, conflitos do servidor com aprovar/descartar), bloqueio de logout offline com vendas pendentes
- [x] Testes: API +17 (`sync.test.ts`: grant adulterado/outro aparelho/expirado, reenvio e reenvios simultâneos, venda online × física do mesmo produto, preço divergente, dois dispositivos, operationId/sequência reutilizados, caixa fechado → reenvio, dependências, falha no meio da transação com trigger de falha, aprovar/descartar/permissões, não aprovável, crédito, catálogo); web +11 com `fake-indexeddb` (fila, sequência, reinício com pendentes, grant, estados, falha de rede, envio único, catálogo protegido). Total: API 175, shared 39, web 23
- [x] E2E (`e2e/tests/offline.spec.ts`, build de produção + Service Worker + `context.setOffline`): sincroniza online → recarrega offline (sessão retomada) → venda offline → fiado bloqueado → reinício com venda pendente → logout bloqueado → reconecta → "Confirmada" e estoque do servidor baixa. Suíte E2E: 5 specs passando
- [ ] Cancelamento/devolução offline **não** implementados (exigem confirmação do servidor; `reversesOperationId` já é armazenado e validado como FK, sem tipo de operação que o use)
- [ ] Venda offline fiada/parcial/com cliente não suportada (decisão: exige validação de crédito no servidor)
- [x] **Correção (migration `005_offline_cash.sql`)**: a operação carrega o `cashSessionId` do caixa em que a venda foi feita. Origem aberta → a venda entra nela; origem fechada → conflito `CASH_SESSION_CLOSED` (aprovável por gerente/admin) — **nunca** é atribuída automaticamente ao caixa aberto na sincronização. Caixa de outro operador/desconhecido/ainda não aberto → conflito não aprovável. A **regularização** auditada (`cash_regularizations`, imutável) lança a venda UMA vez no caixa aberto do vendedor (`sales/payments.origin_cash_session_id`, `payments.regularization=true`, excluída de `cash_session_expected` → sem duplicidade financeira); o fechamento original permanece intacto. Testes: queda com fechamento de caixa, sincronização no dia seguinte, reenvio idempotente, regularização única
- [ ] Risco residual: grant roubado + `deviceId` permite enviar vendas dentro da janela de 8 h (mitigado por `operationId`/sequência únicos, limite da janela, trânsito por TLS e auditoria; sem atestado de dispositivo)
- [ ] Sem validação em dispositivo real (queda de rede física/instalação do PWA); `LOGIN_RATE_LIMIT` configurável para a suíte E2E

## Fase 9 — Nuvemshop 🟡 🔌

> **Revisão técnica final (2026-11-20):** auditoria do módulo contra a documentação oficial, correções com testes de regressão (migration `007`) e roteiro de homologação em [`docs/HOMOLOGACAO_NUVEMSHOP.md`](docs/HOMOLOGACAO_NUVEMSHOP.md). Corrigido: reaplicação de delta após resposta HTTP perdida (lote de envio com leitura do remoto; `envio_incerto`), baixa em dobro de pedido `sem_estoque`, descarte de webhook durante processamento, divergência falsa com evento de pedido pendente, resolução sobre fila pendente, bloqueio de locations só na variante, `code`/`state` do OAuth no log, `order/edited`. **Continua sem nenhuma verificação contra a API real.**

> **Níveis de verificação** (nada abaixo foi executado contra a API real — não há credenciais nem loja de homologação):
>
> | Nível                            | Estado                                                                                                                                |
> | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
> | **Código implementado**          | Todo o módulo (itens ✅ abaixo)                                                                                                       |
> | **Testado com simulação**        | 43 testes de API com loja Nuvemshop falsa em memória + cliente HTTP com `fetch` simulado; E2E da tela com a integração desconectada   |
> | **Pendente de homologação**      | Todo o fluxo real: OAuth, registro de webhooks, formato real dos payloads/cabeçalhos, semântica de estoque em pedido, limites de taxa |
> | **Verificado contra a API real** | **Nenhum item**                                                                                                                       |

Contratos baseados na documentação oficial (nuvemshop.dev, API versão estável `2025-03`; sem endpoints experimentais): OAuth `POST /apps/authorize/token`, `Authorization: Bearer`, `User-Agent` obrigatório, `GET/POST /products`, `POST /products/{id}/variants/stock` (`action: variation|replace`), `GET /orders`, webhooks com `x-linkedstore-hmac-sha256`, limite por `x-rate-limit-*` (429).

- [x] Migration `006_nuvemshop.sql`: `integration_connections`, `integration_oauth_states`, `external_catalog_cache`, `external_variant_links`, `integration_events`, `online_orders`/`online_order_items`, `integration_issues`, `integration_outbox`; tipos de movimento `pedido_online`/`estorno_pedido_online`; **trigger** `enqueue_nuvemshop_stock` (outbox transacional: o movimento e a fila nascem na mesma transação — única ligação do núcleo com o módulo)
- [x] Adaptador de API (`client.ts`, porta `NuvemshopApi`): timeout, classificação de erros (auth/rate_limit/transient/permanent/not_found), paginação, leitura de `x-rate-limit-*`
- [x] Credenciais: OAuth com `state` de uso único (10 min), token cifrado AES-256-GCM (chave `INTEGRATION_ENCRYPTION_KEY` ou derivada do `JWT_SECRET`), nunca exibido nem logado; desconectar apaga o token; `app/uninstalled`/`store/redact` revogam
- [x] Vínculo produto/variante por **IDs externos** (SKU só sugere), linha de base de estoque lida no vínculo (diferença não é sobrescrita), importação de catálogo somente leitura
- [x] Webhooks: HMAC sobre o corpo cru, resposta rápida, dedupe por hash do corpo enquanto o evento não foi processado, processamento assíncrono com backoff; lojas desconhecidas ignoradas
- [x] Pedidos: sempre busca o **estado atual** na API (eventos repetidos/fora de ordem/atrasados convergem); snapshot mais antigo descartado; não pago → sem baixa; pago → baixa 1× por item; sem estoque → pendência `sem_estoque` (nada cancelado, saldo nunca negativo); item sem vínculo → `item_nao_mapeado`; cancelado → repõe só o que foi baixado e se `restock_on_cancel`; reembolso após baixa → `reembolso_revisar` (sem estorno automático); pedido editado após baixa → `pedido_editado`; **não cria venda/pagamento físico**
- [x] Estoque PDV → Nuvemshop: **delta** coalescido por variante (nunca valor absoluto → edição direta na loja é preservada), lease por vínculo, pré-leitura do remoto (reenvio após resposta perdida não aplica duas vezes), backoff `30 s·2ⁿ` (teto 1 h, ±25 %), 8 tentativas, 429 respeita `x-rate-limit-reset`, 401/403 → `autorizacao_invalida` (para o envio; vendas continuam). Venda física offline sincronizada depois gera o mesmo envio
- [x] Reconciliação periódica: compara remoto × local; só abre `estoque_divergente` após 2 leituras iguais e sem envio/pedido em trânsito; ações humanas `aceitar_remoto` (ajuste local auditado, não volta ao canal), `enviar_local` (relê o remoto antes; `REMOTE_CHANGED` se mudou), `ignorar`; varredura de pedidos atualizados cobre webhooks perdidos (cursor)
- [x] Worker (`pnpm --filter @pdv/api worker`; `worker:prod`): eventos → outbox → varredura/reconciliação a cada `RECONCILE_INTERVAL_MIN`; seguro com várias instâncias
- [x] API `/integrations/nuvemshop/*` e `/integrations/{issues,events,outbox,orders}` com permissões `integration:read` (lê), `integration:manage` (admin+gerente: vincular, resolver, reprocessar, sincronizar) e `integration:admin` (admin: webhooks, desconectar, regra de reposição); registro de webhooks e OAuth **só por ação explícita**; auditoria
- [x] UI `/integracoes`: conexão/diagnóstico (último evento, último estoque **confirmado pela loja**, reconciliação, limite de taxa), produtos vinculados/não vinculados com sugestão por SKU, pendências com resolução, pedidos online, fila de estoque (só "confirmado pela loja" após resposta externa; "NÃO confirmado" enquanto houver pendência), eventos, reprocessamento manual
- [x] Testes (API +43): HMAC, webhook duplicado/fora de ordem/simultâneo, pedido pago/cancelado/sem estoque/sem vínculo/reembolso, venda física durante indisponibilidade, venda offline sincronizada depois, falha temporária + backoff, resposta perdida, edição direta na loja, 401/429/erro permanente, concorrência de envio, reconciliação e resolução, varredura, credencial ausente/ilegível/revogada, OAuth, cliente HTTP, permissões. E2E: 2 specs. Totais: API 238 (após a revisão técnica: +17 regressões), shared 39, web 24, E2E 7 specs
- [ ] 🔌 Nenhuma chamada real à Nuvemshop: confirmar contratos (campos de pedido/variante, `x-rate-limit-*`, assinatura) em loja de homologação — roteiro H1–H19 em `docs/HOMOLOGACAO_NUVEMSHOP.md`. Contratos de OAuth, estoque, webhooks e pedidos foram **conferidos na documentação** (não na API)
- [ ] 🔌 A documentação não informa **quando** a Nuvemshop baixa o estoque de um pedido (criação × pagamento); a reconciliação tolera pedidos em trânsito, mas o comportamento real precisa ser observado
- [ ] Lojas com **múltiplas locations**: não suportado (bloqueio por variante **e** por loja; pendência `multiplas_locations`, sem envio automático) — a documentação não diz qual location recebe o ajuste do endpoint de estoque
- [ ] Preço/catálogo local → Nuvemshop **não** sincronizados (decisão: catálogo e preço = PDV, sem push); estoque ilimitado na loja não recebe ajuste
- [ ] Reembolso de pedido online e devolução física de item vinculado a pedido: revisão manual
- [ ] Worker dedicado no Render exige plano pago (ver `render.yaml`); não implantado
- [ ] Pendente de homologação: quando a loja baixa estoque de pedido (criação × pagamento) e de qual location; efeito de `restock=false`; unidade de `x-rate-limit-reset`; escopos mínimos; semântica de `order/edited`

## Fase 10 — Produção ⬜

Testes obrigatórios (lista da especificação §10), observabilidade, deploy Render/Neon, backups.

---

## Decisões que dependem do negócio (a confirmar)

- ✅ Decididos na Fase 5: desconto por papel (inicialmente só gerente/admin); fiado sem juros; limite de crédito configurável por cliente, sem limite automático; formas: dinheiro, PIX, débito, crédito e misto.
- ✅ Fase 6: vencimento do fiado opcional, sem juros e sem bloqueio automático.
- Estoque negativo por venda física offline: permitido (a venda prevalece) e sinalizado como conflito.
- Formas de pagamento habilitadas (dinheiro, PIX, débito, crédito…).

---

## Pendências e dependências externas

- 🔌 **Neon**: nenhum teste contra o Neon real (usado PostgreSQL 16 local). Falta informar `DATABASE_URL`.
- 🔌 **Render**: `render.yaml` escrito mas **nunca implantado**; free tier hiberna e não tem pre-deploy (migrations rodam no start).
- 🔌 **Nuvemshop**: módulo implementado e testado só com simulação (Fase 9); exige app (`NUVEMSHOP_APP_ID/CLIENT_SECRET`), `PUBLIC_API_URL` HTTPS acessível pela Nuvemshop, loja de homologação e **autorização explícita** antes de qualquer alteração na loja de produção.
- E2E: `pnpm e2e` exige banco migrado (`DATABASE_URL`, `JWT_SECRET`) e admin (`E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD`); usa Chromium do Playwright.
- Primeiro admin: `ADMIN_NAME/ADMIN_EMAIL/ADMIN_PASSWORD` + `pnpm --filter @pdv/api create-admin`.
- Sem rate limit global (apenas no login) e sem CSRF (token Bearer em `localStorage`; risco de XSS mitigado por não renderizar HTML de usuário — rever na Fase 10).
