import { createHash } from 'node:crypto';
import type pg from 'pg';
import { allocateReceipt } from '@pdv/shared';
import type {
  CustomerAccountDTO,
  CustomerPaymentDTO,
  DebtListQuery,
  DebtReceiptDTO,
  DebtReceiptInput,
  DebtReceiptReverseInput,
  OpenDebtDTO,
  Paginated,
  PaginationQuery,
  PaymentMethod,
} from '@pdv/shared';
import { lockKey, many, maybeOne, one, withTransaction } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { AppError, errors } from '../../shared/errors.js';
import { escapeLike } from '../../shared/validate.js';
import { recordAudit } from '../audit/service.js';
import { requireOpenSession } from '../cash/service.js';
import { getCustomer } from '../customers/service.js';
import { translateSaleError } from '../sales/service.js';
import type { SaleActor } from '../sales/service.js';

const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const TODAY = `(now() at time zone 'America/Sao_Paulo')::date`;

// ---------------------------------------------------------------------------
// Dívidas em aberto
// ---------------------------------------------------------------------------
interface DebtRow {
  sale_id: string;
  number: string;
  created_at: Date;
  customer_id: string;
  customer_name: string;
  due_date: string | null;
  overdue: boolean;
  total_cents: number;
  received_cents: number;
  returned_cents: number;
  balance_cents: number;
}

const DEBT_SELECT = `
  select s.id as sale_id, s.number::text as number, s.created_at, c.id as customer_id,
         c.name as customer_name, to_char(s.due_date, 'YYYY-MM-DD') as due_date,
         (s.due_date is not null and s.due_date < ${TODAY}) as overdue,
         ss.total_cents, ss.received_cents, ss.returned_cents, ss.balance_cents
  from sales s
  join sale_summary ss on ss.sale_id = s.id
  join customers c on c.id = s.customer_id
  where s.status = 'concluida' and ss.balance_cents > 0`;

const toDebt = (r: DebtRow): OpenDebtDTO => ({
  saleId: r.sale_id,
  saleNumber: Number(r.number),
  createdAt: r.created_at.toISOString(),
  customerId: r.customer_id,
  customerName: r.customer_name,
  dueDate: r.due_date,
  overdue: r.overdue,
  totalCents: r.total_cents,
  receivedCents: r.received_cents,
  returnedCents: r.returned_cents,
  balanceCents: r.balance_cents,
});

