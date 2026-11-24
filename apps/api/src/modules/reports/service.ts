import type pg from 'pg';
import { csvMoney, csvRow, PAYMENT_METHODS } from '@pdv/shared';
import type {
  DailyPointDTO,
  LedgerEntryType,
  MethodAmountDTO,
  PaymentMethod,
  RecentMovementDTO,
  ReportRange,
  ReportSummaryDTO,
  SellerReportDTO,
  TopProductDTO,
} from '@pdv/shared';
import { many, one } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';

/**
 * Relatórios são SOMENTE LEITURA e derivados das fontes únicas (sales, payments, cash_movements,
 * sale_summary): nenhum total é gravado. Exceção documentada à regra de fronteiras de módulo:
 * leituras de relatório consultam tabelas de outros módulos diretamente.
 *
 * Períodos são datas no fuso da loja, inclusive nas duas pontas.
 */
const TZ = 'America/Sao_Paulo';
const FROM = `($1::date)::timestamp at time zone '${TZ}'`;
const TO = `(($2::date) + 1)::timestamp at time zone '${TZ}'`;
const inRange = (col: string) => `${col} >= ${FROM} and ${col} < ${TO}`;
const TODAY = `(now() at time zone '${TZ}')::date`;

export interface Period {
  from: string;
  to: string;
}

export async function resolvePeriod(db: Db, range: ReportRange): Promise<Period> {
  const today = await one<{ today: string }>(db, `select to_char(${TODAY}, 'YYYY-MM-DD') as today`);
  const from = range.from ?? range.to ?? today.today;
  const to = range.to ?? range.from ?? today.today;
  return { from, to };
}

/** Lê tudo num snapshot único: os números de um mesmo relatório nunca divergem entre si. */
async function readOnly<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      /* conexão já inválida */
    }
    throw err;
  } finally {
    client.release();
  }
}

