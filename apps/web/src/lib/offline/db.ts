import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type {
  CatalogCustomerDTO,
  CatalogVariantDTO,
  OfflineSalePayload,
  SyncConflictDTO,
  SyncState,
  UserDTO,
} from '@pdv/shared';

/** Operação offline guardada no aparelho até o servidor confirmar. */
export interface LocalOperation {
  operationId: string;
  deviceId: string;
  /** Sequência local monotônica por dispositivo. */
  sequence: number;
  type: 'create_sale';
  createdAt: string;
  /** Caixa em que a venda foi realizada (preservado até o servidor). */
  cashSessionId: string;
  dependsOn: string[];
  reversesOperationId?: string;
  payload: OfflineSalePayload;
  /** Autorização offline usada nesta venda (o JWT pode expirar antes da sincronização). */
  grant: string;
  userId: string;
  state: SyncState;
  attempts: number;
  /** Resumo para exibição (não é fonte de verdade financeira). */
  summary: { totalCents: number; itemCount: number; label: string };
  saleNumber?: number;
  saleId?: string;
  error?: { code: string; message: string };
  conflicts?: SyncConflictDTO[];
  resolution?: 'aprovada' | 'descartada';
  confirmedAt?: string;
}

export type MetaValue =
  | { key: 'deviceId'; value: string }
  | { key: 'sequence'; value: number }
  | { key: 'session'; value: { user: UserDTO; savedAt: number } }
  | { key: 'cash'; value: { sessionId: string; number: number; userId: string; savedAt: number } }
  | { key: 'grant'; value: { grant: string; userId: string; issuedAt: number; expiresAt: number } }
  | {
      key: 'catalog';
      value: { generatedAt: string; discountLimitBp: number; userId: string };
    };

interface PdvDB extends DBSchema {
  meta: { key: string; value: MetaValue };
  variants: { key: string; value: CatalogVariantDTO };
  customers: { key: string; value: CatalogCustomerDTO };
  ops: {
    key: string;
    value: LocalOperation;
    indexes: { 'by-sequence': number; 'by-state': string };
  };
}

export type Db = IDBPDatabase<PdvDB>;

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  dbPromise ??= openDB<PdvDB>('pdv-offline', 1, {
    upgrade(db) {
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('variants', { keyPath: 'id' });
      db.createObjectStore('customers', { keyPath: 'id' });
      const ops = db.createObjectStore('ops', { keyPath: 'operationId' });
      ops.createIndex('by-sequence', 'sequence');
      ops.createIndex('by-state', 'state');
    },
  });
  return dbPromise;
}

/** Somente para testes: fecha e descarta a conexão em cache (simula reinício do navegador). */
export async function resetDbConnection(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

/** Pede ao navegador que não descarte o armazenamento sob pressão de espaço. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
