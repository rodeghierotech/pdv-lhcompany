import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { auth, openCash, setup } from './helpers.js';
import type { TestCtx } from './helpers.js';
import { createNuvemshopDeps } from '../src/modules/nuvemshop/index.js';
import type { NuvemshopDeps } from '../src/modules/nuvemshop/index.js';
import { NuvemshopError } from '../src/modules/nuvemshop/types.js';
import type { NuvemshopApi, RemoteOrder, RemoteVariant } from '../src/modules/nuvemshop/types.js';
import {
  ingestWebhook,
  processEvents,
  verifyWebhookSignature,
} from '../src/modules/nuvemshop/events.js';
import { sendOutbox, retryOutbox } from '../src/modules/nuvemshop/outbox.js';
import { reconcileStock, resolveIssue, sweepOrders } from '../src/modules/nuvemshop/reconcile.js';
import {
  completeAuthorization,
  createInstallUrl,
  getStatus,
} from '../src/modules/nuvemshop/connection.js';
import { createLink, importCatalog } from '../src/modules/nuvemshop/links.js';
import { runCycle } from '../src/modules/nuvemshop/worker.js';
import {
  createNuvemshopClient,
  exchangeAuthorizationCode,
} from '../src/modules/nuvemshop/client.js';
import { backoffMs } from '../src/modules/nuvemshop/deps.js';
import { redactUrl } from '../src/app.js';
import { createGrantSigner } from '../src/modules/sync/grant.js';

const STORE = '4242';
const SECRET = 'segredo-do-app-nuvemshop-123';

/** Loja Nuvemshop falsa em memória (contratos conforme a documentação 2025-03). */
class FakeNuvemshop implements NuvemshopApi {
  variants = new Map<string, RemoteVariant>();
  orders = new Map<string, RemoteOrder>();
  calls: string[] = [];
  /** Cada delta efetivamente aplicado pela loja (para provar ausência de aplicação dupla). */
  applied: number[] = [];
  locations = 1;
  failures: Array<{ op: string; err: NuvemshopError | 'lose_response' }> = [];
  fail(op: string, err: NuvemshopError | 'lose_response') {
    this.failures.push({ op, err });
  }
  webhooks: Array<{ id: string; event: string; url: string }> = [];
  addVariant(id: string, productId: string, sku: string, stock: number | null, locationCount = 1) {
    this.variants.set(id, {
      id,
      productId,
      sku,
      barcode: null,
      priceCents: 10000,
      stock,
      locationCount,
    });
  }
  private maybeFail(name: string) {
    this.calls.push(name);
    const i = this.failures.findIndex((f) => f.op === name);
    if (i < 0) return undefined;
    const err = this.failures.splice(i, 1)[0]!.err;
    if (err instanceof NuvemshopError) throw err;
    return err;
  }
  async getOrder(id: string) {
    this.maybeFail('getOrder');
    return this.orders.get(id) ?? null;
  }
  async listOrdersUpdatedSince(since: Date) {
    this.maybeFail('listOrders');
    return {
      items: [...this.orders.values()].filter(
        (o) => !o.updatedAt || new Date(o.updatedAt) >= since,
      ),
      hasMore: false,
    };
  }
  async listProducts() {
    this.maybeFail('listProducts');
    const byProduct = new Map<string, RemoteVariant[]>();
    for (const v of this.variants.values())
      byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
    return {
      items: [...byProduct].map(([id, variants]) => ({ id, name: `Produto ${id}`, variants })),
      hasMore: false,
    };
  }
  async getVariant(_p: string, v: string) {
    this.maybeFail('getVariant');
    return this.variants.get(v) ?? null;
  }
  async adjustStock(_p: string, v: string, delta: number) {
    const lose = this.maybeFail('adjustStock');
    const cur = this.variants.get(v)!;
    cur.stock = Math.max(0, (cur.stock ?? 0) + delta);
    this.applied.push(delta);
    if (lose === 'lose_response') throw new NuvemshopError('transient', 'timeout após aplicar');
    return cur.stock;
  }
  async replaceStock(_p: string, v: string, value: number) {
    this.maybeFail('replaceStock');
    this.variants.get(v)!.stock = value;
  }
  async listLocations() {
    return Array.from({ length: this.locations }, (_, i) => ({ id: `loc${i}`, name: `Loja ${i}` }));
  }
  async listWebhooks() {
    return this.webhooks;
  }
  async createWebhook(event: string, url: string) {
    const w = { id: String(this.webhooks.length + 1), event, url };
    this.webhooks.push(w);
    return w;
  }
}

let ctx: TestCtx;
let deps: NuvemshopDeps;
let fake: FakeNuvemshop;
let gerente: string;
let admin: string;
let vendedor: string;
let seq = 0;
const env = () =>
  loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    NUVEMSHOP_APP_ID: '9999',
    NUVEMSHOP_CLIENT_SECRET: SECRET,
    PUBLIC_API_URL: 'https://api.exemplo.test',
    WEB_URL: 'https://pdv.exemplo.test',
  });

beforeAll(async () => {
  ctx = await setup();
  gerente = ctx.tokenFor('gerente');
  admin = ctx.tokenFor('admin');
  vendedor = ctx.tokenFor('vendedor');
  fake = new FakeNuvemshop();
  deps = createNuvemshopDeps(ctx.pool, env(), { makeApi: () => fake });
});
afterAll(async () => {
  const bad = await ctx.pool.query(
    `select v.id from product_variants v left join stock_levels s on s.variant_id = v.id
     where coalesce(s.quantity, 0) <> coalesce((select sum(quantity_delta) from stock_movements m where m.variant_id = v.id), 0)`,
  );
  expect(bad.rows).toEqual([]);
  await ctx.close();
});

async function connect(status = 'ativa') {
  await ctx.pool.query('delete from integration_connections');
  await ctx.pool.query(
    `insert into integration_connections (provider, external_store_id, access_token_enc, scope, status, connected_at)
     values ('nuvemshop', $1, $2, 'read_orders read_products write_products', $3, now() - interval '1 day')`,
    [STORE, deps.cipher.encrypt('token-de-teste'), status],
  );
}
beforeEach(async () => {
  fake.calls = [];
  fake.applied = [];
  fake.locations = 1;
  fake.failures = [];
  fake.orders.clear();
  await ctx.pool.query(
    "update integration_outbox set status = 'cancelado' where status in ('pendente', 'falha', 'enviando')",
  );
  await ctx.pool.query(
    "update integration_events set status = 'ignorado' where status in ('pendente', 'falha', 'processando')",
  );
  await connect();
});

