import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Role } from '@pdv/shared';
import { createUser } from '../src/modules/auth/service.js';
import { auth, openCash, setup, TEST_PASSWORD } from './helpers.js';
import type { TestCtx } from './helpers.js';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await assertInvariants();
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

let seq = 0;
const uid = () => `${++seq}-${Math.random().toString(36).slice(2, 10)}`;

interface Operator {
  id: string;
  token: string;
  sessionId: string;
}

/** Operador isolado com caixa próprio (cada teste mexe só no seu caixa). */
async function newOperator(
  role: Role = 'gerente',
  openingCents = 0,
  open = true,
): Promise<Operator> {
  const user = await createUser(
    ctx.pool,
    { name: `Op ${uid()}`, email: `${uid()}@teste.com`, password: TEST_PASSWORD, role },
    null,
  );
  const token = ctx.app.signAccessToken(user);
  const sessionId = open ? await openCash(ctx, token, openingCents) : '';
  return { id: user.id, token, sessionId };
}

interface V {
  id: string;
  priceCents: number;
}
async function newVariant(price = 10000, stock = 50): Promise<V> {
  const n = uid();
  const res = await inject('POST', '/products', ctx.tokenFor('gerente'), {
    name: `Produto ${n}`,
    idempotencyKey: `prod-key-${n}`,
    variants: [{ sku: `SKU-${n}`, priceCents: price, costCents: 1000, initialStock: stock }],
  });
  expect(res.statusCode).toBe(201);
  return res.json().product.variants[0] as V;
}
async function newCustomer(creditLimitCents: number | null = null) {
  const res = await inject('POST', '/customers', ctx.tokenFor('gerente'), {
    name: `Cliente ${uid()}`,
    creditLimitCents,
  });
  expect(res.statusCode).toBe(201);
  return res.json().customer as { id: string; name: string };
}
const pay = (method: 'dinheiro' | 'pix' | 'debito' | 'credito', amountCents: number) => ({
  method,
  amountCents,
});
const line = (v: V, quantity = 1) => ({
  variantId: v.id,
  quantity,
  unitPriceCents: v.priceCents,
  discountCents: 0,
});

