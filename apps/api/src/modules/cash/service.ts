import { createHash } from 'node:crypto';
import type pg from 'pg';
import { hasPermission } from '@pdv/shared';
import type {
  CashCloseInput,
  CashMovementInput,
  CashMovementReverseInput,
  CashOpenInput,
  CashReportDTO,
  CashSessionDTO,
  CashSessionListQuery,
  LedgerEntryDTO,
  LedgerEntryType,
  MethodAmountDTO,
  Paginated,
  PaginationQuery,
  PaymentMethod,
  Role,
} from '@pdv/shared';
import { PAYMENT_METHODS } from '@pdv/shared';
import { lockKey, many, maybeOne, one, withTransaction } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { AppError, errors, PG, pgErrorCode } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';

export interface CashActor {
  id: string;
  role: Role;
}

const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ---------------------------------------------------------------------------
// Sessão aberta do operador (usada por vendas, devoluções, cancelamentos e recebimentos)
// ---------------------------------------------------------------------------
/**
 * Devolve o caixa aberto do operador com FOR SHARE: o fechamento (FOR UPDATE) espera esta
 * transação terminar, então nenhum pagamento entra num caixa que está sendo fechado.
 */
export async function requireOpenSession(tx: pg.PoolClient, userId: string): Promise<string> {
  const row = await maybeOne<{ id: string }>(
    tx,
    `select id from cash_sessions where opened_by = $1 and status = 'aberto' for share`,
    [userId],
  );
  if (!row) {
    throw errors.conflict('CASH_NOT_OPEN', 'Abra o caixa antes de registrar operações financeiras');
  }
  return row.id;
}

