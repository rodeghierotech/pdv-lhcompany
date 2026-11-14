# Produtos e estoque — especificação de design

**Data:** 14 de novembro de 2026  
**Estado:** proposta para aprovação

## Intenção

Entregar a primeira fatia vertical operacional do PDV LH Company: cadastrar produtos e suas variantes, consultar catálogo e saldo, registrar reposição e conferir o histórico auditável de estoque.

A entrega deve validar contratos, API, PostgreSQL e interface em conjunto. Ela estabelece o padrão de domínio e de experiência que será reutilizado pelos módulos de venda, caixa e sincronização.

## Usuário e contexto

O usuário é a pessoa que opera e administra a loja de moda. Ela pode trabalhar pelo celular durante conferências e reposições, ou pelo desktop durante cadastro e atendimento.

A interface nasce para telas pequenas e se expande no desktop. O desktop continua sendo o fluxo de maior produtividade, com tabela, atalhos de teclado e maior densidade, mas nenhuma função essencial depende dele.

## Objetivos

- Listar e buscar produtos por nome, SKU e código de barras.
- Exibir uma linha por variante, com produto, atributos, preço e saldo atual.
- Filtrar variantes com estoque abaixo ou igual ao limite configurado para cada variante; o filtro precisa alterar de fato os resultados.
- Cadastrar um produto com uma ou mais variantes em uma única operação atômica.
- Registrar reposição com quantidade, custo unitário, data de recebimento e referência opcional.
- Criar lote, movimento e saldo na mesma transação da reposição.
- Consultar o histórico imutável de movimentos de cada variante.
- Mostrar separadamente a confirmação no servidor e os dados comerciais.
- Preservar os campos preenchidos quando houver erro recuperável.
- Oferecer foco visível, navegação por teclado e alvos de toque adequados.

## Fora desta entrega

- Importação ou publicação na Nuvemshop.
- Operações offline e fila IndexedDB. Cadastro, preço e reposição exigem conexão, conforme a arquitetura.
- Fotos de produtos; o banco atual não possui esse conceito.
- Edição ou exclusão de produtos, variantes, lotes ou movimentos.
- Ajuste manual de saldo. Uma futura contagem gera movimento de ajuste; nunca altera o saldo diretamente.
- Venda, pagamento, caixa, despesa e relatórios completos.
- Inativação de produto ou variante pela interface nesta primeira entrega.
- Paginação avançada e virtualização antes de haver volume que as justifique.
- Autenticação nesta fatia. As rotas permanecem disponíveis somente no ambiente local de desenvolvimento e não podem ser publicadas antes do módulo de autenticação online.

## Abordagens consideradas

### Fatia vertical completa — escolhida

Implementar contratos, regras, persistência, API e interface do mesmo fluxo. Entrega valor utilizável cedo e testa as fronteiras reais da arquitetura.

### Backend primeiro

Reduziria a incerteza no domínio antes da UI, mas adiaria a validação do fluxo operacional e da abordagem mobile-first.

### Interface com dados simulados

Seria mais rápida para explorar aparência, mas não validaria atomicidade, idempotência ou auditoria e criaria retrabalho ao conectar dados reais.

## Direção visual escolhida

A estrutura escolhida foi a **mesa operacional**: busca, resumo útil e catálogo denso. Ela foi revisada para evitar o repertório genérico de dashboards de SaaS.

Princípios visuais:

- aparência de ferramenta de loja e ficha de estoque, não de painel promocional;
- superfícies planas, divisórias claras e pouco arredondamento;
- nenhuma sombra, gradiente, vidro ou decoração sem função;
- números agregados em uma linha de conferência, não em cartões de KPI;
- cor vinho identifica ação principal; vermelho identifica alerta acionável;
- estados neutros não ganham chips coloridos;
- tipografia compacta e firme; SKU pode usar fonte monoespaçada;
- ícones Lucide ajudam a reconhecer rotas, sempre com nome quando houver ambiguidade;
- no celular, navegação inferior com ícone e legenda;
- no desktop, navegação lateral com ícone, nome e atalho, podendo ser recolhida;
- estado de sincronização aparece em texto simples e não implica confirmação comercial.

