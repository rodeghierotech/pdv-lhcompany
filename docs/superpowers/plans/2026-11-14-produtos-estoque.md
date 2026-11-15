# Produtos e estoque — plano de implementação

> **Para agentes executores:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para executar este plano tarefa por tarefa. Os passos usam caixas de seleção (`- [ ]`) para acompanhamento.

**Objetivo:** entregar uma fatia vertical mobile-first para cadastrar produtos e variantes, pesquisar catálogo, registrar reposições auditáveis e consultar saldo e histórico.

**Arquitetura:** contratos Zod compartilhados definem as fronteiras; serviços Fastify coordenam transações PostgreSQL e repositórios SQL; o React consome a API por adaptadores pequenos e mantém estado de formulário local. Movimentos são imutáveis, saldo e custo médio são atualizados na mesma transação, e toda mutação é idempotente por `operationId`.

**Stack:** React, TypeScript estrito, Tailwind CSS, shadcn/ui, Lucide Icons, Fastify, Zod, `pg`, PostgreSQL, Vitest/Testing Library e `node:test` via `tsx`.

**Especificação:** `docs/superpowers/specs/2026-11-14-produtos-estoque-design.md`

## Restrições globais

- Implementar mobile-first; o desktop adiciona densidade, tabela e atalhos sem conter função exclusiva.
- Usar tokens semânticos e componentes em `apps/web/src/components/shared`; não usar hexadecimais nem medidas visuais arbitrárias em componentes.
- Usar Lucide para símbolos; ícones interativos precisam de nome acessível e o estado ativo não depende apenas de cor.
- Não editar ou apagar movimentos, lotes, vendas ou saldos diretamente.
- Produto e variantes confirmam juntos; reposição, lote, movimento, saldo e custo médio confirmam juntos.
- Toda fronteira HTTP usa schemas Zod de `packages/contracts`.
- Dinheiro permanece inteiro em centavos; quantidade e limite de estoque são inteiros.
- Não adicionar fila offline nesta entrega e não mostrar falha de rede como operação concluída.
- Não expor `DATABASE_URL`, tokens ou detalhes SQL ao cliente.
- As novas rotas são somente para desenvolvimento local; implantação externa fica bloqueada até existir autenticação online.
- Não adicionar tecnologia fora da stack sem registrar a decisão em `docs/ARQUITETURA.md`.

## Foco de revisão

- Duas requisições concorrentes com o mesmo `operationId` devem produzir um único resultado, sem saldo duplicado.
- O mesmo `operationId` com conteúdo diferente deve responder conflito e preservar a primeira operação.
- Duas reposições concorrentes na mesma variante não podem perder incremento nem calcular custo sobre saldo desatualizado.
- Busca vazia, com espaços e com diferença de caixa deve retornar resultado estável, limitado e sem erro.
- Falha de rede ou `409` após preenchimento deve preservar o formulário e nunca exibir confirmação falsa.

---

## Mapa de arquivos

### Contratos

- `packages/contracts/src/products.ts`: produto, variante, comando de criação e consulta de catálogo.
- `packages/contracts/src/inventory.ts`: reposição, saldo e histórico.
- `packages/contracts/src/index.ts`: exportações públicas.

### API

- `apps/api/src/infrastructure/database.ts`: pool e helper transacional injetável.
- `apps/api/src/infrastructure/migration-runner.ts`: executor reutilizável de migrações.
- `apps/api/src/infrastructure/run-migrations.ts`: entrada CLI.
- `apps/api/src/modules/products/*`: erros, repositório, serviço e rotas de produtos.
- `apps/api/src/modules/inventory/*`: cálculo de custo, erros, repositório, serviço e rotas de estoque.
- `apps/api/src/test/database-test-support.ts`: conexão e limpeza exclusiva de testes PostgreSQL.
- `apps/api/migrations/0002_product_inventory_operations.sql`: idempotência e limite de estoque baixo.

### Web

- `apps/web/src/components/shared/*`: botão, campo, shell, navegação e mensagens de estado.
- `apps/web/src/lib/api-client.ts`: fetch tipado e normalização de erros.
- `apps/web/src/features/products/*`: catálogo, detalhe e cadastro.
- `apps/web/src/features/inventory/*`: reposição e histórico.
- `apps/web/src/App.tsx`: composição e navegação interna desta fatia.
- `apps/web/src/styles/index.css` e `docs/DESIGN_SYSTEM.md`: tokens e regras visuais aprovadas.