const n = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------------------
export async function getSummary(pool: pg.Pool, range: ReportRange): Promise<ReportSummaryDTO> {
  return readOnly(pool, async (db) => {
    const { from, to } = await resolvePeriod(db, range);
    const p = [from, to];

    const sales = await one<{
      c: number;
      gross: string;
      discount: string;
      valid_c: number;
      valid: string;
    }>(
      db,
      `select count(*)::int as c, coalesce(sum(total_cents), 0) as gross,
              coalesce(sum(discount_cents), 0) as discount,
              (count(*) filter (where status <> 'cancelada'))::int as valid_c,
              coalesce(sum(total_cents) filter (where status <> 'cancelada'), 0) as valid
       from sales s where ${inRange('s.created_at')}`,
      p,
    );
    const cancelled = await one<{ c: number; t: string }>(
      db,
      `select count(*)::int as c, coalesce(sum(total_cents), 0) as t
       from sales s where s.status = 'cancelada' and ${inRange('s.cancelled_at')}`,
      p,
    );
    const returns = await one<{ c: number; t: string }>(
      db,
      `select count(distinct r.id)::int as c, coalesce(sum(ri.amount_cents), 0) as t
       from sale_returns r join sale_return_items ri on ri.return_id = r.id
       where ${inRange('r.created_at')}`,
      p,
    );
    const pay = await many<{
      method: PaymentMethod;
      received: string;
      refunded: string;
      sales_received: string;
      debt_received: string;
    }>(
      db,
      `select method,
              coalesce(sum(amount_cents) filter (where kind = 'recebimento'), 0) as received,
              coalesce(sum(amount_cents) filter (where kind = 'estorno'), 0) as refunded,
              coalesce(sum(amount_cents) filter (where kind = 'recebimento' and receipt_id is null), 0)
                as sales_received,
              coalesce(sum(amount_cents) filter (where kind = 'recebimento' and receipt_id is not null), 0)
                as debt_received
       from payments pm where ${inRange('pm.created_at')} group by method`,
      p,
    );
    const expenses = await many<{ category: string; total: string; reversed: string }>(
      db,
      `select cat as category, coalesce(sum(total), 0) as total, coalesce(sum(reversed), 0) as reversed
       from (
         select coalesce(nullif(trim(m.category), ''), 'Sem categoria') as cat,
                m.amount_cents as total, 0 as reversed
         from cash_movements m where m.kind = 'despesa' and ${inRange('m.created_at')}
         union all
         select coalesce(nullif(trim(o.category), ''), 'Sem categoria'), 0, m.amount_cents
         from cash_movements m join cash_movements o on o.id = m.reverses_movement_id
         where m.kind = 'estorno' and o.kind = 'despesa' and ${inRange('m.created_at')}
       ) x group by cat order by sum(total) - sum(reversed) desc, cat`,
      p,
    );
    const debts = await one<{ t: string; c: number; cust: number; overdue: string }>(
      db,
      `select coalesce(sum(ss.balance_cents), 0) as t, count(*)::int as c,
              count(distinct s.customer_id)::int as cust,
              coalesce(sum(ss.balance_cents) filter (where s.due_date is not null and s.due_date < ${TODAY}), 0)
                as overdue
       from sales s join sale_summary ss on ss.sale_id = s.id
       where s.status = 'concluida' and ss.balance_cents > 0 and s.customer_id is not null`,
    );
    const open = await one<{ c: number; expected: string }>(
      db,
      `select count(*)::int as c, coalesce(sum(cash_session_expected(id)), 0) as expected
       from cash_sessions where status = 'aberto'`,
    );
    const closed = await one<{ c: number; shortage: string; surplus: string }>(
      db,
      `select count(*)::int as c,
              coalesce(-sum(difference_cents) filter (where difference_cents < 0), 0) as shortage,
              coalesce(sum(difference_cents) filter (where difference_cents > 0), 0) as surplus
       from cash_sessions cs where cs.status = 'fechado' and ${inRange('cs.closed_at')}`,
      p,
    );
    const low = await one<{ c: number }>(
      db,
      `select count(*)::int as c
       from product_variants v
       join products pr on pr.id = v.product_id and pr.active
       left join stock_levels s on s.variant_id = v.id
       where v.active and coalesce(s.quantity, 0) <= v.min_stock`,
    );

    const byMethod: MethodAmountDTO[] = PAYMENT_METHODS.map((method) => {
      const row = pay.find((x) => x.method === method);
      const received = n(row?.received);
      const refunded = n(row?.refunded);
      return {
        method,
        receivedCents: received,
        refundedCents: refunded,
        netCents: received - refunded,
      };
    });
    const salesReceived = pay.reduce((s, x) => s + n(x.sales_received), 0);
    const debtReceived = pay.reduce((s, x) => s + n(x.debt_received), 0);
    const refunded = pay.reduce((s, x) => s + n(x.refunded), 0);
    const expTotal = expenses.reduce((s, x) => s + n(x.total), 0);
    const expReversed = expenses.reduce((s, x) => s + n(x.reversed), 0);

    return {
      period: { from, to },
      sales: {
        grossCents: n(sales.gross),
        count: sales.c,
        discountCents: n(sales.discount),
        validCount: sales.valid_c,
        validCents: n(sales.valid),
        ticketAverageCents: sales.valid_c > 0 ? Math.round(n(sales.valid) / sales.valid_c) : 0,
        cancelledCount: cancelled.c,
        cancelledCents: n(cancelled.t),
        returnsCount: returns.c,
        returnsCents: n(returns.t),
        netCents: n(sales.gross) - n(cancelled.t) - n(returns.t),
      },
      receipts: {
        byMethod,
        salesCents: salesReceived,
        debtCents: debtReceived,
        refundedCents: refunded,
        netCents: salesReceived + debtReceived - refunded,
      },
      expenses: {
        totalCents: expTotal,
        reversedCents: expReversed,
        netCents: expTotal - expReversed,
        byCategory: expenses.map((x) => ({
          category: x.category,
          netCents: n(x.total) - n(x.reversed),
        })),
      },
      openDebts: {
        totalCents: n(debts.t),
        salesCount: debts.c,
        customersCount: debts.cust,
        overdueCents: n(debts.overdue),
      },
      cash: {
        openSessions: open.c,
        openExpectedCents: n(open.expected),
        closedSessions: closed.c,
        shortageCents: n(closed.shortage),
        surplusCents: n(closed.surplus),
      },
      lowStockCount: low.c,
    };
  });
}