export function translateCashError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const code = pgErrorCode(err);
  const message = err instanceof Error ? err.message : '';
  if (code === PG.checkViolation && /cash_integrity/.test(message)) {
    throw errors.conflict(
      'CASH_INTEGRITY',
      'Operação recusada: caixa fechado ou de outro operador',
    );
  }
  if (code === PG.uniqueViolation && /cash_sessions_one_open_per_user/.test(message)) {
    throw errors.conflict('CASH_ALREADY_OPEN', 'Você já possui um caixa aberto');
  }
  if (code === PG.uniqueViolation) {
    throw errors.conflict('DUPLICATE_OPERATION', 'Operação já registrada com esta chave');
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
interface SessionRow {
  id: string;
  number: string;
  status: 'aberto' | 'fechado';
  opened_by: string;
  opened_by_name: string;
  opened_at: Date;
  opening_cents: number;
  closed_by_name: string | null;
  closed_at: Date | null;
  counted_cents: number | null;
  expected_cents: number | null;
  difference_cents: number | null;
  close_note: string | null;
}

const SESSION_SELECT = `
  select s.id, s.number::text as number, s.status, s.opened_by, uo.name as opened_by_name,
         s.opened_at, s.opening_cents, uc.name as closed_by_name, s.closed_at, s.counted_cents,
         s.expected_cents, s.difference_cents, s.close_note
  from cash_sessions s
  join users uo on uo.id = s.opened_by
  left join users uc on uc.id = s.closed_by`;

const toSession = (r: SessionRow): CashSessionDTO => ({
  id: r.id,
  number: Number(r.number),
  status: r.status,
  openedById: r.opened_by,
  openedByName: r.opened_by_name,
  openedAt: r.opened_at.toISOString(),
  openingCents: r.opening_cents,
  closedByName: r.closed_by_name,
  closedAt: r.closed_at?.toISOString() ?? null,
  countedCents: r.counted_cents,
  expectedCents: r.expected_cents,
  differenceCents: r.difference_cents,
  closeNote: r.close_note,
});

const canManage = (actor: CashActor) => hasPermission(actor.role, 'cash:manage');

/** Operador comum só enxerga o próprio caixa; gerente/admin enxergam todos. */
export async function getSession(db: Db, id: string, actor: CashActor): Promise<CashSessionDTO> {
  const row = await maybeOne<SessionRow>(db, `${SESSION_SELECT} where s.id = $1`, [id]);
  if (!row || (!canManage(actor) && row.opened_by !== actor.id)) throw errors.notFound('Caixa');
  return toSession(row);
}

export async function getCurrentSession(db: Db, userId: string): Promise<CashSessionDTO | null> {
  const row = await maybeOne<SessionRow>(
    db,
    `${SESSION_SELECT} where s.opened_by = $1 and s.status = 'aberto'`,
    [userId],
  );
  return row ? toSession(row) : null;
}

export async function listSessions(
  db: Db,
  query: CashSessionListQuery,
  actor: CashActor,
): Promise<Paginated<CashSessionDTO>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (!canManage(actor)) add('s.opened_by = ?', actor.id);
  else if (query.userId) add('s.opened_by = ?', query.userId);
  if (query.status) add('s.status = ?', query.status);
  if (query.from)
    add(`(s.opened_at at time zone 'America/Sao_Paulo')::date >= ?::date`, query.from);
  if (query.to) add(`(s.opened_at at time zone 'America/Sao_Paulo')::date <= ?::date`, query.to);
  const w = where.length ? `where ${where.join(' and ')}` : '';
  const total = Number(
    (await one<{ count: string }>(db, `select count(*) from cash_sessions s ${w}`, params)).count,
  );
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = await many<SessionRow>(
    db,
    `${SESSION_SELECT} ${w} order by s.opened_at desc, s.id limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { items: rows.map(toSession), page: query.page, pageSize: query.pageSize, total };
}

/**
 * Relatório do caixa. Tudo é derivado dos fatos (`payments`, `cash_movements`, `sales`...):
 * nada é copiado, então não existe segunda fonte de verdade nem contagem em dobro.
 */
export async function getReport(db: Db, sessionId: string): Promise<CashReportDTO> {
  const session = await one<{ opening_cents: number; expected: number }>(
    db,
    'select opening_cents, cash_session_expected(id) as expected from cash_sessions where id = $1',
    [sessionId],
  );
  const sales = await one<{ c: number; t: number }>(
    db,
    `select count(*)::int as c, coalesce(sum(total_cents), 0)::bigint as t
     from sales where cash_session_id = $1`,
    [sessionId],
  );
  const cancelled = await one<{ c: number; t: number }>(
    db,
    `select count(*)::int as c, coalesce(sum(total_cents), 0)::bigint as t
     from sales where cancel_session_id = $1`,
    [sessionId],
  );
  const returns = await one<{ c: number; t: number }>(
    db,
    `select count(distinct r.id)::int as c, coalesce(sum(ri.amount_cents), 0)::bigint as t
     from sale_returns r join sale_return_items ri on ri.return_id = r.id
     where r.cash_session_id = $1`,
    [sessionId],
  );
  const pay = await many<{
    method: PaymentMethod;
    received: number;
    refunded: number;
    sales_received: number;
    debt_received: number;
  }>(
    db,
    `select method,
            coalesce(sum(amount_cents) filter (where kind = 'recebimento'), 0)::bigint as received,
            coalesce(sum(amount_cents) filter (where kind = 'estorno'), 0)::bigint as refunded,
            coalesce(sum(amount_cents) filter (where kind = 'recebimento' and receipt_id is null), 0)::bigint
              as sales_received,
            coalesce(sum(amount_cents) filter (where kind = 'recebimento' and receipt_id is not null), 0)::bigint
              as debt_received
     from payments where cash_session_id = $1 group by method`,
    [sessionId],
  );
  const mov = await one<{
    suprimento: number;
    sangria: number;
    despesa: number;
    reversals: number;
    net: number;
  }>(
    db,
    `select coalesce(sum(amount_cents) filter (where kind = 'suprimento'), 0)::bigint as suprimento,
            coalesce(sum(amount_cents) filter (where kind = 'sangria'), 0)::bigint as sangria,
            coalesce(sum(amount_cents) filter (where kind = 'despesa'), 0)::bigint as despesa,
            coalesce(sum(case direction when 'entrada' then amount_cents else -amount_cents end)
                     filter (where kind = 'estorno'), 0)::bigint as reversals,
            coalesce(sum(case direction when 'entrada' then amount_cents else -amount_cents end), 0)::bigint
              as net
     from cash_movements where session_id = $1`,
    [sessionId],
  );

  const byMethod: MethodAmountDTO[] = PAYMENT_METHODS.map((method) => {
    const row = pay.find((p) => p.method === method);
    const received = Number(row?.received ?? 0);
    const refunded = Number(row?.refunded ?? 0);
    return {
      method,
      receivedCents: received,
      refundedCents: refunded,
      netCents: received - refunded,
    };
  });
  const sum = (f: (p: (typeof pay)[number]) => number) => pay.reduce((s, p) => s + Number(f(p)), 0);
  const receivedSales = sum((p) => p.sales_received);
  const receivedDebt = sum((p) => p.debt_received);
  const refunded = sum((p) => p.refunded);

  return {
    openingCents: session.opening_cents,
    salesCount: sales.c,
    salesTotalCents: Number(sales.t),
    cancelledCount: cancelled.c,
    cancelledCents: Number(cancelled.t),
    returnsCount: returns.c,
    returnsCents: Number(returns.t),
    byMethod,
    receivedSalesCents: receivedSales,
    receivedDebtCents: receivedDebt,
    refundedCents: refunded,
    receivedNetCents: receivedSales + receivedDebt - refunded,
    suprimentoCents: Number(mov.suprimento),
    sangriaCents: Number(mov.sangria),
    despesaCents: Number(mov.despesa),
    movementReversalsCents: Number(mov.reversals),
    movementsNetCents: Number(mov.net),
    expectedCashCents: session.expected,
  };
}

/** Livro de movimentações do caixa: pagamentos e movimentos próprios, na ordem cronológica. */
export async function getLedger(
  db: Db,
  sessionId: string,
  query: PaginationQuery,
  actor: CashActor,
): Promise<Paginated<LedgerEntryDTO>> {
  await getSession(db, sessionId, actor); // valida existência e escopo
  const entries = `
    select s.id::text as id, 'abertura'::text as type, s.opened_at as at, s.opening_cents as amount_cents,
           null::text as method, 'entrada'::text as cash_effect, u.name as operator,
           'Abertura de caixa'::text as description, null::uuid as sale_id, null::bigint as sale_number,
           null::uuid as receipt_id, null::text as customer_name, false as reversed
    from cash_sessions s join users u on u.id = s.opened_by where s.id = $1
    union all
    select pm.id::text,
           case when pm.kind = 'recebimento'
                  then (case when pm.receipt_id is null then 'recebimento_venda' else 'recebimento_fiado' end)
                else (case when rc.kind = 'estorno' then 'estorno_recebimento' else 'estorno_pagamento' end)
           end,
           pm.created_at, pm.amount_cents, pm.method,
           case when pm.method <> 'dinheiro' then 'nenhum'
                when pm.kind = 'recebimento' then 'entrada' else 'saida' end,
           u.name,
           case when rc.number is not null then 'Recebimento #' || rc.number else null end,
           pm.sale_id, sl.number, pm.receipt_id, c.name,
           exists (select 1 from payments r where r.reverses_payment_id = pm.id)
    from payments pm
    join sales sl on sl.id = pm.sale_id
    left join customers c on c.id = sl.customer_id
    left join debt_receipts rc on rc.id = pm.receipt_id
    left join users u on u.id = pm.created_by
    where pm.cash_session_id = $1
    union all
    select m.id::text, case when m.kind = 'estorno' then 'estorno_movimento' else m.kind end,
           m.created_at, m.amount_cents, null, m.direction, u.name, m.description,
           null, null, null, null,
           exists (select 1 from cash_movements r where r.reverses_movement_id = m.id)
    from cash_movements m join users u on u.id = m.created_by
    where m.session_id = $1`;
  const total = Number(
    (await one<{ count: string }>(db, `select count(*) from (${entries}) e`, [sessionId])).count,
  );
  const rows = await many<{
    id: string;
    type: LedgerEntryType;
    at: Date;
    amount_cents: number;
    method: PaymentMethod | null;
    cash_effect: 'entrada' | 'saida' | 'nenhum';
    operator: string | null;
    description: string | null;
    sale_id: string | null;
    sale_number: string | null;
    receipt_id: string | null;
    customer_name: string | null;
    reversed: boolean;
  }>(db, `select * from (${entries}) e order by at, id limit $2 offset $3`, [
    sessionId,
    query.pageSize,
    (query.page - 1) * query.pageSize,
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      at: r.at.toISOString(),
      amountCents: r.amount_cents,
      method: r.method,
      cashEffect: r.cash_effect,
      operatorName: r.operator,
      description: r.description,
      saleId: r.sale_id,
      saleNumber: r.sale_number === null ? null : Number(r.sale_number),
      receiptId: r.receipt_id,
      customerName: r.customer_name,
      reversed: r.reversed,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

// ---------------------------------------------------------------------------
// Abertura
// ---------------------------------------------------------------------------
export async function openSession(
  pool: pg.Pool,
  input: CashOpenInput,
  actor: CashActor,
): Promise<{ session: CashSessionDTO; created: boolean }> {
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `cash-open:${input.idempotencyKey}`);
      const existing = await maybeOne<{ id: string; opened_by: string; opening_cents: number }>(
        tx,
        'select id, opened_by, opening_cents from cash_sessions where open_key = $1',
        [input.idempotencyKey],
      );
      if (existing) {
        if (existing.opened_by !== actor.id || existing.opening_cents !== input.openingCents) {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { session: await getSession(tx, existing.id, actor), created: false };
      }
      // Serializa aberturas do mesmo operador; o índice único é a barreira final.
      await lockKey(tx, `cash-open-user:${actor.id}`);
      if (
        await maybeOne(
          tx,
          `select 1 from cash_sessions where opened_by = $1 and status = 'aberto'`,
          [actor.id],
        )
      ) {
        throw errors.conflict('CASH_ALREADY_OPEN', 'Você já possui um caixa aberto');
      }
      const created = await one<{ id: string; number: string }>(
        tx,
        `insert into cash_sessions (opened_by, opening_cents, open_key) values ($1, $2, $3)
         returning id, number::text as number`,
        [actor.id, input.openingCents, input.idempotencyKey],
      );
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'cash.open',
        entity: 'cash_session',
        entityId: created.id,
        payload: { number: Number(created.number), openingCents: input.openingCents },
      });
      return { session: await getSession(tx, created.id, actor), created: true };
    });
  } catch (err) {
    return translateCashError(err);
  }
}

// ---------------------------------------------------------------------------
// Fechamento com conferência
// ---------------------------------------------------------------------------
export async function closeSession(
  pool: pg.Pool,
  sessionId: string,
  input: CashCloseInput,
  actor: CashActor,
): Promise<{ session: CashSessionDTO; created: boolean }> {
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `cash-close:${input.idempotencyKey}`);
      const replay = await maybeOne<{
        id: string;
        counted_cents: number;
        close_note: string | null;
      }>(tx, 'select id, counted_cents, close_note from cash_sessions where close_key = $1', [
        input.idempotencyKey,
      ]);
      if (replay) {
        if (
          replay.id !== sessionId ||
          replay.counted_cents !== input.countedCents ||
          (replay.close_note ?? null) !== (input.note ?? null)
        ) {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { session: await getSession(tx, sessionId, actor), created: false };
      }

      // FOR UPDATE: espera operações em andamento (que seguram FOR SHARE) e bloqueia novas.
      const s = await maybeOne<{ opened_by: string; status: string; number: string }>(
        tx,
        'select opened_by, status, number::text as number from cash_sessions where id = $1 for update',
        [sessionId],
      );
      if (!s || (s.opened_by !== actor.id && !canManage(actor))) throw errors.notFound('Caixa');
      if (s.status !== 'aberto')
        throw errors.conflict('CASH_ALREADY_CLOSED', 'Este caixa já foi fechado');

      const expected = (
        await one<{ e: number }>(tx, 'select cash_session_expected($1) as e', [sessionId])
      ).e;
      const difference = input.countedCents - expected;
      if (difference !== 0 && !input.note) {
        throw new AppError(
          'DIFFERENCE_NOTE_REQUIRED',
          422,
          'Informe uma observação para justificar a diferença de caixa',
          {
            expectedCents: expected,
            countedCents: input.countedCents,
            differenceCents: difference,
          },
        );
      }
      await tx.query(
        `update cash_sessions
            set status = 'fechado', closed_by = $2, closed_at = clock_timestamp(), counted_cents = $3,
                expected_cents = $4, difference_cents = $5, close_note = $6, close_key = $7
          where id = $1`,
        [
          sessionId,
          actor.id,
          input.countedCents,
          expected,
          difference,
          input.note ?? null,
          input.idempotencyKey,
        ],
      );
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'cash.close',
        entity: 'cash_session',
        entityId: sessionId,
        payload: {
          number: Number(s.number),
          expectedCents: expected,
          countedCents: input.countedCents,
          differenceCents: difference,
          note: input.note ?? null,
        },
      });
      return { session: await getSession(tx, sessionId, actor), created: true };
    });
  } catch (err) {
    return translateCashError(err);
  }
}

// ---------------------------------------------------------------------------
// Movimentos: sangria, suprimento, despesa e estorno
// ---------------------------------------------------------------------------
async function lockOwnSession(tx: pg.PoolClient, userId: string): Promise<string> {
  const row = await maybeOne<{ id: string }>(
    tx,
    `select id from cash_sessions where opened_by = $1 and status = 'aberto' for update`,
    [userId],
  );
  if (!row) throw errors.conflict('CASH_NOT_OPEN', 'Abra o caixa antes de registrar movimentos');
  return row.id;
}

async function assertCashAvailable(
  tx: pg.PoolClient,
  sessionId: string,
  amount: number,
): Promise<void> {
  const expected = (
    await one<{ e: number }>(tx, 'select cash_session_expected($1) as e', [sessionId])
  ).e;
  if (amount > expected) {
    throw new AppError(
      'INSUFFICIENT_CASH',
      422,
      'Dinheiro insuficiente na gaveta para esta saída',
      {
        expectedCents: expected,
        requestedCents: amount,
      },
    );
  }
}

export interface MovementResult {
  id: string;
  created: boolean;
}

export async function createMovement(
  pool: pg.Pool,
  input: CashMovementInput,
  actor: CashActor,
): Promise<MovementResult> {
  const hash = hashOf({
    kind: input.kind,
    amountCents: input.amountCents,
    description: input.description,
    category: input.category ?? null,
    by: actor.id,
  });
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `cash-movement:${input.idempotencyKey}`);
      const existing = await maybeOne<{ id: string; request_hash: string }>(
        tx,
        'select id, request_hash from cash_movements where idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing) {
        if (existing.request_hash !== hash) {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { id: existing.id, created: false };
      }
      const sessionId = await lockOwnSession(tx, actor.id);
      const direction = input.kind === 'suprimento' ? 'entrada' : 'saida';
      if (direction === 'saida') await assertCashAvailable(tx, sessionId, input.amountCents);
      const row = await one<{ id: string }>(
        tx,
        `insert into cash_movements
           (session_id, kind, direction, amount_cents, description, category, idempotency_key,
            request_hash, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          sessionId,
          input.kind,
          direction,
          input.amountCents,
          input.description,
          input.category ?? null,
          input.idempotencyKey,
          hash,
          actor.id,
        ],
      );
      await recordAudit(tx, {
        actorId: actor.id,
        action: `cash.${input.kind}`,
        entity: 'cash_movement',
        entityId: row.id,
        payload: {
          sessionId,
          amountCents: input.amountCents,
          description: input.description,
          category: input.category ?? null,
        },
      });
      return { id: row.id, created: true };
    });
  } catch (err) {
    return translateCashError(err);
  }
}