## Task 1: Contratos compartilhados

**Arquivos:**

- Modificar: `packages/contracts/src/products.ts`
- Criar: `packages/contracts/src/inventory.ts`
- Modificar: `packages/contracts/src/index.ts`
- Criar: `packages/contracts/src/products.test.ts`
- Criar: `packages/contracts/src/inventory.test.ts`
- Modificar: `packages/contracts/package.json`

**Interfaces:**

- Produz: `CreateProductCommand`, `ProductCatalogQuery`, `ProductCatalogItem`, `CreateReplenishmentCommand`, `InventoryHistoryItem` e `InventoryHistoryResponse` com seus schemas Zod homônimos.
- `CreateProductCommand` contém `operationId` e `product`; cada variante contém `minimumStockQuantity`, padrão `3`.
- `ProductCatalogQuery` contém `search`, `lowStockOnly`, `status` (`active`, `inactive` ou `all`) e `limit`.
- `ProductCatalogItem` contém IDs e nomes de produto/variante, SKU, código de barras, atributos, preço, custo médio atual, saldo, limite de estoque baixo e estado ativo.
- `CreateReplenishmentCommand` contém `operationId`, `variantId`, `quantity`, `unitCostInCents` e `sourceReference`; não aceita data do cliente.
- `InventoryHistoryResponse` contém identificação da variante, saldo, custo médio atual, custo estimado e movimentos ordenados.

- [ ] **Passo 1: configurar o executor de testes do pacote**

Adicionar `tsx` às dependências de desenvolvimento e os scripts `test` e `test:watch` usando `tsx --test`.

- [ ] **Passo 2: escrever testes falhando para contratos de produto**

Cobrir `applies_default_minimum_stock_of_three`, `rejects_negative_minimum_stock`, `rejects_product_without_variants`, `rejects_fractional_money_in_cents`, `trims_catalog_search`, `defaults_catalog_status_to_active` e `caps_catalog_limit`.

- [ ] **Passo 3: executar os testes de produto e confirmar falha**

Executar: `npm.cmd run test --workspace=@lh-company/contracts -- products.test.ts`  
Esperado: FAIL porque os novos schemas ainda não existem.

- [ ] **Passo 4: implementar os schemas de produto**

Adicionar:

```ts
CreateProductCommandSchema
ProductCatalogQuerySchema
ProductCatalogItemSchema
```

`ProductCatalogQuerySchema` aceita `search`, `lowStockOnly`, `status` e `limit`; `status` assume `active`, `limit` assume `50` e nunca supera `100`.

- [ ] **Passo 5: executar os testes de produto e confirmar sucesso**

Executar o mesmo comando do passo 3.  
Esperado: PASS.

- [ ] **Passo 6: escrever testes falhando para reposição e histórico**

Cobrir `accepts_positive_replenishment`, `rejects_zero_quantity`, `rejects_fractional_quantity`, `rejects_negative_unit_cost`, `rejects_client_supplied_occurred_at` e `parses_signed_history_quantity`.

- [ ] **Passo 7: implementar `inventory.ts` e exportações públicas**

Criar os schemas e tipos listados em Interfaces; `sourceReference` é texto aparado, opcional, com máximo de 200 caracteres.

- [ ] **Passo 8: executar testes e typecheck do pacote**

Executar:

```powershell
npm.cmd run test --workspace=@lh-company/contracts
npm.cmd run typecheck --workspace=@lh-company/contracts
```

Esperado: todos PASS.

- [ ] **Passo 9: commit**

```powershell
git add packages/contracts
git commit -m "feat: define product and inventory contracts"
```

## Task 2: Migração e infraestrutura transacional testável

**Arquivos:**

- Criar: `apps/api/migrations/0002_product_inventory_operations.sql`
- Modificar: `apps/api/src/infrastructure/database.ts`
- Criar: `apps/api/src/infrastructure/migration-runner.ts`
- Modificar: `apps/api/src/infrastructure/run-migrations.ts`
- Criar: `apps/api/src/test/database-test-support.ts`
- Criar: `apps/api/src/infrastructure/migration-runner.db.test.ts`
- Modificar: `apps/api/package.json`
- Modificar: `.env.example`

