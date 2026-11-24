import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { resetDbConnection } from './db';
import {
  enqueueSale,
  getDeviceId,
  grantIsValid,
  listOperations,
  loadCatalogMeta,
  pendingCount,
  saveCatalog,
  searchLocalVariants,
} from './store';
import { refreshCatalog, syncNow } from './sync';

const USER = 'user-1';
const CASH = '22222222-2222-4222-8222-222222222222';
const V1 = '11111111-1111-4111-8111-111111111111';
const snapshot = (stock = 5) => ({
  generatedAt: '2026-01-01T00:00:00.000Z',
  discountLimitBp: 1000,
  variants: [
    {
      id: V1,
      sku: 'CAM-P-AZ',
      barcode: '789',
      productName: 'Camiseta Básica',
      size: 'P',
      color: 'Azul',
      priceCents: 5000,
      stock,
    },
  ],
  customers: [],
});
const payload = (qty = 1) => ({
  items: [{ variantId: V1, quantity: qty, unitPriceCents: 5000, discountCents: 0 }],
  payments: [{ method: 'dinheiro' as const, amountCents: 5000 * qty }],
});
const enqueue = (id = crypto.randomUUID(), qty = 1) =>
  enqueueSale({
    operationId: id,
    userId: USER,
    grant: 'g.sig',
    cashSessionId: CASH,
    payload: payload(qty),
    label: 'x',
  });