Os valores visuais devem virar tokens semânticos em `docs/DESIGN_SYSTEM.md` e no tema Tailwind. Componentes não recebem cores hexadecimais nem medidas visuais avulsas.

## Fluxos de interface

### Catálogo

No celular, a tela começa com título, quantidade de produtos e variantes, ação “Novo”, busca e abas funcionais para todos, estoque baixo e inativos. Cada variante ocupa uma linha tocável. O saldo baixo é indicado por texto e cor de alerta, sem pílula decorativa.

No desktop, os mesmos dados viram tabela. A linha de conferência mostra apenas indicadores que apoiam decisões: custo em estoque, variantes com estoque baixo e variantes sem movimento recente. A primeira entrega pode deixar “sem movimento recente” oculto se a consulta necessária ampliar demais o escopo.

Selecionar uma variante abre o detalhe com seus dados, saldo atual e histórico de movimentos em ordem decrescente.

### Cadastro de produto

O cadastro usa uma página própria em celular e desktop, evitando um painel estreito para um formulário potencialmente longo.

Campos do produto:

- nome obrigatório;
- descrição opcional;
- categoria opcional.

Campos por variante:

- SKU obrigatório e único;
- código de barras opcional e único quando preenchido;
- atributos em pares nome/valor, com atalhos de interface para “Cor” e “Tamanho”;
- preço de venda em centavos no contrato, exibido como moeda no formulário;
- custo em centavos no contrato, exibido como moeda no formulário;
- controle de estoque, ligado por padrão.
- limite de estoque baixo, configurável por variante e iniciado com 3 unidades.

O produto precisa de pelo menos uma variante. O formulário permite adicionar e remover variantes antes de salvar. Erros de uma variante devem apontar a linha e o campo exatos. Ao salvar, produto e todas as variantes confirmam juntos ou nada é persistido.

### Reposição

A reposição parte de uma variante. No celular, usa uma página ou folha inferior de altura ampla; no desktop, pode usar painel lateral, desde que todo o resumo e a confirmação fiquem visíveis.

Campos:

- quantidade inteira positiva;
- custo unitário não negativo;
- referência de origem opcional.

Antes de confirmar, a interface resume variante, quantidade, custo e saldo projetado. A ação informa explicitamente que registrará uma entrada auditável. Erros recuperáveis preservam todos os campos. A primeira versão não aceita lançamento retroativo: recebimento e movimento recebem o horário de confirmação do servidor.

### Histórico

O histórico exibe data, motivo em linguagem humana, quantidade com sinal, lote ou referência quando houver e identificador da operação disponível para suporte. Nenhum item possui ação de apagar ou editar.

## Contratos e API

Toda entrada HTTP e toda resposta pública usam schemas Zod em `packages/contracts`.

Contratos propostos:

- `CreateProductCommandSchema`: `operationId` e os dados de `CreateProductInputSchema`;
- `ProductCatalogQuerySchema`: busca, filtro de estoque e limite seguro;
- `ProductCatalogItemSchema`: produto, variante e saldo atual;
- `CreateReplenishmentCommandSchema`: `operationId`, `variantId`, quantidade, custo e referência;
- `InventoryHistoryQuerySchema` e `InventoryHistoryItemSchema`.

Rotas propostas:

- `GET /products` — catálogo pesquisável, uma entrada por variante;
- `POST /products` — criação atômica e idempotente;
- `POST /inventory/replenishments` — lote, movimento e saldo na mesma transação;
- `GET /inventory/variants/:variantId/history` — saldo e movimentos da variante.

