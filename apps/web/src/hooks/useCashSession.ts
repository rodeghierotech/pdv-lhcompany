import { useQuery } from '@tanstack/react-query';
import type { CashReportDTO, CashSessionDTO } from '@pdv/shared';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { clearCashSession, saveCashSession } from '@/lib/offline/store';

export interface CurrentCash {
  session: CashSessionDTO | null;
  report: CashReportDTO | null;
}

/** Caixa aberto do operador logado (null = fechado). Exigido para vender, receber e devolver. */
export function useCashSession() {
  const { user } = useAuth();
  const userId = user?.id;
  return useQuery({
    queryKey: ['cash', 'current'],
    queryFn: async () => {
      const current = await api<CurrentCash>('/cash/current');
      // O aparelho lembra o caixa aberto: venda offline carrega o caixa de origem até o servidor.
      try {
        if (current.session && userId) {
          await saveCashSession({
            sessionId: current.session.id,
            number: current.session.number,
            userId,
          });
        } else await clearCashSession();
      } catch {
        /* IndexedDB indisponível: vendas offline ficam bloqueadas */
      }
      return current;
    },
    staleTime: 15_000,
  });
}
