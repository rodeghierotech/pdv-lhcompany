import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, setup, TEST_PASSWORD } from './helpers.js';
import type { TestCtx } from './helpers.js';

let ctx: TestCtx;
let admin: string;
let gerente: string;
let vendedor: string;

beforeAll(async () => {
  ctx = await setup();
  admin = ctx.tokenFor('admin');
  gerente = ctx.tokenFor('gerente');
  vendedor = ctx.tokenFor('vendedor');
});
afterAll(() => ctx.close());

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: token ? auth(token) : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const productBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Camiseta Básica',
  idempotencyKey: `prod-${Math.random().toString(36).slice(2)}-key`,
  variants: [
    {
      sku: 'CB-P-PRETA',
      size: 'P',
      color: 'Preta',
      priceCents: 5990,
      costCents: 2500,
      initialStock: 10,
    },
    {
      sku: 'CB-M-PRETA',
      size: 'M',
      color: 'Preta',
      priceCents: 5990,
      costCents: 2500,
      minStock: 3,
    },
  ],
  ...overrides,
});

describe('autenticação', () => {
  it('exige token', async () => {
    expect((await inject('GET', '/products')).statusCode).toBe(401);
    expect((await inject('GET', '/products', 'token-invalido')).statusCode).toBe(401);
  });

  it('faz login e rejeita credenciais inválidas sem revelar o motivo', async () => {
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ADMIN@teste.com', password: TEST_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTypeOf('string');
    expect(ok.json().user).not.toHaveProperty('password_hash');

    const wrongPass = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@teste.com', password: 'errada' },
    });
    const wrongEmail = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nao@existe.com', password: 'qualquer' },
    });
    expect(wrongPass.statusCode).toBe(401);
    expect(wrongEmail.statusCode).toBe(401);
    expect(wrongPass.json().error.message).toBe(wrongEmail.json().error.message);
  });

  it('bloqueia usuário desativado mesmo com token ainda válido', async () => {
    const token = ctx.tokenFor('vendedor');
    await ctx.pool.query("update users set active = false where email = 'vendedor@teste.com'");
    expect((await inject('GET', '/products', token)).statusCode).toBe(401);
    await ctx.pool.query("update users set active = true where email = 'vendedor@teste.com'");
    expect((await inject('GET', '/products', token)).statusCode).toBe(200);
  });

  it('somente admin cria usuários', async () => {
    const body = {
      name: 'Nova Pessoa',
      email: 'nova@teste.com',
      password: 'senha-longa-123',
      role: 'vendedor',
    };
    expect((await inject('POST', '/users', gerente, body)).statusCode).toBe(403);
    const created = await inject('POST', '/users', admin, body);
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain('senha-longa');
    expect((await inject('POST', '/users', admin, body)).statusCode).toBe(409);
  });

  it('aplica limite de tentativas no login', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'x@y.com', password: 'z' },
        remoteAddress: '203.0.113.9',
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('produtos e variantes', () => {
  it('vendedor lê mas não cria produtos', async () => {
    expect((await inject('GET', '/products', vendedor)).statusCode).toBe(200);
    expect((await inject('POST', '/products', vendedor, productBody())).statusCode).toBe(403);
  });

  it('cria produto com variantes e estoque inicial via movimentação', async () => {
    const res = await inject('POST', '/products', gerente, productBody());
    expect(res.statusCode).toBe(201);
    const product = res.json().product;
    expect(product.variants).toHaveLength(2);
    const [p, m] = product.variants;
    expect(p.stock).toBe(10);
    expect(m.stock).toBe(0);

    const movements = await inject('GET', `/stock/movements?variantId=${p.id}`, gerente);
    expect(movements.json().total).toBe(1);
    expect(movements.json().items[0]).toMatchObject({ type: 'entrada', quantityDelta: 10 });
  });

  it('é idempotente na criação (mesma chave não duplica produto nem estoque)', async () => {
    const body = productBody({
      name: 'Calça Jeans',
      idempotencyKey: 'chave-calca-0001',
      variants: [{ sku: 'CJ-38', priceCents: 12990, initialStock: 5 }],
    });
    const first = await inject('POST', '/products', gerente, body);
    const second = await inject('POST', '/products', gerente, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().product.id).toBe(first.json().product.id);
    expect(second.json().product.variants[0].stock).toBe(5);
  });

  it('trata requisições concorrentes com a mesma chave', async () => {
    const body = productBody({
      name: 'Boné',
      idempotencyKey: 'chave-bone-concorrente',
      variants: [{ sku: 'BONE-U', priceCents: 3990, initialStock: 2 }],
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => inject('POST', '/products', gerente, body)),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().product.id)).size).toBe(1);
    const count = await ctx.pool.query("select count(*) from products where name = 'Boné'");
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('rejeita SKU e código de barras duplicados e não deixa produto órfão', async () => {
    const before = Number((await ctx.pool.query('select count(*) from products')).rows[0].count);
    const dupSku = await inject(
      'POST',
      '/products',
      gerente,
      productBody({ name: 'Outro', variants: [{ sku: 'cb-p-preta', priceCents: 100 }] }),
    );
    expect(dupSku.statusCode).toBe(409);
    expect(dupSku.json().error.code).toBe('SKU_IN_USE');

    await inject(
      'POST',
      '/products',
      gerente,
      productBody({
        name: 'Com Barras',
        variants: [{ sku: 'BAR-1', barcode: '789000', priceCents: 100 }],
      }),
    );
    const dupBarcode = await inject(
      'POST',
      '/products',
      gerente,
      productBody({
        name: 'Barras 2',
        variants: [{ sku: 'BAR-2', barcode: '789000', priceCents: 100 }],
      }),
    );
    expect(dupBarcode.json().error.code).toBe('BARCODE_IN_USE');

    const after = Number((await ctx.pool.query('select count(*) from products')).rows[0].count);
    expect(after).toBe(before + 1); // apenas "Com Barras"
  });

  it('valida entrada (preço negativo, sem variantes)', async () => {
    const neg = await inject(
      'POST',
      '/products',
      gerente,
      productBody({ variants: [{ sku: 'NEG', priceCents: -1 }] }),
    );
    expect(neg.statusCode).toBe(400);
    expect(neg.json().error.code).toBe('VALIDATION_ERROR');
    const none = await inject('POST', '/products', gerente, productBody({ variants: [] }));
    expect(none.statusCode).toBe(400);
  });

  it('busca por nome, SKU e código de barras com paginação', async () => {
    const byName = await inject('GET', '/products?q=jeans', vendedor);
    expect(byName.json().items.map((p: { name: string }) => p.name)).toEqual(['Calça Jeans']);
    const bySku = await inject('GET', '/products?q=cj-38', vendedor);
    expect(bySku.json().total).toBe(1);
    const byBarcode = await inject('GET', '/products?q=789000', vendedor);
    expect(byBarcode.json().items[0].name).toBe('Com Barras');
    const wildcard = await inject('GET', '/products?q=%25', vendedor);
    expect(wildcard.json().total).toBe(0);
    const paged = await inject('GET', '/products?pageSize=2&page=1', vendedor);
    expect(paged.json().items).toHaveLength(2);
    expect(paged.json().total).toBeGreaterThan(2);
  });

  it('atualiza produto e variante com auditoria', async () => {
    const list = await inject('GET', '/products?q=jeans', gerente);
    const product = list.json().items[0];
    const upd = await inject('PATCH', `/products/${product.id}`, gerente, {
      name: 'Calça Jeans Slim',
    });
    expect(upd.json().product.name).toBe('Calça Jeans Slim');
    const v = await inject('PATCH', `/variants/${product.variants[0].id}`, gerente, {
      priceCents: 13990,
    });
    expect(v.json().variant.priceCents).toBe(13990);
    expect((await inject('PATCH', `/products/${product.id}`, gerente, {})).statusCode).toBe(400);
    const audit = await ctx.pool.query(
      "select count(*) from audit_log where action in ('product.update', 'variant.update')",
    );
    expect(Number(audit.rows[0].count)).toBe(2);
  });

  it('cria categorias únicas', async () => {
    expect((await inject('POST', '/categories', gerente, { name: 'Camisetas' })).statusCode).toBe(
      201,
    );
    expect((await inject('POST', '/categories', gerente, { name: 'camisetas' })).statusCode).toBe(
      409,
    );
    expect((await inject('GET', '/categories', vendedor)).json().items).toHaveLength(1);
  });
});

