import { AdminShell } from "./components/shared/AdminShell";
import { SyncStatusCard } from "./features/sincronizacao/SyncStatusCard";
import { deriveSyncStatus } from "./features/sincronizacao/sync-status";
import { readSupabasePublicConfig } from "./lib/supabase/config";
import { CatalogPage } from "./features/produtos/CatalogPage";
import { SignInForm } from "./features/auth/SignInForm";
import { clearStoredSession, fetchOrganizationId, readStoredSession, signInWithPassword, type AuthSession } from "./lib/supabase/auth-session";
import { useEffect, useState } from "react";

export function App() {
  const syncStatus = deriveSyncStatus(readSupabasePublicConfig(import.meta.env));
  const [session, setSession] = useState<AuthSession | undefined>(() => readStoredSession(window.localStorage));
  const [organizationId, setOrganizationId] = useState<string>();
  const [organizationError, setOrganizationError] = useState<string>();

  useEffect(() => {
    if (!session) return;
    fetchOrganizationId(session).then(setOrganizationId).catch((error: unknown) => {
      setOrganizationError(error instanceof Error ? error.message : "Não foi possível identificar a organização.");
    });
  }, [session]);

  return (
    <AdminShell
      title="PDV LH Company"
      description="Base administrativa da Rodeghiero Tech"
    >
      {!session ? <SignInForm onSubmit={async ({ email, password }) => { setSession(await signInWithPassword({ email, password, storage: window.localStorage })); }} /> : null}
      {session && organizationId ? <CatalogPage accessToken={session.accessToken} organizationId={organizationId} /> : null}
      {session && !organizationId ? <section className="border-border bg-surface rounded-lg border p-4" role="status"><p className="text-sm">{organizationError ?? "Carregando a organização autorizada..."}</p><button className="text-muted-foreground mt-3 text-sm underline" onClick={() => { clearStoredSession(window.localStorage); setSession(undefined); setOrganizationError(undefined); }}>Sair</button></section> : null}
      <SyncStatusCard status={syncStatus} />
    </AdminShell>
  );
}