// ---------------------------------------------------------------------------
export async function getDaily(pool: pg.Pool, range: ReportRange): Promise<DailyPointDTO[]> {
  return readOnly(pool, async (db) => {
    const { from, to } = await resolvePeriod(db, range);
    const rows = await many<{
      day: string;
      gross: string;
      c: number;
      adj: string;
      rec: string;
    }>(
      db,
      `with days as (select generate_series($1::date, $2::date, interval '1 day')::date as d),
       s as (
         select (created_at at time zone '${TZ}')::date as d, count(*)::int as c, sum(total_cents) as gross
         from sales where ${inRange('created_at')} group by 1),
       canc as (
         select (cancelled_at at time zone '${TZ}')::date as d, sum(total_cents) as t
         from sales where status = 'cancelada' and ${inRange('cancelled_at')} group by 1),
       ret as (
         select (r.created_at at time zone '${TZ}')::date as d, sum(ri.amount_cents) as t
         from sale_returns r join sale_return_items ri on ri.return_id = r.id
         where ${inRange('r.created_at')} group by 1),
       pay as (
         select (created_at at time zone '${TZ}')::date as d,
                sum(case kind when 'recebimento' then amount_cents else -amount_cents end) as t
         from payments where ${inRange('created_at')} group by 1)
       select to_char(days.d, 'YYYY-MM-DD') as day, coalesce(s.gross, 0) as gross, coalesce(s.c, 0) as c,
              coalesce(canc.t, 0) + coalesce(ret.t, 0) as adj, coalesce(pay.t, 0) as rec
       from days left join s on s.d = days.d left join canc on canc.d = days.d
       left join ret on ret.d = days.d left join pay on pay.d = days.d
       order by days.d`,
      [from, to],
    );
    return rows.map((r) => ({
      date: r.day,
      grossCents: n(r.gross),
      salesCount: r.c,
      adjustmentsCents: n(r.adj),
      receivedNetCents: n(r.rec),
    }));
  });
}

export async function getTopProducts(
  pool: pg.Pool,
  range: ReportRange,
  limit: number,
): Promise<TopProductDTO[]> {
  const period = await resolvePeriod(pool, range);
  const rows = await many<{
    variant_id: string;
    sku: string;
    product_name: string;
    size: string | null;
    color: string | null;
    qty: string;
    revenue: string;
  }>(
    pool,
    `select si.variant_id, max(si.sku) as sku, max(si.product_name) as product_name,
            max(si.size) as size, max(si.color) as color,
            sum(si.quantity - coalesce(r.qty, 0)) as qty,
            sum(si.line_total_cents - coalesce(r.amount, 0)) as revenue
     from sale_items si
     join sales s on s.id = si.sale_id
     left join lateral (
       select sum(ri.quantity) as qty, sum(ri.amount_cents) as amount
       from sale_return_items ri where ri.sale_item_id = si.id
     ) r on true
     where s.status <> 'cancelada' and ${inRange('s.created_at')}
     group by si.variant_id
     having sum(si.quantity - coalesce(r.qty, 0)) > 0
     order by qty desc, revenue desc, sku
     limit $3`,
    [period.from, period.to, limit],
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    sku: r.sku,
    productName: r.product_name,
    size: r.size,
    color: r.color,
    quantity: n(r.qty),
    revenueCents: n(r.revenue),
  }));
}

export async function getSellers(pool: pg.Pool, range: ReportRange): Promise<SellerReportDTO[]> {
  const period = await resolvePeriod(pool, range);
  const rows = await many<{ id: string; name: string; c: number; t: string; d: string }>(
    pool,
    `select u.id, u.name, count(*)::int as c, sum(s.total_cents) as t, sum(s.discount_cents) as d
     from sales s join users u on u.id = s.seller_id
     where s.status <> 'cancelada' and ${inRange('s.created_at')}
     group by u.id, u.name order by sum(s.total_cents) desc, u.name`,
    [period.from, period.to],
  );
  return rows.map((r) => ({
    sellerId: r.id,
    sellerName: r.name,
    salesCount: r.c,
    salesCents: n(r.t),
    discountCents: n(r.d),
    ticketAverageCents: r.c > 0 ? Math.round(n(r.t) / r.c) : 0,
  }));
}

