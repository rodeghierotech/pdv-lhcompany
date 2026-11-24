import type pg from 'pg';
import type {
  CustomerCreateInput,
  CustomerDTO,
  CustomerListQuery,
  CustomerUpdateInput,
  Paginated,
} from '@pdv/shared';
import { many, maybeOne, one, withTransaction } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { AppError, errors, PG, pgConstraint, pgErrorCode } from '../../shared/errors.js';
import { escapeLike } from '../../shared/validate.js';
import { recordAudit } from '../audit/service.js';

interface CustomerRow {
  id: string;
  name: string;
  document: string | null;
  phone: string | null;
  credit_limit_cents: number | null;
  active: boolean;
  debt_cents: number;
  overdue_cents: number;
}

const CUSTOMER_SELECT = `
  select c.id, c.name, c.document, c.phone, c.credit_limit_cents, c.active,
         coalesce((
           select sum(ss.balance_cents) from sale_summary ss
           join sales s on s.id = ss.sale_id where s.customer_id = c.id
         ), 0)::int as debt_cents,
         coalesce((
           select sum(ss.balance_cents) from sale_summary ss
           join sales s on s.id = ss.sale_id
           where s.customer_id = c.id and s.due_date is not null
             and s.due_date < (now() at time zone 'America/Sao_Paulo')::date
         ), 0)::int as overdue_cents
  from customers c`;

const toDTO = (c: CustomerRow): CustomerDTO => ({
  id: c.id,
  name: c.name,
  document: c.document,
  phone: c.phone,
  creditLimitCents: c.credit_limit_cents,
  active: c.active,
  debtCents: c.debt_cents,
  overdueCents: c.overdue_cents,
});

/** Saldo devedor atual do cliente: soma dos saldos em aberto das vendas não canceladas. */
export async function customerDebt(db: Db, customerId: string): Promise<number> {
  const row = await one<{ debt: number }>(
    db,
    `select coalesce(sum(ss.balance_cents), 0)::int as debt
     from sale_summary ss join sales s on s.id = ss.sale_id
     where s.customer_id = $1`,
    [customerId],
  );
  return row.debt;
}

function translateCustomerError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (pgErrorCode(err) === PG.uniqueViolation && pgConstraint(err) === 'customers_document_uq') {
    throw errors.conflict('DOCUMENT_IN_USE', 'Já existe um cliente com este documento');
  }
  throw err;
}

export async function getCustomer(db: Db, id: string): Promise<CustomerDTO> {
  const row = await maybeOne<CustomerRow>(db, `${CUSTOMER_SELECT} where c.id = $1`, [id]);
  if (!row) throw errors.notFound('Cliente');
  return toDTO(row);
}

export async function listCustomers(
  pool: pg.Pool,
  query: CustomerListQuery,
): Promise<Paginated<CustomerDTO>> {
  const params: unknown[] = [];
  let where = '';
  if (query.q) {
    params.push(`%${escapeLike(query.q)}%`, query.q.replace(/\D/g, ''));
    where = `where (c.name ilike $1 or c.phone ilike $1 or (length($2) > 0 and c.document = $2))`;
  }
  const total = Number(
    (await one<{ count: string }>(pool, `select count(*) from customers c ${where}`, params)).count,
  );
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = await many<CustomerRow>(
    pool,
    `${CUSTOMER_SELECT} ${where} order by lower(c.name), c.id
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { items: rows.map(toDTO), page: query.page, pageSize: query.pageSize, total };
}

export async function createCustomer(
  pool: pg.Pool,
  input: CustomerCreateInput,
  actorId: string,
): Promise<CustomerDTO> {
  try {
    return await withTransaction(pool, async (tx) => {
      const created = await one<{ id: string }>(
        tx,
        `insert into customers (name, document, phone, credit_limit_cents)
         values ($1, $2, $3, $4) returning id`,
        [input.name, input.document ?? null, input.phone ?? null, input.creditLimitCents ?? null],
      );
      await recordAudit(tx, {
        actorId,
        action: 'customer.create',
        entity: 'customer',
        entityId: created.id,
        payload: { name: input.name, creditLimitCents: input.creditLimitCents ?? null },
      });
      return getCustomer(tx, created.id);
    });
  } catch (err) {
    return translateCustomerError(err);
  }
}

export async function updateCustomer(
  pool: pg.Pool,
  id: string,
  input: CustomerUpdateInput,
  actorId: string,
): Promise<CustomerDTO> {
  const columns: Record<string, string> = {
    name: 'name',
    document: 'document',
    phone: 'phone',
    creditLimitCents: 'credit_limit_cents',
    active: 'active',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in input)) continue;
    let value = (input as Record<string, unknown>)[key];
    if (key === 'document' && typeof value === 'string') {
      const digits = value.replace(/\D/g, '');
      if (digits !== '' && !/^(\d{11}|\d{14})$/.test(digits)) {
        throw errors.validation('Documento deve ter 11 (CPF) ou 14 (CNPJ) dígitos');
      }
      value = digits === '' ? null : digits;
    }
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  params.push(id);
  try {
    return await withTransaction(pool, async (tx) => {
      const res = await tx.query(
        `update customers set ${sets.join(', ')} where id = $${params.length}`,
        params,
      );
      if (res.rowCount === 0) throw errors.notFound('Cliente');
      await recordAudit(tx, {
        actorId,
        action: 'customer.update',
        entity: 'customer',
        entityId: id,
        payload: input as Record<string, unknown>,
      });
      return getCustomer(tx, id);
    });
  } catch (err) {
    return translateCustomerError(err);
  }
}
