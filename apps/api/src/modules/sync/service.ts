import { createHash } from 'node:crypto';
import type pg from 'pg';
import { hasPermission } from '@pdv/shared';
import type {
  CatalogSnapshotDTO,
  OfflineGrantClaims,
  SyncConflictDTO,
  SyncOperationInput,
  SyncResolveInput,
  SyncResultDTO,
  UserDTO,
} from '@pdv/shared';
import { lockKey, many, maybeOne, one, withTransaction } from '../../db/pool.js';
import { AppError, errors } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { getDiscountLimit } from '../settings/service.js';
import { requireOpenSession } from '../cash/service.js';
import { createSaleTx, translateSaleError } from '../sales/service.js';

/** Tolerância de relógio entre dispositivo e servidor. */
const SKEW_MS = 5 * 60 * 1000;

/** Erros que se resolvem sozinhos ou por ação do próprio operador: a operação pode ser reenviada. */
const RECOVERABLE_CODES = new Set(['CASH_NOT_OPEN', 'CASH_INTEGRITY', 'DEPENDENCY_PENDING']);
/** Conflitos que gerente/admin podem aprovar. Violações de autorização offline nunca são aprováveis. */
const APPROVABLE_CODES = new Set([
  'DISCOUNT_LIMIT_EXCEEDED',
  'DISCOUNT_NOT_ALLOWED',
  'CREDIT_LIMIT_EXCEEDED',
  'CASH_SESSION_CLOSED',
]);

const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ---------------------------------------------------------------------------
// Dispositivos e catálogo
// ---------------------------------------------------------------------------
export async function registerDevice(
  db: pg.Pool | pg.PoolClient,
  deviceId: string,
  userId: string,
): Promise<void> {
  await db.query(
    `insert into devices (id, user_id) values ($1, $2)
     on conflict (id) do update set user_id = excluded.user_id, last_seen_at = now()`,
    [deviceId, userId],
  );
}

/** Instantâneo do que o balcão precisa para vender sem internet. */
export async function getCatalogSnapshot(
  pool: pg.Pool,
  actor: UserDTO,
): Promise<CatalogSnapshotDTO> {
  const variants = await many<{
    id: string;
    sku: string;
    barcode: string | null;
    product_name: string;
    size: string | null;
    color: string | null;
    price_cents: number;
    stock: number;
  }>(
    pool,
    `select v.id, v.sku, v.barcode, p.name as product_name, v.size, v.color, v.price_cents,
            coalesce(s.quantity, 0) as stock
     from product_variants v
     join products p on p.id = v.product_id
     left join stock_levels s on s.variant_id = v.id
     where v.active and p.active
     order by p.name, v.sku`,
  );
  const customers = await many<{
    id: string;
    name: string;
    document: string | null;
    phone: string | null;
    credit_limit_cents: number | null;
  }>(
    pool,
    'select id, name, document, phone, credit_limit_cents from customers where active order by lower(name)',
  );
  return {
    generatedAt: new Date().toISOString(),
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      barcode: v.barcode,
      productName: v.product_name,
      size: v.size,
      color: v.color,
      priceCents: v.price_cents,
      stock: v.stock,
    })),
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      document: c.document,
      phone: c.phone,
      creditLimitCents: c.credit_limit_cents,
    })),
    discountLimitBp: await getDiscountLimit(pool, actor.role),
  };
}

// ---------------------------------------------------------------------------
// Persistência do resultado de cada operação
// ---------------------------------------------------------------------------
interface OpRow {
  operation_id: string;
  request_hash: string;
  status: SyncResultDTO['status'];
  sale_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  resolution: 'aprovada' | 'descartada' | null;
  device_id: string;
  user_id: string;
  payload: SyncOperationInput['payload'];
  client_created_at: Date;
  cash_session_id: string | null;
}

interface Outcome {
  status: SyncResultDTO['status'];
  saleId?: string;
  error?: { code: string; message: string };
  conflicts: SyncConflictDTO[];
}

