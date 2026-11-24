# Homologação Nuvemshop — procedimento e checklist

> **Escopo:** loja de TESTE da Nuvemshop, dados controlados. **Nunca** use a loja de produção sem autorização expressa.
> Até aqui nada foi executado contra a API real: tudo abaixo marcado "pendente" só se confirma nesta homologação.

## 1. Contratos verificados na documentação oficial (nuvemshop.dev / tiendanube.github.io, API `2025-03`)

| Tema      | Documentação diz                                                                                                                                                                                                                                                                                                                                      | Uso no PDV                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| OAuth     | `GET https://www.nuvemshop.com.br/apps/{app_id}/authorize`; `POST …/apps/authorize/token` (JSON `client_id`, `client_secret`, `grant_type=authorization_code`, `code` — expira em 5 min); resposta `access_token`, `token_type`, `scope`, `user_id` (= id da loja); **token não expira**, só invalida em reinstalação/desinstalação                   | `connection.ts`, `client.ts`                            |
| Estoque   | `POST /products/{id}/variants/stock` `{action: variation\|replace, value, id}`; `variation` somado, **retirar além do disponível resulta em 0, sem erro**; **idempotência não documentada** (`variation` é cumulativo); 200 devolve as variantes atualizadas                                                                                          | delta por `variation`; lote com leitura prévia (ver §2) |
| Locations | Com 1 location ativa, `inventory_levels` tem 1 item; com várias, o estoque é alterado por `PUT /products/{id}/variants/{id}` com `location_id`. **O endpoint de estoque não documenta qual location recebe o ajuste**                                                                                                                                 | **bloqueado** com >1 location (variante ou loja)        |
| Webhooks  | 2xx em **3 s**; até 16 tentativas em 48 h; **ordem não garantida; duplicatas possíveis** (idempotência é do receptor); HMAC-SHA256 do corpo cru em `x-linkedstore-hmac-sha256`; eventos `order/{created,updated,paid,cancelled,pending,voided,edited,…}`, `app/uninstalled`, `store/redact`                                                           | `events.ts`                                             |
| Pedidos   | `status` open/closed/cancelled; `payment_status` authorized/pending/paid/partially_paid/abandoned/refunded/partially_refunded/voided; `GET /orders?updated_at_min`; cancelar `POST /orders/{id}/cancel` com `restock` (padrão **true**); criação via API tem `inventory_behaviour` `bypass` (padrão) ou `claim`, e `location_id` define de onde baixa | `orders.ts`                                             |

### Pendente de homologação (a documentação **não** informa)

1. **Quando a Nuvemshop baixa o estoque de um pedido da loja virtual** (criação × pagamento) e de qual location. O PDV assume que a loja baixa o próprio estoque e **não** reenvia a baixa de pedido online ao canal; se isso for falso, o saldo remoto ficará acima do local e a reconciliação abrirá `estoque_divergente`.
2. Se cancelar com `restock=false` (ou cancelamento feito pelo painel) devolve estoque na loja. O PDV repõe o local se `restock_on_cancel` estiver ligado; divergência aparece na reconciliação.
3. Formato real dos campos de pedido/variante (`updated_at`, `products[].variant_id`, `inventory_levels`) e do cabeçalho `Link` de paginação.
4. Unidade e comportamento de `x-rate-limit-*` (assumido: `reset` em ms) e limites reais.
5. Escopos mínimos necessários (previsto: `read_products write_products read_orders`; confirmar se `locations` exige escopo próprio).
6. Se a resposta do `variation` lista a variante com `stock` resultante (o PDV usa quando existe; senão calcula).
7. Comportamento de `order/edited` e se `order/updated` cobre edições de itens.

## 2. Revisão técnica (correções aplicadas — migration `007`)

| #   | Achado                                                                                                                                | Correção                                                                                                                                                                                                                                                                                                                       | Teste de regressão                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | Resposta HTTP perdida + nova venda antes do retry somava os deltas e reaplicava o já aplicado                                         | **Lote de envio** gravado antes da chamada (`batch_id/base/delta`); linhas novas não entram em lote em dúvida; retry relê o remoto: `== max(0, base+delta)` → já aplicado; `== base` → reenvia o mesmo delta; outro valor → conflito `envio_incerto` (decisão humana). Recusas comprovadas (401/403/404/422/429) limpam o lote | resposta perdida + venda nova; falha antes de aplicar; remoto mudou; lote bloqueia novas linhas; 422 |
| 2   | `sem_estoque` era rebaixado a cada evento: se o operador acertava o estoque (ex.: aceitar o saldo da loja), o pedido baixava em dobro | `sem_estoque` não é reprocessado sozinho; ações humanas `baixar_agora` (1×, idempotente) e `ignorar`                                                                                                                                                                                                                           | pedido sem estoque + evento posterior + baixar/ignorar                                               |
| 3   | Webhook idêntico recebido **durante** o processamento era descartado (leitura antiga do pedido ficava)                                | Dedupe só contra evento ainda `pendente`                                                                                                                                                                                                                                                                                       | reentrega durante processamento                                                                      |
| 4   | Reconciliação podia abrir divergência com webhook de pedido ainda não processado                                                      | Não abre enquanto há evento `order/*` pendente/processando/em falha                                                                                                                                                                                                                                                            | evento de pedido não processado                                                                      |
| 5   | Resolução de divergência com envio pendente aplicaria o delta por cima                                                                | Recusa `PENDING_OUTBOX`/`LINK_BUSY`; `enviar_local` roda sob lock do saldo e só grava a resolução após o envio                                                                                                                                                                                                                 | resolução com envio pendente                                                                         |
| 6   | Bloqueio de múltiplas locations só olhava a variante                                                                                  | Também conta locations da **loja** (`GET /locations`) em vínculo, envio, reconciliação e resolução                                                                                                                                                                                                                             | locations da loja                                                                                    |
| 7   | `code`/`state` do OAuth apareciam na URL registrada pelo log                                                                          | Serializer de log com `redactUrl`; corpo de erro 4xx sem token                                                                                                                                                                                                                                                                 | log sem code/state; erro sem token                                                                   |
| 8   | `order/edited` não era assinado                                                                                                       | Adicionado                                                                                                                                                                                                                                                                                                                     | teste de assinatura                                                                                  |