**Interfaces:**

- Produz: `createDatabasePool(connectionString: string): Pool`.
- Produz: `withinTransaction<T>(operation: (client: PoolClient) => Promise<T>, database?: Pool): Promise<T>`.
- Produz: `runMigrations(database: Pool, migrationsDirectory?: string): Promise<void>`.
- Produz: `getTestDatabasePool(): Pool` e `resetProductInventoryTables(pool: Pool): Promise<void>`; exigem `TEST_DATABASE_URL`.

- [ ] **Passo 1: escrever o teste PostgreSQL falhando da migração**

O teste `applies_product_operation_and_low_stock_columns_once` executa migrações duas vezes e afirma:

- `product.operation_id` e `product.operation_fingerprint` existem;
- `inventory_movement.operation_fingerprint` existe;
- `product_variant.minimum_stock_quantity` é `NOT NULL`, padrão `3` e rejeita negativo;
- `schema_migration` contém cada arquivo uma única vez.

- [ ] **Passo 2: executar o teste de banco e confirmar falha**

Executar: `npm.cmd run test:db --workspace=@lh-company/api -- migration-runner.db.test.ts`  
Esperado: FAIL por ausência da migração/refatoração. Se `TEST_DATABASE_URL` não estiver configurada, registrar o bloqueio e continuar apenas quando houver banco de teste autorizado.

- [ ] **Passo 3: criar a migração `0002`**

Adicionar colunas anuláveis `operation_id UUID UNIQUE` e `operation_fingerprint TEXT` em `product`, coluna `operation_fingerprint TEXT` em `inventory_movement`, coluna `minimum_stock_quantity INTEGER NOT NULL DEFAULT 3 CHECK (minimum_stock_quantity >= 0)` em `product_variant` e índice para busca ordenada por nome/SKU sem alterar `0001`.

- [ ] **Passo 4: separar o executor de migração da entrada CLI**

Mover a lógica reutilizável para `migration-runner.ts`; `run-migrations.ts` apenas obtém o pool, executa e encerra.

- [ ] **Passo 5: tornar pool e transação injetáveis**

Manter `getDatabasePool()` para produção e permitir que testes/serviços forneçam outro `Pool`.

- [ ] **Passo 6: implementar suporte explícito ao banco de testes**

`getTestDatabasePool()` falha com mensagem clara se `TEST_DATABASE_URL` estiver ausente. A limpeza usa nomes de tabelas fixos e `TRUNCATE ... RESTART IDENTITY CASCADE`; nunca lê `DATABASE_URL` de produção.

Configurar `test` para arquivos `*.unit.test.ts` e `test:db` para arquivos `*.db.test.ts`, impedindo que a suíte pura tente acessar PostgreSQL.

- [ ] **Passo 7: executar o teste duas vezes**

Executar o comando do passo 2 em duas execuções separadas.  
Esperado: PASS nas duas e nenhuma migração duplicada.

- [ ] **Passo 8: commit**

```powershell
git add apps/api/migrations apps/api/src/infrastructure apps/api/src/test apps/api/package.json .env.example
git commit -m "feat: add product inventory migration infrastructure"
```

## Task 3: Criação atômica e idempotente de produtos

**Arquivos:**

- Criar: `apps/api/src/modules/products/product-errors.ts`
- Criar: `apps/api/src/modules/products/product-repository.ts`
- Criar: `apps/api/src/modules/products/product-service.ts`
- Criar: `apps/api/src/modules/products/product-service.db.test.ts`

**Interfaces:**

- Produz: `createProductRepository(): ProductRepository` com métodos que recebem `PoolClient`.
- Produz: `createProductService(dependencies: { database: Pool; repository: ProductRepository; idFactory?: () => string }): ProductService`.
- `ProductService.create(command: CreateProductCommand): Promise<Product>`.
- Erros: `ProductConflictError`, `OperationPayloadConflictError` e `ProductNotFoundError` com códigos estáveis.

- [ ] **Passo 1: escrever testes falhando da criação**

