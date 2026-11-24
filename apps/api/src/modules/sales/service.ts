import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  computeReturnEffect,
  computeSaleTotals,
  isDiscountWithinLimit,
  lineGrossCents,
  lineTotalCents,
  MAX_SALE_SUBTOTAL_CENTS,
  returnItemAmountCents,
} from '@pdv/shared';
import type {
  Paginated,
  PaymentMethod,
  PaymentStatus,
  ReturnPreviewDTO,
  Role,
  SaleCancelInput,
  SaleCreateInput,
  SaleDTO,
  SaleListItemDTO,
  SaleListQuery,
  SaleReturnInput,
  SaleReturnPreviewInput,
  SaleStatus,
  SyncConflictDTO,
} from '@pdv/shared';
import { lockKey, many, maybeOne, one, withTransaction } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { AppError, errors, PG, pgErrorCode } from '../../shared/errors.js';
import { escapeLike } from '../../shared/validate.js';
import { recordAudit } from '../audit/service.js';
import { customerDebt } from '../customers/service.js';
import { requireOpenSession } from '../cash/service.js';
import { getDiscountLimit } from '../settings/service.js';

export interface SaleActor {
  id: string;
  role: Role;
}

export interface SaleResult {
  sale: SaleDTO;
  /** false quando a mesma chave de idempotência já havia sido processada. */
  created: boolean;
}

