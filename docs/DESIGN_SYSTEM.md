# Design system — LH Company

## Direção e hierarquia

Ferramenta operacional para varejo de moda: papel, tinta e vinho. Informação alinhada à esquerda, linhas divisórias e densidade de um livro de registros. Sem gradientes, efeitos de vidro, sombras decorativas, cartões genéricos de indicadores ou cores diferentes para cada módulo. A interface apresenta o trabalho real, sem filtros ou métricas fictícias.

A base é mobile-first. No celular, navegação inferior com ícone e legenda; no desktop (breakpoint `md` padrão do Tailwind), o mesmo conteúdo ganha um trilho lateral compacto e recolhível. Recolher reduz a largura, mas preserva ícone, nome e atalho. Desktop acrescenta densidade; não oferece funções exclusivas. O conteúdo reserva espaço para a navegação e a área segura inferior do dispositivo.

## Tokens semânticos

Valores em OKLCH, definidos somente em `apps/web/src/styles/index.css`:

| Token | Papel |
| --- | --- |
| `background` | Papel quente do plano de trabalho |
| `surface` | Superfície clara de controles e navegação |
| `foreground` | Tinta principal |
| `muted-foreground` | Texto secundário legível |
| `border` | Divisórias e contornos de controles |
| `primary` / `primary-foreground` | Ação vinho com texto claro |
| `accent` / `accent-foreground` | Fundo suave de interação / tinta |
| `destructive` / `destructive-foreground` | Perigo e ação sensível |
| `destructive-surface` | Fundo discreto de erro |
| `success` / `success-surface` | Confirmação explícita |
| `focus` | Contorno visível de teclado |

Escala de espaçamento e breakpoints padrão do Tailwind; medidas específicas de layout, raios e área segura ficam em tokens nomeados. Componentes usam classes semânticas, sem hexadecimais, sombras avulsas ou medidas arbitrárias.

## Tipografia e componentes

Fonte de sistema sem downloads: Segoe UI, Arial e sans-serif. Texto operacional `text-sm`, títulos de página `text-xl`, metadados `text-xs`. Pesos normal, medium e semibold; caixa de frase nos rótulos. Valores e quantidades usam numerais tabulares quando necessário. Evitar títulos enormes, rótulos decorativos repetidos e monoespaçada como decoração.

Raios contidos (`rounded-control`, 0,25rem); nenhum sombreado decorativo. `Button` oferece variantes primary, secondary, ghost e destructive, tamanhos default/small/icon e estado de carregamento. Ações destrutivas e financeiras precisam de confirmação no fluxo consumidor; o botão sozinho não executa regras de domínio.

`TextField` associa rótulo, ajuda e erro por IDs; preserva props e valor controlado do consumidor. Erros usam `aria-invalid` e descrição, sem depender só da cor. `FeedbackMessage` combina ícone Lucide, texto e semântica de status/alerta para informação, confirmação ou erro. Confirmar uma ação local não implica confirmação no servidor: estado comercial e estado de sincronização sempre têm mensagens separadas.

## Navegação e acessibilidade

`ResponsiveNavigation` recebe `activeItem`, `onNavigate` e itens com `id`, `label`, `icon` Lucide e `shortcut` opcional. O item ativo usa `aria-current="page"`, peso de texto e marcador de contorno além de cor. Símbolos decorativos têm `aria-hidden`; o nome acessível de cada controle vem do rótulo, e botões só de ícone exigem `aria-label`.

Atalhos opcionais usam Alt + uma letra/número e são exibidos no desktop. Não interceptam digitação em input, textarea, select ou contenteditable (inclusive descendentes), eventos repetidos ou composição de texto. Tab, Enter e Espaço funcionam pelos controles HTML nativos. O shell tem link para pular ao conteúdo. O foco usa contorno visível sem depender dos atalhos.

Controles têm alvo mínimo de toque de 2,75rem; o tamanho small é reservado à densidade desktop. A navegação inferior mantém área de toque e legenda. Layout funciona com zoom e quebra de texto; sem truncar nomes essenciais. Movimento só responde à interação e respeita redução de movimento. Foco, carregamento, erro e sucesso são explícitos, sem apagar entradas em falhas recuperáveis.
