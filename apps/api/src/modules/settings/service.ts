import type pg from 'pg';
import type { DiscountLimitDTO, Role } from '@pdv/shared';
import { many, maybeOne, withTransaction } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { recordAudit } from '../audit/service.js';

export async function listDiscountLimits(db: Db): Promise<DiscountLimitDTO[]> {
  const rows = await many<{ role: Role; max_discount_bp: number }>(
    db,
    `select role, max_discount_bp from role_discount_limits
     order by case role when 'admin' then 1 when 'gerente' then 2 else 3 end`,
  );
  return rows.map((r) => ({ role: r.role, maxDiscountBp: r.max_discount_bp }));
}

/** Limite de desconto do papel em pontos-base (0 = não pode conceder desconto). */
export async function getDiscountLimit(db: Db, role: Role): Promise<number> {
  const row = await maybeOne<{ max_discount_bp: number }>(
    db,
    'select max_discount_bp from role_discount_limits where role = $1',
    [role],
  );
  return row?.max_discount_bp ?? 0;
}

export async function updateDiscountLimit(
  pool: pg.Pool,
  role: Role,
  maxDiscountBp: number,
  actorId: string,
): Promise<DiscountLimitDTO> {
  return withTransaction(pool, async (tx) => {
    const before = await getDiscountLimit(tx, role);
    await tx.query(
      `insert into role_discount_limits (role, max_discount_bp, updated_by) values ($1, $2, $3)
       on conflict (role) do update set max_discount_bp = excluded.max_discount_bp,
                                        updated_by = excluded.updated_by`,
      [role, maxDiscountBp, actorId],
    );
    await recordAudit(tx, {
      actorId,
      action: 'settings.discount_limit',
      entity: 'role_discount_limit',
      entityId: role,
      payload: { from: before, to: maxDiscountBp },
    });
    return { role, maxDiscountBp };
  });
}
