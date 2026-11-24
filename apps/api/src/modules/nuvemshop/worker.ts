import { PROVIDER, getConnection } from './deps.js';
import type { NuvemshopDeps } from './deps.js';
import { processEvents } from './events.js';
import { sendOutbox } from './outbox.js';
import { reconcileStock, sweepOrders } from './reconcile.js';

export interface CycleResult {
  events: Awaited<ReturnType<typeof processEvents>>;
  outbox: Awaited<ReturnType<typeof sendOutbox>>;
  sweep?: Awaited<ReturnType<typeof sweepOrders>>;
  reconcile?: Awaited<ReturnType<typeof reconcileStock>>;
}

/** Um ciclo do worker: eventos → outbox → (se vencido) varredura de pedidos e reconciliação. */
export async function runCycle(
  deps: NuvemshopDeps,
  opts: { forceReconcile?: boolean } = {},
): Promise<CycleResult> {
  const events = await processEvents(deps);
  const outbox = await sendOutbox(deps);
  const result: CycleResult = { events, outbox };
  const conn = await getConnection(deps.pool);
  if (conn?.status === 'ativa') {
    const every = deps.env.RECONCILE_INTERVAL_MIN * 60_000;
    const last = conn.last_reconcile_at?.getTime() ?? 0;
    const now = deps.now ? deps.now().getTime() : Date.now();
    if (opts.forceReconcile || now - last >= every) {
      result.sweep = await sweepOrders(deps);
      result.events = await processEvents(deps);
      result.reconcile = await reconcileStock(deps);
    }
  }
  return result;
}

/** Laço contínuo (processo separado `worker`). Seguro com várias instâncias (leases/skip locked). */
export function startWorker(
  deps: NuvemshopDeps,
  log: (msg: string, extra?: unknown) => void = console.error,
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await runCycle(deps);
    } catch (err) {
      log(`worker ${PROVIDER}: ciclo falhou`, err instanceof Error ? err.message : err);
    }
    if (!stopped) timer = setTimeout(() => void tick(), deps.env.WORKER_INTERVAL_MS);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
