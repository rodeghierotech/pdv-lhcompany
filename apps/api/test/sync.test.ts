import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, openCash, setup } from './helpers.js';
import type { TestCtx } from './helpers.js';
import { createGrantSigner } from '../src/modules/sync/grant.js';

let ctx: TestCtx;
let vendedor: string;
let gerente: string;
let sellerCash: string;
let gerenteCash: string;

beforeAll(async () => {
  ctx = await setup();
  vendedor = ctx.tokenFor('vendedor');
  gerente = ctx.tokenFor('gerente');
  sellerCash = await openCash(ctx, vendedor);
  gerenteCash = await openCash(ctx, gerente);
});
afterAll(async () => {
  // estoque derivado das movimentações (pode ser negativo por venda física offline)
  const bad = await ctx.pool.query(
    `select v.id from product_variants v left join stock_levels s on s.variant_id = v.id
     where coalesce(s.quantity, 0) <> coalesce((select sum(quantity_delta) from stock_movements m where m.variant_id = v.id), 0)`,
  );
  expect(bad.rows).toEqual([]);
  await ctx.close();
});

/** Recua a abertura de um caixa (teste de venda feita horas antes). Só em teste: a trigger protege o campo. */
async function backdateSession(id: string, ms: number): Promise<void> {
  const c = await ctx.pool.connect();
  try {
    await c.query('alter table cash_sessions disable trigger cash_sessions_guard');
    await c.query(
      "update cash_sessions set opened_at = opened_at - ($2 || ' milliseconds')::interval where id = $1",
      [id, String(ms)],
    );
    await c.query('alter table cash_sessions enable trigger cash_sessions_guard');
  } finally {
    c.release();
  }
}

interface Result {
  status: string;
  saleId?: string;
  saleNumber?: number;
  duplicate?: boolean;
  resolution?: string;
  error: { code: string };
  conflicts: Array<{ code: string; blocking: boolean }>;
}
interface V {
  id: string;
  priceCents: number;
}
let n = 0;
async function newVariant(price = 10000, stock = 10): Promise<V> {
  const k = ++n;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/products',
    headers: auth(gerente),
    payload: {
      name: `Produto sync ${k}`,
      idempotencyKey: `sync-prod-${k}-${Math.random()}`,
      variants: [
        { sku: `SYNC-${k}-${Date.now()}`, priceCents: price, costCents: 100, initialStock: stock },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().product.variants[0] as V;
}
const stockOf = async (v: V) =>
  Number(
    (await ctx.pool.query('select quantity from stock_levels where variant_id=$1', [v.id])).rows[0]
      .quantity,
  );

interface Device {
  id: string;
  /** Caixa em que o aparelho vendeu (conhecido enquanto online). */
  cash: string;
  grant: string;
  seq: number;
}
/** Dispositivo cuja autorização foi emitida há `ageMs` (a venda offline acontece depois disso). */
function agedDevice(role: 'vendedor' | 'gerente', ageMs: number): Device {
  const id = randomUUID();
  const signer = createGrantSigner(process.env.JWT_SECRET!);
  const g = signer.issue({ id: ctx.users[role].id, role }, id, Date.now() - ageMs);
  return { id, grant: g.grant, seq: 0, cash: role === 'gerente' ? gerenteCash : sellerCash };
}
async function newDevice(token = vendedor): Promise<Device> {
  const id = randomUUID();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/auth/offline-grant',
    headers: auth(token),
    payload: { deviceId: id },
  });
  expect(res.statusCode).toBe(200);
  return {
    id,
    grant: res.json().grant as string,
    seq: 0,
    cash: token === gerente ? gerenteCash : sellerCash,
  };
}