Cobrir:

- `creates_product_variants_and_zero_balances_in_one_transaction`;
- `rolls_back_product_when_variant_insert_fails`;
- `returns_original_product_for_same_operation_and_payload`;
- `rejects_same_operation_with_different_payload`;
- `maps_duplicate_sku_and_barcode_to_product_conflict`;
- duas chamadas concorrentes com mesmo `operationId` deixam um único produto.

- [ ] **Passo 2: executar testes e confirmar falha**

Executar: `npm.cmd run test:db --workspace=@lh-company/api -- product-service.db.test.ts`  
Esperado: FAIL porque serviço e repositório não existem.

- [ ] **Passo 3: implementar erros e fingerprint estável**

O serviço calcula SHA-256 do comando Zod já normalizado, excluindo somente campos gerados pelo servidor. O fingerprint fica associado a `operation_id`.

- [ ] **Passo 4: implementar repositório de criação**

Inserir produto, variantes e um `inventory_balance` zero por variante controlada usando o mesmo `PoolClient`. Mapear linhas SQL para `ProductSchema` antes de retornar.

- [ ] **Passo 5: implementar serviço transacional**

Antes de criar, procurar `operationId`; payload igual retorna o agregado existente e payload diferente lança `OperationPayloadConflictError`. Tratar corrida de chave única repetindo a leitura da operação vencedora.

- [ ] **Passo 6: executar testes e confirmar sucesso**

Executar o comando do passo 2.  
Esperado: PASS, inclusive concorrência e rollback.

- [ ] **Passo 7: commit**

```powershell
git add apps/api/src/modules/products
git commit -m "feat: create products atomically"
```

## Task 4: Catálogo e rotas HTTP de produtos

**Arquivos:**

- Modificar: `apps/api/src/modules/products/product-repository.ts`
- Modificar: `apps/api/src/modules/products/product-service.ts`
- Criar: `apps/api/src/modules/products/product-routes.ts`
- Criar: `apps/api/src/modules/products/product-routes.db.test.ts`
- Modificar: `apps/api/src/app.ts`

**Interfaces:**

- Acrescenta: `ProductService.list(query: ProductCatalogQuery): Promise<ProductCatalogItem[]>`.
- Produz: `registerProductRoutes(app: FastifyInstance, service: ProductService): Promise<void>`.
- `createApp(options?: { database?: Pool }): FastifyInstance` registra `/products` e mantém `/health`.

- [ ] **Passo 1: escrever testes falhando do catálogo e HTTP**

Cobrir:

- lista uma linha por variante com saldo zero;
- `search` aparado e sem diferença de caixa encontra nome, SKU ou código de barras;
- `lowStockOnly=true` compara saldo com limite da própria variante;
- `status=active|inactive|all` altera realmente os resultados;
- limite máximo de 100 é respeitado e a ordenação é estável;
- `POST /products` retorna `201` e o agregado;
- payload inválido retorna `400` sem detalhes internos;
- SKU duplicado e operação incompatível retornam `409` com código público estável.

- [ ] **Passo 2: executar testes e confirmar falha**

Executar: `npm.cmd run test:db --workspace=@lh-company/api -- product-routes.db.test.ts`  
Esperado: FAIL por ausência das rotas/listagem.

- [ ] **Passo 3: implementar consulta de catálogo no repositório**

Usar parâmetros SQL, `LEFT JOIN inventory_balance`, `COALESCE(quantity, 0)`, ordenação por nome/SKU/id e limite validado. Não interpolar busca nem ordenação.

- [ ] **Passo 4: implementar rotas finas e mapeamento de erros**

Validar `request.query` e `request.body` com contratos compartilhados; traduzir somente erros conhecidos. Respostas inesperadas usam o logger do Fastify e mensagem segura.

- [ ] **Passo 5: injetar serviço ao criar o app**

O pool opcional permite `app.inject()` com banco de teste; o caminho padrão usa `getDatabasePool()`.

- [ ] **Passo 6: executar testes, typecheck e lint da API**

```powershell
npm.cmd run test:db --workspace=@lh-company/api -- product-routes.db.test.ts
npm.cmd run typecheck --workspace=@lh-company/api
npm.cmd run lint
```

