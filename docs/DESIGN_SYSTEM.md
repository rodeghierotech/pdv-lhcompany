# Design System — Rodeghiero Tech

## Princípios

O sistema administrativo é neutro, denso e operacional: informação útil primeiro, decoração por último. A identidade do cliente entra por tokens, não por bifurcações de componentes. A experiência deve parecer parte da mesma plataforma em produtos futuros da Rodeghiero Tech.

## Fundação visual

- Stack visual: Tailwind CSS, shadcn/ui e Lucide Icons.
- Tokens semânticos obrigatórios: `background`, `foreground`, `surface`, `muted`, `primary`, `secondary`, `destructive`, `warning`, `success`, `border`, `ring`, `radius`, `shadow`, `spacing` e escala tipográfica.
- Os valores concretos dos tokens ficam no tema global/Tailwind. Componentes só consomem nomes semânticos; não recebem hex, sombras ou espaçamentos ad hoc.
- Tema inicial: neutro e sóbrio, alto contraste de texto, cor de destaque reservada a ação principal e estados de operação.
- Gradientes, ilustrações decorativas e cartões sem função são exceção. Cards são usados para indicador resumido, agrupamento operacional ou ação claramente delimitada.

## Estrutura e componentes compartilhados

| Área | Componente padrão | Regra |
| --- | --- | --- |
| Estrutura | `AdminShell`, `Sidebar`, `AppHeader` | Navegação e ações globais iguais em todos os módulos. |
| Página | `PageHeader` | Título, descrição curta, breadcrumbs quando necessários e ações à direita. |
| Dados | `DataTable` | Busca, filtros, paginação, colunas, seleção e estados vazios padronizados. |
| Formulário | Campos shadcn + mensagens Zod | Rótulo, ajuda, erro e foco acessível; sem validação visual duplicada. |
| Diálogo | `ConfirmDialog`, `FormDialog` | Confirmação explícita para estorno, cancelamento, ajuste e ações financeiras. |
| Estado | `StatusBadge`, `AlertBanner`, `Toast`, `EmptyState` | Texto e cor representam o estado sem depender só de cor. |
| Indicador | `MetricCard` | Valor, período, comparação opcional e estado de carregamento. |
| Assíncrono | `LoadingState`, `ErrorState`, `SyncIndicator` | Ação em andamento, erro recuperável e sincronização sempre visíveis. |

Antes de criar um componente, verificar se um item desta tabela atende o caso. Novas abstrações só entram após dois usos reais ou quando eliminarem inconsistência comprovada.

## Padrões de interação

- Navegação interna sem recarregamento completo; URL reflete módulo, filtro relevante e registro aberto quando apropriado.
- PDV privilegia teclado: busca recebe foco inicial, Enter confirma ação segura e atalhos nunca disparam estorno/cancelamento sem confirmação.
- Tabelas mantêm filtros e paginação ao retornar de um formulário.
- Formulários não descartam conteúdo em falha recuperável.
- Desktop é prioritário; telas menores reorganizam sem ocultar estado financeiro, de estoque ou de sincronização.
- Todo foco é visível, diálogos prendem/restauram foco e ícones têm rótulo acessível quando não acompanhados de texto.

## Estados operacionais do PDV

`concluída`, `cancelada` e `devolvida` descrevem a venda; `pago`, `parcial` e `fiado` descrevem pagamento; `local`, `pendente`, `confirmada`, `falha recuperável` e `conflito` descrevem sincronização. A interface mostra essas dimensões separadamente para não confundir venda concluída com backup no servidor.
