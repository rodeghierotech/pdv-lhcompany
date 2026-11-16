# PDV LH Company

Fatia local de produtos e estoque: cadastro com múltiplas variantes, catálogo com busca e filtros, reposição idempotente e histórico auditável. A confirmação no servidor é exibida separadamente do estado comercial, como estoque baixo. Cadastro e reposição exigem conexão; esta entrega não possui fila offline.

## Restrição de uso

**Somente desenvolvimento local. A implantação externa da API, das migrações e do frontend desta fatia está bloqueada até a implementação da autenticação online.** As rotas de produtos e estoque ainda não autenticam o operador. Não exponha os servidores locais à rede, não use túneis e não configure credenciais ou dados de produção neste ambiente.

## Preparação local

Requisitos: Node.js 22 ou superior, npm e PostgreSQL de desenvolvimento. Execute os comandos na raiz do repositório, em PowerShell:

```powershell
npm.cmd ci
```

Configure as variáveis no ambiente do processo que executará cada comando; a API, as migrações e os testes PostgreSQL não carregam arquivos `.env` automaticamente. A tabela lista apenas os nomes, sem valores ou credenciais:

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | API e migrações, exclusivamente banco local de desenvolvimento nesta fatia. Nunca enviar ao frontend. |
| `TEST_DATABASE_URL` | Suíte PostgreSQL, exclusivamente banco local descartável e separado do desenvolvimento. |
| `PORT` | Porta opcional da API; mantenha o padrão para usar o proxy web sem alterações. |
| `VITE_API_BASE_URL` | Opcional no web; em desenvolvimento, prefira o proxy local já configurado. Não habilita implantação externa. |

Com `DATABASE_URL` configurada para o banco local de desenvolvimento, aplique as migrações numeradas:

```powershell
npm.cmd run db:migrate --workspace=@lh-company/api
```

Inicie a API somente na interface de loopback:

```powershell
npm.cmd run dev:api
```

O servidor da API fica restrito à interface de loopback enquanto esta fatia não possui autenticação. Em outro terminal, inicie o web apenas em loopback:

```powershell
npm.cmd run dev --workspace=@lh-company/web -- --host 127.0.0.1
```

Abra o endereço local informado pelo Vite. O proxy de desenvolvimento encaminha `/api` para a porta padrão da API e remove esse prefixo. API e web devem permanecer na mesma máquina. Não é necessário configurar CORS nem uma URL de serviço externo.

## Verificação

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
```

Os comandos agregam os workspaces aplicáveis. `test` executa apenas contratos, regras puras da API e componentes web; não acessa PostgreSQL. `build` compila API e web, sem publicar artefatos nem aplicar migrações.

Para a suíte PostgreSQL, configure **somente `TEST_DATABASE_URL`** para um banco local descartável e execute:

```powershell
npm.cmd run test:db
```

Essa suíte aplica migrações e limpa as tabelas de produtos e estoque com `TRUNCATE`. Nunca aponte `TEST_DATABASE_URL` para produção ou para um banco com dados a preservar. Não existe fallback para `DATABASE_URL`; sem `TEST_DATABASE_URL`, a suíte falha antes de abrir conexão. Os testes de banco rodam em sequência para não disputar a limpeza.

Para conferir o fluxo integrado, cadastre um produto com variantes, busque por nome/SKU/código de barras, altere o filtro de estoque baixo, registre uma reposição e consulte o histórico. Em caso de falha da API, os formulários preservam os campos para nova tentativa; uma falha não é confirmação do servidor. Consulte [a arquitetura](docs/ARQUITETURA.md), [o plano](PLANO.md) e [o design system](docs/DESIGN_SYSTEM.md) antes de estender esta entrega.