Esperado: PASS.

- [ ] **Passo 7: commit**

```powershell
git add apps/api/src/app.ts apps/api/src/modules/products
git commit -m "feat: expose product catalog api"
```

## Task 5: Reposição, custo médio e histórico auditável

**Arquivos:**

- Criar: `apps/api/src/modules/inventory/inventory-domain.ts`
- Criar: `apps/api/src/modules/inventory/inventory-domain.unit.test.ts`
- Criar: `apps/api/src/modules/inventory/inventory-errors.ts`
- Criar: `apps/api/src/modules/inventory/inventory-repository.ts`
- Criar: `apps/api/src/modules/inventory/inventory-service.ts`
- Criar: `apps/api/src/modules/inventory/inventory-service.db.test.ts`
- Criar: `apps/api/src/modules/inventory/inventory-routes.ts`
- Criar: `apps/api/src/modules/inventory/inventory-routes.db.test.ts`
- Modificar: `apps/api/src/app.ts`

**Interfaces:**

- Produz: `calculateWeightedAverageCost(input: { currentQuantity: number; currentUnitCostInCents: number; incomingQuantity: number; incomingUnitCostInCents: number }): number`.
- Produz: `InventoryService.replenish(command: CreateReplenishmentCommand): Promise<InventoryHistoryResponse>`.
- Produz: `InventoryService.getHistory(variantId: string, query: InventoryHistoryQuery): Promise<InventoryHistoryResponse>`.
- Produz: `registerInventoryRoutes(app, service)` para `POST /inventory/replenishments` e `GET /inventory/variants/:variantId/history`.

- [ ] **Passo 1: escrever testes falhando do custo médio**

Cobrir saldo zero, média exata e arredondamento de meio centavo para o centavo mais próximo em valores não negativos. Exemplo fixo: `10 × 1000 + 5 × 1300 = 16500`; dividido por `15` resulta `1100`.

- [ ] **Passo 2: implementar e validar `calculateWeightedAverageCost`**

Rejeitar inteiros negativos e valores não inteiros. Usar `Math.round` somente após validar que o numerador permanece dentro de `Number.MAX_SAFE_INTEGER`.

- [ ] **Passo 3: escrever testes PostgreSQL falhando da reposição**

Cobrir:

- cria lote, movimento positivo e incrementa saldo;
- atualiza custo médio na mesma transação;
- usa horário do servidor para lote e movimento;
- rollback não deixa lote, movimento, saldo ou custo parcial;
- mesma operação/payload retorna resultado original;
- mesma operação/payload diferente retorna conflito;
- duas reposições concorrentes na mesma variante preservam ambos os incrementos e custo serializado;
- variante inexistente, inativa ou sem controle retorna erro conhecido.

- [ ] **Passo 4: implementar repositório com bloqueio da variante e saldo**

Dentro da transação, selecionar variante e saldo com `FOR UPDATE`, calcular custo usando a função de domínio, inserir lote e movimento e atualizar saldo/custo. O relógio do servidor é obtido uma vez por operação.

- [ ] **Passo 5: implementar serviço idempotente**

Usar `inventory_movement.operation_id` e `inventory_movement.operation_fingerprint`. A migração `0002` adiciona o fingerprint sem alterar a migração inicial.

- [ ] **Passo 6: escrever e implementar testes das rotas**

Verificar `201`, `400`, `404`, `409`, resposta segura em `500`, histórico decrescente e saldo/custo estimado calculados no servidor.

- [ ] **Passo 7: registrar rotas no app e executar verificações**

```powershell
npm.cmd run test --workspace=@lh-company/api
npm.cmd run test:db --workspace=@lh-company/api
npm.cmd run typecheck --workspace=@lh-company/api
```

Esperado: PASS.

- [ ] **Passo 8: commit**

```powershell
git add apps/api/src/modules/inventory apps/api/src/app.ts apps/api/migrations
git commit -m "feat: add auditable inventory replenishment"
```

## Task 6: Fundação visual e testes do frontend

**Arquivos:**