As rotas ficam finas: validam a fronteira, chamam o serviço de domínio e traduzem erros conhecidos. Regra de negócio e SQL não vivem no handler.

Respostas esperadas:

- `201` para uma nova criação;
- repetição do mesmo `operationId` devolve o resultado original sem duplicar dados;
- `400` para contrato inválido;
- `404` para variante inexistente;
- `409` para SKU, código de barras ou operação incompatível;
- `500` com mensagem segura para falha inesperada, sem SQL, segredo ou URL de banco.

## Persistência e regras de domínio

Uma nova migração adicionará a estrutura mínima necessária para idempotência de criação de produto, o limite de estoque baixo por variante e os índices exigidos pela busca. Migrações já aplicadas não serão alteradas.

### Criação de produto

- `operationId` é UUID único e identifica a mutação.
- Produto e variantes são inseridos na mesma transação.
- Cada variante que controla estoque recebe saldo materializado inicial igual a zero na mesma transação.
- SKU deve ser único globalmente.
- Código de barras deve ser único quando preenchido.
- Valores monetários permanecem inteiros em centavos.
- O limite de estoque baixo é um inteiro não negativo por variante e assume 3 quando não informado.
- Repetir a mesma operação retorna o recurso criado; reutilizar o identificador com carga incompatível gera conflito.

### Reposição

- Só é aceita para variante existente, ativa e com controle de estoque.
- A quantidade é inteira e maior que zero.
- A transação cria `stock_lot`.
- A transação cria `inventory_movement` com motivo `replenishment` e delta positivo.
- A mesma transação atualiza `inventory_balance` com incremento atômico.
- A mesma transação atualiza `product_variant.cost_in_cents` pelo custo médio ponderado entre o saldo anterior e a nova entrada. O cálculo usa inteiros, com regra de arredondamento determinística documentada e testada.
- Quando o saldo anterior for zero, o novo custo atual é o custo unitário da entrada.
- `stock_lot.received_at` e `inventory_movement.occurred_at` usam o horário de confirmação do servidor; a API não recebe data retroativa nesta entrega.
- O `operationId` do movimento é único e torna a chamada idempotente.
- O movimento é a evidência auditável; o saldo materializado é apenas a consulta rápida.
- Falha em qualquer etapa reverte lote, movimento e saldo.

### Consulta

- O saldo vem de `inventory_balance`, nunca da soma feita no cliente.
- O histórico vem de `inventory_movement` e não pode ser alterado pela API.
- O indicador de custo em estoque soma, por variante, `saldo atual × custo médio atual`. Ele é uma estimativa operacional; a interface deve nomeá-lo como “Custo estimado em estoque”.
- “Estoque baixo” significa saldo menor ou igual ao limite configurado na própria variante.
- Resultados têm ordenação estável por nome do produto, SKU e identificador.
- A busca é normalizada no backend e recebe limite máximo para não retornar o catálogo inteiro sem controle.

## Estados de sincronização e comercial

Esta entrega não cria operações offline. Em conexão normal, a interface mostra “Confirmado no servidor” somente após resposta bem-sucedida da API.

Falha de rede não pode ser mostrada como cadastro ou reposição concluída. O formulário permanece disponível para nova tentativa. O estado de sincronização não substitui indicadores como ativo, estoque baixo ou saldo.

## Segurança e implantação desta fatia

O repositório ainda não possui autenticação online. Para evitar ampliar esta entrega com um módulo sem requisitos definidos, as novas rotas serão usadas somente no desenvolvimento local.

- Não publicar API, migrações ou frontend desta fatia em ambiente acessível externamente.
- Não adicionar bypass, credencial fixa ou segredo ao cliente.
- Autenticação online é um bloqueio explícito para implantação.
- O plano de implementação deve manter essa restrição visível na documentação e no handoff.

## Organização do código

