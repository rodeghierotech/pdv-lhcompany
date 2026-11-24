import { computeSaleTotals, OFFLINE_GRANT_MAX_AGE_MS } from '@pdv/shared';
import type {
  CatalogSnapshotDTO,
  CatalogVariantDTO,
  OfflineSalePayload,
  SellableVariantDTO,
  UserDTO,
} from '@pdv/shared';
import { getDb, requestPersistentStorage } from './db';

export const requestPersistent = requestPersistentStorage;
import type { LocalOperation, MetaValue } from './db';

/** Evento disparado quando a fila local muda (qualquer aba/módulo ouvindo a janela). */
export const QUEUE_EVENT = 'pdv:queue-changed';
const announce = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_EVENT));
};

type MetaOf<K extends MetaValue['key']> = Extract<MetaValue, { key: K }>['value'];

async function getMeta<K extends MetaValue['key']>(key: K): Promise<MetaOf<K> | undefined> {
  const db = await getDb();
  return (await db.get('meta', key))?.value as MetaOf<K> | undefined;
}
async function setMeta(entry: MetaValue): Promise<void> {
  const db = await getDb();
  await db.put('meta', entry);
}

// ---------------------------------------------------------------------------
// Dispositivo, sessão e autorização
// ---------------------------------------------------------------------------
export async function getDeviceId(): Promise<string> {
  const existing = await getMeta('deviceId');
  if (existing) return existing;
  const db = await getDb();
  // Transação única: duas abas não geram ids diferentes.
  const tx = db.transaction('meta', 'readwrite');
  const again = (await tx.store.get('deviceId'))?.value as string | undefined;
  const id = again ?? crypto.randomUUID();
  if (!again) await tx.store.put({ key: 'deviceId', value: id });
  await tx.done;
  return id;
}

export const saveSession = (user: UserDTO) =>
  setMeta({ key: 'session', value: { user, savedAt: Date.now() } });
export const loadSession = () => getMeta('session');

/** Caixa aberto conhecido pelo aparelho (atualizado enquanto online); base para vender offline. */
export const saveCashSession = (c: { sessionId: string; number: number; userId: string }) =>
  setMeta({ key: 'cash', value: { ...c, savedAt: Date.now() } });
export const loadCashSession = () => getMeta('cash');
export async function clearCashSession(): Promise<void> {
  await (await getDb()).delete('meta', 'cash');
}
export async function clearSession(): Promise<void> {
  const db = await getDb();
  await db.delete('meta', 'session');
  await db.delete('meta', 'grant');
  await db.delete('meta', 'cash');
}

export const saveGrant = (g: MetaOf<'grant'>) => setMeta({ key: 'grant', value: g });
export const loadGrant = () => getMeta('grant');

/** Autorização válida agora (assinatura é verificada pelo servidor; aqui só a janela de tempo). */
export function grantIsValid(
  g: MetaOf<'grant'> | undefined,
  userId: string | undefined,
  now = Date.now(),
): g is MetaOf<'grant'> {
  return (
    !!g &&
    g.userId === userId &&
    now < g.expiresAt &&
    g.expiresAt - g.issuedAt <= OFFLINE_GRANT_MAX_AGE_MS
  );
}

// ---------------------------------------------------------------------------
// Catálogo local
// ---------------------------------------------------------------------------
export async function saveCatalog(snapshot: CatalogSnapshotDTO, userId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['variants', 'customers', 'meta'], 'readwrite');
  await tx.objectStore('variants').clear();
  await tx.objectStore('customers').clear();
  for (const v of snapshot.variants) await tx.objectStore('variants').put(v);
  for (const c of snapshot.customers) await tx.objectStore('customers').put(c);
  await tx.objectStore('meta').put({
    key: 'catalog',
    value: { generatedAt: snapshot.generatedAt, discountLimitBp: snapshot.discountLimitBp, userId },
  });
  await tx.done;
}

export const loadCatalogMeta = () => getMeta('catalog');

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const toSellable = (v: CatalogVariantDTO): SellableVariantDTO => ({
  variantId: v.id,
  productId: '',
  sku: v.sku,
  barcode: v.barcode,
  productName: v.productName,
  size: v.size,
  color: v.color,
  priceCents: v.priceCents,
  stock: v.stock,
});