const op = (
  d: Device,
  v: V,
  over: Record<string, unknown> = {},
  payload: Record<string, unknown> = {},
) => ({
  operationId: randomUUID(),
  sequence: d.seq++,
  type: 'create_sale',
  createdAt: new Date().toISOString(),
  cashSessionId: d.cash,
  dependsOn: [],
  payload: {
    items: [{ variantId: v.id, quantity: 1, unitPriceCents: v.priceCents, discountCents: 0 }],
    payments: [{ method: 'dinheiro', amountCents: v.priceCents }],
    ...payload,
  },
  ...over,
});

const sync = (d: Device, operations: unknown[], grant = d.grant) =>
  ctx.app.inject({
    method: 'POST',
    url: '/sync/operations',
    payload: { deviceId: d.id, grant, operations },
  });
const results = async (d: Device, operations: unknown[]) => {
  const res = await sync(d, operations);
  expect(res.statusCode).toBe(200);
  return res.json().results as Result[];
};

describe('autorização offline', () => {
  it('exige sessão e emite grant com validade de no máximo 8 h', async () => {
    const id = randomUUID();
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/auth/offline-grant',
          payload: { deviceId: id },
        })
      ).statusCode,
    ).toBe(401);
    const d = await newDevice();
    const claims = JSON.parse(Buffer.from(d.grant.split('.')[0]!, 'base64url').toString());
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(8 * 3600_000);
    expect(claims.did).toBe(d.id);
  });

  it('rejeita grant adulterado, de outro dispositivo e sem assinatura', async () => {
    const d = await newDevice();
    const v = await newVariant();
    const [body, sig] = d.grant.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, 'base64url').toString()),
        role: 'admin',
        exp: Date.now() + 9e8,
      }),
    ).toString('base64url');
    expect((await sync(d, [op(d, v)], `${forged}.${sig}`)).statusCode).toBe(401);
    expect((await sync(d, [op(d, v)], 'lixo-lixo-lixo-lixo.lixo-lixo-lixo')).statusCode).toBe(401);
    const other = await newDevice();
    expect((await sync(d, [op(d, v)], other.grant)).statusCode).toBe(401);
    expect(await stockOf(v)).toBe(10);
  });

  it('operação fora da janela da autorização (token expirado) vira conflito e não vende', async () => {
    const signer = createGrantSigner(process.env.JWT_SECRET!);
    const deviceId = randomUUID();
    const old = signer.issue(
      { id: ctx.users.vendedor.id, role: 'vendedor' },
      deviceId,
      Date.now() - 12 * 3600_000,
    );
    const d: Device = { id: deviceId, grant: old.grant, seq: 0, cash: sellerCash };
    await backdateSession(sellerCash, 13 * 3600_000);
    const v = await newVariant();
    // criada 1 h depois de a autorização expirar
    const late = new Date(old.claims.exp + 3600_000).toISOString();
    const [r] = await results(d, [op(d, v, { createdAt: late })]);
    expect(r!.status).toBe('conflito');
    expect(r!.error.code).toBe('GRANT_EXPIRED');
    expect(await stockOf(v)).toBe(10);
    // criada dentro da janela, mesmo sincronizada depois da expiração: aceita
    const inside = new Date(old.claims.iat + 3600_000).toISOString();
    const [ok] = await results(d, [op(d, v, { createdAt: inside })]);
    expect(ok!.status).toBe('confirmada');
  });
});