async function saveOutcome(
  tx: pg.PoolClient,
  op: SyncOperationInput,
  deviceId: string,
  userId: string,
  opHash: string,
  outcome: Outcome,
): Promise<void> {
  await tx.query(
    `insert into sync_operations
       (operation_id, device_id, sequence, user_id, type, payload, request_hash, depends_on,
        reverses_operation_id, client_created_at, status, last_error_code, last_error_message, sale_id,
        cash_session_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            (select id from cash_sessions where id = $15))
     on conflict (operation_id) do update
       set status = excluded.status,
           attempts = sync_operations.attempts + 1,
           last_error_code = excluded.last_error_code,
           last_error_message = excluded.last_error_message,
           sale_id = excluded.sale_id,
           updated_at = now()`,
    [
      op.operationId,
      deviceId,
      op.sequence,
      userId,
      op.type,
      JSON.stringify(op.payload),
      opHash,
      op.dependsOn,
      op.reversesOperationId ?? null,
      op.createdAt,
      outcome.status,
      outcome.error?.code ?? null,
      outcome.error?.message ?? null,
      outcome.saleId ?? null,
      op.cashSessionId,
    ],
  );
  if (outcome.status !== 'falha_recuperavel') {
    for (const c of outcome.conflicts) {
      await tx.query(
        `insert into sync_conflicts (operation_id, code, blocking, message, details)
         values ($1, $2, $3, $4, $5)`,
        [op.operationId, c.code, c.blocking, c.message, JSON.stringify(c.details)],
      );
    }
  }
}

async function storedResult(db: pg.Pool | pg.PoolClient, row: OpRow): Promise<SyncResultDTO> {
  const conflicts = await many<{
    code: string;
    blocking: boolean;
    message: string;
    details: Record<string, unknown>;
  }>(
    db,
    'select code, blocking, message, details from sync_conflicts where operation_id = $1 order by created_at, id',
    [row.operation_id],
  );
  const sale = row.sale_id
    ? await maybeOne<{ number: string }>(
        db,
        'select number::text as number from sales where id = $1',
        [row.sale_id],
      )
    : null;
  return {
    operationId: row.operation_id,
    status: row.status,
    saleId: row.sale_id ?? undefined,
    saleNumber: sale ? Number(sale.number) : undefined,
    duplicate: true,
    resolution: row.resolution ?? undefined,
    error: row.last_error_code
      ? { code: row.last_error_code, message: row.last_error_message ?? '' }
      : undefined,
    conflicts: conflicts.map((c) => ({ ...c })),
  };
}

// ---------------------------------------------------------------------------
// Caixa de origem
// ---------------------------------------------------------------------------
interface CashRefusal {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Define em qual caixa a venda offline será registrada. Nunca usa "o caixa aberto agora" no
 * lugar do caixa de origem: caixa de origem aberto → nele; fechado → só por regularização
 * aprovada (`allowRegularization`), no caixa aberto do vendedor, preservando o fechamento original.
 */
async function resolveCashSession(
  tx: pg.PoolClient,
  userId: string,
  originId: string | null,
  createdMs: number,
  allowRegularization: boolean,
): Promise<{ sessionId: string; originSessionId: string } | CashRefusal> {
  const origin = originId
    ? await maybeOne<{
        number: string;
        opened_by: string;
        opened_at: Date;
        closed_at: Date | null;
        status: 'aberto' | 'fechado';
      }>(
        tx,
        `select number::text as number, opened_by, opened_at, closed_at, status
         from cash_sessions where id = $1 for share`,
        [originId],
      )
    : null;
  if (!originId || !origin) {
    return {
      code: 'CASH_SESSION_UNKNOWN',
      message: 'Caixa de origem da venda não encontrado',
      details: { cashSessionId: originId },
    };
  }
  if (origin.opened_by !== userId) {
    return {
      code: 'CASH_SESSION_FOREIGN',
      message: 'O caixa informado pertence a outro operador',
      details: { cashSessionId: originId },
    };
  }
  if (createdMs < origin.opened_at.getTime() - SKEW_MS) {
    return {
      code: 'CASH_SESSION_NOT_OPEN_YET',
      message: 'A venda é anterior à abertura do caixa informado',
      details: { cashSessionId: originId, openedAt: origin.opened_at.toISOString() },
    };
  }
  if (origin.status === 'aberto') return { sessionId: originId, originSessionId: originId };
  if (!allowRegularization) {
    return {
      code: 'CASH_SESSION_CLOSED',
      message: `O caixa #${origin.number} já foi fechado; a venda exige regularização aprovada`,
      details: {
        cashSessionId: originId,
        cashSessionNumber: Number(origin.number),
        closedAt: origin.closed_at?.toISOString(),
        soldAfterClose: !!origin.closed_at && createdMs > origin.closed_at.getTime(),
      },
    };
  }
  // Regularização: registra no caixa aberto do vendedor (lança CASH_NOT_OPEN se não houver).
  return { sessionId: await requireOpenSession(tx, userId), originSessionId: originId };
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------
export interface SyncContext {
  claims: OfflineGrantClaims;
  deviceId: string;
  user: UserDTO;
}

function classify(err: unknown): { code: string; message: string; recoverable: boolean } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, recoverable: RECOVERABLE_CODES.has(err.code) };
  }
  return {
    code: 'TRANSIENT_FAILURE',
    message: 'Falha temporária ao processar; a operação será reenviada',
    recoverable: true,
  };
}