/** Últimas movimentações financeiras (pagamentos e movimentos de caixa) de toda a loja. */
export async function getRecent(pool: pg.Pool, limit = 10): Promise<RecentMovementDTO[]> {
  const rows = await many<{
    id: string;
    type: LedgerEntryType;
    at: Date;
    amount: number;
    method: string | null;
    operator: string | null;
    description: string | null;
    sale_id: string | null;
    sale_number: string | null;
  }>(
    pool,
    `select * from (
       select pm.id, (case when pm.kind = 'recebimento' then
                             (case when pm.receipt_id is null then 'recebimento_venda' else 'recebimento_fiado' end)
                           else (case when pm.receipt_id is null then 'estorno_pagamento' else 'estorno_recebimento' end)
                      end) as type,
              pm.created_at as at, pm.amount_cents as amount, pm.method, u.name as operator,
              null::text as description, s.id as sale_id, s.number::text as sale_number
       from payments pm join users u on u.id = pm.created_by join sales s on s.id = pm.sale_id
       union all
       select m.id, (case m.kind when 'estorno' then 'estorno_movimento' else m.kind end), m.created_at,
              m.amount_cents, null, u.name, m.description, null, null
       from cash_movements m join users u on u.id = m.created_by
     ) x order by at desc, id limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    at: r.at.toISOString(),
    amountCents: r.amount,
    method: r.method,
    operatorName: r.operator,
    description: r.description,
    saleId: r.sale_id,
    saleNumber: r.sale_number === null ? null : Number(r.sale_number),
  }));
}

// ---------------------------------------------------------------------------
// CSV (limite de linhas para não estourar memória)
const CSV_MAX_ROWS = 50_000;
const BOM = '﻿'; // Excel pt-BR reconhece UTF-8

export async function exportSalesCsv(pool: pg.Pool, range: ReportRange): Promise<string> {
  const period = await resolvePeriod(pool, range);
  const rows = await many<{
    number: string;
    at: string;
    customer: string | null;
    seller: string;
    status: string;
    payment_status: string | null;
    total: number;
    discount: number;
    returned: number;
    received: number;
    balance: number;
  }>(
    pool,
    `select s.number::text as number, to_char(s.created_at at time zone '${TZ}', 'YYYY-MM-DD HH24:MI') as at,
            c.name as customer, u.name as seller, s.status, ss.payment_status,
            s.total_cents as total, s.discount_cents as discount, ss.returned_cents as returned,
            ss.received_cents as received, ss.balance_cents as balance
     from sales s join sale_summary ss on ss.sale_id = s.id join users u on u.id = s.seller_id
     left join customers c on c.id = s.customer_id
     where ${inRange('s.created_at')} order by s.number limit ${CSV_MAX_ROWS}`,
    [period.from, period.to],
  );
  const lines = [
    csvRow([
      'numero',
      'data',
      'cliente',
      'vendedor',
      'status',
      'pagamento',
      'total',
      'desconto',
      'devolvido',
      'recebido_liquido',
      'saldo',
    ]),
    ...rows.map((r) =>
      csvRow([
        r.number,
        r.at,
        r.customer,
        r.seller,
        r.status,
        r.payment_status,
        csvMoney(r.total),
        csvMoney(r.discount),
        csvMoney(r.returned),
        csvMoney(r.received),
        csvMoney(r.balance),
      ]),
    ),
  ];
  return BOM + lines.join('\r\n') + '\r\n';
}

export async function exportPaymentsCsv(pool: pg.Pool, range: ReportRange): Promise<string> {
  const period = await resolvePeriod(pool, range);
  const rows = await many<{
    at: string;
    kind: string;
    method: string;
    amount: number;
    sale: string;
    receipt: string | null;
    operator: string;
    cash: string | null;
  }>(
    pool,
    `select to_char(pm.created_at at time zone '${TZ}', 'YYYY-MM-DD HH24:MI:SS') as at, pm.kind, pm.method,
            pm.amount_cents as amount, s.number::text as sale, dr.number::text as receipt,
            u.name as operator, cs.number::text as cash
     from payments pm join sales s on s.id = pm.sale_id join users u on u.id = pm.created_by
     left join debt_receipts dr on dr.id = pm.receipt_id
     left join cash_sessions cs on cs.id = pm.cash_session_id
     where ${inRange('pm.created_at')} order by pm.created_at, pm.id limit ${CSV_MAX_ROWS}`,
    [period.from, period.to],
  );
  const lines = [
    csvRow(['data', 'tipo', 'forma', 'valor', 'venda', 'recebimento_fiado', 'operador', 'caixa']),
    ...rows.map((r) =>
      csvRow([r.at, r.kind, r.method, csvMoney(r.amount), r.sale, r.receipt, r.operator, r.cash]),
    ),
  ];
  return BOM + lines.join('\r\n') + '\r\n';
}
