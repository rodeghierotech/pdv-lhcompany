import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { auth, openCash, setup } from './helpers.js';
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
  // Toda venda/devolução/cancelamento exige caixa aberto do operador (Fase 6).
  for (const token of [admin, gerente, vendedor]) await openCash(ctx, token);
});

afterAll(async () => {
  await assertGlobalInvariants();
  await ctx.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const inject = (method: Method, url: string, token?: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: token ? auth(token) : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

interface V {
  id: string;
  sku: string;
  priceCents: number;
}
let seq = 0;
const uid = () => `${++seq}-${Math.random().toString(36).slice(2, 10)}`;

async function newVariant(
  opts: { price?: number; stock?: number; name?: string; barcode?: string } = {},
): Promise<V> {
  const n = uid();
  const res = await inject('POST', '/products', gerente, {
    name: opts.name ?? `Produto ${n}`,
    idempotencyKey: `prod-key-${n}`,
    variants: [
      {
        sku: `SKU-${n}`,
        barcode: opts.barcode,
        priceCents: opts.price ?? 10000,
        costCents: 4000,
        initialStock: opts.stock ?? 10,
      },
    ],
  });
  expect(res.statusCode).toBe(201);
  return res.json().product.variants[0] as V;
}

async function newCustomer(opts: { creditLimitCents?: number | null; name?: string } = {}) {
  const res = await inject('POST', '/customers', gerente, {
    name: opts.name ?? `Cliente ${uid()}`,
    creditLimitCents: opts.creditLimitCents ?? null,
  });
  expect(res.statusCode).toBe(201);
  return res.json().customer as { id: string; name: string };
}

const item = (v: V, quantity = 1, discountCents = 0) => ({
  variantId: v.id,
  quantity,
  unitPriceCents: v.priceCents,
  discountCents,
});
const pay = (method: 'dinheiro' | 'pix' | 'debito' | 'credito', amountCents: number) => ({
  method,
  amountCents,
});
const saleBody = (items: unknown[], payments: unknown[], extra: Record<string, unknown> = {}) => ({
  idempotencyKey: `sale-key-${uid()}`,
  items,
  payments,
  ...extra,
});
const postSale = (token: string, body: unknown) => inject('POST', '/sales', token, body);

const stockOf = async (variantId: string): Promise<number> =>
  (await ctx.pool.query('select quantity from stock_levels where variant_id = $1', [variantId]))
    .rows[0].quantity;
const countRows = async (table: string): Promise<number> =>
  Number((await ctx.pool.query(`select count(*) from ${table}`)).rows[0].count);

/** Cria uma venda paga (ou com pagamentos informados) e devolve o DTO. */
async function makeSale(
  items: unknown[],
  payments: unknown[],
  extra: Record<string, unknown> = {},
  token = gerente,
) {
  const res = await postSale(token, saleBody(items, payments, extra));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().sale;
}

const cancel = (id: string, token = gerente, key = `cancel-key-${uid()}`) =>
  inject('POST', `/sales/${id}/cancel`, token, { reason: 'Cliente desistiu', idempotencyKey: key });
const ret = (
  id: string,
  items: unknown[],
  refunds: unknown[],
  key = `return-key-${uid()}`,
  token = gerente,
) =>
  inject('POST', `/sales/${id}/returns`, token, {
    items,
    refunds,
    reason: 'Não serviu',
    idempotencyKey: key,
  });

/** Invariantes que devem valer em QUALQUER estado do banco. */
async function assertGlobalInvariants() {
  const q = (sql: string) => ctx.pool.query(sql).then((r) => r.rows);
  // estoque = soma das movimentações, nunca negativo
  expect(
    await q(`select v.id from product_variants v left join stock_levels s on s.variant_id = v.id
             where coalesce(s.quantity, 0) <> coalesce((select sum(quantity_delta) from stock_movements m where m.variant_id = v.id), 0)
                or coalesce(s.quantity, 0) < 0`),
  ).toEqual([]);
  // totais da venda = soma dos itens
  expect(
    await q(`select s.id from sales s
             where s.subtotal_cents <> (select sum(quantity * unit_price_cents) from sale_items where sale_id = s.id)
                or s.total_cents <> (select sum(line_total_cents) from sale_items where sale_id = s.id)`),
  ).toEqual([]);
  // recebido líquido dentro do permitido; cancelada = nada recebido
  expect(
    await q(`select sale_id from sale_summary
             where (status = 'cancelada' and received_cents <> 0)
                or (status <> 'cancelada' and (received_cents < 0 or received_cents > total_cents - returned_cents))`),
  ).toEqual([]);
  // toda venda tem uma baixa por item; todo item devolvido tem entrada
  expect(
    await q(`select i.id from sale_items i where not exists
             (select 1 from stock_movements m where m.sale_item_id = i.id and m.quantity_delta = -i.quantity)`),
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
describe('criação de venda', () => {
  it('registra venda paga: totais, baixa de estoque e pagamento na mesma transação', async () => {
    const a = await newVariant({ price: 8990, stock: 10 });
    const b = await newVariant({ price: 15000, stock: 5 });
    const sale = await makeSale([item(a, 2), item(b, 1)], [pay('pix', 32980)]);

    expect(sale).toMatchObject({
      status: 'concluida',
      paymentStatus: 'pago',
      subtotalCents: 32980,
      discountCents: 0,
      totalCents: 32980,
      receivedCents: 32980,
      balanceCents: 0,
    });
    expect(sale.items.map((i: { sku: string }) => i.sku)).toEqual([a.sku, b.sku]); // ordem do carrinho
    expect(await stockOf(a.id)).toBe(8);
    expect(await stockOf(b.id)).toBe(4);

    const movement = await ctx.pool.query(
      `select m.type, m.quantity_delta from stock_movements m join sale_items i on i.id = m.sale_item_id
       where i.sale_id = $1 order by m.quantity_delta`,
      [sale.id],
    );
    expect(movement.rows).toEqual([
      { type: 'venda', quantity_delta: -2 },
      { type: 'venda', quantity_delta: -1 },
    ]);
    const audit = await ctx.pool.query(
      "select count(*) from audit_log where action = 'sale.create' and entity_id = $1",
      [sale.id],
    );
    expect(Number(audit.rows[0].count)).toBe(1);
  });

  it('aceita pagamento misto (várias formas)', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale(
      [item(v, 1)],
      [pay('dinheiro', 4000), pay('pix', 3000), pay('credito', 3000)],
    );
    expect(sale.paymentStatus).toBe('pago');
    expect(sale.payments.map((p: { method: string }) => p.method)).toEqual([
      'dinheiro',
      'pix',
      'credito',
    ]);
  });

  it('o servidor recusa preço desatualizado e não grava nada', async () => {
    const v = await newVariant({ price: 5000, stock: 4 });
    const before = {
      sales: await countRows('sales'),
      movements: await countRows('stock_movements'),
    };
    await inject('PATCH', `/variants/${v.id}`, gerente, { priceCents: 6000 });
    const res = await postSale(vendedor, saleBody([item(v, 1)], [pay('pix', 5000)]));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PRICE_CHANGED');
    expect(res.json().error.details[0].currentPriceCents).toBe(6000);
    expect(await countRows('sales')).toBe(before.sales);
    expect(await countRows('stock_movements')).toBe(before.movements);
    expect(await stockOf(v.id)).toBe(4);
  });

  it('estoque insuficiente em UM item cancela a venda inteira (atomicidade)', async () => {
    const ok = await newVariant({ stock: 10 });
    const short = await newVariant({ stock: 1 });
    const res = await postSale(
      vendedor,
      saleBody([item(ok, 2), item(short, 3)], [pay('pix', 50000)]),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.json().error.details).toEqual([
      expect.objectContaining({ sku: short.sku, requested: 3, available: 1 }),
    ]);
    expect(await stockOf(ok.id)).toBe(10); // nada foi baixado
    expect(await stockOf(short.id)).toBe(1);
  });

  it('recusa item inativo, variante repetida, pagamento a maior e valores inválidos', async () => {
    const v = await newVariant();
    await inject('PATCH', `/variants/${v.id}`, gerente, { active: false });
    const inactive = await postSale(vendedor, saleBody([item(v)], [pay('pix', 10000)]));
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().error.code).toBe('VARIANT_INACTIVE');

    const w = await newVariant({ price: 10000 });
    const dup = await postSale(vendedor, saleBody([item(w), item(w)], [pay('pix', 20000)]));
    expect(dup.statusCode).toBe(400);

    const over = await postSale(vendedor, saleBody([item(w)], [pay('pix', 10001)]));
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('OVERPAYMENT');

    for (const bad of [
      { ...item(w), quantity: 0 },
      { ...item(w), quantity: 1001 },
      { ...item(w), unitPriceCents: -1 },
    ]) {
      expect((await postSale(vendedor, saleBody([bad], []))).statusCode).toBe(400);
    }
    expect((await postSale(vendedor, saleBody([], []))).statusCode).toBe(400);
    expect(await stockOf(w.id)).toBe(10);
  });

  it('exige autenticação', async () => {
    expect((await inject('POST', '/sales', undefined, {})).statusCode).toBe(401);
    expect((await inject('GET', '/sales')).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('fiado, pagamento parcial e limite de crédito', () => {
  it('fiado exige cliente; venda fica "fiado" com o saldo como débito', async () => {
    const v = await newVariant({ price: 10000 });
    const noCustomer = await postSale(vendedor, saleBody([item(v)], []));
    expect(noCustomer.statusCode).toBe(422);
    expect(noCustomer.json().error.code).toBe('CUSTOMER_REQUIRED');
    expect(await stockOf(v.id)).toBe(10);

    const c = await newCustomer();
    const sale = await makeSale([item(v)], [], { customerId: c.id }, vendedor);
    expect(sale).toMatchObject({
      paymentStatus: 'fiado',
      receivedCents: 0,
      balanceCents: 10000,
      customerId: c.id,
    });
    const customer = (await inject('GET', `/customers/${c.id}`, vendedor)).json().customer;
    expect(customer.debtCents).toBe(10000);
  });

  it('pagamento parcial: "parcial", saldo vira débito e exige cliente', async () => {
    const v = await newVariant({ price: 10000 });
    const res = await postSale(vendedor, saleBody([item(v)], [pay('dinheiro', 3000)]));
    expect(res.json().error.code).toBe('CUSTOMER_REQUIRED');

    const c = await newCustomer();
    const sale = await makeSale([item(v)], [pay('dinheiro', 3000)], { customerId: c.id }, vendedor);
    expect(sale).toMatchObject({
      paymentStatus: 'parcial',
      receivedCents: 3000,
      balanceCents: 7000,
    });
    expect((await inject('GET', `/customers/${c.id}`, vendedor)).json().customer.debtCents).toBe(
      7000,
    );
  });

  it('respeita o limite de crédito configurado e não aplica limite quando não configurado', async () => {
    const limited = await newCustomer({ creditLimitCents: 10000 });
    const v = await newVariant({ price: 4000, stock: 50 });
    await makeSale([item(v, 2)], [], { customerId: limited.id }); // dívida 8000
    const over = await postSale(
      gerente,
      saleBody([item(v, 1)], [pay('pix', 1000)], { customerId: limited.id }),
    ); // +3000 > 10000
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(over.json().error.details).toMatchObject({
      currentDebtCents: 8000,
      requestedCents: 3000,
      availableCents: 2000,
    });
    expect(await stockOf(v.id)).toBe(48);
    // dentro do limite restante
    await makeSale([item(v, 1)], [pay('pix', 2000)], { customerId: limited.id }); // +2000 = 10000
    // sem limite
    const unlimited = await newCustomer();
    await makeSale([item(v, 10)], [], { customerId: unlimited.id });
  });

  it('limite de crédito vale sob concorrência (nenhum cliente passa do limite)', async () => {
    const c = await newCustomer({ creditLimitCents: 10000 });
    // Uma variante POR venda: assim o lock de estoque não serializa as requisições e só o lock
    // do cliente impede a corrida no limite de crédito.
    const variants = await Promise.all(
      Array.from({ length: 6 }, () => newVariant({ price: 4000, stock: 5 })),
    );
    const results = await Promise.all(
      variants.map((v) => postSale(gerente, saleBody([item(v, 1)], [], { customerId: c.id }))),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2); // 2 x 4000 = 8000; 3ª passaria de 10000
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(4);
    expect((await inject('GET', `/customers/${c.id}`, gerente)).json().customer.debtCents).toBe(
      8000,
    );
  });

  it('só gerente/admin definem limite de crédito', async () => {
    const asSeller = await inject('POST', '/customers', vendedor, {
      name: 'Maria Teste',
      creditLimitCents: 5000,
    });
    expect(asSeller.statusCode).toBe(403);
    const plain = await inject('POST', '/customers', vendedor, {
      name: 'Maria Teste',
      document: '123.456.789-09',
    });
    expect(plain.statusCode).toBe(201);
    expect(plain.json().customer.document).toBe('12345678909');
    const patch = await inject('PATCH', `/customers/${plain.json().customer.id}`, vendedor, {
      creditLimitCents: 100,
    });
    expect(patch.statusCode).toBe(403);
    expect(
      (
        await inject('POST', '/customers', gerente, { name: 'Outra', document: '12345678909' })
      ).json().error.code,
    ).toBe('DOCUMENT_IN_USE');
  });
});

// ---------------------------------------------------------------------------
describe('descontos por papel', () => {
  it('vendedor não concede desconto por padrão; gerente e admin podem', async () => {
    const v = await newVariant({ price: 10000, stock: 20 });
    const denied = await postSale(vendedor, saleBody([item(v, 1, 500)], [pay('pix', 9500)]));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('DISCOUNT_NOT_ALLOWED');
    expect(await stockOf(v.id)).toBe(20);

    const ok = await makeSale([item(v, 1, 1000)], [pay('pix', 9000)], {}, gerente);
    expect(ok).toMatchObject({ subtotalCents: 10000, discountCents: 1000, totalCents: 9000 });
    await makeSale([item(v, 1, 2000)], [pay('pix', 8000)], {}, admin);
  });

  it('limite por papel é configurável apenas pelo administrador e é aplicado', async () => {
    const v = await newVariant({ price: 10000, stock: 30 });
    expect(
      (await inject('PUT', '/settings/discount-limits/gerente', gerente, { maxDiscountBp: 1000 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await inject('PUT', '/settings/discount-limits/gerente', admin, { maxDiscountBp: 10001 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await inject('PUT', '/settings/discount-limits/gerente', admin, { maxDiscountBp: 1000 }))
        .statusCode,
    ).toBe(200); // 10%

    const over = await postSale(gerente, saleBody([item(v, 1, 1500)], [pay('pix', 8500)]));
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
    expect(over.json().error.details.maxDiscountBp).toBe(1000);
    await makeSale([item(v, 1, 1000)], [pay('pix', 9000)], {}, gerente); // exatamente 10%

    // habilitar vendedor com 5%
    await inject('PUT', '/settings/discount-limits/vendedor', admin, { maxDiscountBp: 500 });
    await makeSale([item(v, 1, 500)], [pay('pix', 9500)], {}, vendedor);
    expect(
      (await postSale(vendedor, saleBody([item(v, 1, 501)], [pay('pix', 9499)]))).statusCode,
    ).toBe(403);

    const limits = (await inject('GET', '/settings/discount-limits', vendedor)).json().items;
    expect(limits).toEqual([
      { role: 'admin', maxDiscountBp: 10000 },
      { role: 'gerente', maxDiscountBp: 1000 },
      { role: 'vendedor', maxDiscountBp: 500 },
    ]);
    const audit = await ctx.pool.query(
      "select count(*) from audit_log where action = 'settings.discount_limit'",
    );
    expect(Number(audit.rows[0].count)).toBe(2);

    // restaura o padrão para os demais testes
    await inject('PUT', '/settings/discount-limits/gerente', admin, { maxDiscountBp: 10000 });
    await inject('PUT', '/settings/discount-limits/vendedor', admin, { maxDiscountBp: 0 });
  });

  it('desconto maior que o valor do item é inválido', async () => {
    const v = await newVariant({ price: 1000 });
    const res = await postSale(admin, saleBody([item(v, 1, 1001)], []));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_DISCOUNT');
  });
});

// ---------------------------------------------------------------------------
describe('idempotência', () => {
  it('reenvio da mesma venda devolve a original sem duplicar venda, pagamento nem baixa', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const body = saleBody([item(v, 2)], [pay('pix', 20000)]);
    const first = await postSale(vendedor, body);
    const second = await postSale(vendedor, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().sale.id).toBe(first.json().sale.id);
    expect(await stockOf(v.id)).toBe(8);
    const payments = await ctx.pool.query('select count(*) from payments where sale_id = $1', [
      first.json().sale.id,
    ]);
    expect(Number(payments.rows[0].count)).toBe(1);
  });

  it('mesma chave com dados diferentes é rejeitada', async () => {
    const v = await newVariant({ price: 10000 });
    const body = saleBody([item(v, 1)], [pay('pix', 10000)]);
    expect((await postSale(vendedor, body)).statusCode).toBe(201);
    const res = await postSale(vendedor, {
      ...body,
      items: [item(v, 2)],
      payments: [pay('pix', 20000)],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await stockOf(v.id)).toBe(9);
  });

  it('requisições simultâneas com a mesma chave criam UMA venda e baixam o estoque UMA vez', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const body = saleBody([item(v, 3)], [pay('pix', 30000)]);
    const results = await Promise.all(Array.from({ length: 6 }, () => postSale(vendedor, body)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(new Set(results.map((r) => r.json().sale.id)).size).toBe(1);
    expect(await stockOf(v.id)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
describe('concorrência de estoque', () => {
  it('vendas simultâneas nunca vendem mais que o estoque', async () => {
    const v = await newVariant({ price: 1000, stock: 5 });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        postSale(vendedor, saleBody([item(v, 1)], [pay('pix', 1000)])),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(7);
    expect(await stockOf(v.id)).toBe(0);
  });

  it('vendas com os mesmos produtos em ordem oposta não geram deadlock', async () => {
    const a = await newVariant({ price: 1000, stock: 20 });
    const b = await newVariant({ price: 1000, stock: 20 });
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        postSale(
          vendedor,
          saleBody(i % 2 ? [item(a), item(b)] : [item(b), item(a)], [pay('pix', 2000)]),
        ),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(16).fill(201));
    expect(await stockOf(a.id)).toBe(4);
    expect(await stockOf(b.id)).toBe(4);
  });

  it('venda concorrente com ajuste manual de estoque mantém o saldo consistente', async () => {
    const v = await newVariant({ price: 1000, stock: 4 });
    const sales = Array.from({ length: 6 }, () =>
      postSale(vendedor, saleBody([item(v)], [pay('pix', 1000)])),
    );
    const adjust = inject('POST', '/stock/adjustments', gerente, {
      variantId: v.id,
      delta: -2,
      reason: 'Perda',
      idempotencyKey: `adj-${uid()}-abc`,
    });
    const results = await Promise.all([...sales, adjust]);
    const sold = results.slice(0, 6).filter((r) => r.statusCode === 201).length;
    const adjusted = results[6]!.statusCode === 201 ? 2 : 0;
    expect(await stockOf(v.id)).toBe(4 - sold - adjusted);
    expect(await stockOf(v.id)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
describe('autorização', () => {
  it('vendedor vende e consulta, mas não cancela nem devolve', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 10000)], {}, vendedor);
    expect((await inject('GET', `/sales/${sale.id}`, vendedor)).statusCode).toBe(200);
    expect((await cancel(sale.id, vendedor)).statusCode).toBe(403);
    expect(
      (
        await ret(
          sale.id,
          [{ saleItemId: sale.items[0].id, quantity: 1 }],
          [pay('pix', 10000)],
          undefined,
          vendedor,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await inject('POST', `/sales/${sale.id}/returns/preview`, vendedor, {
          items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(403);
    expect((await inject('GET', `/sales/${sale.id}`, vendedor)).json().sale.status).toBe(
      'concluida',
    );
  });

  it('usuário desativado perde acesso imediatamente', async () => {
    const token = ctx.tokenFor('vendedor');
    await ctx.pool.query("update users set active = false where email = 'vendedor@teste.com'");
    expect((await postSale(token, saleBody([], []))).statusCode).toBe(401);
    await ctx.pool.query("update users set active = true where email = 'vendedor@teste.com'");
  });
});

// ---------------------------------------------------------------------------
describe('cancelamento', () => {
  it('estorna pagamentos e devolve o estoque com movimentações compensatórias', async () => {
    const a = await newVariant({ price: 10000, stock: 10 });
    const b = await newVariant({ price: 5000, stock: 10 });
    const sale = await makeSale(
      [item(a, 2), item(b, 1)],
      [pay('dinheiro', 10000), pay('pix', 15000)],
    );
    expect(await stockOf(a.id)).toBe(8);

    const res = await cancel(sale.id);
    expect(res.statusCode).toBe(201);
    const cancelled = res.json().sale;
    expect(cancelled).toMatchObject({
      status: 'cancelada',
      paymentStatus: null,
      receivedCents: 0,
      balanceCents: 0,
    });
    expect(cancelled.cancelReason).toBe('Cliente desistiu');
    expect(await stockOf(a.id)).toBe(10);
    expect(await stockOf(b.id)).toBe(10);

    // pagamentos originais permanecem; estornos espelham forma e valor
    const kinds = cancelled.payments.map(
      (p: { kind: string; method: string; amountCents: number }) =>
        `${p.kind}:${p.method}:${p.amountCents}`,
    );
    expect(kinds).toEqual([
      'recebimento:dinheiro:10000',
      'recebimento:pix:15000',
      'estorno:dinheiro:10000',
      'estorno:pix:15000',
    ]);
    // movimentações originais intactas + compensatórias referenciando-as
    const mv = await ctx.pool.query(
      `select count(*) filter (where type = 'venda') as vendas,
              count(*) filter (where type = 'estorno' and reverses_movement_id is not null) as estornos
       from stock_movements where variant_id = any($1::uuid[])`,
      [[a.id, b.id]],
    );
    expect(mv.rows[0]).toEqual({ vendas: '2', estornos: '2' });
  });

  it('é idempotente: reenvio com a mesma chave devolve a venda; outra chave é recusada', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 1)], [pay('pix', 10000)]);
    const key = `cancel-key-${uid()}`;
    expect((await cancel(sale.id, gerente, key)).statusCode).toBe(201);
    const replay = await cancel(sale.id, gerente, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const other = await cancel(sale.id, gerente);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('ALREADY_CANCELLED');
    expect(await stockOf(v.id)).toBe(10); // estoque devolvido uma única vez
  });

  it('cancelamentos simultâneos: apenas um é aplicado', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 4)], [pay('pix', 40000)]);
    const results = await Promise.all(Array.from({ length: 5 }, () => cancel(sale.id)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
    expect(await stockOf(v.id)).toBe(10);
    const refunds = await ctx.pool.query(
      "select count(*) from payments where sale_id = $1 and kind = 'estorno'",
      [sale.id],
    );
    expect(Number(refunds.rows[0].count)).toBe(1);
  });

  it('cancelar venda fiada zera o débito do cliente sem estornar dinheiro', async () => {
    const c = await newCustomer();
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 1)], [pay('pix', 2000)], { customerId: c.id });
    expect((await inject('GET', `/customers/${c.id}`, gerente)).json().customer.debtCents).toBe(
      8000,
    );
    const res = await cancel(sale.id);
    expect(
      res.json().sale.payments.filter((p: { kind: string }) => p.kind === 'estorno'),
    ).toHaveLength(1); // só o recebido
    expect((await inject('GET', `/customers/${c.id}`, gerente)).json().customer.debtCents).toBe(0);
  });

  it('venda com devolução não pode ser cancelada', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 2)], [pay('pix', 20000)]);
    expect(
      (await ret(sale.id, [{ saleItemId: sale.items[0].id, quantity: 1 }], [pay('pix', 10000)]))
        .statusCode,
    ).toBe(201);
    const res = await cancel(sale.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HAS_RETURNS');
  });

  it('exige motivo', async () => {
    const v = await newVariant();
    const sale = await makeSale([item(v)], [pay('pix', 10000)]);
    const res = await inject('POST', `/sales/${sale.id}/cancel`, gerente, {
      reason: '',
      idempotencyKey: `cancel-key-${uid()}`,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('devolução', () => {
  it('devolução parcial de venda paga: devolve estoque, exige reembolso exato e mantém a venda concluída', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 3)], [pay('dinheiro', 30000)]);
    const itemId = sale.items[0].id;
    expect(await stockOf(v.id)).toBe(7);

    const preview = await inject('POST', `/sales/${sale.id}/returns/preview`, gerente, {
      items: [{ saleItemId: itemId, quantity: 2 }],
    });
    expect(preview.json().preview).toEqual({
      valueCents: 20000,
      refundDueCents: 20000,
      debtReductionCents: 0,
    });

    const wrong = await ret(
      sale.id,
      [{ saleItemId: itemId, quantity: 2 }],
      [pay('dinheiro', 15000)],
    );
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('REFUND_MISMATCH');
    expect(wrong.json().error.details.expectedRefundCents).toBe(20000);
    const none = await ret(sale.id, [{ saleItemId: itemId, quantity: 2 }], []);
    expect(none.json().error.code).toBe('REFUND_MISMATCH');
    expect(await stockOf(v.id)).toBe(7); // recusas não alteram nada

    const ok = await ret(sale.id, [{ saleItemId: itemId, quantity: 2 }], [pay('dinheiro', 20000)]);
    expect(ok.statusCode).toBe(201);
    const s = ok.json().sale;
    expect(s).toMatchObject({
      status: 'concluida',
      returnedCents: 20000,
      receivedCents: 10000,
      paymentStatus: 'pago',
      balanceCents: 0,
    });
    expect(s.items[0].returnedQuantity).toBe(2);
    expect(s.returns).toHaveLength(1);
    expect(s.returns[0]).toMatchObject({ valueCents: 20000, reason: 'Não serviu' });
    expect(await stockOf(v.id)).toBe(9);
    const mv = await ctx.pool.query(
      'select type, quantity_delta from stock_movements where sale_return_item_id is not null and variant_id = $1',
      [v.id],
    );
    expect(mv.rows).toEqual([{ type: 'devolucao', quantity_delta: 2 }]);
  });

  it('devolver todos os itens leva a venda a "devolvida" (terminal)', async () => {
    const a = await newVariant({ price: 10000, stock: 10 });
    const b = await newVariant({ price: 5000, stock: 10 });
    const sale = await makeSale([item(a, 1), item(b, 2)], [pay('pix', 20000)]);
    const [ia, ib] = sale.items;
    const first = await ret(sale.id, [{ saleItemId: ia.id, quantity: 1 }], [pay('pix', 10000)]);
    expect(first.json().sale.status).toBe('concluida');
    const last = await ret(sale.id, [{ saleItemId: ib.id, quantity: 2 }], [pay('pix', 10000)]);
    expect(last.json().sale).toMatchObject({
      status: 'devolvida',
      receivedCents: 0,
      returnedCents: 20000,
    });
    expect(await stockOf(a.id)).toBe(10);
    expect(await stockOf(b.id)).toBe(10);

    const again = await ret(sale.id, [{ saleItemId: ia.id, quantity: 1 }], [pay('pix', 10000)]);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('SALE_RETURNED');
    expect((await cancel(sale.id)).json().error.code).toBe('SALE_RETURNED');
  });

  it('com desconto, devoluções parciais somam exatamente o total pago (sem perder centavos)', async () => {
    const v = await newVariant({ price: 3333, stock: 10 });
    // 3 x 33,33 = 99,99 - desconto 0,98 = 99,01 pago
    const sale = await makeSale([item(v, 3, 98)], [pay('pix', 9901)]);
    const id = sale.items[0].id;
    let refunded = 0;
    for (const expectedStatus of ['concluida', 'concluida', 'devolvida']) {
      const preview = (
        await inject('POST', `/sales/${sale.id}/returns/preview`, gerente, {
          items: [{ saleItemId: id, quantity: 1 }],
        })
      ).json().preview;
      const res = await ret(
        sale.id,
        [{ saleItemId: id, quantity: 1 }],
        [pay('pix', preview.refundDueCents)],
      );
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().sale.status).toBe(expectedStatus);
      refunded += preview.refundDueCents;
    }
    expect(refunded).toBe(9901);
  });

  it('devolução de venda fiada abate o débito e não gera reembolso', async () => {
    const c = await newCustomer();
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 2)], [], { customerId: c.id });
    const id = sale.items[0].id;
    const withRefund = await ret(sale.id, [{ saleItemId: id, quantity: 1 }], [pay('pix', 10000)]);
    expect(withRefund.json().error.code).toBe('REFUND_MISMATCH');
    expect(withRefund.json().error.details.expectedRefundCents).toBe(0);

    const ok = await ret(sale.id, [{ saleItemId: id, quantity: 1 }], []);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().sale).toMatchObject({
      balanceCents: 10000,
      paymentStatus: 'fiado',
      receivedCents: 0,
    });
    expect((await inject('GET', `/customers/${c.id}`, gerente)).json().customer.debtCents).toBe(
      10000,
    );
    expect(ok.json().sale.payments).toHaveLength(0);
  });

  it('venda parcial: a devolução abate a dívida primeiro e reembolsa apenas o excedente', async () => {
    const c = await newCustomer();
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 1)], [pay('dinheiro', 3000)], { customerId: c.id }); // pagou 30, deve 70
    const preview = await inject('POST', `/sales/${sale.id}/returns/preview`, gerente, {
      items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
    });
    expect(preview.json().preview).toEqual({
      valueCents: 10000,
      refundDueCents: 3000,
      debtReductionCents: 7000,
    });
    const ok = await ret(
      sale.id,
      [{ saleItemId: sale.items[0].id, quantity: 1 }],
      [pay('dinheiro', 3000)],
    );
    expect(ok.json().sale).toMatchObject({
      status: 'devolvida',
      receivedCents: 0,
      balanceCents: 0,
    });
    expect((await inject('GET', `/customers/${c.id}`, gerente)).json().customer.debtCents).toBe(0);
  });

  it('rejeita item de outra venda e quantidade acima do vendido', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const s1 = await makeSale([item(v, 2)], [pay('pix', 20000)]);
    const s2 = await makeSale([item(v, 1)], [pay('pix', 10000)]);
    const foreign = await ret(
      s1.id,
      [{ saleItemId: s2.items[0].id, quantity: 1 }],
      [pay('pix', 10000)],
    );
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error.code).toBe('ITEM_NOT_IN_SALE');
    const tooMany = await ret(
      s1.id,
      [{ saleItemId: s1.items[0].id, quantity: 3 }],
      [pay('pix', 30000)],
    );
    expect(tooMany.json().error.code).toBe('RETURN_EXCEEDS_SOLD');
    expect(await stockOf(v.id)).toBe(7);
  });

  it('é idempotente: reenvio não devolve estoque nem dinheiro duas vezes', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 2)], [pay('pix', 20000)]);
    const body = {
      items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
      refunds: [pay('pix', 10000)],
      reason: 'Defeito',
      idempotencyKey: `return-key-${uid()}`,
    };
    const first = await inject('POST', `/sales/${sale.id}/returns`, gerente, body);
    const second = await inject('POST', `/sales/${sale.id}/returns`, gerente, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(await stockOf(v.id)).toBe(9);
    expect(second.json().sale.returnedCents).toBe(10000);
    const diff = await inject('POST', `/sales/${sale.id}/returns`, gerente, {
      ...body,
      reason: 'Outro motivo',
    });
    expect(diff.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('devoluções simultâneas do mesmo item não passam da quantidade vendida', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 3)], [pay('pix', 30000)]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        ret(sale.id, [{ saleItemId: sale.items[0].id, quantity: 2 }], [pay('pix', 20000)]),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(3);
    expect(await stockOf(v.id)).toBe(9); // 10 - 3 + 2
    const s = (await inject('GET', `/sales/${sale.id}`, gerente)).json().sale;
    expect(s.items[0].returnedQuantity).toBe(2);
    expect(s.receivedCents).toBe(10000);
  });

  it('devolução e cancelamento simultâneos: só um prevalece e o estoque fecha', async () => {
    const v = await newVariant({ price: 10000, stock: 10 });
    const sale = await makeSale([item(v, 2)], [pay('pix', 20000)]);
    const results = await Promise.all([
      cancel(sale.id),
      ret(sale.id, [{ saleItemId: sale.items[0].id, quantity: 2 }], [pay('pix', 20000)]),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await stockOf(v.id)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
describe('histórico e detalhamento', () => {
  it('lista com filtros, paginação e detalhe completo', async () => {
    const c = await newCustomer({ name: 'Joana Histórico' });
    const v = await newVariant({ price: 10000, stock: 30 });
    const fiado = await makeSale([item(v)], [], { customerId: c.id });
    const parcial = await makeSale([item(v)], [pay('pix', 4000)], { customerId: c.id });
    const paga = await makeSale([item(v)], [pay('pix', 10000)], { customerId: c.id });
    const cancelled = await makeSale([item(v)], [pay('pix', 10000)], { customerId: c.id });
    await cancel(cancelled.id);

    const byCustomer = (await inject('GET', `/sales?customerId=${c.id}`, vendedor)).json();
    expect(byCustomer.total).toBe(4);
    expect(byCustomer.items[0].id).toBe(cancelled.id); // mais recente primeiro

    const status = async (qs: string) =>
      (await inject('GET', `/sales?customerId=${c.id}&${qs}`, vendedor))
        .json()
        .items.map((s: { id: string }) => s.id);
    expect(await status('paymentStatus=fiado')).toEqual([fiado.id]);
    expect(await status('paymentStatus=parcial')).toEqual([parcial.id]);
    expect(await status('paymentStatus=pago')).toEqual([paga.id]);
    expect(await status('status=cancelada')).toEqual([cancelled.id]);
    expect(await status(`q=${paga.number}`)).toEqual([paga.id]);
    expect((await inject('GET', '/sales?q=joana', vendedor)).json().total).toBeGreaterThanOrEqual(
      4,
    );

    const page = (
      await inject('GET', `/sales?customerId=${c.id}&pageSize=2&page=2`, vendedor)
    ).json();
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    expect(
      (await inject('GET', `/sales?customerId=${c.id}&from=${today}&to=${today}`, vendedor)).json()
        .total,
    ).toBe(4);
    expect(
      (await inject('GET', `/sales?customerId=${c.id}&to=2000-01-01`, vendedor)).json().total,
    ).toBe(0);

    const detail = (await inject('GET', `/sales/${parcial.id}`, vendedor)).json().sale;
    expect(detail).toMatchObject({
      customerName: 'Joana Histórico',
      sellerName: 'Teste gerente',
      paymentStatus: 'parcial',
      balanceCents: 6000,
    });
    expect(detail.items[0]).toMatchObject({
      sku: v.sku,
      quantity: 1,
      unitPriceCents: 10000,
      lineTotalCents: 10000,
    });
    expect(
      (await inject('GET', '/sales/00000000-0000-4000-8000-000000000000', vendedor)).statusCode,
    ).toBe(404);
    expect((await inject('GET', '/sales/abc', vendedor)).statusCode).toBe(400);
  });

  it('o histórico preserva os dados do momento da venda mesmo se o cadastro mudar', async () => {
    const v = await newVariant({ price: 7000, name: 'Camisa Antiga' });
    const sale = await makeSale([item(v, 1)], [pay('pix', 7000)]);
    await inject('PATCH', `/variants/${v.id}`, gerente, { priceCents: 9900 });
    await inject(
      'PATCH',
      `/products/${(await ctx.pool.query('select product_id from product_variants where id = $1', [v.id])).rows[0].product_id}`,
      gerente,
      { name: 'Camisa Nova' },
    );
    const detail = (await inject('GET', `/sales/${sale.id}`, vendedor)).json().sale;
    expect(detail.items[0]).toMatchObject({ productName: 'Camisa Antiga', unitPriceCents: 7000 });
  });
});

// ---------------------------------------------------------------------------
describe('busca de produtos no balcão', () => {
  it('encontra por código de barras, SKU e nome; exatos primeiro; ignora inativos', async () => {
    const v = await newVariant({
      name: 'Jaqueta Jeans Azul',
      barcode: '7891234567895',
      price: 19990,
      stock: 3,
    });
    const byBarcode = (await inject('GET', '/pos/variants?q=7891234567895', vendedor)).json().items;
    expect(byBarcode).toHaveLength(1);
    expect(byBarcode[0]).toMatchObject({
      variantId: v.id,
      priceCents: 19990,
      stock: 3,
      productName: 'Jaqueta Jeans Azul',
    });
    expect(
      (await inject('GET', `/pos/variants?q=${v.sku.toLowerCase()}`, vendedor)).json().items[0]
        .variantId,
    ).toBe(v.id);
    expect(
      (await inject('GET', '/pos/variants?q=jaqueta', vendedor)).json().items[0].variantId,
    ).toBe(v.id);
    expect((await inject('GET', '/pos/variants?q=%25', vendedor)).json().items).toEqual([]);
    await inject('PATCH', `/variants/${v.id}`, gerente, { active: false });
    expect((await inject('GET', '/pos/variants?q=jaqueta', vendedor)).json().items).toEqual([]);
    expect((await inject('GET', '/pos/variants?q=', vendedor)).statusCode).toBe(400);
    expect((await inject('GET', '/pos/variants?q=x')).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('barreiras de integridade no banco (última linha de defesa)', () => {
  async function inTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<{ error?: Error }> {
    const c = await ctx.pool.connect();
    try {
      await c.query('begin');
      await fn(c);
      await c.query('commit');
      return {};
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      return { error: err as Error };
    } finally {
      c.release();
    }
  }

  const sellerId = () => ctx.users.gerente.id;

  it('venda, itens e pagamentos são imutáveis', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 10000)]);
    await expect(
      ctx.pool.query('update sales set total_cents = 1 where id = $1', [sale.id]),
    ).rejects.toThrow(/imutáveis|check/);
    await expect(ctx.pool.query('delete from sales where id = $1', [sale.id])).rejects.toThrow(
      /imutável/,
    );
    await expect(
      ctx.pool.query('update sale_items set quantity = 9 where sale_id = $1', [sale.id]),
    ).rejects.toThrow(/imutável/);
    await expect(
      ctx.pool.query('delete from payments where sale_id = $1', [sale.id]),
    ).rejects.toThrow(/imutável/);
    await expect(
      ctx.pool.query('update payments set amount_cents = 1 where sale_id = $1', [sale.id]),
    ).rejects.toThrow(/imutável/);
  });

  it('venda cancelada/devolvida é estado terminal', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 10000)]);
    await cancel(sale.id);
    await expect(
      ctx.pool.query(
        "update sales set status = 'concluida', cancelled_at = null, cancelled_by = null, cancel_reason = null, cancel_key = null where id = $1",
        [sale.id],
      ),
    ).rejects.toThrow(/terminal/);
  });

  it('recusa no COMMIT pagamento que ultrapassa o total da venda', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 10000)]);
    const { error } = await inTx((c) =>
      c
        .query(
          `insert into payments (sale_id, kind, method, amount_cents, created_by, cash_session_id)
           values ($1, 'recebimento', 'pix', 1, $2, (select id from cash_sessions where opened_by = $2 and status = 'aberto'))`,
          [sale.id, sellerId()],
        )
        .then(() => undefined),
    );
    expect(error?.message).toMatch(/sale_integrity.*fora do permitido/);
  });

  it('recusa no COMMIT estorno que deixaria o recebido negativo', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 5000)], {
      customerId: (await newCustomer()).id,
    });
    const { error } = await inTx((c) =>
      c
        .query(
          `insert into payments (sale_id, kind, method, amount_cents, created_by, cash_session_id)
           values ($1, 'estorno', 'pix', 5001, $2, (select id from cash_sessions where opened_by = $2 and status = 'aberto'))`,
          [sale.id, sellerId()],
        )
        .then(() => undefined),
    );
    expect(error?.message).toMatch(/sale_integrity/);
  });

  it('recusa no COMMIT venda sem itens e item sem baixa de estoque', async () => {
    const noItems = await inTx((c) =>
      c
        .query(
          `insert into sales (seller_id, subtotal_cents, discount_cents, total_cents, idempotency_key, request_hash, cash_session_id)
           values ($1, 0, 0, 0, $2, 'x', (select id from cash_sessions where opened_by = $1 and status = 'aberto'))`,
          [sellerId(), `raw-${uid()}`],
        )
        .then(() => undefined),
    );
    expect(noItems.error?.message).toMatch(/sem itens/);

    const v = await newVariant({ price: 10000 });
    const noStock = await inTx(async (c) => {
      const s = await c.query(
        `insert into sales (seller_id, subtotal_cents, discount_cents, total_cents, idempotency_key, request_hash, cash_session_id)
         values ($1, 10000, 0, 10000, $2, 'x', (select id from cash_sessions where opened_by = $1 and status = 'aberto')) returning id`,
        [sellerId(), `raw-${uid()}`],
      );
      await c.query(
        `insert into sale_items (sale_id, variant_id, position, sku, product_name, quantity, unit_price_cents, unit_cost_cents, discount_cents, line_total_cents)
         values ($1, $2, 0, 'X', 'X', 1, 10000, 0, 0, 10000)`,
        [s.rows[0].id, v.id],
      );
    });
    expect(noStock.error?.message).toMatch(/sem baixa de estoque/);
    expect(await stockOf(v.id)).toBe(10);
  });

  it('recusa no COMMIT totais da venda que não conferem com os itens', async () => {
    const v = await newVariant({ price: 10000 });
    const { error } = await inTx(async (c) => {
      const s = await c.query(
        `insert into sales (seller_id, subtotal_cents, discount_cents, total_cents, idempotency_key, request_hash, cash_session_id)
         values ($1, 99999, 0, 99999, $2, 'x', (select id from cash_sessions where opened_by = $1 and status = 'aberto')) returning id`,
        [sellerId(), `raw-${uid()}`],
      );
      const i = await c.query(
        `insert into sale_items (sale_id, variant_id, position, sku, product_name, quantity, unit_price_cents, unit_cost_cents, discount_cents, line_total_cents)
         values ($1, $2, 0, 'X', 'X', 1, 10000, 0, 0, 10000) returning id`,
        [s.rows[0].id, v.id],
      );
      await c.query(
        `insert into stock_movements (variant_id, type, quantity_delta, sale_item_id) values ($1, 'venda', -1, $2)`,
        [v.id, i.rows[0].id],
      );
    });
    expect(error?.message).toMatch(/totais da venda/);
  });

  it('recusa no COMMIT cancelamento direto sem estornar pagamentos e estoque', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 10000)]);
    const { error } = await inTx((c) =>
      c
        .query(
          "update sales set status = 'cancelada', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'x', cancel_key = $3, cancel_session_id = (select id from cash_sessions where opened_by = $2 and status = 'aberto') where id = $1",
          [sale.id, sellerId(), `raw-${uid()}`],
        )
        .then(() => undefined),
    );
    expect(error?.message).toMatch(/sale_integrity/);
    expect((await inject('GET', `/sales/${sale.id}`, gerente)).json().sale.status).toBe(
      'concluida',
    );
  });

  it('recusa "devolvida" sem devoluções e devolução sem entrada de estoque', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 10000)]);
    const fake = await inTx((c) =>
      c
        .query("update sales set status = 'devolvida' where id = $1", [sale.id])
        .then(() => undefined),
    );
    expect(fake.error?.message).toMatch(/sale_integrity/);

    const noStock = await inTx(async (c) => {
      const r = await c.query(
        `insert into sale_returns (sale_id, reason, idempotency_key, request_hash, created_by, cash_session_id)
         values ($1, 'abc', $2, 'x', $3, (select id from cash_sessions where opened_by = $3 and status = 'aberto')) returning id`,
        [sale.id, `raw-${uid()}`, sellerId()],
      );
      await c.query(
        'insert into sale_return_items (return_id, sale_item_id, quantity, amount_cents) values ($1, $2, 1, 10000)',
        [r.rows[0].id, sale.items[0].id],
      );
    });
    expect(noStock.error?.message).toMatch(/sale_integrity/);
  });

  it('estorno de pagamento precisa espelhar o recebimento original', async () => {
    const v = await newVariant({ price: 10000 });
    const sale = await makeSale([item(v)], [pay('pix', 10000)]);
    const paymentId = sale.payments[0].id;
    const { error } = await inTx((c) =>
      c
        .query(
          `insert into payments (sale_id, kind, method, amount_cents, reverses_payment_id, created_by, cash_session_id)
           values ($1, 'estorno', 'dinheiro', 10000, $2, $3, (select id from cash_sessions where opened_by = $3 and status = 'aberto'))`,
          [sale.id, paymentId, sellerId()],
        )
        .then(() => undefined),
    );
    expect(error?.message).toMatch(/estorno de pagamento inválido/);
  });

  it('movimentação de venda exige vínculo com o item vendido', async () => {
    const v = await newVariant();
    await expect(
      ctx.pool.query(
        "insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'venda', -1)",
        [v.id],
      ),
    ).rejects.toThrow(/stock_movements_sale_ref_ck/);
    expect(await stockOf(v.id)).toBe(10);
  });

  it('invariantes globais valem após toda a bateria de operações', async () => {
    await assertGlobalInvariants();
  });
});