async function processOne(
  pool: pg.Pool,
  ctx: SyncContext,
  op: SyncOperationInput,
): Promise<SyncResultDTO> {
  const opHash = hashOf({
    deviceId: ctx.deviceId,
    sequence: op.sequence,
    type: op.type,
    createdAt: new Date(op.createdAt).toISOString(),
    cashSessionId: op.cashSessionId,
    dependsOn: [...op.dependsOn].sort(),
    reverses: op.reversesOperationId ?? null,
    payload: op.payload,
  });

  const attempt = async (): Promise<SyncResultDTO> =>
    withTransaction(pool, async (tx) => {
      await lockKey(tx, `sync-op:${op.operationId}`);

      // Deduplicação: operação já recebida.
      const existing = await maybeOne<OpRow>(
        tx,
        'select * from sync_operations where operation_id = $1',
        [op.operationId],
      );
      if (existing) {
        if (existing.request_hash !== opHash) {
          throw errors.conflict(
            'OPERATION_ID_REUSED',
            'Este operationId já foi usado com conteúdo diferente',
          );
        }
        if (existing.status !== 'falha_recuperavel') return storedResult(tx, existing);
      } else {
        const clash = await maybeOne(
          tx,
          'select 1 from sync_operations where device_id = $1 and sequence = $2',
          [ctx.deviceId, op.sequence],
        );
        if (clash) {
          throw errors.conflict(
            'SEQUENCE_REUSED',
            'A sequência deste dispositivo já foi usada por outra operação',
          );
        }
      }

      await registerDevice(tx, ctx.deviceId, ctx.user.id);
      const fail = async (
        code: string,
        message: string,
        recoverable: boolean,
        conflicts: SyncConflictDTO[] = [],
        details: Record<string, unknown> = {},
      ): Promise<SyncResultDTO> => {
        const status = recoverable ? 'falha_recuperavel' : 'conflito';
        const blocking: SyncConflictDTO[] = recoverable
          ? []
          : [{ code, blocking: true, message, details }, ...conflicts];
        await saveOutcome(tx, op, ctx.deviceId, ctx.user.id, opHash, {
          status,
          error: { code, message },
          conflicts: blocking,
        });
        return {
          operationId: op.operationId,
          status,
          error: { code, message },
          conflicts: blocking,
        };
      };

      // Autorização offline: a operação precisa ter acontecido dentro da janela da autorização.
      const created = new Date(op.createdAt).getTime();
      if (created < ctx.claims.iat - SKEW_MS || created > ctx.claims.exp + SKEW_MS) {
        return fail(
          'GRANT_EXPIRED',
          'Operação fora da validade da autorização offline (máx. 8 h)',
          false,
        );
      }
      if (created > Date.now() + SKEW_MS) {
        return fail('CLOCK_AHEAD', 'Data da operação está no futuro', false);
      }
      if (!hasPermission(ctx.user.role, 'sale:create')) {
        return fail('FORBIDDEN', 'Usuário sem permissão para vender', false);
      }

      // Dependências: todas precisam estar confirmadas (ou descartadas explicitamente = bloqueio).
      for (const dep of op.dependsOn) {
        const d = await maybeOne<{ status: string; resolution: string | null }>(
          tx,
          'select status, resolution from sync_operations where operation_id = $1',
          [dep],
        );
        if (!d || d.status === 'falha_recuperavel') {
          return fail('DEPENDENCY_PENDING', 'Aguardando operação da qual esta depende', true);
        }
        if (d.status === 'conflito') {
          return fail(
            'DEPENDENCY_BLOCKED',
            'A operação da qual esta depende está em conflito',
            false,
          );
        }
      }

      // Caixa de origem (nunca "o caixa aberto agora").
      const cs = await resolveCashSession(tx, ctx.user.id, op.cashSessionId, created, false);
      if ('code' in cs) return fail(cs.code, cs.message, false, [], cs.details);

      // Aplicação: savepoint para que o erro de negócio não aborte a gravação do resultado.
      const conflicts: SyncConflictDTO[] = [];
      await tx.query('savepoint apply_op');
      try {
        const occurredAt = new Date(Math.min(created, Date.now()));
        const sale = await createSaleTx(
          tx,
          { ...op.payload, idempotencyKey: `op:${op.operationId}` },
          { id: ctx.user.id, role: ctx.user.role },
          { occurredAt, syncOperationId: op.operationId, cashSession: cs, conflicts },
        );
        await tx.query('release savepoint apply_op');
        await saveOutcome(tx, op, ctx.deviceId, ctx.user.id, opHash, {
          status: 'confirmada',
          saleId: sale.sale.id,
          conflicts,
        });
        return {
          operationId: op.operationId,
          status: 'confirmada',
          saleId: sale.sale.id,
          saleNumber: sale.sale.number,
          conflicts,
        };
      } catch (err) {
        await tx.query('rollback to savepoint apply_op');
        let normalized: unknown = err;
        try {
          translateSaleError(err);
        } catch (t) {
          normalized = t;
        }
        const c = classify(normalized);
        // Erros não classificados (DB/rede) abortam a transação inteira: o chamador registra.
        if (!(normalized instanceof AppError)) throw normalized;
        return fail(c.code, c.message, c.recoverable);
      }
    });

  try {
    return await attempt();
  } catch (err) {
    const c = classify(err);
    // Falha no meio da transação (ou no COMMIT): nada foi aplicado; registra para repetição segura.
    if (err instanceof AppError && !c.recoverable) {
      return {
        operationId: op.operationId,
        status: 'conflito',
        error: { code: c.code, message: c.message },
        conflicts: [{ code: c.code, blocking: true, message: c.message, details: {} }],
      };
    }
    try {
      await withTransaction(pool, async (tx) => {
        await registerDevice(tx, ctx.deviceId, ctx.user.id);
        await saveOutcome(tx, op, ctx.deviceId, ctx.user.id, opHash, {
          status: 'falha_recuperavel',
          error: { code: c.code, message: c.message },
          conflicts: [],
        });
      });
    } catch {
      // sem registro: o cliente mantém a operação pendente e reenvia
    }
    return {
      operationId: op.operationId,
      status: 'falha_recuperavel',
      error: { code: c.code, message: c.message },
    };
  }
}