const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
interface SaleRow {
  id: string;
  number: string; // bigint
  created_at: Date;
  status: SaleStatus;
  payment_status: PaymentStatus | null;
  customer_id: string | null;
  customer_name: string | null;
  seller_name: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  received_cents: number;
  returned_cents: number;
  balance_cents: number;
  note: string | null;
  due_date: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

const SALE_SELECT = `
  select s.id, s.number::text as number, s.created_at, s.status, ss.payment_status,
         s.customer_id, c.name as customer_name, u.name as seller_name,
         s.subtotal_cents, s.discount_cents, s.total_cents,
         ss.received_cents, ss.returned_cents, ss.balance_cents,
         s.note, to_char(s.due_date, 'YYYY-MM-DD') as due_date, s.cancelled_at, s.cancel_reason
  from sales s
  join sale_summary ss on ss.sale_id = s.id
  join users u on u.id = s.seller_id
  left join customers c on c.id = s.customer_id`;

const listItem = (r: SaleRow): SaleListItemDTO => ({
  id: r.id,
  number: Number(r.number),
  createdAt: r.created_at.toISOString(),
  status: r.status,
  paymentStatus: r.payment_status,
  customerName: r.customer_name,
  sellerName: r.seller_name,
  totalCents: r.total_cents,
  balanceCents: r.balance_cents,
});

export async function getSale(db: Db, id: string): Promise<SaleDTO> {
  const row = await maybeOne<SaleRow>(db, `${SALE_SELECT} where s.id = $1`, [id]);
  if (!row) throw errors.notFound('Venda');

  const items = await many<{
    id: string;
    variant_id: string;
    sku: string;
    product_name: string;
    size: string | null;
    color: string | null;
    quantity: number;
    unit_price_cents: number;
    discount_cents: number;
    line_total_cents: number;
    returned_quantity: number;
  }>(
    db,
    `select i.id, i.variant_id, i.sku, i.product_name, i.size, i.color, i.quantity,
            i.unit_price_cents, i.discount_cents, i.line_total_cents,
            coalesce((select sum(ri.quantity) from sale_return_items ri where ri.sale_item_id = i.id), 0)::int
              as returned_quantity
     from sale_items i where i.sale_id = $1 order by i.position`,
    [id],
  );

  const payments = await many<{
    id: string;
    kind: 'recebimento' | 'estorno';
    method: PaymentMethod;
    amount_cents: number;
    created_at: Date;
    receipt_id: string | null;
    receipt_number: string | null;
    reverses_payment_id: string | null;
    reversed: boolean;
  }>(
    db,
    `select pm.id, pm.kind, pm.method, pm.amount_cents, pm.created_at, pm.receipt_id,
            rc.number::text as receipt_number, pm.reverses_payment_id,
            exists (select 1 from payments r where r.reverses_payment_id = pm.id) as reversed
     from payments pm left join debt_receipts rc on rc.id = pm.receipt_id
     where pm.sale_id = $1 order by pm.created_at, pm.id`,
    [id],
  );

  const returns = await many<{
    id: string;
    reason: string;
    created_at: Date;
    created_by_name: string | null;
  }>(
    db,
    `select r.id, r.reason, r.created_at, u.name as created_by_name
     from sale_returns r left join users u on u.id = r.created_by
     where r.sale_id = $1 order by r.created_at, r.id`,
    [id],
  );
  const returnItems = returns.length
    ? await many<{
        return_id: string;
        sale_item_id: string;
        quantity: number;
        amount_cents: number;
      }>(
        db,
        `select return_id, sale_item_id, quantity, amount_cents
         from sale_return_items where return_id = any($1::uuid[])`,
        [returns.map((r) => r.id)],
      )
    : [];

  return {
    ...listItem(row),
    customerId: row.customer_id,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    receivedCents: row.received_cents,
    returnedCents: row.returned_cents,
    note: row.note,
    dueDate: row.due_date,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    items: items.map((i) => ({
      id: i.id,
      variantId: i.variant_id,
      sku: i.sku,
      productName: i.product_name,
      size: i.size,
      color: i.color,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      discountCents: i.discount_cents,
      lineTotalCents: i.line_total_cents,
      returnedQuantity: i.returned_quantity,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      kind: p.kind,
      method: p.method,
      amountCents: p.amount_cents,
      createdAt: p.created_at.toISOString(),
      receiptId: p.receipt_id,
      receiptNumber: p.receipt_number === null ? null : Number(p.receipt_number),
      reversesPaymentId: p.reverses_payment_id,
      reversed: p.reversed,
    })),
    returns: returns.map((r) => {
      const its = returnItems
        .filter((ri) => ri.return_id === r.id)
        .map((ri) => ({
          saleItemId: ri.sale_item_id,
          quantity: ri.quantity,
          amountCents: ri.amount_cents,
        }));
      return {
        id: r.id,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
        createdByName: r.created_by_name,
        valueCents: its.reduce((sum, i) => sum + i.amountCents, 0),
        items: its,
      };
    }),
  };
}

export async function listSales(
  pool: pg.Pool,
  query: SaleListQuery,
): Promise<Paginated<SaleListItemDTO>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.status) where.push(`s.status = ${add(query.status)}`);
  if (query.paymentStatus) where.push(`ss.payment_status = ${add(query.paymentStatus)}`);
  if (query.customerId) where.push(`s.customer_id = ${add(query.customerId)}`);
  if (query.q) {
    const like = add(`%${escapeLike(query.q)}%`);
    const asNumber = /^\d{1,15}$/.test(query.q) ? add(query.q) : null;
    where.push(
      asNumber
        ? `(s.number = ${asNumber}::bigint or c.name ilike ${like})`
        : `c.name ilike ${like}`,
    );
  }
  // Datas interpretadas no fuso da loja.
  if (query.from) {
    where.push(
      `s.created_at >= (${add(query.from)}::date)::timestamp at time zone 'America/Sao_Paulo'`,
    );
  }
  if (query.to) {
    where.push(
      `s.created_at < (${add(query.to)}::date + 1)::timestamp at time zone 'America/Sao_Paulo'`,
    );
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  const total = Number(
    (
      await one<{ count: string }>(
        pool,
        `select count(*) from sales s
         join sale_summary ss on ss.sale_id = s.id
         left join customers c on c.id = s.customer_id ${whereSql}`,
        params,
      )
    ).count,
  );
  const limit = add(query.pageSize);
  const offset = add((query.page - 1) * query.pageSize);
  const rows = await many<SaleRow>(
    pool,
    `${SALE_SELECT} ${whereSql} order by s.created_at desc, s.number desc limit ${limit} offset ${offset}`,
    params,
  );
  return { items: rows.map(listItem), page: query.page, pageSize: query.pageSize, total };
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------
export function translateSaleError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const code = pgErrorCode(err);
  const message = err instanceof Error ? err.message : '';
  if (code === PG.checkViolation && /cash_integrity/.test(message)) {
    throw errors.conflict(
      'CASH_INTEGRITY',
      'Operação recusada: caixa fechado ou de outro operador',
    );
  }
  // Última barreira: o banco recusou o COMMIT por violar uma invariante financeira/de estoque.
  if (
    code === PG.checkViolation &&
    /sale_integrity|receipt_integrity|estorno .* inválido/.test(message)
  ) {
    throw errors.conflict(
      'INTEGRITY_VIOLATION',
      'A operação violaria a integridade financeira ou de estoque e foi recusada',
    );
  }
  if (code === PG.uniqueViolation) {
    throw errors.conflict('DUPLICATE_OPERATION', 'Operação já registrada com esta chave');
  }
  if (code === PG.foreignKeyViolation) {
    throw errors.validation('Referência inexistente (cliente ou produto)');
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Criação de venda
// ---------------------------------------------------------------------------
interface LockedVariant {
  id: string;
  sku: string;
  size: string | null;
  color: string | null;
  price_cents: number;
  cost_cents: number;
  active: boolean;
  product_name: string;
  product_active: boolean;
  stock: number;
}

/** Modo offline: a venda física já aconteceu; o servidor registra e sinaliza divergências. */
export interface OfflineSaleOptions {
  /** Momento real da venda (já limitado pelo serviço de sync). */
  occurredAt: Date;
  syncOperationId: string;
  /** Aprovada por gerente/admin: ignora limite de desconto e de crédito. */
  approved?: boolean;
  /**
   * Caixa da venda. `sessionId` é onde ela será registrada; `originSessionId` é o caixa em que
   * foi realizada. Diferem apenas na regularização de caixa já fechado.
   */
  cashSession: { sessionId: string; originSessionId: string };
  /** Saída: divergências informativas detectadas. */
  conflicts: SyncConflictDTO[];
}

export async function createSale(
  pool: pg.Pool,
  input: SaleCreateInput,
  actor: SaleActor,
): Promise<SaleResult> {
  try {
    return await withTransaction(pool, (tx) => createSaleTx(tx, input, actor));
  } catch (err) {
    return translateSaleError(err);
  }
}

/** Corpo da venda dentro de uma transação já aberta (reutilizado pela sincronização offline). */
export async function createSaleTx(
  tx: pg.PoolClient,
  input: SaleCreateInput,
  actor: SaleActor,
  offline?: OfflineSaleOptions,
): Promise<SaleResult> {
  const hash = hashOf({
    customerId: input.customerId ?? null,
    note: input.note ?? null,
    dueDate: input.dueDate ?? null,
    items: [...input.items].sort((a, b) => a.variantId.localeCompare(b.variantId)),
    payments: [...input.payments].sort(
      (a, b) => a.method.localeCompare(b.method) || a.amountCents - b.amountCents,
    ),
  });

  {
    {
      // 1. Idempotência: serializa a mesma chave; reenvio idêntico devolve a venda já criada.
      await lockKey(tx, `sale-create:${input.idempotencyKey}`);
      const existing = await maybeOne<{ id: string; request_hash: string }>(
        tx,
        'select id, request_hash from sales where idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing) {
        if (existing.request_hash !== hash) {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { sale: await getSale(tx, existing.id), created: false };
      }

      // 1b. Toda venda acontece dentro de um caixa aberto do operador.
      const sessionId = offline?.cashSession.sessionId ?? (await requireOpenSession(tx, actor.id));

      // 2. Trava os saldos de estoque em ordem determinística (evita deadlock entre vendas).
      const variantIds = input.items.map((i) => i.variantId);
      const locked = await many<LockedVariant>(
        tx,
        `select v.id, v.sku, v.size, v.color, v.price_cents, v.cost_cents, v.active,
                p.name as product_name, p.active as product_active, s.quantity as stock
         from product_variants v
         join products p on p.id = v.product_id
         join stock_levels s on s.variant_id = v.id
         where v.id = any($1::uuid[])
         order by v.id
         for update of s`,
        [variantIds],
      );
      const byId = new Map(locked.map((v) => [v.id, v]));
      const missing = variantIds.filter((id) => !byId.has(id));
      if (missing.length) {
        throw errors.unprocessable('VARIANT_NOT_FOUND', 'Produto não encontrado no catálogo');
      }

      const inactive: { variantId: string; sku: string }[] = [];
      const priceChanged: { variantId: string; sku: string; currentPriceCents: number }[] = [];
      const short: { variantId: string; sku: string; requested: number; available: number }[] = [];
      for (const item of input.items) {
        const v = byId.get(item.variantId)!;
        if (offline) {
          // A venda física prevalece: registra e sinaliza, sem recusar.
          if (!v.active || !v.product_active) inactive.push({ variantId: v.id, sku: v.sku });
          if (v.price_cents !== item.unitPriceCents) {
            priceChanged.push({ variantId: v.id, sku: v.sku, currentPriceCents: v.price_cents });
          }
          if (v.stock < item.quantity) {
            short.push({
              variantId: v.id,
              sku: v.sku,
              requested: item.quantity,
              available: v.stock,
            });
          }
        } else if (!v.active || !v.product_active) inactive.push({ variantId: v.id, sku: v.sku });
        else if (v.price_cents !== item.unitPriceCents) {
          priceChanged.push({ variantId: v.id, sku: v.sku, currentPriceCents: v.price_cents });
        } else if (v.stock < item.quantity) {
          short.push({ variantId: v.id, sku: v.sku, requested: item.quantity, available: v.stock });
        }
      }
      if (offline) {
        if (inactive.length) {
          offline.conflicts.push({
            code: 'VARIANT_INACTIVE',
            blocking: false,
            message: 'Venda offline de produto que está inativo no servidor',
            details: { items: inactive },
          });
        }
        if (priceChanged.length) {
          offline.conflicts.push({
            code: 'PRICE_DIVERGED',
            blocking: false,
            message: 'Preço vendido difere do preço atual do servidor; foi mantido o preço cobrado',
            details: { items: priceChanged },
          });
        }
        if (short.length) {
          offline.conflicts.push({
            code: 'STOCK_NEGATIVE',
            blocking: false,
            message:
              'Estoque do servidor insuficiente; a venda física foi aplicada e o saldo ficou negativo',
            details: { items: short },
          });
        }
      } else {
        if (inactive.length) {
          throw new AppError('VARIANT_INACTIVE', 409, 'Há produto inativo no carrinho', inactive);
        }
        if (priceChanged.length) {
          throw new AppError(
            'PRICE_CHANGED',
            409,
            'O preço de um item mudou. Atualize o carrinho.',
            priceChanged,
          );
        }
        if (short.length) {
          throw new AppError('INSUFFICIENT_STOCK', 422, 'Estoque insuficiente', short);
        }
      }

      // 3. Valores (recalculados no servidor; o cliente nunca dita totais).
      for (const item of input.items) {
        const gross = lineGrossCents(item);
        if (gross > MAX_SALE_SUBTOTAL_CENTS) {
          throw errors.unprocessable('SALE_TOO_LARGE', 'Valor da venda acima do limite permitido');
        }
        if (item.discountCents > gross) {
          throw errors.unprocessable('INVALID_DISCOUNT', 'Desconto maior que o valor do item');
        }
      }
      const totals = computeSaleTotals(input.items);
      if (totals.subtotalCents > MAX_SALE_SUBTOTAL_CENTS) {
        throw errors.unprocessable('SALE_TOO_LARGE', 'Valor da venda acima do limite permitido');
      }

      // 4. Autorização de desconto pelo limite configurado para o papel.
      if (totals.discountCents > 0 && !offline?.approved) {
        const limit = await getDiscountLimit(tx, actor.role);
        if (limit === 0) {
          throw new AppError('DISCOUNT_NOT_ALLOWED', 403, 'Seu perfil não pode conceder desconto');
        }
        if (!isDiscountWithinLimit(totals.discountCents, totals.subtotalCents, limit)) {
          throw new AppError(
            'DISCOUNT_LIMIT_EXCEEDED',
            403,
            `Desconto acima do limite de ${limit / 100}% do seu perfil`,
            { maxDiscountBp: limit },
          );
        }
      }

      // 5. Pagamentos: não pode pagar a mais; saldo restante vira débito do cliente.
      const paidCents = input.payments.reduce((sum, p) => sum + p.amountCents, 0);
      if (paidCents > totals.totalCents) {
        throw new AppError('OVERPAYMENT', 422, 'Pagamentos somam mais que o total da venda', {
          totalCents: totals.totalCents,
          paidCents,
        });
      }
      const balanceCents = totals.totalCents - paidCents;
      if (input.dueDate) {
        if (balanceCents === 0) {
          throw errors.unprocessable(
            'DUE_DATE_WITHOUT_BALANCE',
            'Vencimento só vale para venda com saldo a receber',
          );
        }
        const ok = await one<{ ok: boolean }>(
          tx,
          `select $1::date >= (now() at time zone 'America/Sao_Paulo')::date as ok`,
          [input.dueDate],
        );
        if (!ok.ok && !offline)
          throw errors.unprocessable('DUE_DATE_IN_PAST', 'O vencimento não pode estar no passado');
      }

      if (input.customerId) {
        const customer = await maybeOne<{ active: boolean; credit_limit_cents: number | null }>(
          tx,
          'select active, credit_limit_cents from customers where id = $1 for update',
          [input.customerId],
        );
        if (!customer) throw errors.unprocessable('CUSTOMER_NOT_FOUND', 'Cliente não encontrado');
        if (!customer.active) throw errors.conflict('CUSTOMER_INACTIVE', 'Cliente inativo');
        if (balanceCents > 0 && customer.credit_limit_cents !== null && !offline?.approved) {
          const debt = await customerDebt(tx, input.customerId);
          if (debt + balanceCents > customer.credit_limit_cents) {
            throw new AppError(
              'CREDIT_LIMIT_EXCEEDED',
              422,
              'Limite de crédito do cliente excedido',
              {
                creditLimitCents: customer.credit_limit_cents,
                currentDebtCents: debt,
                requestedCents: balanceCents,
                availableCents: Math.max(customer.credit_limit_cents - debt, 0),
              },
            );
          }
        }
      } else if (balanceCents > 0) {
        throw errors.unprocessable(
          'CUSTOMER_REQUIRED',
          'Informe o cliente para vender fiado ou com pagamento parcial',
        );
      }

      const regularized =
        !!offline && offline.cashSession.sessionId !== offline.cashSession.originSessionId;
      // 6. Grava venda, itens, baixa de estoque e pagamentos na mesma transação.
      const sale = await one<{ id: string; number: string }>(
        tx,
        `insert into sales (customer_id, seller_id, subtotal_cents, discount_cents, total_cents,
                            note, idempotency_key, request_hash, cash_session_id, due_date,
                            created_at, origin, sync_operation_id, origin_cash_session_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now()), $12, $13, $14)
         returning id, number::text as number`,
        [
          input.customerId ?? null,
          actor.id,
          totals.subtotalCents,
          totals.discountCents,
          totals.totalCents,
          input.note ?? null,
          input.idempotencyKey,
          hash,
          sessionId,
          input.dueDate ?? null,
          offline?.occurredAt ?? null,
          offline ? 'offline' : 'online',
          offline?.syncOperationId ?? null,
          offline?.cashSession.originSessionId ?? sessionId,
        ],
      );

      for (const [position, item] of input.items.entries()) {
        const v = byId.get(item.variantId)!;
        const row = await one<{ id: string }>(
          tx,
          `insert into sale_items
             (sale_id, variant_id, position, sku, product_name, size, color, quantity,
              unit_price_cents, unit_cost_cents, discount_cents, line_total_cents)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [
            sale.id,
            v.id,
            position,
            v.sku,
            v.product_name,
            v.size,
            v.color,
            item.quantity,
            item.unitPriceCents,
            v.cost_cents,
            item.discountCents,
            lineTotalCents(item),
          ],
        );
        await tx.query(
          `insert into stock_movements
             (variant_id, type, quantity_delta, reason, idempotency_key, actor_id, sale_item_id, created_at)
           values ($1, 'venda', $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))`,
          [
            v.id,
            -item.quantity,
            `Venda #${sale.number}`,
            `sale-item:${row.id}`,
            actor.id,
            row.id,
            offline?.occurredAt ?? null,
          ],
        );
      }

      for (const payment of input.payments) {
        await tx.query(
          `insert into payments (sale_id, kind, method, amount_cents, created_by, cash_session_id, created_at,
                                 regularization, origin_cash_session_id)
           values ($1, 'recebimento', $2, $3, $4, $5, coalesce($6::timestamptz, clock_timestamp()), $7, $8)`,
          [
            sale.id,
            payment.method,
            payment.amountCents,
            actor.id,
            sessionId,
            offline?.occurredAt ?? null,
            regularized,
            regularized ? offline!.cashSession.originSessionId : null,
          ],
        );
      }

      await recordAudit(tx, {
        actorId: actor.id,
        action: 'sale.create',
        entity: 'sale',
        entityId: sale.id,
        payload: {
          number: Number(sale.number),
          totalCents: totals.totalCents,
          discountCents: totals.discountCents,
          paidCents,
          balanceCents,
          customerId: input.customerId ?? null,
          origin: offline ? 'offline' : 'online',
        },
      });

      return { sale: await getSale(tx, sale.id), created: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Cancelamento (venda inteira)
// ---------------------------------------------------------------------------
export async function cancelSale(
  pool: pg.Pool,
  saleId: string,
  input: SaleCancelInput,
  actor: SaleActor,
): Promise<SaleResult> {
  try {
    return await withTransaction(pool, async (tx) => {
      const sale = await maybeOne<{
        number: string;
        status: SaleStatus;
        cancel_key: string | null;
      }>(
        tx,
        'select number::text as number, status, cancel_key from sales where id = $1 for update',
        [saleId],
      );
      if (!sale) throw errors.notFound('Venda');

      if (sale.status === 'cancelada') {
        if (sale.cancel_key === input.idempotencyKey) {
          return { sale: await getSale(tx, saleId), created: false };
        }
        throw errors.conflict('ALREADY_CANCELLED', 'Esta venda já foi cancelada');
      }
      if (sale.status === 'devolvida') {
        throw errors.conflict('SALE_RETURNED', 'Venda totalmente devolvida não pode ser cancelada');
      }
      const hasReturns = await maybeOne(
        tx,
        'select 1 from sale_returns where sale_id = $1 limit 1',
        [saleId],
      );
      if (hasReturns) {
        throw errors.conflict(
          'HAS_RETURNS',
          'Venda com devolução parcial não pode ser cancelada; devolva os itens restantes',
        );
      }

      // O dinheiro devolvido sai do caixa de quem cancela, no momento do cancelamento.
      const sessionId = await requireOpenSession(tx, actor.id);
      await tx.query(
        `update sales set status = 'cancelada', cancelled_at = now(), cancelled_by = $2,
                          cancel_reason = $3, cancel_key = $4, cancel_session_id = $5
         where id = $1`,
        [saleId, actor.id, input.reason, input.idempotencyKey, sessionId],
      );

      // Estorna cada recebimento (mesma forma e valor) — dinheiro volta ao cliente.
      const received = await many<{ id: string; method: PaymentMethod; amount_cents: number }>(
        tx,
        `select id, method, amount_cents from payments
         where sale_id = $1 and kind = 'recebimento'
           and not exists (select 1 from payments r where r.reverses_payment_id = payments.id)
         order by created_at, id`,
        [saleId],
      );
      for (const p of received) {
        await tx.query(
          `insert into payments
             (sale_id, kind, method, amount_cents, reverses_payment_id, created_by, cash_session_id)
           values ($1, 'estorno', $2, $3, $4, $5, $6)`,
          [saleId, p.method, p.amount_cents, p.id, actor.id, sessionId],
        );
      }

      // Devolve o estoque com movimentações compensatórias (nunca apaga a baixa original).
      const movements = await many<{ id: string; variant_id: string; quantity_delta: number }>(
        tx,
        `select m.id, m.variant_id, m.quantity_delta
         from stock_movements m join sale_items i on i.id = m.sale_item_id
         where i.sale_id = $1 and m.type = 'venda'
         order by m.variant_id`,
        [saleId],
      );
      for (const m of movements) {
        await tx.query(
          `insert into stock_movements
             (variant_id, type, quantity_delta, reason, reverses_movement_id, idempotency_key, actor_id)
           values ($1, 'estorno', $2, $3, $4, $5, $6)`,
          [
            m.variant_id,
            -m.quantity_delta,
            `Cancelamento da venda #${sale.number}`,
            m.id,
            `sale-cancel:${m.id}`,
            actor.id,
          ],
        );
      }

      await recordAudit(tx, {
        actorId: actor.id,
        action: 'sale.cancel',
        entity: 'sale',
        entityId: saleId,
        payload: { number: Number(sale.number), reason: input.reason },
      });
      return { sale: await getSale(tx, saleId), created: true };
    });
  } catch (err) {
    return translateSaleError(err);
  }
}

// ---------------------------------------------------------------------------
// Devoluções (parciais ou totais)
// ---------------------------------------------------------------------------
interface ReturnLine {
  saleItemId: string;
  variantId: string;
  quantity: number;
  amountCents: number;
}

async function planReturn(
  tx: pg.PoolClient,
  saleId: string,
  requested: { saleItemId: string; quantity: number }[],
): Promise<{ lines: ReturnLine[]; effect: ReturnPreviewDTO }> {
  const items = await many<{
    id: string;
    variant_id: string;
    quantity: number;
    line_total_cents: number;
    returned: number;
  }>(
    tx,
    `select i.id, i.variant_id, i.quantity, i.line_total_cents,
            coalesce((select sum(ri.quantity) from sale_return_items ri where ri.sale_item_id = i.id), 0)::int
              as returned
     from sale_items i where i.sale_id = $1`,
    [saleId],
  );
  const byId = new Map(items.map((i) => [i.id, i]));

  const lines: ReturnLine[] = [];
  for (const req of requested) {
    const item = byId.get(req.saleItemId);
    if (!item) throw errors.unprocessable('ITEM_NOT_IN_SALE', 'Item não pertence a esta venda');
    const remaining = item.quantity - item.returned;
    if (req.quantity > remaining) {
      throw new AppError(
        'RETURN_EXCEEDS_SOLD',
        422,
        'Quantidade devolvida maior que a disponível',
        {
          saleItemId: item.id,
          remaining,
        },
      );
    }
    lines.push({
      saleItemId: item.id,
      variantId: item.variant_id,
      quantity: req.quantity,
      amountCents: returnItemAmountCents(
        item.line_total_cents,
        item.quantity,
        item.returned,
        req.quantity,
      ),
    });
  }

  const summary = await one<{
    total_cents: number;
    returned_cents: number;
    received_cents: number;
  }>(
    tx,
    'select total_cents, returned_cents, received_cents from sale_summary where sale_id = $1',
    [saleId],
  );
  const valueCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const effect = computeReturnEffect({
    totalCents: summary.total_cents,
    returnedBeforeCents: summary.returned_cents,
    receivedCents: summary.received_cents,
    valueCents,
  });
  return { lines, effect };
}

function assertReturnable(status: SaleStatus): void {
  if (status === 'cancelada')
    throw errors.conflict('SALE_CANCELLED', 'Venda cancelada não aceita devolução');
  if (status === 'devolvida')
    throw errors.conflict('SALE_RETURNED', 'Venda já totalmente devolvida');
}

export async function previewReturn(
  pool: pg.Pool,
  saleId: string,
  input: SaleReturnPreviewInput,
): Promise<ReturnPreviewDTO> {
  return withTransaction(pool, async (tx) => {
    const sale = await maybeOne<{ status: SaleStatus }>(
      tx,
      'select status from sales where id = $1',
      [saleId],
    );
    if (!sale) throw errors.notFound('Venda');
    assertReturnable(sale.status);
    return (await planReturn(tx, saleId, input.items)).effect;
  });
}

export async function createReturn(
  pool: pg.Pool,
  saleId: string,
  input: SaleReturnInput,
  actor: SaleActor,
): Promise<SaleResult> {
  const hash = hashOf({
    saleId,
    reason: input.reason,
    items: [...input.items].sort((a, b) => a.saleItemId.localeCompare(b.saleItemId)),
    refunds: [...input.refunds].sort(
      (a, b) => a.method.localeCompare(b.method) || a.amountCents - b.amountCents,
    ),
  });
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `sale-return:${input.idempotencyKey}`);
      const existing = await maybeOne<{ sale_id: string; request_hash: string }>(
        tx,
        'select sale_id, request_hash from sale_returns where idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing) {
        if (existing.sale_id !== saleId || existing.request_hash !== hash) {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { sale: await getSale(tx, saleId), created: false };
      }

      // Serializa operações na mesma venda (devoluções, cancelamento).
      const sale = await maybeOne<{ number: string; status: SaleStatus }>(
        tx,
        'select number::text as number, status from sales where id = $1 for update',
        [saleId],
      );
      if (!sale) throw errors.notFound('Venda');
      assertReturnable(sale.status);

      const sessionId = await requireOpenSession(tx, actor.id);
      const { lines, effect } = await planReturn(tx, saleId, input.items);
      const refundsCents = input.refunds.reduce((sum, r) => sum + r.amountCents, 0);
      if (refundsCents !== effect.refundDueCents) {
        throw new AppError(
          'REFUND_MISMATCH',
          422,
          'O reembolso informado não confere com o valor a devolver',
          { expectedRefundCents: effect.refundDueCents, informedRefundCents: refundsCents },
        );
      }

      const ret = await one<{ id: string }>(
        tx,
        `insert into sale_returns (sale_id, reason, idempotency_key, request_hash, created_by, cash_session_id)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [saleId, input.reason, input.idempotencyKey, hash, actor.id, sessionId],
      );
      for (const line of lines) {
        const row = await one<{ id: string }>(
          tx,
          `insert into sale_return_items (return_id, sale_item_id, quantity, amount_cents)
           values ($1, $2, $3, $4) returning id`,
          [ret.id, line.saleItemId, line.quantity, line.amountCents],
        );
        await tx.query(
          `insert into stock_movements
             (variant_id, type, quantity_delta, reason, idempotency_key, actor_id, sale_return_item_id)
           values ($1, 'devolucao', $2, $3, $4, $5, $6)`,
          [
            line.variantId,
            line.quantity,
            `Devolução da venda #${sale.number}`,
            `return-item:${row.id}`,
            actor.id,
            row.id,
          ],
        );
      }
      for (const refund of input.refunds) {
        await tx.query(
          `insert into payments (sale_id, kind, method, amount_cents, return_id, created_by, cash_session_id)
           values ($1, 'estorno', $2, $3, $4, $5, $6)`,
          [saleId, refund.method, refund.amountCents, ret.id, actor.id, sessionId],
        );
      }

      // Tudo devolvido => venda passa a "devolvida" (estado terminal).
      const pending = await maybeOne(
        tx,
        `select 1 from sale_items i
         where i.sale_id = $1
           and i.quantity > coalesce((select sum(ri.quantity) from sale_return_items ri
                                      where ri.sale_item_id = i.id), 0)
         limit 1`,
        [saleId],
      );
      if (!pending) await tx.query("update sales set status = 'devolvida' where id = $1", [saleId]);

      await recordAudit(tx, {
        actorId: actor.id,
        action: 'sale.return',
        entity: 'sale',
        entityId: saleId,
        payload: {
          number: Number(sale.number),
          valueCents: effect.valueCents,
          refundCents: refundsCents,
          debtReductionCents: effect.debtReductionCents,
          reason: input.reason,
        },
      });
      return { sale: await getSale(tx, saleId), created: true };
    });
  } catch (err) {
    return translateSaleError(err);
  }
}

