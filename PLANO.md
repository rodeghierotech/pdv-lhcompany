# PLANO — PDV LH Company

## Objetivo

Criar um PDV básico de moda para atendimento rápido, com continuidade offline, controle financeiro e integração assíncrona com a Nuvemshop. O PDV é a fonte principal de catálogo e estoque depois da importação inicial.

## Escopo da primeira versão

### Operação e vendas

- Busca de produtos e clientes, carrinho, variantes de tamanho/cor, SKU, preço e estoque por variante.
- Formas de pagamento: dinheiro, PIX registrado, débito, crédito e fiado; taxa por modalidade de cartão.
- Fiado parcial e baixa posterior de saldo.
- Edição/cancelamento via estorno auditável, com movimento reverso de estoque quando aplicável.
- Estados de venda, pagamento e sincronização exibidos separadamente.

### Produtos e estoque

- Importação inicial de catálogo, variantes, preço, custo e estoque da Nuvemshop.
- Cadastro manual complementar de produtos e variações.
- Reposição com custo, lote e entrada de estoque.
- Histórico de ajustes, estoque baixo e margem estimada.

### Caixa, despesas e relatórios

- Abertura com troco, sangria, suprimento e fechamento por forma de pagamento com divergência.
- Despesas avulsas/fixas, categorias e forma de pagamento.
- Relatórios de vendas, taxa líquida de cartões, despesas, fiado em aberto, estoque, custo e margem estimada.

### Nuvemshop

- Publicar produtos, variantes, preço e estoque originados no PDV.
- Importar pedidos online, movimentando estoque somente quando o pagamento estiver aprovado.
- Processar alterações, cancelamentos, devoluções e eventos repetidos de forma idempotente.
- Criar pendência humana em conflito de estoque; não cancelar pedidos nem apagar movimentos automaticamente.

## Fora de escopo

- Integração direta com maquininha ou cobrança PIX.
- Emissão fiscal.
- Múltiplas lojas, caixas ou perfis de permissão.
- Sincronização de cadastro de clientes com Nuvemshop.

## Requisitos críticos

- Uma venda offline funciona sem internet, mas é claramente indicada como local/pendente até confirmação do servidor.
- Operações locais são atômicas e ordenadas por dependências.
- Pendências não sincronizadas não são consideradas backup, nem ficam visíveis como confirmadas em outro dispositivo.
- O histórico de estoque e financeiro é auditável; saldos atuais são derivados e atualizados transacionalmente.
- Sessão offline é limitada, assinada pelo backend e permite somente operações explicitamente autorizadas.
- API e worker em produção são pagos e sempre ativos; banco fica no Neon.

## Critérios de aceite

- Venda offline, cancelamento offline fora de ordem, duplicação de envio e reconexão não duplicam movimentos.
- Falha de transação IndexedDB não deixa venda parcialmente concluída.
- Conflito entre venda física offline e pedido online preserva ambos os registros e abre pendência.
- Pedido editado após pagamento ajusta apenas o delta; reembolso parcial não repõe estoque sem redução/devolução confirmada.
- Token offline expirado, de outro dispositivo ou sem escopo bloqueia a operação sensível correta.