Confirmado **sem alteração**: token nunca em respostas/logs/status (cifrado AES-256-GCM; teste varre todas as rotas GET); eventos fora de ordem/duplicados convergem (estado atual buscado na API, `remote_updated_at`, lock por pedido, baixa idempotente por item); estoque ilimitado não recebe ajuste.

Limitações aceitas: leitura→escrita do lote não é atômica na loja (uma venda online entre ambas, somada a resposta perdida, cai em `envio_incerto` — nunca em duplicidade); coincidência exata entre o remoto e `base+delta` por edição manual é indistinguível de "já aplicado".

## 3. Pré-requisitos (checklist de implantação do ambiente de teste)

**Infra**

- [ ] Banco PostgreSQL 16 **de teste** (Neon branch ou local) e `DATABASE_URL`.
- [ ] API acessível por **HTTPS público** (ex.: túnel `cloudflared`/`ngrok` ou Render de teste) — a Nuvemshop só entrega webhooks em HTTPS. Anote `PUBLIC_API_URL`.
- [ ] Front servido em HTTPS (`WEB_URL`) e `CORS_ORIGINS` com essa origem.
- [ ] `pnpm install && pnpm db:migrate` (aplica 001–007; confirme "Migrations aplicadas").
- [ ] Primeiro admin: `ADMIN_NAME/ADMIN_EMAIL/ADMIN_PASSWORD pnpm --filter @pdv/api create-admin`.

**App Nuvemshop (Portal de Parceiros → Aplicativos)**

- [ ] Criar aplicativo de **teste** e uma **loja de desenvolvimento/demonstração**.
- [ ] Escopos: `read_products`, `write_products`, `read_orders`.
- [ ] URL de redirecionamento: `{PUBLIC_API_URL}/integrations/nuvemshop/callback`.
- [ ] Copiar `App ID` e `Client Secret` (segredo: só em variável de ambiente/painel, nunca no git).

**Variáveis (API e worker, mesmos valores)**

- [ ] `NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_SECRET`, `PUBLIC_API_URL`, `WEB_URL`
- [ ] `NUVEMSHOP_USER_AGENT="PDV LH Company (seu-email@dominio)"`
- [ ] `INTEGRATION_ENCRYPTION_KEY` (≥ 32 caracteres aleatórios; **guarde**: trocar invalida o token) e `JWT_SECRET`
- [ ] `RECONCILE_INTERVAL_MIN=5` apenas durante a homologação (padrão 30)

**Processos**

- [ ] API: `pnpm --filter @pdv/api start` (ou `dev`); `GET /health` = ok.
- [ ] **Worker em processo separado**: `pnpm --filter @pdv/api worker` (`worker:prod` após build). Sem ele nada é enviado/processado.
- [ ] Relógio do servidor sincronizado (NTP).

## 4. Dados controlados na loja de teste

Crie na loja **3 produtos**, cada um com 1 variante e **1 location**, SKU idêntico ao do PDV:

| SKU     | Uso                             | Estoque inicial (loja = PDV) |
| ------- | ------------------------------- | ---------------------------- |
| `HML-A` | fluxos básicos                  | 10                           |
| `HML-B` | pedido sem estoque/cancelamento | 2                            |
| `HML-C` | conflito e reconciliação        | 5                            |

Mais: 1 variante **sem controle de estoque** (`HML-INF`), e (opcional, último) ativar uma 2ª location para provar o bloqueio. Registre prints/JSON de cada resposta relevante (sem token).

## 5. Roteiro (executar em ordem; marcar resultado e anexar evidência)

Pré: login admin → `/integracoes`. Todos os números abaixo são o esperado.

