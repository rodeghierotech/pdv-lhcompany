# Catálogo unificado: Nuvemshop + cadastro manual — Design

## Intenção

Criar o catálogo e a fundação de estoque do PDV de moda com duas entradas complementares: importação inicial da Nuvemshop e cadastro manual para itens ou variantes ausentes. As duas entradas alimentam o mesmo catálogo canônico do Supabase; depois da importação inicial, o PDV será a fonte comercial principal.

## Objetivos

- Importar produtos, variantes, SKU, código de barras, atributos, preço, custo e estoque inicial da Nuvemshop sem expor token no navegador.
- Cadastrar e editar manualmente produtos e variantes ausentes no mesmo modelo de dados.
- Registrar estoque inicial e reposições como movimentos imutáveis, com saldo materializado atualizado na mesma transação.
- Conservar o vínculo externo de produto/variante e reconciliar automaticamente apenas por SKU único.
- Exibir importações em progresso, pendências de mapeamento e confirmação de servidor de forma separada do estado comercial.

## Não objetivos

- Publicação do catálogo do PDV na Nuvemshop, sincronização contínua, webhooks de pedidos, vendas, caixa e pagamentos.
- Resolver automaticamente conflito de SKU ambíguo, apagar itens importados ou sobrescrever alteração manual sem revisão.
- Importar ou expor tokens, URLs de banco ou credenciais no PWA.
- Tratar estoque vindo da Nuvemshop como venda confirmada ou como substituto de histórico de movimentos.

## Abordagem escolhida

Há um único fluxo de catálogo canônico. Uma Edge Function do Supabase autenticada por administrador buscará as páginas da Nuvemshop e normalizará dados externos para um comando interno idempotente. O cadastro manual chamará a mesma camada de comando com origem `manual`; ambos persistem `product`, `product_variant`, `inventory_movement` e `inventory_balance` na mesma transação SQL.

O adaptador Nuvemshop considera uma variante como unidade de preço e estoque. Ele lê `inventory_levels` quando disponível e mantém compatibilidade com o estoque de variante legado. Cada vínculo externo guarda IDs da Nuvemshop, SKU e a última referência recebida. SKU único pode religar uma variante existente; ausência ou ambiguidade abre pendência humana e não grava movimento automaticamente. A Nuvemshop documenta que variantes podem ser recriadas quando atributos mudam, tornando esse vínculo e a regra de SKU único necessários. [Nuvemshop Product Variant](https://tiendanube.github.io/api-documentation/resources/product-variant)

## Modelo de dados

- `product`: organização, nome, descrição, categoria, ativo, origem e timestamps de servidor.
- `product_variant`: organização, produto, SKU único por organização, código de barras, atributos JSON, preço/custo em centavos, controle de estoque, ativo e timestamps.
- `external_product_mapping` e `external_variant_mapping`: origem `nuvemshop`, IDs externos, SKU observado, status `linked` ou `needs_review` e timestamps.
- `stock_lot`: custo e referência da entrada.
- `inventory_movement`: livro imutável com motivo, quantidade não nula, referência e operação idempotente.
- `inventory_balance`: saldo por variante, alterado somente na transação que cria o movimento.
- `catalog_import`: execução, origem, estado, totais, erros recuperáveis e pendências humanas.

Todas as tabelas são vinculadas à organização, têm RLS forçada e não recebem políticas permissivas. O PWA só pode ler o catálogo da sua organização. Escritas que alteram catálogo ou estoque acontecem em RPCs `SECURITY DEFINER` cuidadosamente validadas ou na Edge Function; o cliente não grava livros nem saldos diretamente.

## Fluxos

### Importação inicial

1. Um administrador solicita importação; a UI cria uma execução pendente, não promete que ela terminou.
2. A Edge Function lê os segredos protegidos, pagina a API Nuvemshop e valida cada payload com Zod.
3. Para cada variante, a função cria ou atualiza o catálogo canônico por ID externo ou SKU único; divergência abre pendência.
4. A quantidade importada gera um movimento `replenishment` ligado à execução somente se a variante ainda não possui saldo local; nunca há alteração direta de `inventory_balance`.
5. A transação atualiza produto, variante, mapping, movimento e saldo juntos; repetição da operação é idempotente.
6. A UI mostra `concluída`, `falha recuperável` ou `pendências para revisar`, separadamente do catálogo já confirmado.

Uma reimportação ou uma variante manual com saldo local não altera quantidade, preço ou custo automaticamente: cria pendência para revisão. Quando a Nuvemshop fornece múltiplos locais, o importador usa apenas o local padrão configurado. A ausência de custo importa `0` e deixa o item explicitamente marcado para revisão de margem.

### Cadastro manual

1. O usuário preenche produto e ao menos uma variante com SKU, preço e custo em centavos.
2. A RPC valida o contrato, verifica SKU por organização e cria produto/variantes.
3. Se houver estoque inicial, cria lote, movimento `replenishment` e saldo na mesma transação.
4. A resposta confirma a gravação no servidor; uma tentativa local pendente continua visível como pendente até a confirmação.

### Reposição manual posterior

1. O usuário escolhe uma variante, quantidade positiva, custo em centavos e referência opcional.
2. A RPC cria lote e movimento `replenishment`, atualiza `inventory_balance` na mesma transação e retorna o novo saldo confirmado.
3. A operação não edita nem remove movimentos anteriores.

## Experiência do operador

A tela de Produtos mostra busca, status, SKU, variantes, estoque e origem. O botão `Importar Nuvemshop` abre uma confirmação e mostra execução/pêndencias; `Novo produto` abre formulário manual com variações de tamanho/cor. Erros recuperáveis preservam o formulário. A interface não mostra importado ou salvo localmente como sincronizado antes da resposta do servidor.

## Segurança e limites

- `NUVEMSHOP_STORE_ID`, token e identificação da aplicação ficam apenas nos segredos da Edge Function.
- O frontend recebe apenas o resultado sanitizado de importação, nunca cabeçalhos, payload bruto sigiloso ou credenciais.
- Valores monetários são inteiros em centavos; quantidade é inteiro e não pode alterar movimento existente.
- A configuração real da Nuvemshop e a aplicação da migration exigem um projeto Supabase conectado; esta etapa não inventa credenciais.

## Critérios de aceite

- Produto/variante importado e manual coexistem no mesmo catálogo sem duplicar SKU único.
- Uma reexecução não duplica produto, movimento ou saldo.
- SKU ambíguo cria pendência e não grava estoque automaticamente.
- Estoque inicial é evidenciado por `inventory_movement`; saldo e movimento são transacionais.
- Token Nuvemshop e service-role não aparecem no PWA nem nos logs da UI.
- Importação e sincronização usam estados explícitos, sem confundir pendente/local com confirmado.
