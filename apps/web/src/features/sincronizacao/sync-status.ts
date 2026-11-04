import type { SupabasePublicConfigResult } from "../../lib/supabase/config";

export type SyncStatus =
  | {
      kind: "configuration_required";
      label: "Configuração pendente";
      description: "Configure a conexão com o Supabase antes de sincronizar operações.";
    }
  | {
      kind: "ready_to_connect";
      label: "Pronto para conectar";
      description: "Nenhuma operação foi confirmada pelo servidor ainda.";
    };

export function deriveSyncStatus(
  config: SupabasePublicConfigResult,
): SyncStatus {
  if (config.status === "missing_configuration") {
    return {
      kind: "configuration_required",
      label: "Configuração pendente",
      description:
        "Configure a conexão com o Supabase antes de sincronizar operações.",
    };
  }

  return {
    kind: "ready_to_connect",
    label: "Pronto para conectar",
    description: "Nenhuma operação foi confirmada pelo servidor ainda.",
  };
}