interface V {
  id: string;
  sku: string;
  priceCents: number;
}
async function newVariant(stock = 10): Promise<V> {
  const k = ++seq;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/products',
    headers: auth(gerente),
    payload: {
      name: `Produto NS ${k}`,
      idempotencyKey: `ns-prod-${k}-${Math.random()}`,
      variants: [
        { sku: `NS-${k}-${Date.now()}`, priceCents: 10000, costCents: 100, initialStock: stock },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().product.variants[0] as V;
}
const stockOf = async (v: V) =>
  Number(
    (
      await ctx.pool.query('select coalesce(quantity,0) q from stock_levels where variant_id=$1', [
        v.id,
      ])
    ).rows[0]?.q ?? 0,
  );

/** Cria variante local + remota e o vínculo (via catálogo importado, como na UI). */
async function linked(localStock = 10, remoteStock: number | null = localStock) {
  const v = await newVariant(localStock);
  const rid = `v${++seq}`;
  fake.addVariant(rid, `p${seq}`, v.sku, remoteStock);
  await importCatalog(deps);
  const actor = ctx.users.gerente.id;
  const link = await createLink(deps, actor, { variantId: v.id, externalVariantId: rid });
  return { v, rid, pid: `p${seq}`, linkId: link.id };
}

let orderSeq = 1000;
function order(
  items: Array<{ variantId: string; productId: string; quantity: number }>,
  over: Partial<RemoteOrder> = {},
): RemoteOrder {
  const id = String(++orderSeq);
  return {
    id,
    number: id,
    status: 'open',
    paymentStatus: 'pending',
    totalCents: 10000,
    paidAt: null,
    cancelledAt: null,
    cancelReason: null,
    updatedAt: new Date().toISOString(),
    items: items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
      sku: null,
      quantity: i.quantity,
    })),
    ...over,
  };
}
let evSeq = 0;
async function webhook(event: string, id: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ store_id: STORE, event, id, n: ++evSeq, ...extra });
  return ingestWebhook(deps, body, JSON.parse(body));
}
const queue = (sql: string, p: unknown[] = []) => ctx.pool.query(sql, p).then((r) => r.rows);
const issues = async (kind: string) =>
  queue("select * from integration_issues where kind = $1 and status = 'aberto'", [kind]);

describe('assinatura e ingestão de webhooks', () => {
  it('valida HMAC-SHA256 do corpo cru', () => {
    const body = '{"store_id":1,"event":"order/paid","id":5}';
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body + ' ', sig, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, 'zz', SECRET)).toBe(false);
  });

  it('rota: rejeita assinatura inválida, aceita válida e deduplica reentrega', async () => {
    const app = await buildApp({ env: env(), pool: ctx.pool, nuvemshop: { makeApi: () => fake } });
    const body = JSON.stringify({ store_id: STORE, event: 'order/created', id: '777' });
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    const send = (signature: string) =>
      app.inject({
        method: 'POST',
        url: '/integrations/nuvemshop/webhooks',
        headers: { 'content-type': 'application/json', 'x-linkedstore-hmac-sha256': signature },
        payload: body,
      });
    expect((await send('0'.repeat(64))).statusCode).toBe(401);
    const first = await send(sig);
    expect(first.statusCode).toBe(200);
    expect(first.json().result).toBe('registrado');
    expect((await send(sig)).json().result).toBe('duplicado');
    const n = await queue("select count(*)::int n from integration_events where entity_id = '777'");
    expect(n[0].n).toBe(1);
    await app.close();
  });

  it('ignora loja desconhecida e trata app/uninstalled revogando a credencial', async () => {
    const app = await buildApp({ env: env(), pool: ctx.pool, nuvemshop: { makeApi: () => fake } });
    const post = (payload: object) => {
      const body = JSON.stringify(payload);
      return app.inject({
        method: 'POST',
        url: '/integrations/nuvemshop/webhooks',
        headers: {
          'content-type': 'application/json',
          'x-linkedstore-hmac-sha256': createHmac('sha256', SECRET).update(body).digest('hex'),
        },
        payload: body,
      });
    };
    expect((await post({ store_id: 'outra', event: 'order/paid', id: '1' })).json().result).toBe(
      'loja_desconhecida',
    );
    expect((await post({ store_id: STORE, event: 'app/uninstalled' })).statusCode).toBe(200);
    const [c] = await queue('select status, access_token_enc from integration_connections');
    expect(c.status).toBe('revogada');
    expect(c.access_token_enc).toBeNull();
    // sem credencial: o worker não processa nada
    expect((await processEvents(deps)).skipped).toBe('sem_conexao_ativa');
    await app.close();
  });
});