/** Processa o lote em ordem de sequência. Cada operação tem sua própria transação. */
export async function processOperations(
  pool: pg.Pool,
  ctx: SyncContext,
  operations: SyncOperationInput[],
): Promise<SyncResultDTO[]> {
  const ordered = [...operations].sort((a, b) => a.sequence - b.sequence);
  const results: SyncResultDTO[] = [];
  for (const op of ordered) results.push(await processOne(pool, ctx, op));
  return results;
}

// ---------------------------------------------------------------------------
// Consulta e resolução de conflitos
// ---------------------------------------------------------------------------
export interface SyncIssueDTO {
  operationId: string;
  deviceId: string;
  sequence: number;
  status: SyncResultDTO['status'];
  sellerName: string;
  clientCreatedAt: string;
  totalCents: number;
  errorCode: string | null;
  errorMessage: string | null;
  resolution: 'aprovada' | 'descartada' | null;
  approvable: boolean;
  saleId: string | null;
  conflicts: SyncConflictDTO[];
}

/** Operações com problema (conflito não resolvido, falha) ou divergências informativas sem ciência. */
export async function listIssues(pool: pg.Pool): Promise<SyncIssueDTO[]> {
  const rows = await many<OpRow & { seller_name: string; updated_at: Date; sequence: string }>(
    pool,
    `select o.*, u.name as seller_name
     from sync_operations o
     join users u on u.id = o.user_id
     where (o.status = 'conflito' and o.resolution is null)
        or o.status = 'falha_recuperavel'
        or exists (select 1 from sync_conflicts c
                   where c.operation_id = o.operation_id and c.acknowledged_at is null)
     order by o.received_at desc
     limit 200`,
  );
  const out: SyncIssueDTO[] = [];
  for (const r of rows) {
    const conflicts = await many<SyncConflictDTO & { acknowledged_at: Date | null }>(
      pool,
      `select code, blocking, message, details, acknowledged_at
       from sync_conflicts where operation_id = $1 order by created_at, id`,
      [r.operation_id],
    );
    const payload = r.payload;
    const subtotal = payload.items.reduce(
      (s, i) => s + i.quantity * i.unitPriceCents - i.discountCents,
      0,
    );
    out.push({
      operationId: r.operation_id,
      deviceId: r.device_id,
      sequence: Number(r.sequence),
      status: r.status,
      sellerName: r.seller_name,
      clientCreatedAt: r.client_created_at.toISOString(),
      totalCents: subtotal,
      errorCode: r.last_error_code,
      errorMessage: r.last_error_message,
      resolution: r.resolution,
      approvable:
        r.status === 'conflito' && !r.resolution && APPROVABLE_CODES.has(r.last_error_code ?? ''),
      saleId: r.sale_id,
      conflicts: conflicts.map(({ acknowledged_at: _a, ...c }) => c),
    });
  }
  return out;
}

