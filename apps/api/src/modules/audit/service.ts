import type { Db } from '../../db/pool.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

/** Registra na MESMA transação da ação auditada (passe o client da transação). */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    'insert into audit_log (actor_id, action, entity, entity_id, payload) values ($1, $2, $3, $4, $5)',
    [
      entry.actorId,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      JSON.stringify(entry.payload ?? {}),
    ],
  );
}