describe('pedidos online', () => {
  it('pedido não pago não baixa; pago baixa uma vez; eventos duplicados não baixam de novo', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 2 }]);
    fake.orders.set(o.id, o);
    await webhook('order/created', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(10);

    fake.orders.set(o.id, {
      ...o,
      paymentStatus: 'paid',
      paidAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await webhook('order/paid', o.id);
    await webhook('order/paid', o.id, { retry: true });
    await processEvents(deps);
    expect(await stockOf(v)).toBe(8);
    await webhook('order/updated', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(8);
    const mv = await queue(
      "select count(*)::int n from stock_movements where variant_id = $1 and type = 'pedido_online'",
      [v.id],
    );
    expect(mv[0].n).toBe(1);
  });

  it('eventos fora de ordem convergem pelo estado atual (cancelado antes do "paid" chegar)', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }], {
      status: 'cancelled',
      paymentStatus: 'pending',
      cancelledAt: new Date().toISOString(),
    });
    fake.orders.set(o.id, o);
    await webhook('order/cancelled', o.id);
    await webhook('order/paid', o.id); // chega depois, mas o estado atual é cancelado
    await processEvents(deps);
    expect(await stockOf(v)).toBe(10);
    const it = await queue(
      'select i.stock_status from online_order_items i join online_orders o on o.id = i.order_id where o.external_order_id = $1',
      [o.id],
    );
    expect(it[0].stock_status).toBe('nao_aplicavel');
  });

  it('instantâneo mais antigo do que o aplicado é descartado', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }], {
      paymentStatus: 'paid',
      updatedAt: '2026-11-19T12:00:00Z',
    });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    fake.orders.set(o.id, { ...o, paymentStatus: 'pending', updatedAt: '2026-11-19T11:00:00Z' });
    await webhook('order/updated', o.id);
    await processEvents(deps);
    const [row] = await queue(
      'select payment_status from online_orders where external_order_id = $1',
      [o.id],
    );
    expect(row.payment_status).toBe('paid');
    expect(await stockOf(v)).toBe(9);
  });

  it('cancelamento após baixa repõe uma vez; sem baixa prévia não repõe; respeita restock_on_cancel', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 3 }], {
      paymentStatus: 'paid',
      updatedAt: new Date(Date.now() - 5000).toISOString(),
    });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(7);
    fake.orders.set(o.id, {
      ...o,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await webhook('order/cancelled', o.id);
    await webhook('order/cancelled', o.id, { again: true });
    await processEvents(deps);
    expect(await stockOf(v)).toBe(10);

    // regra comercial desligada: não repõe
    await ctx.pool.query('update integration_connections set restock_on_cancel = false');
    const o2 = order([{ variantId: rid, productId: pid, quantity: 1 }], {
      paymentStatus: 'paid',
      updatedAt: new Date(Date.now() - 5000).toISOString(),
    });
    fake.orders.set(o2.id, o2);
    await webhook('order/paid', o2.id);
    await processEvents(deps);
    fake.orders.set(o2.id, { ...o2, status: 'cancelled', updatedAt: new Date().toISOString() });
    await webhook('order/cancelled', o2.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(9);
  });

  it('pago sem estoque suficiente: pendência de atendimento, nada é cancelado nem fica negativo', async () => {
    const { v, rid, pid } = await linked(1);
    const o = order([{ variantId: rid, productId: pid, quantity: 5 }], { paymentStatus: 'paid' });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(1);
    const open = await issues('sem_estoque');
    expect(open.some((i) => i.details.orderId === o.id)).toBe(true);
    // cancelar o pedido resolve a pendência automaticamente
    fake.orders.set(o.id, {
      ...o,
      status: 'cancelled',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await webhook('order/cancelled', o.id);
    await processEvents(deps);
    expect((await issues('sem_estoque')).some((i) => i.details.orderId === o.id)).toBe(false);
  });

  it('item sem vínculo local gera pendência e não baixa nada', async () => {
    const o = order([{ variantId: 'desconhecida', productId: 'px', quantity: 1 }], {
      paymentStatus: 'paid',
    });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    expect((await issues('item_nao_mapeado')).some((i) => i.details.orderId === o.id)).toBe(true);
  });

  it('pedido online nunca cria venda física nem pagamento', async () => {
    const { rid, pid } = await linked(10);
    const before = await queue(
      'select (select count(*) from sales)::int s, (select count(*) from payments)::int p',
    );
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }], { paymentStatus: 'paid' });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    const after = await queue(
      'select (select count(*) from sales)::int s, (select count(*) from payments)::int p',
    );
    expect(after).toEqual(before);
  });

  it('reembolso após baixa abre pendência de revisão (sem estorno automático)', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }], {
      paymentStatus: 'paid',
      updatedAt: new Date(Date.now() - 5000).toISOString(),
    });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    fake.orders.set(o.id, { ...o, paymentStatus: 'refunded', updatedAt: new Date().toISOString() });
    await webhook('order/updated', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(9);
    expect((await issues('reembolso_revisar')).length).toBeGreaterThan(0);
  });

  it('eventos simultâneos do mesmo pedido baixam apenas uma vez', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 2 }], { paymentStatus: 'paid' });
    fake.orders.set(o.id, o);
    for (let i = 0; i < 6; i++) await webhook('order/paid', o.id, { i });
    await Promise.all([processEvents(deps), processEvents(deps), processEvents(deps)]);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(8);
  });

  it('baixa por pedido online não volta ao canal pelo outbox', async () => {
    const { rid, pid, linkId } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }], { paymentStatus: 'paid' });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    const out = await queue('select count(*)::int n from integration_outbox where link_id = $1', [
      linkId,
    ]);
    expect(out[0].n).toBe(0);
  });
});