export async function resolveOperation(
  pool: pg.Pool,
  operationId: string,
  input: SyncResolveInput,
  actor: UserDTO,
): Promise<SyncResultDTO> {
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `sync-op:${operationId}`);
      const row = await maybeOne<OpRow>(
        tx,
        'select * from sync_operations where operation_id = $1 for update',
        [operationId],
      );
      if (!row) throw errors.notFound('Operação');
      if (row.status !== 'conflito' || row.resolution) {
        throw errors.conflict('NOT_RESOLVABLE', 'Esta operação não está em conflito pendente');
      }

      if (input.action === 'descartar') {
        await tx.query(
          `update sync_operations set resolution = 'descartada', resolved_by = $2, resolved_at = now(),
             resolution_note = $3, updated_at = now() where operation_id = $1`,
          [operationId, actor.id, input.note],
        );
      } else {
        if (!APPROVABLE_CODES.has(row.last_error_code ?? '')) {
          throw errors.unprocessable(
            'NOT_APPROVABLE',
            'Este conflito não pode ser aprovado; só descartado',
          );
        }
        const seller = await one<{ role: UserDTO['role']; active: boolean }>(
          tx,
          'select role, active from users where id = $1',
          [row.user_id],
        );
        if (!seller.active) throw errors.conflict('USER_INACTIVE', 'Vendedor inativo');
        const cs = await resolveCashSession(
          tx,
          row.user_id,
          row.cash_session_id,
          row.client_created_at.getTime(),
          true,
        );
        if ('code' in cs) throw errors.unprocessable(cs.code, cs.message);
        const conflicts: SyncConflictDTO[] = [];
        const sale = await createSaleTx(
          tx,
          { ...row.payload, idempotencyKey: `op:${operationId}` },
          { id: row.user_id, role: seller.role },
          {
            occurredAt: new Date(Math.min(row.client_created_at.getTime(), Date.now())),
            syncOperationId: operationId,
            cashSession: cs,
            approved: true,
            conflicts,
          },
        );
        if (cs.sessionId !== cs.originSessionId) {
          const received = row.payload.payments.reduce((n, p) => n + p.amountCents, 0);
          const cash = row.payload.payments
            .filter((p) => p.method === 'dinheiro')
            .reduce((n, p) => n + p.amountCents, 0);
          await tx.query(
            `insert into cash_regularizations
               (operation_id, sale_id, origin_session_id, target_session_id, cash_cents,
                received_cents, approved_by, note)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              operationId,
              sale.sale.id,
              cs.originSessionId,
              cs.sessionId,
              cash,
              received,
              actor.id,
              input.note,
            ],
          );
        }
        await tx.query(
          `update sync_operations set status = 'confirmada', sale_id = $2, resolution = 'aprovada',
             resolved_by = $3, resolved_at = now(), resolution_note = $4,
             last_error_code = null, last_error_message = null, updated_at = now()
           where operation_id = $1`,
          [operationId, sale.sale.id, actor.id, input.note],
        );
        for (const c of conflicts) {
          await tx.query(
            `insert into sync_conflicts (operation_id, code, blocking, message, details)
             values ($1, $2, $3, $4, $5)`,
            [operationId, c.code, c.blocking, c.message, JSON.stringify(c.details)],
          );
        }
      }
      await tx.query(
        `update sync_conflicts set acknowledged_by = $2, acknowledged_at = now()
         where operation_id = $1 and acknowledged_at is null`,
        [operationId, actor.id],
      );
      await recordAudit(tx, {
        actorId: actor.id,
        action: input.action === 'aprovar' ? 'sync.approve' : 'sync.discard',
        entity: 'sync_operation',
        entityId: operationId,
        payload: { note: input.note, code: row.last_error_code },
      });
      const updated = await one<OpRow>(
        tx,
        'select * from sync_operations where operation_id = $1',
        [operationId],
      );
      return storedResult(tx, updated);
    });
  } catch (err) {
    return translateSaleError(err);
  }
}

/** Dá ciência às divergências informativas de uma operação já confirmada. */
export async function acknowledgeConflicts(
  pool: pg.Pool,
  operationId: string,
  actor: UserDTO,
): Promise<void> {
  const res = await pool.query(
    `update sync_conflicts set acknowledged_by = $2, acknowledged_at = now()
     where operation_id = $1 and acknowledged_at is null and not blocking`,
    [operationId, actor.id],
  );
  if (res.rowCount) {
    await recordAudit(pool, {
      actorId: actor.id,
      action: 'sync.acknowledge',
      entity: 'sync_operation',
      entityId: operationId,
    });
  }
}
