import type { SyncState } from '@pdv/shared';
import { Badge } from '@/components/ui/display';

const LABEL: Record<SyncState, string> = {
  local: 'Salva no aparelho',
  pendente: 'Enviando…',
  confirmada: 'Confirmada',
  falha_recuperavel: 'Falha — será reenviada',
  conflito: 'Conflito',
};
const VARIANT: Record<SyncState, 'default' | 'success' | 'warning' | 'destructive'> = {
  local: 'warning',
  pendente: 'warning',
  confirmada: 'success',
  falha_recuperavel: 'warning',
  conflito: 'destructive',
};

/** Estado de sincronização de uma operação. "Confirmada" só após resposta do servidor. */
export function SyncBadge({ state }: { state: SyncState }) {
  return <Badge variant={VARIANT[state]}>{LABEL[state]}</Badge>;
}