- Modificar: `docs/ARQUITETURA.md`
- Modificar: `docs/DESIGN_SYSTEM.md`
- Modificar: `apps/web/package.json`
- Modificar: `apps/web/vite.config.ts`
- Modificar: `apps/web/src/styles/index.css`
- Criar: `apps/web/src/lib/cn.ts`
- Criar: `apps/web/src/components/shared/Button.tsx`
- Criar: `apps/web/src/components/shared/TextField.tsx`
- Criar: `apps/web/src/components/shared/FeedbackMessage.tsx`
- Modificar: `apps/web/src/components/shared/AdminShell.tsx`
- Criar: `apps/web/src/components/shared/ResponsiveNavigation.tsx`
- Criar: `apps/web/src/components/shared/ResponsiveNavigation.test.tsx`
- Criar: `apps/web/src/test/setup.ts`

**Interfaces:**

- Produz: `Button`, `TextField`, `FeedbackMessage`, `AdminShell` e `ResponsiveNavigation` com props estritamente tipadas.
- `ResponsiveNavigation` recebe `activeItem`, `onNavigate` e itens com `label`, `icon` Lucide e atalho opcional.

- [ ] **Passo 1: registrar as ferramentas aprovadas de UI e teste**

Documentar em `docs/ARQUITETURA.md` que componentes shadcn/ui usam `class-variance-authority`, `clsx` e `tailwind-merge`, e que o frontend usa Vitest, jsdom e Testing Library. Não adicionar biblioteca de estado, formulário ou consulta.

- [ ] **Passo 2: instalar somente as dependências documentadas**

```powershell
npm.cmd install class-variance-authority clsx tailwind-merge --workspace=@lh-company/web
npm.cmd install -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom --workspace=@lh-company/web
```

- [ ] **Passo 3: escrever o design system aprovado**

Definir tokens semânticos para papel, superfície, texto, texto discreto, divisória, ação vinho, perigo, foco e confirmação. Registrar tipografia, raios contidos, ausência de sombras decorativas, ícones Lucide e regras mobile-first.

- [ ] **Passo 4: escrever teste falhando da navegação**

Cobrir rótulos acessíveis, estado ativo via `aria-current`, acionamento por clique/teclado e suspensão dos atalhos quando o foco estiver em `input`, `textarea` ou elemento editável.

- [ ] **Passo 5: implementar tokens e componentes compartilhados**

Usar receitas shadcn/ui, tokens Tailwind e foco visível. Nenhum componente contém hex, sombra avulsa ou breakpoint arbitrário.

- [ ] **Passo 6: implementar navegação mobile/desktop**

No celular, ícone e legenda em barra inferior; no desktop, ícone, nome e atalho em barra lateral recolhível. A estrutura permanece navegável sem JavaScript de atalho.

- [ ] **Passo 7: executar testes, typecheck e build web**

```powershell
npm.cmd run test --workspace=@lh-company/web
npm.cmd run typecheck --workspace=@lh-company/web
npm.cmd run build --workspace=@lh-company/web
```

Esperado: PASS.

- [ ] **Passo 8: commit**

```powershell
git add docs/ARQUITETURA.md docs/DESIGN_SYSTEM.md apps/web package-lock.json
git commit -m "feat: establish lh company interface system"
```

## Task 7: Cliente HTTP e catálogo responsivo

**Arquivos:**

- Criar: `apps/web/src/lib/api-client.ts`
- Criar: `apps/web/src/lib/api-client.test.ts`
- Criar: `apps/web/src/features/products/api/products-api.ts`
- Criar: `apps/web/src/features/products/components/ProductCatalog.tsx`
- Criar: `apps/web/src/features/products/components/ProductCatalog.test.tsx`
- Criar: `apps/web/src/features/products/pages/ProductCatalogPage.tsx`
- Modificar: `apps/web/src/App.tsx`
- Modificar: `apps/web/vite.config.ts`

**Interfaces:**

- Produz: `requestJson<T>(path: string, init?: RequestInit): Promise<T>` e `ApiError` com `status`, `code` e mensagem segura.
- Produz: `listProducts(query: ProductCatalogQuery): Promise<ProductCatalogItem[]>`.
- `ProductCatalogPage` recebe callbacks `onCreateProduct` e `onSelectVariant`.

- [ ] **Passo 1: escrever testes falhando do cliente HTTP**