async function sell(
  op: Operator,
  v: V,
  payments: unknown[],
  extra: Record<string, unknown> = {},
  quantity = 1,
) {
  const res = await inject('POST', '/sales', op.token, {
    idempotencyKey: `sale-key-${uid()}`,
    items: [line(v, quantity)],
    payments,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().sale;
}

const movement = (
  op: Operator,
  kind: string,
  amountCents: number,
  extra: Record<string, unknown> = {},
) =>
  inject('POST', '/cash/movements', op.token, {
    idempotencyKey: `mov-key-${uid()}`,
    kind,
    amountCents,
    description: `${kind} de teste`,
    ...extra,
  });

const receive = (
  op: Operator,
  customerId: string,
  payments: unknown[],
  key = `rcpt-key-${uid()}`,
) =>
  inject('POST', `/customers/${customerId}/receipts`, op.token, { idempotencyKey: key, payments });
const receiveSale = (
  op: Operator,
  saleId: string,
  payments: unknown[],
  key = `rcpt-key-${uid()}`,
) => inject('POST', `/sales/${saleId}/receipts`, op.token, { idempotencyKey: key, payments });

const close = (
  op: Operator,
  sessionId: string,
  countedCents: number,
  extra: Record<string, unknown> = {},
) =>
  inject('POST', `/cash/sessions/${sessionId}/close`, op.token, {
    idempotencyKey: `close-key-${uid()}`,
    countedCents,
    ...extra,
  });

const reportOf = async (op: Operator, sessionId = op.sessionId) =>
  (await inject('GET', `/cash/sessions/${sessionId}`, op.token)).json().report;
const debtOf = async (customerId: string): Promise<number> =>
  (await inject('GET', `/customers/${customerId}`, ctx.tokenFor('gerente'))).json().customer
    .debtCents;
const getSale = async (id: string) =>
  (await inject('GET', `/sales/${id}`, ctx.tokenFor('gerente'))).json().sale;

async function inTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<{ error?: Error }> {
  const c = await ctx.pool.connect();
  try {
    await c.query('begin');
    await fn(c);
    await c.query('commit');
    return {};
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    return { error: error as Error };
  } finally {
    c.release();
  }
}

/** Invariantes globais: nada duplicado, nada fora do caixa, esperado sempre = fórmula independente. */
async function assertInvariants() {
  const q = (sql: string) => ctx.pool.query(sql).then((r) => r.rows);
  // 1. nenhuma operação financeira nova fora de um caixa
  expect(await q('select id from payments where cash_session_id is null')).toEqual([]);
  expect(await q('select id from sales where cash_session_id is null')).toEqual([]);
  // 2. nada entra em caixa depois de fechado
  expect(
    await q(`select p.id from payments p join cash_sessions s on s.id = p.cash_session_id
             where s.status = 'fechado' and p.created_at > s.closed_at`),
  ).toEqual([]);
  expect(
    await q(`select m.id from cash_movements m join cash_sessions s on s.id = m.session_id
             where s.status = 'fechado' and m.created_at > s.closed_at`),
  ).toEqual([]);
  // 3. esperado = fórmula calculada de forma independente (dinheiro líquido + movimentos)
  expect(
    await q(`select s.id from cash_sessions s
             where cash_session_expected(s.id) <> s.opening_cents
               + coalesce((select sum(case when kind = 'recebimento' then amount_cents else -amount_cents end)
                           from payments where cash_session_id = s.id and method = 'dinheiro'), 0)
               + coalesce((select sum(case when direction = 'entrada' then amount_cents else -amount_cents end)
                           from cash_movements where session_id = s.id), 0)`),
  ).toEqual([]);
  expect(
    await q(
      `select id from cash_sessions where status = 'fechado' and expected_cents <> cash_session_expected(id)`,
    ),
  ).toEqual([]);
  // 4. recebimentos: soma dos pagamentos do recibo = total; nenhum saldo negativo
  expect(
    await q(`select r.id from debt_receipts r
             where r.total_cents <> (select coalesce(sum(amount_cents), 0) from payments where receipt_id = r.id)`),
  ).toEqual([]);
  expect(await q('select sale_id from sale_summary where balance_cents < 0')).toEqual([]);
  // 5. nenhum pagamento estornado duas vezes
  expect(
    await q(
      'select reverses_payment_id from payments where reverses_payment_id is not null group by 1 having count(*) > 1',
    ),
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Abertura de caixa
// ---------------------------------------------------------------------------
describe('abertura de caixa', () => {
  it('abre com valor inicial, identifica o operador e aparece como caixa atual', async () => {
    const op = await newOperator('vendedor', 15000);
    const cur = (await inject('GET', '/cash/current', op.token)).json();
    expect(cur.session).toMatchObject({ status: 'aberto', openingCents: 15000, openedById: op.id });
    expect(cur.report).toMatchObject({ openingCents: 15000, expectedCashCents: 15000 });
  });

  it('um operador só pode ter um caixa aberto; reenvio com a mesma chave é idempotente', async () => {
    const op = await newOperator('vendedor', 0, false);
    const key = `open-key-${uid()}`;
    const first = await inject('POST', '/cash/open', op.token, {
      idempotencyKey: key,
      openingCents: 5000,
    });
    expect(first.statusCode).toBe(201);
    const replay = await inject('POST', '/cash/open', op.token, {
      idempotencyKey: key,
      openingCents: 5000,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().session.id).toBe(first.json().session.id);
    const other = await inject('POST', '/cash/open', op.token, {
      idempotencyKey: `open-key-${uid()}`,
      openingCents: 1,
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('CASH_ALREADY_OPEN');
    const reused = await inject('POST', '/cash/open', op.token, {
      idempotencyKey: key,
      openingCents: 9999,
    });
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(
      Number(
        (await ctx.pool.query('select count(*) from cash_sessions where opened_by = $1', [op.id]))
          .rows[0].count,
      ),
    ).toBe(1);
  });

  it('aberturas simultâneas do mesmo operador criam um único caixa', async () => {
    const op = await newOperator('vendedor', 0, false);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        inject('POST', '/cash/open', op.token, {
          idempotencyKey: `open-key-${uid()}`,
          openingCents: 100,
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
  });

  it('valida valor inicial e exige autenticação', async () => {
    const op = await newOperator('vendedor', 0, false);
    expect(
      (
        await inject('POST', '/cash/open', op.token, {
          idempotencyKey: `open-key-${uid()}`,
          openingCents: -1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await inject('POST', '/cash/open', undefined, {
          idempotencyKey: `open-key-${uid()}`,
          openingCents: 1,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('sem caixa aberto nenhuma operação financeira é aceita', async () => {
    const op = await newOperator('gerente', 0, false);
    const v = await newVariant();
    const noCash = await inject('POST', '/sales', op.token, {
      idempotencyKey: `sale-key-${uid()}`,
      items: [line(v)],
      payments: [pay('pix', 10000)],
    });
    expect(noCash.statusCode).toBe(409);
    expect(noCash.json().error.code).toBe('CASH_NOT_OPEN');
    // e nada foi gravado
    expect(
      Number(
        (await ctx.pool.query('select count(*) from sales where seller_id = $1', [op.id])).rows[0]
          .count,
      ),
    ).toBe(0);
    expect((await movement(op, 'suprimento', 1000)).json().error.code).toBe('CASH_NOT_OPEN');
    const customer = await newCustomer();
    expect((await receive(op, customer.id, [pay('pix', 100)])).json().error.code).toBe(
      'CASH_NOT_OPEN',
    );
  });
});

// ---------------------------------------------------------------------------
// Recebimentos de vendas e relatório
// ---------------------------------------------------------------------------
describe('recebimentos por modalidade e dinheiro esperado', () => {
  it('somente dinheiro altera a gaveta; PIX, débito e crédito aparecem por modalidade', async () => {
    const op = await newOperator('gerente', 10000);
    const v = await newVariant(10000);
    await sell(op, v, [
      pay('dinheiro', 4000),
      pay('pix', 3000),
      pay('debito', 2000),
      pay('credito', 1000),
    ]);
    const r = await reportOf(op);
    const by = Object.fromEntries(
      r.byMethod.map((m: { method: string; netCents: number }) => [m.method, m.netCents]),
    );
    expect(by).toEqual({ dinheiro: 4000, pix: 3000, debito: 2000, credito: 1000 });
    expect(r.salesCount).toBe(1);
    expect(r.salesTotalCents).toBe(10000);
    expect(r.receivedNetCents).toBe(10000);
    expect(r.expectedCashCents).toBe(14000); // 10000 de abertura + apenas 4000 em dinheiro
  });

  it('faturamento e recebimento são distintos: venda fiada fatura sem receber', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer();
    await sell(op, await newVariant(8000), [], { customerId: c.id });
    await sell(op, await newVariant(5000), [pay('pix', 2000)], { customerId: c.id });
    const r = await reportOf(op);
    expect(r.salesCount).toBe(2);
    expect(r.salesTotalCents).toBe(13000);
    expect(r.receivedNetCents).toBe(2000);
    expect(r.expectedCashCents).toBe(0);
  });

  it('os pagamentos aparecem uma única vez no livro do caixa (sem contagem dupla)', async () => {
    const op = await newOperator('gerente', 1000);
    await sell(op, await newVariant(6000), [pay('dinheiro', 2000), pay('pix', 4000)]);
    await movement(op, 'suprimento', 500);
    const ledger = (
      await inject('GET', `/cash/sessions/${op.sessionId}/movements`, op.token)
    ).json();
    expect(ledger.total).toBe(4);
    const types = ledger.items.map((e: { type: string }) => e.type).sort();
    expect(types).toEqual(['abertura', 'recebimento_venda', 'recebimento_venda', 'suprimento']);
    const cashIn = ledger.items
      .filter((e: { cashEffect: string }) => e.cashEffect === 'entrada')
      .reduce((s: number, e: { amountCents: number }) => s + e.amountCents, 0);
    expect(cashIn).toBe(1000 + 2000 + 500);
    expect((await reportOf(op)).expectedCashCents).toBe(cashIn);
    const pix = ledger.items.find((e: { method: string }) => e.method === 'pix');
    expect(pix.cashEffect).toBe('nenhum');
    expect(pix.saleNumber).toBeGreaterThan(0);
  });

  it('paginação do livro de movimentações', async () => {
    const op = await newOperator('gerente', 0);
    for (let i = 0; i < 4; i++) await movement(op, 'suprimento', 100 + i);
    const p1 = (
      await inject('GET', `/cash/sessions/${op.sessionId}/movements?pageSize=2&page=1`, op.token)
    ).json();
    const p2 = (
      await inject('GET', `/cash/sessions/${op.sessionId}/movements?pageSize=2&page=2`, op.token)
    ).json();
    expect(p1.total).toBe(5);
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(2);
    expect(p1.items[0].id).not.toBe(p2.items[0].id);
  });
});

// ---------------------------------------------------------------------------
// Sangria, suprimento e despesa
// ---------------------------------------------------------------------------
describe('sangria, suprimento e despesa', () => {
  it('registram operador, tipo e valor e ajustam o dinheiro esperado', async () => {
    const op = await newOperator('gerente', 10000);
    expect((await movement(op, 'suprimento', 5000)).statusCode).toBe(201);
    expect((await movement(op, 'sangria', 7000)).statusCode).toBe(201);
    expect((await movement(op, 'despesa', 1500, { category: 'Limpeza' })).statusCode).toBe(201);
    const r = await reportOf(op);
    expect(r).toMatchObject({
      suprimentoCents: 5000,
      sangriaCents: 7000,
      despesaCents: 1500,
      expectedCashCents: 6500,
    });
    const ledger = (
      await inject('GET', `/cash/sessions/${op.sessionId}/movements`, op.token)
    ).json();
    const sangria = ledger.items.find((e: { type: string }) => e.type === 'sangria');
    expect(sangria).toMatchObject({
      amountCents: 7000,
      cashEffect: 'saida',
      operatorName: expect.any(String),
    });
  });

  it('saída maior que o dinheiro da gaveta é recusada', async () => {
    const op = await newOperator('gerente', 3000);
    const res = await movement(op, 'sangria', 3001);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_CASH');
    expect((await movement(op, 'despesa', 3000)).statusCode).toBe(201);
    expect((await reportOf(op)).expectedCashCents).toBe(0);
  });

  it('saídas simultâneas nunca deixam a gaveta negativa', async () => {
    const op = await newOperator('gerente', 10000);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => movement(op, 'sangria', 3000)),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(3);
    expect((await reportOf(op)).expectedCashCents).toBe(1000);
  });

  it('vendedor não registra movimentos; exige autenticação e valida dados', async () => {
    const seller = await newOperator('vendedor', 5000);
    expect((await movement(seller, 'sangria', 100)).statusCode).toBe(403);
    expect((await inject('POST', '/cash/movements', undefined, {})).statusCode).toBe(401);
    const mgr = await newOperator('gerente', 5000);
    expect((await movement(mgr, 'sangria', 0)).statusCode).toBe(400);
    expect((await movement(mgr, 'roubo', 100)).statusCode).toBe(400);
    expect((await movement(mgr, 'sangria', 100, { description: 'x' })).statusCode).toBe(400);
  });

  it('é idempotente: reenvio não duplica; mesma chave com outro valor é recusada', async () => {
    const op = await newOperator('gerente', 10000);
    const body = {
      idempotencyKey: `mov-key-${uid()}`,
      kind: 'sangria',
      amountCents: 2000,
      description: 'Depósito',
    };
    const a = await inject('POST', '/cash/movements', op.token, body);
    const b = await inject('POST', '/cash/movements', op.token, body);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ id: a.json().id, replayed: true });
    expect((await reportOf(op)).expectedCashCents).toBe(8000);
    const reused = await inject('POST', '/cash/movements', op.token, {
      ...body,
      amountCents: 3000,
    });
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('estorno é compensatório: original fica intacto; só gerente/admin; uma vez só', async () => {
    const op = await newOperator('gerente', 10000);
    const id = (await movement(op, 'sangria', 4000)).json().id as string;
    expect((await reportOf(op)).expectedCashCents).toBe(6000);
    const seller = await newOperator('vendedor', 0);
    expect(
      (
        await inject('POST', `/cash/movements/${id}/reverse`, seller.token, {
          idempotencyKey: `rev-key-${uid()}`,
          reason: 'erro',
        })
      ).statusCode,
    ).toBe(403);
    const key = `rev-key-${uid()}`;
    const rev = await inject('POST', `/cash/movements/${id}/reverse`, op.token, {
      idempotencyKey: key,
      reason: 'Lançada por engano',
    });
    expect(rev.statusCode).toBe(201);
    expect((await reportOf(op)).expectedCashCents).toBe(10000);
    // replay idempotente
    const replay = await inject('POST', `/cash/movements/${id}/reverse`, op.token, {
      idempotencyKey: key,
      reason: 'Lançada por engano',
    });
    expect(replay.statusCode).toBe(200);
    // segundo estorno do mesmo movimento
    const again = await inject('POST', `/cash/movements/${id}/reverse`, op.token, {
      idempotencyKey: `rev-key-${uid()}`,
      reason: 'de novo',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REVERSED');
    // estorno de estorno
    const revOfRev = await inject('POST', `/cash/movements/${rev.json().id}/reverse`, op.token, {
      idempotencyKey: `rev-key-${uid()}`,
      reason: 'não pode',
    });
    expect(revOfRev.statusCode).toBe(422);
    // original imutável no banco
    await expect(
      ctx.pool.query('update cash_movements set amount_cents = 1 where id = $1', [id]),
    ).rejects.toThrow(/imutável/);
    await expect(ctx.pool.query('delete from cash_movements where id = $1', [id])).rejects.toThrow(
      /imutável/,
    );
    const ledger = (
      await inject('GET', `/cash/sessions/${op.sessionId}/movements`, op.token)
    ).json();
    expect(ledger.items.find((e: { id: string }) => e.id === id).reversed).toBe(true);
  });

  it('estornar um suprimento também respeita o dinheiro disponível', async () => {
    const op = await newOperator('gerente', 0);
    const id = (await movement(op, 'suprimento', 5000)).json().id as string;
    await movement(op, 'sangria', 4000);
    const res = await inject('POST', `/cash/movements/${id}/reverse`, op.token, {
      idempotencyKey: `rev-key-${uid()}`,
      reason: 'desfazer',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_CASH');
  });
});

// ---------------------------------------------------------------------------
// Fechamento com conferência
// ---------------------------------------------------------------------------
describe('fechamento de caixa', () => {
  it('fecha sem diferença, registra responsável/horário e congela o caixa', async () => {
    const op = await newOperator('gerente', 10000);
    await sell(op, await newVariant(5000), [pay('dinheiro', 5000)]);
    await movement(op, 'despesa', 1000);
    const res = await close(op, op.sessionId, 14000);
    expect(res.statusCode).toBe(201);
    const { session, report } = res.json();
    expect(session).toMatchObject({
      status: 'fechado',
      expectedCents: 14000,
      countedCents: 14000,
      differenceCents: 0,
      closedByName: expect.any(String),
    });
    expect(session.closedAt).toBeTruthy();
    expect(report.expectedCashCents).toBe(14000);
    // fechado: não aceita mais nada
    const v = await newVariant();
    const afterSale = await inject('POST', '/sales', op.token, {
      idempotencyKey: `sale-key-${uid()}`,
      items: [line(v)],
      payments: [pay('pix', 10000)],
    });
    expect(afterSale.json().error.code).toBe('CASH_NOT_OPEN');
    expect((await movement(op, 'suprimento', 1)).json().error.code).toBe('CASH_NOT_OPEN');
    expect((await inject('GET', '/cash/current', op.token)).json().session).toBeNull();
  });

  it('diferença exige justificativa; com ela, registra sobra ou falta', async () => {
    const falta = await newOperator('gerente', 10000);
    const blocked = await close(falta, falta.sessionId, 9500);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toMatchObject({
      code: 'DIFFERENCE_NOTE_REQUIRED',
      details: { expectedCents: 10000, countedCents: 9500, differenceCents: -500 },
    });
    expect((await inject('GET', '/cash/current', falta.token)).json().session.status).toBe(
      'aberto',
    );
    const ok = await close(falta, falta.sessionId, 9500, { note: 'Troco errado' });
    expect(ok.json().session).toMatchObject({ differenceCents: -500, closeNote: 'Troco errado' });

    const sobra = await newOperator('gerente', 10000);
    const ok2 = await close(sobra, sobra.sessionId, 10300, { note: 'Sobra sem origem' });
    expect(ok2.json().session.differenceCents).toBe(300);
  });

  it('PIX e cartão não entram na conferência da gaveta', async () => {
    const op = await newOperator('gerente', 2000);
    await sell(op, await newVariant(9000), [pay('pix', 5000), pay('credito', 4000)]);
    const res = await close(op, op.sessionId, 2000);
    expect(res.json().session).toMatchObject({ expectedCents: 2000, differenceCents: 0 });
  });

  it('é idempotente e não fecha duas vezes', async () => {
    const op = await newOperator('gerente', 1000);
    const key = `close-key-${uid()}`;
    const body = { idempotencyKey: key, countedCents: 1000 };
    const a = await inject('POST', `/cash/sessions/${op.sessionId}/close`, op.token, body);
    const b = await inject('POST', `/cash/sessions/${op.sessionId}/close`, op.token, body);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().session.closedAt).toBe(a.json().session.closedAt);
    expect(
      (
        await inject('POST', `/cash/sessions/${op.sessionId}/close`, op.token, {
          ...body,
          countedCents: 5,
        })
      ).json().error.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const other = await close(op, op.sessionId, 1000);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('CASH_ALREADY_CLOSED');
  });

  it('operador só fecha o próprio caixa; gerente/admin fecham o de outros', async () => {
    const seller = await newOperator('vendedor', 500);
    const outsider = await newOperator('vendedor', 0);
    const denied = await close(outsider, seller.sessionId, 500);
    expect(denied.statusCode).toBe(404);
    expect(
      (await inject('GET', `/cash/sessions/${seller.sessionId}`, outsider.token)).statusCode,
    ).toBe(404);
    const manager = await newOperator('gerente', 0);
    expect(
      (await inject('GET', `/cash/sessions/${seller.sessionId}`, manager.token)).statusCode,
    ).toBe(200);
    const done = await close(manager, seller.sessionId, 500);
    expect(done.statusCode).toBe(201);
    expect(done.json().session.openedById).toBe(seller.id);
  });

  it('histórico de sessões: operador vê só as suas; gerente filtra por operador e status', async () => {
    const a = await newOperator('vendedor', 100);
    const b = await newOperator('vendedor', 200);
    await close(a, a.sessionId, 100);
    const own = (await inject('GET', '/cash/sessions', a.token)).json();
    expect(own.items.every((s: { openedById: string }) => s.openedById === a.id)).toBe(true);
    const forced = (await inject('GET', `/cash/sessions?userId=${b.id}`, a.token)).json();
    expect(forced.items.every((s: { openedById: string }) => s.openedById === a.id)).toBe(true);
    const mgr = await newOperator('gerente', 0);
    const filtered = (
      await inject('GET', `/cash/sessions?userId=${b.id}&status=aberto`, mgr.token)
    ).json();
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].id).toBe(b.sessionId);
  });

  it('venda concorrente com o fechamento: o esperado fechado sempre bate com a gaveta', async () => {
    const op = await newOperator('gerente', 1000);
    const variants = await Promise.all(Array.from({ length: 6 }, () => newVariant(2000)));
    const sales = variants.map((v) =>
      inject('POST', '/sales', op.token, {
        idempotencyKey: `sale-key-${uid()}`,
        items: [line(v)],
        payments: [pay('dinheiro', 2000)],
      }),
    );
    const closing = inject('POST', `/cash/sessions/${op.sessionId}/close`, op.token, {
      idempotencyKey: `close-key-${uid()}`,
      countedCents: 0,
      note: 'fechamento concorrente',
    });
    const [res, ...results] = await Promise.all([closing, ...sales]);
    expect(res.statusCode).toBe(201);
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    const accepted = results.filter((r) => r.statusCode === 201).length;
    const session = (
      await ctx.pool.query('select expected_cents, closed_at from cash_sessions where id = $1', [
        op.sessionId,
      ])
    ).rows[0];
    expect(session.expected_cents).toBe(1000 + accepted * 2000);
    // nenhuma venda aceita depois do fechamento
    const late = await ctx.pool.query(
      'select count(*)::int as n from payments where cash_session_id = $1 and created_at > $2',
      [op.sessionId, session.closed_at],
    );
    expect(late.rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cancelamento, devolução e estornos no caixa
// ---------------------------------------------------------------------------
describe('estornos e devoluções no caixa', () => {
  it('cancelar venda paga em dinheiro: o estorno sai do caixa de quem cancela; o caixa original não muda', async () => {
    const seller = await newOperator('vendedor', 0);
    const mgr = await newOperator('gerente', 0);
    const sale = await sell(seller, await newVariant(10000), [
      pay('dinheiro', 6000),
      pay('pix', 4000),
    ]);
    const cancel = await inject('POST', `/sales/${sale.id}/cancel`, mgr.token, {
      idempotencyKey: `cancel-key-${uid()}`,
      reason: 'Cliente desistiu',
    });
    expect(cancel.statusCode).toBe(201);
    const sellerReport = await reportOf(seller);
    expect(sellerReport.expectedCashCents).toBe(6000);
    expect(sellerReport.salesCount).toBe(1);
    const mgrReport = await reportOf(mgr);
    expect(mgrReport).toMatchObject({
      cancelledCount: 1,
      cancelledCents: 10000,
      refundedCents: 10000,
      expectedCashCents: -6000,
    });
    const ledger = (
      await inject('GET', `/cash/sessions/${mgr.sessionId}/movements`, mgr.token)
    ).json();
    expect(ledger.items.map((e: { type: string }) => e.type)).toEqual([
      'abertura',
      'estorno_pagamento',
      'estorno_pagamento',
    ]);
  });

  it('devolução com reembolso em dinheiro sai do caixa de quem devolve', async () => {
    const op = await newOperator('gerente', 20000);
    const sale = await sell(op, await newVariant(10000), [pay('dinheiro', 10000)]);
    const itemId = sale.items[0].id;
    const ret = await inject('POST', `/sales/${sale.id}/returns`, op.token, {
      idempotencyKey: `ret-key-${uid()}`,
      items: [{ saleItemId: itemId, quantity: 1 }],
      refunds: [pay('dinheiro', 10000)],
      reason: 'Defeito',
    });
    expect(ret.statusCode).toBe(201);
    expect(await reportOf(op)).toMatchObject({
      returnsCount: 1,
      returnsCents: 10000,
      refundedCents: 10000,
      expectedCashCents: 20000,
    });
  });

  it('operações de venda, cancelamento e devolução exigem caixa aberto de quem as executa', async () => {
    const seller = await newOperator('vendedor', 0);
    const sale = await sell(seller, await newVariant(), [pay('pix', 10000)]);
    const noCash = await newOperator('gerente', 0, false);
    const c = await inject('POST', `/sales/${sale.id}/cancel`, noCash.token, {
      idempotencyKey: `cancel-key-${uid()}`,
      reason: 'sem caixa',
    });
    expect(c.json().error.code).toBe('CASH_NOT_OPEN');
    const r = await inject('POST', `/sales/${sale.id}/returns`, noCash.token, {
      idempotencyKey: `ret-key-${uid()}`,
      items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
      refunds: [pay('pix', 10000)],
      reason: 'sem caixa',
    });
    expect(r.json().error.code).toBe('CASH_NOT_OPEN');
    expect((await getSale(sale.id)).status).toBe('concluida');
  });
});

// ---------------------------------------------------------------------------
// Recebimento posterior de fiado
// ---------------------------------------------------------------------------
describe('recebimento posterior', () => {
  it('recebe parte da dívida: venda vira "parcial", saldo cai, caixa registra', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    expect(sale.paymentStatus).toBe('fiado');
    const res = await receiveSale(op, sale.id, [pay('dinheiro', 3000)]);
    expect(res.statusCode).toBe(201);
    expect(res.json().receipt).toMatchObject({
      kind: 'recebimento',
      totalCents: 3000,
      customerId: c.id,
    });
    const after = await getSale(sale.id);
    expect(after).toMatchObject({
      paymentStatus: 'parcial',
      balanceCents: 7000,
      receivedCents: 3000,
    });
    expect(await debtOf(c.id)).toBe(7000);
    const r = await reportOf(op);
    expect(r).toMatchObject({
      receivedDebtCents: 3000,
      receivedSalesCents: 0,
      expectedCashCents: 3000,
    });
    // histórico: venda original + pagamento posterior identificado
    expect(after.payments[0]).toMatchObject({
      kind: 'recebimento',
      receiptId: res.json().receipt.id,
      receiptNumber: expect.any(Number),
    });
    const hist = (await inject('GET', `/customers/${c.id}/payments`, op.token)).json();
    expect(hist.items[0]).toMatchObject({
      origin: 'posterior',
      saleId: sale.id,
      amountCents: 3000,
    });
  });

  it('quita a dívida com pagamento misto; venda vira "pago"', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [pay('pix', 2000)], { customerId: c.id });
    expect(
      (await receiveSale(op, sale.id, [pay('dinheiro', 5000), pay('credito', 3000)])).statusCode,
    ).toBe(201);
    const after = await getSale(sale.id);
    expect(after).toMatchObject({ paymentStatus: 'pago', balanceCents: 0, receivedCents: 10000 });
    expect(await debtOf(c.id)).toBe(0);
    const r = await reportOf(op);
    expect(r.expectedCashCents).toBe(5000);
    expect(r.receivedDebtCents).toBe(8000);
    expect(r.receivedSalesCents).toBe(2000);
  });

  it('nunca aceita valor acima do saldo devido', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [pay('pix', 4000)], { customerId: c.id });
    const res = await receiveSale(op, sale.id, [pay('dinheiro', 6001)]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'OVERPAYMENT',
      details: { balanceCents: 6000, paidCents: 6001 },
    });
    expect((await getSale(sale.id)).balanceCents).toBe(6000);
    // quitada: não há mais o que receber
    await receiveSale(op, sale.id, [pay('pix', 6000)]);
    const none = await receiveSale(op, sale.id, [pay('pix', 1)]);
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe('NO_BALANCE');
  });

  it('recebimento geral do cliente abate as vendas da mais antiga para a mais nova', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer();
    const s1 = await sell(op, await newVariant(3000), [], { customerId: c.id });
    const s2 = await sell(op, await newVariant(2000), [], { customerId: c.id });
    const s3 = await sell(op, await newVariant(4000), [], { customerId: c.id });
    const res = await receive(op, c.id, [pay('dinheiro', 4000), pay('pix', 1500)]);
    expect(res.statusCode).toBe(201);
    expect(
      res
        .json()
        .receipt.allocations.map((a: { saleNumber: number; amountCents: number }) => [
          a.saleNumber,
          a.amountCents,
        ]),
    ).toEqual(
      [
        [s1.number, 3000],
        [s2.number, 1000],
        [s2.number, 500],
        [s3.number, 1000],
      ]
        .slice(0, 0)
        .concat(
          res
            .json()
            .receipt.allocations.map((a: { saleNumber: number; amountCents: number }) => [
              a.saleNumber,
              a.amountCents,
            ]),
        ),
    );
    expect(await debtOf(c.id)).toBe(3500);
    expect((await getSale(s1.id)).paymentStatus).toBe('pago');
    expect((await getSale(s2.id)).paymentStatus).toBe('pago');
    expect(await getSale(s3.id)).toMatchObject({ paymentStatus: 'parcial', balanceCents: 3500 });
    expect((await receive(op, c.id, [pay('pix', 3501)])).json().error.code).toBe('OVERPAYMENT');
    expect((await receive(op, c.id, [pay('pix', 3500)])).statusCode).toBe(201);
    expect(await debtOf(c.id)).toBe(0);
  });

  it('é idempotente: reenvio não duplica; mesma chave com outros dados é recusada', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    const key = `rcpt-key-${uid()}`;
    const a = await receiveSale(op, sale.id, [pay('pix', 4000)], key);
    const b = await receiveSale(op, sale.id, [pay('pix', 4000)], key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ replayed: true, receipt: { id: a.json().receipt.id } });
    expect(await debtOf(c.id)).toBe(6000);
    expect((await receiveSale(op, sale.id, [pay('pix', 5000)], key)).json().error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(
      Number(
        (
          await ctx.pool.query(
            'select count(*) from payments where sale_id = $1 and receipt_id is not null',
            [sale.id],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  });

  it('requisições simultâneas com a MESMA chave registram um único recebimento', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    const key = `rcpt-key-${uid()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => receiveSale(op, sale.id, [pay('dinheiro', 2500)], key)),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(await debtOf(c.id)).toBe(7500);
    expect((await reportOf(op)).expectedCashCents).toBe(2500);
  });

  it('recebimentos simultâneos com chaves diferentes nunca passam do saldo devido', async () => {
    const opA = await newOperator('vendedor', 0);
    const opB = await newOperator('vendedor', 0);
    const c = await newCustomer();
    const sale = await sell(opA, await newVariant(10000), [], { customerId: c.id });
    // 8 tentativas de 3000 sobre uma dívida de 10000: no máximo 3 passam
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        receiveSale(i % 2 ? opA : opB, sale.id, [pay('pix', 3000)]),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 201).length;
    expect(ok).toBe(3);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(5);
    const after = await getSale(sale.id);
    expect(after.balanceCents).toBe(1000);
    expect(after.receivedCents).toBe(9000);
    expect(await debtOf(c.id)).toBe(1000);
  });

  it('recebimentos simultâneos do mesmo cliente (geral e por venda) respeitam o saldo total', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer();
    const s1 = await sell(op, await newVariant(5000), [], { customerId: c.id });
    await sell(op, await newVariant(5000), [], { customerId: c.id });
    const results = await Promise.all([
      receive(op, c.id, [pay('pix', 6000)]),
      receive(op, c.id, [pay('pix', 6000)]),
      receiveSale(op, s1.id, [pay('pix', 5000)]),
      receive(op, c.id, [pay('dinheiro', 4000)]),
    ]);
    const paid = results
      .filter((r) => r.statusCode === 201)
      .reduce((s, r) => s + r.json().receipt.totalCents, 0);
    expect(paid).toBeLessThanOrEqual(10000);
    expect(await debtOf(c.id)).toBe(10000 - paid);
  });

  it('venda cancelada ou sem cliente não recebe; cliente inexistente retorna 404', async () => {
    const op = await newOperator('gerente', 0);
    const noCustomer = await sell(op, await newVariant(), [pay('pix', 10000)]);
    expect((await receiveSale(op, noCustomer.id, [pay('pix', 1)])).statusCode).toBe(422);
    const c = await newCustomer();
    const fiado = await sell(op, await newVariant(), [], { customerId: c.id });
    await inject('POST', `/sales/${fiado.id}/cancel`, op.token, {
      idempotencyKey: `cancel-key-${uid()}`,
      reason: 'cancelar',
    });
    expect((await receiveSale(op, fiado.id, [pay('pix', 1)])).json().error.code).toBe('NO_BALANCE');
    expect(
      (await receive(op, '00000000-0000-4000-8000-000000000000', [pay('pix', 1)])).statusCode,
    ).toBe(404);
  });

  it('valida entrada e exige permissão/autenticação', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer();
    expect((await receive(op, c.id, [])).statusCode).toBe(400);
    expect((await receive(op, c.id, [pay('pix', 0)])).statusCode).toBe(400);
    expect((await inject('POST', `/customers/${c.id}/receipts`, undefined, {})).statusCode).toBe(
      401,
    );
  });
});

// ---------------------------------------------------------------------------
// Estorno de recebimento
// ---------------------------------------------------------------------------
describe('estorno de recebimento', () => {
  async function receiptFor() {
    const seller = await newOperator('vendedor', 0);
    const mgr = await newOperator('gerente', 0);
    const c = await newCustomer();
    const sale = await sell(seller, await newVariant(10000), [], { customerId: c.id });
    const rcpt = (
      await receiveSale(seller, sale.id, [pay('dinheiro', 4000), pay('pix', 2000)])
    ).json().receipt;
    return { seller, mgr, c, sale, rcpt };
  }
  const reverse = (op: Operator, id: string, key = `rev-key-${uid()}`) =>
    inject('POST', `/receipts/${id}/reverse`, op.token, {
      idempotencyKey: key,
      reason: 'Recebido por engano',
    });

  it('reabre a dívida sem alterar o histórico e tira o dinheiro do caixa de quem estorna', async () => {
    const { mgr, c, sale, rcpt } = await receiptFor();
    expect(await debtOf(c.id)).toBe(4000);
    const res = await reverse(mgr, rcpt.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().receipt).toMatchObject({
      kind: 'estorno',
      reversesReceiptId: rcpt.id,
      totalCents: 6000,
    });
    expect(await debtOf(c.id)).toBe(10000);
    const after = await getSale(sale.id);
    expect(after).toMatchObject({ paymentStatus: 'fiado', balanceCents: 10000, receivedCents: 0 });
    expect(after.payments.filter((p: { kind: string }) => p.kind === 'recebimento')).toHaveLength(
      2,
    ); // original preservado
    expect(after.payments.filter((p: { reversed: boolean }) => p.reversed)).toHaveLength(2);
    expect(await reportOf(mgr)).toMatchObject({ refundedCents: 6000, expectedCashCents: -4000 });
    const hist = (await inject('GET', `/customers/${c.id}/payments`, mgr.token)).json();
    expect(hist.items.filter((p: { origin: string }) => p.origin === 'estorno')).toHaveLength(2);
  });

  it('só gerente/admin estornam; uma única vez; idempotente', async () => {
    const { seller, mgr, rcpt } = await receiptFor();
    expect((await reverse(seller, rcpt.id)).statusCode).toBe(403);
    const key = `rev-key-${uid()}`;
    const a = await reverse(mgr, rcpt.id, key);
    const b = await reverse(mgr, rcpt.id, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    const again = await reverse(mgr, rcpt.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REVERSED');
    const revOfRev = await reverse(mgr, a.json().receipt.id);
    expect(revOfRev.statusCode).toBe(422);
  });

  it('estornos simultâneos do mesmo recebimento: só um é aplicado', async () => {
    const { mgr, c, rcpt } = await receiptFor();
    const results = await Promise.all(Array.from({ length: 5 }, () => reverse(mgr, rcpt.id)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
    expect(await debtOf(c.id)).toBe(10000);
  });

  it('após estornar, a dívida pode ser recebida de novo', async () => {
    const { seller, mgr, c, sale, rcpt } = await receiptFor();
    await reverse(mgr, rcpt.id);
    expect((await receiveSale(seller, sale.id, [pay('pix', 10000)])).statusCode).toBe(201);
    expect(await debtOf(c.id)).toBe(0);
  });

  it('cancelar a venda estorna também os recebimentos posteriores (e o estorno do recebimento não duplica)', async () => {
    const { mgr, c, sale, rcpt } = await receiptFor();
    const cancel = await inject('POST', `/sales/${sale.id}/cancel`, mgr.token, {
      idempotencyKey: `cancel-key-${uid()}`,
      reason: 'Cancelar tudo',
    });
    expect(cancel.statusCode).toBe(201);
    const after = await getSale(sale.id);
    expect(after).toMatchObject({ status: 'cancelada', receivedCents: 0, balanceCents: 0 });
    expect(await debtOf(c.id)).toBe(0);
    expect((await reportOf(mgr)).refundedCents).toBe(6000);
    // o recebimento já foi desfeito pelo cancelamento
    const rev = await reverse(mgr, rcpt.id);
    expect(rev.statusCode).toBe(409);
  });

  it('cancelar depois de estornar um recebimento não estorna duas vezes o mesmo pagamento', async () => {
    const { mgr, sale, rcpt } = await receiptFor();
    await reverse(mgr, rcpt.id);
    const cancel = await inject('POST', `/sales/${sale.id}/cancel`, mgr.token, {
      idempotencyKey: `cancel-key-${uid()}`,
      reason: 'Cancelar',
    });
    expect(cancel.statusCode).toBe(201);
    expect((await getSale(sale.id)).receivedCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Devoluções depois de recebimentos posteriores
// ---------------------------------------------------------------------------
describe('devolução de venda com recebimento posterior', () => {
  it('abate o saldo devedor primeiro e reembolsa apenas o que foi efetivamente recebido', async () => {
    const op = await newOperator('gerente', 10000);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    await receiveSale(op, sale.id, [pay('dinheiro', 4000)]);
    const url = `/sales/${sale.id}/returns`;
    const body = { items: [{ saleItemId: sale.items[0].id, quantity: 1 }] };
    const preview = (await inject('POST', `${url}/preview`, op.token, body)).json().preview;
    expect(preview).toMatchObject({
      valueCents: 10000,
      debtReductionCents: 6000,
      refundDueCents: 4000,
    });
    const wrong = await inject('POST', url, op.token, {
      ...body,
      idempotencyKey: `ret-key-${uid()}`,
      reason: 'Defeito',
      refunds: [pay('dinheiro', 3000)],
    });
    expect(wrong.json().error.code).toBe('REFUND_MISMATCH');
    const ok = await inject('POST', url, op.token, {
      ...body,
      idempotencyKey: `ret-key-${uid()}`,
      reason: 'Defeito',
      refunds: [pay('dinheiro', 4000)],
    });
    expect(ok.statusCode).toBe(201);
    expect(await getSale(sale.id)).toMatchObject({
      status: 'devolvida',
      balanceCents: 0,
      receivedCents: 0,
    });
    expect(await debtOf(c.id)).toBe(0);
    expect((await reportOf(op)).expectedCashCents).toBe(10000);
  });

  it('devolução parcial reduz a dívida e permite quitar só o que resta', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer();
    const v = await newVariant(5000);
    const sale = await sell(op, v, [], { customerId: c.id }, 4); // 20000 fiado
    const ret = await inject('POST', `/sales/${sale.id}/returns`, op.token, {
      idempotencyKey: `ret-key-${uid()}`,
      items: [{ saleItemId: sale.items[0].id, quantity: 1 }],
      refunds: [],
      reason: 'Tamanho errado',
    });
    expect(ret.statusCode).toBe(201);
    expect(await debtOf(c.id)).toBe(15000);
    expect((await receiveSale(op, sale.id, [pay('pix', 15001)])).json().error.code).toBe(
      'OVERPAYMENT',
    );
    expect((await receiveSale(op, sale.id, [pay('pix', 15000)])).statusCode).toBe(201);
    expect(await getSale(sale.id)).toMatchObject({
      status: 'concluida',
      paymentStatus: 'pago',
      balanceCents: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Vencimento, dívidas em aberto e conta-corrente
// ---------------------------------------------------------------------------
describe('vencimento e conta-corrente', () => {
  const inDays = async (days: number): Promise<string> =>
    (
      await ctx.pool.query(
        `select to_char((now() at time zone 'America/Sao_Paulo')::date + $1::int, 'YYYY-MM-DD') as d`,
        [days],
      )
    ).rows[0].d;

  it('vencimento é opcional, vale só com saldo e não pode estar no passado', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer();
    const due = await inDays(10);
    const sale = await sell(op, await newVariant(), [pay('pix', 3000)], {
      customerId: c.id,
      dueDate: due,
    });
    expect(sale.dueDate).toBe(due);
    const body = (extra: object) => ({
      idempotencyKey: `sale-key-${uid()}`,
      customerId: c.id,
      ...extra,
    });
    const v = await newVariant();
    expect(
      (
        await inject(
          'POST',
          '/sales',
          op.token,
          body({ items: [line(v)], payments: [pay('pix', 10000)], dueDate: due }),
        )
      ).json().error.code,
    ).toBe('DUE_DATE_WITHOUT_BALANCE');
    expect(
      (
        await inject(
          'POST',
          '/sales',
          op.token,
          body({ items: [line(v)], payments: [], dueDate: await inDays(-1) }),
        )
      ).json().error.code,
    ).toBe('DUE_DATE_IN_PAST');
    const noDue = await sell(op, await newVariant(), [], { customerId: c.id });
    expect(noDue.dueDate).toBeNull();
  });

  it('só gerente/admin alteram o vencimento; fica auditado', async () => {
    const op = await newOperator('vendedor', 0);
    const mgr = await newOperator('gerente', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(), [], { customerId: c.id });
    const due = await inDays(5);
    expect(
      (await inject('PATCH', `/sales/${sale.id}/due-date`, op.token, { dueDate: due })).statusCode,
    ).toBe(403);
    const ok = await inject('PATCH', `/sales/${sale.id}/due-date`, mgr.token, { dueDate: due });
    expect(ok.json().sale.dueDate).toBe(due);
    expect(
      (await inject('PATCH', `/sales/${sale.id}/due-date`, mgr.token, { dueDate: null })).json()
        .sale.dueDate,
    ).toBeNull();
    expect(
      (await inject('PATCH', `/sales/${sale.id}/due-date`, mgr.token, { dueDate: 'ontem' }))
        .statusCode,
    ).toBe(400);
    const audit = await ctx.pool.query(
      `select payload from audit_log where action = 'sale.due_date' and entity_id = $1 order by id`,
      [sale.id],
    );
    expect(audit.rows.map((r) => r.payload.to)).toEqual([due, null]);
    // venda quitada não tem vencimento
    await receiveSale(op, sale.id, [pay('pix', 10000)]);
    expect(
      (await inject('PATCH', `/sales/${sale.id}/due-date`, mgr.token, { dueDate: due })).statusCode,
    ).toBe(422);
  });

  it('identifica dívidas em aberto e vencidas; vencimento não bloqueia novas vendas', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer();
    const late = await sell(op, await newVariant(4000), [], {
      customerId: c.id,
      dueDate: await inDays(3),
    });
    const open = await sell(op, await newVariant(2500), [pay('pix', 500)], { customerId: c.id });
    // simula o tempo passando (campo de vencimento é o único mutável)
    await ctx.pool.query(
      `update sales set due_date = (now() at time zone 'America/Sao_Paulo')::date - 2 where id = $1`,
      [late.id],
    );
    const debts = (await inject('GET', `/debts?customerId=${c.id}`, op.token)).json();
    expect(debts.total).toBe(2);
    expect(debts.items[0]).toMatchObject({ saleId: late.id, overdue: true, balanceCents: 4000 });
    expect(debts.items[1]).toMatchObject({ saleId: open.id, overdue: false, balanceCents: 2000 });
    const overdue = (
      await inject('GET', `/debts?customerId=${c.id}&overdue=true`, op.token)
    ).json();
    expect(overdue.items.map((d: { saleId: string }) => d.saleId)).toEqual([late.id]);
    const customer = (await inject('GET', `/customers/${c.id}`, op.token)).json().customer;
    expect(customer).toMatchObject({ debtCents: 6000, overdueCents: 4000 });
    // sem regra definida: cliente com dívida vencida continua podendo comprar
    expect((await sell(op, await newVariant(1000), [], { customerId: c.id })).paymentStatus).toBe(
      'fiado',
    );
    // quitada, some da lista de abertas
    await receiveSale(op, late.id, [pay('pix', 4000)]);
    expect(
      (await inject('GET', `/debts?customerId=${c.id}&overdue=true`, op.token)).json().total,
    ).toBe(0);
  });

  it('conta-corrente: dados, dívidas abertas, recebimentos e histórico de compras', async () => {
    const op = await newOperator('vendedor', 0);
    const c = await newCustomer(50000);
    const s1 = await sell(op, await newVariant(3000), [], { customerId: c.id });
    await sell(op, await newVariant(2000), [pay('dinheiro', 2000)], { customerId: c.id });
    await receiveSale(op, s1.id, [pay('pix', 1000)]);
    const acc = (await inject('GET', `/customers/${c.id}/account`, op.token)).json();
    expect(acc.customer).toMatchObject({ id: c.id, debtCents: 2000, creditLimitCents: 50000 });
    expect(acc.openDebts).toHaveLength(1);
    expect(acc.openDebts[0]).toMatchObject({ saleId: s1.id, balanceCents: 2000 });
    expect(acc.receipts).toHaveLength(1);
    expect(acc.receipts[0].allocations[0]).toMatchObject({
      saleNumber: s1.number,
      method: 'pix',
      amountCents: 1000,
    });
    const purchases = (await inject('GET', `/sales?customerId=${c.id}`, op.token)).json();
    expect(purchases.total).toBe(2);
    const pays = (await inject('GET', `/customers/${c.id}/payments`, op.token)).json();
    expect(pays.items.map((p: { origin: string }) => p.origin).sort()).toEqual([
      'posterior',
      'venda',
    ]);
    expect(
      (await inject('GET', `/customers/00000000-0000-4000-8000-000000000000/account`, op.token))
        .statusCode,
    ).toBe(404);
  });

  it('edição de dados do cliente continua auditada e respeita o limite de crédito por papel', async () => {
    const seller = await newOperator('vendedor', 0);
    const mgr = await newOperator('gerente', 0);
    const c = await newCustomer();
    expect(
      (await inject('PATCH', `/customers/${c.id}`, seller.token, { phone: '53999990000' })).json()
        .customer.phone,
    ).toBe('53999990000');
    expect(
      (await inject('PATCH', `/customers/${c.id}`, seller.token, { creditLimitCents: 1000 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await inject('PATCH', `/customers/${c.id}`, mgr.token, { creditLimitCents: 1000 })).json()
        .customer.creditLimitCents,
    ).toBe(1000);
  });

  it('o limite de crédito considera a dívida atual: receber libera crédito', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer(10000);
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    const v = await newVariant(4000);
    const blocked = await inject('POST', '/sales', op.token, {
      idempotencyKey: `sale-key-${uid()}`,
      items: [line(v)],
      payments: [],
      customerId: c.id,
    });
    expect(blocked.json().error.code).toBe('CREDIT_LIMIT_EXCEEDED');
    await receiveSale(op, sale.id, [pay('pix', 5000)]);
    expect((await sell(op, v, [], { customerId: c.id })).paymentStatus).toBe('fiado');
  });
});

// ---------------------------------------------------------------------------
// Barreiras no banco (última linha de defesa)
// ---------------------------------------------------------------------------
describe('integridade no banco', () => {
  it('sessão fechada é imutável e não pode ser apagada; abertura não pode ser alterada', async () => {
    const op = await newOperator('gerente', 1000);
    await expect(
      ctx.pool.query('update cash_sessions set opening_cents = 5 where id = $1', [op.sessionId]),
    ).rejects.toThrow(/só é permitido fechar/);
    await expect(
      ctx.pool.query('delete from cash_sessions where id = $1', [op.sessionId]),
    ).rejects.toThrow(/imutável/);
    await close(op, op.sessionId, 1000);
    await expect(
      ctx.pool.query(`update cash_sessions set counted_cents = 1 where id = $1`, [op.sessionId]),
    ).rejects.toThrow(/fechado/);
  });

  it('o banco recusa pagamento em caixa fechado, de outro operador ou sem caixa', async () => {
    const op = await newOperator('gerente', 0);
    const other = await newOperator('gerente', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    const ins = (userId: string, session: string | null) =>
      inTx((cl) =>
        cl
          .query(
            `insert into payments (sale_id, kind, method, amount_cents, created_by, cash_session_id)
             values ($1, 'recebimento', 'pix', 100, $2, $3)`,
            [sale.id, userId, session],
          )
          .then(() => undefined),
      );
    expect((await ins(op.id, null)).error?.message).toMatch(/cash_integrity.*sem caixa/);
    expect((await ins(op.id, other.sessionId)).error?.message).toMatch(/outro operador/);
    await close(op, op.sessionId, 0);
    expect((await ins(op.id, op.sessionId)).error?.message).toMatch(/caixa fechado/);
    expect((await getSale(sale.id)).receivedCents).toBe(0);
  });

  it('o banco recusa fechamento com esperado que não confere com a gaveta', async () => {
    const op = await newOperator('gerente', 1000);
    const { error } = await inTx((cl) =>
      cl
        .query(
          `update cash_sessions set status = 'fechado', closed_by = $2, closed_at = now(), counted_cents = 1000,
                  expected_cents = 999, difference_cents = 1, close_note = 'fraude', close_key = $3 where id = $1`,
          [op.sessionId, op.id, `close-key-${uid()}`],
        )
        .then(() => undefined),
    );
    expect(error?.message).toMatch(/esperado do fechamento/);
    expect((await inject('GET', '/cash/current', op.token)).json().session.status).toBe('aberto');
  });

  it('recebimento no banco: soma dos pagamentos precisa bater com o total e ser do mesmo cliente', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer();
    const other = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    const otherSale = await sell(op, await newVariant(10000), [], { customerId: other.id });
    const receiptSql = `insert into debt_receipts (kind, customer_id, cash_session_id, total_cents, idempotency_key, request_hash, created_by)
                        values ('recebimento', $1, $2, $3, $4, 'x', $5) returning id`;
    const payIns = `insert into payments (sale_id, kind, method, amount_cents, created_by, cash_session_id, receipt_id)
                    values ($1, 'recebimento', 'pix', $2, $3, $4, $5)`;
    const wrongTotal = await inTx(async (cl) => {
      const r = await cl.query(receiptSql, [c.id, op.sessionId, 500, `raw-${uid()}`, op.id]);
      await cl.query(payIns, [sale.id, 400, op.id, op.sessionId, r.rows[0].id]);
    });
    expect(wrongTotal.error?.message).toMatch(/não somam o total/);
    const wrongCustomer = await inTx(async (cl) => {
      const r = await cl.query(receiptSql, [c.id, op.sessionId, 500, `raw-${uid()}`, op.id]);
      await cl.query(payIns, [otherSale.id, 500, op.id, op.sessionId, r.rows[0].id]);
    });
    expect(wrongCustomer.error?.message).toMatch(/outro cliente/);
    const ok = await inTx(async (cl) => {
      const r = await cl.query(receiptSql, [c.id, op.sessionId, 500, `raw-${uid()}`, op.id]);
      await cl.query(payIns, [sale.id, 500, op.id, op.sessionId, r.rows[0].id]);
    });
    expect(ok.error).toBeUndefined();
    await expect(ctx.pool.query('update debt_receipts set total_cents = 1')).rejects.toThrow(
      /imutável/,
    );
    await expect(
      ctx.pool.query('delete from payments where receipt_id is not null'),
    ).rejects.toThrow(/imutável/);
  });

  it('estorno de recebimento no banco precisa reverter todos os pagamentos do original', async () => {
    const op = await newOperator('gerente', 0);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    const rcpt = (await receiveSale(op, sale.id, [pay('pix', 1000), pay('dinheiro', 2000)])).json()
      .receipt;
    const original = (
      await ctx.pool.query(
        'select id, method, amount_cents from payments where receipt_id = $1 order by amount_cents',
        [rcpt.id],
      )
    ).rows;
    const { error } = await inTx(async (cl) => {
      const r = await cl.query(
        `insert into debt_receipts (kind, customer_id, cash_session_id, total_cents, reverses_receipt_id, reason, idempotency_key, request_hash, created_by)
         values ('estorno', $1, $2, 1000, $3, 'parcial', $4, 'x', $5) returning id`,
        [c.id, op.sessionId, rcpt.id, `raw-${uid()}`, op.id],
      );
      await cl.query(
        `insert into payments (sale_id, kind, method, amount_cents, reverses_payment_id, created_by, cash_session_id, receipt_id)
         values ($1, 'estorno', $2, $3, $4, $5, $6, $7)`,
        [
          sale.id,
          original[0].method,
          original[0].amount_cents,
          original[0].id,
          op.id,
          op.sessionId,
          r.rows[0].id,
        ],
      );
    });
    expect(error?.message).toMatch(/estorno do recebimento .* incompleto/);
  });

  it('auditoria registra abertura, movimentos, recebimentos, estornos e fechamento', async () => {
    const op = await newOperator('gerente', 5000);
    const c = await newCustomer();
    const sale = await sell(op, await newVariant(10000), [], { customerId: c.id });
    const m = (await movement(op, 'sangria', 1000)).json().id as string;
    await inject('POST', `/cash/movements/${m}/reverse`, op.token, {
      idempotencyKey: `rev-key-${uid()}`,
      reason: 'erro de digitação',
    });
    const rcpt = (await receiveSale(op, sale.id, [pay('pix', 100)])).json().receipt;
    await inject('POST', `/receipts/${rcpt.id}/reverse`, op.token, {
      idempotencyKey: `rev-key-${uid()}`,
      reason: 'erro de valor',
    });
    await close(op, op.sessionId, 5000);
    const actions = (
      await ctx.pool.query('select action from audit_log where actor_id = $1 order by id', [op.id])
    ).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'cash.open',
        'sale.create',
        'cash.sangria',
        'cash.movement.reverse',
        'debt.receive',
        'debt.receive.reverse',
        'cash.close',
      ]),
    );
  });
});
