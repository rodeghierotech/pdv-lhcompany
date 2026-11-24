import {
  AlertTriangle,
  Banknote,
  BarChart3,
  HandCoins,
  LogOut,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Users,
  Plug,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { Badge } from '@/components/ui/display';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useCashSession } from '@/hooks/useCashSession';
import { useOffline } from '@/hooks/useOffline';
import { syncNow } from '@/lib/offline/sync';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const STORE_NAME = import.meta.env.VITE_STORE_NAME ?? 'LH Company';

const nav = [
  { to: '/vender', label: 'Vender', icon: ShoppingCart },
  { to: '/vendas', label: 'Vendas', icon: Receipt },
  { to: '/caixa', label: 'Caixa', icon: Banknote },
  { to: '/clientes', label: 'Clientes', icon: Users },
  { to: '/fiado', label: 'Fiado', icon: HandCoins },
  { to: '/produtos', label: 'Produtos', icon: Package },
  { to: '/estoque-baixo', label: 'Estoque baixo', icon: AlertTriangle },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const { online, pending, conflicts, grantValid } = useOffline();
  const cash = useCashSession();

  // Sair com vendas ainda não confirmadas: sem conexão é bloqueado; com conexão, envia antes.
  async function requestLogout() {
    if (pending > 0) {
      if (!online) {
        toast.error(
          `Há ${pending} venda(s) não sincronizada(s). Reconecte-se para enviá-las antes de sair.`,
        );
        return;
      }
      await syncNow().catch(() => undefined);
    }
    logout();
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-base font-semibold">PDV · {STORE_NAME}</span>
          <nav aria-label="Principal" className="flex flex-1 flex-wrap gap-1">
            {[
              ...(can('report:read') ? [{ to: '/painel', label: 'Painel', icon: BarChart3 }] : []),
              ...nav,
              ...(can('integration:read')
                ? [{ to: '/integracoes', label: 'Integrações', icon: Plug }]
                : []),
              ...(can('settings:manage')
                ? [{ to: '/configuracoes', label: 'Configurações', icon: Settings }]
                : []),
            ].map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
                    isActive && 'bg-accent text-foreground',
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            {cash.data && (
              <Link to="/caixa" aria-label="Situação do caixa">
                <Badge variant={cash.data.session ? 'success' : 'warning'}>
                  {cash.data.session
                    ? `Caixa #${cash.data.session.number} aberto`
                    : 'Caixa fechado'}
                </Badge>
              </Link>
            )}
            {(pending > 0 || conflicts > 0) && (
              <Link to="/sincronizacao" aria-label="Sincronização pendente">
                <Badge variant={conflicts > 0 ? 'destructive' : 'warning'} className="gap-1">
                  <RefreshCw className="size-3" />
                  {pending > 0 && `${pending} pendente(s)`}
                  {pending > 0 && conflicts > 0 && ' · '}
                  {conflicts > 0 && `${conflicts} conflito(s)`}
                </Badge>
              </Link>
            )}
            {online ? (
              <Badge variant="success">Online</Badge>
            ) : (
              <Badge variant="warning" className="gap-1">
                <WifiOff className="size-3" /> Sem conexão
              </Badge>
            )}
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user?.name} · {user?.role}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void requestLogout()}
              aria-label="Sair"
            >
              <LogOut /> <span className="hidden sm:inline">Sair</span>
            </Button>
          </div>
        </div>
        {!online && (
          <div role="status" className="bg-warning/15 px-4 py-2 text-center text-sm text-warning">
            Sem conexão.{' '}
            {grantValid
              ? 'Você pode vender à vista (sem cliente); as vendas ficam salvas neste aparelho até a sincronização.'
              : 'Autorização offline ausente ou expirada: vendas bloqueadas até reconectar.'}{' '}
            <Link to="/sincronizacao" className="underline">
              Sincronização
            </Link>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
