# Ativação do Supabase e Vercel

## 1. Criar o projeto Supabase

Crie um projeto Supabase e, no SQL Editor, aplique as migrations na ordem abaixo:

1. `supabase/migrations/20261104120000_initial_foundation.sql`
2. `supabase/migrations/20261106090000_catalog_inventory.sql`
3. `supabase/migrations/20261106100000_catalog_inventory_operations.sql`
4. `supabase/migrations/20261106110000_catalog_import_command.sql`

As migrations criam RLS por organização. Depois de criar o primeiro usuário no Supabase Auth, crie uma organização e uma associação em `organization_member` para esse usuário antes de testar o catálogo.

## 2. Configurar a Vercel

No projeto Vercel do diretório `apps/web`, configure somente:

```text
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon-ou-publishable
```

Não configure service-role, URL PostgreSQL, token Nuvemshop ou qualquer outro segredo com prefixo `VITE_`.

## 3. Configurar a Nuvemshop

Guarde estes valores somente nos segredos da Edge Function do Supabase:

```text
NUVEMSHOP_STORE_ID
NUVEMSHOP_ACCESS_TOKEN
NUVEMSHOP_USER_AGENT
NUVEMSHOP_DEFAULT_LOCATION_ID
```

Também disponibilize `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` para a função. Publique `supabase/functions/import-nuvemshop`; o token e o service-role nunca entram na Vercel nem no bundle web.

## 4. Verificação manual

1. Abra o PDV publicado e confirme que o status de sincronização mostra “Pronto para conectar”.
2. Faça login e associe o usuário à organização.
3. Crie um produto manualmente; ele só deve aparecer como confirmado após resposta do servidor.
4. Publique a Edge Function `import-nuvemshop` e execute a importação apenas depois de cadastrar o local padrão e os segredos.

## Limite atual

A migration e o frontend estão versionados, mas não foram aplicados a um projeto Supabase real neste worktree. A confirmação de integração depende dessas configurações externas.