Cobrir JSON bem-sucedido, resposta vazia, erro estruturado, `500` não JSON e falha de rede. Nenhum erro inclui URL de banco ou corpo bruto do servidor.

- [ ] **Passo 2: implementar cliente e adaptador de produtos**

Usar `VITE_API_BASE_URL` quando definido e `/api` no desenvolvimento. Configurar proxy Vite para a API local; não adicionar CORS ou URL de produção nesta entrega.

- [ ] **Passo 3: escrever testes falhando do catálogo**

Cobrir carregamento, vazio, erro com tentativa novamente, busca aparada, filtro de estoque baixo que dispara nova consulta, lista mobile e tabela desktop com os mesmos dados sem duplicação semântica.

- [ ] **Passo 4: implementar catálogo mobile-first**

Renderizar uma linha por variante, saldo calculado pelo servidor, SKU legível, alerta de estoque baixo e linha de conferência sem cartões de KPI. Usar debounce curto somente para busca textual; filtro é imediato.

- [ ] **Passo 5: integrar ao shell e verificar testes**

```powershell
npm.cmd run test --workspace=@lh-company/web
npm.cmd run typecheck --workspace=@lh-company/web
```

Esperado: PASS.

- [ ] **Passo 6: commit**

```powershell
git add apps/web/src apps/web/vite.config.ts
git commit -m "feat: add responsive product catalog"
```

## Task 8: Cadastro de produto com variantes

**Arquivos:**

- Modificar: `apps/web/src/features/products/api/products-api.ts`
- Criar: `apps/web/src/features/products/components/ProductForm.tsx`
- Criar: `apps/web/src/features/products/components/ProductForm.test.tsx`
- Criar: `apps/web/src/features/products/pages/CreateProductPage.tsx`
- Criar: `apps/web/src/lib/money.ts`
- Criar: `apps/web/src/lib/money.test.ts`
- Modificar: `apps/web/src/App.tsx`

**Interfaces:**

- Produz: `createProduct(command: CreateProductCommand): Promise<Product>`.
- Produz: `parseBrazilianMoneyToCents(value: string): number` e `formatCents(value: number): string` sem ponto flutuante financeiro.
- `ProductForm` recebe `onSubmit(command)`, `onCancel` e `operationIdFactory`; mantém valores e o mesmo `operationId` até sucesso ou cancelamento explícito.

- [ ] **Passo 1: escrever testes falhando de conversão monetária**

Cobrir `"189,90" → 18990`, `"1.234,56" → 123456`, centavos ausentes, valor negativo e entrada ambígua/inválida.

- [ ] **Passo 2: implementar utilitários monetários e confirmar testes**

Tratar a string por dígitos e separadores; não converter o valor financeiro com `parseFloat`.

- [ ] **Passo 3: escrever testes falhando do formulário**

Cobrir pelo menos uma variante, adicionar/remover variante, atalho Cor/Tamanho, limite padrão 3, erro no campo exato, foco no primeiro erro, prevenção de envio duplo e preservação total após falha de rede ou `409`.

- [ ] **Passo 4: implementar formulário e página própria**

Gerar `operationId` uma vez ao iniciar o formulário e reutilizá-lo em todas as tentativas, mesmo se houver edição após falha de rede. Em conflito de payload, não gerar outro identificador automaticamente: oferecer retorno ao catálogo e atualização dos dados para reconciliar a operação possivelmente confirmada.

- [ ] **Passo 5: integrar criação ao catálogo**

Após `201`, voltar ao catálogo, atualizar a consulta e anunciar sucesso. Nenhuma navegação ocorre em erro.

- [ ] **Passo 6: executar testes e build web**

```powershell
npm.cmd run test --workspace=@lh-company/web
npm.cmd run build --workspace=@lh-company/web
```

Esperado: PASS.

- [ ] **Passo 7: commit**

```powershell
git add apps/web/src
git commit -m "feat: add product variant registration"
```

## Task 9: Reposição e histórico na interface

**Arquivos:**