describe('outbox: venda física → Nuvemshop', () => {
  async function sell(v: V, qty = 1, token = vendedor) {
    const cash = await openCashFor(token);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: auth(token),
      payload: {
        idempotencyKey: `ns-sale-${randomUUID()}`,
        cashSessionId: cash,
        items: [{ variantId: v.id, quantity: qty, unitPriceCents: v.priceCents, discountCents: 0 }],
        payments: [{ method: 'dinheiro', amountCents: v.priceCents * qty }],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  const cashCache = new Map<string, string>();
  async function openCashFor(token: string) {
    if (!cashCache.has(token)) cashCache.set(token, await openCash(ctx, token));
    return cashCache.get(token)!;
  }

  it('venda enfileira na mesma transação e envia delta; só é "enviado" após confirmação externa', async () => {
    const { v, rid, linkId } = await linked(10);
    await sell(v, 2);
    let [row] = await queue('select status, delta from integration_outbox where link_id = $1', [
      linkId,
    ]);
    expect(row).toMatchObject({ status: 'pendente', delta: -2 });
    const st = await getStatus(deps);
    expect(st.stockInSync).toBe(false);
    const stats = await sendOutbox(deps);
    expect(stats.sent).toBe(1);
    expect(fake.variants.get(rid)!.stock).toBe(8);
    [row] = await queue('select status from integration_outbox where link_id = $1', [linkId]);
    expect(row.status).toBe('enviado');
    expect((await getStatus(deps)).stockInSync).toBe(true);
  });

  it('agrega várias vendas em um único delta', async () => {
    const { v, rid } = await linked(10);
    await sell(v, 1);
    await sell(v, 2);
    await sell(v, 1);
    await sendOutbox(deps);
    expect(fake.calls.filter((c) => c === 'adjustStock').length).toBe(1);
    expect(fake.variants.get(rid)!.stock).toBe(6);
  });

  it('indisponibilidade da Nuvemshop: venda física conclui; envio é retentado com backoff e depois entrega', async () => {
    const { v, rid, linkId } = await linked(10);
    await sell(v, 1);
    expect(await stockOf(v)).toBe(9); // venda não depende do canal
    fake.fail('getVariant', new NuvemshopError('transient', 'HTTP 503', 503));
    const s1 = await sendOutbox(deps);
    expect(s1.failed).toBe(1);
    const [r1] = await queue(
      'select status, attempts, next_attempt_at > now() as later from integration_outbox where link_id = $1',
      [linkId],
    );
    expect(r1).toMatchObject({ status: 'pendente', attempts: 0, later: true });
    // ainda dentro da janela de espera: nada é enviado
    expect((await sendOutbox(deps)).sent).toBe(0);
    await ctx.pool.query(
      'update integration_outbox set next_attempt_at = now() where link_id = $1',
      [linkId],
    );
    expect((await sendOutbox(deps)).sent).toBe(1);
    expect(fake.variants.get(rid)!.stock).toBe(9);
  });

  it('resposta perdida após aplicar: o reenvio NÃO aplica o delta duas vezes', async () => {
    const { v, rid, linkId } = await linked(10);
    await sell(v, 3);
    fake.fail('adjustStock', 'lose_response');
    await sendOutbox(deps);
    expect(fake.variants.get(rid)!.stock).toBe(7);
    await ctx.pool.query(
      'update integration_outbox set next_attempt_at = now() where link_id = $1',
      [linkId],
    );
    await sendOutbox(deps);
    expect(fake.variants.get(rid)!.stock).toBe(7);
    const [row] = await queue('select status, note from integration_outbox where link_id = $1', [
      linkId,
    ]);
    expect(row.status).toBe('enviado');
    expect(row.note).toMatch(/já aplicado/);
  });

  it('edição direta na Nuvemshop é preservada: aplica delta sobre o valor atual, nunca valor absoluto', async () => {
    const { v, rid } = await linked(10);
    fake.variants.get(rid)!.stock = 25; // lojista repôs estoque no painel
    await sell(v, 2);
    await sendOutbox(deps);
    expect(fake.variants.get(rid)!.stock).toBe(23);
    expect(fake.calls).not.toContain('replaceStock');
    const [row] = await queue(
      "select note from integration_outbox where status = 'enviado' order by sent_at desc limit 1",
    );
    expect(row.note).toMatch(/remoto havia mudado/);
  });

  it('estoque remoto menor que a baixa: zera e abre pendência', async () => {
    const { v, rid } = await linked(10);
    fake.variants.get(rid)!.stock = 1;
    await sell(v, 3);
    await sendOutbox(deps);
    expect(fake.variants.get(rid)!.stock).toBe(0);
    expect((await issues('estoque_remoto_insuficiente')).length).toBeGreaterThan(0);
  });

  it('estoque ilimitado e múltiplas locations não recebem ajuste automático', async () => {
    const a = await linked(10, null);
    await sell(a.v, 1);
    await sendOutbox(deps);
    expect(fake.calls).not.toContain('adjustStock');
    const [ra] = await queue('select status from integration_outbox where link_id = $1', [
      a.linkId,
    ]);
    expect(ra.status).toBe('cancelado');

    const b = await linked(10);
    fake.variants.get(b.rid)!.locationCount = 2;
    await sell(b.v, 1);
    fake.calls = [];
    await sendOutbox(deps);
    expect(fake.calls).not.toContain('adjustStock');
    expect((await issues('multiplas_locations')).length).toBeGreaterThan(0);
  });

  it('variante removida na loja: vínculo marcado e movimento em conflito', async () => {
    const { v, rid, linkId } = await linked(10);
    fake.variants.delete(rid);
    await sell(v, 1);
    await sendOutbox(deps);
    const [l] = await queue('select status from external_variant_links where id = $1', [linkId]);
    expect(l.status).toBe('removido_remoto');
  });

  it('erro permanente → falha; reprocesso manual autorizado volta para a fila', async () => {
    const { v, linkId } = await linked(10);
    await sell(v, 1);
    fake.fail('adjustStock', new NuvemshopError('permanent', 'HTTP 422', 422));
    await sendOutbox(deps);
    const [row] = await queue('select id, status from integration_outbox where link_id = $1', [
      linkId,
    ]);
    expect(row.status).toBe('falha');
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/integrations/outbox/${row.id}/retry`,
      headers: auth(vendedor),
    });
    expect(denied.statusCode).toBe(403);
    expect(await retryOutbox(deps, row.id, ctx.users.gerente.id)).toBe(true);
    expect((await sendOutbox(deps)).sent).toBe(1);
  });

  it('401 invalida a conexão e interrompe o envio; vendas seguem normais', async () => {
    const { v, linkId } = await linked(10);
    await sell(v, 1);
    fake.fail('getVariant', new NuvemshopError('auth', 'HTTP 401', 401));
    await sendOutbox(deps);
    const [c] = await queue('select status from integration_connections');
    expect(c.status).toBe('autorizacao_invalida');
    expect((await sendOutbox(deps)).skipped).toBe('sem_conexao_ativa');
    const [row] = await queue(
      'select status, attempts from integration_outbox where link_id = $1',
      [linkId],
    );
    expect(row.status).toBe('pendente');
    expect(row.attempts).toBe(0);
    await sell(v, 1);
    expect(await stockOf(v)).toBe(8);
  });

  it('429 respeita o tempo informado sem consumir tentativa', async () => {
    const { v, linkId } = await linked(10);
    await sell(v, 1);
    fake.fail('adjustStock', new NuvemshopError('rate_limit', 'HTTP 429', 429, 5000));
    await sendOutbox(deps);
    const [row] = await queue(
      "select attempts, next_attempt_at > now() + interval '3 seconds' as waits from integration_outbox where link_id = $1",
      [linkId],
    );
    expect(row.attempts).toBe(0);
    expect(row.waits).toBe(true);
  });

  it('envios concorrentes da mesma variante não duplicam (lease por vínculo)', async () => {
    const { v, rid } = await linked(10);
    await sell(v, 4);
    await Promise.all([sendOutbox(deps), sendOutbox(deps), sendOutbox(deps)]);
    expect(fake.variants.get(rid)!.stock).toBe(6);
  });

  it('venda offline sincronizada depois também gera envio ao canal (uma vez, idempotente)', async () => {
    const { v, rid } = await linked(10);
    const cash = await openCashFor(vendedor);
    const deviceId = randomUUID();
    const signer = createGrantSigner(process.env.JWT_SECRET!);
    const g = signer.issue(
      { id: ctx.users.vendedor.id, role: 'vendedor' },
      deviceId,
      Date.now() - 60_000,
    );
    const opId = randomUUID();
    const body = {
      deviceId,
      grant: g.grant,
      operations: [
        {
          operationId: opId,
          sequence: 0,
          type: 'create_sale',
          createdAt: new Date().toISOString(),
          cashSessionId: cash,
          dependsOn: [],
          payload: {
            items: [
              { variantId: v.id, quantity: 2, unitPriceCents: v.priceCents, discountCents: 0 },
            ],
            payments: [{ method: 'dinheiro', amountCents: v.priceCents * 2 }],
          },
        },
      ],
    };
    const send = () => ctx.app.inject({ method: 'POST', url: '/sync/operations', payload: body });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200); // reenvio idempotente
    await sendOutbox(deps);
    expect(fake.variants.get(rid)!.stock).toBe(8);
    expect(await stockOf(v)).toBe(8);
  });
});

describe('reconciliação', () => {
  it('divergência exige 2 observações estáveis; aceitar remoto ajusta local sem devolver ao canal', async () => {
    const { v, rid, linkId } = await linked(10);
    fake.variants.get(rid)!.stock = 6;
    const r1 = await reconcileStock(deps);
    expect(r1.opened).toBe(0);
    expect((await issues('estoque_divergente')).length).toBe(0);
    const r2 = await reconcileStock(deps);
    expect(r2.opened).toBeGreaterThan(0);
    const [issue] = await queue(
      "select id from integration_issues where kind = 'estoque_divergente' and link_id = $1 and status = 'aberto'",
      [linkId],
    );
    await resolveIssue(deps, issue.id, 'aceitar_remoto', ctx.users.gerente.id, 'contagem física');
    expect(await stockOf(v)).toBe(6);
    const out = await queue('select count(*)::int n from integration_outbox where link_id = $1', [
      linkId,
    ]);
    expect(out[0].n).toBe(0);
    await expect(
      resolveIssue(deps, issue.id, 'ignorar', ctx.users.gerente.id),
    ).rejects.toMatchObject({ code: 'ISSUE_ALREADY_RESOLVED' });
  });

  it('com envio pendente ou pedido não baixado não abre divergência', async () => {
    const { v, rid, linkId } = await linked(10);
    const cash = await openCash(ctx, ctx.tokenFor('gerente'));
    await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: auth(gerente),
      payload: {
        idempotencyKey: `ns-${randomUUID()}`,
        cashSessionId: cash,
        items: [{ variantId: v.id, quantity: 1, unitPriceCents: v.priceCents, discountCents: 0 }],
        payments: [{ method: 'dinheiro', amountCents: v.priceCents }],
      },
    });
    const mine = async () =>
      (await issues('estoque_divergente')).filter((i) => i.link_id === linkId).length;
    await reconcileStock(deps);
    await reconcileStock(deps);
    await reconcileStock(deps);
    expect(await mine()).toBe(0);
    await sendOutbox(deps);
    expect(fake.variants.get(rid)!.stock).toBe(9);
    await reconcileStock(deps);
    await reconcileStock(deps);
    expect(await mine()).toBe(0);
  });

  it('divergência resolvida sozinha fecha a pendência; "enviar local" só com remoto inalterado', async () => {
    const { rid, v, linkId } = await linked(10);
    fake.variants.get(rid)!.stock = 7;
    await reconcileStock(deps);
    await reconcileStock(deps);
    const [issue] = await queue(
      "select id from integration_issues where kind = 'estoque_divergente' and link_id = $1 and status = 'aberto'",
      [linkId],
    );
    fake.variants.get(rid)!.stock = 8; // mudou depois da pendência
    await expect(
      resolveIssue(deps, issue.id, 'enviar_local', ctx.users.gerente.id),
    ).rejects.toMatchObject({ code: 'REMOTE_CHANGED' });
    fake.variants.get(rid)!.stock = 10;
    await reconcileStock(deps);
    expect((await issues('estoque_divergente')).filter((i) => i.link_id === linkId).length).toBe(0);
    expect(await stockOf(v)).toBe(10);
  });

  it('"enviar local" substitui o remoto por decisão humana, relendo antes', async () => {
    const { rid, linkId } = await linked(10);
    fake.variants.get(rid)!.stock = 3;
    await reconcileStock(deps);
    await reconcileStock(deps);
    const [issue] = await queue(
      "select id from integration_issues where kind = 'estoque_divergente' and link_id = $1 and status = 'aberto'",
      [linkId],
    );
    await resolveIssue(deps, issue.id, 'enviar_local', ctx.users.gerente.id);
    expect(fake.variants.get(rid)!.stock).toBe(10);
  });

  it('varredura recupera pedido cujo webhook foi perdido', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }], { paymentStatus: 'paid' });
    fake.orders.set(o.id, o);
    const s = await sweepOrders(deps);
    expect(s.ordersQueued).toBe(1);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(9);
    // segunda varredura não duplica
    await sweepOrders(deps);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(9);
  });

  it('runCycle executa eventos, outbox, varredura e reconciliação', async () => {
    await linked(5);
    const r = await runCycle(deps, { forceReconcile: true });
    expect(r.reconcile?.checked).toBeGreaterThan(0);
    const [c] = await queue('select last_reconcile_at from integration_connections');
    expect(c.last_reconcile_at).not.toBeNull();
  });
});

describe('falhas de eventos e credenciais', () => {
  it('falha temporária ao buscar pedido reagenda com backoff e depois processa', async () => {
    const { v, rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }], { paymentStatus: 'paid' });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    fake.fail('getOrder', new NuvemshopError('transient', 'HTTP 502', 502));
    const s = await processEvents(deps);
    expect(s.failed).toBe(1);
    expect(await stockOf(v)).toBe(10);
    await ctx.pool.query(
      "update integration_events set next_attempt_at = now() where status = 'falha'",
    );
    await processEvents(deps);
    expect(await stockOf(v)).toBe(9);
  });

  it('sem conexão/credencial: workers não fazem nada e vendas físicas continuam', async () => {
    await ctx.pool.query('delete from integration_connections');
    expect((await sendOutbox(deps)).skipped).toBe('sem_conexao_ativa');
    expect((await processEvents(deps)).skipped).toBe('sem_conexao_ativa');
    expect((await reconcileStock(deps)).skipped).toBe('sem_conexao_ativa');
    await expect(importCatalog(deps)).rejects.toMatchObject({ code: 'INTEGRATION_NOT_ACTIVE' });
    const st = await getStatus(deps);
    expect(st.connection).toBeNull();
  });

  it('chave de cifragem alterada marca autorização inválida em vez de falhar', async () => {
    const other = createNuvemshopDeps(ctx.pool, env(), {
      makeApi: () => fake,
      cipher: createNuvemshopDeps(
        ctx.pool,
        loadEnv({
          NODE_ENV: 'test',
          DATABASE_URL: process.env.DATABASE_URL,
          JWT_SECRET: 'outra-chave-outra-chave-outra-chave-12',
          LOG_LEVEL: 'silent',
        }),
      ).cipher,
    });
    expect((await sendOutbox(other)).skipped).toBe('sem_conexao_ativa');
    const [c] = await queue('select status from integration_connections');
    expect(c.status).toBe('autorizacao_invalida');
  });

  it('token nunca aparece no status nem é gravado em texto claro', async () => {
    const st = JSON.stringify(await getStatus(deps));
    expect(st).not.toContain('token-de-teste');
    const [c] = await queue('select access_token_enc from integration_connections');
    expect(c.access_token_enc).not.toContain('token-de-teste');
    expect(deps.cipher.decrypt(c.access_token_enc)).toBe('token-de-teste');
  });
});

describe('OAuth e adaptador HTTP', () => {
  it('state é de uso único e o token é guardado cifrado', async () => {
    await ctx.pool.query('delete from integration_connections');
    const { url } = await createInstallUrl(deps, ctx.users.admin.id);
    expect(url).toContain('/apps/9999/authorize?state=');
    const state = new URL(url).searchParams.get('state')!;
    const exchange = async () => ({
      accessToken: 'novo-token-secreto',
      scope: 'read_orders',
      storeId: STORE,
    });
    await completeAuthorization(deps, { code: 'abc', state }, exchange);
    const [c] = await queue(
      'select status, access_token_enc, external_store_id from integration_connections',
    );
    expect(c).toMatchObject({ status: 'ativa', external_store_id: STORE });
    expect(c.access_token_enc).not.toContain('novo-token-secreto');
    await expect(
      completeAuthorization(deps, { code: 'abc', state }, exchange),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      completeAuthorization(deps, { code: 'abc', state: 'x'.repeat(48) }, exchange),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('exchangeAuthorizationCode envia o contrato OAuth e mapeia erros', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const ok = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          access_token: 'tk',
          token_type: 'bearer',
          scope: 'read_orders',
          user_id: 4242,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await exchangeAuthorizationCode({
      authBase: 'https://www.nuvemshop.com.br',
      appId: '1',
      clientSecret: 'sec-sec-sec',
      code: 'c',
      userAgent: 'PDV (a@b.c)',
      fetchImpl: ok,
    });
    expect(r).toEqual({ accessToken: 'tk', scope: 'read_orders', storeId: '4242' });
    expect(seen!.url).toBe('https://www.nuvemshop.com.br/apps/authorize/token');
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({
      client_id: '1',
      grant_type: 'authorization_code',
      code: 'c',
    });
    const bad = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    await expect(
      exchangeAuthorizationCode({
        authBase: 'https://x.test',
        appId: '1',
        clientSecret: 'sec-sec-sec',
        code: 'c',
        userAgent: 'ua',
        fetchImpl: bad,
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('cliente HTTP: cabeçalhos, delta de estoque, classificação de erros e rate limit', async () => {
    const reqs: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    let next: Response = new Response('{}', { status: 200 });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      reqs.push({
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      });
      return next;
    }) as unknown as typeof fetch;
    let remaining: number | null = null;
    const api = createNuvemshopClient({
      apiBase: 'https://api.nuvemshop.com.br/2025-03',
      storeId: '42',
      accessToken: 'tok',
      userAgent: 'PDV (a@b.c)',
      fetchImpl,
      onRateLimit: (i) => {
        remaining = i.remaining;
      },
    });
    next = new Response('{}', { status: 200, headers: { 'x-rate-limit-remaining': '37' } });
    await api.adjustStock('10', '20', -3);
    expect(reqs[0]!.url).toBe('https://api.nuvemshop.com.br/2025-03/42/products/10/variants/stock');
    expect(reqs[0]!.method).toBe('POST');
    expect(JSON.parse(reqs[0]!.body!)).toEqual({ action: 'variation', value: -3, id: 20 });
    expect(reqs[0]!.headers.Authorization ?? reqs[0]!.headers.authorization).toBe(
      'bearer tok'.replace('bearer', 'Bearer'),
    );
    expect(reqs[0]!.headers['User-Agent']).toContain('PDV');
    expect(remaining).toBe(37);
    for (const [status, kind] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limit'],
      [500, 'transient'],
      [422, 'permanent'],
    ] as const) {
      next = new Response('{}', {
        status,
        headers: status === 429 ? { 'x-rate-limit-reset': '2000' } : {},
      });
      await expect(api.getOrder('1')).rejects.toMatchObject({ kind });
    }
    next = new Response('{}', { status: 404 });
    expect(await api.getOrder('1')).toBeNull();
  });

  it('backoff exponencial com teto de 1h', () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(4, mid)).toBe(240_000);
    expect(backoffMs(20, mid)).toBe(3_600_000);
  });
});

describe('API administrativa', () => {
  it('permissões: vendedor não acessa; gerente lê e gerencia; apenas admin desconecta/registra webhooks', async () => {
    const get = (token: string, url: string) =>
      ctx.app.inject({ method: 'GET', url, headers: auth(token) });
    expect((await get(vendedor, '/integrations/nuvemshop/status')).statusCode).toBe(403);
    expect((await get(gerente, '/integrations/nuvemshop/status')).statusCode).toBe(200);
    const post = (token: string, url: string) =>
      ctx.app.inject({ method: 'POST', url, headers: auth(token) });
    expect((await post(gerente, '/integrations/nuvemshop/disconnect')).statusCode).toBe(403);
    expect((await post(gerente, '/integrations/nuvemshop/webhooks/register')).statusCode).toBe(403);
    expect((await get(admin, '/integrations/issues')).statusCode).toBe(200);
    expect((await get(admin, '/integrations/orders')).statusCode).toBe(200);
    expect((await get(admin, '/integrations/events')).statusCode).toBe(200);
    expect((await get(admin, '/integrations/outbox')).statusCode).toBe(200);
    const links = await get(gerente, '/integrations/nuvemshop/links?filter=nao_vinculados');
    expect(links.statusCode).toBe(200);
  });

  it('registro de webhooks é explícito, usa a URL pública e não duplica', async () => {
    const app = await buildApp({ env: env(), pool: ctx.pool, nuvemshop: { makeApi: () => fake } });
    const token = app.signAccessToken(ctx.users.admin);
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/integrations/nuvemshop/webhooks/register',
        headers: auth(token),
      });
    const r1 = (await call()).json();
    expect(r1.created.length).toBeGreaterThan(0);
    expect(
      fake.webhooks.every(
        (w) => w.url === 'https://api.exemplo.test/integrations/nuvemshop/webhooks',
      ),
    ).toBe(true);
    const r2 = (await call()).json();
    expect(r2.created).toEqual([]);
    await app.close();
  });

  it('vínculo por IDs: bloqueia duplicidade e variante remota desconhecida; desvincular cancela envios', async () => {
    const { v, rid, linkId } = await linked(10);
    const v2 = await newVariant(5);
    await expect(
      createLink(deps, ctx.users.gerente.id, { variantId: v2.id, externalVariantId: rid }),
    ).rejects.toMatchObject({ code: 'ALREADY_LINKED' });
    await expect(
      createLink(deps, ctx.users.gerente.id, { variantId: v2.id, externalVariantId: 'nao-existe' }),
    ).rejects.toMatchObject({ code: 'REMOTE_VARIANT_UNKNOWN' });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/integrations/nuvemshop/links/${linkId}`,
      headers: auth(gerente),
    });
    expect(res.statusCode).toBe(204);
    const [l] = await queue('select status from external_variant_links where id = $1', [linkId]);
    expect(l.status).toBe('desvinculado');
    expect(await stockOf(v)).toBe(10);
  });
});

