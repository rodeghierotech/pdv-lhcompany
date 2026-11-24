import type { CatalogSnapshotDTO, SyncResultDTO } from '@pdv/shared';
import { api, ApiError } from '@/lib/api';
import { getDb } from './db';
import type { LocalOperation } from './db';
import {
  getDeviceId,
  grantIsValid,
  pendingCount,
  listOperations,
  loadGrant,
  purgeConfirmed,
  saveCatalog,
  saveGrant,
  updateOperation,
} from './store';

const BATCH = 50;

let running: Promise<SyncSummary> | null = null;

export interface SyncSummary {
  sent: number;
  confirmed: number;
  failed: number;
  conflicts: number;
  networkError: boolean;
}

const empty = (): SyncSummary => ({
  sent: 0,
  confirmed: 0,
  failed: 0,
  conflicts: 0,
  networkError: false,
});

/** Operações que devem ser (re)enviadas: nunca confirmadas e não descartadas. */
const sendable = (op: LocalOperation) =>
  op.state === 'local' ||
  op.state === 'pendente' || // envio interrompido (reinício do navegador): reenvio é idempotente
  op.state === 'falha_recuperavel' ||
  (op.state === 'conflito' && !op.resolution);

async function applyResult(op: LocalOperation, r: SyncResultDTO): Promise<void> {
  // Estado só vira "confirmada" com a confirmação explícita do servidor.
  if (r.status === 'confirmada') {
    await updateOperation(op.operationId, {
      state: 'confirmada',
      saleId: r.saleId,
      saleNumber: r.saleNumber,
      conflicts: r.conflicts,
      error: undefined,
      confirmedAt: new Date().toISOString(),
    });
  } else if (r.status === 'conflito') {
    await updateOperation(op.operationId, {
      state: 'conflito',
      error: r.error,
      conflicts: r.conflicts,
      resolution: r.resolution,
      ...(r.resolution === 'descartada' ? { confirmedAt: new Date().toISOString() } : {}),
    });
  } else {
    await updateOperation(op.operationId, { state: 'falha_recuperavel', error: r.error });
  }
}

async function runSync(): Promise<SyncSummary> {
  const summary = empty();
  const ops = (await listOperations()).filter(sendable).sort((a, b) => a.sequence - b.sequence);
  if (ops.length === 0) return summary;

  // Cada venda carrega a própria autorização; agrupa por (dispositivo, autorização).
  const groups = new Map<string, LocalOperation[]>();
  for (const op of ops) {
    const k = `${op.deviceId}|${op.grant}`;
    groups.set(k, [...(groups.get(k) ?? []), op]);
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += BATCH) {
      const batch = group.slice(i, i + BATCH);
      const previous = new Map(batch.map((o) => [o.operationId, o.state]));
      for (const op of batch) {
        if (op.state !== 'conflito') {
          await updateOperation(op.operationId, { state: 'pendente', attempts: op.attempts + 1 });
        }
      }
      let results: SyncResultDTO[];
      try {
        const res = await api<{ results: SyncResultDTO[] }>('/sync/operations', {
          method: 'POST',
          auth: false,
          body: {
            deviceId: batch[0]!.deviceId,
            grant: batch[0]!.grant,
            operations: batch.map((o) => ({
              operationId: o.operationId,
              sequence: o.sequence,
              type: o.type,
              createdAt: o.createdAt,
              cashSessionId: o.cashSessionId,
              dependsOn: o.dependsOn,
              ...(o.reversesOperationId ? { reversesOperationId: o.reversesOperationId } : {}),
              payload: o.payload,
            })),
          },
        });
        results = res.results;
      } catch (err) {
        // Sem resposta: nada foi confirmado; volta ao estado anterior para nova tentativa.
        for (const op of batch) {
          const prev = previous.get(op.operationId)!;
          if (prev !== 'conflito')
            await updateOperation(op.operationId, { state: prev === 'pendente' ? 'local' : prev });
        }
        if (err instanceof ApiError && err.isNetwork) {
          summary.networkError = true;
          return summary;
        }
        // Autorização recusada (401/403): operações ficam como falha para o operador avaliar.
        for (const op of batch) {
          await updateOperation(op.operationId, {
            state: 'falha_recuperavel',
            error: {
              code: err instanceof ApiError ? err.code : 'ERROR',
              message: err instanceof Error ? err.message : 'Falha na sincronização',
            },
          });
        }
        summary.failed += batch.length;
        continue;
      }
      const byId = new Map(batch.map((o) => [o.operationId, o]));
      for (const r of results) {
        const op = byId.get(r.operationId);
        if (!op) continue;
        summary.sent++;
        await applyResult(op, r);
        if (r.status === 'confirmada') summary.confirmed++;
        else if (r.status === 'conflito') summary.conflicts++;
        else summary.failed++;
      }
    }
  }
  await purgeConfirmed();
  return summary;
}

/**
 * Envio único por vez: Web Locks entre abas (quando disponível) + promessa compartilhada na aba.
 * Duas abas nunca enviam em paralelo; mesmo que enviem, o servidor deduplica por operationId.
 */
export function syncNow(): Promise<SyncSummary> {
  if (running) return running;
  const exec = async (): Promise<SyncSummary> => {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) return runSync();
    const out = await locks.request('pdv-sync', { ifAvailable: true }, async (lock) =>
      lock ? runSync() : null,
    );
    return out ?? empty();
  };
  running = exec().finally(() => {
    running = null;
  });
  return running;
}

// ---------------------------------------------------------------------------
// Autorização offline e catálogo (exigem o servidor)
// ---------------------------------------------------------------------------
/** Emite uma nova autorização (8 h). Só é possível online; nunca renovada localmente. */
export async function refreshGrant(userId: string): Promise<void> {
  const deviceId = await getDeviceId();
  const res = await api<{ grant: string; issuedAt: string; expiresAt: string }>(
    '/auth/offline-grant',
    { method: 'POST', body: { deviceId } },
  );
  await saveGrant({
    grant: res.grant,
    userId,
    issuedAt: new Date(res.issuedAt).getTime(),
    expiresAt: new Date(res.expiresAt).getTime(),
  });
}

/** Renova a autorização quando falta menos de `minRemainingMs` (ou não há). */
export async function ensureGrant(userId: string, minRemainingMs = 3 * 3600_000): Promise<void> {
  const g = await loadGrant();
  if (grantIsValid(g, userId) && g.expiresAt - Date.now() > minRemainingMs) return;
  await refreshGrant(userId);
}

/**
 * Baixa o catálogo do servidor. Com vendas ainda não confirmadas, NÃO substitui o catálogo local:
 * o estoque do servidor ainda não inclui essas vendas e o saldo local ficaria otimista.
 */
export async function refreshCatalog(userId: string): Promise<boolean> {
  if ((await pendingCount()) > 0) return false;
  const snapshot = await api<CatalogSnapshotDTO>('/sync/catalog');
  await saveCatalog(snapshot, userId);
  return true;
}

/** Descarta todo o conteúdo local do catálogo (não toca em operações pendentes). */
export async function clearCatalog(): Promise<void> {
  const db = await getDb();
  await db.clear('variants');
  await db.clear('customers');
}