/** Estorno compensatório: nunca altera o movimento original; entra no caixa aberto de quem estorna. */
export async function reverseMovement(
  pool: pg.Pool,
  movementId: string,
  input: CashMovementReverseInput,
  actor: CashActor,
): Promise<MovementResult> {
  const hash = hashOf({ movementId, reason: input.reason, by: actor.id });
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `cash-movement:${input.idempotencyKey}`);
      const existing = await maybeOne<{ id: string; request_hash: string }>(
        tx,
        'select id, request_hash from cash_movements where idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing) {
        if (existing.request_hash !== hash) {
          throw errors.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'Esta chave de idempotência já foi usada com dados diferentes',
          );
        }
        return { id: existing.id, created: false };
      }
      const sessionId = await lockOwnSession(tx, actor.id);
      // Serializa estornos do mesmo movimento (a UNIQUE é a barreira final).
      const original = await maybeOne<{
        kind: string;
        direction: 'entrada' | 'saida';
        amount_cents: number;
        description: string;
      }>(
        tx,
        'select kind, direction, amount_cents, description from cash_movements where id = $1 for update',
        [movementId],
      );
      if (!original) throw errors.notFound('Movimento');
      if (original.kind === 'estorno') {
        throw errors.unprocessable('NOT_REVERSIBLE', 'Um estorno não pode ser estornado');
      }
      if (
        await maybeOne(tx, 'select 1 from cash_movements where reverses_movement_id = $1', [
          movementId,
        ])
      ) {
        throw errors.conflict('ALREADY_REVERSED', 'Este movimento já foi estornado');
      }
      const direction = original.direction === 'entrada' ? 'saida' : 'entrada';
      if (direction === 'saida') await assertCashAvailable(tx, sessionId, original.amount_cents);
      const row = await one<{ id: string }>(
        tx,
        `insert into cash_movements
           (session_id, kind, direction, amount_cents, description, reverses_movement_id,
            idempotency_key, request_hash, created_by)
         values ($1, 'estorno', $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          sessionId,
          direction,
          original.amount_cents,
          `Estorno (${original.kind}): ${input.reason}`.slice(0, 200),
          movementId,
          input.idempotencyKey,
          hash,
          actor.id,
        ],
      );
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'cash.movement.reverse',
        entity: 'cash_movement',
        entityId: row.id,
        payload: { reverses: movementId, amountCents: original.amount_cents, reason: input.reason },
      });
      return { id: row.id, created: true };
    });
  } catch (err) {
    if (
      pgErrorCode(err) === PG.uniqueViolation &&
      /reverses_movement_id/.test(String((err as Error).message))
    ) {
      throw errors.conflict('ALREADY_REVERSED', 'Este movimento já foi estornado');
    }
    return translateCashError(err);
  }
}
