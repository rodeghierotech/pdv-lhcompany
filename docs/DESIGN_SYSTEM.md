# Design System — PDV LH Company

Interface para atendimento no balcão: densa o suficiente para ser rápida, calma o suficiente para não cansar após horas de uso.

## Princípios

1. **Velocidade > ornamento**: sem animações longas; transições ≤ 150 ms.
2. **Teclado primeiro** no desktop (foco visível, atalhos na tela de vendas); toque confortável no mobile (alvos ≥ 40 px).
3. **Estado sempre visível**: conexão e sincronização aparecem no cabeçalho o tempo todo.
4. **Ações críticas pedem confirmação explícita** (cancelar, devolver, ajustar estoque, fechar caixa).
5. **Feedback claro**: sucesso/erro via toast; erros de formulário junto ao campo.

## Tokens (Tailwind v4 / CSS variables em `apps/web/src/index.css`)

| Token                                       | Uso                                    |
| ------------------------------------------- | -------------------------------------- |
| `--background` / `--foreground`             | Fundo e texto base                     |
| `--primary`                                 | Ação principal (grafite escuro)        |
| `--muted`, `--border`                       | Superfícies secundárias, bordas        |
| `--success` / `--warning` / `--destructive` | Estados (confirmada / pendente / erro) |
| `--radius`                                  | 0.5rem                                 |

Identidade (nome da loja, cor primária) vem de configuração (`VITE_STORE_NAME` e variáveis CSS), para reuso em outros clientes.

Tipografia: sistema (`ui-sans-serif`), números tabulares (`tabular-nums`) em valores e quantidades. Moeda sempre via `formatBRL` (`packages/shared`).

## Componentes (`apps/web/src/components/ui`, padrão shadcn/ui)

Button, Input, Label, Badge, Card, Table, Dialog, Toaster (sonner). Novos componentes seguem o padrão shadcn: `cva` para variantes, `cn()` para composição, Radix para acessibilidade.

## Padrões de interface

- **Painel (`/painel`)**: KPIs com a definição visível (faturamento ≠ recebido); gráfico SVG de barras agrupadas com `role="img"` e `<title>` por dia; grids usam `min-w-0` nos filhos para tabelas rolarem dentro do cartão em telas estreitas.

- **Caixa (`/caixa`)**: três cartões separam _dinheiro na gaveta_, _faturamento_ (competência) e _recebimentos efetivos por modalidade_; o fechamento mostra a diferença ao vivo e exige justificativa. Badge no cabeçalho mostra o caixa aberto/fechado.
- **Conta-corrente (`/clientes/:id`)**: saldo, vencido, limite e crédito disponível no topo; dívidas em aberto com botão _Receber_ por venda ou do saldo geral; recebimentos e pagamentos nunca são editados (apenas estornados).

- **PDV (`/vender`)**: busca com foco automático (Enter adiciona leitura exata de SKU/código de barras; F2 foca a busca, F9 finaliza); carrinho à esquerda, cliente/pagamento à direita; status Pago/Parcial/Fiado visível; erros de negócio com mensagem acionável (`lib/errors.ts`).

- **Layout**: barra lateral (desktop) / navegação inferior simples (mobile); cabeçalho com loja, usuário e indicador de estado.
- **Listas**: busca no topo (debounce 250 ms), tabela densa, paginação.
- **Formulários**: validação com zod (schemas compartilhados), valores monetários em campo de texto com máscara BRL convertido para centavos.
- **Estoque**: badge `baixo` quando `quantidade <= estoque mínimo`; `zerado` em destaque.

## Estados de sincronização (`SyncBadge`, fase 8)

| Estado              | Cor      | Texto                    |
| ------------------- | -------- | ------------------------ |
| `local`             | âmbar    | Salva no aparelho        |
| `pendente`          | âmbar    | Enviando…                |
| `confirmada`        | verde    | Confirmada pelo servidor |
| `falha_recuperavel` | âmbar    | Falha — será reenviada   |
| `conflito`          | vermelho | Conflito                 |

Regra: nunca exibir "confirmada" antes da resposta do servidor. Venda offline mostra faixa âmbar "Venda salva neste aparelho … ainda NÃO confirmada pelo servidor"; o cabeçalho exibe o contador de pendentes/conflitos (link para `/sincronizacao`) e, sem conexão, a faixa informa se há autorização offline válida.

## Integração Nuvemshop (`/integracoes`, fase 9)

Abas: Resumo, Produtos, Pendências, Pedidos online, Fila de estoque, Eventos (`role="tablist"`). Selos: verde = `confirmado pela loja`/processado, âmbar = pendente/enviando, vermelho = falha/conflito, cinza = ignorado/cancelado. Regra: o estoque só aparece como sincronizado quando a fila está vazia **e** há confirmação externa registrada; caso contrário o resumo exibe "Estoque NÃO confirmado". Ações que alteram a loja ou sobrescrevem estoque pedem confirmação.

## Acessibilidade

Contraste AA, foco visível, `aria-label` em botões de ícone, diálogos via Radix (foco preso e `Esc`).