describe('revisão técnica: regressões', () => {
  const cashCache = new Map<string, string>();
  async function sell(v: V, qty = 1) {
    if (!cashCache.has(vendedor)) {
      const open = await queue(
        "select id from cash_sessions where opened_by = $1 and status = 'aberto'",
        [ctx.users.vendedor.id],
      );
      cashCache.set(vendedor, open[0]?.id ?? (await openCash(ctx, vendedor)));
    }
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: auth(vendedor),
      payload: {
        idempotencyKey: `ns-rev-${randomUUID()}`,
        cashSessionId: cashCache.get(vendedor),
        items: [{ variantId: v.id, quantity: qty, unitPriceCents: v.priceCents, discountCents: 0 }],
        payments: [{ method: 'dinheiro', amountCents: v.priceCents * qty }],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  const due = (linkId: string) =>
    ctx.pool.query(
      "update integration_outbox set next_attempt_at = now() where link_id = $1 and status = 'pendente'",
      [linkId],
    );

  it('resposta perdida + venda nova antes do retry: o delta já aplicado NÃO é reaplicado', async () => {
    const { v, rid, linkId } = await linked(10);
    await sell(v, 3);
    fake.fail('adjustStock', 'lose_response'); // a loja aplicou -3, a resposta se perdeu
    await sendOutbox(deps);
    expect(fake.variants.get(rid)!.stock).toBe(7);
    await sell(v, 1); // nova venda ANTES do retry (antes: delta somado → -4 aplicado sobre 7)
    await due(linkId);
    await sendOutbox(deps);
    await due(linkId);
    await sendOutbox(deps);
    expect(fake.applied).toEqual([-3, -1]);
    expect(fake.variants.get(rid)!.stock).toBe(6);
    expect(await stockOf(v)).toBe(6);
    const rows = await queue(
      'select status, delta from integration_outbox where link_id = $1 order by created_at',
      [linkId],
    );
    expect(rows.map((r) => r.status)).toEqual(['enviado', 'enviado']);
  });

  it('falha ANTES de aplicar (transiente): o retry reenvia o mesmo delta uma única vez', async () => {
    const { v, rid, linkId } = await linked(10);
    await sell(v, 2);
    fake.fail('adjustStock', new NuvemshopError('transient', 'HTTP 503', 503));
    await sendOutbox(deps);
    expect(fake.applied).toEqual([]);
    await due(linkId);
    await sendOutbox(deps);
    await due(linkId);
    await sendOutbox(deps);
    expect(fake.applied).toEqual([-2]);
    expect(fake.variants.get(rid)!.stock).toBe(8);
  });

  it('resposta perdida e a loja mudou nesse intervalo: resultado incerto → conflito, sem reenviar às cegas', async () => {
    const { v, rid, linkId } = await linked(10);
    await sell(v, 3);
    fake.fail('adjustStock', 'lose_response');
    await sendOutbox(deps);
    fake.variants.get(rid)!.stock = 50; // lojista repôs estoque no painel
    await due(linkId);
    await sendOutbox(deps);
    expect(fake.applied).toEqual([-3]);
    const [row] = await queue('select status, note from integration_outbox where link_id = $1', [
      linkId,
    ]);
    expect(row.status).toBe('conflito');
    expect((await issues('envio_incerto')).some((i) => i.link_id === linkId)).toBe(true);
    // a resolução humana relê o remoto e cancela o conflito
    const [issue] = await queue(
      "select id from integration_issues where kind = 'envio_incerto' and link_id = $1 and status = 'aberto'",
      [linkId],
    );
    await resolveIssue(deps, issue.id, 'aceitar_remoto', ctx.users.gerente.id);
    expect(await stockOf(v)).toBe(50);
    const [after] = await queue('select status from integration_outbox where link_id = $1', [
      linkId,
    ]);
    expect(after.status).toBe('cancelado');
  });

  it('lote em dúvida bloqueia linhas novas até ser resolvido (sem misturar deltas)', async () => {
    const { v, linkId } = await linked(10);
    await sell(v, 1);
    fake.fail('adjustStock', new NuvemshopError('transient', 'timeout', 504));
    await sendOutbox(deps);
    await sell(v, 1);
    const rows = await queue(
      'select batch_id from integration_outbox where link_id = $1 order by created_at',
      [linkId],
    );
    expect(rows[0].batch_id).not.toBeNull();
    expect(rows[1].batch_id).toBeNull();
    // ainda em espera do backoff: nada é enviado, nem a linha nova
    await sendOutbox(deps);
    expect(fake.applied).toEqual([]);
  });

  it('recusa comprovada (422) limpa o lote; reprocesso manual usa o estado atual', async () => {
    const { v, linkId } = await linked(10);
    await sell(v, 1);
    fake.fail('adjustStock', new NuvemshopError('permanent', 'HTTP 422', 422));
    await sendOutbox(deps);
    const [row] = await queue(
      'select id, status, batch_id from integration_outbox where link_id = $1',
      [linkId],
    );
    expect(row).toMatchObject({ status: 'falha', batch_id: null });
    await retryOutbox(deps, row.id, ctx.users.gerente.id);
    await sendOutbox(deps);
    expect(fake.applied).toEqual([-1]);
  });

  it('usa o estoque devolvido pela API como confirmação (ack)', async () => {
    const { v, rid, linkId } = await linked(10);
    await sell(v, 4);
    await sendOutbox(deps);
    const [l] = await queue('select remote_stock_ack from external_variant_links where id = $1', [
      linkId,
    ]);
    expect(l.remote_stock_ack).toBe(fake.variants.get(rid)!.stock);
  });

  it('webhook idêntico recebido DURANTE o processamento gera nova leitura (não é descartado)', async () => {
    const { rid, pid } = await linked(10);
    const o = order([{ variantId: rid, productId: pid, quantity: 1 }]);
    fake.orders.set(o.id, o);
    const body = JSON.stringify({ store_id: STORE, event: 'order/updated', id: o.id });
    expect(await ingestWebhook(deps, body, JSON.parse(body))).toBe('registrado');
    expect(await ingestWebhook(deps, body, JSON.parse(body))).toBe('duplicado'); // ainda pendente
    await ctx.pool.query(
      "update integration_events set status = 'processando' where entity_id = $1",
      [o.id],
    );
    expect(await ingestWebhook(deps, body, JSON.parse(body))).toBe('registrado');
  });

  it('pedido pago sem estoque NÃO é rebaixado por evento posterior; "baixar agora" baixa uma vez; "ignorar" encerra', async () => {
    const { v, rid, pid } = await linked(1);
    const o = order([{ variantId: rid, productId: pid, quantity: 3 }], { paymentStatus: 'paid' });
    fake.orders.set(o.id, o);
    await webhook('order/paid', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(1);
    // operador acerta o estoque local (ex.: aceitou o saldo da loja / entrada) e chega outro evento
    await ctx.pool.query(
      "insert into stock_movements (variant_id, type, quantity_delta, reason, idempotency_key) values ($1, 'ajuste', 20, 'acerto', $2)",
      [v.id, `nuvemshop:test:${randomUUID()}`],
    );
    await webhook('order/updated', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(21); // não baixou sozinho
    const [issue] = await queue(
      "select id from integration_issues where kind = 'sem_estoque' and status = 'aberto' and details->>'orderId' = $1",
      [o.id],
    );
    await resolveIssue(deps, issue.id, 'baixar_agora', ctx.users.gerente.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(18);
    await webhook('order/updated', o.id);
    await processEvents(deps);
    expect(await stockOf(v)).toBe(18); // uma vez só

    const o2 = order([{ variantId: rid, productId: pid, quantity: 100 }], {
      paymentStatus: 'paid',
    });
    fake.orders.set(o2.id, o2);
    await webhook('order/paid', o2.id);
    await processEvents(deps);
    const [issue2] = await queue(
      "select id from integration_issues where kind = 'sem_estoque' and status = 'aberto' and details->>'orderId' = $1",
      [o2.id],
    );
    await resolveIssue(deps, issue2.id, 'ignorar', ctx.users.gerente.id);
    const [it] = await queue(
      'select i.stock_status from online_order_items i join online_orders o on o.id = i.order_id where o.external_order_id = $1',
      [o2.id],
    );
    expect(it.stock_status).toBe('nao_aplicavel');
  });

  it('múltiplas locations na LOJA bloqueiam vínculo e envio, mesmo que a variante só liste uma', async () => {
    const a = await linked(10); // vinculada com 1 location
    fake.locations = 2;
    await sell(a.v, 1);
    await sendOutbox(deps);
    expect(fake.applied).toEqual([]);
    expect((await issues('multiplas_locations')).some((i) => i.link_id === a.linkId)).toBe(true);
    const v2 = await newVariant(5);
    fake.addVariant('multi-1', 'pm', v2.sku, 5);
    await importCatalog(deps);
    await expect(
      createLink(deps, ctx.users.gerente.id, { variantId: v2.id, externalVariantId: 'multi-1' }),
    ).rejects.toMatchObject({ code: 'MULTIPLE_LOCATIONS' });
  });

  it('resolver divergência com envio pendente é recusado (evita aplicar delta por cima)', async () => {
    const { v, rid, linkId } = await linked(10);
    fake.variants.get(rid)!.stock = 4;
    await reconcileStock(deps);
    await reconcileStock(deps);
    const [issue] = await queue(
      "select id from integration_issues where kind = 'estoque_divergente' and link_id = $1 and status = 'aberto'",
      [linkId],
    );
    await sell(v, 1); // gera linha pendente no outbox
    await expect(
      resolveIssue(deps, issue.id, 'aceitar_remoto', ctx.users.gerente.id),
    ).rejects.toMatchObject({ code: 'PENDING_OUTBOX' });
  });

  it('reconciliação não abre divergência enquanto há eventos de pedido não processados', async () => {
    const { rid, linkId } = await linked(10);
    fake.variants.get(rid)!.stock = 7; // a loja já baixou um pedido que o PDV ainda não processou
    await webhook('order/paid', '999001');
    await reconcileStock(deps);
    await reconcileStock(deps);
    await reconcileStock(deps);
    expect((await issues('estoque_divergente')).filter((i) => i.link_id === linkId).length).toBe(0);
  });
});

describe('revisão técnica: segredos e logs', () => {
  it('redactUrl remove code/state/token das URLs registradas', () => {
    expect(redactUrl('/integrations/nuvemshop/callback?code=abc123&state=zzz')).toBe(
      '/integrations/nuvemshop/callback?code=[redigido]&state=[redigido]',
    );
    expect(redactUrl('/x?q=camisa&access_token=SEGREDO')).toBe(
      '/x?q=camisa&access_token=[redigido]',
    );
    expect(redactUrl(undefined)).toBeUndefined();
  });

  it('o log do servidor não contém code/state do OAuth nem o token', async () => {
    const lines: string[] = [];
    const { Writable } = await import('node:stream');
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logEnv = { ...env(), LOG_LEVEL: 'info' as const };
    const app = await buildApp({
      env: logEnv,
      pool: ctx.pool,
      nuvemshop: { makeApi: () => fake },
      logStream: sink,
    });
    await app.inject({
      method: 'GET',
      url: '/integrations/nuvemshop/callback?code=CODIGO-SECRETO-1&state=ESTADO-SECRETO-1234567890',
    });
    await app.close();
    const log = lines.join('');
    expect(log).toContain('/integrations/nuvemshop/callback');
    expect(log).not.toContain('CODIGO-SECRETO-1');
    expect(log).not.toContain('ESTADO-SECRETO-1234567890');
  });

  it('nenhuma resposta administrativa expõe token, segredo do app ou blob cifrado', async () => {
    const [c] = await queue('select access_token_enc from integration_connections');
    const urls = [
      '/integrations/nuvemshop/status',
      '/integrations/nuvemshop/links',
      '/integrations/issues',
      '/integrations/events',
      '/integrations/outbox',
      '/integrations/orders',
    ];
    for (const url of urls) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: auth(admin) });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('token-de-teste');
      expect(res.body).not.toContain(c.access_token_enc);
      expect(res.body).not.toContain(SECRET);
    }
    const install = await ctx.app.inject({
      method: 'POST',
      url: '/integrations/nuvemshop/install-url',
      headers: auth(admin),
    });
    expect(install.body).not.toContain(SECRET);
  });

  it('erro 4xx da API não vaza o token mesmo se o corpo o ecoar', async () => {
    const fetchImpl = (async () =>
      new Response('token inválido: tok-ultra-secreto', {
        status: 422,
      })) as unknown as typeof fetch;
    const api = createNuvemshopClient({
      apiBase: 'https://x.test/2025-03',
      storeId: '1',
      accessToken: 'tok-ultra-secreto',
      userAgent: 'ua',
      fetchImpl,
    });
    await expect(api.getOrder('1')).rejects.toSatisfy(
      (e: Error) => !e.message.includes('tok-ultra-secreto'),
    );
  });

  it('adjustStock lê o estoque resultante da resposta (lista de variantes atualizadas)', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ id: 20, product_id: 10, stock: 7, inventory_levels: [{ stock: 7 }] }]),
        { status: 200 },
      )) as unknown as typeof fetch;
    const api = createNuvemshopClient({
      apiBase: 'https://x.test/2025-03',
      storeId: '1',
      accessToken: 't',
      userAgent: 'ua',
      fetchImpl,
    });
    expect(await api.adjustStock('10', '20', -3)).toBe(7);
  });

  it('assina também order/edited', async () => {
    const { SUBSCRIBED_EVENTS } = await import('../src/modules/nuvemshop/events.js');
    expect(SUBSCRIBED_EVENTS).toContain('order/edited');
  });
});