describe('sincronização de vendas', () => {
  it('aplica venda offline com data real, pagamento, estoque e origem; reenvio não duplica', async () => {
    const d = agedDevice('vendedor', 3600_000);
    await backdateSession(sellerCash, 2 * 3600_000);
    const v = await newVariant(5000, 10);
    const o = op(d, v, { createdAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    const [r1] = await results(d, [o]);
    expect(r1!.status).toBe('confirmada');
    expect(r1!.saleNumber).toBeGreaterThan(0);
    expect(await stockOf(v)).toBe(9);

    const [r2] = await results(d, [o]);
    expect(r2!.status).toBe('confirmada');
    expect(r2!.duplicate).toBe(true);
    expect(r2!.saleId).toBe(r1!.saleId);
    expect(await stockOf(v)).toBe(9);

    const sale = (await ctx.pool.query('select * from sales where id=$1', [r1!.saleId])).rows[0];
    expect(sale.origin).toBe('offline');
    expect(sale.cash_session_id).toBe(sellerCash);
    expect(Date.now() - new Date(sale.created_at).getTime()).toBeGreaterThan(25 * 60_000);
    const pay = (
      await ctx.pool.query('select created_at from payments where sale_id=$1', [sale.id])
    ).rows;
    expect(pay).toHaveLength(1);
    expect(new Date(pay[0].created_at).getTime()).toBe(new Date(sale.created_at).getTime());
  });

  it('reenvios simultâneos da mesma operação geram uma única venda', async () => {
    const d = await newDevice();
    const v = await newVariant(7000, 10);
    const o = op(d, v);
    const all = await Promise.all(Array.from({ length: 6 }, () => sync(d, [o])));
    for (const res of all) expect(res.statusCode).toBe(200);
    const ids = new Set(all.map((r) => r.json().results[0].saleId));
    expect(ids.size).toBe(1);
    expect(await stockOf(v)).toBe(9);
    expect(
      Number(
        (
          await ctx.pool.query('select count(*) from sales where sync_operation_id=$1', [
            o.operationId,
          ])
        ).rows[0].count,
      ),
    ).toBe(1);
  });

  it('venda online e venda física offline do mesmo produto: física prevalece e sinaliza estoque negativo', async () => {
    const d = await newDevice();
    const v = await newVariant(9000, 1);
    const online = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: auth(gerente),
      payload: {
        idempotencyKey: `online-${randomUUID()}`,
        items: [{ variantId: v.id, quantity: 1, unitPriceCents: 9000, discountCents: 0 }],
        payments: [{ method: 'pix', amountCents: 9000 }],
      },
    });
    expect(online.statusCode).toBe(201);
    const [r] = await results(d, [op(d, v)]);
    expect(r!.status).toBe('confirmada');
    expect(r!.conflicts.map((c: { code: string; blocking: boolean }) => c.code)).toContain(
      'STOCK_NEGATIVE',
    );
    expect(
      r!.conflicts.every((c: { code: string; blocking: boolean }) => c.blocking === false),
    ).toBe(true);
    expect(await stockOf(v)).toBe(-1);
  });

  it('preço divergente: mantém o preço cobrado e registra a divergência', async () => {
    const d = await newDevice();
    const v = await newVariant(10000, 5);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/variants/${v.id}`,
      headers: auth(gerente),
      payload: { priceCents: 12000 },
    });
    const [r] = await results(d, [
      op(d, v, {}, { payments: [{ method: 'dinheiro', amountCents: 10000 }] }),
    ]);
    expect(r!.status).toBe('confirmada');
    expect(r!.conflicts.map((c: { code: string; blocking: boolean }) => c.code)).toContain(
      'PRICE_DIVERGED',
    );
    const total = (await ctx.pool.query('select total_cents from sales where id=$1', [r!.saleId]))
      .rows[0];
    expect(total.total_cents).toBe(10000);
  });

  it('dispositivos diferentes vendendo a última peça: ambas aplicadas, estoque negativo e ledger consistente', async () => {
    const a = await newDevice();
    const b = await newDevice(gerente);
    const v = await newVariant(3000, 1);
    const [ra] = await results(a, [op(a, v)]);
    const [rb] = await results(b, [op(b, v)]);
    expect(ra!.status).toBe('confirmada');
    expect(rb!.status).toBe('confirmada');
    expect(a.seq).toBe(b.seq); // mesma sequência local em dispositivos distintos é permitido
    expect(await stockOf(v)).toBe(-1);
    const sellers = (
      await ctx.pool.query('select seller_id from sales where id = any($1)', [
        [ra!.saleId, rb!.saleId],
      ])
    ).rows.map((r) => r.seller_id);
    expect(new Set(sellers).size).toBe(2);
  });

  it('operationId reutilizado com conteúdo diferente e sequência reutilizada são recusados', async () => {
    const d = await newDevice();
    const v = await newVariant();
    const o = op(d, v);
    await results(d, [o]);
    const tampered = { ...o, payload: { ...(o.payload as object), note: 'outra coisa' } };
    const [r1] = await results(d, [tampered]);
    expect(r1!.status).toBe('conflito');
    expect(r1!.error.code).toBe('OPERATION_ID_REUSED');
    const [r2] = await results(d, [{ ...op(d, v), sequence: o.sequence }]);
    expect(r2!.error.code).toBe('SEQUENCE_REUSED');
    expect(await stockOf(v)).toBe(9);
  });

  it('dependências: espera a operação anterior e aplica depois', async () => {
    const d = await newDevice();
    const v = await newVariant();
    const first = op(d, v);
    const second = op(d, v, { dependsOn: [first.operationId] });
    const [r1] = await results(d, [second]);
    expect(r1!.status).toBe('falha_recuperavel');
    expect(r1!.error.code).toBe('DEPENDENCY_PENDING');
    const both = await results(d, [first, second]);
    expect(both.map((r) => r.status)).toEqual(['confirmada', 'confirmada']);
    expect(await stockOf(v)).toBe(8);
  });

  it('falha no meio da transação: nada é aplicado e o reenvio funciona', async () => {
    const d = await newDevice();
    const v = await newVariant(1300, 10);
    await ctx.pool.query(`
      create function pg_temp_fault() returns trigger language plpgsql as $$
      begin if new.amount_cents = 1300 then raise exception 'falha simulada' using errcode = 'XX000'; end if; return new; end $$;
      create trigger fault_pay before insert on payments for each row execute function pg_temp_fault();`);
    const o = op(d, v);
    try {
      const [r1] = await results(d, [o]);
      expect(r1!.status).toBe('falha_recuperavel');
      expect(r1!.error.code).toBe('TRANSIENT_FAILURE');
      expect(await stockOf(v)).toBe(10);
      expect(
        Number(
          (
            await ctx.pool.query('select count(*) from sales where idempotency_key=$1', [
              `op:${o.operationId}`,
            ])
          ).rows[0].count,
        ),
      ).toBe(0);
    } finally {
      await ctx.pool.query('drop trigger fault_pay on payments; drop function pg_temp_fault();');
    }
    const [r2] = await results(d, [o]);
    expect(r2!.status).toBe('confirmada');
    expect(await stockOf(v)).toBe(9);
  });

  it('desconto acima do limite: conflito bloqueante; gerente aprova ou descarta; vendedor não resolve', async () => {
    const d = await newDevice();
    const v = await newVariant(10000, 10);
    const bigDiscount = {
      items: [{ variantId: v.id, quantity: 1, unitPriceCents: 10000, discountCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    };
    const o1 = op(d, v, {}, bigDiscount);
    const o2 = op(d, v, {}, bigDiscount);
    const [r1, r2] = await results(d, [o1, o2]);
    expect(r1!.status).toBe('conflito');
    expect(r1!.error.code).toBe('DISCOUNT_NOT_ALLOWED');
    expect(await stockOf(v)).toBe(10);

    const post = (id: string, token: string, action: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/sync/operations/${id}/resolve`,
        headers: auth(token),
        payload: { action, note: 'conferido no balcão' },
      });
    expect((await post(o1.operationId, vendedor, 'aprovar')).statusCode).toBe(403);

    const approved = await post(o1.operationId, gerente, 'aprovar');
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().result.status).toBe('confirmada');
    expect(await stockOf(v)).toBe(9);
    // idempotente: resolver de novo é recusado
    expect((await post(o1.operationId, gerente, 'aprovar')).statusCode).toBe(409);

    const discarded = await post(o2.operationId, gerente, 'descartar');
    expect(discarded.json().result.resolution).toBe('descartada');
    expect(await stockOf(v)).toBe(9);
    // reenvio devolve o estado resolvido
    const [again] = await results(d, [o2]);
    expect(again!.resolution).toBe('descartada');
    const issues = await ctx.app.inject({
      method: 'GET',
      url: '/sync/issues',
      headers: auth(gerente),
    });
    const ids = issues.json().items.map((i: { operationId: string }) => i.operationId);
    expect(ids).not.toContain(o1.operationId);
    expect(ids).not.toContain(o2.operationId);
    expect(r2!.status).toBe('conflito');
  });

  it('conflito de autorização (expirada) não é aprovável', async () => {
    const signer = createGrantSigner(process.env.JWT_SECRET!);
    const deviceId = randomUUID();
    const g = signer.issue(
      { id: ctx.users.vendedor.id, role: 'vendedor' },
      deviceId,
      Date.now() - 20 * 3600_000,
    );
    const d: Device = { id: deviceId, grant: g.grant, seq: 0, cash: sellerCash };
    const v = await newVariant();
    const o = op(d, v, { createdAt: new Date().toISOString() });
    const [r] = await results(d, [o]);
    expect(r!.error.code).toBe('GRANT_EXPIRED');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sync/operations/${o.operationId}/resolve`,
      headers: auth(gerente),
      payload: { action: 'aprovar', note: 'tentando' },
    });
    expect(res.statusCode).toBe(422);
    expect(await stockOf(v)).toBe(10);
  });

  it('variante inexistente: conflito sem aplicar', async () => {
    const d = await newDevice();
    const ghost: V = { id: randomUUID(), priceCents: 1000 };
    const [r] = await results(d, [op(d, ghost)]);
    expect(r!.status).toBe('conflito');
    expect(r!.error.code).toBe('VARIANT_NOT_FOUND');
  });

  it('venda offline fiada com cliente respeita limite de crédito', async () => {
    const d = await newDevice();
    const v = await newVariant(10000, 5);
    const c = await ctx.app.inject({
      method: 'POST',
      url: '/customers',
      headers: auth(gerente),
      payload: { name: 'Cliente Fiado Sync', creditLimitCents: 5000 },
    });
    const customerId = c.json().customer.id;
    const [r] = await results(d, [op(d, v, {}, { customerId, payments: [] })]);
    expect(r!.status).toBe('conflito');
    expect(r!.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
  });
});

describe('caixa de origem e regularização', () => {
  const closeCash = async (token: string, sessionId: string) => {
    const cur = await ctx.app.inject({ method: 'GET', url: '/cash/current', headers: auth(token) });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/cash/sessions/${sessionId}/close`,
      headers: auth(token),
      payload: {
        idempotencyKey: `close-${randomUUID()}`,
        countedCents: cur.json().report.expectedCashCents,
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
  };
  const sessionRow = async (id: string) =>
    (
      await ctx.pool.query(
        'select status, counted_cents, expected_cents, difference_cents, closed_at, cash_session_expected(id) as live from cash_sessions where id=$1',
        [id],
      )
    ).rows[0];
  async function newSeller(ageMs = 0) {
    const email = `vend.${randomUUID()}@sync.dev`;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/users',
      headers: auth(ctx.tokenFor('admin')),
      payload: { name: 'Vendedor Sync', email, password: 'senha-vendedor-123', role: 'vendedor' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'senha-vendedor-123' },
    });
    const token = login.json().token as string;
    const cash = await openCash(ctx, token, 10000);
    const deviceId = randomUUID();
    const userId = login.json().user.id as string;
    const grant = createGrantSigner(process.env.JWT_SECRET!).issue(
      { id: userId, role: 'vendedor' },
      deviceId,
      Date.now() - ageMs,
    );
    if (ageMs > 0) await backdateSession(cash, ageMs + 60_000);
    const d: Device = { id: deviceId, grant: grant.grant, seq: 0, cash };
    return { token, cash, d, id: userId };
  }

  it('venda offline com o caixa de origem aberto é registrada nele (com data real)', async () => {
    const { d, cash } = await newSeller(3600_000);
    const v = await newVariant(2500, 5);
    const created = new Date(Date.now() - 20 * 60_000).toISOString();
    const [r] = await results(d, [op(d, v, { createdAt: created })]);
    expect(r!.status).toBe('confirmada');
    const sale = (await ctx.pool.query('select * from sales where id=$1', [r!.saleId])).rows[0];
    expect(sale.cash_session_id).toBe(cash);
    expect(sale.origin_cash_session_id).toBe(cash);
    const pay = (await ctx.pool.query('select * from payments where sale_id=$1', [sale.id]))
      .rows[0];
    expect(pay.regularization).toBe(false);
    expect(pay.cash_session_id).toBe(cash);
  });

  it('caixa fechado durante a queda: venda NÃO vai para o caixa aberto depois; reenvio idempotente; fechamento original preservado', async () => {
    const { token, cash, d } = await newSeller();
    const v = await newVariant(4000, 5);
    const o = op(d, v);
    // fecha o caixa de origem enquanto o aparelho está offline e abre outro (dia seguinte)
    await closeCash(token, cash);
    const before = await sessionRow(cash);
    const next = await openCash(ctx, token, 5000);

    const [r1] = await results(d, [o]);
    expect(r1!.status).toBe('conflito');
    expect(r1!.error.code).toBe('CASH_SESSION_CLOSED');
    expect(r1!.conflicts[0]).toMatchObject({ code: 'CASH_SESSION_CLOSED', blocking: true });
    expect(await stockOf(v)).toBe(5);
    // nada foi atribuído ao caixa novo
    expect(
      Number(
        (await ctx.pool.query('select count(*) from payments where cash_session_id=$1', [next]))
          .rows[0].count,
      ),
    ).toBe(0);

    // reenvios idempotentes: mesmo desfecho, sem duplicar nada
    for (let i = 0; i < 3; i++) {
      const [again] = await results(d, [o]);
      expect(again!.status).toBe('conflito');
      expect(again!.duplicate).toBe(true);
    }
    expect(
      Number(
        (
          await ctx.pool.query('select count(*) from sync_conflicts where operation_id=$1', [
            o.operationId,
          ])
        ).rows[0].count,
      ),
    ).toBe(1);
    // fechamento original intacto
    expect(await sessionRow(cash)).toEqual(before);
  });

  it('sincronização no dia seguinte: regularização aprovada registra a venda uma vez, no caixa aberto, com referência ao original', async () => {
    const { token, cash, d, id: sellerId } = await newSeller(6 * 3600_000);
    const v = await newVariant(6000, 5);
    // venda feita há 5 h; caixa fechado há 4 h (simulado: fecha agora; data da venda no passado)
    const o = op(
      d,
      v,
      { createdAt: new Date(Date.now() - 5 * 3600_000).toISOString() },
      {
        payments: [
          { method: 'dinheiro', amountCents: 3000 },
          { method: 'pix', amountCents: 3000 },
        ],
      },
    );
    await closeCash(token, cash);
    const original = await sessionRow(cash);
    const [r1] = await results(d, [o]);
    expect(r1!.error.code).toBe('CASH_SESSION_CLOSED');

    const approve = (who: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/sync/operations/${o.operationId}/resolve`,
        headers: auth(who),
        payload: { action: 'aprovar', note: 'venda feita antes do fechamento' },
      });
    // vendedor não aprova; sem caixa aberto do vendedor a regularização é recusada
    expect((await approve(token)).statusCode).toBe(403);
    const noCash = await approve(gerente);
    expect(noCash.statusCode).toBe(409);
    expect(noCash.json().error.code).toBe('CASH_NOT_OPEN');
    expect(await stockOf(v)).toBe(5);

    const next = await openCash(ctx, token, 20000);
    const nextBefore = await sessionRow(next);
    const ok = await approve(gerente);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().result.status).toBe('confirmada');
    const saleId = ok.json().result.saleId as string;

    const sale = (await ctx.pool.query('select * from sales where id=$1', [saleId])).rows[0];
    expect(sale.seller_id).toBe(sellerId);
    expect(sale.cash_session_id).toBe(next);
    expect(sale.origin_cash_session_id).toBe(cash);
    expect(Date.now() - new Date(sale.created_at).getTime()).toBeGreaterThan(4.9 * 3600_000);
    const pays = (
      await ctx.pool.query('select * from payments where sale_id=$1 order by amount_cents', [
        saleId,
      ])
    ).rows;
    expect(pays).toHaveLength(2);
    for (const p of pays) {
      expect(p.regularization).toBe(true);
      expect(p.origin_cash_session_id).toBe(cash);
      expect(p.cash_session_id).toBe(next);
    }
    // fechamento original preservado; gaveta do caixa novo não é inflada (sem contar duas vezes)
    expect(await sessionRow(cash)).toEqual(original);
    expect((await sessionRow(next)).live).toBe(nextBefore.live);
    const reg = (
      await ctx.pool.query('select * from cash_regularizations where operation_id=$1', [
        o.operationId,
      ])
    ).rows;
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({
      origin_session_id: cash,
      target_session_id: next,
      cash_cents: 3000,
      received_cents: 6000,
    });
    expect(await stockOf(v)).toBe(4);

    // nova aprovação e reenvio da operação: nenhum efeito duplicado
    expect((await approve(gerente)).statusCode).toBe(409);
    const [again] = await results(d, [o]);
    expect(again!.status).toBe('confirmada');
    expect(again!.saleId).toBe(saleId);
    expect(await stockOf(v)).toBe(4);
    expect(
      Number(
        (await ctx.pool.query('select count(*) from payments where sale_id=$1', [saleId])).rows[0]
          .count,
      ),
    ).toBe(2);
    // registro imutável
    await expect(
      ctx.pool.query('update cash_regularizations set note=$1', ['x']),
    ).rejects.toThrow();
  });

  it('caixa de outro operador, inexistente ou anterior à abertura: conflito não aprovável', async () => {
    const a = await newSeller();
    const b = await newSeller();
    const v = await newVariant(1000, 9);
    const foreign = { ...a.d, cash: b.cash };
    const [r1] = await results(foreign, [op(foreign, v)]);
    expect(r1!.error.code).toBe('CASH_SESSION_FOREIGN');
    const ghost = { ...a.d, cash: randomUUID(), seq: 10 };
    const [r2] = await results(ghost, [op(ghost, v)]);
    expect(r2!.error.code).toBe('CASH_SESSION_UNKNOWN');
    const early = {
      ...a.d,
      seq: 20,
      grant: createGrantSigner(process.env.JWT_SECRET!).issue(
        { id: a.id, role: 'vendedor' },
        a.d.id,
        Date.now() - 4 * 3600_000,
      ).grant,
    };
    const [r3] = await results(early, [
      op(early, v, { createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() }),
    ]);
    expect(r3!.error.code).toBe('CASH_SESSION_NOT_OPEN_YET');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sync/operations/${(r1 as unknown as { operationId: string }).operationId}/resolve`,
      headers: auth(gerente),
      payload: { action: 'aprovar', note: 'tentando' },
    });
    expect(res.statusCode).toBe(422);
    expect(await stockOf(v)).toBe(9);
  });
});

describe('catálogo offline', () => {
  it('entrega variantes ativas, clientes e limite de desconto do papel', async () => {
    const v = await newVariant(4200, 3);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/sync/catalog',
      headers: auth(vendedor),
    });
    expect(res.statusCode).toBe(200);
    const snap = res.json();
    expect(snap.variants.find((x: { id: string }) => x.id === v.id)).toMatchObject({
      priceCents: 4200,
      stock: 3,
    });
    expect(typeof snap.discountLimitBp).toBe('number');
    expect((await ctx.app.inject({ method: 'GET', url: '/sync/catalog' })).statusCode).toBe(401);
  });
});
