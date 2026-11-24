import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, setReachabilityHandler } from '@/lib/api';
import {
  loadCatalogMeta,
  loadGrant,
  grantIsValid,
  listOperations,
  requestPersistent,
} from '@/lib/offline/store';
import { ensureGrant, refreshCatalog, syncNow as runSync } from '@/lib/offline/sync';
import type { SyncSummary } from '@/lib/offline/sync';
import { QUEUE_EVENT } from '@/lib/offline/store';

/** Avisa a interface que a fila local mudou (nova venda, novo estado). */
export function notifyQueueChanged(): void {
  window.dispatchEvent(new Event(QUEUE_EVENT));
}

export function subscribeQueue(fn: () => void): () => void {
  window.addEventListener(QUEUE_EVENT, fn);
  return () => window.removeEventListener(QUEUE_EVENT, fn);
}

export interface OfflineState {
  /** Servidor alcançável (não é só navigator.onLine). */
  online: boolean;
  /** Vendas ainda sem confirmação do servidor (local, pendente, falha recuperável). */
  pending: number;
  /** Operações em conflito aguardando decisão. */
  conflicts: number;
  syncing: boolean;
  grantExpiresAt: number | null;
  /** Autorização offline válida para o usuário atual. */
  grantValid: boolean;
  catalogAt: string | null;
  lastSyncAt: number | null;
  syncNow: () => Promise<SyncSummary | null>;
}

const OfflineContext = createContext<OfflineState | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [online, setOnline] = useState<boolean>(() => navigator.onLine);
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [grantExpiresAt, setGrantExpiresAt] = useState<number | null>(null);
  const [grantValid, setGrantValid] = useState(false);
  const [catalogAt, setCatalogAt] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const userId = user?.id;
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const reload = useCallback(async () => {
    const ops = await listOperations();
    setPending(
      ops.filter(
        (o) => o.state === 'local' || o.state === 'pendente' || o.state === 'falha_recuperavel',
      ).length,
    );
    setConflicts(ops.filter((o) => o.state === 'conflito' && !o.resolution).length);
    const g = await loadGrant();
    setGrantExpiresAt(g?.expiresAt ?? null);
    setGrantValid(grantIsValid(g, userId));
    setCatalogAt((await loadCatalogMeta())?.generatedAt ?? null);
  }, [userId]);

  // Alcançabilidade: eventos do navegador + resultado real das requisições.
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    setReachabilityHandler(setOnline);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      setReachabilityHandler(null);
    };
  }, []);

  // Sem alcançabilidade, sonda /health até o servidor voltar.
  useEffect(() => {
    if (online) return;
    const id = setInterval(() => {
      api('/health').catch(() => undefined); // o handler de alcançabilidade atualiza o estado
    }, 5_000);
    return () => clearInterval(id);
  }, [online]);

  useEffect(() => {
    void reload();
    void requestPersistent();
    const fn = () => void reload();
    return subscribeQueue(fn);
  }, [reload]);

  const syncNow = useCallback(async (): Promise<SyncSummary | null> => {
    if (!onlineRef.current) return null;
    setSyncing(true);
    try {
      const summary = await runSync();
      setLastSyncAt(Date.now());
      return summary;
    } catch {
      return null;
    } finally {
      setSyncing(false);
      await reload();
    }
  }, [reload]);

  // Ao ficar online (e a cada minuto): envia a fila, renova a autorização e atualiza o catálogo.
  const cycle = useCallback(async () => {
    if (!userId || !onlineRef.current) return;
    try {
      await syncNow();
      await ensureGrant(userId);
      await refreshCatalog(userId);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
    await reload();
  }, [userId, syncNow, reload]);

  useEffect(() => {
    if (!online || !userId) return;
    void cycle();
    const id = setInterval(() => void cycle(), 60_000);
    return () => clearInterval(id);
  }, [online, userId, cycle]);

  const value = useMemo<OfflineState>(
    () => ({
      online,
      pending,
      conflicts,
      syncing,
      grantExpiresAt,
      grantValid,
      catalogAt,
      lastSyncAt,
      syncNow,
    }),
    [
      online,
      pending,
      conflicts,
      syncing,
      grantExpiresAt,
      grantValid,
      catalogAt,
      lastSyncAt,
      syncNow,
    ],
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineState {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline deve ser usado dentro de OfflineProvider');
  return ctx;
}