function mockFetch(
  handler: (body: {
    operations: Array<{ operationId: string; cashSessionId?: string }>;
  }) => unknown,
) {
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    const out = handler(body);
    return new Response(JSON.stringify(out), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(async () => {
  await resetDbConnection();
  globalThis.indexedDB = new IDBFactory();
  await saveCatalog(snapshot(), USER);
});
afterEach(() => vi.unstubAllGlobals());

describe('catálogo e fila local', () => {
  it('busca por nome, SKU e código de barras, sem acento', async () => {
    expect(await searchLocalVariants('camiseta')).toHaveLength(1);
    expect(await searchLocalVariants('cam-p')).toHaveLength(1);
    expect(await searchLocalVariants('789')).toHaveLength(1);
    expect(await searchLocalVariants('básica')).toHaveLength(1);
    expect(await searchLocalVariants('basica')).toHaveLength(1);
    expect(await searchLocalVariants('calça')).toHaveLength(0);
  });

  it('enfileira com sequência monotônica, estado local e baixa de estoque local', async () => {
    const a = await enqueue();
    expect(a.cashSessionId).toBe(CASH); // caixa de origem preservado na operação
    const b = await enqueue(undefined, 2);
    expect([a.sequence, b.sequence]).toEqual([0, 1]);
    expect(a.state).toBe('local');
    expect(a.deviceId).toBe(await getDeviceId());
    expect((await searchLocalVariants('cam'))[0]!.stock).toBe(2);
    expect(await pendingCount()).toBe(2);
  });

  it('enfileirar o mesmo operationId é idempotente (não baixa estoque duas vezes)', async () => {
    const id = crypto.randomUUID();
    await enqueue(id);
    await enqueue(id);
    expect(await listOperations()).toHaveLength(1);
    expect((await searchLocalVariants('cam'))[0]!.stock).toBe(4);
  });

  it('sobrevive à reinicialização do navegador (conexão nova, mesmos dados)', async () => {
    const id = crypto.randomUUID();
    await enqueue(id);
    const device = await getDeviceId();
    await resetDbConnection(); // fecha a conexão; o IndexedDB persiste
    const ops = await listOperations();
    expect(ops.map((o) => o.operationId)).toEqual([id]);
    expect(ops[0]!.state).toBe('local');
    expect(await getDeviceId()).toBe(device);
    const next = await enqueue();
    expect(next.sequence).toBe(1);
  });
});

describe('autorização offline', () => {
  const g = (issuedAt: number, expiresAt: number) => ({
    grant: 'x',
    userId: USER,
    issuedAt,
    expiresAt,
  });
  it('só vale dentro da janela e para o mesmo usuário; nunca acima de 8 h', () => {
    const now = Date.now();
    expect(grantIsValid(g(now - 1000, now + 3600_000), USER)).toBe(true);
    expect(grantIsValid(g(now - 9 * 3600_000, now - 1000), USER)).toBe(false); // expirada
    expect(grantIsValid(g(now - 1000, now + 3600_000), 'outro')).toBe(false);
    expect(grantIsValid(g(now, now + 20 * 3600_000), USER)).toBe(false); // adulterada
    expect(grantIsValid(undefined, USER)).toBe(false);
  });
});

describe('sincronização', () => {
  it('só marca confirmada após resposta confirmando do servidor', async () => {
    const op = await enqueue();
    let during = '';
    mockFetch((body) => {
      void listOperations().then((o) => (during = o[0]!.state));
      return {
        results: body.operations.map((o) => ({
          operationId: o.operationId,
          status: 'confirmada',
          saleId: 's1',
          saleNumber: 42,
        })),
      };
    });
    const summary = await syncNow();
    expect(summary.confirmed).toBe(1);
    const [after] = await listOperations();
    expect(after!.state).toBe('confirmada');
    expect(after!.saleNumber).toBe(42);
    expect(after!.operationId).toBe(op.operationId);
    expect(during).not.toBe('confirmada');
  });

  it('o envio carrega o caixa de origem de cada venda', async () => {
    await enqueue();
    let sent: Array<{ cashSessionId?: string; operationId: string }> = [];
    mockFetch((body) => {
      sent = body.operations as typeof sent;
      return { results: [] };
    });
    await syncNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.cashSessionId).toBe(CASH);
  });

  it('falha de rede mantém a venda pendente (nunca confirmada) e reenvia depois', async () => {
    await enqueue();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    const s1 = await syncNow();
    expect(s1.networkError).toBe(true);
    const [op1] = await listOperations();
    expect(op1!.state).toBe('local');
    expect(await pendingCount()).toBe(1);

    mockFetch((body) => ({
      results: body.operations.map((o) => ({
        operationId: o.operationId,
        status: 'confirmada',
        saleId: 's',
        saleNumber: 1,
      })),
    }));
    await syncNow();
    expect((await listOperations())[0]!.state).toBe('confirmada');
    expect(await pendingCount()).toBe(0);
  });

  it('operação interrompida em "pendente" (reinício durante o envio) é reenviada', async () => {
    const op = await enqueue();
    const { updateOperation } = await import('./store');
    await updateOperation(op.operationId, { state: 'pendente' });
    const fn = mockFetch((body) => ({
      results: body.operations.map((o) => ({
        operationId: o.operationId,
        status: 'confirmada',
        saleId: 's',
        saleNumber: 7,
        duplicate: true,
      })),
    }));
    await syncNow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect((await listOperations())[0]!.state).toBe('confirmada');
  });

  it('conflito e falha recuperável refletem o servidor; falha recuperável é reenviada', async () => {
    const a = await enqueue();
    const b = await enqueue();
    mockFetch((body) => ({
      results: body.operations.map((o) =>
        o.operationId === a.operationId
          ? {
              operationId: o.operationId,
              status: 'conflito',
              error: { code: 'DISCOUNT_NOT_ALLOWED', message: 'x' },
              conflicts: [],
            }
          : {
              operationId: o.operationId,
              status: 'falha_recuperavel',
              error: { code: 'CASH_NOT_OPEN', message: 'caixa' },
            },
      ),
    }));
    await syncNow();
    const byId = Object.fromEntries((await listOperations()).map((o) => [o.operationId, o.state]));
    expect(byId[a.operationId]).toBe('conflito');
    expect(byId[b.operationId]).toBe('falha_recuperavel');
    const fn = mockFetch((body) => ({
      results: body.operations.map((o) => ({
        operationId: o.operationId,
        status: 'conflito',
        error: { code: 'DISCOUNT_NOT_ALLOWED', message: 'x' },
        resolution: 'descartada',
      })),
    }));
    await syncNow();
    expect(fn).toHaveBeenCalledTimes(1); // conflito sem resolução também consulta o desfecho
    expect((await listOperations()).find((o) => o.operationId === a.operationId)!.resolution).toBe(
      'descartada',
    );
  });

  it('chamadas simultâneas compartilham um único envio', async () => {
    await enqueue();
    const fn = mockFetch((body) => ({
      results: body.operations.map((o) => ({
        operationId: o.operationId,
        status: 'confirmada',
        saleId: 's',
        saleNumber: 1,
      })),
    }));
    await Promise.all([syncNow(), syncNow(), syncNow()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('não substitui o catálogo local enquanto há vendas não confirmadas', async () => {
    await enqueue();
    const fn = mockFetch(() => snapshot(99));
    expect(await refreshCatalog(USER)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect((await searchLocalVariants('cam'))[0]!.stock).toBe(4);
    expect((await loadCatalogMeta())?.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