// ---------------------------------------------------------------------------
// Vencimento do fiado (opcional; nunca bloqueia vendas automaticamente)
// ---------------------------------------------------------------------------
export async function updateSaleDueDate(
  pool: pg.Pool,
  saleId: string,
  dueDate: string | null,
  actor: SaleActor,
): Promise<SaleDTO> {
  try {
    return await withTransaction(pool, async (tx) => {
      const sale = await maybeOne<{ status: SaleStatus; due: string | null; number: string }>(
        tx,
        `select status, to_char(due_date, 'YYYY-MM-DD') as due, number::text as number
         from sales where id = $1 for update`,
        [saleId],
      );
      if (!sale) throw errors.notFound('Venda');
      if (sale.status !== 'concluida') {
        throw errors.conflict(
          'SALE_NOT_ACTIVE',
          'Só é possível alterar o vencimento de venda concluída',
        );
      }
      const summary = await one<{ balance: number }>(
        tx,
        'select balance_cents as balance from sale_summary where sale_id = $1',
        [saleId],
      );
      if (dueDate && summary.balance === 0) {
        throw errors.unprocessable('DUE_DATE_WITHOUT_BALANCE', 'Venda sem saldo a receber');
      }
      await tx.query('update sales set due_date = $2 where id = $1', [saleId, dueDate]);
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'sale.due_date',
        entity: 'sale',
        entityId: saleId,
        payload: { number: Number(sale.number), from: sale.due, to: dueDate },
      });
      return getSale(tx, saleId);
    });
  } catch (err) {
    return translateSaleError(err);
  }
}
