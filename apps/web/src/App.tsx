import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { useAuth } from '@/hooks/useAuth';
import { CashHistoryPage, CashSessionPage } from '@/pages/CashHistoryPage';
import { CashPage } from '@/pages/CashPage';
import { CustomerDetailPage } from '@/pages/CustomerDetailPage';
import { CustomersPage } from '@/pages/CustomersPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { DebtsPage } from '@/pages/DebtsPage';
import { LoginPage } from '@/pages/LoginPage';
import { LowStockPage } from '@/pages/LowStockPage';
import { ProductDetailPage } from '@/pages/ProductDetailPage';
import { ProductFormPage } from '@/pages/ProductFormPage';
import { PosPage } from '@/pages/PosPage';
import { ProductsPage } from '@/pages/ProductsPage';
import { SaleDetailPage } from '@/pages/SaleDetailPage';
import { SalesPage } from '@/pages/SalesPage';
import { IntegrationsPage } from '@/pages/IntegrationsPage';
import { SyncPage } from '@/pages/SyncPage';
import { SettingsPage } from '@/pages/SettingsPage';

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <p className="p-8 text-center text-muted-foreground">Carregando…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RequirePermission({
  permission,
}: {
  permission: Parameters<ReturnType<typeof useAuth>['can']>[0];
}) {
  const { can } = useAuth();
  return can(permission) ? <Outlet /> : <Navigate to="/vender" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/vender" replace />} />
          <Route path="/vender" element={<PosPage />} />
          <Route path="/sincronizacao" element={<SyncPage />} />
          <Route path="/vendas" element={<SalesPage />} />
          <Route path="/vendas/:id" element={<SaleDetailPage />} />
          <Route path="/caixa" element={<CashPage />} />
          <Route element={<RequirePermission permission="cash:read" />}>
            <Route path="/caixa/historico" element={<CashHistoryPage />} />
            <Route path="/caixa/sessoes/:id" element={<CashSessionPage />} />
          </Route>
          <Route path="/clientes" element={<CustomersPage />} />
          <Route path="/clientes/:id" element={<CustomerDetailPage />} />
          <Route path="/fiado" element={<DebtsPage />} />
          <Route element={<RequirePermission permission="report:read" />}>
            <Route path="/painel" element={<DashboardPage />} />
          </Route>
          <Route element={<RequirePermission permission="integration:read" />}>
            <Route path="/integracoes" element={<IntegrationsPage />} />
          </Route>
          <Route element={<RequirePermission permission="settings:manage" />}>
            <Route path="/configuracoes" element={<SettingsPage />} />
          </Route>
          <Route path="/produtos" element={<ProductsPage />} />
          <Route element={<RequirePermission permission="product:write" />}>
            <Route path="/produtos/novo" element={<ProductFormPage />} />
          </Route>
          <Route path="/produtos/:id" element={<ProductDetailPage />} />
          <Route path="/estoque-baixo" element={<LowStockPage />} />
          <Route path="*" element={<Navigate to="/vender" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
