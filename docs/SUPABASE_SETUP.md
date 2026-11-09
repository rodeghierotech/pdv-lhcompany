# Ativação do Supabase e Vercel

## 1. Criar o projeto Supabase

Crie um projeto Supabase e, no SQL Editor, aplique as migrations na ordem abaixo:

1. `supabase/migrations/20261104120000_initial_foundation.sql`
2. `supabase/migrations/20261106090000_catalog_inventory.sql`

As migrations criam RLS por organização. Depois de criar o primeiro usuário no Supabase Auth, crie uma organização e uma associação em `organization_member` para esse usuário antes de testar o catálogo.

## 2. Configurar a Vercel

No projeto Vercel do diretório `apps/web`, configure somente:

```text
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon-ou-publishable
```

Não configure service-role, URL PostgreSQL, token Nuvemshop ou qualquer outro segredo com prefixo `VITE_`.

## 3. Configurar a Nuvemshop

Guarde `NUVEMSHOP_STORE_ID`, token e identificação da aplicação somente nos segredos da Edge Function do Supabase. Defina também o ID do local físico padrão usado pela importação. O frontend nunca recebe esses valores.

## 4. Verificação manual

1. Abra o PDV publicado e confirme que o status de sincronização mostra “Pronto para conectar”.
2. Faça login e associe o usuário à organização.
3. Crie um produto manualmente; ele só deve aparecer como confirmado após resposta do servidor.
4. Execute a importação Nuvemshop apenas depois de cadastrar o local padrão e os segredos.

## Limite atual

A migration e o frontend estão versionados, mas não foram aplicados a um projeto Supabase real neste worktree. A confirmação de integração depende dessas configurações externas.