- Criar: `apps/web/src/features/inventory/api/inventory-api.ts`
- Criar: `apps/web/src/features/inventory/components/ReplenishmentForm.tsx`
- Criar: `apps/web/src/features/inventory/components/ReplenishmentForm.test.tsx`
- Criar: `apps/web/src/features/inventory/components/InventoryHistory.tsx`
- Criar: `apps/web/src/features/inventory/components/InventoryHistory.test.tsx`
- Criar: `apps/web/src/features/inventory/pages/VariantInventoryPage.tsx`
- Modificar: `apps/web/src/App.tsx`

**Interfaces:**

- Produz: `replenishInventory(command): Promise<InventoryHistoryResponse>` e `getInventoryHistory(variantId): Promise<InventoryHistoryResponse>`.
- `ReplenishmentForm` recebe variante, saldo atual, `onSubmit`, `onCancel` e fábrica de UUID.
- `InventoryHistory` recebe resposta já validada e não expõe ações de editar/apagar.

- [ ] **Passo 1: escrever testes falhando da reposição**

Cobrir quantidade inteira positiva, custo monetário, saldo projetado, resumo antes da confirmação, texto “Registrar entrada auditável”, envio único e preservação após falha recuperável.

- [ ] **Passo 2: implementar formulário de reposição**

Usar página no celular e painel amplo no desktop com os mesmos campos. Não enviar data do cliente. Reutilizar `operationId` em retry idêntico.

- [ ] **Passo 3: escrever testes falhando do histórico**

Cobrir ordem decrescente, sinal explícito, motivo em português, referência/lote, estado vazio, erro e ausência de controles de edição/exclusão.

- [ ] **Passo 4: implementar detalhe e histórico**

Exibir saldo, custo médio, custo estimado e estado confirmado no servidor em regiões distintas. Atualizar todos após reposição bem-sucedida.

- [ ] **Passo 5: executar testes web**

```powershell
npm.cmd run test --workspace=@lh-company/web
npm.cmd run typecheck --workspace=@lh-company/web
```

Esperado: PASS.

- [ ] **Passo 6: commit**

```powershell
git add apps/web/src
git commit -m "feat: add inventory replenishment workflow"
```

## Task 10: Integração, acessibilidade e verificação final

**Arquivos:**

- Modificar: `package.json`
- Modificar: `README.md` se existir; caso continue ausente, criar `README.md`
- Modificar: arquivos das tarefas anteriores somente para correções encontradas na verificação.

**Interfaces:**

- Produz scripts raiz `test`, `test:db` e `build` que executam workspaces aplicáveis.
- Produz instruções locais sem segredos para API, web, migração e banco de teste.

- [ ] **Passo 1: adicionar scripts agregados e documentação local**

Documentar `DATABASE_URL` e `TEST_DATABASE_URL` apenas como nomes de variáveis, a restrição de desenvolvimento local e o bloqueio de implantação até autenticação.

- [ ] **Passo 2: executar a suíte pura completa**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
```

Esperado: todos PASS.

- [ ] **Passo 3: executar suíte PostgreSQL, se autorizada e configurada**

```powershell
npm.cmd run test:db
```

Esperado: PASS sem tocar banco de produção. Se faltar `TEST_DATABASE_URL`, registrar exatamente essa validação como não executada.

- [ ] **Passo 4: validar fluxos reais em navegador**

Em viewport móvel e desktop, verificar: busca, filtro real, cadastro com múltiplas variantes, retry preservando dados, reposição, histórico, foco visível, navegação por teclado e ausência de overflow horizontal.

- [ ] **Passo 5: validar separação de estados**

Simular falha da API e confirmar que a UI não mostra “Confirmado no servidor”; confirmar que estoque baixo continua sendo estado comercial independente.

- [ ] **Passo 6: conferir diff e escopo**

Executar `git diff --check`, revisar que não há segredo, URL de banco, deleção de movimento nem arquivos `.superpowers` versionados.

- [ ] **Passo 7: commit final de integração**

```powershell
git add package.json README.md apps packages docs package-lock.json .gitignore
git commit -m "feat: complete product inventory vertical slice"
```

## Resultado esperado

Ao concluir as dez tarefas, o ambiente local permite cadastrar um produto com variantes, encontrá-lo no catálogo responsivo, registrar reposição idempotente, conferir saldo/custo/histórico e distinguir confirmação do servidor de estado comercial. Nenhuma parte desta fatia será implantada externamente antes da autenticação online.
