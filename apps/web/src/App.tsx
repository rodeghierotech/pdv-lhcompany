import { AdminShell } from "./components/shared/AdminShell";
import { SyncStatusCard } from "./features/sincronizacao/SyncStatusCard";
import { deriveSyncStatus } from "./features/sincronizacao/sync-status";
import { readSupabasePublicConfig } from "./lib/supabase/config";
import { CatalogPage } from "./features/produtos/CatalogPage";

export function App() {
  const syncStatus = deriveSyncStatus(readSupabasePublicConfig(import.meta.env));

  return (
    <AdminShell
      title="PDV LH Company"
      description="Base administrativa da Rodeghiero Tech"
    >
      <CatalogPage />
      <SyncStatusCard status={syncStatus} />
    </AdminShell>
  );
}