| #   | Passo                                                                                                                                                                                                | Esperado                                                                                                                                                     | Confirma                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| H1  | **Conectar**: "Conectar à Nuvemshop" → autorizar na loja de teste                                                                                                                                    | Retorna a `/integracoes?conectado=1`; status "Conectada", `storeId` correto; no banco `access_token_enc` não contém o token                                  | OAuth, escopos (§1.5)              |
| H2  | Logs da API/worker                                                                                                                                                                                   | Nenhum `code`, `state` ou token                                                                                                                              | segredos                           |
| H3  | **Importar catálogo** → vincular `HML-A/B/C` pela sugestão de SKU                                                                                                                                    | 3 vínculos; estoque da loja e do PDV inalterados                                                                                                             | formato de produto/variante (§1.3) |
| H4  | Tentar vincular `HML-INF`                                                                                                                                                                            | Vincula, mas envios são cancelados como "estoque não gerenciado"                                                                                             | estoque ilimitado                  |
| H5  | **Registrar webhooks** (admin)                                                                                                                                                                       | Webhooks criados na loja apontando para `PUBLIC_API_URL/…/webhooks`; repetir não duplica                                                                     | registro de webhooks               |
| H6  | Criar pedido de teste de `HML-A` ×1 na loja, **sem pagar**                                                                                                                                           | Evento recebido (aba Eventos = processado); pedido aparece em "Pedidos online" como não pago; **estoque PDV continua 10**; anotar estoque da loja (10 ou 9)  | **quando a loja baixa (§1.1)**     |
| H7  | Pagar o pedido H6                                                                                                                                                                                    | PDV baixa 1× (`pedido_online`) → PDV 9; fila de estoque **não** ganha linha; estoque da loja = 9 (se 10 depois de pago → registrar: loja baixa no pagamento) | baixa única, sem eco               |
| H8  | Repetir "reenviar webhook" no painel da loja (se existir) ou `POST` idêntico assinado                                                                                                                | Evento duplicado/idempotente; PDV continua 9                                                                                                                 | duplicidade                        |
| H9  | Cancelar o pedido na loja **com** reposição                                                                                                                                                          | PDV volta a 10; loja 10                                                                                                                                      | `restock` padrão (§1.2)            |
| H10 | Repetir H6–H9 cancelando **sem** reposição                                                                                                                                                           | Loja fica abaixo do PDV → após 2 reconciliações aparece `estoque_divergente`; registrar                                                                      | `restock=false`                    |
| H11 | **Venda física** de `HML-A` ×2 no PDV                                                                                                                                                                | Linha `-2` na Fila de estoque → "confirmado pela loja" após o worker; loja −2; "Estoque confirmado" no Resumo                                                | delta (§1.6)                       |
| H12 | Derrubar a conexão do worker (parar worker) e vender ×1; religar                                                                                                                                     | Venda conclui; linha pendente; ao religar é enviada uma vez                                                                                                  | indisponibilidade                  |
| H13 | Editar o estoque de `HML-C` direto no painel da loja (5 → 8) e vender ×1 no PDV                                                                                                                      | Loja = 7 (delta sobre 8, **não** sobrescreve); nota "estoque remoto havia mudado"; reconciliação abre divergência (PDV 4 × loja 7)                           | conflito de canais                 |
| H14 | Resolver H13 com "Aceitar estoque da loja"                                                                                                                                                           | PDV = 7; **nenhuma** linha nova na fila                                                                                                                      | reconciliação                      |
| H15 | Pedido pago de `HML-B` ×5 (estoque 2)                                                                                                                                                                | Pendência `sem_estoque`; PDV continua 2; nada cancelado; "Baixar agora" só após entrada de estoque, e baixa **uma** vez                                      | pedido sem estoque                 |
| H16 | **Resposta perdida** (simulação manual): com o worker rodando, derrubar a rede do worker logo após a chamada (ex.: `tc`/firewall ~1 s depois de enviar) ou bloquear só a resposta; venda ×1; religar | Estoque da loja baixa **uma** vez; lote confirmado "já aplicado"                                                                                             | idempotência real (§1.6)           |
| H17 | Reinstalar/desinstalar o app                                                                                                                                                                         | `app/uninstalled` → status "Acesso revogado", token apagado; vendas continuam                                                                                | revogação                          |
| H18 | (opcional) Ativar 2ª location                                                                                                                                                                        | Novos vínculos recusados; envios viram `multiplas_locations`; nada é alterado na loja                                                                        | bloqueio seguro                    |
| H19 | Limite de taxa: importar catálogo repetidamente                                                                                                                                                      | 429 respeitado sem perder envios; anotar cabeçalhos `x-rate-limit-*`                                                                                         | §1.4                               |

**Critério de aprovação:** H1–H15 e H17 conforme esperado, sem baixa duplicada nem estoque negativo, sem segredo em log/resposta. Qualquer divergência de H6/H7/H9/H10 → ajustar a regra de baixa/reposição (item §1.1/1.2) **antes** de produção.

## 6. Reversão e limpeza

- Desconectar (`/integracoes` → Desconectar) apaga o token; desinstalar o app na loja de teste invalida-o na Nuvemshop.
- Banco de teste descartável; a loja de teste nunca é a de produção.
- Para pausar sem desconectar: pare o worker (vendas continuam; a fila acumula e é enviada depois).
