# Rodeghiero Tech — regras obrigatórias

## Escopo e segurança

- Leia `PLANO.md`, `docs/ARQUITETURA.md` e `docs/DESIGN_SYSTEM.md` antes de alterar código.
- Não implemente comportamento fora da tarefa recebida. Preserve auditoria, movimentos imutáveis, estoque, financeiro, autorização offline e sincronização descritos no plano.
- Nunca trate uma operação local como confirmada no servidor. Exiba o estado de sincronização separadamente do estado comercial.
- Não apague vendas, pagamentos ou movimentos de estoque: use estorno ou movimento reverso auditável.
- Não exponha segredos, tokens de Nuvemshop ou URLs de banco no cliente.

## Frontend

- Use React, TypeScript estrito, Tailwind CSS, shadcn/ui e Lucide Icons.
- Use tokens semânticos e componentes de `src/components/shared` antes de criar algo novo. Não use cores hexadecimais ou medidas visuais arbitrárias em componentes.
- Desktop é o fluxo principal do PDV; mantenha responsividade, foco visível, teclado e feedback de carregamento/erro/sucesso.
- Confirme operações destrutivas ou financeiramente sensíveis e preserve entradas de formulário em erros recuperáveis.

## Backend e domínio

- Valide toda fronteira HTTP e mensagem de sincronização com Zod.
- Mantenha regra de negócio, persistência e interface separadas; organize por domínio e evite arquivos extensos.
- Operações offline usam identificador próprio, sequência, dependências e referência à operação revertida quando houver.
- Gravações de venda offline devem ser uma única transação IndexedDB: venda, pagamentos, movimentos e item da fila confirmam juntos ou não confirmam.
- Saldos materializados são atualizados na mesma transação do movimento que os originou; o livro de movimentos é a referência auditável.

## Qualidade

- Escreva testes para regras críticas de estoque, sincronização, financeiro e autorização offline.
- Execute lint, typecheck e os testes relevantes após mudanças, quando autorizado; informe claramente o que não foi executado.
- Não acrescente bibliotecas ou tecnologias fora da stack aprovada sem justificar e registrar a decisão em `docs/ARQUITETURA.md`.