/** Busca por nome, SKU ou código de barras no catálogo local. */
export async function searchLocalVariants(q: string, limit = 30): Promise<SellableVariantDTO[]> {
  const needle = norm(q.trim());
  if (!needle) return [];
  const db = await getDb();
  const all = await db.getAll('variants');
  return all
    .filter((v) =>
      [v.productName, v.sku, v.barcode ?? '', v.size ?? '', v.color ?? ''].some((f) =>
        norm(f).includes(needle),
      ),
    )
    .slice(0, limit)
    .map(toSellable);
}

// ---------------------------------------------------------------------------
// Fila de operações
// ---------------------------------------------------------------------------
export interface EnqueueSaleInput {
  operationId: string;
  userId: string;
  grant: string;
  cashSessionId: string;
  payload: OfflineSalePayload;
  label: string;
}

/**
 * Grava a venda na fila e baixa o estoque LOCAL, numa única transação do IndexedDB.
 * A sequência é alocada na mesma transação (monotônica por dispositivo, sem lacunas duplicadas).
 * Reenfileirar o mesmo operationId é idempotente.
 */
export async function enqueueSale(input: EnqueueSaleInput): Promise<LocalOperation> {
  const deviceId = await getDeviceId();
  const db = await getDb();
  const tx = db.transaction(['ops', 'meta', 'variants'], 'readwrite');
  const existing = await tx.objectStore('ops').get(input.operationId);
  if (existing) {
    await tx.done;
    return existing;
  }
  const seq = ((await tx.objectStore('meta').get('sequence'))?.value as number | undefined) ?? 0;
  const totals = computeSaleTotals(input.payload.items);
  const op: LocalOperation = {
    operationId: input.operationId,
    deviceId,
    sequence: seq,
    type: 'create_sale',
    createdAt: new Date().toISOString(),
    cashSessionId: input.cashSessionId,
    dependsOn: [],
    payload: input.payload,
    grant: input.grant,
    userId: input.userId,
    state: 'local',
    attempts: 0,
    summary: {
      totalCents: totals.totalCents,
      itemCount: input.payload.items.reduce((s, i) => s + i.quantity, 0),
      label: input.label,
    },
  };
  await tx.objectStore('ops').put(op);
  await tx.objectStore('meta').put({ key: 'sequence', value: seq + 1 });
  for (const item of input.payload.items) {
    const v = await tx.objectStore('variants').get(item.variantId);
    if (v) await tx.objectStore('variants').put({ ...v, stock: v.stock - item.quantity });
  }
  await tx.done;
  announce();
  return op;
}

export async function listOperations(): Promise<LocalOperation[]> {
  const db = await getDb();
  return (await db.getAllFromIndex('ops', 'by-sequence')).reverse();
}

export async function getOperation(id: string): Promise<LocalOperation | undefined> {
  return (await getDb()).get('ops', id);
}

export async function updateOperation(
  id: string,
  patch: Partial<LocalOperation>,
): Promise<LocalOperation | undefined> {
  const db = await getDb();
  const tx = db.transaction('ops', 'readwrite');
  const cur = await tx.store.get(id);
  if (!cur) {
    await tx.done;
    return undefined;
  }
  const next = { ...cur, ...patch };
  await tx.store.put(next);
  await tx.done;
  announce();
  return next;
}

/** Operações que ainda dependem do servidor (inclui conflito sem resolução, para receber o desfecho). */
export const isOpen = (op: LocalOperation): boolean =>
  op.state !== 'confirmada' && !(op.state === 'conflito' && op.resolution === 'descartada');

export async function pendingCount(): Promise<number> {
  const ops = await listOperations();
  return ops.filter(
    (o) => o.state === 'local' || o.state === 'pendente' || o.state === 'falha_recuperavel',
  ).length;
}

/** Remove vendas confirmadas há mais de `days` dias (histórico local; o servidor é a fonte de verdade). */
export async function purgeConfirmed(days = 7): Promise<void> {
  const limit = Date.now() - days * 86_400_000;
  const db = await getDb();
  const tx = db.transaction('ops', 'readwrite');
  for (const op of await tx.store.getAll()) {
    if (
      (op.state === 'confirmada' || op.resolution === 'descartada') &&
      op.confirmedAt &&
      new Date(op.confirmedAt).getTime() < limit
    ) {
      await tx.store.delete(op.operationId);
    }
  }
  await tx.done;
}