export async function listOpenDebts(db: Db, query: DebtListQuery): Promise<Paginated<OpenDebtDTO>> {
  const params: unknown[] = [];
  let filter = '';
  if (query.customerId) {
    params.push(query.customerId);
    filter += ` and s.customer_id = $${params.length}`;
  }
  if (query.overdue) filter += ` and s.due_date is not null and s.due_date < ${TODAY}`;
  if (query.q) {
    params.push(`%${escapeLike(query.q)}%`, query.q.replace(/\D/g, ''));
    filter += ` and (c.name ilike $${params.length - 1}
                     or (length($${params.length}) > 0 and s.number::text = $${params.length}))`;
  }
  const total = Number(
    (await one<{ count: string }>(db, `select count(*) from (${DEBT_SELECT} ${filter}) d`, params))
      .count,
  );
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = await many<DebtRow>(
    db,
    `${DEBT_SELECT} ${filter}
     order by (s.due_date is null), s.due_date, s.created_at, s.id
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { items: rows.map(toDebt), page: query.page, pageSize: query.pageSize, total };
}

// ---------------------------------------------------------------------------
// Recebimentos (leitura)
// ---------------------------------------------------------------------------
interface ReceiptRow {
  id: string;
  number: string;
  kind: 'recebimento' | 'estorno';
  customer_id: string;
  total_cents: number;
  created_at: Date;
  created_by_name: string;
  note: string | null;
  reason: string | null;
  reverses_receipt_id: string | null;
  reversed: boolean;
}

const RECEIPT_SELECT = `
  select r.id, r.number::text as number, r.kind, r.customer_id, r.total_cents, r.created_at,
         u.name as created_by_name, r.note, r.reason, r.reverses_receipt_id,
         exists (select 1 from debt_receipts x where x.reverses_receipt_id = r.id) as reversed
  from debt_receipts r join users u on u.id = r.created_by`;

async function hydrateReceipts(db: Db, rows: ReceiptRow[]): Promise<DebtReceiptDTO[]> {
  if (rows.length === 0) return [];
  const allocs = await many<{
    receipt_id: string;
    sale_id: string;
    sale_number: string;
    method: PaymentMethod;
    amount_cents: number;
  }>(
    db,
    `select pm.receipt_id, pm.sale_id, s.number::text as sale_number, pm.method, pm.amount_cents
     from payments pm join sales s on s.id = pm.sale_id
     where pm.receipt_id = any($1::uuid[]) order by pm.created_at, pm.id`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({
    id: r.id,
    number: Number(r.number),
    kind: r.kind,
    customerId: r.customer_id,
    totalCents: r.total_cents,
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    note: r.note,
    reason: r.reason,
    reversesReceiptId: r.reverses_receipt_id,
    reversed: r.reversed,
    allocations: allocs
      .filter((a) => a.receipt_id === r.id)
      .map((a) => ({
        saleId: a.sale_id,
        saleNumber: Number(a.sale_number),
        method: a.method,
        amountCents: a.amount_cents,
      })),
  }));
}

export async function getReceipt(db: Db, id: string): Promise<DebtReceiptDTO> {
  const row = await maybeOne<ReceiptRow>(db, `${RECEIPT_SELECT} where r.id = $1`, [id]);
  if (!row) throw errors.notFound('Recebimento');
  return (await hydrateReceipts(db, [row]))[0]!;
}

export async function getCustomerAccount(db: Db, customerId: string): Promise<CustomerAccountDTO> {
  const customer = await getCustomer(db, customerId);
  const debts = await many<DebtRow>(
    db,
    `${DEBT_SELECT} and s.customer_id = $1 order by (s.due_date is null), s.due_date, s.created_at, s.id`,
    [customerId],
  );
  const receipts = await many<ReceiptRow>(
    db,
    `${RECEIPT_SELECT} where r.customer_id = $1 order by r.created_at desc, r.id desc limit 50`,
    [customerId],
  );
  const openDebts = debts.map(toDebt);
  return {
    customer,
    openDebts,
    overdueCents: openDebts.filter((d) => d.overdue).reduce((s, d) => s + d.balanceCents, 0),
    receipts: await hydrateReceipts(db, receipts),
  };
}

/** Histórico de pagamentos do cliente: no ato da venda, posteriores (fiado) e estornos. */
export async function listCustomerPayments(
  db: Db,
  customerId: string,
  query: PaginationQuery,
): Promise<Paginated<CustomerPaymentDTO>> {
  await getCustomer(db, customerId);
  const total = Number(
    (
      await one<{ count: string }>(
        db,
        `select count(*) from payments pm join sales s on s.id = pm.sale_id where s.customer_id = $1`,
        [customerId],
      )
    ).count,
  );
  const rows = await many<{
    id: string;
    kind: 'recebimento' | 'estorno';
    method: PaymentMethod;
    amount_cents: number;
    created_at: Date;
    sale_id: string;
    sale_number: string;
    receipt_id: string | null;
    receipt_number: string | null;
    operator: string | null;
  }>(
    db,
    `select pm.id, pm.kind, pm.method, pm.amount_cents, pm.created_at, pm.sale_id,
            s.number::text as sale_number, pm.receipt_id, rc.number::text as receipt_number,
            u.name as operator
     from payments pm
     join sales s on s.id = pm.sale_id
     left join debt_receipts rc on rc.id = pm.receipt_id
     left join users u on u.id = pm.created_by
     where s.customer_id = $1
     order by pm.created_at desc, pm.id
     limit $2 offset $3`,
    [customerId, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      method: r.method,
      amountCents: r.amount_cents,
      createdAt: r.created_at.toISOString(),
      saleId: r.sale_id,
      saleNumber: Number(r.sale_number),
      receiptId: r.receipt_id,
      receiptNumber: r.receipt_number === null ? null : Number(r.receipt_number),
      origin: r.kind === 'estorno' ? 'estorno' : r.receipt_id ? 'posterior' : 'venda',
      operatorName: r.operator,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

// ---------------------------------------------------------------------------
// Recebimento posterior de fiado / saldo de venda parcial
// ---------------------------------------------------------------------------
export interface ReceiptResult {
  receipt: DebtReceiptDTO;
  created: boolean;
}

/**
 * Recebe parte ou todo o saldo devido. Com `saleId`, recebe só daquela venda; sem ele, abate as
 * vendas em aberto do cliente da mais antiga para a mais nova.
 *
 * Concorrência: a linha do cliente é bloqueada (serializa recebimentos do mesmo cliente) e depois
 * as vendas, em ordem determinística; os saldos só são lidos após os bloqueios, então dois
 * recebimentos simultâneos nunca somam mais que o saldo devido.
 */
export async function receiveDebt(
  pool: pg.Pool,
  customerId: string,
  saleId: string | null,
  input: DebtReceiptInput,
  actor: SaleActor,
): Promise<ReceiptResult> {
  const hash = hashOf({
    customerId,
    saleId,
    note: input.note ?? null,
    payments: [...input.payments].sort(
      (a, b) => a.method.localeCompare(b.method) || a.amountCents - b.amountCents,
    ),
  });
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `debt-receipt:${input.idempotencyKey}`);
      const existing = await maybeOne<{ id: string; request_hash: string; kind: string }>(
        tx,
        'select id, request_hash, kind from debt_receipts where idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing) {
        if (existing.request_hash !== hash || existing.kind !== 'recebimento') {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { receipt: await getReceipt(tx, existing.id), created: false };
      }

      const sessionId = await requireOpenSession(tx, actor.id);
      const customer = await maybeOne(tx, 'select 1 from customers where id = $1 for update', [
        customerId,
      ]);
      if (!customer) throw errors.notFound('Cliente');

      // 1) bloqueia as vendas candidatas; 2) só então lê os saldos.
      const params: unknown[] = [customerId];
      let saleFilter = '';
      if (saleId) {
        params.push(saleId);
        saleFilter = 'and s.id = $2';
      }
      await many(
        tx,
        `select s.id from sales s
         where s.customer_id = $1 and s.status = 'concluida' ${saleFilter}
         order by s.created_at, s.id for update of s`,
        params,
      );
      const open = await many<{ sale_id: string; balance_cents: number }>(
        tx,
        `select s.id as sale_id, ss.balance_cents
         from sales s join sale_summary ss on ss.sale_id = s.id
         where s.customer_id = $1 and s.status = 'concluida' and ss.balance_cents > 0 ${saleFilter}
         order by s.created_at, s.id`,
        params,
      );
      if (saleId && open.length === 0) {
        throw errors.unprocessable('NO_BALANCE', 'Esta venda não tem saldo a receber');
      }
      const balance = open.reduce((s, d) => s + d.balance_cents, 0);
      const paid = input.payments.reduce((s, p) => s + p.amountCents, 0);
      if (paid > balance) {
        throw new AppError('OVERPAYMENT', 422, 'O valor recebido é maior que o saldo devido', {
          balanceCents: balance,
          paidCents: paid,
        });
      }
      const allocations = allocateReceipt(
        input.payments,
        open.map((d) => ({ saleId: d.sale_id, balanceCents: d.balance_cents })),
      );
      if (!allocations)
        throw errors.unprocessable('OVERPAYMENT', 'O valor recebido é maior que o saldo devido');

      const receipt = await one<{ id: string; number: string }>(
        tx,
        `insert into debt_receipts
           (kind, customer_id, cash_session_id, total_cents, note, idempotency_key, request_hash, created_by)
         values ('recebimento', $1, $2, $3, $4, $5, $6, $7) returning id, number::text as number`,
        [customerId, sessionId, paid, input.note ?? null, input.idempotencyKey, hash, actor.id],
      );
      for (const a of allocations) {
        await tx.query(
          `insert into payments (sale_id, kind, method, amount_cents, created_by, cash_session_id, receipt_id)
           values ($1, 'recebimento', $2, $3, $4, $5, $6)`,
          [a.saleId, a.method, a.amountCents, actor.id, sessionId, receipt.id],
        );
      }
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'debt.receive',
        entity: 'debt_receipt',
        entityId: receipt.id,
        payload: {
          number: Number(receipt.number),
          customerId,
          saleId,
          totalCents: paid,
          sales: [...new Set(allocations.map((a) => a.saleId))],
        },
      });
      return { receipt: await getReceipt(tx, receipt.id), created: true };
    });
  } catch (err) {
    return translateSaleError(err);
  }
}

/**
 * Estorno de recebimento (compensatório): reverte todos os pagamentos do recebimento original,
 * reabrindo a dívida. O dinheiro devolvido sai do caixa de quem estorna.
 */
export async function reverseReceipt(
  pool: pg.Pool,
  receiptId: string,
  input: DebtReceiptReverseInput,
  actor: SaleActor,
): Promise<ReceiptResult> {
  const hash = hashOf({ receiptId, reason: input.reason });
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `debt-receipt:${input.idempotencyKey}`);
      const existing = await maybeOne<{ id: string; request_hash: string; kind: string }>(
        tx,
        'select id, request_hash, kind from debt_receipts where idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing) {
        if (existing.request_hash !== hash || existing.kind !== 'estorno') {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { receipt: await getReceipt(tx, existing.id), created: false };
      }

      const sessionId = await requireOpenSession(tx, actor.id);
      const original = await maybeOne<{
        id: string;
        kind: string;
        customer_id: string;
        number: string;
      }>(
        tx,
        'select id, kind, customer_id, number::text as number from debt_receipts where id = $1',
        [receiptId],
      );
      if (!original) throw errors.notFound('Recebimento');
      if (original.kind !== 'recebimento') {
        throw errors.unprocessable('NOT_REVERSIBLE', 'Um estorno não pode ser estornado');
      }
      // Mesma ordem de bloqueio do recebimento: cliente, depois vendas.
      await tx.query('select 1 from customers where id = $1 for update', [original.customer_id]);
      await many(
        tx,
        `select s.id from sales s
         where s.id in (select sale_id from payments where receipt_id = $1)
         order by s.created_at, s.id for update of s`,
        [receiptId],
      );
      if (
        await maybeOne(tx, 'select 1 from debt_receipts where reverses_receipt_id = $1', [
          receiptId,
        ])
      ) {
        throw errors.conflict('ALREADY_REVERSED', 'Este recebimento já foi estornado');
      }
      const payments = await many<{
        id: string;
        sale_id: string;
        method: PaymentMethod;
        amount_cents: number;
      }>(
        tx,
        'select id, sale_id, method, amount_cents from payments where receipt_id = $1 order by created_at, id',
        [receiptId],
      );
      const alreadyUndone = await maybeOne(
        tx,
        `select 1 from payments r where r.reverses_payment_id = any($1::uuid[])`,
        [payments.map((p) => p.id)],
      );
      if (alreadyUndone) {
        throw errors.conflict(
          'ALREADY_REVERSED',
          'Pagamentos deste recebimento já foram estornados (ex.: cancelamento da venda)',
        );
      }
      const total = payments.reduce((s, p) => s + p.amount_cents, 0);
      const reversal = await one<{ id: string; number: string }>(
        tx,
        `insert into debt_receipts
           (kind, customer_id, cash_session_id, total_cents, reverses_receipt_id, reason,
            idempotency_key, request_hash, created_by)
         values ('estorno', $1, $2, $3, $4, $5, $6, $7, $8) returning id, number::text as number`,
        [
          original.customer_id,
          sessionId,
          total,
          receiptId,
          input.reason,
          input.idempotencyKey,
          hash,
          actor.id,
        ],
      );
      for (const p of payments) {
        await tx.query(
          `insert into payments
             (sale_id, kind, method, amount_cents, reverses_payment_id, created_by, cash_session_id, receipt_id)
           values ($1, 'estorno', $2, $3, $4, $5, $6, $7)`,
          [p.sale_id, p.method, p.amount_cents, p.id, actor.id, sessionId, reversal.id],
        );
      }
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'debt.receive.reverse',
        entity: 'debt_receipt',
        entityId: reversal.id,
        payload: {
          number: Number(reversal.number),
          reverses: receiptId,
          originalNumber: Number(original.number),
          totalCents: total,
          reason: input.reason,
        },
      });
      return { receipt: await getReceipt(tx, reversal.id), created: true };
    });
  } catch (err) {
    return translateSaleError(err);
  }
}
