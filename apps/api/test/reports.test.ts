import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@pdv/shared';
import { createUser } from '../src/modules/auth/service.js';
import { auth, openCash, setup, TEST_PASSWORD } from './helpers.js';
import type { TestCtx } from './helpers.js';

let ctx: TestCtx;
type Method = 'GET' | 'POST';
const inject = (method: Method, url: string, token?: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: token ? auth(token) : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

let seq = 0;
const uid = () => `${++seq}-${Math.random().toString(36).slice(2, 10)}`;

interface Operator {
  id: string;
  token: string;
  sessionId: string;
}
async function newOperator(role: Role): Promise<Operator> {
  const user = await createUser(
    ctx.pool,
    { name: `Op ${role} ${uid()}`, email: `${uid()}@teste.com`, password: TEST_PASSWORD, role },
    null,
  );
  const token = ctx.app.signAccessToken(user);
  return { id: user.id, token, sessionId: await openCash(ctx, token, 0) };
}
interface V {
  id: string;
  priceCents: number;
}
async function newVariant(price: number, minStock = 0): Promise<V> {
  const n = uid();
  const res = await inject('POST', '/products', ctx.tokenFor('gerente'), {
    name: `Produto ${n}`,
    idempotencyKey: `prod-key-${n}`,
    variants: [{ sku: `SKU-${n}`, priceCents: price, costCents: 1000, initialStock: 50, minStock }],
  });
  expect(res.statusCode).toBe(201);
  return res.json().product.variants[0] as V;
}
async function sell(
  op: Operator,
  items: { v: V; q: number }[],
  payments: unknown[],
  extra: Record<string, unknown> = {},
) {
  const res = await inject('POST', '/sales', op.token, {
    idempotencyKey: `sale-key-${uid()}`,
    items: items.map(({ v, q }) => ({
      variantId: v.id,
      quantity: q,
      unitPriceCents: v.priceCents,
      discountCents: 0,
    })),
    payments,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().sale as { id: string; items: { id: string }[]; number: number };
}
const pay = (method: string, amountCents: number) => ({ method, amountCents });

interface Fixture {
  g: Operator;
  v: Operator;
  A: V;
  B: V;
  customerName: string;
}
let fx: Fixture;

beforeAll(async () => {
  ctx = await setup();
  const g = await newOperator('gerente');
  const v = await newOperator('vendedor');
  const A = await newVariant(10000);
  const B = await newVariant(2500);
  const customerRes = await inject('POST', '/customers', g.token, {
    name: "=cmd|' /C calc'!A0",
  });
  const customer = customerRes.json().customer as { id: string; name: string };

  // Venda 1 (gerente): 2xA à vista em dinheiro.
  const s1 = await sell(g, [{ v: A, q: 2 }], [pay('dinheiro', 20000)]);
  // Venda 2 (vendedor): 1xA + 2xB = 15000 com cliente, só 5000 em PIX (fiado parcial 10000).
  const s2 = await sell(
    v,
    [
      { v: A, q: 1 },
      { v: B, q: 2 },
    ],
    [pay('pix', 5000)],
    { customerId: customer.id },
  );
  // Venda 3 (gerente): 1xB em crédito e cancelada em seguida.
  const s3 = await sell(g, [{ v: B, q: 1 }], [pay('credito', 2500)]);
  const cancel = await inject('POST', `/sales/${s3.id}/cancel`, g.token, {
    reason: 'Cliente desistiu',
    idempotencyKey: `cancel-${uid()}`,
  });
  expect(cancel.statusCode, cancel.body).toBe(201);
  // Devolução de 1xA da venda 1, reembolso em dinheiro.
  const ret = await inject('POST', `/sales/${s1.id}/returns`, g.token, {
    items: [{ saleItemId: s1.items[0]!.id, quantity: 1 }],
    refunds: [pay('dinheiro', 10000)],
    reason: 'Tamanho errado',
    idempotencyKey: `ret-${uid()}`,
  });
  expect(ret.statusCode, ret.body).toBe(201);
  // Recebimento posterior de fiado: 4000 em dinheiro (dívida cai para 6000).
  const rec = await inject('POST', `/sales/${s2.id}/receipts`, g.token, {
    idempotencyKey: `rcpt-${uid()}`,
    payments: [pay('dinheiro', 4000)],
  });
  expect(rec.statusCode, rec.body).toBe(201);
  // Despesas: 1500 'Limpeza'; 1000 'Transporte' estornada em seguida.
  const mov = (amountCents: number, category: string) =>
    inject('POST', '/cash/movements', g.token, {
      idempotencyKey: `mov-${uid()}`,
      kind: 'despesa',
      amountCents,
      description: `Despesa ${category}`,
      category,
    });
  expect((await mov(1500, 'Limpeza')).statusCode).toBe(201);
  const transporte = await mov(1000, 'Transporte');
  expect(transporte.statusCode).toBe(201);
  const reverse = await inject('POST', `/cash/movements/${transporte.json().id}/reverse`, g.token, {
    idempotencyKey: `rev-${uid()}`,
    reason: 'Lançada por engano',
  });
  expect(reverse.statusCode, reverse.body).toBe(201);
  fx = { g, v, A, B, customerName: customer.name };
});
afterAll(async () => {
  await ctx.close();
});

const gerente = () => ctx.tokenFor('gerente');
const summary = async (query = '') =>
  (await inject('GET', `/reports/summary${query}`, gerente())).json().summary;

describe('resumo: faturamento ≠ recebimento', () => {
  it('apura faturamento, cancelamentos, devoluções, ticket médio e líquido', async () => {
    const s = (await summary()).sales;
    expect(s).toMatchObject({
      grossCents: 37500,
      count: 3,
      validCount: 2,
      validCents: 35000,
      ticketAverageCents: 17500,
      cancelledCount: 1,
      cancelledCents: 2500,
      returnsCount: 1,
      returnsCents: 10000,
      netCents: 25000,
    });
  });

  it('recebimentos por modalidade: só o que entrou, com estornos e fiado separados', async () => {
    const r = (await summary()).receipts;
    const by = Object.fromEntries(
      r.byMethod.map((m: { method: string }) => [m.method, m]),
    ) as Record<string, { receivedCents: number; refundedCents: number; netCents: number }>;
    expect(by.dinheiro).toMatchObject({
      receivedCents: 24000,
      refundedCents: 10000,
      netCents: 14000,
    });
    expect(by.pix).toMatchObject({ receivedCents: 5000, refundedCents: 0, netCents: 5000 });
    expect(by.credito).toMatchObject({ receivedCents: 2500, refundedCents: 2500, netCents: 0 });
    expect(by.debito?.netCents).toBe(0);
    expect(r).toMatchObject({
      salesCents: 27500,
      debtCents: 4000,
      refundedCents: 12500,
      netCents: 19000,
    });
    // faturamento líquido (25000) ≠ recebimento líquido (19000): a diferença é o fiado em aberto
    expect(25000 - r.netCents).toBe((await summary()).openDebts.totalCents);
  });

  it('despesas por categoria, descontando estornos', async () => {
    const e = (await summary()).expenses;
    expect(e).toMatchObject({ totalCents: 2500, reversedCents: 1000, netCents: 1500 });
    expect(e.byCategory).toEqual([
      { category: 'Limpeza', netCents: 1500 },
      { category: 'Transporte', netCents: 0 },
    ]);
  });

  it('valores em aberto, resumo de caixa e estoque baixo', async () => {
    const s = await summary();
    expect(s.openDebts).toMatchObject({
      totalCents: 6000,
      salesCount: 1,
      customersCount: 1,
      overdueCents: 0,
    });
    expect(s.cash.openSessions).toBe(2);
    const low = await inject('GET', '/stock/low', gerente());
    expect(s.lowStockCount).toBe(low.json().items.length);
  });

  it('bate com a fonte única: soma dos relatórios de caixa = relatório da loja', async () => {
    const s = await summary();
    const reports = await Promise.all(
      [fx.g, fx.v].map(
        async (op) =>
          (await inject('GET', `/cash/sessions/${op.sessionId}`, gerente())).json().report,
      ),
    );
    for (const m of s.receipts.byMethod as {
      method: string;
      receivedCents: number;
      refundedCents: number;
    }[]) {
      const rec = reports.reduce(
        (sum, r) =>
          sum + r.byMethod.find((x: { method: string }) => x.method === m.method).receivedCents,
        0,
      );
      const ref = reports.reduce(
        (sum, r) =>
          sum + r.byMethod.find((x: { method: string }) => x.method === m.method).refundedCents,
        0,
      );
      expect([m.method, m.receivedCents, m.refundedCents]).toEqual([m.method, rec, ref]);
    }
    expect(s.cash.openExpectedCents).toBe(reports.reduce((sum, r) => sum + r.expectedCashCents, 0));
    expect(s.sales.grossCents).toBe(reports.reduce((sum, r) => sum + r.salesTotalCents, 0));
  });
});

describe('séries, ranking e movimentações', () => {
  it('série diária fecha com o resumo', async () => {
    const items = (await inject('GET', '/reports/daily', gerente())).json().items as {
      date: string;
      grossCents: number;
      salesCount: number;
      adjustmentsCents: number;
      receivedNetCents: number;
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      grossCents: 37500,
      salesCount: 3,
      adjustmentsCents: 12500,
      receivedNetCents: 19000,
    });
  });

  it('série cobre todos os dias do período, inclusive os vazios', async () => {
    const today = (await summary()).period.from as string;
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 2);
    const from = d.toISOString().slice(0, 10);
    const items = (await inject('GET', `/reports/daily?from=${from}&to=${today}`, gerente())).json()
      .items as { date: string; grossCents: number }[];
    expect(items.map((i) => i.date)).toEqual([from, items[1]!.date, today]);
    expect(items.map((i) => i.grossCents)).toEqual([0, 0, 37500]);
  });

  it('mais vendidos: líquido de devoluções e sem vendas canceladas', async () => {
    const items = (await inject('GET', '/reports/top-products?limit=5', gerente())).json().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ variantId: fx.A.id, quantity: 2, revenueCents: 20000 });
    expect(items[1]).toMatchObject({ variantId: fx.B.id, quantity: 2, revenueCents: 5000 });
    const one = (await inject('GET', '/reports/top-products?limit=1', gerente())).json().items;
    expect(one).toHaveLength(1);
  });

  it('por vendedor: ignora vendas canceladas', async () => {
    const items = (await inject('GET', '/reports/sellers', gerente())).json().items;
    expect(
      items.map((i: { salesCount: number; salesCents: number }) => [i.salesCount, i.salesCents]),
    ).toEqual([
      [1, 20000],
      [1, 15000],
    ]);
    expect(items[0].ticketAverageCents).toBe(20000);
  });

  it('movimentações recentes: mais novas primeiro e com tipo', async () => {
    const items = (await inject('GET', '/reports/recent', gerente())).json().items as {
      type: string;
      at: string;
    }[];
    expect(items.length).toBe(9); // 6 pagamentos/estornos + 3 movimentos de caixa
    expect(items[0]!.type).toBe('estorno_movimento');
    const times = items.map((i) => Date.parse(i.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('período', () => {
  it('período sem movimento zera os fluxos, mas a posição atual (fiado) permanece', async () => {
    const s = await summary('?from=2099-01-01&to=2099-01-31');
    expect(s.period).toEqual({ from: '2099-01-01', to: '2099-01-31' });
    expect(s.sales.grossCents).toBe(0);
    expect(s.receipts.netCents).toBe(0);
    expect(s.expenses.totalCents).toBe(0);
    expect(s.openDebts.totalCents).toBe(6000);
  });

  it('o dia anterior não enxerga as vendas de hoje (fronteira do dia)', async () => {
    const today = (await summary()).period.from as string;
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const y = d.toISOString().slice(0, 10);
    expect((await summary(`?from=${y}&to=${y}`)).sales.count).toBe(0);
  });

  it('valida datas e limita o tamanho do período', async () => {
    for (const q of [
      '?from=2026-11-10&to=2026-11-01',
      '?from=2026-02-30',
      '?from=ontem',
      '?from=2024-01-01&to=2026-01-01',
    ]) {
      const res = await inject('GET', `/reports/summary${q}`, gerente());
      expect(res.statusCode, q).toBe(400);
    }
    expect((await inject('GET', '/reports/top-products?limit=0', gerente())).statusCode).toBe(400);
  });
});

describe('autorização e somente leitura', () => {
  const urls = [
    '/reports/summary',
    '/reports/daily',
    '/reports/top-products',
    '/reports/sellers',
    '/reports/recent',
    '/reports/sales.csv',
    '/reports/payments.csv',
  ];
  it('exige autenticação e permissão report:read (vendedor não vê o faturamento)', async () => {
    for (const url of urls) {
      expect((await inject('GET', url)).statusCode, url).toBe(401);
      expect((await inject('GET', url, ctx.tokenFor('vendedor'))).statusCode, url).toBe(403);
      expect((await inject('GET', url, ctx.tokenFor('admin'))).statusCode, url).toBe(200);
      expect((await inject('GET', url, gerente())).statusCode, url).toBe(200);
    }
  });

  it('consultar relatórios não grava nada (exceto a auditoria das exportações)', async () => {
    const count = async (t: string) =>
      Number((await ctx.pool.query(`select count(*) from ${t}`)).rows[0].count);
    const before = [await count('payments'), await count('sales'), await count('cash_movements')];
    await summary();
    await inject('GET', '/reports/daily', gerente());
    await inject('GET', '/reports/recent', gerente());
    expect([await count('payments'), await count('sales'), await count('cash_movements')]).toEqual(
      before,
    );
  });
});

describe('exportação CSV', () => {
  it('vendas: cabeçalho, linhas do período, valores pt-BR e proteção contra fórmula', async () => {
    const res = await inject('GET', '/reports/sales.csv', gerente());
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'numero;data;cliente;vendedor;status;pagamento;total;desconto;devolvido;recebido_liquido;saldo',
    );
    expect(lines).toHaveLength(4);
    const fiado = lines.find((l) => l.includes('150,00'))!;
    expect(fiado).toContain(
      ';concluida;parcial;150,00;0,00;0,00;50,00;100,00'.replace('50,00;100,00', '90,00;60,00'),
    );
    // nome de cliente malicioso não vira fórmula (a célula começa com apóstrofo)
    expect(res.body).toContain("'=cmd|' /C calc'!A0");
    expect(res.body).not.toMatch(/;=cmd/);
  });

  it('pagamentos: lista recebimentos e estornos com vínculo ao fiado', async () => {
    const res = await inject('GET', '/reports/payments.csv', gerente());
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe('data;tipo;forma;valor;venda;recebimento_fiado;operador;caixa');
    // 4 recebimentos de venda/fiado (dinheiro, pix, credito, dinheiro fiado) + 2 estornos
    expect(lines).toHaveLength(1 + 6);
    expect(lines.filter((l) => l.includes(';estorno;'))).toHaveLength(2);
    expect(lines.some((l) => /;recebimento;dinheiro;40,00;\d+;\d+;/.test(l))).toBe(true);
  });

  it('exportações ficam registradas na auditoria', async () => {
    const rows = (
      await ctx.pool.query(
        "select payload from audit_log where action = 'report.export' order by id",
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.payload.kind)).toContain('sales');
  });
});

describe('CORS', () => {
  it('expõe content-disposition para o navegador nomear o arquivo exportado', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/reports/sales.csv',
      headers: { ...auth(gerente()), origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-expose-headers']).toContain('content-disposition');
  });
});