```text
packages/contracts/src/
  products.ts
  inventory.ts

apps/api/src/modules/products/
  product-routes.ts
  product-service.ts
  product-repository.ts
  product-errors.ts

apps/api/src/modules/inventory/
  inventory-routes.ts
  inventory-service.ts
  inventory-repository.ts
  inventory-errors.ts

apps/web/src/features/products/
  api/
  components/
  pages/

apps/web/src/features/inventory/
  api/
  components/
  pages/
```

Componentes realmente compartilhados, como campo monetário, aviso de erro e estrutura de página, ficam em `apps/web/src/components/shared`. Componentes específicos permanecem dentro da feature.

## Acessibilidade e responsividade

- Implementação parte da largura mínima suportada pelo projeto e adiciona complexidade progressivamente.
- Alvos de toque têm pelo menos 44 por 44 pixels.
- Todo ícone interativo possui nome acessível.
- O estado ativo não depende somente de cor.
- A tabela desktop possui equivalente em lista semântica no celular.
- Formulários têm rótulos persistentes, mensagens associadas ao campo e foco no primeiro erro.
- A navegação por teclado segue a ordem visual.
- Atalhos não sobrescrevem comandos do navegador nem funcionam enquanto o usuário digita em campos.
- Carregamento, vazio, erro e sucesso têm mensagens específicas e acionáveis.

## Testes e verificação

Testes críticos devem cobrir:

- schema rejeita dinheiro fracionário em centavos e quantidade inválida;
- schema aplica limite padrão de 3 e rejeita limite negativo;
- criação rejeita produto sem variante;
- criação atômica não deixa produto parcial quando uma variante falha;
- repetição do `operationId` não duplica produto nem reposição;
- reutilização incompatível do identificador gera conflito;
- reposição cria lote, movimento e saldo na mesma transação;
- reposição calcula custo médio ponderado com arredondamento determinístico;
- saldo anterior zero adota o custo da nova entrada;
- horário auditável vem do servidor e o contrato não aceita retroatividade;
- rollback não deixa lote ou saldo parcial;
- histórico mantém movimento imutável e ordenado;
- busca e filtro de estoque baixo alteram os resultados;
- UI preserva entradas em erro recuperável.

Para domínio e API, a implementação pode usar o executor `node:test` por meio de `tsx`, já presente na stack. Qualquer biblioteca adicional de teste deve ser justificada e registrada em `docs/ARQUITETURA.md` antes de entrar no projeto.

Ao final, executar lint, typecheck, testes relevantes e build dos workspaces. Migrações PostgreSQL só serão executadas quando houver `DATABASE_URL` de ambiente de desenvolvimento ou teste explicitamente configurada.

## Decisões deixadas ao implementador

- nomes internos de funções e pequenos componentes;
- divisão de arquivos menores dentro da organização definida;
- SQL exato dos índices, após verificar o plano de consulta;
- breakpoint exato em que lista vira tabela, usando os tokens do design system;
- uso de página ou folha inferior para reposição no celular, desde que o resumo, a confirmação e a preservação de dados sejam atendidos.

## Critérios de aceite

- Um produto com múltiplas variantes é criado de forma atômica e idempotente.
- O catálogo responde à busca e ao filtro de estoque baixo em celular e desktop.
- Uma reposição confirmada cria lote e movimento e altera o saldo na mesma transação.
- Uma reposição atualiza o custo médio da variante e o custo estimado do estoque de forma coerente.
- Repetir uma requisição não duplica nenhum registro ou saldo.
- O histórico evidencia a origem de cada alteração e não oferece edição ou exclusão.
- Falhas recuperáveis mantêm os dados digitados e não exibem sucesso falso.
- Estado do servidor e estado comercial aparecem separadamente.
- A interface segue a direção visual aprovada, usa tokens semânticos e componentes compartilhados.
- Lint, typecheck, testes relevantes e build passam, ou impedimentos externos são relatados com precisão.
- A entrega permanece local e não é publicada antes da implementação de autenticação online.