describe('estoque', () => {
  let variantId: string;
  beforeAll(async () => {
    const res = await inject(
      'POST',
      '/products',
      gerente,
      productBody({
        name: 'Vestido',
        idempotencyKey: 'chave-vestido-estoque',
        variants: [
          { sku: 'VEST-M', priceCents: 15000, costCents: 6000, initialStock: 4, minStock: 5 },
        ],
      }),
    );
    variantId = res.json().product.variants[0].id;
  });

  it('registra entrada com lote e é idempotente', async () => {
    const body = { variantId, quantity: 6, note: 'Reposição', idempotencyKey: 'entrada-0001-abc' };
    const first = await inject('POST', '/stock/entries', gerente, body);
    expect(first.statusCode).toBe(201);
    expect(first.json().stock).toBe(10);
    const replay = await inject('POST', '/stock/entries', gerente, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, stock: 10 });
    const reused = await inject('POST', '/stock/entries', gerente, { ...body, quantity: 99 });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const batches = await ctx.pool.query(
      'select count(*) from stock_batches where variant_id = $1',
      [variantId],
    );
    expect(Number(batches.rows[0].count)).toBe(2); // inicial + reposição
  });

  it('vendedor não registra entrada nem ajuste', async () => {
    const entry = await inject('POST', '/stock/entries', vendedor, {
      variantId,
      quantity: 1,
      idempotencyKey: 'vend-entry-0001',
    });
    const adj = await inject('POST', '/stock/adjustments', vendedor, {
      variantId,
      delta: -1,
      reason: 'teste',
      idempotencyKey: 'vend-adj-00001',
    });
    expect(entry.statusCode).toBe(403);
    expect(adj.statusCode).toBe(403);
  });

  it('ajusta estoque exigindo motivo e impede saldo negativo', async () => {
    const ok = await inject('POST', '/stock/adjustments', gerente, {
      variantId,
      delta: -3,
      reason: 'Peça danificada',
      idempotencyKey: 'ajuste-0001-abc',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().stock).toBe(7);

    const tooMuch = await inject('POST', '/stock/adjustments', gerente, {
      variantId,
      delta: -50,
      reason: 'Contagem errada',
      idempotencyKey: 'ajuste-0002-abc',
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().error.code).toBe('INSUFFICIENT_STOCK');

    const noReason = await inject('POST', '/stock/adjustments', gerente, {
      variantId,
      delta: -1,
      reason: '',
      idempotencyKey: 'ajuste-0003-abc',
    });
    expect(noReason.statusCode).toBe(400);
  });

  it('não permite saldo negativo sob ajustes concorrentes', async () => {
    const res = await inject(
      'POST',
      '/products',
      gerente,
      productBody({
        name: 'Meia',
        idempotencyKey: 'chave-meia-concorrente',
        variants: [{ sku: 'MEIA-U', priceCents: 1500, initialStock: 5 }],
      }),
    );
    const id = res.json().product.variants[0].id;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        inject('POST', '/stock/adjustments', gerente, {
          variantId: id,
          delta: -2,
          reason: 'Concorrência',
          idempotencyKey: `conc-ajuste-${i}-xyz`,
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2); // 5 → 3 → 1
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(6);
    const level = await ctx.pool.query('select quantity from stock_levels where variant_id = $1', [
      id,
    ]);
    expect(level.rows[0].quantity).toBe(1);
  });

  it('estorna com movimentação compensatória, sem apagar o original', async () => {
    const adj = await inject('POST', '/stock/adjustments', gerente, {
      variantId,
      delta: 2,
      reason: 'Achado na contagem',
      idempotencyKey: 'ajuste-estornar-1',
    });
    const movementId = adj.json().movement.id;
    const stockBefore = adj.json().stock;

    const rev = await inject('POST', `/stock/movements/${movementId}/reverse`, gerente, {
      reason: 'Contagem refeita',
      idempotencyKey: 'estorno-0001-abc',
    });
    expect(rev.statusCode).toBe(201);
    expect(rev.json().movement).toMatchObject({
      type: 'estorno',
      quantityDelta: -2,
      reversesMovementId: movementId,
    });
    expect(rev.json().stock).toBe(stockBefore - 2);

    const again = await inject('POST', `/stock/movements/${movementId}/reverse`, gerente, {
      reason: 'Outra tentativa',
      idempotencyKey: 'estorno-0002-abc',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REVERSED');

    const original = await ctx.pool.query('select count(*) from stock_movements where id = $1', [
      movementId,
    ]);
    expect(Number(original.rows[0].count)).toBe(1);
  });

  it('lista estoque baixo e histórico de movimentações', async () => {
    const low = await inject('GET', '/stock/low', vendedor);
    expect(low.statusCode).toBe(200);
    const skus = low.json().items.map((v: { sku: string }) => v.sku);
    expect(skus).toContain('CB-M-PRETA'); // saldo 0 <= mínimo 3
    const hist = await inject('GET', `/stock/movements?variantId=${variantId}`, vendedor);
    expect(hist.json().items.length).toBeGreaterThanOrEqual(4);
    expect(hist.json().items[0]).toHaveProperty('actorName');
  });

  it('mantém o saldo igual à soma das movimentações em todas as variantes', async () => {
    const mismatch = await ctx.pool.query(`
      select v.id from product_variants v
      left join stock_levels s on s.variant_id = v.id
      where coalesce(s.quantity, 0) <> coalesce((select sum(quantity_delta) from stock_movements m where m.variant_id = v.id), 0)`);
    expect(mismatch.rows).toEqual([]);
  });
});

describe('infraestrutura', () => {
  it('responde health check e 404 padronizado', async () => {
    expect((await inject('GET', '/health')).json()).toEqual({ status: 'ok' });
    const nf = await inject('GET', '/nao-existe');
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('NOT_FOUND');
  });

  it('não vaza detalhes internos em erros', async () => {
    const bad = await inject('GET', '/products/nao-e-uuid', vendedor);
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).not.toMatch(/select|pg_|stack/i);
  });
});
